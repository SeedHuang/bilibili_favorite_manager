import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { markFolderAsAi, isAiFolder, listAiFolderIds } from './aiFolders.js';

describe('AI 夹子标记', () => {
  it('标记后可查;没标记的夹子是人类夹子(保守默认)', () => {
    const db = openDb(':memory:');
    const r = db
      .prepare(`INSERT INTO work_folders (origin_id, name, created_at) VALUES (NULL, 'AI 编程', ?)`)
      .run(Date.now());
    const id = Number(r.lastInsertRowid);

    expect(isAiFolder(db, id)).toBe(false); // 无标记 = 人类
    markFolderAsAi(db, id);
    expect(isAiFolder(db, id)).toBe(true);
    expect([...listAiFolderIds(db)]).toEqual([id]);
  });

  it('夹子删了标记跟着走(CASCADE)', () => {
    const db = openDb(':memory:');
    const r = db
      .prepare(`INSERT INTO work_folders (origin_id, name, created_at) VALUES (NULL, '临时', ?)`)
      .run(Date.now());
    const id = Number(r.lastInsertRowid);
    markFolderAsAi(db, id);
    db.prepare(`PRAGMA foreign_keys = ON`).run();
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(id);
    expect(isAiFolder(db, id)).toBe(false);
  });
});
