import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertItem } from '../db/repo/items.js';
import { seedLlm, setAssignment } from '../llm/config.js';
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

/** SSE 文本 → [{event, data}] */
const sse = (body: string) =>
  body.split('\n\n').filter((b) => b.trim()).map((b) => ({
    event: /^event: (.+)$/m.exec(b)?.[1] ?? 'message',
    data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? '{}') as Record<string, unknown>,
  }));

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

  it('run(scope=missing):只标没标注的;progress + done 帧', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ id: 'BV1', tags: ['教学'], kind: '教学' }, { id: 'BV2', tags: ['娱乐'], kind: '娱乐' }]),
    );

    const res = await app.inject({ method: 'POST', url: '/api/tags/run' });
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = sse(res.body);
    expect(events.find((e) => e.event === 'done')!.data.tagged).toBe(2);

    // 增量:再跑一次,没有未标注的 → done.tagged=0 且一次 LLM 都不调
    mocks.complete.mockClear();
    const res2 = await app.inject({ method: 'POST', url: '/api/tags/run' });
    expect(sse(res2.body).find((e) => e.event === 'done')!.data.tagged).toBe(0);
    expect(mocks.complete).not.toHaveBeenCalled();
    await app.close();
  });

  it('run(scope=all):已标注的也重标', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    mocks.complete.mockResolvedValue(JSON.stringify([{ id: 'BV1', tags: ['教学'], kind: '教学' }]));
    await app.inject({ method: 'POST', url: '/api/tags/run' });

    mocks.complete.mockClear();
    mocks.complete.mockResolvedValue(JSON.stringify([{ id: 'BV1', tags: ['娱乐'], kind: '娱乐' }]));
    const res = await app.inject({ method: 'POST', url: '/api/tags/run?scope=all' });
    expect(sse(res.body).find((e) => e.event === 'done')!.data.tagged).toBe(1);
    const row = db.prepare(`SELECT ai_tags FROM items WHERE id='BV1'`).get() as { ai_tags: string };
    expect(JSON.parse(row.ai_tags).kind).toBe('娱乐');
    await app.close();
  });

  it('中止:inject signal → 已完成的批次落库不回滚,没跑的没被补成结果', async () => {
    const { app, db } = makeApp();
    for (let i = 0; i < 40; i++) upsertItem(db, { id: `BV${i}`, type: 2, title: `题${i}` });

    // 第一批照常跑完(落库),**第二批**才模拟「客户端断开」:abort 掉 inject 的 signal,
    // 等**路由侧**的 signal 真的 abort 之后再抛 AbortError(provider 被中断时就是抛这个)
    // —— 不依赖事件循环先后(照 routes.test.ts 的 run-pass-2 中断用例)
    //
    // mock 必须回**本批自己的 id**:只回固定一条的话,"标了几条"和"中止有没有生效"
    // 分不开 —— 那样无论中止与否都只落 1 条,断言就等于没测。
    const controller = new AbortController();
    let calls = 0;
    mocks.complete.mockImplementation(
      async ({ messages, abortSignal }: { messages: { content: string }[]; abortSignal?: AbortSignal }) => {
        calls += 1;
        if (calls >= 2) {
          controller.abort();
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

    // **不能用 res.body 断言 aborted 帧** —— 客户端自己就是那个断开的,路由侧的
    // aborted 帧根本发不出去;而 inject 的 promise 会跟着 reject(§9D 测试同款),
    // 不吞掉它 await 当场抛。要验的是中止的**效果**
    await app
      .inject({ method: 'POST', url: '/api/tags/run', signal: controller.signal })
      .catch(() => undefined);

    const tagged = (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE ai_tags IS NOT NULL`).get() as { n: number }).n;
    expect(tagged).toBeGreaterThan(0); // 已完成的批次保留
    expect(tagged).toBeLessThan(40); // 没跑的批次没被补成"结果"
    // 中止真的让后面**一次调用都没再发**:40 条 / 批上限 32 = 2 批,第 2 批撞上中止
    expect(mocks.complete).toHaveBeenCalledTimes(2);

    // 中止记 warn 不是 error(用户改主意不是故障)。silent 只关 stdout,events 表照写。
    // **要 waitFor** —— 断开那一刻 inject 的 promise 就落定了,路由的收尾(记日志 → end)
    // 是在那之后接着跑的,直接断言会读到还没写的库
    await vi.waitFor(() =>
      expect(db.prepare(`SELECT level FROM events WHERE code='TAGGING_ABORTED'`).get()).toEqual({
        level: 'warn',
      }),
    );
    await app.close();
  });

  it('没配任何模型 → 400(不是 SSE)', async () => {
    const { app, db } = makeApp();
    db.prepare(`DELETE FROM settings`).run();
    const res = await app.inject({ method: 'POST', url: '/api/tags/run' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).not.toContain('text/event-stream');
    await app.close();
  });
});
