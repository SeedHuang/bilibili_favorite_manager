import type Database from 'better-sqlite3';

/**
 * 规则 —— 谁该进哪个夹子的判据。
 *
 * **结构化可执行**,不是一段自由文本:能执行才叫资产,否则它只是 prompt。
 * 而且只有能执行才算得出「命中几条」—— 那是调规则时唯一有用的反馈。
 *
 * 字段只留四个(不加正则、不加与或非、不加权重):表达力换"你一眼看懂它在干什么"。
 * 前三个是**文本**,`tag` 是唯一的结构化字段 —— 选中一个词就匹配它**整棵子树**(§9F C11)。
 */
export type RuleField = 'title' | 'intro' | 'upper' | 'tag';

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

/**
 * 把规则里引用的 tag id 重写一遍(spec §9F C16)。
 *
 * 规则存的是 tag id(落地细节 3,理由正当:改名不该改语义),而词库每轮都在
 * 合并、偶尔删除 —— 那都是**删节点**。不重写的话:规则的 tag 条件永远匹配不上
 * (`subtreeSets` 里没有那个 id 了),那条 tag 条件就成了永远匹配不到的死 id。
 * 用户看到的是"规则还在,就是不生效"。规则是这产品唯一比 B站 多的东西(§9C),
 * 这是整条链路上唯一会**静默吃掉它**的地方。
 *
 * `map` 返回 null = 那个 id 没了(节点被删)→ 从条件里去掉;某条 tag 条件被掏空
 * 就整条丢掉(留一条"任何都不含"的空条件匹配不到任何东西,只是噪音)。
 *
 * **调用方必须在同一个事务里** —— 它是 `mergeTags` / `deleteTag` 的一部分,
 * 而且要在**删节点之前**跑:反过来的话任何一步失败,规则里就留下一串死 id。
 */
export function rewriteRuleTagIds(
  db: Database.Database,
  map: (tagId: number) => number | null,
): void {
  const rows = db
    .prepare(`SELECT folder_id, conditions_json FROM work_folder_rules`)
    .all() as { folder_id: number; conditions_json: string }[];
  const upd = db.prepare(
    `UPDATE work_folder_rules SET conditions_json = ?, updated_at = ? WHERE folder_id = ?`,
  );

  for (const r of rows) {
    // 坏 JSON 直接跳过 —— 静默当成"没有规则"会让归类悄悄少一层依据
    // (和 `shape()` 里那条"坏 JSON 直接抛"同一条纪律:别猜)
    let conds: RuleCondition[];
    try {
      conds = JSON.parse(r.conditions_json) as RuleCondition[];
    } catch {
      continue;
    }
    if (!Array.isArray(conds)) continue;

    let touched = false;
    const next: RuleCondition[] = [];
    for (const c of conds) {
      if (c.field !== 'tag') {
        next.push(c);
        continue;
      }
      const ids: number[] = [];
      for (const raw of c.any) {
        const n = Number(raw);
        if (!Number.isInteger(n)) continue; // 编不出数字的写法原样丢掉
        const to = map(n);
        if (to !== null && !ids.includes(to)) ids.push(to);
      }
      if (ids.length === 0) {
        touched = true; // 这条条件被掏空了 → 整条丢掉
        continue;
      }
      const shaped = ids.map(String);
      if (shaped.join(',') !== c.any.join(',')) touched = true;
      next.push({ ...c, any: shaped });
    }

    if (touched) upd.run(JSON.stringify(next), Date.now(), r.folder_id);
  }
}
