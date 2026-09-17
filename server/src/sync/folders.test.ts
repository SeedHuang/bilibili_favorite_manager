import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { listFolders } from '../db/repo/folders.js';
import { syncFolderList } from './folders.js';
import type { BiliClient } from '../bilibili/client.js';

function deps(getImpl: (path: string, params?: Record<string, unknown>) => Promise<unknown>) {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  const calls: { path: string; params?: Record<string, unknown> }[] = [];
  const client = {
    get: vi.fn(async (path: string, params?: Record<string, unknown>) => {
      calls.push({ path, params });
      return getImpl(path, params);
    }),
  } as unknown as BiliClient;
  return { db, log, client, calls };
}

const foldersPayload = {
  count: 2,
  list: [
    { id: 1, title: '默认收藏夹', media_count: 3480, attr: 0 },
    { id: 2, title: '深度学习', media_count: 412, attr: 0 },
  ],
};

describe('syncFolderList', () => {
  it('拉取并落库', async () => {
    const d = deps(async () => foldersPayload);
    const r = await syncFolderList(d, 27725036);
    expect(r.count).toBe(2);
    expect(r.totalItems).toBe(3892);
    // 按 title 排序,SQLite 默认 BINARY 排序 = UTF-8 字节序:
    // 深 (E6B7B1) < 默 (E9BB98),所以「深度学习」在前
    expect(listFolders(d.db).map((f) => f.title)).toEqual(['深度学习', '默认收藏夹']);
  });

  it('只请求一次 —— type 参数被忽略,不做重复请求', async () => {
    const d = deps(async () => foldersPayload);
    await syncFolderList(d, 27725036);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]!.path).toBe('/x/v3/fav/folder/created/list-all');
  });

  it('不签名(signed:false)—— 实测该接口不需要 wbi', async () => {
    const d = deps(async () => foldersPayload);
    await syncFolderList(d, 27725036);
    // 通过 mock 的第三参断言
    const get = d.client.get as unknown as ReturnType<typeof vi.fn>;
    expect(get.mock.calls[0]![2]).toEqual({ signed: false });
  });

  it('data 为 null 时按「没有收藏夹」处理,不报错', async () => {
    const d = deps(async () => null);
    const r = await syncFolderList(d, 27725036);
    expect(r.count).toBe(0);
    expect(listFolders(d.db)).toHaveLength(0);
  });

  it('list 不是数组时按「没有收藏夹」处理,不抛错', async () => {
    const d = deps(async () => ({ list: 'not-an-array' }));
    const r = await syncFolderList(d, 27725036);
    expect(r.count).toBe(0);
    expect(listFolders(d.db)).toHaveLength(0);
  });

  it('list 不可遍历(对象)时同样按空处理,不抛错', async () => {
    const d = deps(async () => ({ list: {} }));
    const r = await syncFolderList(d, 27725036);
    expect(r.count).toBe(0);
    expect(listFolders(d.db)).toHaveLength(0);
  });

  it('list 里混入脏数据时跳过那一条,其余照常', async () => {
    const d = deps(async () => ({
      list: [{ id: 1, title: '好', media_count: 1 }, { title: '没有 id' }],
    }));
    const r = await syncFolderList(d, 27725036);
    expect(r.count).toBe(1);
  });

  it('已存在的夹子被更新而不是重复插入', async () => {
    const d = deps(async () => foldersPayload);
    await syncFolderList(d, 27725036);
    await syncFolderList(d, 27725036);
    expect(listFolders(d.db)).toHaveLength(2);
  });

  it('成功时写一条 info 事件', async () => {
    const d = deps(async () => foldersPayload);
    await syncFolderList(d, 27725036);
    const row = d.db.prepare(`SELECT message FROM events WHERE category='sync'`).get() as { message: string };
    expect(row.message).toContain('2');
  });
});
