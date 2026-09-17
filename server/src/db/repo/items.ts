import type Database from 'better-sqlite3';

export interface ItemUpsert {
  id: string;
  type: number;
  title: string;
  intro?: string | null;
  cover?: string | null;
  upperMid?: number | null;
  upperName?: string | null;
  duration?: number | null;
  pubtime?: number | null;
  invalid?: boolean;
  raw?: string | null;
}

export interface ItemRow {
  id: string;
  type: number | null;
  title: string;
  intro: string | null;
  cover: string | null;
  upper_mid: number | null;
  upper_name: string | null;
  duration: number | null;
  pubtime: number | null;
  invalid: number;
  invalid_checked_at: number | null;
  ai_tags: string | null;
  ai_summary: string | null;
  ai_checked_at: number | null;
  raw: string | null;
}

/**
 * 插入或更新条目。
 *
 * **C8 硬规矩**:UPDATE 分支绝不写 ai_tags / ai_summary / ai_checked_at。
 * 否则一次重同步就会把 M4 花几十分钟跑出来的 AI 标签全洗掉 ——
 * 这是这类工具最经典的翻车点。
 */
export function upsertItem(db: Database.Database, i: ItemUpsert): void {
  db.prepare(
    `INSERT INTO items (id, type, title, intro, cover, upper_mid, upper_name,
                        duration, pubtime, invalid, raw)
     VALUES (@id, @type, @title, @intro, @cover, @upperMid, @upperName,
             @duration, @pubtime, @invalid, @raw)
     ON CONFLICT(id) DO UPDATE SET
       type       = excluded.type,
       title      = excluded.title,
       intro      = excluded.intro,
       cover      = excluded.cover,
       upper_mid  = excluded.upper_mid,
       upper_name = excluded.upper_name,
       duration   = excluded.duration,
       pubtime    = excluded.pubtime,
       invalid    = excluded.invalid,
       raw        = excluded.raw
       -- 刻意不动 ai_tags / ai_summary / ai_checked_at (C8)`,
  ).run({
    id: i.id,
    type: i.type,
    title: i.title,
    intro: i.intro ?? null,
    cover: i.cover ?? null,
    upperMid: i.upperMid ?? null,
    upperName: i.upperName ?? null,
    duration: i.duration ?? null,
    pubtime: i.pubtime ?? null,
    invalid: i.invalid ? 1 : 0,
    raw: i.raw ?? null,
  });
}

/** 建立「条目属于某收藏夹」的关联。幂等 —— 重复关联不产生重复行。 */
export function linkFolderItem(
  db: Database.Database,
  folderId: number,
  itemId: string,
  favTime: number | null,
): void {
  db.prepare(
    `INSERT INTO folder_items (folder_id, item_id, fav_time)
     VALUES (?, ?, ?)
     ON CONFLICT(folder_id, item_id) DO UPDATE SET
       -- 读不到 fav_time(如文章条目)时保留已知值,不回写成 NULL
       fav_time = COALESCE(excluded.fav_time, folder_items.fav_time)`,
  ).run(folderId, itemId, favTime);
}

export function countFolderItems(db: Database.Database, folderId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM folder_items WHERE folder_id = ?`)
    .get(folderId) as { n: number };
  return row.n;
}

export function listItemIdsByFolder(
  db: Database.Database,
  folderId: number,
  opts: { limit?: number; offset?: number } = {},
): string[] {
  const rows = db
    .prepare(
      `SELECT item_id FROM folder_items WHERE folder_id = ?
       ORDER BY fav_time DESC, item_id LIMIT ? OFFSET ?`,
    )
    .all(folderId, opts.limit ?? -1, opts.offset ?? 0) as { item_id: string }[];
  return rows.map((r) => r.item_id);
}

export function getItem(db: Database.Database, id: string): ItemRow | undefined {
  return db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
}
