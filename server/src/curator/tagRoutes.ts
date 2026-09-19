/**
 * /api/tags/* —— 条目 AI 标注(spec §9E)。
 *
 * **轮询不是 SSE**:这一版把 `run` 从"开 SSE 长连接逐帧推"改成"启动即返回 +
 * 前端轮询 `run-progress`"。原因:umi dev server 的代理在 dev 下对 SSE 长连接
 * 处理有毛病(帧被攒着延迟吐、长连接还会把浏览器到 8000 的同域连接占死,
 * 后续 `tree`/`changes`/`status` 全部 pending)。轮询是短连接,没有这个病。
 *
 * 进度/日志都挂在**内存里的 `currentRun`** 上,`run-progress` 一拉就有。
 * 中止也从"客户端断开才感知"改成显式的 `run-abort` 端点。
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
  listTagTree, mergeTags, setTagParent, renameTag, deleteTag, clearTagLibrary, normalizeTagName,
  subtreeSets, tagScale, type TagNode,
} from '../db/repo/tags.js';
import { runTagCheck } from './tagcheck.js';
import { reconcileWithBudget, MIN_SAMPLE, type TreeChange } from './tagtree.js';
import { getSetting, setSetting } from '../db/repo/state.js';

export interface TagDeps {
  db: Database.Database;
  log: Logger;
}

/** 最近一轮「树的变化」清单存这个键 —— 刷新页面还在(§9F C10 要"看得见") */
const CHANGES_KEY = 'tags.lastChanges';

/**
 * 最近一次 reconcile 的耗时(M4h Task 1)—— `reconcile-stats` 读它。
 * 单进程内存变量:标注一次只跑一轮,没有并发场景,和 currentRun 同一个理由。
 */
const lastReconcile: { ms: number | null; at: number | null } = { ms: null, at: null };

/**
 * 上一轮标注长出的新词 —— 手动质检 scope='new' 用它(不然"只查这次新的"没词可查)。
 * 单进程内存变量,和 lastReconcile 同一个理由:标注一次只跑一轮。
 */
let lastRunNewWords: string[] = [];

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

  /**
   * 当前这一轮标注的实时状态 —— `run-progress` 轮询读的就是它。
   *
   * 单进程内存对象就够了(标注一次只跑一轮,没有并发的场景)。`logs` 是
   * 这一轮的日志行(phase/item/verdict/note 全进),前端按长度增量追加。
   */
  const currentRun: {
    running: boolean;
    scope: 'missing' | 'all' | null;
    done: number;
    total: number;
    tagged: number;
    failedBatches: { firstItemId: string; size: number; reason: string }[];
    /** 完成后才有 —— 结果载荷 */
    result: { tagged: number; failedBatches: { firstItemId: string; size: number; reason: string }[]; newWordCount: number; changes: TreeChange[] } | null;
    error: string | null;
    logs: unknown[];
    /** 中止控制器 —— `run-abort` 端点拿着它停正在跑的那轮 */
    controller: AbortController | null;
  } = {
    running: false,
    scope: null,
    done: 0,
    total: 0,
    tagged: 0,
    failedBatches: [],
    result: null,
    error: null,
    logs: [],
    controller: null,
  };

  app.get('/api/tags/status', async () => {
    const tag = readLlmSettings(db, 'tag');
    // 用途平级后没有"回落"了:tag 没配就是没配,界面照实说
    return {
      ...tagStats(db),
      model: tag ? { provider: tag.config.provider, model: tag.config.model, source: 'tag' as const } : null,
    };
  });

  /**
   * 词库健康度(M4h Task 1)。活跃词数是整理成本的决定量(spec §1.5)——
   * 用户从这里看到"词库正在膨胀"的早期信号,而不是等它卡死。
   */
  app.get('/api/tags/reconcile-stats', async () => {
    // 活跃词的口径和 reconcile 用同一个下限 —— 硬编码会静默分叉
    const { totalTags, activeTags } = tagScale(db, MIN_SAMPLE);
    return { totalTags, activeTags, reconcileMs: lastReconcile.ms, lastRunAt: lastReconcile.at };
  });

  // ── 进度查询 / 中止 ─────────────────────────────────
  app.get('/api/tags/run-progress', async () => {
    const { running, scope, done, total, tagged, failedBatches, result, error, logs } = currentRun;
    return { running, scope, done, total, tagged, failedBatches, result, error, logs };
  });

  app.post('/api/tags/run-abort', async () => {
    // 没有在跑的就当无事发生 —— 幂等,反复点停止不炸
    currentRun.controller?.abort();
    return { ok: true };
  });

  /**
   * 清空标注(M4h 后测试辅助)。**高危、不可撤销** —— 前端必须二次确认(输入「清空」文字)。
   * 连词库树一起清,所有条目回「未标注」,规则里的 tag 条件一并移除。
   */
  app.post('/api/tags/clear-tags', async (req, reply) => {
    if (currentRun.running) {
      return reply.code(409).send({ ok: false, reason: '标注跑着不能清空 —— 先等它跑完或停止' });
    }
    clearTagLibrary(db);
    log.event({ level: 'info', category: 'llm', code: 'TAGS_CLEARED', message: '词库树 + 条目标注已清空' });
    return { ok: true };
  });

  /**
   * 手动质检(spec M4h 扩展)。scope 选范围:
   * - 'new':只检本轮新词(fresh 闸门,老词不碰)
   * - 'all':检全库词,绕过 fresh(老词可能被删,不可逆 —— 弹窗已明示风险)
   * 同步执行;标注跑着时 409。
   */
  app.post('/api/tags/tagcheck', async (req, reply) => {
    if (currentRun.running) {
      return reply.code(409).send({ ok: false, reason: '标注跑着不能质检 —— 先等它跑完或停止' });
    }
    // scope 显式校验:没传或传别的都 400 —— 前端弹窗永远传一个,不许静默落 new
    const scope = (req.body as { scope?: string })?.scope;
    if (scope !== 'all' && scope !== 'new') {
      return reply.code(400).send({ ok: false, reason: 'scope 只能是 all 或 new' });
    }
    const checker = readLlmSettings(db, 'tagcheck');
    if (!checker) {
      return reply.code(400).send({ ok: false, reason: '还没配「标签质检」模型 —— 先去「授权」页配一个' });
    }
    const t0 = Date.now();
    let r;
    try {
      r = await runTagCheck({
        config: checker.config,
        tree: listTagTree(db),
        // scope='new' 用上一轮标注的新词(还没跑过标注就是空数组 → 零批早退,合理:没有"这次新的"可查);
        // scope='all' 待检词由 allTags 决定,newNames 用不上
        newNames: scope === 'new' ? lastRunNewWords : [],
        db,
        log,
        allTags: scope === 'all',
        // 无 signal:手动质检是独立请求,没有 run 的 controller
        timeoutMs: 180_000,
      });
    } catch (e) {
      // 手动质检失败要出声 + 回 500 —— 不能静默返回"删 0 合 0 挪 0"(看起来像"什么都没检"但其实是挂了)
      const message = (e as Error)?.message ?? String(e);
      log.event({ level: 'warn', category: 'llm', code: 'TAGCHECK_FAILED', message });
      return reply.code(500).send({ ok: false, reason: `质检失败:${message}` });
    }
    console.log(`[tags/check] 手动质检完成 scope=${scope} 耗时 ${Date.now() - t0}ms`);
    log.event({ level: 'info', category: 'llm', code: 'TAGCHECK_MANUAL', message: `手动质检:${scope}` });
    return { ok: true, scope, ...r };
  });

  app.post('/api/tags/run', async (req, reply) => {
    // 已经在跑就拒掉 —— 轮询版没有"再开一条连接同跑"的可能(那是 SSE 时代的坑),
    // 但两个标签页同时点还是可能撞上,守一道
    if (currentRun.running) {
      return reply.code(409).send({ ok: false, reason: '已有一轮标注在跑 —— 等它跑完或先停止' });
    }

    const scope = (req.query as { scope?: string }).scope === 'all' ? 'all' : 'missing';
    const llm = readLlmSettings(db, 'tag');
    if (!llm) {
      return reply.code(400).send({ ok: false, reason: '还没配模型 —— 先去「授权」页配一个' });
    }

    // 增量口径用 **Set** 不是 `listUntaggedItemIds().includes()`:后者是全库 O(n²) 扫,
    // 3250 条真跑起来是秒级的卡顿
    const untagged = new Set(listUntaggedItemIds(db));
    console.log(`[tags/run] 请求到达 scope=${scope} 未标注=${untagged.size}`);
    // **两条腿都排除已失效**:`scope='missing'` 靠上面的 Set(它已经不带 invalid 了),
    // 但 `scope='all'` 是直接拿全表 —— 不加这句,「重新标注全部」会把 300 条
    // 「已失效视频」占位符也喂给模型,一个没标题没简介的条目模型什么都标不出来,
    // 白花一轮调用(还记一批失败)。invalid 在 items 上一直有、界面上也一直有徽标
    const pool = allItems().filter((i) => (scope === 'all' || untagged.has(i.id)) && i.invalid === 0);
    console.log(`[tags/run] 池子算完 poolSize=${pool.length} —— 启动即返回,后台跑`);

    // **启动即返回** —— 后台跑,前端靠轮询 run-progress 看进度
    reply.send({ ok: true, poolSize: pool.length });

    // 初始化这一轮的状态
    const controller = new AbortController();
    currentRun.running = true;
    currentRun.scope = scope;
    currentRun.done = 0;
    currentRun.total = pool.length;
    currentRun.tagged = 0;
    currentRun.failedBatches = [];
    currentRun.result = null;
    currentRun.error = null;
    currentRun.logs = [];
    currentRun.controller = controller;

    /** 日志的唯一出口 —— SSE 版写帧,这里写进 currentRun.logs 让轮询读到 */
    const frame = (event: 'phase' | 'item' | 'verdict' | 'note', data: unknown) => {
      // 载荷里补上 type —— 前端受控联合的判别字段(原来在前端解析时补,现在这里补)
      currentRun.logs.push({ type: event, ...(data as object) });
    };
    /** note 帧的两个字段就这么两个,包一层省得每个调用点都写一遍对象字面量 */
    const note = (level: 'info' | 'warn', text: string) => frame('note', { level, text });

    /** 中止收尾:记 warn(用户改主意不是故障,§9D B5)+ 日志留一行 */
    const finishAborted = () => {
      const message = '用户中止了标注 —— 已完成的条目已保留';
      log.event({ level: 'warn', category: 'llm', code: 'TAGGING_ABORTED', message });
      note('warn', message);
    };

    /**
     * 打标阶段的开场(§9D.7)。空池子**不该有打标阶段**:发 phase 帧会让人以为
     * "用这个模型标了",而真相是"没什么可跑的"。
     */
    if (pool.length > 0) {
      frame('phase', { phase: 'tag', provider: llm.config.provider, model: llm.config.model });
    }

    try {
      // 空池子直接给一份"无事发生"的结果 —— 形状不变(§9D.7),数全为 0
      const r = pool.length === 0
        ? { tagged: 0, failedBatches: [], newWords: [] }
        : await runTagging({
            config: llm.config,
            ctx: llm.ctx,
            items: pool,
            signal: controller.signal,
            db,
            // 每批完成更新一次进度 —— 轮询端点读到的最新值
            onBatch: (b) => {
              currentRun.done = b.done;
              currentRun.total = b.total;
              currentRun.tagged = b.tagged;
              currentRun.failedBatches = b.failedBatches;
            },
            onItem: (i) => frame('item', i),
            onNote: note,
          });

      // runTagging 中止时**不抛**而是带着已完成的批次原样返回 —— 这里也要认一次,
      // 否则会拿"跑到一半"的结果发 done 帧(把没跑的批次当成标完了)
      if (controller.signal.aborted) {
        finishAborted();
        return;
      }

      // 空池子(本轮一条都没标)→ **树没变,跳过质检和整理**(M4h Task 2)。
      // reconcile 是同步全量计算,词库大时空池子的高频点击也会把它拖成秒级卡顿;
      // 而它整理的历史同义词在下次真实增量标注时一并合并(树真的变了才需要整理)。
      // 已知限制:全标完且再无新条目时历史同义词暂停整理 —— spec §2.2 接受。
      if (pool.length === 0) {
        note('info', '没有需要标注的条目 —— 有效的都标过了');
        log.event({ level: 'info', category: 'llm', message: '没有需要标注的条目 —— 有效的都标过了' });
        currentRun.done = 0;
        currentRun.tagged = 0;
        currentRun.failedBatches = [];
        currentRun.result = { tagged: 0, failedBatches: [], newWordCount: 0, changes: [] };
        return;
      }

      // ── 跑完自动整理(§9F C8 + C9 + C10)────────────────
      // 顺序不能反:先质检(定新词的归宿、剔泛词),再让数据说话(合并/挂父)。
      // 反过来判据会把证据吃掉 —— 详见 tagtree.ts 开头那段。

      // 上一轮新词落给手动质检 scope='new' 用(没词也记 —— 空数组意味着"这轮没长出新的")
      lastRunNewWords = r.newWords;

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
        // 跳过质检只发 note、不发 phase 帧:phase 是"这一阶段开跑了",而这里根本没跑
        note('warn', '没配「标签质检」模型 —— 跳过质检,这轮泛词闸门没跑');
      } else {
        try {
          console.log(`[tags/run] 打标完成,共 ${r.tagged} 条 —— 开始质检(${checker.config.model}),新词 ${r.newWords.length} 个`);
          frame('phase', { phase: 'check', provider: checker.config.provider, model: checker.config.model });
          check = await runTagCheck({
            config: checker.config,
            tree: listTagTree(db),
            newNames: r.newWords,
            db,
            // 质检"一个词都没判回来"要出声 —— 那个失败看起来和"什么都没变"一模一样
            log,
            onVerdict: (v) => frame('verdict', v),
            onNote: note,
            // 中止 + 超时都要透传:质检挂起不能把 running 永久钉在 true(和打标同款)
            signal: controller.signal,
            timeoutMs: 180_000,
          });
        } catch (e) {
          // 质检失败**不该**把已经标好的东西废掉 —— 下一轮还会再判一次
          const message = (e as Error)?.message ?? String(e);
          log.event({
            level: 'warn', category: 'llm', code: 'TAGCHECK_FAILED',
            message,
          });
          // 整段质检挂了比"一个词都没判回来"更重(那是调用成功但输出空),必须进日志
          note('warn', `标签质检整段失败(${message})—— 已标好的照旧保留,下一轮会再判`);
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
      // 连 done 帧一起带崩(质检那步是包着的,这里不包就是两套待遇)。
      // 超时也是 warn 但不当作失败(M4h Task 3):部分整理已落库,差的下一轮补
      const t0 = Date.now();
      console.log(`[tags/run] 质检完成(剔 ${check.dropped}/合 ${check.merged}/挪 ${check.moved})—— 开始判据整理`);
      try {
        const { changes: treeChanges, timedOut, limitRaised } = reconcileWithBudget(db);
        changes.push(...treeChanges);
        lastReconcile.ms = Date.now() - t0;
        lastReconcile.at = Date.now();
        if (timedOut) {
          log.event({
            level: 'warn', category: 'llm', code: 'TREE_RECONCILE_TIMEOUT',
            message: '词库整理超时,本轮部分整理 —— 活跃词过多需要治理',
          });
        }
        // 活跃词破限自动提了下限 —— 规模治理的可见信号,用户该知道"词库在膨胀"
        if (limitRaised) {
          log.event({
            level: 'info', category: 'llm', code: 'TREE_RECONCILE_LIMIT_RAISED',
            message: '活跃词过多,统计下限自动从 5 提到 10 —— 词库在膨胀,该治理了',
          });
        }
      } catch (e) {
        log.event({
          level: 'warn', category: 'llm', code: 'TREE_RECONCILE_FAILED',
          message: (e as Error)?.message ?? String(e),
        });
      }
      setSetting(db, CHANGES_KEY, JSON.stringify(changes));

      // **每批失败都落一条 events,带上 firstItemId / size / reason。**
      for (const b of r.failedBatches) {
        log.event({
          level: 'warn', category: 'llm', code: 'TAGGING_BATCH_FAILED',
          message: `标注批失败:${b.size} 条`,
          detail: { firstItemId: b.firstItemId, size: b.size, reason: b.reason },
        });
      }

      log.event({
        level: 'info',
        category: 'llm',
        message: `标注完成:${r.tagged} 条,${r.failedBatches.length} 批失败`,
      });

      // 完成态写入 currentRun —— 前端轮询到 running=false 且有 result 就知道跑完了
      currentRun.done = r.tagged;
      currentRun.tagged = r.tagged;
      currentRun.failedBatches = r.failedBatches;
      currentRun.result = {
        tagged: r.tagged,
        failedBatches: r.failedBatches,
        newWordCount: r.newWords.length,
        changes,
      };
    } catch (e) {
      if (controller.signal.aborted) {
        finishAborted();
      } else {
        const message = (e as Error)?.message ?? String(e);
        log.event({ level: 'error', category: 'llm', code: 'TAGGING_FAILED', message });
        currentRun.error = message;
      }
    } finally {
      currentRun.running = false;
      currentRun.controller = null;
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
