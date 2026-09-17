import type Database from 'better-sqlite3';

/**
 * 一条条目的归类结果。
 *
 * 这个类型放在 db/ 而不是 curator/,是为了让依赖方向保持向下:
 * 存储层说出它的形状,curator 引用它(和 FolderSpec 一样的处理)。
 */
export interface Assignment {
  itemId: string;
  /** null = 未归类,由用户自己处理 */
  folderTempId: string | null;
  confidence: number;
  reason: string;
}

/** Pass 2 里整批失败的记录 —— 其余批次照常,这些要单独提示用户 */
export interface FailedBatch {
  firstItemId: string;
  size: number;
  reason: string;
}

export interface StoredClassification {
  assignments: Assignment[];
  failed: FailedBatch[];
  updatedAt: number;
}

/** 存一份归类结果。同一会话重跑 = 覆盖(旧结果没有保留价值) */
export function saveClassification(
  db: Database.Database,
  sessionId: number,
  assignments: Assignment[],
  failed: FailedBatch[] = [],
): void {
  db.prepare(
    `INSERT INTO classifications (session_id, assignments_json, failed_json, updated_at)
     VALUES (@sessionId, @assignments, @failed, @updatedAt)
     ON CONFLICT(session_id) DO UPDATE SET
       assignments_json = excluded.assignments_json,
       failed_json      = excluded.failed_json,
       updated_at       = excluded.updated_at`,
  ).run({
    sessionId,
    assignments: JSON.stringify(assignments),
    failed: JSON.stringify(failed),
    updatedAt: Date.now(),
  });
}

/**
 * 丢掉这份归类结果。撤回方案要用 —— 只清草稿不清归类的话,
 * 下次打开会话结果又冒出来了,而草稿已经空了,界面上是自相矛盾的半截状态。
 */
export function deleteClassification(db: Database.Database, sessionId: number): void {
  db.prepare(`DELETE FROM classifications WHERE session_id = ?`).run(sessionId);
}

export function getClassification(
  db: Database.Database,
  sessionId: number,
): StoredClassification | null {
  const row = db
    .prepare(`SELECT * FROM classifications WHERE session_id = ?`)
    .get(sessionId) as
    | { assignments_json: string; failed_json: string | null; updated_at: number }
    | undefined;
  if (!row) return null;

  // 坏 JSON 直接抛 —— 静默当成"没归类过"会让用户以为结果丢了,那是更糟的结果
  return {
    assignments: JSON.parse(row.assignments_json) as Assignment[],
    failed: row.failed_json ? (JSON.parse(row.failed_json) as FailedBatch[]) : [],
    updatedAt: row.updated_at,
  };
}
