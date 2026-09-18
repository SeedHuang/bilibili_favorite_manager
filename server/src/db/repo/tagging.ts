import type Database from 'better-sqlite3';

/**
 * AI 标注的落库口(spec §9F)。
 *
 * 标注的产物这次搬进了三张真表(`tags` / `tag_aliases` / `item_tags`,见 `tags.ts`),
 * 这里只剩 `items` 上的两个 AI 派生量:形态 + **水位线**。
 *
 * 为什么两列还留在这个模块:性质没变 —— `upsertItem` 的 UPDATE 分支**刻意**不写它们
 * (§9E C8),这里是 AI 侧唯一的写入口。两边谁也不碰谁的列,重同步洗不掉标注、
 * 重标注也碰不到同步数据。
 */

/**
 * 标注落地的那两个 AI 列:形态 + **水位线**。
 *
 * 形态(教学/娱乐/…)是 §9F C7 明文规定的**独立正交轴**,不并入主题树 ——
 * 混进树会让集合判据的合并/挂父要给保留节点开一堆例外,一列比一套例外便宜。
 *
 * **`ai_checked_at` 是增量标注的唯一依据**(`listUntaggedItemIds` 查的就是
 * `ai_checked_at IS NULL`)。它必须在这儿写:原来写它的那个函数
 * (`setItemTagging`)被这次改造删掉了 —— 忘了接手的话,「AI 标注」每次都把
 * 全库 3250 条重标一遍,「增量」和「重新标注全部」不再有区别,而界面上
 * **看不出任何异常**(进度条照跑,「已标 N/M」恒为 0)。
 *
 * 两列都属于 C8 的 AI 派生列 —— 同步永不写它们。
 */
export function markItemTagged(db: Database.Database, id: string, kind: string): void {
  db.prepare(`UPDATE items SET ai_kind = ?, ai_checked_at = ? WHERE id = ?`)
    .run(kind, Date.now(), id);
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
