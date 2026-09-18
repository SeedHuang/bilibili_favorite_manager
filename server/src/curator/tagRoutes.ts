/**
 * /api/tags/* —— 条目 AI 标注(spec §9E)。SSE/中止/进度模式照抄 §9D 的 run-pass-2。
 *
 * 和 ruleRoutes 一样单独一个文件:curator/routes.ts 已经近千行,标注是独立的一件事。
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import { readLlmSettings } from '../llm/config.js';
import { listUntaggedItemIds, tagStats } from '../db/repo/tagging.js';
import type { ItemRow } from '../db/repo/items.js';
import { runTagging } from './tagger.js';
import {
  listTagTree, mergeTags, setTagParent, renameTag, deleteTag, type TagNode,
} from '../db/repo/tags.js';
import { runTagCheck } from './tagcheck.js';
import { reconcile, type TreeChange } from './tagtree.js';
import { getSetting, setSetting } from '../db/repo/state.js';

export interface TagDeps {
  db: Database.Database;
  log: Logger;
}

/** 最近一轮「树的变化」清单存这个键 —— 刷新页面还在(§9F C10 要"看得见") */
const CHANGES_KEY = 'tags.lastChanges';

/** 这些 id 是不是全都在词库里 —— 手动操作都要先过这一句,否则 404 变成静默无操作 */
const tagsExist = (db: Database.Database, ids: number[]): boolean => {
  const uniq = [...new Set(ids)];
  const n = (db
    .prepare(`SELECT COUNT(*) n FROM tags WHERE id IN (${uniq.map(() => '?').join(',')})`)
    .get(...uniq) as { n: number }).n;
  return n === uniq.length;
};

export function registerTagRoutes(app: FastifyInstance, deps: TagDeps): void {
  const { db, log } = deps;
  const allItems = () => db.prepare(`SELECT * FROM items`).all() as ItemRow[];

  app.get('/api/tags/status', async () => {
    const tag = readLlmSettings(db, 'tag');
    // 用途平级后没有"回落"了:tag 没配就是没配,界面照实说
    return {
      ...tagStats(db),
      model: tag ? { provider: tag.config.provider, model: tag.config.model, source: 'tag' as const } : null,
    };
  });

  app.post('/api/tags/run', async (req, reply) => {
    const scope = (req.query as { scope?: string }).scope === 'all' ? 'all' : 'missing';
    const llm = readLlmSettings(db, 'tag');
    // **先校验后 hijack** —— 接管响应之后就只能写 SSE 帧,4xx 再也发不出去
    if (!llm) {
      return reply.code(400).send({ ok: false, reason: '还没配模型 —— 先去「授权」页配一个' });
    }

    // 增量口径用 **Set** 不是 `listUntaggedItemIds().includes()`:后者是全库 O(n²) 扫,
    // 3250 条真跑起来是秒级的卡顿
    const untagged = new Set(listUntaggedItemIds(db));
    const pool = allItems().filter((i) => scope === 'all' || untagged.has(i.id));

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    /** 客户端还在吗 —— 断了就别再写了(连接没了,写了也是丢) */
    const closed = () => reply.raw.writableEnded || reply.raw.destroyed;
    // **不能听 req.raw 的 'close'** —— Node ≥16 里它表示"请求体读完了",不是"客户端走了":
    // JSON body 会被 Fastify 在进 handler 之前消费掉,那条 close 在第一个 tick 就触发,
    // 把刚建好的 controller 直接 abort 掉 —— 每跑一条都当场自尽。断开要看**响应**:
    // 我们自己正常收尾(writableEnded)之外的 close 才是客户端真的走了
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    /** 中断收尾:记 warn(用户改主意不是故障,§9D B5)+ 尽力回一帧(连接在就回) */
    const finishAborted = () => {
      log.event({
        level: 'warn',
        category: 'llm',
        code: 'TAGGING_ABORTED',
        message: '用户中止了标注 —— 已完成的条目已保留',
      });
      if (!closed()) reply.raw.write(`event: aborted\ndata: {"reason":"已中止"}\n\n`);
    };

    try {
      const r = await runTagging({
        config: llm.config,
        ctx: llm.ctx,
        items: pool,
        signal: controller.signal,
        db,
        // progress 帧只有这三个数 —— 没有 ruleCount,那是归类的字段
        onBatch: (b) => {
          if (closed()) return; // 帧发不出去,但结果照落(批次落库在 runTagging 里)
          reply.raw.write(
            `event: progress\ndata: ${JSON.stringify({ done: b.done, total: b.total, tagged: b.tagged })}\n\n`,
          );
        },
      });

      // runTagging 中止时**不抛**而是带着已完成的批次原样返回 —— 这里也要认一次,
      // 否则会拿"跑到一半"的结果发 done 帧(把没跑的批次当成标完了)
      if (controller.signal.aborted) return finishAborted();
      if (closed()) return;

      // ── 跑完自动整理(§9F C8 + C9 + C10)────────────────
      // 顺序不能反:先质检(定新词的归宿、剔泛词),再让数据说话(合并/挂父)。
      // 反过来判据会把证据吃掉 —— 详见 tagtree.ts 开头那段。

      /**
       * **质检用的是「标签质检」那个用途的模型,不是打标那个。**
       *
       * 两个要求是相反的:打标要便宜、能丢给本地 4b 跑全库;质检判的是**词性**
       * (量小,十几到几十个词),要准。共用一个槽必然二选一都不对。
       * 所以第五个用途**必须真的被读到** —— 漏了这一行的话它在界面上是个
       * 配置了却永远不生效的下拉,而质检会跟着打标一起跑在本地 4b 上。
       */
      const checker = readLlmSettings(db, 'tagcheck');
      let check = { dropped: 0, merged: 0, moved: 0 };
      if (!checker) {
        log.event({
          level: 'info', category: 'llm',
          message: '没配「标签质检」模型 —— 跳过质检(泛词闸门这轮没跑)',
        });
      } else {
        try {
          check = await runTagCheck({
            config: checker.config,
            tree: listTagTree(db),
            newNames: r.newWords,
            db,
          });
        } catch (e) {
          // 质检失败**不该**把已经标好的东西废掉 —— 下一轮还会再判一次
          log.event({
            level: 'warn', category: 'llm', code: 'TAGCHECK_FAILED',
            message: (e as Error)?.message ?? String(e),
          });
        }
      }

      // 「树的变化」= 质检做的 + 判据做的。清单要**看得见**(C10),
      // 但不设审批闸 —— 用户只要求"看得见它在长什么"
      const changes: TreeChange[] = [];
      if (check.merged > 0 || check.moved > 0 || check.dropped > 0) {
        changes.push({
          kind: 'merge',
          from: '（质检）',
          to: '',
          detail: `合并 ${check.merged} 组 · 挪位 ${check.moved} 个 · 剔除泛词 ${check.dropped} 个`,
        });
      }
      // **判据单独 try** —— 它和质检一样是"锦上添花",不该把已经跑通的标注
      // 连 done 帧一起带崩(质检那步是包着的,这里不包就是两套待遇)
      try {
        changes.push(...reconcile(db));
      } catch (e) {
        log.event({
          level: 'warn', category: 'llm', code: 'TREE_RECONCILE_FAILED',
          message: (e as Error)?.message ?? String(e),
        });
      }
      setSetting(db, CHANGES_KEY, JSON.stringify(changes));

      // 上面两步是网络往返(质检一次 LLM 调用 + 判据一遍全表),可能是**秒级** ——
      // 客户端在这段里走了很正常。和前面那道守卫同理:发不出去的帧不写。
      // (变化清单已经落库了:树是真的动了,跟客户端在不在没关系)
      if (closed()) return;

      log.event({
        level: 'info',
        category: 'llm',
        message: `标注完成:${r.tagged} 条,${r.failedBatches.length} 批失败`,
      });
      reply.raw.write(`event: done\ndata: ${JSON.stringify({
        tagged: r.tagged,
        failedBatches: r.failedBatches,
        check,
        changes,
        // 只报**个数**不报名单:界面上要的是"这轮长了多少新词",名单没人看,
        // 而它可能上千条 —— 塞进 SSE 帧是白占带宽
        newWordCount: r.newWords.length,
      })}\n\n`);
    } catch (e) {
      if (controller.signal.aborted) {
        finishAborted();
      } else {
        const message = (e as Error)?.message ?? String(e);
        log.event({ level: 'error', category: 'llm', code: 'TAGGING_FAILED', message });
        if (!closed()) reply.raw.write(`event: error\ndata: ${JSON.stringify({ reason: message })}\n\n`);
      }
    } finally {
      reply.raw.end();
    }
  });

  // ── 词库树(§9F)────────────────────────────────────
  app.get('/api/tags/tree', async () => {
    const tree = listTagTree(db);
    const count = (nodes: TagNode[]): number =>
      nodes.reduce((n, x) => n + 1 + count(x.children), 0);
    return { tree, total: count(tree) };
  });

  /**
   * 手动合并。**要校验 fromId !== toId** —— 自己并自己没有意义,而且会让
   * mergeTags 里那条 DELETE 把节点删掉。
   */
  app.post('/api/tags/merge', async (req, reply) => {
    const { fromId, toId } = (req.body ?? {}) as { fromId?: number; toId?: number };
    if (typeof fromId !== 'number' || typeof toId !== 'number') {
      return reply.code(400).send({ ok: false, reason: '要给出 fromId 和 toId' });
    }
    if (fromId === toId) return reply.code(400).send({ ok: false, reason: '不能并到自己身上' });
    if (!tagsExist(db, [fromId, toId])) {
      return reply.code(404).send({ ok: false, reason: '词库里没有这个标签' });
    }
    // 闸在 mergeTags 里(防环 + 超深)—— false 是"这两个词不能并",不是故障
    if (!mergeTags(db, fromId, toId)) {
      return reply.code(400).send({ ok: false, reason: '这两个词不能合并(会成环或超出 4 层)' });
    }
    log.event({ level: 'info', category: 'llm', message: `标签合并:${fromId} → ${toId}` });
    return { ok: true };
  });

  /** 改名 / 换父。两个都可选,给哪个改哪个 */
  app.patch('/api/tags/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { name?: string; parentId?: number | null };
    if (!tagsExist(db, [id])) return reply.code(404).send({ ok: false, reason: '词库里没有这个标签' });
    if (body.name !== undefined) {
      if (!body.name.trim()) return reply.code(400).send({ ok: false, reason: '名字不能为空' });
      // renameTag 返回 false = 这个名字已经被别的节点占了(全局唯一,撞了改不动)。
      // **撞名不自动合并** —— 那是「合并」按钮的事;这里必须报出去,回 ok:true
      // 而库里没变,等于对唯一能处理它的调用方撒谎
      if (!renameTag(db, id, body.name)) {
        return reply.code(400).send({ ok: false, reason: '这个名字已经被别的标签占了' });
      }
    }
    if (body.parentId !== undefined) {
      if (body.parentId !== null && !tagsExist(db, [body.parentId])) {
        return reply.code(400).send({ ok: false, reason: '父节点不存在' });
      }
      // 闸在 setTagParent 里(自己挂自己 / 挂到自己的后代 / 超 4 层):
      // false 就是"这次不合法",不是故障
      if (!setTagParent(db, id, body.parentId)) {
        return reply.code(400).send({ ok: false, reason: '不能挂到这个位置(会成环或超出 4 层)' });
      }
    }
    return { ok: true };
  });

  app.delete('/api/tags/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!tagsExist(db, [id])) return reply.code(404).send({ ok: false, reason: '词库里没有这个标签' });
    deleteTag(db, id);
    return { ok: true };
  });

  app.get('/api/tags/changes', async () => {
    const raw = getSetting(db, CHANGES_KEY);
    return { changes: raw ? (JSON.parse(raw) as TreeChange[]) : [] };
  });
}
