import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './state.js';

export interface FolderUpsert {
  id: number;
  title: string;
  mediaCount: number;
  type?: number | null;
  intro?: string | null;
  privacy?: number | null;
  mtime?: number | null;
  raw?: string | null;
}

export interface FolderRow {
  id: number;
  type: number | null;
  title: string;
  intro: string | null;
  privacy: number | null;
  media_count: number;
  mtime: number | null;
  raw: string | null;
  synced_at: number | null;
}

/**
 * 插入或更新收藏夹。
 * 实测未确认 list-all 是否返回 mtime/intro/privacy —— 缺省写 NULL,不瞎猜。
 */
export function upsertFolder(db: Database.Database, f: FolderUpsert): void {
  db.prepare(
    `INSERT INTO folders (id, type, title, intro, privacy, media_count, mtime, raw, synced_at)
     VALUES (@id, @type, @title, @intro, @privacy, @mediaCount, @mtime, @raw, @syncedAt)
     ON CONFLICT(id) DO UPDATE SET
       type        = excluded.type,
       title       = excluded.title,
       intro       = excluded.intro,
       privacy     = excluded.privacy,
       media_count = excluded.media_count,
       mtime       = excluded.mtime,
       raw         = excluded.raw,
       synced_at   = excluded.synced_at`,
  ).run({
    id: f.id,
    type: f.type ?? null,
    title: f.title,
    intro: f.intro ?? null,
    privacy: f.privacy ?? null,
    mediaCount: f.mediaCount,
    mtime: f.mtime ?? null,
    raw: f.raw ?? null,
    syncedAt: Date.now(),
  });
}

export function listFolders(db: Database.Database): FolderRow[] {
  return db.prepare(`SELECT * FROM folders ORDER BY title`).all() as FolderRow[];
}

export function getFolder(db: Database.Database, id: number): FolderRow | undefined {
  return db.prepare(`SELECT * FROM folders WHERE id = ?`).get(id) as FolderRow | undefined;
}

// ── 锁定夹子(默认收藏夹)────────────────────────────────
//
// B站 的「默认收藏夹」是账号自带的:新收藏没指定夹子时会落在这里。
// 它**不能改名、不能删除**,只能把里面的条目移走或取消收藏。
// 我们本地必须知道这条约束,否则 AI 会提一个"把它并进别的夹子"的方案,
// 那个方案到写回时必然失败。

/** 手动覆盖的设置键(没有 = 不覆盖,按自动判定) */
const lockKey = (id: number): string => `folder.lock.${id}`;

/**
 * 自动判定:这个夹子是不是 B站 账号自带、不可改名/删除的那个。
 *
 * 两个信号任一命中:
 * - **标题**是「默认收藏夹」—— 它不能被改名,所以这个标题是稳定的
 * - `raw.attr === 0` —— 实测该账号 64 个夹子里只有它是 0(其余是 2 或 22)
 *
 * 只取到过一个账号的样本,`attr` 的位含义没确认,所以给手动开关兜底。
 */
export function isDefaultFolder(row: FolderRow): boolean {
  if (row.title.trim() === '默认收藏夹') return true;
  if (!row.raw) return false;
  try {
    const o = JSON.parse(row.raw) as { attr?: unknown };
    return o.attr === 0;
  } catch {
    return false; // raw 坏了不猜,退化成"不是"
  }
}

/** 最终判定:手动设置优先于自动判定 */
export function isLockedFolder(db: Database.Database, row: FolderRow): boolean {
  const manual = getSetting(db, lockKey(row.id));
  if (manual === '1') return true;
  if (manual === '0') return false;
  return isDefaultFolder(row);
}

/** 手动锁 / 解锁;传 null 清掉覆盖,回到自动判定 */
export function setFolderLock(db: Database.Database, id: number, locked: boolean | null): void {
  if (locked === null) {
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(lockKey(id));
    return;
  }
  setSetting(db, lockKey(id), locked ? '1' : '0');
}
