import type Database from 'better-sqlite3';

/** 游标 key 约定 —— 集中在这里,避免字符串散落各处拼错 */
export const stateKey = {
  /** 某个收藏夹的分页游标 */
  cursor: (folderId: number) => `sync:cursor:${folderId}`,
  /** 上次全量同步完成时间 */
  lastFull: 'sync:lastFull',
  /**
   * 上次**完整**拉完这个夹子时,B站 list-all 报的 media_count。
   *
   * 增量判据拿它当基准,而不是拿本地条数 —— 失效视频让本地条数**永远**小于
   * media_count,用条数差判会让 needsSync 恒真,每次启动全量重拉 64 个夹子。
   */
  folderSyncedCount: (folderId: number) => `sync:count:${folderId}`,
} as const;

export function getState(db: Database.Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? undefined;
}

export function setState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

export function deleteState(db: Database.Database, key: string): void {
  db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(key);
}

export function getSetting(db: Database.Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** 只返回键名 —— 值可能含凭证,不该被随手打印 */
export function listSettingKeys(db: Database.Database): string[] {
  return (db.prepare(`SELECT key FROM settings`).all() as { key: string }[]).map((r) => r.key);
}
