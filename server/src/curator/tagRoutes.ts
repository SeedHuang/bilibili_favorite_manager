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
import { getItem, type ItemRow } from '../db/repo/items.js';
import { listWorkFolders } from '../db/repo/workbench.js';
import { shapeItem } from '../http/routes/items.js';
import { runTagging } from './tagger.js';
import {
  listTagTree, mergeTags, setTagParent, renameTag, deleteTag, normalizeTagName,
  subtreeSets, type TagNode,
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

/**
 * 「这次改动不合法」的哨兵 —— PATCH 路由用它把两种失败分开。
 *
 * 那个事务里两类失败必须走不同状态码:**用户输入不合法**是 400,**库真出故障**是 500。
 * 都用裸 `Error` 的话 `catch` 无从分辨,只能一律当 400 —— 等于把一次 SQLite 故障
 * 谎报成"你的输入有问题",还把内部错误串当成校验文案发给客户端。
 * 错误归类错了比响亮地失败更糟,所以宁可多这一个类型。
 */
class Rejected extends Error {}

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

    /**
     * **两条腿要么一起成,要么一起不成。**
     *
     * 一个请求里同时给 `name` 和 `parentId` 是正常用法(本文件自己的用例就这么发)。
     * 分开写的话,改名已经提交、挂父那步才失败 —— 调用方拿到 400,名字却已经改了,
     * 刷新一下才发现。手动路由是**自动整理搞错时用户唯一的逃生口**,一个报"失败"
     * 却已经动过手的逃生口比没有更糟。
     *
     * 失败靠**抛**来中止:事务正常返回才提交。`renameTag` / `setTagParent` 内部
     * 各自的 transaction 会被 savepoint 嵌套进来一起回滚,不用动那两个函数。
     *
     * 抛的是 `Rejected` 而**不是**裸 `Error` —— 见下面 catch 里那段:不区分的话
     * 一次数据库故障会被谎报成 400。
     */
    const reject = (reason: string): never => {
      throw new Rejected(reason);
    };
    try {
      db.transaction(() => {
        if (body.name !== undefined) {
          if (!body.name.trim()) reject('名字不能为空');
          // 标点/空白组成的名字 trim 后非空、归一化后却是空串,`renameTag` 会返回 false。
          // 不单独认出来的话用户会被告知"这个名字已经被别的标签占了" —— 那是句假话
          if (!normalizeTagName(body.name)) reject('名字里没有可用的字符');
          // renameTag 返回 false = 这个名字已经被别的节点占了(全局唯一,撞了改不动)。
          // **撞名不自动合并** —— 那是「合并」按钮的事;这里必须报出去,回 ok:true
          // 而库里没变,等于对唯一能处理它的调用方撒谎
          if (!renameTag(db, id, body.name)) reject('这个名字已经被别的标签占了');
        }
        if (body.parentId !== undefined) {
          if (body.parentId !== null && !tagsExist(db, [body.parentId])) reject('父节点不存在');
          // 闸在 setTagParent 里(自己挂自己 / 挂到自己的后代 / 超 4 层):
          // false 就是"这次不合法",不是故障
          if (!setTagParent(db, id, body.parentId)) reject('不能挂到这个位置(会成环或超出 4 层)');
        }
      })();
    } catch (e) {
      // **不是我们的拒绝 → 照实往上抛**,Fastify 默认处理回 500(和加事务之前一样)。
      // 吞下去当 400 会把"库坏了"说成"你输入错了",还泄漏内部错误串
      if (!(e instanceof Rejected)) throw e;
      return reply.code(400).send({ ok: false, reason: e.message });
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

  /**
   * 按标签筛条目(§9F C12「浏览」页)。
   *
   * **用子树**:选「体育」要能捞出 NBA、世界杯那些 —— 和规则的匹配语义(C11)一致,
   * 否则用户点一下发现"体育 只有 3 条"会以为标签没用。
   *
   * 夹子归属走**同级字段 `foldersOf`**,不塞进 item 里:shapeItem 是"出口形状
   * 单一口径"(见它的注释),加字段会让前端两套渲染分叉。
   */
  app.get('/api/tags/:id/items', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!tagsExist(db, [id])) return reply.code(404).send({ ok: false, reason: '词库里没有这个标签' });
    const q = req.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const pageSize = Math.max(1, Number(q.pageSize ?? 60) || 60);

    const sub = subtreeSets(db).get(id) ?? new Set([id]);
    const ids = db
      .prepare(
        `SELECT DISTINCT item_id FROM item_tags
          WHERE tag_id IN (${[...sub].map(() => '?').join(',')})
          ORDER BY item_id`,
      )
      .all(...sub) as { item_id: string }[];

    const total = ids.length;
    const slice = ids.slice((page - 1) * pageSize, page * pageSize).map((r) => r.item_id);

    // 归属一次查完(工作副本口径 —— 「浏览」看的是"你桌上这份")
    const foldersOf: Record<string, { id: number; title: string }[]> = {};
    const folderName = new Map(listWorkFolders(db).map((f) => [f.id, f.name]));
    if (slice.length) {
      const rows = db
        .prepare(
          `SELECT item_id, folder_id FROM work_folder_items
            WHERE item_id IN (${slice.map(() => '?').join(',')})`,
        )
        .all(...slice) as { item_id: string; folder_id: number }[];
      for (const r of rows) {
        (foldersOf[r.item_id] ??= []).push({ id: r.folder_id, title: folderName.get(r.folder_id) ?? `#${r.folder_id}` });
      }
    }

    const tagsOf: Record<string, string[]> = {};
    if (slice.length) {
      const rows = db
        .prepare(
          `SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
            WHERE it.item_id IN (${slice.map(() => '?').join(',')})
            ORDER BY it.item_id, t.name`,
        )
        .all(...slice) as { item_id: string; name: string }[];
      for (const r of rows) (tagsOf[r.item_id] ??= []).push(r.name);
    }

    return {
      items: slice
        .map((iid) => getItem(db, iid))
        .filter((x): x is ItemRow => x !== undefined)
        .map((x) => shapeItem(x, null)),
      total,
      foldersOf,
      // 详情栏要显示"这条挂的**全部**标签" —— 只显示当前筛的那个词会让人
      // 以为它没有别的标签。和 foldersOf 同一批查完,不多一次往返
      tagsOf,
    };
  });
}
