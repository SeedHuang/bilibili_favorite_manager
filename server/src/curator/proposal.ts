// server/src/curator/proposal.ts
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import type { RuleCondition } from '../db/repo/rules.js';
import type { ItemRow } from '../db/repo/items.js';
import { complete } from '../llm/provider.js';
import { readLlmSettings } from '../llm/config.js';
import { parseLooseJson } from './parse.js';
import {
  startProposal, saveDrafts, gatherInputs,
} from '../db/repo/proposals.js';
import { tagNamesById, subtreeSets, itemTagIds } from '../db/repo/tags.js';
import { matchAll, toRuleItem } from './rules.js';

/**
 * 夹子方案生成 —— prompt 组装 + AI 输出裁判(纯函数,无 IO)。
 *
 * 裁判沿 validateSuggestion 的纪律:**编造就整条丢**,不给部分正确留宽容。
 * 阶梯进 prompt **不带任何具体例子** —— 具体词(Claude Code 之类)会锚定模型
 * 往科技领域聚,例子只留在 spec 的人看表格里。
 */

export interface LevelDef { level: number; name: string; criterion: string }

/** 1 严 → 10 松。靠这条递进链理解松紧,不靠例子 */
export const LEVELS: LevelDef[] = [
  { level: 1, name: '专精', criterion: '围绕同一具体事物的同一具体用法/技巧' },
  { level: 2, name: '工具', criterion: '同一个具体事物/工具,不细分内部功能' },
  { level: 3, name: '方案', criterion: '解决同一问题的同类工具或方案' },
  { level: 4, name: '方向', criterion: '同一技术路线/方法论' },
  { level: 5, name: '领域', criterion: '同一领域,跨过方案之间的分歧' },
  { level: 6, name: '邻域', criterion: '领域 + 紧邻领域可合并' },
  { level: 7, name: '大类', criterion: '同一大类,领域之上' },
  { level: 8, name: '行业', criterion: '同一行业' },
  { level: 9, name: '生活', criterion: '生活大领域(如学习、娱乐、日常)' },
  { level: 10, name: '全收', criterion: '全库归成几大主题' },
];

export const levelText = (level: number) => LEVELS.find((l) => l.level === level) ?? null;

export interface PromptInputs {
  treeText: string; coText: string; expected: string; level: number;
}

export function buildPrompt(inputs: PromptInputs): { system: string; user: string } {
  const lv = levelText(inputs.level);
  if (!lv) throw new Error(`档位必须是 1~10,收到 ${inputs.level}`);

  const ladder = LEVELS
    .map((l) => `  L${l.level} ${l.name}:${l.criterion}`)
    .join('\n');
  const others = LEVELS.filter((l) => l.level !== inputs.level)
    .map((l) => `L${l.level}=${l.name}`)
    .join('、');

  const system = [
    '你是视频收藏夹整理助手。任务是:把词库里的概念按指定的「相关性档位」聚成一套夹子方案。',
    '档位从 1(最严,夹子多而细)到 10(最松,夹子少而大),本次要求:',
    `  L${lv.level} ${lv.name}:${lv.criterion}`,
    `完整阶梯供参照(${others})。成员之间"共享什么才算同类"以本档定义为准。`,
    '共现数字(两词同现于同一视频的统计)只能当**线索**,不是指令 —— 万金油词(如"教程")共现虚高,别被它牵着走。',
    '输出纯 JSON 数组,不要 markdown 围栏,形状:',
    '[{"name":"夹子名","reason":"归类理由一句话","tagIds":[词库id],"keywords":["标题关键词"]}]',
  ].join('\n');

  const user = [
    `## 词库树(每词带挂条目数)`,
    inputs.treeText,
    ``,
    `## 词间共现(Jaccard ≥ 0.3)`,
    inputs.coText,
    ``,
    `## 数量护栏`,
    `本档预计 ${inputs.expected} 夹子。超出区间说明你在细拆或硬塞。`,
    ``,
    `请给出夹子方案。每个夹子必须挂至少一个词库 id 或至少一个标题关键词。`,
  ].join('\n');

  return { system, user };
}

// ── 裁判 ──────────────────────────────────────────────────

export interface ValidFolder {
  name: string; reason: string; tagIds: number[]; keywords: string[];
}

export interface FolderCtx {
  validTagIds: ReadonlySet<number>;
  /** 已有工作夹子的名字 + 本方案先到的名字 —— 防重 */
  knownNames: ReadonlySet<string>;
}

const MAX_KEYWORDS = 20;

/** 全过才留;编造就整条丢(spec:不给部分正确留宽容) */
export function validateFolders(raw: unknown, ctx: FolderCtx): ValidFolder[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ValidFolder[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name.trim()) continue;
    const name = o.name.trim();
    if (ctx.knownNames.has(name) || seen.has(name)) continue; // 重名丢(与已有/与前面)
    seen.add(name);

    const reason = typeof o.reason === 'string' ? o.reason : '';

    if (!Array.isArray(o.tagIds)) continue;
    const tagIds: number[] = [];
    let badTag = false;
    for (const t of o.tagIds) {
      const n = typeof t === 'number' ? t : Number(t);
      if (!Number.isInteger(n) || !ctx.validTagIds.has(n)) { badTag = true; break; }
      if (!tagIds.includes(n)) tagIds.push(n);
    }
    if (badTag) continue; // 一个编造 = 整条不可信

    if (!Array.isArray(o.keywords)) continue;
    const keywords = [...new Set(
      o.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter(Boolean),
    )].slice(0, MAX_KEYWORDS);

    if (tagIds.length === 0 && keywords.length === 0) continue;
    out.push({ name, reason, tagIds, keywords });
  }
  return out;
}

// ── 生成主流程 ────────────────────────────────────────────

export const GENERATE_TIMEOUT_MS = 300_000;

/**
 * 一轮生成。**先落 generating 再干活**(刷新/断线状态不丢),错误回 idle。
 * 裁判顺序:validateFolders(结构)→ matchAll 实跑(命中 0 丢)→ 偏弱对账。
 */
export async function runGeneration(db: Database.Database, log: Logger, level: number): Promise<void> {
  const llm = readLlmSettings(db, 'rules');
  if (!llm) { // 路由已拦,这里兜底(异步路径里没人接 400)
    log.event({ level: 'error', category: 'llm', code: 'PROPOSAL_NO_LLM', message: '生成方案时模型配置消失' });
    return;
  }
  startProposal(db, level);
  try {
    const inputs = gatherInputs(db, level);
    const prompt = buildPrompt({ ...inputs, level });
    const raw = await complete({
      config: llm.config,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      thinking: false,
      timeoutMs: GENERATE_TIMEOUT_MS,
    });

    // 结构裁判:knownNames = 现有工作夹子名 + 词表里同名也当重名(防 AI 起名和词重)
    const nameOf = tagNamesById(db);
    const workNames = new Set(
      (db.prepare(`SELECT name FROM work_folders`).all() as { name: string }[]).map((r) => r.name),
    );
    for (const n of nameOf.values()) workNames.add(n);
    const validTagIds = new Set([...nameOf.keys()]);
    const folders = validateFolders(parseLooseJson(raw), { validTagIds, knownNames: workNames });

    // 实跑命中 + 偏弱对账
    const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
    const tagsOf = itemTagIds(db);
    const subtree = subtreeSets(db);
    const uncoveredCount = inputs.uncoveredCount;

    const drafts: DraftShape[] = [];
    for (const f of folders) {
      const conditions: RuleCondition[] = [];
      if (f.tagIds.length) conditions.push({ field: 'tag', any: f.tagIds.map(String) });
      if (f.keywords.length) conditions.push({ field: 'title', any: f.keywords });
      const probe = [{ folderId: 0, conditions, origin: 'ai' as const, updatedAt: 0 }];
      const matched = matchAll(
        items.map((i) => ({ ...toRuleItem(i), tagIds: tagsOf.get(i.id) ?? [] })),
        probe, { subtree },
      );
      if (matched.size === 0) {
        log.event({ level: 'info', category: 'llm', code: 'PROPOSAL_DRAFT_DROPPED', message: `「${f.name}」命中 0 条,丢弃` });
        continue;
      }
      // 数据裁判:声称收编的词压着 N 条,关键词规则却捞不到 → 偏弱
      // 口径:tagIds 的直接挂载数(不含子树)与命中数差 5 倍以上 → weak
      const claimed = f.tagIds.reduce((s, id) => s + (tagCount(db, id) ?? 0), 0);
      const weak = claimed >= 10 && matched.size < claimed / 5;
      drafts.push({ name: f.name, reason: f.reason, conditions, hitCount: matched.size, weak });
    }

    if (drafts.length === 0) throw new Error('AI 的方案没一个草稿活下来 —— 换个档位或模型再试');
    saveDrafts(db, level, uncoveredCount, drafts);
    log.event({ level: 'info', category: 'llm', code: 'PROPOSAL_READY', message: `方案就绪:${drafts.length} 个草稿夹子` });
  } catch (e) {
    // 回 idle 而不是留 generating —— 卡在"生成中"是死状态
    db.prepare(`UPDATE folder_proposals SET status = 'idle' WHERE id = 1`).run();
    log.event({ level: 'error', category: 'llm', code: 'PROPOSAL_FAILED', message: (e as Error)?.message ?? String(e) });
  }
}

/** saveDrafts 吃的形状 —— 就地别名一下,不为此 import DraftInput */
interface DraftShape {
  name: string; reason: string; conditions: RuleCondition[]; hitCount: number; weak: boolean;
}

/** 单个 tag 的挂载数(不加子树) */
const tagCount = (db: Database.Database, id: number): number | null => {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM item_tags WHERE tag_id = ?`).get(id) as { n: number };
  return r.n;
};
