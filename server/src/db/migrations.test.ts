import { describe, it, expect } from 'vitest';
import { openDb, applySchema } from './index.js';

describe('M4 schema migration', () => {
  it('sessions / session_messages / taxonomy_draft / audit_logs 表存在', () => {
    const db = openDb(':memory:');
    applySchema(db);
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?, ?, ?)`,
        )
        .all('sessions', 'session_messages', 'taxonomy_draft', 'audit_logs') as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(['sessions', 'session_messages', 'taxonomy_draft', 'audit_logs']),
    );
  });

  it('applySchema 幂等', () => {
    const db = openDb(':memory:');
    expect(() => applySchema(db)).not.toThrow();
    expect(() => applySchema(db)).not.toThrow();
  });

  it('sessions 表支持 status 列(active | archived)', () => {
    const db = openDb(':memory:');
    applySchema(db);
    db.prepare(`INSERT INTO sessions (title, status) VALUES (?, ?)`).run('test', 'active');
    const r = db.prepare(`SELECT status FROM sessions WHERE title = ?`).get('test') as {
      status: string;
    };
    expect(r.status).toBe('active');
  });

  it('session_messages.session_id 外键指向 sessions', () => {
    const db = openDb(':memory:');
    applySchema(db);
    db.prepare(`INSERT INTO sessions (title, status) VALUES (?, ?)`).run('t', 'active');
    db.prepare(`INSERT INTO session_messages (session_id, role, content) VALUES (?, ?, ?)`).run(
      1,
      'user',
      'hi',
    );
    expect(db.prepare(`SELECT COUNT(*) AS n FROM session_messages`).get() as { n: number }).toEqual({
      n: 1,
    });
  });

  it('taxonomy_draft 是 sessions 的一对一', () => {
    const db = openDb(':memory:');
    applySchema(db);
    db.prepare(`INSERT INTO sessions (id, title, status) VALUES (?, ?, ?)`).run(42, 't', 'active');
    db.prepare(`INSERT INTO taxonomy_draft (session_id, folders_json) VALUES (?, ?)`).run(42, '[]');
    const r = db.prepare(`SELECT folders_json FROM taxonomy_draft WHERE session_id = ?`).get(42) as {
      folders_json: string;
    };
    expect(r.folders_json).toBe('[]');
  });

  // 外键开着的时候,session_id 指向不存在的会话必须被拒 ——
  // 否则孤儿草稿会静默堆积,压缩上下文时读出一个不属于任何会话的体系。
  it('taxonomy_draft.session_id 外键生效(引用不存在的会话直接报错)', () => {
    const db = openDb(':memory:');
    applySchema(db);
    expect(() =>
      db.prepare(`INSERT INTO taxonomy_draft (session_id, folders_json) VALUES (?, ?)`).run(9, '[]'),
    ).toThrow();
  });
});
