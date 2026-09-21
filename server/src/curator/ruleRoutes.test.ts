import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { ensureTag, linkItemTag } from '../db/repo/tags.js';
import { seedLlm } from '../llm/config.js';
import type { BiliClient } from '../bilibili/client.js';

// LLM 全 mock —— 路由测试绝不打真实 API
const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', async (orig) => ({
  ...(await orig<typeof import('../llm/provider.js')>()),
  complete: mocks.complete,
}));

const stubClient = {
  withCredentials: () => ({ get: async () => null }),
} as unknown as BiliClient;

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  seedLlm(db);
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
  beforeEach(() => vi.clearAllMocks());

  it('GET /api/rules 列出全部工作夹子,没规则的也在(hit=0)', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);

    const res = await app.inject({ url: '/api/rules' });
    expect(res.statusCode).toBe(200);

    const rules = res.json().rules as { folderId: number; conditions: unknown[]; hit: number }[];
    const mine = rules.find((r) => r.folderId === id)!;
    expect(mine.conditions).toEqual([]);
    expect(mine.hit).toBe(0);
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

  // 锁定这道闸有**两个**执行点(替换规则 / 采纳建议),上面那条只钉住了替换这一个
  it('锁定夹子的采纳也被拒,且库里一行没写', async () => {
    const { app, db } = makeApp();
    await workcopy(app);
    // 和上面同款:锁定夹子必须在 ensureWorkcopy **之前**躺在快照里 ——
    // ensureWorkcopy 幂等,已有工作副本时再加夹子就进不去了(那测的是空集),所以
    // reset 清掉工作副本、重新建一次,让 9 被克隆进来
    upsertFolder(db, { id: 9, title: '默认收藏夹', mediaCount: 0, raw: JSON.stringify({ attr: 0 }) });
    await app.inject({ method: 'POST', url: '/api/workbench/reset' });
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '临时' } });

    const view = (await app.inject({ url: '/api/workbench' })).json();
    const locked = view.folders.find((f: { originId: number | null }) => f.originId === 9).id;

    const res = await app.inject({
      method: 'POST', url: `/api/rules/${locked}/adopt`,
      // 这条建议**本身是合法的**(BV1 的标题真的含 Python)—— 它只会因为**锁**被拒,
      // 不是因为自证不过;否则测的是另一道闸,锁定那道没被钉住
      payload: { field: 'title', any: ['Python'], because: '同类', evidenceItemIds: ['BV1'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('默认收藏夹');

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === locked);
    expect(mine.conditions).toEqual([]); // 一条都没写进去
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

  // 采纳是**追加**,不是覆盖 —— 覆盖会把夹子原有的规则整条抹掉
  it('POST adopt 追加一条条件,origin 记 ai', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);
    await app.inject({
      method: 'PUT', url: `/api/rules/${id}`,
      payload: { conditions: [{ field: 'title', any: ['Python'] }] },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/rules/${id}/adopt`,
      payload: {
        field: 'title', any: ['Rust'], because: '同类',
        evidenceItemIds: ['BV2'],
      },
    });
    expect(res.statusCode).toBe(200);

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === id);
    expect(mine.conditions).toEqual([
      { field: 'title', any: ['Python'] },
      { field: 'title', any: ['Rust'] },
    ]);
    expect(mine.origin).toBe('ai');
    expect(mine.hit).toBe(2); // 两条都被捞走了
    await app.close();
  });

  // §9C.6 约束 2:没验过的建议不入库。采纳这条路径**也要**过验证
  it('POST adopt 一条自证不过的建议 → 400,库里没有它', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);

    const res = await app.inject({
      method: 'POST', url: `/api/rules/${id}/adopt`,
      payload: {
        field: 'title', any: ['根本打不中'],
        because: '编的', evidenceItemIds: ['BV1'],
      },
    });
    expect(res.statusCode).toBe(400);

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === id);
    expect(mine.conditions).toEqual([]);
    await app.close();
  });
});
