// server/src/curator/reviewRoutes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { saveRule, getRule } from '../db/repo/rules.js';
import { saveReviewDrafts, listReviewDrafts } from '../db/repo/reviews.js';
import { listWorkFolders } from '../db/repo/workbench.js';
import { makeAi, seedAi } from '../ai.js';
import { reviewRun } from './reviewRoutes.js';
import type { BiliClient } from '../bilibili/client.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));

const stubClient = { withCredentials: () => ({ get: async () => null }) } as unknown as BiliClient;

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  seedAi(db);
  db.prepare(`INSERT INTO items (id,type,title) VALUES ('BV1',2,'NBA 教程'),('BV2',2,'健身日记')`).run();
  const ai = { ...makeAi(db), complete: mocks.complete };
  return { app: createServer({ db, log, client: stubClient, ai }), db };
}

type AppCtx = { app: ReturnType<typeof createServer>; db: ReturnType<typeof openDb> };

/**
 * 工作副本:1 个克隆自快照的人类夹(origin_id 非空,装 BV1)+ 2 个 AI 夹子。
 * 建夹子的 POST 会触发工作副本克隆(幂等):克隆行先落 1 号位(人类夹),
 * AI 夹子是新建的(origin_id NULL)。id 全部按真实返回,不做自增序假设。
 */
async function seedReviewWorkbench({ app, db }: AppCtx): Promise<{ humanId: number; ai1: number; ai2: number }> {
  db.prepare(`INSERT INTO folders (id, title, media_count) VALUES (1, '人类收藏', 1)`).run();
  db.prepare(`INSERT INTO folder_items (folder_id, item_id) VALUES (1, 'BV1')`).run();
  const ai1 = (await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI 篮球' } })).json().id;
  const ai2 = (await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI 健身' } })).json().id;
  db.prepare(`INSERT INTO work_ai_folders (folder_id, created_at) VALUES (?, ?), (?, ?)`)
    .run(ai1, Date.now(), ai2, Date.now());
  saveRule(db, ai1, [{ field: 'title', any: ['NBA'] }], 'ai');
  return { humanId: 1, ai1, ai2 };
}

/** 三种草稿各一。rule 的证据条目要真被关键词命中(自证关),merge/delete 只认 AI 夹子 */
const reviewOut = (humanId: number, ai1: number, ai2: number) => JSON.stringify([
  { kind: 'rule', folderTempId: String(humanId), field: 'title', any: ['NBA'], because: 'NBA 教程都在这', evidenceItemIds: ['BV1'] },
  { kind: 'merge', fromTempId: String(ai1), intoTempId: String(ai2), because: '两个 AI 夹子都是篮球' },
  { kind: 'delete', folderTempId: String(ai1), because: '空了' },
]);

describe('审查路由', () => {
  beforeEach(() => {
    mocks.complete.mockReset();
    // reviewRun 是模块级内存态 —— 「再点 → 409」用例的挂起 promise 永不 settle,
    // running 会钉在 true 泄漏到下一个用例,这里手动复位(照 proposalRoutes 的规矩)
    reviewRun.running = false;
    reviewRun.logs = [];
  });

  it('没配模型 → 400', async () => {
    const { app, db } = makeApp();
    // 校验顺序:先 folderIds 再查模型 —— 所以这里要拿一个合法夹子 id
    const id = (await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '临时' } })).json().id;
    db.prepare(`DELETE FROM settings WHERE key LIKE 'llm.purpose.%'`).run();
    const res = await app.inject({ method: 'POST', url: '/api/reviews/generate', payload: { folderIds: [id] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('模型');
  });

  it('folderIds 空/非数字/含不存在的夹子 → 400', async () => {
    const { app } = makeApp();
    const id = (await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '临时' } })).json().id;
    for (const folderIds of [[], ['1'], [1.5], [id, 999]]) {
      const res = await app.inject({ method: 'POST', url: '/api/reviews/generate', payload: { folderIds } });
      expect(res.statusCode).toBe(400);
    }
  });

  it('生成全链路:202 → 3 条 pending 草稿(带夹子名)', async () => {
    const { app, db } = makeApp();
    const { humanId, ai1, ai2 } = await seedReviewWorkbench({ app, db });
    mocks.complete.mockResolvedValue(reviewOut(humanId, ai1, ai2));
    const start = await app.inject({ method: 'POST', url: '/api/reviews/generate', payload: { folderIds: [humanId, ai1, ai2] } });
    expect(start.statusCode).toBe(202);

    await new Promise((r) => setTimeout(r, 20));

    const cur = (await app.inject({ url: '/api/reviews/current' })).json();
    expect(cur.running).toBe(false);
    expect(cur.drafts).toHaveLength(3);
    expect(cur.drafts.every((d: { status: string }) => d.status === 'pending')).toBe(true);
    expect(cur.drafts.map((d: { kind: string }) => d.kind).sort()).toEqual(['delete', 'merge', 'rule']);
    const rule = cur.drafts.find((d: { kind: string }) => d.kind === 'rule');
    expect(rule.folderName).toBe('人类收藏');
    expect(rule.conditions).toEqual([{ field: 'title', any: ['NBA'] }]);
  });

  it('adopt rule 草稿 → 目标夹子规则追加、origin=ai、草稿状态 adopted', async () => {
    const { app, db } = makeApp();
    const { humanId, ai1, ai2 } = await seedReviewWorkbench({ app, db });
    mocks.complete.mockResolvedValue(reviewOut(humanId, ai1, ai2));
    await app.inject({ method: 'POST', url: '/api/reviews/generate', payload: { folderIds: [humanId, ai1, ai2] } });
    await new Promise((r) => setTimeout(r, 20));
    const { drafts } = (await app.inject({ url: '/api/reviews/current' })).json();
    const ruleDraft = drafts.find((d: { kind: string }) => d.kind === 'rule');

    const res = await app.inject({ method: 'POST', url: '/api/reviews/adopt', payload: { draftId: ruleDraft.id } });
    expect(res.statusCode).toBe(200);

    const saved = getRule(db, humanId)!;
    expect(saved.conditions).toEqual([{ field: 'title', any: ['NBA'] }]);
    expect(saved.origin).toBe('ai');
    const cur = (await app.inject({ url: '/api/reviews/current' })).json();
    expect(cur.drafts.find((d: { id: number }) => d.id === ruleDraft.id).status).toBe('adopted');
  });

  it('adopt merge 草稿 → 源夹子消失、目标规则 = 草稿 conditions', async () => {
    const { app, db } = makeApp();
    const { ai1, ai2 } = await seedReviewWorkbench({ app, db });
    // 直接种一条带 conditions 的 merge 草稿:采纳时 AI 的精选并集覆盖机械并集
    saveReviewDrafts(db, [
      { kind: 'merge', folderId: ai1, intoId: ai2, conditions: [{ field: 'title', any: ['篮球'] }], because: '合并' },
    ]);
    const draft = listReviewDrafts(db)[0]!;

    const res = await app.inject({ method: 'POST', url: '/api/reviews/adopt', payload: { draftId: draft.id } });
    expect(res.statusCode).toBe(200);

    expect(listWorkFolders(db).some((f) => f.id === ai1)).toBe(false);
    expect(getRule(db, ai2)!.conditions).toEqual([{ field: 'title', any: ['篮球'] }]);
    // folder_id 挂 CASCADE:源夹子被并掉,草稿行跟着清(采纳动作已留痕 operation_log)
    expect(listReviewDrafts(db).some((d) => d.id === draft.id)).toBe(false);
  });

  it('adopt delete 草稿 → 夹子没了', async () => {
    const { app, db } = makeApp();
    const { ai1 } = await seedReviewWorkbench({ app, db });
    saveReviewDrafts(db, [{ kind: 'delete', folderId: ai1, because: '没用了' }]);
    const draft = listReviewDrafts(db)[0]!;

    const res = await app.inject({ method: 'POST', url: '/api/reviews/adopt', payload: { draftId: draft.id } });
    expect(res.statusCode).toBe(200);

    expect(listWorkFolders(db).some((f) => f.id === ai1)).toBe(false);
    // folder_id 挂 CASCADE:夹子被删,草稿行跟着清(采纳动作已留痕 operation_log)
    expect(listReviewDrafts(db).some((d) => d.id === draft.id)).toBe(false);
  });

  it('adopt-all → 只采纳 rule,merge/delete 保持 pending', async () => {
    const { app, db } = makeApp();
    const { humanId, ai1, ai2 } = await seedReviewWorkbench({ app, db });
    mocks.complete.mockResolvedValue(reviewOut(humanId, ai1, ai2));
    await app.inject({ method: 'POST', url: '/api/reviews/generate', payload: { folderIds: [humanId, ai1, ai2] } });
    await new Promise((r) => setTimeout(r, 20));

    const res = await app.inject({ method: 'POST', url: '/api/reviews/adopt-all' });
    expect(res.statusCode).toBe(200);

    const cur = (await app.inject({ url: '/api/reviews/current' })).json();
    const byKind = Object.fromEntries(cur.drafts.map((d: { kind: string }) => [d.kind, d]));
    expect(byKind.rule.status).toBe('adopted');
    expect(byKind.merge.status).toBe('pending');
    expect(byKind.delete.status).toBe('pending');
    expect(getRule(db, humanId)!.origin).toBe('ai');
  });

  it('在跑时再点 generate → 409;abort 未在跑 → 409', async () => {
    const { app, db } = makeApp();
    const { humanId, ai1, ai2 } = await seedReviewWorkbench({ app, db });

    // 未在跑时 abort → 409
    const idleAb = await app.inject({ method: 'POST', url: '/api/reviews/abort' });
    expect(idleAb.statusCode).toBe(409);

    // 挂起模拟进行中:再点 → 409
    mocks.complete.mockImplementation(() => new Promise(() => {}));
    const r1 = await app.inject({ method: 'POST', url: '/api/reviews/generate', payload: { folderIds: [humanId, ai1, ai2] } });
    expect(r1.statusCode).toBe(202);
    const r2 = await app.inject({ method: 'POST', url: '/api/reviews/generate', payload: { folderIds: [humanId, ai1, ai2] } });
    expect(r2.statusCode).toBe(409);
  });
});
