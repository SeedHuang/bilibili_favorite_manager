import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertItem, linkFolderItem, countFolderItems, listItemIdsByFolder, getItem } from './items.js';
import { upsertFolder } from './folders.js';

describe('items repo', () => {
  it('插入并读回条目', () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: '视频', intro: '简介', upperName: 'UP' });
    const i = getItem(db, 'BV1')!;
    expect(i.title).toBe('视频');
    expect(i.intro).toBe('简介');
    expect(i.upper_name).toBe('UP');
    expect(i.invalid).toBe(0);
  });

  it('upsert 更新同步字段', () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: '旧' });
    upsertItem(db, { id: 'BV1', type: 2, title: '新' });
    expect(getItem(db, 'BV1')!.title).toBe('新');
  });

  it('C8:重同步不覆盖 ai_* 派生列', () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: '视频' });
    db.prepare(`UPDATE items SET ai_tags = ?, ai_summary = ? WHERE id = 'BV1'`)
      .run('["rust"]', 'AI 摘要');
    // 再来一次同步
    upsertItem(db, { id: 'BV1', type: 2, title: '视频改名' });
    const i = getItem(db, 'BV1')!;
    expect(i.title).toBe('视频改名');   // 同步字段更新了
    expect(i.ai_tags).toBe('["rust"]'); // AI 字段没被动
    expect(i.ai_summary).toBe('AI 摘要');
  });

  it('一个条目可以在多个收藏夹里(多对多)', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: 'a', mediaCount: 1 });
    upsertFolder(db, { id: 2, title: 'b', mediaCount: 1 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'v' });
    linkFolderItem(db, 1, 'BV1', 100);
    linkFolderItem(db, 2, 'BV1', 200);
    expect(countFolderItems(db, 1)).toBe(1);
    expect(countFolderItems(db, 2)).toBe(1);
  });

  it('重复关联同一夹子不产生重复行(幂等)', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: 'a', mediaCount: 1 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'v' });
    linkFolderItem(db, 1, 'BV1', 100);
    linkFolderItem(db, 1, 'BV1', 100);
    expect(countFolderItems(db, 1)).toBe(1);
  });

  it('listItemIdsByFolder 支持分页', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: 'a', mediaCount: 3 });
    for (const id of ['BV1', 'BV2', 'BV3']) {
      upsertItem(db, { id, type: 2, title: id });
      linkFolderItem(db, 1, id, 100);
    }
    expect(listItemIdsByFolder(db, 1, { limit: 2 })).toHaveLength(2);
    expect(listItemIdsByFolder(db, 1, { limit: 2, offset: 2 })).toHaveLength(1);
  });

  it('分页在 fav_time 全部相同时也不重不漏', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: 'a', mediaCount: 3 });
    for (const id of ['BV1', 'BV2', 'BV3']) {
      upsertItem(db, { id, type: 2, title: id });
      linkFolderItem(db, 1, id, 100); // 刻意全部同一个 fav_time
    }
    const page1 = listItemIdsByFolder(db, 1, { limit: 2 });
    const page2 = listItemIdsByFolder(db, 1, { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(1);
    const all = [...page1, ...page2];
    expect(new Set(all).size).toBe(3);        // 无重复
    expect(all.sort()).toEqual(['BV1', 'BV2', 'BV3']); // 无遗漏
  });

  it('重同步读不到 fav_time 时不清掉已知值', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: 'a', mediaCount: 1 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'v' });
    linkFolderItem(db, 1, 'BV1', 100);
    linkFolderItem(db, 1, 'BV1', null); // 文章条目可能拿不到 fav_time
    const row = db
      .prepare(`SELECT fav_time FROM folder_items WHERE folder_id = 1 AND item_id = 'BV1'`)
      .get() as { fav_time: number | null };
    expect(row.fav_time).toBe(100);
  });

  it('invalid 用 0/1 存', () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'v', invalid: true });
    expect(getItem(db, 'BV1')!.invalid).toBe(1);
  });
});
