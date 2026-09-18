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
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** 幂等应用 DDL */
export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  // §9F C7:kind 是独立的正交轴(形态),迁到自己的列;ai_tags 自此不读不写
  ensureColumn(db, 'items', 'ai_kind', 'ai_kind TEXT');
}
