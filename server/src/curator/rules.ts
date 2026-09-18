import type { FolderRule, RuleCondition, RuleField } from '../db/repo/rules.js';
import type { ItemRow } from '../db/repo/items.js';

/**
 * 规则匹配 —— **纯函数,无 IO**。
 *
 * 它是归类的第一段:规则命中的条目 0 token、毫秒级归位,而且是**确定性的**
 * (改一条规则、重跑、结果可预测),AI 只处理规则没覆盖的语义边界。
 *
 * 命中即成员:一条条目可以同时命中多个夹子,那就都归(R4)。
 * B站 本来就支持一条视频在多个夹子里,所以"命中多个"不是冲突,是事实。
 */

export interface RuleItem {
  id: string;
  title: string;
  intro?: string | null;
  upperName?: string | null;
  /** 条目挂的标签 id。规则 field='tag' 时用它(C11) */
  tagIds?: readonly number[];
}

export interface RuleContext {
  /**
   * tagId → 它的子树(含自己)。**必传才能用 tag 条件** ——
   * 缺了就当没有标签,而不是"命中一切"。
   */
  subtree?: ReadonlyMap<number, ReadonlySet<number>>;
}

export interface RuleHitToken {
  field: RuleField;
  token: string;
}

export interface RuleHit {
  folderId: number;
  /** 命中的条件,可能多条(同一个夹子的多个条件都命中时) */
  tokens: RuleHitToken[];
}

const FIELD_LABEL: Record<RuleField, string> = {
  title: '标题', intro: '简介', upper: 'UP 名', tag: '标签',
};

/**
 * 库里的条目 → 规则引擎看的那个投影。**只有这一处**。
 *
 * 它跟着 `RuleItem` 住在同一个模块里:三个调用点(归类前先跑规则、规则面板算命中数、
 * 建议算"规则覆盖了谁")看到的东西必须一模一样 —— 各写一遍的话,漏掉 `tagIds`
 * (或某天多一个字段)只会让其中一条路上的规则悄悄少命中,而另外两条路看着是对的。
 *
 * `tagIds` 不在这个基础投影里:只有规则匹配那两条路要它,自证那条路用不上
 * (探针字段只可能是文本字段)。需要它的地方自己铺一层,见下面的用法。
 */
export const toRuleItem = (i: ItemRow): RuleItem => ({
  id: i.id, title: i.title, intro: i.intro, upperName: i.upper_name,
});

/** 一条条目命中哪些夹子的规则。**可多个** —— 命中即成员 */
export function matchItem(
  item: RuleItem,
  rules: readonly FolderRule[],
  ctx: RuleContext = {},
): RuleHit[] {
  // tag 不是文本字段,没有可查的干草堆 —— 它单独一条分支处理(它在 ctx 里查子树)
  const text: Record<'title' | 'intro' | 'upper', string> = {
    title: (item.title ?? '').toLowerCase(),
    intro: (item.intro ?? '').toLowerCase(),
    upper: (item.upperName ?? '').toLowerCase(),
  };

  const hits: RuleHit[] = [];

  for (const rule of rules) {
    const tokens: RuleHitToken[] = [];
    for (const cond of rule.conditions) {
      if (cond.field === 'tag') {
        // 选中任何一个标签 = 匹配它**整棵子树**(§9F C11):选「体育」命中
        // 所有体育下的条目,选「NBA」只命 NBA 那条线。条件里存的是 tag id 的
        // 字符串形式(存名字的话,改一次词名就悄悄改掉了规则语义)。
        const ids = item.tagIds ?? [];
        const sub = ctx.subtree;
        if (!sub || ids.length === 0) continue;
        for (const kw of cond.any) {
          if (!kw) continue;
          const root = Number(kw);
          if (!Number.isInteger(root)) continue;
          const want = sub.get(root);
          if (!want) continue;                       // 词库里没有这个词 → 不命中(不是命中一切)
          if (ids.some((t) => want.has(t))) tokens.push({ field: 'tag', token: kw });
        }
        continue;
      }
      const hay = text[cond.field];
      if (!hay) continue;
      for (const kw of cond.any) {
        // 空关键词会匹配一切 —— 半写的规则不该捞走任何东西
        if (!kw) continue;
        if (hay.includes(kw.toLowerCase())) tokens.push({ field: cond.field, token: kw });
      }
    }
    // 同一个夹子的多个条件都命中 → 只出一条,但 tokens 都带上
    if (tokens.length > 0) hits.push({ folderId: rule.folderId, tokens });
  }

  return hits;
}

/**
 * 批量版本。**没命中的条目根本不进 Map** —— 调用方据此算"剩下多少要给 AI"(§9C.3 ②)
 * 和"规则覆盖了多少条"(§9C.4 试跑)。
 */
export function matchAll(
  items: readonly RuleItem[],
  rules: readonly FolderRule[],
  ctx: RuleContext = {},
): Map<string, RuleHit[]> {
  const out = new Map<string, RuleHit[]>();
  for (const item of items) {
    const hits = matchItem(item, rules, ctx);
    if (hits.length > 0) out.set(item.id, hits);
  }
  return out;
}

/**
 * 把一组条件渲染成给模型看的一句话(空条件 → 空串,调用方据此不写那一行)
 *
 * **关键词还是空的 = 这条条件还没写完** —— 界面上「新增规则」建出来的就是
 * `[{ field: 'title', any: [] }]` 这个形状,而用户打字的过程中也是它。半句话
 * (`标题含 `)喂给模型比不喂更糟:那正是 §9C.0 里"模型拿到残缺信息于是瞎猜"的老毛病。
 * 这里用的判空条件和 `matchItem` 里那句 `if (!kw) continue` **完全一致** ——
 * 两处对"半写的规则"必须给出同一个答案。
 *
 * **tag 条件里存的是 id,这里得翻成词名再印。** 印 id 的话模型读到的是
 * 「标签含 42、57」—— 而 C15 说的"依据就是标签和规则"里的那一半,变成一串
 * 数字就全废了。翻不到名字的 id 直接跳过:一个都翻不出来时这条渲染成空串,
 * 和"关键词还空着"同款(它本来也就匹配不到东西)。
 *
 * **`tagNameOf` 是必填的,不给默认值。** 给 `= new Map()` 的话,漏传的那个调用方
 * 不报错 —— 只是 tag 条件静默渲染成空串,模型看不到这一半依据,而没有任何测试
 * 会发现。这和 C6 里"闸放唯一收口、不放在各调用点"是同一条道理:
 * **默认值会把"漏了"变成"静默降级"**。
 */
export function renderConditions(
  conditions: readonly RuleCondition[],
  tagNameOf: ReadonlyMap<number, string>,
): string {
  const written = (c: RuleCondition): string[] =>
    c.field === 'tag'
      ? c.any.map(Number).map((id) => tagNameOf.get(id)).filter((x): x is string => !!x)
      : c.any.filter((k) => k);
  return conditions
    .filter((c) => written(c).length > 0)
    .map((c) => `${FIELD_LABEL[c.field]}含 ${written(c).join('/')}`)
    .join(';或 ');
}

// ── 建议的自证(spec §9C.5 R7)─────────────────────────────

/** 模型原始输出 —— 全是 unknown,因为它是不可信输入 */
export interface RawSuggestion {
  folderTempId?: unknown;
  field?: unknown;
  any?: unknown;
  because?: unknown;
  evidenceItemIds?: unknown;
}

/** 过了自证的建议。形状与 spec §9C.5 的返回形状一一对应,少一层翻译 */
export interface ValidSuggestion {
  folderId: number;
  field: RuleField;
  any: string[];
  because: string;
  evidenceItemIds: string[];
}

export interface SuggestionCtx {
  validFolderIds: ReadonlySet<number>;
  /** 全库条目 —— 自证时要拿它当场跑匹配 */
  itemsById: ReadonlyMap<string, RuleItem>;
}

const VALID_FIELDS: readonly RuleField[] = ['title', 'intro', 'upper'];
/** 一条规则最多这么多词 —— 防模型塞一堆噪音把规则变垃圾 */
const MAX_KEYWORDS = 20;

/**
 * 验证一条 AI 建议。**过不了任一关就丢**。
 *
 * 最后那一关是关键:**它说"这些词管用"就必须真的管用** —— 拿它给的证据条目
 * 当场跑一遍匹配,打不中就是它编的。不给"部分正确"留宽容:一个词打不中,
 * 说明它没真在读数据,那另外几个词也不可信。
 */
export function validateSuggestion(
  raw: RawSuggestion,
  ctx: SuggestionCtx,
): ValidSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;

  // 模型常把数字 id 吐成字符串,两边都认
  const rawId = raw.folderTempId;
  const folderId = typeof rawId === 'number' ? rawId : Number(rawId);
  if (!Number.isInteger(folderId) || !ctx.validFolderIds.has(folderId)) return null;

  if (typeof raw.field !== 'string' || !VALID_FIELDS.includes(raw.field as RuleField)) return null;

  // 模型经常把 any 写成字符串而不是数组(`"any":"Python"`)—— 那是**序列化**写错了,
  // 不是它想表达的东西错了。包成单元素数组是**无损**的:不切词、不猜,那串字面就是
  // 它要的关键词,自证照样要过。真机上 qwen2.5:14b 就是这么写的,54 条建议全被丢掉。
  //
  // **绝不切词**:把 "前端 技术" 拆成两个词会让 "技术" 捞走一大片不相干的条目 ——
  // 宁可选不中(自证会丢掉它),也不要悄悄改变匹配语义。
  const rawAny = typeof raw.any === 'string' ? [raw.any] : raw.any;
  if (!Array.isArray(rawAny)) return null;
  const any = rawAny
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter((k) => k !== '')
    .slice(0, MAX_KEYWORDS);
  if (any.length === 0) return null;

  if (!Array.isArray(raw.evidenceItemIds) || raw.evidenceItemIds.length === 0) return null;
  const evidenceItemIds = raw.evidenceItemIds.filter((x): x is string => typeof x === 'string');
  if (evidenceItemIds.length === 0) return null;

  // ★ 自证:每个证据条目都必须被这组词命中
  const probe: FolderRule[] = [
    { folderId, conditions: [{ field: raw.field as RuleField, any }], origin: 'ai', updatedAt: 0 },
  ];
  for (const id of evidenceItemIds) {
    const item = ctx.itemsById.get(id);
    if (!item) return null; // 它引用了一条不存在的条目
    if (matchItem(item, probe).length === 0) return null; // 词打不中它自己给的证据 —— 那就是编的
  }

  return {
    folderId,
    field: raw.field as RuleField,
    any,
    because: typeof raw.because === 'string' ? raw.because : '',
    evidenceItemIds,
  };
}

export function validateSuggestions(raw: unknown, ctx: SuggestionCtx): ValidSuggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => validateSuggestion(r as RawSuggestion, ctx))
    .filter((v): v is ValidSuggestion => v !== null);
}

/**
 * 按 `夹子 + 字段 + 排序后的词表` 去重,并把各批的 `evidenceItemIds` 并起来。
 *
 * 不同批看到的是同一类条目时,合成一条**更强的**建议 —— 证据更多,
 * 你更容易判断该不该采纳(spec §9C.5 c)。
 */
export function mergeSuggestions(list: readonly ValidSuggestion[]): ValidSuggestion[] {
  const out = new Map<string, ValidSuggestion>();

  for (const s of list) {
    const key = `${s.folderId}|${s.field}|${[...s.any].sort().join(',')}`;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...s, evidenceItemIds: [...new Set(s.evidenceItemIds)] });
      continue;
    }
    // 保留先看到的那条(它的 because 也是先看到的),只把证据并进来
    prev.evidenceItemIds = [...new Set([...prev.evidenceItemIds, ...s.evidenceItemIds])];
  }

  return [...out.values()];
}
