import type Database from 'better-sqlite3';
import type { RuleCondition } from './rules.js';
import { matchAll, toRuleItem } from '../../curator/rules.js';
import { itemTagIds, subtreeSets, tagCounts, tagNamesById } from './tags.js';
import type { ItemRow } from './items.js';

/**
 * 夹子方案生成的存储层。
 *
 * 一份方案头(folder_proposals,id=1 全局唯一)+ 一批草稿夹子。
 * 草稿的 conditions_json 与 RuleCondition[] 同形 —— 采纳后就是一条普通规则,
 * 不需要任何转换。这里是纯读写;「生成」本身(prompt、模型调用)在 Task 2/3。
 */
export type ProposalStatus = 'idle' | 'generating' | 'ready';

export interface DraftInput {
  name: string;
  reason: string;
  conditions: RuleCondition[];
  hitCount: number;
  weak: boolean;
}

export interface ProposalDraft extends DraftInput {
  id: number;
  status: 'pending' | 'adopted' | 'discarded';
  adoptedFolderId: number | null;
  sampleTitles: string[];
}

interface DraftRow {
  id: number;
  name: string;
  reason: string | null;
  conditions_json: string;
  hit_count: number;
  weak: number;
  status: string;
  adopted_folder_id: number | null;
}

export function getProposal(db: Database.Database): {
  level: number | null; uncoveredCount: number; status: ProposalStatus; createdAt: number | null;
} | null {
  const row = db.prepare(
    `SELECT level, uncovered_count, status, created_at FROM folder_proposals WHERE id = 1`,
  ).get() as { level: number | null; uncovered_count: number | null; status: string; created_at: number | null } | undefined;
  if (!row) return null;
  return {
    level: row.level,
    uncoveredCount: row.uncovered_count ?? 0,
    status: row.status as ProposalStatus,
    createdAt: row.created_at,
  };
}

/** 开始一轮生成:清旧草稿、写 generating。事务保证不留半份 */
export function startProposal(db: Database.Database, level: number): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO folder_proposals (id, level, status, created_at) VALUES (1, ?, 'generating', ?)
       ON CONFLICT(id) DO UPDATE SET level = excluded.level, status = 'generating',
         uncovered_count = NULL, created_at = excluded.created_at`,
    ).run(level, Date.now());
    // 旧草稿在这里清,不在 saveDrafts:生成可能半路失败 —— 那时要看到的是
    // "generating 中、没有旧草稿",而不是"新方案挂着上一轮的旧结论"
    db.prepare(`DELETE FROM folder_proposal_folders`).run();
  })();
}

export function saveDrafts(
  db: Database.Database, level: number, uncoveredCount: number, drafts: DraftInput[],
): void {
  db.transaction(() => {
    // upsert 而不是裸 UPDATE:草稿 FK 指向方案头,头必须先在。
    // 正常流程 startProposal 已建好,这里只是 ready + 补数;单独调也立得住
    db.prepare(
      `INSERT INTO folder_proposals (id, level, status, uncovered_count, created_at)
       VALUES (1, ?, 'ready', ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'ready', level = excluded.level,
         uncovered_count = excluded.uncovered_count`,
    ).run(level, uncoveredCount, Date.now());
    const ins = db.prepare(
      `INSERT INTO folder_proposal_folders
         (proposal_id, name, reason, conditions_json, hit_count, weak, status, created_at)
       VALUES (1, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    for (const d of drafts) {
      ins.run(d.name, d.reason, JSON.stringify(d.conditions), d.hitCount, d.weak ? 1 : 0, Date.now());
    }
  })();
}

const shape = (r: DraftRow): ProposalDraft => ({
  id: r.id,
  name: r.name,
  reason: r.reason ?? '',
  conditions: JSON.parse(r.conditions_json) as RuleCondition[],
  hitCount: r.hit_count,
  weak: r.weak === 1,
  status: r.status as ProposalDraft['status'],
  adoptedFolderId: r.adopted_folder_id,
  // sampleTitles 不落库 —— 界面要看时用 sampleTitlesFor 现算:
  // 词库一轮一轮合并/改名,存下来的是旧词名,显示会撒谎
  sampleTitles: [],
});

export function listDrafts(db: Database.Database): ProposalDraft[] {
  const rows = db.prepare(
    `SELECT * FROM folder_proposal_folders
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id`,
  ).all() as DraftRow[];
  return rows.map(shape);
}

export function setDraftStatus(
  db: Database.Database, draftId: number,
  status: 'adopted' | 'discarded', adoptedFolderId?: number,
): void {
  db.prepare(
    `UPDATE folder_proposal_folders SET status = ?, adopted_folder_id = ? WHERE id = ?`,
  ).run(status, adoptedFolderId ?? null, draftId);
}

/** 草稿命中条目的前 10 条标题 —— 审阅时的证据。实跑 matchAll,和 hit_count 同一口径 */
export function sampleTitlesFor(db: Database.Database, conditions: RuleCondition[]): string[] {
  const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
  const tagsOf = itemTagIds(db);
  const rules = [{ folderId: 0, conditions, origin: 'ai' as const, updatedAt: 0 }];
  const matched = matchAll(
    items.map((i) => ({ ...toRuleItem(i), tagIds: tagsOf.get(i.id) ?? [] })),
    rules,
    { subtree: subtreeSets(db) },
  );
  if (matched.size === 0) return [];
  const titleOf = new Map(items.map((i) => [i.id, i.title]));
  return [...matched.keys()].slice(0, 10).map((id) => titleOf.get(id) ?? '');
}

/** 量化护栏:由档位和有词叶子数推预计夹子数区间(prompt 当边界,不当硬约束) */
export function expectedFolders(minLeafCount: number, level: number): string {
  // L10 → 3~8;L1 → min(叶子数, 50);中间线性插值
  const tight = Math.min(Math.max(minLeafCount, 2), 50);
  const hi = Math.round(8 + ((tight - 8) * (10 - level)) / 9);
  const lo = Math.max(3, Math.round(hi * 0.4));
  return level >= 10 ? '3~8 个' : `${lo}~${hi} 个`;
}

/**
 * tag 共现(Jaccard)。**词名不透明场景下唯一的客观证据** —— 但只是线索不是指令。
 * SQL 自连接一次算完,零 token。
 */
export function cooccurrencePairs(db: Database.Database, min = 0.3): { a: number; b: number; score: number }[] {
  const rows = db.prepare(
    `SELECT it1.tag_id AS a, it2.tag_id AS b, COUNT(DISTINCT it1.item_id) AS inter
       FROM item_tags it1
       JOIN item_tags it2 ON it1.item_id = it2.item_id AND it1.tag_id < it2.tag_id
      GROUP BY it1.tag_id, it2.tag_id`,
  ).all() as { a: number; b: number; inter: number }[];
  const cnt = tagCounts(db); // 复用现有:tag → 挂词条目数
  const out: { a: number; b: number; score: number }[] = [];
  for (const r of rows) {
    const union = (cnt.get(r.a) ?? 0) + (cnt.get(r.b) ?? 0) - r.inter;
    if (union <= 0) continue;
    const score = r.inter / union;
    if (score >= min) out.push({ a: r.a, b: r.b, score: Math.round(score * 100) / 100 });
  }
  return out.sort((x, y) => y.score - x.score);
}

/** prompt 的四样料。都从库里现查,零 token */
export function gatherInputs(db: Database.Database, level: number): {
  treeText: string; coText: string; uncoveredCount: number; expected: string;
} {
  // 词库树:缩进文本,每词带挂条目数
  const rows = db.prepare(
    `SELECT t.id, t.name, t.parent_id, COUNT(it.item_id) AS cnt
       FROM tags t LEFT JOIN item_tags it ON it.tag_id = t.id
      GROUP BY t.id ORDER BY COALESCE(t.parent_id, 0), t.id`,
  ).all() as { id: number; name: string; parent_id: number | null; cnt: number }[];
  const children = new Map<number | null, typeof rows>();
  for (const r of rows) {
    const list = children.get(r.parent_id) ?? [];
    list.push(r); children.set(r.parent_id, list);
  }
  const lines: string[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const r of children.get(parent) ?? []) {
      lines.push(`${'  '.repeat(depth)}- ${r.name}(挂 ${r.cnt} 条)`);
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  const treeText = lines.join('\n');

  // 共现:每词只保留 top 邻居,限制总行数防 token 失控
  const names = tagNamesById(db);
  const pairs = cooccurrencePairs(db, 0.3).slice(0, 300);
  const coText = pairs.length
    ? pairs.map((p) => `${names.get(p.a)} ↔ ${names.get(p.b)}: ${p.score}`).join('\n')
    : '(共现数据不足)';

  const uncoveredCount = (db.prepare(
    `SELECT COUNT(*) AS n FROM items
      WHERE id NOT IN (SELECT item_id FROM item_tags)`,
  ).get() as { n: number }).n;

  const leafCount = rows.filter((r) => !children.has(r.id)).length;
  return { treeText, coText, uncoveredCount, expected: expectedFolders(leafCount, level) };
}
