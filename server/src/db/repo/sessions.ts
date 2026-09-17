import type Database from 'better-sqlite3';

/** 体系里的一个夹子(草稿 / Pass 1 提案共用这一种形状) */
export interface FolderSpec {
  /** Pass 2 引用用的临时 id,如 'f1' */
  tempId: string;
  name: string;
  description: string;
  /** Pass 2 要用的判定规则,必须可执行 */
  rule: string;
  estCount: number;
  /** 复用现有夹子而不是新建 —— B站不能改归属,复用比新建重要得多(spec §9.1) */
  reuseFolderId?: number;
}

export interface SessionRow {
  id: number;
  title: string | null;
  preview: string | null;
  status: string | null;
  summary: string | null;
  created_at: number | null;
  updated_at: number | null;
}

export interface SessionMessage {
  id: number;
  session_id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number | null;
}

/** taxonomy_draft 里存的完整状态 —— 结构化操作只进这里,不进消息流(spec §9.0 红队) */
export interface Draft {
  sessionId: number;
  folders: FolderSpec[];
  constraints?: string;
  summary?: string;
  updatedAt: number;
}

/**
 * 滚动摘要的存储形状。
 *
 * `upToId` 是水位线:**只压缩聊天消息**。体系状态在 taxonomy_draft 里独立保存,
 * 所以压缩聊天永远不会丢掉"已确认的体系" —— 这是 §9.0 红队加固的核心。
 * 塞进 sessions.summary 的 JSON 里,不额外加列。
 */
export interface RollingSummary {
  upToId: number;
  text: string;
}

/**
 * 严格递增的时间戳。
 *
 * `Date.now()` 只有毫秒精度 —— 同一 tick 里建会话 + 发消息会拿到相同的值,
 * 列表按 updated_at 排序就会把"刚聊过的"排到别人下面。进程内单调递增,
 * 保证任何两次写入都能分出先后。
 */
let lastStamp = 0;
const d = (): number => (lastStamp = Math.max(Date.now(), lastStamp + 1));

export function newSession(db: Database.Database, title: string): number {
  const now = d();
  const r = db
    .prepare(
      `INSERT INTO sessions (title, preview, status, created_at, updated_at)
       VALUES (?, NULL, 'active', ?, ?)`,
    )
    .run(title, now, now);
  return Number(r.lastInsertRowid);
}

/** 会话列表 —— 只给摘要一句话,不加载全部消息(spec §9.0) */
export function listSessions(db: Database.Database, opts: { limit?: number } = {}): SessionRow[] {
  return db
    .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(opts.limit ?? 50) as SessionRow[];
}

export function getSession(db: Database.Database, id: number): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

export function appendMessage(
  db: Database.Database,
  sessionId: number,
  role: SessionMessage['role'],
  content: string,
): number {
  const now = d();
  const r = db
    .prepare(
      `INSERT INTO session_messages (session_id, role, content, ts) VALUES (?, ?, ?, ?)`,
    )
    .run(sessionId, role, content, now);

  // 首条用户消息顺手当预览 —— 会话列表要一句话摘要,不想为它多跑一次查询
  const preview =
    role === 'user' ? content.slice(0, 40) : null;
  db.prepare(
    `UPDATE sessions
        SET updated_at = ?,
            preview = COALESCE(preview, ?)
      WHERE id = ?`,
  ).run(now, preview, sessionId);

  return Number(r.lastInsertRowid);
}

/**
 * 取消息。给了 limit 就取**最近** limit 条,但按时间正序返回 ——
 * 上下文拼装和 UI 都按时间顺序读,倒序列表是调用方自己的事。
 */
export function getMessages(
  db: Database.Database,
  sessionId: number,
  opts: { limit?: number; afterId?: number } = {},
): SessionMessage[] {
  const afterId = opts.afterId ?? 0;
  if (opts.limit === undefined) {
    return db
      .prepare(
        `SELECT * FROM session_messages WHERE session_id = ? AND id > ? ORDER BY id`,
      )
      .all(sessionId, afterId) as SessionMessage[];
  }
  const rows = db
    .prepare(
      `SELECT * FROM session_messages WHERE session_id = ? AND id > ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(sessionId, afterId, opts.limit) as SessionMessage[];
  return rows.reverse();
}

export function countMessages(db: Database.Database, sessionId: number): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?`).get(sessionId) as {
      n: number;
    }
  ).n;
}

/** 归档而不是删除 —— 历史可续,删了就没得续了 */
export function archiveSession(db: Database.Database, id: number): void {
  db.prepare(`UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?`).run(d(), id);
}

export function setRollingSummary(
  db: Database.Database,
  sessionId: number,
  summary: RollingSummary,
): void {
  db.prepare(`UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(summary),
    d(),
    sessionId,
  );
}

/** 读滚动摘要。坏数据当作"还没压缩过",不让它炸掉整轮对话 */
export function getRollingSummary(
  db: Database.Database,
  sessionId: number,
): RollingSummary | null {
  const raw = getSession(db, sessionId)?.summary;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RollingSummary;
    return typeof parsed?.upToId === 'number' && typeof parsed?.text === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// ── 体系草稿 ─────────────────────────────────────────────
// 用户在聊天窗里直接编辑的体系(改名/合并/拆分)只落这里,不进消息流。

export function upsertDraft(
  db: Database.Database,
  sessionId: number,
  folders: FolderSpec[],
  constraints?: string,
): void {
  db.prepare(
    `INSERT INTO taxonomy_draft (session_id, folders_json, constraints_json, summary, updated_at)
     VALUES (@sessionId, @folders, @constraints, @summary, @updatedAt)
     ON CONFLICT(session_id) DO UPDATE SET
       folders_json     = excluded.folders_json,
       constraints_json = excluded.constraints_json,
       summary          = excluded.summary,
       updated_at       = excluded.updated_at`,
  ).run({
    sessionId,
    folders: JSON.stringify(folders),
    constraints: constraints === undefined ? null : JSON.stringify({ text: constraints }),
    summary: `${folders.length} 个夹子`,
    updatedAt: d(),
  });
}

export function getLatestDraft(db: Database.Database, sessionId: number): Draft | null {
  const row = db
    .prepare(`SELECT * FROM taxonomy_draft WHERE session_id = ?`)
    .get(sessionId) as
    | { session_id: number; folders_json: string; constraints_json: string | null; updated_at: number }
    | undefined;
  if (!row) return null;

  // 坏 JSON 直接抛 —— 静默返回空体系等于让用户以为草稿没了,那是更糟的结果
  const folders = JSON.parse(row.folders_json) as FolderSpec[];
  const constraints = row.constraints_json
    ? (JSON.parse(row.constraints_json) as { text: string }).text
    : undefined;

  return { sessionId: row.session_id, folders, constraints, updatedAt: row.updated_at };
}
