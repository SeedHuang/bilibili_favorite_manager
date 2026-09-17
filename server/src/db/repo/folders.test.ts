import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import {
  upsertFolder,
  listFolders,
  getFolder,
  isDefaultFolder,
  isLockedFolder,
  setFolderLock,
  type FolderRow,
} from './folders.js';

describe('folders repo', () => {
  it('插入并读回', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: '深度学习', mediaCount: 412, type: 11 });
    const f = getFolder(db, 1)!;
    expect(f.title).toBe('深度学习');
    expect(f.media_count).toBe(412);
  });

  it('upsert 同一 id 是更新而不是重复插入', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: '旧名', mediaCount: 10 });
    upsertFolder(db, { id: 1, title: '新名', mediaCount: 12 });
    expect(listFolders(db)).toHaveLength(1);
    expect(getFolder(db, 1)!.title).toBe('新名');
    expect(getFolder(db, 1)!.media_count).toBe(12);
  });

  it('缺省的可空字段留 NULL,不会写成字符串 "undefined"', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: 'x', mediaCount: 0 });
    const f = getFolder(db, 1)!;
    expect(f.mtime).toBeNull();
    expect(f.intro).toBeNull();
    expect(f.type).toBeNull();
  });

  it('listFolders 按 title 排序(稳定,便于 UI)', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 2, title: 'bbb', mediaCount: 1 });
    upsertFolder(db, { id: 1, title: 'aaa', mediaCount: 1 });
    expect(listFolders(db).map((f) => f.title)).toEqual(['aaa', 'bbb']);
  });
});

// B站 账号自带的「默认收藏夹」:不能改名、不能删除。
// 本地必须认得出它,否则 AI 会提"把它并进别的夹子"这种写回必然失败的方案。
describe('锁定夹子', () => {
  const fresh = () => openDb(':memory:');
  const row = (extra: Partial<FolderRow> = {}): FolderRow => ({
    id: 1, type: null, title: '某个夹子', intro: null, privacy: null,
    media_count: 0, mtime: null, raw: null, synced_at: null, ...extra,
  });

  it('标题是「默认收藏夹」→ 自动锁定(它改不了名,所以标题稳定)', () => {
    expect(isDefaultFolder(row({ title: '默认收藏夹' }))).toBe(true);
  });

  it('raw.attr === 0 → 自动锁定', () => {
    expect(isDefaultFolder(row({ title: '别的名字', raw: JSON.stringify({ attr: 0 }) }))).toBe(true);
  });

  it('attr 是 2 / 22 → 不锁(那是普通夹子)', () => {
    expect(isDefaultFolder(row({ raw: JSON.stringify({ attr: 2 }) }))).toBe(false);
    expect(isDefaultFolder(row({ raw: JSON.stringify({ attr: 22 }) }))).toBe(false);
  });

  it('raw 坏了不猜,当作不是默认夹子', () => {
    expect(isDefaultFolder(row({ title: '普通', raw: '{坏 json' }))).toBe(false);
  });

  it('两个信号都不命中 → 不锁', () => {
    const db = fresh();
    expect(isLockedFolder(db, row({ title: '音乐' }))).toBe(false);
  });

  it('手动锁定任意夹子 —— 自动判定猜错时的兜底', () => {
    const db = fresh();
    upsertFolder(db, { id: 5, title: '音乐', mediaCount: 0 });
    setFolderLock(db, 5, true);
    expect(isLockedFolder(db, getFolder(db, 5)!)).toBe(true);
  });

  it('手动解锁能覆盖自动判定(默认收藏夹也能解锁)', () => {
    const db = fresh();
    upsertFolder(db, { id: 7, title: '默认收藏夹', mediaCount: 0 });
    expect(isLockedFolder(db, getFolder(db, 7)!)).toBe(true);
    setFolderLock(db, 7, false);
    expect(isLockedFolder(db, getFolder(db, 7)!)).toBe(false);
  });

  it('传 null 清掉覆盖,回到自动判定', () => {
    const db = fresh();
    upsertFolder(db, { id: 7, title: '默认收藏夹', mediaCount: 0 });
    setFolderLock(db, 7, false);
    setFolderLock(db, 7, null);
    expect(isLockedFolder(db, getFolder(db, 7)!)).toBe(true);
  });
});
