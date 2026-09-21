import type Database from 'better-sqlite3';

/**
 * AI 夹子标记 —— 三分类的存储层(spec §2)。
 *
 * 有行 = AI 建的夹子,没行 = 人类夹子。**保守默认**:存量夹子没有记录,
 * 一律当人类夹子(用户拍板:标记只写不改,无手动改标入口)。
 */
export function markFolderAsAi(db: Database.Database, folderId: number): void {
  db.prepare(
    `INSERT INTO work_ai_folders (folder_id, created_at) VALUES (?, ?)
     ON CONFLICT(folder_id) DO NOTHING`,
  ).run(folderId, Date.now());
}

export function isAiFolder(db: Database.Database, folderId: number): boolean {
  return (
    db.prepare(`SELECT 1 FROM work_ai_folders WHERE folder_id = ?`).get(folderId) !== undefined
  );
}

export function listAiFolderIds(db: Database.Database): Set<number> {
  return new Set(
    (db.prepare(`SELECT folder_id FROM work_ai_folders`).all() as { folder_id: number }[]).map(
      (r) => r.folder_id,
    ),
  );
}
