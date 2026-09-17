import type Database from 'better-sqlite3';

/**
 * 操作日志 —— 记的是**决策**,不是数据变更。
 *
 * 一次操作一行,哪怕它碰了 412 条视频。数据库级的行变更日志是 debug 用的,
 * 不该出现在界面上;用户要的"留痕"是我做了什么决定。
 *
 * **没有 `apply_ai` 这个 kind**:AI 应用产生的就是下面这些普通类型,
 * 只是 actor='ai'。这是"AI 的改动不是另一类东西"在结构上的落实 ——
 * 否则就会出现"手动改的能还原、AI 改的不能"。
 */
export type OpKind =
  | 'rename_folder'
  | 'merge_folders'
  | 'create_folder'
  | 'delete_folder'
  | 'move_items'
  | 'add_items'
  | 'remove_items'
  | 'delete_invalid_items'
  | 'reset'
  /**
   * 任何编辑动作的失败尝试 —— `actionError` 在写出 4xx 响应前会留一条。
   * 让用户在「操作记录」面板里看到具体哪里错了,而不是只能从短暂的红条读到 reason。
   * detail.attempted 是本想做的动作描述,detail.reason 是失败原因。
   */
  | 'failed';

export type OpActor = 'user' | 'ai';

export interface OperationEntry {
  id: number;
  ts: number;
  kind: OpKind;
  actor: OpActor;
  sessionId: number | null;
  summary: string;
  detail: unknown;
}

export function logOperation(
  db: Database.Database,
  e: {
    kind: OpKind;
    actor: OpActor;
    sessionId?: number | null;
    summary: string;
    detail?: unknown;
  },
): number {
  // ts 必须**严格递增**:一次操作得在日志里有唯一坐标。秒级/毫秒级墙钟不够 ——
  // 同一毫秒内落的第二条会和上一条撞成同一个 ts,调用方拿上一条的 ts 当
  // sinceTs 回来查冲突时就会漏掉它(测试里正是这个场景)。取 max 保证只增不减。
  const last = db.prepare(`SELECT ts FROM operation_log ORDER BY id DESC LIMIT 1`).get() as
    | { ts: number }
    | undefined;
  const ts = Math.max(Date.now(), (last?.ts ?? 0) + 1);

  const r = db
    .prepare(
      `INSERT INTO operation_log (ts, kind, actor, session_id, summary, detail_json)
       VALUES (@ts, @kind, @actor, @sessionId, @summary, @detail)`,
    )
    .run({
      ts,
      kind: e.kind,
      actor: e.actor,
      sessionId: e.sessionId ?? null,
      summary: e.summary,
      detail: e.detail === undefined ? null : JSON.stringify(e.detail),
    });
  return Number(r.lastInsertRowid);
}

export function listOperations(
  db: Database.Database,
  opts: { limit?: number; sinceTs?: number } = {},
): OperationEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM operation_log
        WHERE ts >= ?
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(opts.sinceTs ?? 0, opts.limit ?? 200) as {
    id: number; ts: number; kind: string; actor: string;
    session_id: number | null; summary: string; detail_json: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    kind: r.kind as OpKind,
    actor: r.actor as OpActor,
    sessionId: r.session_id,
    summary: r.summary,
    detail: r.detail_json ? (JSON.parse(r.detail_json) as unknown) : null,
  }));
}
