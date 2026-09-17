import { describe, it, expect } from 'vitest';
import { openDb, applySchema } from './index.js';

/** 取某张表的所有列名 */
function columns(db: ReturnType<typeof openDb>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
}

function tables(db: ReturnType<typeof openDb>): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
      name: string;
    }[]
  ).map((t) => t.name);
}

describe('schema', () => {
  it('建出 M2 需要的全部表', () => {
    const db = openDb(':memory:');
    const t = tables(db);
    for (const name of [
      'folders',
      'items',
      'folder_items',
      'sync_state',
      'settings',
      'events',
      'api_calls',
    ]) {
      expect(t).toContain(name);
    }
  });

  it('applySchema 幂等 —— 跑两次不报错', () => {
    const db = openDb(':memory:');
    expect(() => applySchema(db)).not.toThrow();
    expect(() => applySchema(db)).not.toThrow();
  });

  it('items 表同时有同步列和 ai_* 派生列(C8)', () => {
    const db = openDb(':memory:');
    const cols = columns(db, 'items');
    for (const c of ['id', 'type', 'title', 'intro', 'cover', 'upper_mid', 'upper_name',
      'duration', 'pubtime', 'invalid', 'raw']) {
      expect(cols).toContain(c);
    }
    for (const c of ['ai_tags', 'ai_summary', 'ai_checked_at']) {
      expect(cols).toContain(c);
    }
  });

  it('folders 的 mtime/intro/privacy 可空(实测未确认这些字段是否返回)', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO folders (id, title, media_count) VALUES (1, 'x', 3)`).run();
    const row = db.prepare(`SELECT * FROM folders WHERE id = 1`).get() as Record<string, unknown>;
    expect(row['mtime']).toBeNull();
    expect(row['intro']).toBeNull();
    expect(row['privacy']).toBeNull();
  });

  it('folder_items 是同 (folder_id, item_id) 主键 —— 支持多对多', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO items (id, type, title) VALUES ('BV1', 2, 'v')`).run();
    db.prepare(`INSERT INTO folders (id, title, media_count) VALUES (1, 'a', 1)`).run();
    db.prepare(`INSERT INTO folders (id, title, media_count) VALUES (2, 'b', 1)`).run();
    db.prepare(`INSERT INTO folder_items (folder_id, item_id, fav_time) VALUES (1, 'BV1', 100)`).run();
    db.prepare(`INSERT INTO folder_items (folder_id, item_id, fav_time) VALUES (2, 'BV1', 200)`).run();
    const n = db.prepare(`SELECT COUNT(*) AS n FROM folder_items WHERE item_id = 'BV1'`).get() as { n: number };
    expect(n.n).toBe(2);
  });
});
