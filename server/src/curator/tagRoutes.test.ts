import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertItem } from '../db/repo/items.js';
import { seedLlm, setAssignment } from '../llm/config.js';
import { itemTagIds, ensureTag, linkItemTag, listTagTree } from '../db/repo/tags.js';
import { markItemTagged } from '../db/repo/tagging.js';
import type { BiliClient } from '../bilibili/client.js';

// LLM 全 mock —— 路由测试绝不打真实 API(和 routes.test.ts 同一套:importOriginal
// 铺开真模块再覆盖,provider.ts 新增导出时不会静默失效)
const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', async (orig) => ({
  ...(await orig<typeof import('../llm/provider.js')>()),
  complete: mocks.complete,
}));

const stubClient = { withCredentials: () => ({ get: async () => null }) } as unknown as BiliClient;

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  seedLlm(db, { model: 'qwen3-4b' });
  const app = createServer({ db, log, client: stubClient });
  return { app, db };
}

/**
 * 轮询版测试骨架:POST run 启动即返回,后台异步跑。要拿结果得**轮询 run-progress**
 * 直到 running 变 false —— mock 的 complete 是同步 resolve 的,但 runTagging 是
 * async,POST 返回那一刻后台未必跑完,直接断言会读到"还没跑"的状态。
 */
async function runAndSettle(app: Awaited<ReturnType<typeof makeApp>>['app'], url = '/api/tags/run') {
  const res = await app.inject({ method: 'POST', url });
  expect(res.statusCode).toBe(200);
  const progress = await vi.waitFor(async () => {
    const p = (await app.inject({ method: 'GET', url: '/api/tags/run-progress' })).json() as { running: boolean };
    if (p.running) throw new Error('still running');
    return p;
  });
  return progress as {
    running: boolean;
    scope: 'missing' | 'all' | null;
    done: number;
    total: number;
    tagged: number;
    failedBatches: { firstItemId: string; size: number; reason: string }[];
    result: { tagged: number; failedBatches: { firstItemId: string; size: number; reason: string }[]; newWordCount: number; changes: unknown[] } | null;
    error: string | null;
    logs: { type: string; [k: string]: unknown }[];
  };
}

beforeEach(() => vi.clearAllMocks());

describe('标注路由', () => {
  it('status:报已标/总数;打标用途没配 → model 为 null(不再回落主模型)', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    // 用途平级后没有"回落主模型"了:tag 没配就是没配,界面照实说
    setAssignment(db, 'tag', null);

    const res = await app.inject({ url: '/api/tags/status' });
    const body = res.json();
    expect(body.tagged).toBe(0);
    expect(body.total).toBe(1);
    expect(body.model).toBeNull();
    await app.close();
  });

  it('run(scope=missing):只标没标注的;进度 + 结果', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ id: 'BV1', tags: ['教学'], kind: '教学' }, { id: 'BV2', tags: ['娱乐'], kind: '娱乐' }]),
    );

    const p = await runAndSettle(app);
    expect(p.result!.tagged).toBe(2);

    // 增量:再跑一次,没有未标注的 → tagged=0 且一次 LLM 都不调
    mocks.complete.mockClear();
    const p2 = await runAndSettle(app);
    expect(p2.result!.tagged).toBe(0);
    expect(mocks.complete).not.toHaveBeenCalled();
    await app.close();
  });

  // ★ 已失效条目(invalid=1)在池子里的唯一下场就是"每轮失败、永远留下"(没标题没简介,
  //   模型对着占位符「已失效视频」什么都吐不出来,失败又不写水位线)。两个 scope 都得排掉:
  //   missing 靠增量池本身排除,all 是直接拿全表 —— 不加这句,「重新标注全部」就把 300 条
  //   占位符也喂给模型了
  it('run:池子排除 invalid=1(scope=missing 与 scope=all 都不喂给模型)', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BVX', type: 2, title: '已失效视频', invalid: true });

    // missing:模型只该见到那 1 条有效的
    mocks.complete.mockResolvedValue(JSON.stringify([{ id: 'BV1', tags: ['教学'], kind: '教学' }]));
    const p = await runAndSettle(app);
    expect(p.result!.tagged).toBe(1);
    expect(p.result!.failedBatches).toEqual([]);
    // 模型一次只收到一条 —— 断言它**没被喂** BVX(喂了会连它一起回,于是 mock 若回
    // 空就该记 1 批失败,上面 failedBatches=[] 就是在钉"BVX 根本没进池")
    expect(mocks.complete.mock.calls[0]![0].messages[1].content).not.toContain('BVX');

    // all:重标全部,同样不带已失效
    mocks.complete.mockClear();
    mocks.complete.mockResolvedValue(JSON.stringify([{ id: 'BV1', tags: ['娱乐'], kind: '娱乐' }]));
    const p2 = await runAndSettle(app, '/api/tags/run?scope=all');
    expect(p2.result!.tagged).toBe(1);
    expect(p2.result!.failedBatches).toEqual([]);
    await app.close();
  });

  // ★ 上一轮的修复(排除 invalid)让"池子全空"从"每轮失败"变成**真实可达到的状态**:
  // 有效的都标过了、剩下的只有已失效。这一跑**不该有打标阶段** —— 模型一次都不调,
  // 发一帧 info 的 note 说出"没什么可标的"。
  // M4h 起**空池子连质检和判据整理都跳过**(树没变,没必要跑同步全量计算)——
  // 否则用户高频点「AI 标注」会被 reconcile 拖成秒级卡顿。历史同义词在下次真实
  // 增量标注时一并合并(树真的变了才需要整理)。
  it('run(空池子):零模型调用 + info note + 结果形状不变 + 不跑质检和判据', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BVX', type: 2, title: '已失效视频', invalid: true });
    // 造出用户现在的真实形状:有效的标过了、只有失效的剩着
    markItemTagged(db, 'BV1', '教学');
    const s1 = ensureTag(db, '教学', null);
    linkItemTag(db, 'BV1', s1, 'ai');
    // 再造一棵**判据会想改动**的树:体育 + 篮球 两个**根词**挂同一批视频(重合 100%,
    // 样本够 5)—— 旧版空池子会把它合并掉。新行为下它必须**原样不动**:空池子不整理
    const sport = ensureTag(db, '体育', null);
    const ball = ensureTag(db, '篮球', null);
    for (let i = 0; i < 5; i++) {
      upsertItem(db, { id: `BV${i}`, type: 2, title: `篮球${i}` });
      // 它们也得标过 —— 否则 `ai_checked_at IS NULL` 会把这些**有效**条目送进增量池,
      // 池子就不空了,runTagging 照跑。空池子必须是"有效全标完、只剩已失效"
      markItemTagged(db, `BV${i}`, '体育');
      linkItemTag(db, `BV${i}`, sport, 'ai');
      linkItemTag(db, `BV${i}`, ball, 'ai');
    }

    mocks.complete.mockClear();
    const p = await runAndSettle(app);
    // **一个模型调用都不发** —— 空池子没有任何可标的,模型不该被请来
    expect(mocks.complete).not.toHaveBeenCalled();
    // 出声:一句 info 的 note 说明"没什么可标的"(日志抽屉里能看到为什么这轮无事发生)
    const infos = p.logs.filter((l) => l.type === 'note' && l.level === 'info');
    expect(infos.length).toBeGreaterThan(0);
    expect(String(infos[0]!.text)).toContain('没有需要标注的条目');
    // 没有任何 phase —— 空池子这轮打标、质检都没跑
    expect(p.logs.some((l) => l.type === 'phase')).toBe(false);
    // 结果形状不变(§9D.7 契约),数全为 0,变化清单也是空的(没跑质检和判据)
    expect(p.result).toMatchObject({
      tagged: 0, failedBatches: [], newWordCount: 0, changes: [],
    });
    // **判据没跑**:双向 100% 重合的两个根词原样都在 —— 空池子树没变,不整理
    const names = listTagTree(db).map((n) => n.name);
    expect(names).toContain('体育');
    expect(names).toContain('篮球');
    await app.close();
  });

  // ★ M4h Task 2 的保留面:**树变了(池子非空)就整理** —— 空池子跳过不丢功能。
  // 同样那对 100% 重合的根词,这次池子里有一条真待标的:标注跑完,判据照常把它们合并,
  // 耗时落进 lastReconcile(Task 1 的指标)。
  it('run(池子非空):标注后判据照常整理 —— 空池子跳过不丢这个功能', async () => {
    const { app, db } = makeApp();
    mocks.complete.mockResolvedValue(JSON.stringify([{ id: 'BV9', tags: ['教学'], kind: '教学' }]));
    // 体育 + 篮球 两根词挂同一批 5 条(重合 100%)—— 都标过水位线,不进池子;
    // 另有 1 条真待标的 BV9,让"池子非空"
    const sport = ensureTag(db, '体育', null);
    const ball = ensureTag(db, '篮球', null);
    for (let i = 0; i < 5; i++) {
      upsertItem(db, { id: `BV${i}`, type: 2, title: `篮球${i}` });
      markItemTagged(db, `BV${i}`, '体育');
      linkItemTag(db, `BV${i}`, sport, 'ai');
      linkItemTag(db, `BV${i}`, ball, 'ai');
    }
    upsertItem(db, { id: 'BV9', type: 2, title: 'a' });

    const p = await runAndSettle(app);
    expect(p.result!.tagged).toBe(1);
    // 判据照跑:100% 重合的两个根词被合并(这轮真的长出了东西,树要整理)
    const names = listTagTree(db).map((n) => n.name);
    expect(names).toContain('体育');
    expect(names).not.toContain('篮球');
    // Task 1 的指标端点:总词数 / 活跃词数 / 最近一次耗时都报得出来
    const stats = (await app.inject({ method: 'GET', url: '/api/tags/reconcile-stats' })).json() as {
      totalTags: number; activeTags: number; reconcileMs: number | null;
    };
    expect(stats.reconcileMs).not.toBeNull();
    expect(stats.totalTags).toBeGreaterThan(0);
    expect(stats.activeTags).toBeGreaterThan(0);
    await app.close();
  });

  it('status:带已失效计数(分母排掉它之后,单独报出来)', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BVX', type: 2, title: '已失效视频', invalid: true });

    const res = await app.inject({ url: '/api/tags/status' });
    expect(res.json()).toMatchObject({ tagged: 0, total: 1, invalid: 1 });
    await app.close();
  });

  // ★ 失败原因要能事后从库里查出来 —— 它此前只活在 SSE 帧和屏幕上(用户报的
  //   「3 批失败」那行,库里的 events 是空 code + 空 detail)。「补两轮仍未覆盖」
  //   正是用户这次撞上的那种,和「请求失败」都在 failedBatches 里,一条循环都写
  it('run:每批失败写一条 events,带着 firstItemId / size / reason', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    mocks.complete.mockRejectedValue(new Error('连接被拒'));

    const p = await runAndSettle(app);
    expect(p.result!.failedBatches).toHaveLength(1);

    const row = db.prepare(
      `SELECT level, code, message, detail FROM events WHERE code = 'TAGGING_BATCH_FAILED'`,
    ).get() as { level: string; code: string; message: string; detail: string };
    expect(row.level).toBe('warn');
    expect(row.message).toContain('1 条');
    expect(JSON.parse(row.detail)).toEqual({ firstItemId: 'BV1', size: 1, reason: '请求失败:连接被拒' });
    await app.close();
  });

  // **POST run 返回那一刻,total 就该带着全量分母。** 这是"一共多少个"唯一的数据源:
  // 池子在开跑前算好、跑中不变,所以启动时就能给。模型回空(一条都标不上)时
  // onBatch 一次都不调 —— total 是**唯一**的进度来源,必须对。
  it('run:启动即报出本轮池子的总数(模型回空也报)', async () => {
    const { app, db } = makeApp();
    for (let i = 0; i < 20; i++) upsertItem(db, { id: `BV${i}`, type: 2, title: `题${i}` });
    // 一条都标不上(模型回空)→ 一次 onBatch 都不会调 —— total 就是**唯一**的进度来源
    mocks.complete.mockResolvedValue('[]');

    const res = await app.inject({ method: 'POST', url: '/api/tags/run' });
    // 启动响应本身就带 poolSize —— 前端第一眼就知道"一共多少个"
    expect(res.json()).toMatchObject({ ok: true, poolSize: 20 });
    // 轮询端点也带着同一个数,跑完 done 停在 0
    const p = await runAndSettle(app);
    expect(p.total).toBe(20);
    expect(p.done).toBe(0);
    await app.close();
  });

  it('run(scope=all):已标注的也重标', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    mocks.complete.mockResolvedValue(JSON.stringify([{ id: 'BV1', tags: ['教学'], kind: '教学' }]));
    await runAndSettle(app);

    mocks.complete.mockClear();
    mocks.complete.mockResolvedValue(JSON.stringify([{ id: 'BV1', tags: ['娱乐'], kind: '娱乐' }]));
    const p = await runAndSettle(app, '/api/tags/run?scope=all');
    expect(p.result!.tagged).toBe(1);
    // 形态是**覆盖写**的(不像 item_tags 是累加)—— 重标后 kind 变成第二次的『娱乐』
    const row = db.prepare(`SELECT ai_kind FROM items WHERE id='BV1'`).get() as { ai_kind: string };
    expect(row.ai_kind).toBe('娱乐');
    await app.close();
  });

  it('中止:run-abort → 已完成的批次落库不回滚,没跑的没被补成结果', async () => {
    const { app, db } = makeApp();
    for (let i = 0; i < 40; i++) upsertItem(db, { id: `BV${i}`, type: 2, title: `题${i}` });

    // 第一批照常跑完(落库),**第二批**才模拟「用户点停止」:调 run-abort 中止路由侧
    // 的 controller,等 provider 真的感知 abort 之后抛 AbortError —— 不依赖事件循环先后。
    //
    // mock 必须回**本批自己的 id**:只回固定一条的话,"标了几条"和"中止有没有生效"
    // 分不开 —— 那样无论中止与否都只落 1 条,断言就等于没测。
    let calls = 0;
    mocks.complete.mockImplementation(
      async ({ messages, abortSignal }: { messages: { content: string }[]; abortSignal?: AbortSignal }) => {
        calls += 1;
        if (calls >= 2) {
          await app.inject({ method: 'POST', url: '/api/tags/run-abort' });
          if (abortSignal && !abortSignal.aborted) {
            await new Promise<void>((resolve) =>
              abortSignal.addEventListener('abort', () => resolve(), { once: true }),
            );
          }
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        const ids = [...messages[1]!.content.matchAll(/\[(BV\d+)\]/g)].map((m) => m[1]!);
        return JSON.stringify(ids.map((id) => ({ id, tags: ['教学'], kind: '教学' })));
      },
    );

    // 启动即返回;跑完(被中止)后 run-progress 的 running 也该回 false
    const res = await app.inject({ method: 'POST', url: '/api/tags/run' });
    expect(res.statusCode).toBe(200);
    const p = await vi.waitFor(async () => {
      const prog = (await app.inject({ method: 'GET', url: '/api/tags/run-progress' })).json() as {
        running: boolean; result: { tagged: number; failedBatches: unknown[] } | null;
      };
      if (prog.running) throw new Error('still running');
      return prog;
    });

    // 标上了 = 水位线落了(§9F:ai_checked_at 是"标过"的唯一依据)
    const tagged = (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE ai_checked_at IS NOT NULL`).get() as { n: number }).n;
    expect(tagged).toBeGreaterThan(0); // 已完成的批次保留
    expect(tagged).toBeLessThan(40); // 没跑的批次没被补成"结果"
    expect(p.result).toBeNull(); // 中止没有结果载荷 —— 前端靠 running=false + result=null 识别"被中断"

    // 中止记 warn 不是 error(用户改主意不是故障)。silent 只关 stdout,events 表照写。
    await vi.waitFor(() =>
      expect(db.prepare(`SELECT level FROM events WHERE code='TAGGING_ABORTED'`).get()).toEqual({
        level: 'warn',
      }),
    );

    // 中止之后**一次调用都没再发**:40 条 / 批上限 5 = **8 批**(5+5+...),而调用停在 2
    // —— 少的正是"中止之后的那一次"。中止发生在 call 2(第 2 批)的抛出处,之后每批开工前
    // 的守卫(tagger.ts:210)与补轮那条(:216)都看得见同一个 `signal.aborted`,于是后续
    // 批次一次都没发出去。
    expect(mocks.complete).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it('没配任何模型 → 400', async () => {
    const { app, db } = makeApp();
    db.prepare(`DELETE FROM settings`).run();
    const res = await app.inject({ method: 'POST', url: '/api/tags/run' });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('还没配模型');
    await app.close();
  });

  // §9D.7:日志四种帧。**item 帧**是"什么视频标了什么词"的唯一来源 —— 不带标题的话
  // 用户对着一个 BV 号根本认不出是哪条
  it('run:每条视频标完记一行 item,带着标题和标签', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: '在新疆野外烤羊肉' });
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ id: 'BV1', kind: '娱乐', domains: ['美食'], tags: ['烤羊肉'] }]),
    );

    const p = await runAndSettle(app);
    const items = p.logs.filter((l) => l.type === 'item');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'BV1', title: '在新疆野外烤羊肉', kind: '娱乐', domains: ['美食'], tags: ['烤羊肉'],
    });
    await app.close();
  });

  // §9D.7:**verdict 帧**是"质检每个词判成了什么"的唯一来源。drop 和 keep 都要报 ——
  // 用户问的是"每个词怎么判的",只报动手的那些是半份日志
  it('run:质检每判一个词记一行 verdict', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    mocks.complete
      // 第一次调用是打标(模型给这条标出 AI / 美食),第二次是质检 —— 两种形状的返回
      .mockResolvedValueOnce(JSON.stringify([{ id: 'BV1', kind: '娱乐', domains: ['美食'], tags: ['AI'] }]))
      .mockResolvedValueOnce(JSON.stringify([
        { name: 'AI', action: 'drop' },
        { name: '美食', action: 'keep' },
      ]));

    const p = await runAndSettle(app);
    const verdicts = p.logs.filter((l) => l.type === 'verdict');
    expect(verdicts.map((v) => ({ name: v.name, action: v.action }))).toEqual([
      { name: 'AI', action: 'drop' },
      { name: '美食', action: 'keep' },
    ]);
    await app.close();
  });

  // §9D.7:**note 帧**是失败唯一会在过程里出声的地方 —— 整批失败此前只出现在
  // done 帧的计数里,而用户两次报的都是"它跑过了,我不知道刚才发生了什么"
  it('run:整批失败时记一行 warn 的 note(不能只在结果的计数里)', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    mocks.complete.mockRejectedValue(new Error('连接被拒'));

    const p = await runAndSettle(app);
    const notes = p.logs.filter((l) => l.type === 'note');
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.some((n) => n.level === 'warn' && String(n.text).includes('没标上'))).toBe(true);
    await app.close();
  });

  // ★ M4h 之后的新测试辅助:一键回到「从没标过」,测「继续标注」性能用。
  // 清空的是**整棵词库树**(tags + item_tags + tag_aliases)+ items 水位线 + 规则里的 tag 条件。
  it('clear-tags:清掉词库树、水位线、规则 tag 条件;幂等', async () => {
    const { app, db } = makeApp();
    // 造一个词 + 挂载 + 标注过 + 一条规则引用它
    const tag = ensureTag(db, '美食', null);
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    linkItemTag(db, 'BV1', tag, 'ai');
    markItemTagged(db, 'BV1', '美食');
    // 规则条件引用这个 tag id —— C16 说删 tag 必须清掉,否则规则静默失效
    db.prepare(
      `INSERT INTO work_folders (id, origin_id, name, created_at) VALUES (1, NULL, 'x', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO work_folder_rules (folder_id, conditions_json, origin, updated_at)
       VALUES (1, ?, 'user', 0)`,
    ).run(JSON.stringify([{ field: 'tag', any: [String(tag)] }]));

    const res = await app.inject({ method: 'POST', url: '/api/tags/clear-tags' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // 词库树空了(级联带走了 item_tags / tag_aliases)
    expect(db.prepare(`SELECT COUNT(*) n FROM tags`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) n FROM item_tags`).get()).toEqual({ n: 0 });
    // 水位线清了 → 回「未标注」
    expect(db.prepare(`SELECT ai_checked_at FROM items WHERE id='BV1'`).get()).toEqual({ ai_checked_at: null });
    // 规则里的 tag 条件被移除
    const rule = db.prepare(`SELECT conditions_json FROM work_folder_rules WHERE folder_id=1`).get() as { conditions_json: string };
    expect(rule.conditions_json).not.toContain('tag');
    // 记了 TAGS_CLEARED
    expect(db.prepare(`SELECT code FROM events WHERE code='TAGS_CLEARED'`).get()).toBeTruthy();

    // 幂等:再清一遍也 ok
    const res2 = await app.inject({ method: 'POST', url: '/api/tags/clear-tags' });
    expect(res2.statusCode).toBe(200);
    await app.close();
  });

  it('clear-tags:标注跑着时拒绝(409)', async () => {
    const { app, db } = makeApp();
    // 没有公开端点能直接造"正在跑"的状态,只能靠真实标注跑起来:
    // 用一个不 resolve 的 mock 让 complete 挂起,currentRun.running 停在 true
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    let release!: () => void;
    // 只让**第一次**(打标)挂起;release 之后 tagcheck 还会再调一次 complete,
    // 那次得照常 resolve —— 否则 running 永远回不了 false,测试收不了尾
    let call = 0;
    mocks.complete.mockImplementation(
      () => {
        call += 1;
        if (call === 1) {
          return new Promise((res) => { release = () => res(JSON.stringify([{ id: 'BV1', tags: ['x'], kind: 'x' }])); });
        }
        return Promise.resolve(JSON.stringify([]));
      },
    );
    const runRes = await app.inject({ method: 'POST', url: '/api/tags/run' });
    expect(runRes.statusCode).toBe(200);
    // complete 没 resolve → currentRun.running 仍 true;这时 clear 该 409
    const clearRes = await app.inject({ method: 'POST', url: '/api/tags/clear-tags' });
    expect(clearRes.statusCode).toBe(409);
    release(); // 放行,免得 pending promise 卡住测试
    await vi.waitFor(async () => {
      const p = (await app.inject({ method: 'GET', url: '/api/tags/run-progress' })).json() as { running: boolean };
      if (p.running) throw new Error('still running');
    });
    await app.close();
  });
});

describe('标签树路由', () => {
  it('GET /api/tags/tree 回整棵树 + 总数', async () => {
    const { app, db } = makeApp();
    const food = ensureTag(db, '美食', null);
    ensureTag(db, '烤羊肉', food);
    const r = await app.inject({ method: 'GET', url: '/api/tags/tree' });
    const body = r.json();
    expect(body.total).toBe(2);
    expect(body.tree[0].name).toBe('美食');
    expect(body.tree[0].children[0].name).toBe('烤羊肉');
  });

  it('POST /api/tags/merge 把 from 并进 to', async () => {
    const { app, db } = makeApp();
    const a = ensureTag(db, '路飞', null);
    const b = ensureTag(db, '鲁夫', null);
    const r = await app.inject({ method: 'POST', url: '/api/tags/merge', payload: { fromId: b, toId: a } });
    expect(r.statusCode).toBe(200);
    expect(listTagTree(db).map((n) => n.name)).toEqual(['路飞']);
  });

  it('merge 的 fromId === toId → 400', async () => {
    const { app, db } = makeApp();
    const a = ensureTag(db, 'x', null);
    const r = await app.inject({ method: 'POST', url: '/api/tags/merge', payload: { fromId: a, toId: a } });
    expect(r.statusCode).toBe(400);
  });

  // tagsExist 那一句就是为这个分支存在的:不查的话「词库里没有这个标签」会变成
  // 静默无操作 —— 用户点了合并,界面回 ok,库里什么都没发生
  it('merge 的 id 不在词库里 → 404', async () => {
    const { app, db } = makeApp();
    const a = ensureTag(db, '路飞', null);
    const r = await app.inject({ method: 'POST', url: '/api/tags/merge', payload: { fromId: a, toId: 9999 } });
    expect(r.statusCode).toBe(404);
  });

  it('PATCH 改名 + 换父;DELETE 删词', async () => {
    const { app, db } = makeApp();
    const sport = ensureTag(db, '体育', null);
    const camp = ensureTag(db, '露营', null);
    expect((await app.inject({ method: 'PATCH', url: `/api/tags/${camp}`, payload: { name: '野外露营', parentId: sport } })).statusCode).toBe(200);
    expect(listTagTree(db)[0]!.children[0]!.name).toBe('野外露营');
    expect((await app.inject({ method: 'DELETE', url: `/api/tags/${sport}` })).statusCode).toBe(200);
  });

  // 撞名不自动合并(renameTag 的契约)—— 回 ok:true 而库里没变就是对调用方撒谎
  it('PATCH 改名撞上已有词 → 400', async () => {
    const { app, db } = makeApp();
    const a = ensureTag(db, '路飞', null);
    ensureTag(db, '鲁夫', null);
    const r = await app.inject({ method: 'PATCH', url: `/api/tags/${a}`, payload: { name: '鲁夫' } });
    expect(r.statusCode).toBe(400);
  });

  // 一个请求里同时改名 + 挂父是本文件上面那条用例就在用的形状。两条腿必须一起成
  // 或一起不成 —— 只改名成功、挂父失败,调用方拿到 400 却已经被改了名
  it('PATCH 改名合法但挂父非法 → 400,且改名一起回滚(不留半套)', async () => {
    const { app, db } = makeApp();
    const sport = ensureTag(db, '体育', null);
    const league = ensureTag(db, '篮球', sport);
    // league 是 sport 的后代 → 把 sport 挂到 league 下会成环,setTagParent 必拒
    const r = await app.inject({
      method: 'PATCH', url: `/api/tags/${sport}`,
      payload: { name: '体育运动', parentId: league },
    });
    expect(r.statusCode).toBe(400);
    // 名字必须**原样**在库里 —— 这正是"半套"的落点
    const row = db.prepare(`SELECT name FROM tags WHERE id = ?`).get(sport) as { name: string };
    expect(row.name).toBe('体育');
  });

  it('GET /api/tags/:id/items 回条目 + 每条散在哪些夹子', async () => {
    const { app, db } = makeApp();
    const t = ensureTag(db, '露营', null);
    // 两条挂「露营」的视频,都在工作副本的同一个夹子里 —— 归属要跟着回来
    db.prepare(`INSERT INTO work_folders (id, origin_id, name, created_at) VALUES (1, NULL, '露营', 0)`).run();
    for (const id of ['BV1', 'BV2']) {
      upsertItem(db, { id, type: 2, title: `露营 ${id}` });
      linkItemTag(db, id, t, 'ai');
      db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (1, ?)`).run(id);
    }

    const r = await app.inject({ method: 'GET', url: `/api/tags/${t}/items` });
    const body = r.json();
    expect(body.total).toBe(2);
    // shapeItem 的字段一个不少(出口形状单一口径)
    expect(Object.keys(body.items[0]).sort()).toEqual(
      ['cover', 'duration', 'favTime', 'id', 'invalid', 'pubtime', 'title', 'upperName'].sort(),
    );
    // 夹子归属走**同级字段**,不塞进 item 里 —— 免得破坏 shapeItem 的单一口径
    expect(body.foldersOf[body.items[0].id]).toEqual([{ id: 1, title: '露营' }]);
  });

  // **这个页面的承重语义**(C12):选「体育」要能捞出只挂 篮球 的视频。
  //
  // 上面那条用例只挂**叶子**词,所以退化成 `WHERE tag_id = ?` 也照样绿 ——
  // 定义性的行为没有测试钉住。而"点一个词捞不出它下面的词"正是这一页存在的理由,
  // 和规则引擎的 tag 条件(C11)也是同一套语义,两处必须一致。
  it('GET /api/tags/:id/items 走子树 —— 只挂子词的条目也捞得出来', async () => {
    const { app, db } = makeApp();
    const sport = ensureTag(db, '体育', null);
    const ball = ensureTag(db, '篮球', sport);
    // 这条**一个父词都没挂**,只有 篮球
    upsertItem(db, { id: 'BV1', type: 2, title: '篮球教学' });
    linkItemTag(db, 'BV1', ball, 'ai');

    const r = await app.inject({ method: 'GET', url: `/api/tags/${sport}/items` });
    const body = r.json();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('BV1');
  });

  // 标点组成的名字 trim 后非空、归一化后是空串:状态码本来就是 400,别让文案变成谎话
  it('PATCH 名字只有标点 → 400,理由不是"被占了"', async () => {
    const { app, db } = makeApp();
    const a = ensureTag(db, '路飞', null);
    const r = await app.inject({ method: 'PATCH', url: `/api/tags/${a}`, payload: { name: '——' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().reason).toBe('名字里没有可用的字符');
  });
});
