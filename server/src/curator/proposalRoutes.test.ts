// server/src/curator/proposalRoutes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertItem } from '../db/repo/items.js';
import { ensureTag, linkItemTag } from '../db/repo/tags.js';
import { seedLlm } from '../llm/config.js';
import type { BiliClient } from '../bilibili/client.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', async (orig) => ({
  ...(await orig<typeof import('../llm/provider.js')>()),
  complete: mocks.complete,
}));

const stubClient = { withCredentials: () => ({ get: async () => null }) } as unknown as BiliClient;

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  seedLlm(db);
  db.prepare(`INSERT INTO items (id,type,title) VALUES ('BV1',2,'NBA 教程'),('BV2',2,'健身日记')`).run();
  ensureTag(db, 'NBA', null);
  ensureTag(db, '篮球', null);
  // 不对 AUTOINCREMENT 的自增顺序作假设 —— 一律按 norm 查真实 id
  // (brief 硬编码 tagIds:[1] 依赖自增序;plan 已授权改查真实 id)
  const nbaId = (db.prepare(`SELECT id FROM tags WHERE norm='nba'`).get() as { id: number }).id;
  linkItemTag(db, 'BV1', nbaId, 'ai');
  return { app: createServer({ db, log, client: stubClient }), db, nbaId };
}

// tagIds 用真实 id 而不是硬编码 1(见 makeApp 内注释)。
// 夹子名不能和任何词库词同名 —— 实现把词名也当重名丢(brief Step 3 原文:
// "词表里同名也当重名"),而 brief 测试数据里夹子名「篮球」撞了种子词「篮球」,
// 数据与实现自相矛盾;按 plan 规则以实现为准,夹子改成不撞名的「球类运动」。
const aiOut = (nbaId: number) => JSON.stringify([
  { name: '球类运动', reason: '都讲球', tagIds: [nbaId], keywords: [] },
]);

describe('方案路由', () => {
  beforeEach(() => { mocks.complete.mockReset(); });

  it('没配模型 → 400', async () => {
    const { app, db } = makeApp();
    db.prepare(`DELETE FROM settings WHERE key LIKE 'llm.purpose.%'`).run();
    const res = await app.inject({ method: 'POST', url: '/api/proposals/generate', payload: { level: 5 } });
    expect(res.statusCode).toBe(400);
  });

  it('档位非法 → 400', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/proposals/generate', payload: { level: 99 } });
    expect(res.statusCode).toBe(400);
  });

  it('生成全链路:202 → 轮询 ready → 草稿带命中数与样本', async () => {
    const { app, nbaId } = makeApp();
    mocks.complete.mockResolvedValue(aiOut(nbaId));
    const start = await app.inject({ method: 'POST', url: '/api/proposals/generate', payload: { level: 3 } });
    expect(start.statusCode).toBe(202);

    // 异步但同进程,等一轮事件循环即可
    await new Promise((r) => setTimeout(r, 20));

    const cur = (await app.inject({ url: '/api/proposals/current' })).json();
    expect(cur.proposal).toMatchObject({ status: 'ready', level: 3 });
    expect(cur.drafts).toHaveLength(1);
    expect(cur.drafts[0]).toMatchObject({ name: '球类运动', hitCount: 1 });
    expect(cur.drafts[0].sampleTitles).toEqual(['NBA 教程']);
    // 断言 prompt 备齐:模型调用收到词库文本(brief 用 String(messages) 对象数组
    // 只会得到 "[object Object]",改成取 user 消息的内容,断言意图不变)
    expect(mocks.complete.mock.calls[0]![0].messages[1]!.content).toContain('NBA');
  });

  it('编造 tagId 的草稿被裁判丢掉', async () => {
    const { app } = makeApp();
    mocks.complete.mockResolvedValue(JSON.stringify([
      { name: '坏', reason: '', tagIds: [999], keywords: [] },
      { name: '好', reason: '', tagIds: [], keywords: ['健身'] },
    ]));
    await app.inject({ method: 'POST', url: '/api/proposals/generate', payload: { level: 3 } });
    await new Promise((r) => setTimeout(r, 20));
    const cur = (await app.inject({ url: '/api/proposals/current' })).json();
    expect(cur.drafts.map((d: { name: string }) => d.name)).toEqual(['好']);
  });

  it('采纳:建夹子+写规则(origin=ai)+草稿状态', async () => {
    const { app, nbaId } = makeApp();
    mocks.complete.mockResolvedValue(aiOut(nbaId));
    await app.inject({ method: 'POST', url: '/api/proposals/generate', payload: { level: 3 } });
    await new Promise((r) => setTimeout(r, 20));
    const { drafts } = (await app.inject({ url: '/api/proposals/current' })).json();

    const res = await app.inject({ method: 'POST', url: '/api/proposals/adopt', payload: { draftId: drafts[0].id } });
    expect(res.statusCode).toBe(200);
    const { folderId } = res.json();
    expect(folderId).toBeGreaterThan(0);

    // 夹子存在
    const wb = (await app.inject({ url: '/api/workbench' })).json();
    expect(wb.folders.find((f: { id: number }) => f.id === folderId).name).toBe('球类运动');
    // 规则已写 —— conditions 与草稿同形(tag 条件 any 是 id 字符串数组;
    // plan 授权:断言形状以实现为准,brief 原表达式笔误)
    const rules = (await app.inject({ url: '/api/rules' })).json();
    const rule = rules.rules.find((r: { folderId: number }) => r.folderId === folderId);
    expect(rule.conditions).toEqual([{ field: 'tag', any: [String(nbaId)] }]);
    expect(rule.origin).toBe('ai');
    // 草稿状态
    const cur = (await app.inject({ url: '/api/proposals/current' })).json();
    expect(cur.drafts.find((d: { id: number }) => d.id === drafts[0].id).status).toBe('adopted');
  });

  it('adopt 支持改名;discard 置状态', async () => {
    const { app, nbaId } = makeApp();
    mocks.complete.mockResolvedValue(aiOut(nbaId));
    await app.inject({ method: 'POST', url: '/api/proposals/generate', payload: { level: 3 } });
    await new Promise((r) => setTimeout(r, 20));
    const { drafts } = (await app.inject({ url: '/api/proposals/current' })).json();

    const res = await app.inject({ method: 'POST', url: '/api/proposals/adopt', payload: { draftId: drafts[0].id, name: '球类合集' } });
    const wb = (await app.inject({ url: '/api/workbench' })).json();
    expect(wb.folders.find((f: { id: number }) => f.id === res.json().folderId).name).toBe('球类合集');

    await app.inject({ method: 'POST', url: '/api/proposals/discard', payload: { draftId: drafts[0].id } });
    const cur = (await app.inject({ url: '/api/proposals/current' })).json();
    expect(cur.drafts.find((d: { id: number }) => d.id === drafts[0].id).status).toBe('discarded');
  });

  it('正在生成时再点 → 409', async () => {
    const { app } = makeApp();
    mocks.complete.mockImplementation(() => new Promise(() => {})); // 挂起模拟进行中
    const r1 = await app.inject({ method: 'POST', url: '/api/proposals/generate', payload: { level: 5 } });
    expect(r1.statusCode).toBe(202);
    const r2 = await app.inject({ method: 'POST', url: '/api/proposals/generate', payload: { level: 5 } });
    expect(r2.statusCode).toBe(409);
  });

  it('模型抛错 → 状态回 idle', async () => {
    const { app } = makeApp();
    mocks.complete.mockRejectedValue(new Error('超时'));
    const res = await app.inject({ method: 'POST', url: '/api/proposals/generate', payload: { level: 5 } });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const cur = (await app.inject({ url: '/api/proposals/current' })).json();
    expect(cur.proposal.status).toBe('idle');
  });
});
