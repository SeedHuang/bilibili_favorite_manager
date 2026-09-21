import type Database from 'better-sqlite3';

/** 游标 key 约定 —— 集中在这里,避免字符串散落各处拼错 */
export const stateKey = {
  /** 某个收藏夹的分页游标 */
  cursor: (folderId: number) => `sync:cursor:${folderId}`,
  /** 上次全量同步完成时间 */
  lastFull: 'sync:lastFull',
  /**
   * 上次**完整**拉完这个夹子时,B站 list-all 报的 media_count。
   *
   * 增量判据拿它当基准,而不是拿本地条数 —— 失效视频让本地条数**永远**小于
   * media_count,用条数差判会让 needsSync 恒真,每次启动全量重拉 64 个夹子。
   */
  folderSyncedCount: (folderId: number) => `sync:count:${folderId}`,
} as const;

export function getState(db: Database.Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? undefined;
}

export function setState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

export function deleteState(db: Database.Database, key: string): void {
  db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(key);
}

export function getSetting(db: Database.Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** 只返回键名 —— 值可能含凭证,不该被随手打印 */
export function listSettingKeys(db: Database.Database): string[] {
  return (db.prepare(`SELECT key FROM settings`).all() as { key: string }[]).map((r) => r.key);
}

export function deleteSetting(db: Database.Database, key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

// ── 批次任务轮询/批次配置(spec 2026-09-20 §3)──────────────
// 每个批次/AI 任务的轮询间隔与批次大小,按任务一对一存 settings。
// **settings 是缓存不是真相**:缺 key/非法值兜底默认表 —— 设置页还没用过、
// 或有人手改库写进垃圾值,任务都照常跑,不该挂在这。

export type PollConfig = { intervalMs: number; batch: number | null };

export const POLL_TASKS = ['tag', 'tagcheck', 'proposals'] as const;
export type PollTask = (typeof POLL_TASKS)[number];

export const POLL_INTERVALS = [1000, 2000, 3000, 5000, 10000];
export const POLL_BATCHES = [1, 2, 5, 10, 20, 30, 40, 50];

const DEFAULTS: Record<PollTask, PollConfig> = {
  // tag 的 batch 语义是**批上限**:实际批大小仍随上下文窗收缩,设置只是松紧上限;
  // tagcheck 的 batch 是**定长批大小** —— 两者语义不同,别混用
  tag: { intervalMs: 2000, batch: 16 },
  tagcheck: { intervalMs: 3000, batch: 200 },
  proposals: { intervalMs: 3000, batch: null }, // 一次 LLM 调用,无批次语义
};

const pollKey = (task: string, what: 'interval_ms' | 'batch') => `poll.${task}.${what}`;

const isPollTask = (t: string): t is PollTask => (POLL_TASKS as readonly string[]).includes(t);

export function readPoll(db: Database.Database, taskType: string): PollConfig {
  if (!isPollTask(taskType)) {
    console.warn(`[polls] 未知任务类型 ${taskType},返回 tag 默认`);
    return { ...DEFAULTS.tag }; // 拷贝:调用方 mutate 返回值不能污染全局默认表
  }
  const def = DEFAULTS[taskType];
  const rawIv = Number(getSetting(db, pollKey(taskType, 'interval_ms')));
  const intervalMs = POLL_INTERVALS.includes(rawIv) ? rawIv : def.intervalMs;
  let batch = def.batch;
  if (def.batch !== null) {
    const raw = Number(getSetting(db, pollKey(taskType, 'batch')));
    if (Number.isInteger(raw) && raw >= 1 && raw <= 500) batch = raw; // 自定义档 1~500 都算合法
  }
  return { intervalMs, batch };
}

/**
 * 写单任务配置。**repo 层不校验**(校验在路由层 —— 两处对"什么是合法"必须给同一个答案,
 * 但只有路由对着用户,所以闸放那里)。batch 为 null/undefined 且任务有批次语义时,
 * 视为"恢复默认" —— 删 key,读时兜底。
 */
export function writePoll(
  db: Database.Database,
  taskType: string,
  cfg: { intervalMs: number; batch?: number | null },
): void {
  if (!isPollTask(taskType)) throw new Error(`未知任务类型 ${taskType}`);
  setSetting(db, pollKey(taskType, 'interval_ms'), String(cfg.intervalMs));
  if (DEFAULTS[taskType].batch === null) return; // proposals 无 batch 键
  if (cfg.batch === null || cfg.batch === undefined) {
    deleteSetting(db, pollKey(taskType, 'batch'));
    return;
  }
  setSetting(db, pollKey(taskType, 'batch'), String(cfg.batch));
}

export function listPolls(db: Database.Database): Record<string, PollConfig> {
  const out: Record<string, PollConfig> = {};
  for (const t of POLL_TASKS) out[t] = readPoll(db, t);
  return out;
}
