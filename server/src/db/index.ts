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

/** 幂等应用 DDL */
export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}
