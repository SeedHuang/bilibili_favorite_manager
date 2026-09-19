import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

/**
 * 打开数据库并应用 schema。
 * `:memory:` 用于测试;正式路径由调用方决定(M3 再定默认位置)。
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

/**
 * 给**已存在**的表加一列,幂等。
 *
 * items 是既有表,加列走不了 CREATE TABLE IF NOT EXISTS —— 而 schema.ts 开头写着
 * "等真的需要改列时再引入 user_version 迁移"。这里用最小手段顶上:查 PRAGMA
 * 里有没有,没有才 ALTER。够用、幂等、不引入迁移框架。
 * ponytail: 只支持 ADD COLUMN;真要做改类型 / 删列时再上 user_version。
 */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const fresh = !cols.some((c) => c.name === column);
  if (fresh) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return fresh;
}

/** 幂等应用 DDL */
export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  // §9F C7:kind 是独立的正交轴(形态),迁到自己的列;ai_tags 自此不读不写
  ensureColumn(db, 'items', 'ai_kind', 'ai_kind TEXT');
  // 质检台账:NULL = 该词从没被质检判定过(「继续质检」的账本)
  if (ensureColumn(db, 'tags', 'checked_at', 'checked_at INTEGER')) {
    // **既有词回填为已检**:这些词都经历过旧机制的标注+自动质检,不打这一枪的话,
    // 升级后第一次自动质检(continue 范围)会把整个存量词库当欠账送进模型
    // (几十批调用 + 不可逆 drop)。旧机制没记录谁被漏检,真有欠账用「全部审查」补。
    db.prepare(`UPDATE tags SET checked_at = ? WHERE checked_at IS NULL`).run(Date.now());
  }
}
