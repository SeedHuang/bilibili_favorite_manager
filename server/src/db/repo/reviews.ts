import type Database from 'better-sqlite3';
import type { RuleCondition } from './rules.js';

/** 审查草稿的存储层(spec §6)。与生成草稿分表,互不误伤。 */
export type ReviewKind = 'rule' | 'merge' | 'delete';

export interface ReviewDraftInput {
  kind: ReviewKind;
  folderId: number;
  intoId?: number | null;
  conditions?: RuleCondition[] | null;
  because: string;
}

export interface ReviewDraft extends ReviewDraftInput {
  id: number;
  status: 'pending' | 'adopted' | 'discarded';
  createdAt: number;
}

interface Row {
  id: number; kind: string; folder_id: number; into_id: number | null;
  conditions_json: string | null; because: string | null; status: string; created_at: number;
}

const shape = (r: Row): ReviewDraft => ({
  id: r.id,
  kind: r.kind as ReviewKind,
  folderId: r.folder_id,
  intoId: r.into_id,
  conditions: r.conditions_json ? (JSON.parse(r.conditions_json) as RuleCondition[]) : null,
  because: r.because ?? '',
  status: r.status as ReviewDraft['status'],
  createdAt: r.created_at,
});

export function listReviewDrafts(db: Database.Database): ReviewDraft[] {
  return (
    db.prepare(
      `SELECT * FROM review_drafts
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id`,
    ).all() as Row[]
  ).map(shape);
}

export function saveReviewDrafts(db: Database.Database, drafts: ReviewDraftInput[]): void {
  const ins = db.prepare(
    `INSERT INTO review_drafts (kind, folder_id, into_id, conditions_json, because, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  );
  db.transaction(() => {
    for (const d of drafts) {
      ins.run(d.kind, d.folderId, d.intoId ?? null, d.conditions ? JSON.stringify(d.conditions) : null, d.because, Date.now());
    }
  })();
}

export function setReviewDraftStatus(
  db: Database.Database, id: number, status: 'adopted' | 'discarded',
): void {
  db.prepare(`UPDATE review_drafts SET status = ? WHERE id = ?`).run(status, id);
}

/** 清掉(默认全部、或指定夹子的)pending 草稿 —— 新一轮审查开始前调用。
 *  **undefined = 清全部;空数组 = 不清任何夹子**(动态拼出的 folderIds 恰好为空时,
 *  绝不能退化成"清全部" —— 那会把别的夹子的待审草稿误伤掉)。 */
export function clearPendingReviewDrafts(db: Database.Database, folderIds?: readonly number[]): void {
  if (folderIds === undefined) {
    db.prepare(`DELETE FROM review_drafts WHERE status = 'pending'`).run();
    return;
  }
  if (folderIds.length === 0) return;
  const ph = folderIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM review_drafts WHERE status = 'pending' AND folder_id IN (${ph})`).run(...folderIds);
}
