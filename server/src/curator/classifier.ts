/**
 * 两遍分类引擎(spec §9.1 / §9.1.1 / §9.3 / §9.4)。
 *
 *   Pass 1  提体系:keyword 初分(0 token)→ 抽样 100 条 → AI 抽检校准 → **硬校验**
 *   Pass 2  归类:按 contextWindow 动态分批,逐批产出 {itemId, folderTempId, confidence, reason}
 *
 * 为什么分两遍(而不是一把梭):
 * - 400 条在 32K 上下文里根本塞不下,Pass 1 一开始就跑不起来
 * - 重跑 Pass 1 只要一次调用,所以"体系不满意随便重来",不用重跑 3000 条归类
 *
 * **删除保险(C5 / §10.1.1)**:本模块的输出只有"归到哪个夹子",
 * 结构上就不存在 remove / 删除通道 —— AI 即使想删也无处可写。
 */
import type Database from 'better-sqlite3';
import type { ModelConfig } from '../llm/provider.js';
import { complete } from '../llm/provider.js';
import type { ModelMeta } from '../llm/registry.js';
import { batchSize } from '../llm/context.js';
import type { ChatMessage } from '../llm/context.js';
import { keywordClassify, DEFAULT_RULES } from './keyword.js';
import { parseJsonArray, parseLooseJson } from './parse.js';
import type { FolderSpec } from '../db/repo/sessions.js';
import type { ItemRow } from '../db/repo/items.js';
import type { Assignment, FailedBatch } from '../db/repo/classifications.js';

/**
 * itemId → { 标签显示名, 形态 }。**调用方一次算好**(`tagInfoByItem`)传进来 ——
 * 一批几百条,别在渲染里逐条查(那就是 N+1)。
 */
export type TagInfoMap = ReadonlyMap<string, { names: readonly string[]; kind: string | null }>;

// 归类结果的形状由存储层定义(db/repo/classifications.ts),这里转出去给路由用
export type { Assignment, FailedBatch };

export interface FolderLite {
  id: number;
  name: string;
  /** B站 账号自带的默认收藏夹:不能改名、不能删除,只能往里外移条目 */
  locked?: boolean;
}

export interface TaxonomyProposal {
  folders: FolderSpec[];
  /** AI 解释它做了什么、为什么 */
  notes: string;
}

/** 同一个现有夹子被多个草稿夹子复用了 —— UI 上要指出是哪几个 */
export interface DuplicateReuse {
  folderId: number;
  tempIds: string[];
}

export interface ValidationReport {
  /** 引用了不存在的现有夹子 id(幻觉)→ **阻断** */
  invalidReuseIds: number[];
  /** 同一个现有夹子被复用两次 → **阻断**(去重) */
  duplicateReuseIds: DuplicateReuse[];
  /** 体系里没用上的现有夹子 → 警告,UI 问「这些你确认放弃吗」 */
  unmatchedExistingFolders: number[];
  /** 新建夹子跟现有夹子重名 → 警告,让用户在 UI 改 */
  nameConflicts: string[];
  /**
   * 锁定的夹子(B站 自带的默认收藏夹)被复用却改了名 → 警告。
   *
   * 这条不是 AI 幻觉,是**物理上做不到**:默认收藏夹不能改名。
   * 放过去的话,方案看着没问题,到 M5 写回时才失败 —— 那时代价大得多。
   */
  renamedLockedFolders: { folderId: number; from: string; to: string }[];
}

export interface ClassifyResult {
  taxonomy: TaxonomyProposal;
  validation: ValidationReport;
  assignments: Assignment[];
}

/** 抽样上限(spec §9.1):100 条 / 单夹最多 15 条 */
export const PASS1_SAMPLE_MAX = 100;
export const PASS1_PER_GROUP_MAX = 15;
/** 缩批重试的底线(spec §9.4 第 3 层:50 → 15) */
export const MIN_BATCH = 15;

// ── 校验(§9.1.1)────────────────────────────────────────

/**
 * Pass 1 输出的硬校验。**纯函数,不调 LLM** —— 这是把"AI 幻觉"
 * 挡在 Pass 2 之前的关键一步。
 *
 * 漏掉它的后果很具体:AI 把现有夹子 id 写错 → Pass 2 默默把 3000 条
 * 归到一个不存在的夹子,而且看起来一切正常。
 */
export function validateProposal(
  proposal: TaxonomyProposal,
  existingFolders: FolderLite[],
): ValidationReport {
  const known = new Map(existingFolders.map((f) => [f.id, f]));
  const invalid = new Set<number>();
  const usage = new Map<number, string[]>();
  const existingNames = new Set(existingFolders.map((f) => f.name.trim()));
  const nameConflicts: string[] = [];
  const renamedLockedFolders: { folderId: number; from: string; to: string }[] = [];

  for (const f of proposal.folders) {
    const reuse = f.reuseFolderId;
    if (reuse !== undefined && reuse !== null) {
      const target = known.get(reuse);
      if (!target) {
        invalid.add(reuse);
      } else {
        const ids = usage.get(reuse);
        if (ids) ids.push(f.tempId);
        else usage.set(reuse, [f.tempId]);

        // 复用一个锁定的夹子时名字必须原样 —— 它改不了名
        if (target.locked && f.name.trim() !== target.name.trim()) {
          renamedLockedFolders.push({ folderId: reuse, from: target.name, to: f.name.trim() });
        }
      }
    } else if (existingNames.has(f.name.trim())) {
      nameConflicts.push(f.name.trim());
    }
  }

  const duplicateReuseIds = [...usage.entries()]
    .filter(([, tempIds]) => tempIds.length > 1)
    .map(([folderId, tempIds]) => ({ folderId, tempIds }));

  const reused = new Set(usage.keys());

  return {
    invalidReuseIds: [...invalid],
    duplicateReuseIds,
    unmatchedExistingFolders: existingFolders.filter((f) => !reused.has(f.id)).map((f) => f.id),
    nameConflicts,
    renamedLockedFolders,
  };
}

/** 阻断性错误 —— 有它就不能启动 Pass 2 */
export function isBlocking(report: ValidationReport): boolean {
  return report.invalidReuseIds.length > 0 || report.duplicateReuseIds.length > 0;
}

export class TaxonomyValidationError extends Error {
  constructor(readonly report: ValidationReport) {
    super(
      `Pass 1 输出未通过校验:${report.invalidReuseIds.length} 个不存在的夹子 id、` +
        `${report.duplicateReuseIds.length} 个被重复引用 —— Pass 2 已阻止启动`,
    );
    this.name = 'TaxonomyValidationError';
  }
}

/**
 * 给人看的问题清单 —— 路由直接回给 UI。
 *
 * 必须带**夹子名字**:用户看到「收藏夹 #8 AI 没用上」根本不知道是哪一个,
 * 这条警告就等于没说。
 */
export function describeReport(
  report: ValidationReport,
  existingFolders: FolderLite[] = [],
): string[] {
  const nameOf = (id: number): string => {
    const name = existingFolders.find((f) => f.id === id)?.name;
    return name ? `「${name}」` : `#${id}`;
  };

  const lines: string[] = [];
  for (const id of report.invalidReuseIds) {
    lines.push(`❌ AI 引用的收藏夹 #${id} 不存在 —— 它编了一个 id,Pass 2 已阻止`);
  }
  for (const d of report.duplicateReuseIds) {
    lines.push(`❌ 收藏夹 ${nameOf(d.folderId)} 被 ${d.tempIds.join('、')} 同时复用了`);
  }
  for (const id of report.unmatchedExistingFolders) {
    lines.push(`⚠️ 收藏夹 ${nameOf(id)} AI 没用上,确认放弃吗?`);
  }
  for (const n of report.nameConflicts) {
    lines.push(`⚠️ 新建夹子「${n}」与现有夹子重名,建议改成复用或改名`);
  }
  for (const r of report.renamedLockedFolders) {
    lines.push(
      `⚠️ 「${r.from}」是 B站 自带的默认收藏夹,不能改名(方案里想改成「${r.to}」)—— 请保留原名`,
    );
  }
  return lines;
}

// ── 抽样(§9.1)──────────────────────────────────────────

/**
 * 均衡抽样:跨组轮转取,单组封顶。
 *
 * 轮转而不是"每组取前 N" —— 后者会让小组一条都进不来,而 Pass 1 恰恰需要
 * 看到每一类都有什么。**确定性**(无随机)是为了同样的输入能复现同样的体系。
 */
export function sampleBalanced<T>(
  items: readonly T[],
  groupOf: (item: T) => string,
  opts: { max: number; perGroupMax: number },
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const g = groupOf(item);
    const arr = groups.get(g);
    if (arr) arr.push(item);
    else groups.set(g, [item]);
  }

  const out: T[] = [];
  const taken = new Map<string, number>();
  let progressed = true;

  while (out.length < opts.max && progressed) {
    progressed = false;
    for (const [g, arr] of groups) {
      const n = taken.get(g) ?? 0;
      if (n >= arr.length || n >= opts.perGroupMax) continue;
      out.push(arr[n]!);
      taken.set(g, n + 1);
      progressed = true;
      if (out.length >= opts.max) break;
    }
  }

  return out;
}

// ── Prompt ──────────────────────────────────────────────

/** 导出是为了让测试能钉住 C6 那句"标签是参考" —— 提示词是这条链上唯一的防线 */
export const PASS1_SYSTEM = `你是 bilibili 收藏整理管家。用户会给你他现有的收藏夹结构,和一批收藏条目的样本。

你的任务:提出一套**更少、更清晰**的收藏夹体系。

规则:
1. 按**主题/内容类型**分,不要按 UP 主分。
2. **优先复用现有收藏夹**:能合并进已有夹子的,就用 reuseFolderId 指过去,不要新建同义夹子。
   bilibili 只能给收藏夹改名/删除,不能改归属 —— 新建同义夹子只会越堆越乱。
3. reuseFolderId 必须是下面列表里**真实存在**的 id,不要编。
4. 每个夹子的 rule 要**可执行**,Pass 2 会照着它归类。
5. 尊重用户的约束(夹子数量上限、要保留哪些夹子)。
6. **永远不要提议删除任何条目**。

样本里的「标签」行是另一轮 AI 的判断,**标签是参考**:原始标题和简介才是事实,
冲突时以原始数据为准 —— 别让标签带偏你提的体系。

只输出 JSON,不要 markdown 围栏,不要解释文字:
{"folders":[{"tempId":"f1","name":"夹子名","description":"一句话说明","rule":"判定规则","estCount":120,"reuseFolderId":42}],"notes":"你做了什么、为什么"}

新建的夹子不要带 reuseFolderId 字段。`;

/** 导出是为了让测试能钉住"填数字不填名字"这几句 —— 提示词是这条链上唯一的防线 */
export const PASS2_SYSTEM = `你是收藏归类助手。用户给你一套已确认的收藏夹体系和一批条目,你要把每条归到一个夹子。

规则:
1. 每条只选**一个**主归属 —— 用户想加第二个会自己手动加。
2. 拿不准就填 null(落「未归类」,用户会自己处理),**不要硬塞**。
3. **folderTempId 必须是方括号里的那个数字**(如 [42] → 填 "42"),
   **不要填夹子名字** —— 名字只是给你看的,系统认的是数字。
4. itemId 必须**原样抄**条目标题前那个方括号里的 id,一个字符都不要改 ——
   抄错一条,那条就作废。
5. reason 一句话说清为什么归这里(用户会点开看)。
6. **不要提议删除任何条目**。

条目里的「标签」行是另一轮 AI 的判断,**标签是参考**:原始标题和简介才是事实,
冲突时以原始数据为准。标签可以帮你快速理解条目,但不要盲信。

只输出 JSON 数组,不要 markdown 围栏,不要解释文字。
**字段名必须原样用 itemId / folderTempId / confidence / reason,不要翻译成中文**:
[{"itemId":"BV1xx","folderTempId":"42","confidence":0.9,"reason":"标题和简介都是 Python 教程"}]`;

/** 把一条收藏渲染成模型读的文本。**不带 fav_time** —— 那是"你什么时候收藏的",与主题无关(spec §9.3) */
export function renderItem(
  i: ItemRow,
  maxIntro = 120,
  tagNames?: readonly string[],
  kind?: string | null,
): string {
  const lines = [`[${i.id}] ${i.title}`];
  if (i.intro) {
    const intro = i.intro.length > maxIntro ? `${i.intro.slice(0, maxIntro)}…` : i.intro;
    lines.push(`  简介:${intro}`);
  }
  if (i.upper_name) lines.push(`  UP:${i.upper_name}`);
  if (i.duration) lines.push(`  时长:${Math.round(i.duration / 60)} 分钟`);

  // §9F:标签和 kind 都是**补充信号**,原始标题/简介仍在场(C6 的"冲突时以原始数据为准")
  //
  // **kind 必须继续出现在这儿。** 它是 §9E 实测唯一被验证过有用的那个信号
  // (4b 把"Stable Diffusion"判成教学、"玄幻"判成娱乐,分对了)。只渲染标签的话,
  // `ai_kind` 就成了只写不读的死列 —— 占一列、占标注的输出 token、进不了 prompt、
  // 界面上也不显示。C7 特意论证它是"独立的正交轴",那就得让它继续有用。
  //
  // kind 为「其它」时**不占行** —— 它跟"没有 kind"是一个意思,写出来只是噪音
  // (§9E 的旧实现踩过这个:渲染出一行光秃秃的「AI标签:」)
  const tagPart = tagNames?.length ? tagNames.join('·') : '';
  const kindPart = kind && kind !== '其它' ? `[${kind}]` : '';
  if (tagPart || kindPart) {
    lines.push(`  标签:${tagPart}${tagPart && kindPart ? ' ' : ''}${kindPart}`);
  }
  return lines.join('\n');
}

export function buildPass1Prompt(opts: {
  existingFolders: FolderLite[];
  sample: readonly ItemRow[];
  userConstraint?: string;
  clusterNote?: string;
  /**
   * itemId → 标签显示名。调用方一次算好(`tagInfoByItem`),别在渲染里逐条查。
   *
   * **必填,别给它默认值**(§9F C11):可选的话,"调用方忘了传"就变成"模型永远
   * 看不到标签" —— 不报错、不红测试,只是提示词悄悄变薄。
   */
  tagInfo: TagInfoMap;
  /** §9F C15:每个夹子里**实际**是什么 —— `renderProfiles` 渲染好的那段 */
  profiles?: string;
  /**
   * ⚠️ **参数名必须是 `rulesText`,不能叫 `rules`。** `runPass1` 的 opts 里已经有一个
   * `rules?: ReadonlyMap<string, readonly string[]>`(keyword 初分用的词表),
   * 同一层再加一个同名的 `string` 直接**编译不过**。
   * 名字里带 `Text` 也正好说明它是"给人/给模型看的那段文本",不是数据。
   */
  rulesText?: string;
}): string {
  const folders = opts.existingFolders.length
    ? opts.existingFolders.map((f) => `#${f.id} ${f.name}`).join('\n')
    : '(用户还没有任何收藏夹)';

  const parts = [
    `## 用户现有的收藏夹(${opts.existingFolders.length} 个)`,
    folders,
  ];
  // §9F C15:画像 = "这个夹子里**实际**是什么"。没有它,模型只能看名字猜 ——
  // §9C.0 那次事故(4 条 AI 教程被归进「黑神话」)就是这个猜造成的。
  if (opts.profiles) parts.push('', '### 每个夹子里实际是什么(按标签统计)', opts.profiles);
  if (opts.sample.length) {
    parts.push(
      '',
      `## 收藏样本(${opts.sample.length} 条,从整个收藏库里均衡抽取)`,
      opts.sample
        .map((i) => {
          const t = opts.tagInfo.get(i.id);
          return renderItem(i, 120, t?.names, t?.kind);
        })
        .join('\n\n'),
    );
  }
  if (opts.rulesText) parts.push('', '### 现有的归类规则', opts.rulesText);
  if (opts.clusterNote) parts.push('', `## 本地关键词初筛的情况`, opts.clusterNote);
  if (opts.userConstraint) parts.push('', `## 用户的约束(必须遵守)`, opts.userConstraint);
  parts.push('', '请给出建议体系。');
  return parts.join('\n');
}

export function buildPass2Prompt(opts: {
  folders: readonly FolderSpec[];
  items: readonly ItemRow[];
  /**
   * 每个夹子里已有的几条标题 —— 给**没有规则的**夹子用。
   *
   * 这一条是必须的,来自一次真机事故:一个没有规则的夹子,模型只看名字就会瞎猜
   * (实测 4 条明确的 AI 教程被归进了「黑神话」,而且全标 90% 置信度)。
   * 给它三条标题,它立刻知道那夹子是放什么的。
   */
  samples?: ReadonlyMap<number, readonly string[]>;
  /**
   * itemId → 标签显示名。调用方一次算好(`tagInfoByItem`),别在渲染里逐条查。
   *
   * **必填,别给它默认值**(§9F C11):可选的话,"调用方忘了传"就变成"模型永远
   * 看不到标签" —— 不报错、不红测试,只是提示词悄悄变薄。
   */
  tagInfo: TagInfoMap;
}): string {
  // 只带 tempId + name + rule —— description/estCount 对归类没用,纯占 token(spec §9.3)。
  // **tempId 用方括号单独框出来**:它现在是裸数字(工作夹子 id),写成 `63:健身` 时
  // 实测小模型会填名字而不是数字,于是整批归类全落空(而界面上看起来是"完成")。
  const folders = opts.folders
    .map((f) => {
      const head = `[${f.tempId}] ${f.name}${f.rule ? ` —— ${f.rule}` : ''}`;
      const samples = opts.samples?.get(Number(f.tempId)) ?? [];
      return samples.length
        ? `${head}\n    现有条目:${samples.map((s) => `「${s}」`).join(' ')}`
        : head;
    })
    .join('\n');

  return [
    '## 收藏夹体系',
    folders,
    '',
    `## 待归类条目(${opts.items.length} 条)`,
    opts.items
      .map((i) => {
        const t = opts.tagInfo.get(i.id);
        return renderItem(i, 120, t?.names, t?.kind);
      })
      .join('\n\n'),
    '',
    '请给每条一个归属。',
  ].join('\n');
}

// ── 输出收窄 ────────────────────────────────────────────

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function coerceFolder(raw: unknown, index: number): FolderSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = asString(o.name).trim();
  if (!name) return null;

  // 刻意**不**在这里过滤不存在的 reuseFolderId —— 校验层要看到它才能报错
  const reuse = typeof o.reuseFolderId === 'number' ? o.reuseFolderId : undefined;

  return {
    tempId: asString(o.tempId).trim() || `f${index + 1}`,
    name,
    description: asString(o.description),
    rule: asString(o.rule),
    estCount: typeof o.estCount === 'number' ? o.estCount : 0,
    ...(reuse === undefined ? {} : { reuseFolderId: reuse }),
  };
}

export function coerceProposal(raw: unknown): TaxonomyProposal | null {
  const parsed = parseLooseJson(raw);
  if (!parsed) return null;

  let list: unknown[] | null = null;
  let notes = '';
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.folders)) list = o.folders;
    notes = asString(o.notes);
  }
  if (!list) return null;

  const folders = list
    .map((f, i) => coerceFolder(f, i))
    .filter((f): f is FolderSpec => f !== null);
  if (folders.length === 0) return null;

  return { folders, notes };
}

/**
 * 收窄 Pass 2 的输出。
 *
 * `validTempIds` 里没有的归属**直接丢掉** —— 这是 Pass 1 校验之外的
 * 第二道闸:即使 Pass 2 自己编了个 tempId,也落不到一个不存在的夹子上。
 */
export function coerceAssignments(raw: unknown, validTempIds: ReadonlySet<string>): Assignment[] | null {
  const list = parseJsonArray(raw);
  if (!list) return null;

  const out: Assignment[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const itemId = asString(o.itemId).trim();
    if (!itemId) continue;

    // 模型很自然会把 tempId 吐成数字(63)而不是字符串("63")—— 两边都认。
    // 不认的话一整批会静默变成"未归类",而界面上看起来是"归类完成"。
    const rawTemp = o.folderTempId;
    const tempId = typeof rawTemp === 'number' ? String(rawTemp) : rawTemp;
    let folderTempId: string | null = null;
    if (typeof tempId === 'string' && validTempIds.has(tempId)) {
      folderTempId = tempId;
    }

    const c = typeof o.confidence === 'number' ? o.confidence : 0.5;
    out.push({
      itemId,
      folderTempId,
      confidence: Math.min(1, Math.max(0, c)),
      reason: asString(o.reason),
    });
  }

  return out.length ? out : null;
}

// ── Pass 1 ──────────────────────────────────────────────

export interface Pass1Result {
  taxonomy: TaxonomyProposal;
  validation: ValidationReport;
  /** 实际喂进去的样本 —— UI 上"AI 看了哪些"要能显示 */
  sample: ItemRow[];
  /** keyword 初分的统计:命中/未命中 */
  keywordStats: { matched: number; unmatched: number; clusters: Map<string, number> };
}

/**
 * Pass 1:提体系。
 *
 * 流程是 keyword 初分(0 token)→ 均衡抽样 → 一次 LLM 调用 → 硬校验。
 * 校验不通过**直接抛** —— Pass 2 绝不能跟着一个错的体系跑。
 */
export async function runPass1(opts: {
  config: ModelConfig;
  existingFolders: FolderLite[];
  items: readonly ItemRow[];
  userConstraint?: string;
  rules?: ReadonlyMap<string, readonly string[]>;
  /** 默认按 keyword 簇分组;调用方有更好的分组(如现有夹子)可以覆盖 */
  groupOf?: (item: ItemRow) => string;
  sampleMax?: number;
  perGroupMax?: number;
  /** §9F:标签进 prompt —— 调用方一次查好(`tagInfoByItem`),必填(理由见 C11) */
  tagInfo: TagInfoMap;
  /** §9F C15:每个夹子里**实际**是什么 —— 没有它模型只能看名字猜 */
  profilesText?: string;
  /** 现有规则的可读文本。**别叫 `rules`** —— 那个名字已经被 keyword 词表占了 */
  rulesText?: string;
}): Promise<Pass1Result> {
  const rules = opts.rules ?? DEFAULT_RULES;

  // 1) keyword 初分 —— 纯本地,0 token。每条只算一次,分组和统计共用
  const clusterOf = new Map<string, string>();
  const counts = new Map<string, number>();
  let matched = 0;
  for (const item of opts.items) {
    const top = keywordClassify(item, rules)[0]?.candidate;
    if (top) matched++;
    const key = top ?? '待校准';
    clusterOf.set(item.id, key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // 2) 均衡抽样
  const groupOf = opts.groupOf ?? ((item: ItemRow) => clusterOf.get(item.id) ?? '待校准');
  const sample = sampleBalanced(opts.items, groupOf, {
    max: opts.sampleMax ?? PASS1_SAMPLE_MAX,
    perGroupMax: opts.perGroupMax ?? PASS1_PER_GROUP_MAX,
  });

  const clusterNote = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}:${n} 条`)
    .join('、');

  // 3) 一次 LLM 调用
  const messages: ChatMessage[] = [
    { role: 'system', content: PASS1_SYSTEM },
    {
      role: 'user',
      content: buildPass1Prompt({
        existingFolders: opts.existingFolders,
        sample,
        clusterNote,
        ...(opts.userConstraint ? { userConstraint: opts.userConstraint } : {}),
        ...(opts.profilesText ? { profiles: opts.profilesText } : {}),
        ...(opts.rulesText ? { rulesText: opts.rulesText } : {}),
        tagInfo: opts.tagInfo,
      }),
    },
  ];
  const raw = await complete({ config: opts.config, messages, thinking: false });
  const taxonomy = coerceProposal(raw);
  if (!taxonomy) {
    throw new Error('Pass 1 没吐出可用的体系 JSON —— 重跑一次,或换个模型');
  }

  // 4) 硬校验(§9.1.1)
  const validation = validateProposal(taxonomy, opts.existingFolders);
  if (isBlocking(validation)) throw new TaxonomyValidationError(validation);

  return {
    taxonomy,
    validation,
    sample,
    keywordStats: { matched, unmatched: opts.items.length - matched, clusters: counts },
  };
}

// ── Pass 2 ──────────────────────────────────────────────

export interface Pass2Result {
  assignments: Assignment[];
  failedBatches: FailedBatch[];
}

/** §9D A2:单批完成时的进度载荷 —— 界面靠它画出"第 5/11 批"和本批明细 */
export interface BatchProgress {
  /** 批号,从 1 计。按**出队顺序**编号 —— 缩批裂出的子批也算各自一批(它们也是"第 N 批") */
  batch: number;
  /** 初始批数。缩批会让实际批数变多,batch 可能超过它 */
  batches: number;
  /** 已处理**条目**数 */
  done: number;
  total: number;
  /** 本批产出的归属 */
  assignments: readonly Assignment[];
  /** 截至本批的失败批次 —— 与 runPass2 内部同一个数组,只读 */
  failedBatches: readonly FailedBatch[];
}

/**
 * Pass 2:归类。
 *
 * 每批独立、可续跑、失败只影响该批(spec §9.3)。批大小由 contextWindow 动态算,
 * 不硬编码 —— 换模型不用改这里。
 *
 * **返回的 assignments 保证覆盖每一条输入**。这件事必须在这一层做:
 * 路由是先跑 Pass 1、落草稿、再跑 Pass 2 的,不经过 classifyAll ——
 * 把覆盖保证放在 classifyAll 里,真实路径上就等于没有,模型漏掉的条目
 * 会在审阅界面上凭空消失,用户根本不知道它们没被归类。
 */
export async function runPass2(opts: {
  config: ModelConfig;
  ctx: ModelMeta;
  folders: readonly FolderSpec[];
  items: readonly ItemRow[];
  /** 透传给 buildPass2Prompt —— 没规则的夹子靠已有标题表达"我是放什么的" */
  samples?: ReadonlyMap<number, readonly string[]>;
  /** §9F:标签进 prompt —— 调用方一次查好(`tagInfoByItem`),必填(理由见 C11) */
  tagInfo: TagInfoMap;
  /** §9D A2:每批完成一次。批次从 1 计,done/total 是**条目**数 */
  onBatch?: (b: BatchProgress) => void;
  /** §9D B2:用户点了停止。批与批之间检查;批内由 complete 的 abortSignal 中断 */
  signal?: AbortSignal;
}): Promise<Pass2Result> {
  if (opts.folders.length === 0 || opts.items.length === 0) {
    return { assignments: [], failedBatches: [] };
  }

  const validTempIds = new Set(opts.folders.map((f) => f.tempId));
  const inLibrary = new Set(opts.items.map((i) => i.id));
  const size = batchSize(opts.ctx);

  const queue: ItemRow[][] = [];
  for (let i = 0; i < opts.items.length; i += size) {
    queue.push(opts.items.slice(i, i + size));
  }

  const assignments: Assignment[] = [];
  const failedBatches: FailedBatch[] = [];
  let done = 0;
  const totalBatches = queue.length;
  let batchNo = 0;

  while (queue.length > 0) {
    // **先看信号再花钱** —— 发起 provider 调用前检查,中止就不开下一批
    if (opts.signal?.aborted) break;
    const batch = queue.shift()!;
    batchNo += 1;

    let raw: string;
    try {
      raw = await complete({
        config: opts.config,
        messages: [
          { role: 'system', content: PASS2_SYSTEM },
          {
            role: 'user',
            content: buildPass2Prompt({
              folders: opts.folders,
              items: batch,
              ...(opts.samples ? { samples: opts.samples } : {}),
              tagInfo: opts.tagInfo,
            }),
          },
        ],
        // 归类也是批量:一次发几十条,要的是"照格式吐 JSON"不是"想清楚"
        thinking: false,
        // 批内中断:用户点停止时让 provider 立刻收手,别把 token 生成完再说(§9D B2)
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      });
    } catch (e) {
      if (opts.signal?.aborted) {
        // **主动中断不是故障(§9D B5)**:不记 failedBatches(那笔账是"这批的数据坏了"),
        // 直接跳出 —— 已完成的批次留在 assignments 里,由调用方落库
        break;
      }
      // 网络/服务问题缩批没用,直接标记该批失败,其余批次继续(§9.4 第 4 层)
      failedBatches.push({
        firstItemId: batch[0]!.id,
        size: batch.length,
        reason: `请求失败:${(e as Error)?.message ?? e}`,
      });
      continue;
    }

    const got = coerceAssignments(raw, validTempIds);
    if (got) {
      assignments.push(...got);
      done += batch.length;
      opts.onBatch?.({
        batch: batchNo,
        batches: totalBatches,
        done,
        total: opts.items.length,
        assignments: got,
        failedBatches,
      });
      continue;
    }

    // 解析失败 → 缩批重试(§9.4 第 3 层)
    if (batch.length > MIN_BATCH) {
      const mid = Math.ceil(batch.length / 2);
      queue.unshift(batch.slice(0, mid), batch.slice(mid));
      continue;
    }

    failedBatches.push({
      firstItemId: batch[0]!.id,
      size: batch.length,
      reason: '模型没吐出可解析的 JSON',
    });
  }

  // **主动中断:原样返回已完成的批次**(§9D B5)—— 没轮到处理的条目不替模型下结论,
  // 补成"未归类"等于替用户把那些条目标成待办;用户只是暂停,那些条目等续跑
  // **中止路径跳过兜底与去重**:返回的是"已完成批次的原样累积" —— 没有
  // 兜底占位、没有按置信度去重。当前唯一的消费者(路由)在中止时不会把
  // 这份结果落库(它只落 onBatch 里已完成的批次),所以这个天花板无害;
  // 将来若有"中止但继续用返回值"的调用方,这里要先补齐那两步。
  if (opts.signal?.aborted) return { assignments, failedBatches };

  // 收尾:模型可能漏条目、也可能对同一条给多次、还可能编出不在本库的 itemId。
  // 统一按 items 的顺序重排一次,保证一一对应;同一条重复时留置信度高的那个。
  const byItem = new Map<string, Assignment>();
  for (const a of assignments) {
    if (!inLibrary.has(a.itemId)) continue; // 编出来的 itemId 丢掉
    const prev = byItem.get(a.itemId);
    if (!prev || a.confidence > prev.confidence) byItem.set(a.itemId, a);
  }

  return {
    assignments: opts.items.map(
      (item): Assignment =>
        byItem.get(item.id) ?? {
          itemId: item.id,
          folderTempId: null,
          confidence: 0,
          reason: '模型未给出归类,待你手动处理',
        },
    ),
    failedBatches,
  };
}

// ── 端到端 ──────────────────────────────────────────────

/**
 * 完整跑一遍:keyword → Pass 1 → 校验 → Pass 2。
 *
 * 覆盖保证在 runPass2 里(那里才是真正归类的地方),这里只是把两遍串起来。
 */
export async function classifyAll(opts: {
  db?: Database.Database;
  config: ModelConfig;
  ctx: ModelMeta;
  existingFolders: FolderLite[];
  items: readonly ItemRow[];
  userConstraint?: string;
  rules?: ReadonlyMap<string, readonly string[]>;
  groupOf?: (item: ItemRow) => string;
  /** §9F:标签进 prompt —— 两条 pass 都要,所以在这儿透传两次(必填,理由见 C11) */
  tagInfo: TagInfoMap;
  onBatch?: (b: BatchProgress) => void;
}): Promise<ClassifyResult> {
  const pass1 = await runPass1({
    config: opts.config,
    existingFolders: opts.existingFolders,
    items: opts.items,
    ...(opts.userConstraint ? { userConstraint: opts.userConstraint } : {}),
    ...(opts.rules ? { rules: opts.rules } : {}),
    ...(opts.groupOf ? { groupOf: opts.groupOf } : {}),
    tagInfo: opts.tagInfo,
  });

  const pass2 = await runPass2({
    config: opts.config,
    ctx: opts.ctx,
    folders: pass1.taxonomy.folders,
    items: opts.items,
    tagInfo: opts.tagInfo,
    ...(opts.onBatch ? { onBatch: opts.onBatch } : {}),
  });

  return {
    taxonomy: pass1.taxonomy,
    validation: pass1.validation,
    assignments: pass2.assignments,
  };
}
