import type Database from 'better-sqlite3';

/**
 * 规则 —— 谁该进哪个夹子的判据。
 *
 * **结构化可执行**,不是一段自由文本:能执行才叫资产,否则它只是 prompt。
 * 而且只有能执行才算得出「命中几条」—— 那是调规则时唯一有用的反馈。
 *
 * 字段只留三个(不加正则、不加与或非、不加权重):表达力换"你一眼看懂它在干什么"。
 */
export type RuleField = 'title' | 'intro' | 'upper';

/** 一条条件 = "某字段里命中任一关键词"。条件之间 OR */
export interface RuleCondition {
  field: RuleField;
  any: string[];
}

/** 谁写的 —— 界面上一眼看出这是谁的主意 */
export type RuleOrigin = 'ai' | 'user';

export interface FolderRule {
  folderId: number;
  conditions: RuleCondition[];
  origin: RuleOrigin;
  updatedAt: number;
}

interface RuleRow {
  folder_id: number;
  conditions_json: string;
  origin: string;
  updated_at: number;
}

function shape(r: RuleRow): FolderRule {
  return {
    folderId: r.folder_id,
    // 坏 JSON 直接抛 —— 静默当成"没有规则"会让归类悄悄少一层依据
    conditions: JSON.parse(r.conditions_json) as RuleCondition[],
    origin: r.origin === 'ai' ? 'ai' : 'user',
    updatedAt: r.updated_at,
  };
}

export function listRules(db: Database.Database): FolderRule[] {
  return (db.prepare(`SELECT * FROM work_folder_rules ORDER BY folder_id`).all() as RuleRow[]).map(
    shape,
  );
}

export function getRule(db: Database.Database, folderId: number): FolderRule | null {
  const row = db.prepare(`SELECT * FROM work_folder_rules WHERE folder_id = ?`).get(folderId) as
    | RuleRow
    | undefined;
  return row ? shape(row) : null;
}

/** 存规则。同一夹子**覆盖**(一个夹子一组条件 —— 条件之间本来就是 OR) */
export function saveRule(
  db: Database.Database,
  folderId: number,
  conditions: RuleCondition[],
  origin: RuleOrigin,
): void {
  db.prepare(
    `INSERT INTO work_folder_rules (folder_id, conditions_json, origin, updated_at)
     VALUES (@folderId, @conditions, @origin, @updatedAt)
     ON CONFLICT(folder_id) DO UPDATE SET
       conditions_json = excluded.conditions_json,
       origin          = excluded.origin,
       updated_at      = excluded.updated_at`,
  ).run({
    folderId,
    conditions: JSON.stringify(conditions),
    origin,
    updatedAt: Date.now(),
  });
}

export function deleteRule(db: Database.Database, folderId: number): void {
  db.prepare(`DELETE FROM work_folder_rules WHERE folder_id = ?`).run(folderId);
}
