import type Database from 'better-sqlite3';

/**
 * ai_tags 的**唯一写手**(spec §9E C1/C8)。
 *
 * `items.ai_tags` / `ai_checked_at` 是建表时预留的 AI 派生列,和同步列物理隔离(C8):
 * 同步的 upsertItem 的 UPDATE 分支**刻意**不写它们 —— 这里是 AI 侧的写入口。
 * 两边谁也不碰谁的列,重同步洗不掉标注,重标注也碰不到同步数据。
 */
export interface ItemTagging {
  tags: string[];
  kind: string;
}

interface TagRow { ai_tags: string | null }

/** 导出给 Task 4 的归类链路复用 —— 解析逻辑只有这一份,不养第二份拷贝。 */
export function parseItemTagging(raw: string | null): ItemTagging | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { tags?: unknown; kind?: unknown };
    if (!Array.isArray(o.tags) || typeof o.kind !== 'string') return null;
    return { tags: o.tags.filter((t): t is string => typeof t === 'string'), kind: o.kind };
  } catch {
    return null; // 坏 JSON 当作没标注 —— 手改库不该让整个功能炸掉
  }
}

export function getItemTagging(db: Database.Database, id: string): ItemTagging | null {
  const row = db.prepare(`SELECT ai_tags FROM items WHERE id = ?`).get(id) as TagRow | undefined;
  return row ? parseItemTagging(row.ai_tags) : null;
}

export function setItemTagging(db: Database.Database, id: string, t: ItemTagging | null): void {
  if (t === null) {
    db.prepare(`UPDATE items SET ai_tags = NULL, ai_checked_at = NULL WHERE id = ?`).run(id);
    return;
  }
  db.prepare(
    `UPDATE items SET ai_tags = ?, ai_checked_at = ? WHERE id = ?`,
  ).run(JSON.stringify({ tags: t.tags, kind: t.kind }), Date.now(), id);
}

export function listUntaggedItemIds(db: Database.Database, limit = 100_000): string[] {
  return (
    db.prepare(
      `SELECT id FROM items WHERE ai_checked_at IS NULL ORDER BY id LIMIT ?`,
    ).all(limit) as { id: string }[]
  ).map((r) => r.id);
}

export function tagStats(db: Database.Database): { tagged: number; total: number } {
  const r = db.prepare(
    `SELECT SUM(CASE WHEN ai_checked_at IS NOT NULL THEN 1 ELSE 0 END) tagged, COUNT(*) total FROM items`,
  ).get() as { tagged: number | null; total: number };
  return { tagged: r.tagged ?? 0, total: r.total };
}
