/**
 * 本地整理审计报告(spec §9.0 Step 4,audit_logs.kind = 'reorganize')。
 *
 * 和 M5 那份 `sync` 审计分开存:这份只讲**本地**做了什么(合并了哪些夹、
 * 哪些条目挪到哪、哪些没归上),不含任何对 bilibili 的写请求。
 */
import type Database from 'better-sqlite3';
import { getSession, getLatestDraft, type FolderSpec } from '../db/repo/sessions.js';
import { getClassification, type Assignment } from '../db/repo/classifications.js';
import { listFolders } from '../db/repo/folders.js';
import { countFolderItems } from '../db/repo/items.js';

export interface FolderSnapshot {
  /** 现有夹子才有 */
  id?: number;
  /** 草稿夹子才有 */
  tempId?: string;
  name: string;
  count: number;
}

export interface ReorganizeAudit {
  kind: 'reorganize';
  title: string;
  summary: string;
  before: FolderSnapshot[];
  after: FolderSnapshot[];
  detail: {
    /** 现有夹子 → 被哪个草稿夹子复用了 */
    merged: { fromFolderId: number; intoTempId: string }[];
    /** 没归上的条目(落「未归类」) */
    unassigned: string[];
    /** 草稿夹子 → 归进去的条目 id */
    byFolder: Record<string, string[]>;
  };
}

/** 拼一份整理前后的对比。没有草稿或还没跑 Pass 2 就返回 null */
export function buildReorganizeAudit(
  db: Database.Database,
  sessionId: number,
): ReorganizeAudit | null {
  const session = getSession(db, sessionId);
  const draft = getLatestDraft(db, sessionId);
  if (!session || !draft) return null;

  const classification = getClassification(db, sessionId);
  const assignments: Assignment[] = classification?.assignments ?? [];

  const before: FolderSnapshot[] = listFolders(db).map((f) => ({
    id: f.id,
    name: f.title,
    count: countFolderItems(db, f.id),
  }));

  const byFolder: Record<string, string[]> = {};
  const unassigned: string[] = [];
  for (const a of assignments) {
    if (a.folderTempId === null) {
      unassigned.push(a.itemId);
      continue;
    }
    (byFolder[a.folderTempId] ??= []).push(a.itemId);
  }

  const after: FolderSnapshot[] = draft.folders.map((f: FolderSpec) => ({
    tempId: f.tempId,
    name: f.name,
    count: (byFolder[f.tempId] ?? []).length,
  }));

  const merged = draft.folders
    .filter((f) => f.reuseFolderId !== undefined)
    .map((f) => ({ fromFolderId: f.reuseFolderId!, intoTempId: f.tempId }));

  const beforeTotal = before.reduce((n, f) => n + f.count, 0);
  const afterTotal = after.reduce((n, f) => n + f.count, 0);
  const summary =
    `收藏夹 ${before.length} → ${after.length} 个;` +
    `本次归类覆盖 ${afterTotal} 条` +
    (unassigned.length ? `,另 ${unassigned.length} 条待你手动处理` : '') +
    `。本地镜像共 ${beforeTotal} 条关联。`;

  return {
    kind: 'reorganize',
    title: `整理「${session.title ?? '未命名会话'}」`,
    summary,
    before,
    after,
    detail: { merged, unassigned, byFolder },
  };
}

/** 存档。返回 audit_logs.id */
export function saveAudit(db: Database.Database, a: ReorganizeAudit): number {
  const r = db
    .prepare(
      `INSERT INTO audit_logs (kind, title, summary, before_json, after_json, detail_json, trace_id, created_at)
       VALUES (@kind, @title, @summary, @before, @after, @detail, NULL, @createdAt)`,
    )
    .run({
      kind: a.kind,
      title: a.title,
      summary: a.summary,
      before: JSON.stringify(a.before),
      after: JSON.stringify(a.after),
      detail: JSON.stringify(a.detail),
      createdAt: Date.now(),
    });
  return Number(r.lastInsertRowid);
}

export interface AuditSummary {
  id: number;
  kind: string;
  title: string | null;
  summary: string | null;
  createdAt: number | null;
}

/** 报告列表。**不带 detail** —— 3000 条的明细很大,列表页用不上 */
export function listAudits(db: Database.Database, opts: { limit?: number } = {}): AuditSummary[] {
  const rows = db
    .prepare(
      `SELECT id, kind, title, summary, created_at FROM audit_logs
       ORDER BY id DESC LIMIT ?`,
    )
    .all(opts.limit ?? 20) as { id: number; kind: string; title: string | null; summary: string | null; created_at: number | null }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    createdAt: r.created_at,
  }));
}
