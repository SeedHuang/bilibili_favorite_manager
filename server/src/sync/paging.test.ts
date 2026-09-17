/**
 * 分页 + 增量判据的回归测试。
 *
 * 真机上翻的车:默认收藏夹 B站报 2921 条,本地只拉到 239 条,而且游标被删了
 * (所以永远补不齐)。根因是拿"这页不满 pageSize"当"到底了" ——
 * B站 会把失效视频从列表里滤掉但不从 media_count 里扣,所以中间页不满 20 条是正常的。
 */
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { countFolderItems } from '../db/repo/items.js';
import { getState, setState, stateKey } from '../db/repo/state.js';
import { syncFolderItems } from './items.js';
import { needsSync } from './engine.js';
import { getFolder } from '../db/repo/folders.js';
import type { SyncDeps } from './folders.js';

const PAGE = 20;

/** 造一个能翻页的假 client。pages[i] 是第 i+1 页的 medias,最后一页带 has_more:false */
function fakeClient(pages: { count: number; hasMore?: boolean }[]) {
  const calls: number[] = [];
  return {
    calls,
    client: {
      get: vi.fn(async (_path: string, params: Record<string, unknown>) => {
        const pn = Number(params['pn']);
        calls.push(pn);
        const page = pages[pn - 1];
        if (!page) return { medias: [], has_more: false };
        const medias = Array.from({ length: page.count }, (_, i) => ({
          id: (pn - 1) * PAGE + i + 1,
          bvid: `BV${pn}_${i}`,
          title: `第 ${pn} 页第 ${i} 条`,
          type: 2,
          fav_time: 1700000000,
        }));
        return {
          medias,
          has_more: page.hasMore ?? pn < pages.length,
        };
      }),
    } as never,
  };
}

const makeDeps = (client: unknown) => {
  const db = openDb(':memory:');
  return { db, deps: { db, log: new Logger(db, { silent: true }), client } as unknown as SyncDeps };
};

describe('分页结束判据', () => {
  it('中间页不满 pageSize 也要继续翻 —— 这是真机翻车的根因', async () => {
    // 第 2 页只有 19 条(一条失效被滤掉),后面还有
    const { client, calls } = fakeClient([
      { count: 20 },
      { count: 19 }, // ← 旧代码在这里就收工了
      { count: 20 },
      { count: 5, hasMore: false },
    ]);
    const { db, deps } = makeDeps(client);
    upsertFolder(db, { id: 1, title: '默认收藏夹', mediaCount: 64 });

    const r = await syncFolderItems(deps, 1);

    expect(calls).toEqual([1, 2, 3, 4]); // 四页都拉了
    expect(r.fetched).toBe(64);
    expect(countFolderItems(db, 1)).toBe(64);
  });

  it('has_more 说停就停,不看这页满不满', async () => {
    const { client, calls } = fakeClient([
      { count: 20, hasMore: false }, // 满页但 B站 说没了
    ]);
    const { db, deps } = makeDeps(client);
    upsertFolder(db, { id: 1, title: 'x', mediaCount: 20 });

    const r = await syncFolderItems(deps, 1);
    expect(calls).toEqual([1]);
    expect(r.fetched).toBe(20);
  });

  it('has_more 缺失时退回旧的长度判断(不会比现在更糟)', async () => {
    const db = openDb(':memory:');
    const log = new Logger(db, { silent: true });
    const client = {
      get: vi.fn(async (_p: string, params: Record<string, unknown>) => {
        const pn = Number(params['pn']);
        // 故意不返回 has_more
        return { medias: Array.from({ length: pn === 1 ? 20 : 3 }, (_, i) => ({
          id: pn * 100 + i, bvid: `BV${pn}_${i}`, title: 't', type: 2,
        })) };
      }),
    } as never;
    upsertFolder(db, { id: 1, title: 'x', mediaCount: 23 });

    const r = await syncFolderItems({ db, log, client } as unknown as SyncDeps, 1);
    expect(r.pages).toBe(2);
    expect(r.fetched).toBe(23);
  });

  it('空页永远终止 —— 防服务器一直说"还有"却不给数据', async () => {
    const db = openDb(':memory:');
    const log = new Logger(db, { silent: true });
    const client = {
      get: vi.fn(async () => ({ medias: [], has_more: true })), // 撒谎
    } as never;
    upsertFolder(db, { id: 1, title: 'x', mediaCount: 5 });

    const r = await syncFolderItems({ db, log, client } as unknown as SyncDeps, 1);
    expect(r.pages).toBe(1);
    expect(r.fetched).toBe(0);
  });

  it('走到末尾时把 B站 报的条数记下来,作为下次增量判据的基准', async () => {
    const { client } = fakeClient([{ count: 20, hasMore: false }]);
    const { db, deps } = makeDeps(client);
    upsertFolder(db, { id: 7, title: 'x', mediaCount: 2921 });

    await syncFolderItems(deps, 7);
    expect(getState(db, stateKey.folderSyncedCount(7))).toBe('2921');
  });
});

describe('增量判据', () => {
  const setup = (mediaCount: number, local: number, syncedCount?: string) => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: '默认收藏夹', mediaCount });
    // 直接塞本地关联行,模拟"失效视频导致本地比 B站 少"
    for (let i = 0; i < local; i++) {
      db.prepare(`INSERT INTO items (id, type, title) VALUES (?,?,?)`).run(`BV${i}`, 2, 't');
      db.prepare(`INSERT INTO folder_items (folder_id, item_id) VALUES (?,?)`).run(1, `BV${i}`);
    }
    if (syncedCount !== undefined) setState(db, stateKey.folderSyncedCount(1), syncedCount);
    return db;
  };

  it('从没完整拉过 → 要拉', () => {
    const db = setup(100, 0);
    expect(needsSync(db, getFolder(db, 1)!)).toBe(true);
  });

  it('本地条数少于 media_count(失效视频)但 B站 报的数没变 → **不用拉**', () => {
    // 旧的 `localCount !== media_count` 在这里会恒真 → 每次启动全量重拉
    const db = setup(100, 95, '100');
    expect(needsSync(db, getFolder(db, 1)!)).toBe(false);
  });

  it('B站 报的条数变了 → 要拉', () => {
    const db = setup(101, 95, '100');
    expect(needsSync(db, getFolder(db, 1)!)).toBe(true);
  });

  it('条数一样但还是会拉一次(游标丢了的情况靠 full 兜)', () => {
    const db = setup(100, 100, '100');
    expect(needsSync(db, getFolder(db, 1)!)).toBe(false);
  });
});
