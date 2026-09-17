import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { getState, setState, stateKey } from '../db/repo/state.js';
import { runSync, needsSync, type SyncProgress } from './engine.js';
import { RiskControlError, AuthError } from '../bilibili/errors.js';
import type { BiliClient, RequestRecord } from '../bilibili/client.js';

const UP_MID = 27725036;

/** 造一个「B站侧」的假数据源 */
function fakeWorld(folders: { id: number; title: string; items: number }[]) {
  return async (path: string, params?: Record<string, unknown>) => {
    if (path.endsWith('list-all')) {
      return {
        list: folders.map((f) => ({
          id: f.id, title: f.title, media_count: f.items, attr: 0,
        })),
      };
    }
    // resource/list
    const mediaId = Number(params?.['media_id']);
    const pn = Number(params?.['pn'] ?? 1);
    const ps = Number(params?.['ps'] ?? 20);
    const total = folders.find((f) => f.id === mediaId)?.items ?? 0;
    const start = (pn - 1) * ps;
    const n = Math.max(0, Math.min(ps, total - start));
    return {
      medias: Array.from({ length: n }, (_, i) => ({
        id: mediaId * 1000 + start + i,
        type: 2,
        title: `夹${mediaId} 第${start + i + 1}条`,
        bvid: `BV${mediaId}_${start + i}`,
        attr: 0,
        upper: { mid: 1, name: 'UP' },
        fav_time: 1789345556,
      })),
    };
  };
}

function deps(world: (path: string, params?: Record<string, unknown>) => Promise<unknown>) {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  const setRequestListener = vi.fn();
  const client = { get: vi.fn(world), setRequestListener } as unknown as BiliClient;
  return { db, log, client, setRequestListener };
}

/** 取 runSync 注册进 client 的那个请求上报钩子 */
function listenerOf(mock: ReturnType<typeof vi.fn>): (r: RequestRecord) => void {
  return mock.mock.calls[0]![0] as (r: RequestRecord) => void;
}

/** 实际发出去的 resource/list 请求,按 media_id 顺序列出来 —— 用来证明「循环停在哪」 */
function resourceRequests(d: ReturnType<typeof deps>): number[] {
  return (d.client.get as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => String(c[0]).endsWith('resource/list'))
    .map((c) => Number((c[1] as Record<string, unknown> | undefined)?.['media_id']));
}

describe('needsSync', () => {
  const folder = (over: Record<string, unknown> = {}) => ({
    id: 1, type: null, title: 'x', intro: null, privacy: null,
    media_count: 10, mtime: null, raw: null, synced_at: null, ...over,
  });

  /**
   * 判据在 2026-09-15 改过:基准从「本地条数」换成「上次完整拉完时 B站 报的条数」。
   * 因为失效视频让本地条数**永远**小于 media_count,老的判据恒真 → 每次全量重拉。
   * 所以下面凡是要验"条数一致 → 不同步"的,都得先有基准。
   */
  const withBaseline = (mediaCount: number, synced: number) => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: 'x', mediaCount });
    setState(db, stateKey.folderSyncedCount(1), String(synced));
    return db;
  };

  it('从没完整拉过 → 需要同步(基准缺失)', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: 'x', mediaCount: 10 });
    expect(needsSync(db, folder())).toBe(true);
  });

  it('B站 报的条数与上次完整同步时一致 → 不需要同步', () => {
    const db = withBaseline(1, 1);
    upsertItem(db, { id: 'BV1', type: 2, title: 'v' });
    linkFolderItem(db, 1, 'BV1', 1);
    expect(needsSync(db, folder({ media_count: 1 }))).toBe(false);
  });

  // 这条是这次改判据要解决的病:本地永远比 B站 少,老判据下恒真
  it('本地条数少于 B站(失效视频)但条数没变 → **不需要**同步', () => {
    const db = withBaseline(100, 100);
    upsertItem(db, { id: 'BV1', type: 2, title: 'v' });
    linkFolderItem(db, 1, 'BV1', 1); // 本地只有 1 条,B站 报 100
    expect(needsSync(db, folder({ media_count: 100 }))).toBe(false);
  });

  it('B站 报的条数变了 → 需要同步', () => {
    const db = withBaseline(11, 10);
    expect(needsSync(db, folder({ media_count: 11 }))).toBe(true);
  });

  it('本地比 B站 报的还多 → 需要同步(异常兜底)', () => {
    const db = withBaseline(1, 1);
    for (const id of ['BV1', 'BV2']) {
      upsertItem(db, { id, type: 2, title: id });
      linkFolderItem(db, 1, id, 1);
    }
    expect(needsSync(db, folder({ media_count: 1 }))).toBe(true);
  });

  it('数量相同但 mtime 变了 → 需要同步(如果 B站返回 mtime)', () => {
    const db = withBaseline(1, 1);
    upsertFolder(db, { id: 1, title: 'x', mediaCount: 1, mtime: 100 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'v' });
    linkFolderItem(db, 1, 'BV1', 1);
    expect(needsSync(db, folder({ media_count: 1, mtime: 200 }))).toBe(true);
  });

  it('mtime 不存在时不因此判定需要同步', () => {
    const db = withBaseline(1, 1);
    upsertItem(db, { id: 'BV1', type: 2, title: 'v' });
    linkFolderItem(db, 1, 'BV1', 1);
    expect(needsSync(db, folder({ media_count: 1, mtime: null }))).toBe(false);
  });

  it('数量相同但 mtime 与同步前快照不同 → 需要同步', () => {
    const db = withBaseline(1, 1);
    // 表里已经是 B站 刚写进来的新值(200),同步前快照是 100
    upsertFolder(db, { id: 1, title: 'x', mediaCount: 1, mtime: 200 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'v' });
    linkFolderItem(db, 1, 'BV1', 1);
    expect(needsSync(db, folder({ media_count: 1, mtime: 200 }), 100)).toBe(true);
    expect(needsSync(db, folder({ media_count: 1, mtime: 200 }), 200)).toBe(false);
  });
});

describe('runSync', () => {
  it('首次同步:拉全部夹子和条目', async () => {
    const d = deps(fakeWorld([
      { id: 1, title: '默认收藏夹', items: 3 },
      { id: 2, title: '深度学习', items: 2 },
    ]));
    const r = await runSync(d, UP_MID, { pageSize: 20 });
    expect(r.folders).toBe(2);
    expect(r.items).toBe(5);
    expect(r.foldersSynced).toBe(2);
  });

  it('第二次同步且无变化:跳过全部夹子,不发条目请求', async () => {
    const world = fakeWorld([{ id: 1, title: 'a', items: 2 }]);
    const d = deps(world);
    await runSync(d, UP_MID);
    const before = (d.client.get as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await runSync(d, UP_MID);
    expect(r.foldersSkipped).toBe(1);
    expect(r.foldersSynced).toBe(0);
    expect(r.items).toBe(0);
    // 只多发了一次 list-all(检查变化),没有发 resource/list
    const after = (d.client.get as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(after - before).toBe(1);
  });

  it('某个夹子条数变了:只同步那个夹子', async () => {
    const folders = [
      { id: 1, title: 'a', items: 2 },
      { id: 2, title: 'b', items: 2 },
    ];
    const d = deps(fakeWorld(folders));
    await runSync(d, UP_MID);

    // B站侧夹子 2 多了一条
    folders[1]!.items = 3;
    const r = await runSync(d, UP_MID);
    expect(r.foldersSynced).toBe(1);
    expect(r.foldersSkipped).toBe(1);
    // 夹子 2 现在有 3 条,全部重新拉取并 upsert(fetched 计的是处理过的条数,
    // 不是新增条数 —— 已存在的条目也会被 upsert 一遍)
    expect(r.items).toBe(3);
    expect(getState(d.db, stateKey.cursor(2))).toBeUndefined(); // 游标已清
  });

  it('full:true 时忽略增量判据,全部重拉', async () => {
    const d = deps(fakeWorld([{ id: 1, title: 'a', items: 2 }]));
    await runSync(d, UP_MID);
    const r = await runSync(d, UP_MID, { full: true });
    expect(r.foldersSynced).toBe(1);
  });

  it('onProgress 报告进度', async () => {
    const d = deps(fakeWorld([
      { id: 1, title: 'a', items: 1 },
      { id: 2, title: 'b', items: 1 },
    ]));
    const seen: SyncProgress[] = [];
    await runSync(d, UP_MID, { onProgress: (p) => seen.push(p) });
    expect(seen.some((p) => p.phase === 'folders')).toBe(true);
    expect(seen.filter((p) => p.phase === 'items')).toHaveLength(2);
    expect(seen.find((p) => p.phase === 'items')!.total).toBe(2);
  });

  it('单个夹子失败不中断整体,记 error 事件继续', async () => {
    const world = fakeWorld([
      { id: 1, title: 'a', items: 1 },
      { id: 2, title: 'b', items: 1 },
    ]);
    const d = deps(async (path, params) => {
      if (path.endsWith('resource/list') && Number(params?.['media_id']) === 1) {
        throw new Error('模拟夹子 1 失败');
      }
      return world(path, params);
    });
    const r = await runSync(d, UP_MID);
    expect(r.items).toBe(1); // 夹子 2 成功
    expect(r.foldersFailed).toBe(1);
    expect(r.foldersSynced).toBe(1); // 2 个目标、1 个失败 → 只有夹子 2 算「已同步」
    const errs = d.db.prepare(`SELECT * FROM events WHERE level='error'`).all();
    expect(errs.length).toBeGreaterThan(0);
    const done = d.db
      .prepare(`SELECT message FROM events WHERE message LIKE '同步完成:%'`)
      .get() as { message: string } | undefined;
    expect(done?.message).toContain('失败'); // 报告里要说失败数
  });

  it('数量不变但 mtime 变了 → 仍然同步(靠同步前快照,不靠被覆盖后的表)', async () => {
    const world = fakeWorld([{ id: 1, title: 'a', items: 2 }]);
    let mtime = 100;
    const d = deps(async (path, params) => {
      if (path.endsWith('list-all')) {
        return { list: [{ id: 1, title: 'a', media_count: 2, attr: 0, mtime }] };
      }
      return world(path, params);
    });
    await runSync(d, UP_MID);
    mtime = 200; // 条数没变,只有 mtime 变
    const r = await runSync(d, UP_MID);
    expect(r.foldersSynced).toBe(1);
    expect(r.foldersSkipped).toBe(0);
  });

  it('每次 run 只注册一次请求监听器', async () => {
    const d = deps(fakeWorld([{ id: 1, title: 'a', items: 1 }]));
    await runSync(d, UP_MID);
    expect(d.setRequestListener).toHaveBeenCalledTimes(1);
  });

  it('注册的监听器把请求写进 api_calls,且 trace_id 等于报告的 traceId', async () => {
    const d = deps(fakeWorld([{ id: 1, title: 'a', items: 1 }]));
    const r = await runSync(d, UP_MID);
    listenerOf(d.setRequestListener)({
      method: 'GET', path: '/x/v3/fav/folder/created/list-all',
      httpStatus: 200, code: 0, durationMs: 12, attempt: 1, responseExcerpt: '{}',
    });
    const row = d.db
      .prepare(`SELECT trace_id, path FROM api_calls`)
      .get() as { trace_id: string; path: string } | undefined;
    expect(row?.trace_id).toBe(r.traceId);
    expect(row?.path).toBe('/x/v3/fav/folder/created/list-all');
  });

  it('写一条完成事件,含夹子数与条数', async () => {
    const d = deps(fakeWorld([{ id: 1, title: 'a', items: 2 }]));
    await runSync(d, UP_MID);
    const row = d.db
      .prepare(`SELECT message FROM events WHERE message LIKE '%同步完成%'`)
      .get() as { message: string } | undefined;
    expect(row?.message).toContain('1');
  });

  it('traceId 非空,可用来串联 api_calls', async () => {
    const d = deps(fakeWorld([{ id: 1, title: 'a', items: 1 }]));
    const r = await runSync(d, UP_MID);
    expect(r.traceId).toBeTruthy();
  });

  // C1:风控/未登录是「立即停止整个队列,不重试」的信号(spec §8),
  // 不是「这个夹子失败了」。被当成 per-folder 失败吞掉的话,循环会继续往下走,
  // 客户端会对着一个正在拒绝服务的接口再打 60 多次请求。
  const FATAL: [string, () => Error][] = [
    ['RiskControlError', () => new RiskControlError('触发风控', -412, 200)],
    ['AuthError', () => new AuthError('未登录', -101, 200)],
  ];

  it.each(FATAL)('%s 抛穿 runSync:队列立即停止,后面的夹子不再请求', async (_n, make) => {
    const boom = make();
    const world = fakeWorld([
      { id: 1, title: 'a', items: 1 },
      { id: 2, title: 'b', items: 1 },
    ]);
    const d = deps(async (path, params) => {
      if (path.endsWith('resource/list') && Number(params?.['media_id']) === 1) throw boom;
      return world(path, params);
    });

    // 原样抛出(没被包装),身份保持 —— 调用方才能 instanceof 判它
    await expect(runSync(d, UP_MID)).rejects.toBe(boom);

    // 夹子 'a' 排在 'b' 前面(listFolders 按 title 排序):只请求过 a,说明循环停了
    expect(resourceRequests(d)).toEqual([1]);

    // 也绝不能把它降级成一条 FOLDER_SYNC_FAILED 然后接着跑
    const failed = d.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE code = 'FOLDER_SYNC_FAILED'`)
      .get() as { n: number };
    expect(failed.n).toBe(0);
  });

  // I4:阶段①(夹子列表)失败时要先记 error 事件再抛 —— 否则 /logs 上什么都看不到
  it('夹子列表拉取失败:先记 error 事件再抛出(不让 /logs 静默)', async () => {
    const boom = new RiskControlError('触发风控', -412, 200);
    const d = deps(async () => {
      throw boom;
    });

    await expect(runSync(d, UP_MID)).rejects.toBe(boom);

    const errs = d.db
      .prepare(`SELECT code, message FROM events WHERE level = 'error'`)
      .all() as { code: string; message: string }[];
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.code).toBe('FOLDER_LIST_FAILED');
    // 一个夹子都没同步就炸了
    expect(resourceRequests(d)).toEqual([]);
  });
});
