import type { FolderRule, RuleField } from '../db/repo/rules.js';
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

