import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { ensureTag, linkItemTag } from '../db/repo/tags.js';
import { seedAi } from '../ai.js';
import type { BiliClient } from '../bilibili/client.js';

const stubClient = {
  withCredentials: () => ({ get: async () => null }),
} as unknown as BiliClient;

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  seedAi(db);
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
  upsertItem(db, { id: 'BV2', type: 2, title: 'Rust 入门' });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
  const app = createServer({ db, log, client: stubClient });
  return { app, db };
}

/** 建工作副本,回**克隆出来的那个夹子**的 id(它是快照 7 的副本) */
async function workcopy(app: FastifyInstance): Promise<number> {
  await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '临时' } });
  const view = (await app.inject({ url: '/api/workbench' })).json();
  return view.folders.find((f: { originId: number | null }) => f.originId === 7).id as number;
}

describe('规则路由', () => {
  it('GET /api/rules 列出全部工作夹子,没规则的也在(hit=0)', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);

    const res = await app.inject({ url: '/api/rules' });
    expect(res.statusCode).toBe(200);

    const rules = res.json().rules as { folderId: number; conditions: unknown[]; hit: number; ai: boolean }[];
    const mine = rules.find((r) => r.folderId === id)!;
    expect(mine.conditions).toEqual([]);
    expect(mine.hit).toBe(0);
    expect(mine.ai).toBe(false); // 存量夹子无标记 = 人类夹子(保守默认)
    await app.close();
  });

  it('PUT 存规则,GET 能看到,hit 是真算出来的', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);

    const put = await app.inject({
      method: 'PUT', url: `/api/rules/${id}`,
      payload: { conditions: [{ field: 'title', any: ['Python'] }] },
    });
    expect(put.statusCode).toBe(200);

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === id);
    expect(mine.conditions).toEqual([{ field: 'title', any: ['Python'] }]);
    expect(mine.origin).toBe('user');
    // 全库两条条目标题是 'Python 教程' / 'Rust 入门' → 只捞走 1 条
    expect(mine.hit).toBe(1);
    await app.close();
  });

  it('PUT 校验:conditions 必须是数组、field 必须是四个之一', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);

    expect(
      (await app.inject({ method: 'PUT', url: `/api/rules/${id}`, payload: { conditions: '不是数组' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({
        method: 'PUT', url: `/api/rules/${id}`,
        payload: { conditions: [{ field: '简介', any: ['x'] }] },
      })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({
        method: 'PUT', url: `/api/rules/${id}`,
        payload: { conditions: [{ field: 'title', any: 'not-an-array' }] },
      })).statusCode,
    ).toBe(400);
    await app.close();
  });

  // §9F C11:tag 条件存的是 id,命中算的是**整棵子树** —— 而且要在 rulesWithHits()
  // 里传 ctx 才算得出来(不传的话界面上的"命中 N 条"恒为 0,而规则看起来是配好的)
  it('PUT 接受 tag 条件;命中数按子树算 —— 选父命中只挂子标签的那条', async () => {
    const { app, db } = makeApp();
    const id = await workcopy(app);

    const sport = ensureTag(db, '体育', null);
    const basket = ensureTag(db, '篮球', sport);
    linkItemTag(db, 'BV1', basket, 'ai'); // BV1 只挂子节点,标题里没有"体育"

    const put = await app.inject({
      method: 'PUT', url: `/api/rules/${id}`,
      payload: { conditions: [{ field: 'tag', any: [String(sport)] }] },
    });
    expect(put.statusCode).toBe(200);

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === id);
    expect(mine.hit).toBe(1);
    await app.close();
  });

  it('PUT 一个不存在的工作夹子 → 404', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'PUT', url: '/api/rules/99999', payload: { conditions: [] },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // §9C.6 约束 4:锁定的夹子不能加规则,和改名/删除/移动并删除同一条规则
  it('锁定的夹子加规则被拒', async () => {
    const { app, db } = makeApp();
    await workcopy(app);
    // 「默认收藏夹」快照夹子由 isDefaultFolder 判定锁定(raw.attr === 0)
    upsertFolder(db, { id: 9, title: '默认收藏夹', mediaCount: 0, raw: JSON.stringify({ attr: 0 }) });
    // 重新克隆一份,让 9 也进工作副本
    await app.inject({ method: 'POST', url: '/api/workbench/reset' });
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '临时' } });

    const view = (await app.inject({ url: '/api/workbench' })).json();
    const locked = view.folders.find((f: { originId: number | null }) => f.originId === 9).id;

    const res = await app.inject({
      method: 'PUT', url: `/api/rules/${locked}`,
      payload: { conditions: [{ field: 'title', any: ['x'] }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('默认收藏夹');
    await app.close();
  });

  it('DELETE 清掉规则', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);
    await app.inject({
      method: 'PUT', url: `/api/rules/${id}`,
      payload: { conditions: [{ field: 'title', any: ['Python'] }] },
    });

    expect((await app.inject({ method: 'DELETE', url: `/api/rules/${id}` })).statusCode).toBe(200);

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === id);
    expect(mine.conditions).toEqual([]);
    expect(mine.hit).toBe(0);
    await app.close();
  });
});
