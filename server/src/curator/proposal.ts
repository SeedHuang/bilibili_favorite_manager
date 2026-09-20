// server/src/curator/proposal.ts
import type { RuleCondition } from '../db/repo/rules.js';

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
