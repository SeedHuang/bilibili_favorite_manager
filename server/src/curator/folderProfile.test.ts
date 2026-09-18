import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
import { ensureTag, linkItemTag } from '../db/repo/tags.js';
import { buildFolderProfiles } from './folderProfile.js';

function fixture() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO work_folders (id, origin_id, name, created_at) VALUES (1, NULL, '美食', 0), (2, NULL, '看球', 0)`)
    .run();
  const food = ensureTag(db, '美食', null);
  const sport = ensureTag(db, 'NBA', null);

  for (let i = 0; i < 10; i++) {
    const id = `BV${i}`;
    upsertItem(db, { id, type: 2, title: `菜谱 ${i}` });
    linkItemTag(db, id, food, 'ai');
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (1, ?)`).run(id);
  }
  // 一条走错门的:挂着 NBA,却躺在美食夹子里
  upsertItem(db, { id: 'BVX', type: 2, title: '湖人 vs 勇士' });
  linkItemTag(db, 'BVX', sport, 'ai');
  db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (1, 'BVX')`).run();
  return db;
}

describe('buildFolderProfiles', () => {
  it('画像列出该夹子的高频标签', () => {
    const p = buildFolderProfiles(fixture());
    const food = p.find((x) => x.name === '美食')!;
    expect(food.itemCount).toBe(11);
    expect(food.topTags[0]).toEqual({ name: '美食', count: 10 });
  });

  it('离群:每个标签在夹子里都没有同伴 —— 零参数判据', () => {
    const p = buildFolderProfiles(fixture());
    expect(p.find((x) => x.name === '美食')!.outliers).toEqual(['BVX']);
  });

  it('夹子条目 <5 不判(样本不足,统计下限同 C9)', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO work_folders (id, origin_id, name, created_at) VALUES (1, NULL, '小夹子', 0)`).run();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (1, 'BV1')`).run();
    expect(buildFolderProfiles(db)[0]!.outliers).toEqual([]);
  });

  it('没有标签的条目不判离群(没依据,不是可疑)', () => {
    const db = fixture();
    upsertItem(db, { id: 'BVY', type: 2, title: '还没标' });
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (1, 'BVY')`).run();
    expect(buildFolderProfiles(db).find((x) => x.name === '美食')!.outliers).toEqual(['BVX']);
  });
});
