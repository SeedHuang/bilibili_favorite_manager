import type Database from 'better-sqlite3';
import { getState, stateKey } from './state.js';

/**
 * 工作副本 —— 你要把收藏夹改成什么样。
 *
 * 全局唯一一份:「现在的体系」是单数,多套竞争方案是旧的错误模型。
 * 唯一性由 `work_state` 的 CHECK(id = 1) 在数据库层保证。
 */
export interface WorkFolder {
  id: number;
  /** 指向快照里的哪个夹子;null = 新建的 */
  originId: number | null;
  name: string;
}

export interface WorkState {
  basedOn: number;
  createdAt: number;
}

export function hasWorkcopy(db: Database.Database): boolean {
  return getWorkState(db) !== null;
}

export function getWorkState(db: Database.Database): WorkState | null {
  const row = db.prepare(`SELECT based_on, created_at FROM work_state WHERE id = 1`).get() as
    | { based_on: number; created_at: number }
    | undefined;
  return row ? { basedOn: row.based_on, createdAt: row.created_at } : null;
}

/**
 * 从快照克隆一份工作副本。**幂等** —— 已经有副本时什么都不做。
 *
 * 调用时机是"第一次编辑",不是"点开始整理":不给用户多一个
 * "我还没开始整理所以改不了"的状态。
 */
export function ensureWorkcopy(db: Database.Database): void {
  if (hasWorkcopy(db)) return;
  const now = Date.now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO work_state (id, based_on, created_at) VALUES (1, ?, ?)`,
    ).run(Number(getState(db, stateKey.lastFull) ?? 0) || 0, now);

    db.prepare(
      `INSERT INTO work_folders (origin_id, name, created_at) SELECT id, title, ? FROM folders`,
    ).run(now);

    // 归属按 origin_id 搬过来 —— 只搬 cloned 出来的那些副本夹子
    db.prepare(
      `INSERT INTO work_folder_items (folder_id, item_id)
       SELECT wf.id, fi.item_id
         FROM work_folders wf
         JOIN folder_items fi ON fi.folder_id = wf.origin_id
        WHERE wf.origin_id IS NOT NULL`,
    ).run();
  })();
}

export function listWorkFolders(db: Database.Database): WorkFolder[] {
  const rows = db
    .prepare(`SELECT id, origin_id, name FROM work_folders ORDER BY id`)
    .all() as { id: number; origin_id: number | null; name: string }[];
  return rows.map((r) => ({ id: r.id, originId: r.origin_id, name: r.name }));
}

export function workItemIds(db: Database.Database, workFolderId: number): string[] {
  return (
    db
      .prepare(`SELECT item_id FROM work_folder_items WHERE folder_id = ? ORDER BY item_id`)
      .all(workFolderId) as { item_id: string }[]
  ).map((r) => r.item_id);
}

/**
 * 某个工作夹子里的条目,**分页** —— 展开夹子时用。
 *
 * 与 `workItemIds` 同一张表、同一个排序,只是多了一层 LIMIT/OFFSET:
 * 展开是给人看的,夹子里可能有几千条。
 */
export function workItemIdsPaged(
  db: Database.Database,
  workFolderId: number,
  opts: { limit?: number; offset?: number } = {},
): string[] {
  return (
    db
      .prepare(
        `SELECT item_id FROM work_folder_items WHERE folder_id = ?
         ORDER BY item_id LIMIT ? OFFSET ?`,
      )
      .all(workFolderId, opts.limit ?? -1, opts.offset ?? 0) as { item_id: string }[]
  ).map((r) => r.item_id);
}

/** 「一键还原」的落点。快照一行不碰 —— 它本来就只读。 */
export function resetWorkcopy(db: Database.Database): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM work_folder_items`).run();
    db.prepare(`DELETE FROM work_folders`).run();
    db.prepare(`DELETE FROM work_state WHERE id = 1`).run();
  })();
}
