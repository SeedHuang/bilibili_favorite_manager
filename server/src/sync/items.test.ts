import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { getItem, countFolderItems } from '../db/repo/items.js';
import { getState, setState, stateKey } from '../db/repo/state.js';
import { syncFolderItems } from './items.js';
import type { BiliClient } from '../bilibili/client.js';

const FOLDER = 84975136;

function makeItem(n: number) {
  return {
    id: 1000 + n,
    type: 2,
    title: `视频 ${n}`,
    intro: `简介 ${n}`,
    upper: { mid: 1, name: 'UP' },
    attr: 0,
    bvid: `BV${n}`,
    fav_time: 1789345556 + n,
  };
}

/** pages: 每页返回多少条(最后一页可以更少) */
function deps(countsByPage: number[], opts: { failOnPage?: number } = {}) {
  const db = openDb(':memory:');
  upsertFolder(db, { id: FOLDER, title: '默认收藏夹', mediaCount: countsByPage.reduce((a, b) => a + b, 0) });
  const log = new Logger(db, { silent: true });
  const calls: number[] = [];
  const client = {
    get: vi.fn(async (_path: string, params?: Record<string, unknown>) => {
      const pn = Number(params?.['pn'] ?? 1);
      calls.push(pn);
      if (opts.failOnPage === pn) throw new Error(`模拟第 ${pn} 页失败`);
      const n = countsByPage[pn - 1] ?? 0;
      return { medias: Array.from({ length: n }, (_, i) => makeItem(pn * 100 + i)) };
    }),
  } as unknown as BiliClient;
  return { db, log, client, calls };
}

/**
 * 每页返回什么由一个**外部可变数组**决定 —— 用来模拟「远端数据变了」
 * (现有的 deps helper 按页号生成条目,构造后就改不动了)。
 */
function worldDeps(pages: ReturnType<typeof makeItem>[][]) {
  const db = openDb(':memory:');
  upsertFolder(db, { id: FOLDER, title: 'x', mediaCount: pages.flat().length });
  const log = new Logger(db, { silent: true });
  const client = {
    get: vi.fn(async (_path: string, params?: Record<string, unknown>) => {
      const pn = Number(params?.['pn'] ?? 1);
      return { medias: pages[pn - 1] ?? [] };
    }),
  } as unknown as BiliClient;
  return { db, log, client, pages };
}

function pageLimitEvents(d: { db: ReturnType<typeof openDb> }): number {
  const row = d.db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE code = 'PAGE_LIMIT'`)
    .get() as { n: number };
  return row.n;
}

describe('syncFolderItems', () => {
  it('分页拉完并落库', async () => {
    const d = deps([2, 2, 1]);
    const r = await syncFolderItems(d, FOLDER, { pageSize: 2 });
    expect(r.fetched).toBe(5);
    expect(r.pages).toBe(3);
    expect(countFolderItems(d.db, FOLDER)).toBe(5);
  });

  it('条目内容正确映射', async () => {
    const d = deps([1]);
    await syncFolderItems(d, FOLDER, { pageSize: 2 });
    const item = getItem(d.db, 'BV100')!;
    expect(item.title).toBe('视频 100');
    expect(item.intro).toBe('简介 100');
    expect(item.upper_name).toBe('UP');
  });

  it('请求 pn 从 1 递增', async () => {
    const d = deps([2, 2, 0]);
    await syncFolderItems(d, FOLDER, { pageSize: 2 });
    expect(d.calls).toEqual([1, 2, 3]);
  });

  it('空页立即停止(不会无限翻页)', async () => {
    const d = deps([0]);
    const r = await syncFolderItems(d, FOLDER, { pageSize: 2 });
    expect(r.fetched).toBe(0);
    expect(d.calls).toEqual([1]);
  });

  it('不足一页时也停止', async () => {
    const d = deps([2, 1]);
    const r = await syncFolderItems(d, FOLDER, { pageSize: 2 });
    expect(r.pages).toBe(2);
    expect(r.fetched).toBe(3);
  });

  it('全部拉完后清掉游标', async () => {
    const d = deps([1]);
    await syncFolderItems(d, FOLDER, { pageSize: 2 });
    expect(getState(d.db, stateKey.cursor(FOLDER))).toBeUndefined();
  });

  it('中途失败:已拉到的页保留,游标指向失败的页', async () => {
    const d = deps([2, 2, 2], { failOnPage: 3 });
    await expect(syncFolderItems(d, FOLDER, { pageSize: 2 })).rejects.toThrow('模拟第 3 页失败');
    // 前两页已落库
    expect(countFolderItems(d.db, FOLDER)).toBe(4);
    // 游标指向第 3 页,下次从这里继续
    expect(getState(d.db, stateKey.cursor(FOLDER))).toBe('3');
  });

  it('断点续传:从游标继续,不重拉已完成的页', async () => {
    const d1 = deps([2, 2, 2], { failOnPage: 3 });
    await expect(syncFolderItems(d1, FOLDER, { pageSize: 2 })).rejects.toThrow();
    const cursor = getState(d1.db, stateKey.cursor(FOLDER));
    expect(cursor).toBe('3');

    // 同一个 db 上重跑:应该直接从第 3 页开始
    const calls: number[] = [];
    const resumedClient = {
      get: vi.fn(async (_p: string, params?: Record<string, unknown>) => {
        const pn = Number(params?.['pn'] ?? 1);
        calls.push(pn);
        return { medias: [makeItem(pn * 100)] };
      }),
    } as unknown as BiliClient;
    const r = await syncFolderItems(
      { ...d1, client: resumedClient }, FOLDER, { pageSize: 2 },
    );
    expect(calls).toEqual([3]);          // 没有重拉 1、2 页
    expect(r.resumedFrom).toBe(3);
  });

  it('restart:true 时忽略游标,从头拉', async () => {
    const d = deps([2, 2, 0], { failOnPage: 2 });
    await expect(syncFolderItems(d, FOLDER, { pageSize: 2 })).rejects.toThrow();
    const calls: number[] = [];
    const c = {
      get: vi.fn(async (_p: string, params?: Record<string, unknown>) => {
        calls.push(Number(params?.['pn'] ?? 1));
        return { medias: [makeItem(1)] };
      }),
    } as unknown as BiliClient;
    await syncFolderItems({ ...d, client: c }, FOLDER, { pageSize: 2, restart: true });
    expect(calls).toEqual([1]);
  });

  it('maxPages 兜底,防止意外无限翻页', async () => {
    const d = deps([2, 2, 2, 2, 2, 2]);
    const r = await syncFolderItems(d, FOLDER, { pageSize: 2, maxPages: 3 });
    expect(r.pages).toBe(3);
    // 每页都是满的 → 真的是撞到上限,该报
    expect(pageLimitEvents(d)).toBe(1);
  });

  // T9:恰好在上限那一页排干净时不能误报 PAGE_LIMIT
  it('刚好在上限页排干净 → 不算 PAGE_LIMIT', async () => {
    const d = deps([2, 2, 1]); // 第 3 页只有 1 条(不足一页)→ 排干净了
    const r = await syncFolderItems(d, FOLDER, { pageSize: 2, maxPages: 3 });
    expect(r.pages).toBe(3);
    expect(pageLimitEvents(d)).toBe(0);
  });

  it('medias 为 null / 缺失时按空页处理', async () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: FOLDER, title: 'x', mediaCount: 0 });
    const client = {
      get: vi.fn(async () => null),
    } as unknown as BiliClient;
    const r = await syncFolderItems({ db, log: new Logger(db, { silent: true }), client }, FOLDER, { pageSize: 2 });
    expect(r.fetched).toBe(0);
  });

  it('medias 形状不对(非数组)时按空页处理,不崩', async () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: FOLDER, title: 'x', mediaCount: 0 });
    // 非可迭代对象:真·RED 用这个。字符串是**可迭代**的,{ medias: 'abc' }
    // 会被逐字符遍历成假绿,所以不能拿它当形状不对的证明。
    const client = {
      get: vi.fn(async () => ({ medias: {} })),
    } as unknown as BiliClient;
    const r = await syncFolderItems({ db, log: new Logger(db, { silent: true }), client }, FOLDER, { pageSize: 2 });
    expect(r.fetched).toBe(0);
  });

  it('medias 是字符串时也不逐字符遍历(可迭代,但仍是坏形状)', async () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: FOLDER, title: 'x', mediaCount: 0 });
    const client = {
      get: vi.fn(async () => ({ medias: 'abc' })),
    } as unknown as BiliClient;
    const r = await syncFolderItems({ db, log: new Logger(db, { silent: true }), client }, FOLDER, { pageSize: 2 });
    expect(r.fetched).toBe(0);
  });

  it('脏数据条目跳过,不影响其余', async () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: FOLDER, title: 'x', mediaCount: 2 });
    const client = {
      get: vi.fn(async () => ({ medias: [makeItem(1), { no_title: true }] })),
    } as unknown as BiliClient;
    const r = await syncFolderItems({ db, log: new Logger(db, { silent: true }), client }, FOLDER, { pageSize: 5 });
    expect(r.fetched).toBe(1);
  });

  it('有解析不了的行时不对账(那些条目的 id 我们根本不知道)', async () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: FOLDER, title: 'x', mediaCount: 2 });
    // 本地先有一条 BV1
    const first = {
      get: vi.fn(async () => ({ medias: [makeItem(1)] })),
    } as unknown as BiliClient;
    await syncFolderItems({ db, log: new Logger(db, { silent: true }), client: first }, FOLDER, { pageSize: 5 });
    expect(countFolderItems(db, FOLDER)).toBe(1);

    // 这次远端同时返回一条好行和一条坏行 —— 坏行可能正是 BV1 变了形状,
    // 不能因为「没解析出来」就把它删了:删了 localCount 永远追不上 media_count,
    // needsSync 恒真,每次启动都全量重拉(C2 要修的病)
    const second = {
      get: vi.fn(async () => ({ medias: [makeItem(2), { no_title: true }] })),
    } as unknown as BiliClient;
    await syncFolderItems({ db, log: new Logger(db, { silent: true }), client: second }, FOLDER, { pageSize: 5 });
    expect(countFolderItems(db, FOLDER)).toBe(2); // BV1 还在
  });
});

/**
 * C2 对账:本地有、这一趟远端没返回的关联行要删掉。
 * 不删的话收藏夹里被移走/删除的条目会永远留在地上,而且一旦
 * localCount > media_count,needsSync 就恒为 true —— 每次启动都重拉整个夹子。
 */
describe('对账(远端删掉的,本地也要删)', () => {
  it('远端少了一条 → 本地关联跟着删', async () => {
    const d = worldDeps([[makeItem(1), makeItem(2), makeItem(3)]]);
    await syncFolderItems(d, FOLDER, { pageSize: 20 });
    expect(countFolderItems(d.db, FOLDER)).toBe(3);

    d.pages[0] = [makeItem(1), makeItem(2)]; // 远端删掉了第 3 条
    await syncFolderItems(d, FOLDER, { pageSize: 20 });
    expect(countFolderItems(d.db, FOLDER)).toBe(2);
  });

  it('远端清空 → 本地关联也清空', async () => {
    const d = worldDeps([[makeItem(1), makeItem(2)]]);
    await syncFolderItems(d, FOLDER, { pageSize: 20 });

    d.pages[0] = [];
    await syncFolderItems(d, FOLDER, { pageSize: 20 });
    expect(countFolderItems(d.db, FOLDER)).toBe(0);
  });

  it('restart:true 忽略陈旧游标时照样对账', async () => {
    const d = worldDeps([[makeItem(1), makeItem(2), makeItem(3)]]);
    await syncFolderItems(d, FOLDER, { pageSize: 20 });
    setState(d.db, stateKey.cursor(FOLDER), '2'); // 陈旧游标

    d.pages[0] = [makeItem(1), makeItem(2)];
    await syncFolderItems(d, FOLDER, { pageSize: 20, restart: true });
    expect(countFolderItems(d.db, FOLDER)).toBe(2);
  });

  it('从中间页续传的趟不对账(没看全,没资格判定「远端没有了」)', async () => {
    const d = worldDeps([[makeItem(1), makeItem(2), makeItem(3)], [makeItem(4)]]);
    await syncFolderItems(d, FOLDER, { pageSize: 20 });
    expect(countFolderItems(d.db, FOLDER)).toBe(3);
    setState(d.db, stateKey.cursor(FOLDER), '2');

    d.pages[0] = []; // 第 1 页远端其实已经没有内容了
    d.pages[1] = [makeItem(4)];
    const r = await syncFolderItems(d, FOLDER, { pageSize: 20 });
    expect(r.resumedFrom).toBe(2);
    expect(countFolderItems(d.db, FOLDER)).toBe(4); // 1、2、3 没被误删
  });

  it('撞到 maxPages 上限的趟不对账(同样没看全)', async () => {
    const d = worldDeps([
      [makeItem(1), makeItem(2)],
      [makeItem(3), makeItem(4)],
    ]);
    await syncFolderItems(d, FOLDER, { pageSize: 2 }); // 排干净 → 4 条
    expect(countFolderItems(d.db, FOLDER)).toBe(4);

    d.pages[1] = []; // 第 2 页其实没了,但这趟只看第 1 页就撞上限
    const r = await syncFolderItems(d, FOLDER, { pageSize: 2, maxPages: 1 });
    expect(r.pages).toBe(1);
    expect(countFolderItems(d.db, FOLDER)).toBe(4); // 3、4 没被误删
  });
});
