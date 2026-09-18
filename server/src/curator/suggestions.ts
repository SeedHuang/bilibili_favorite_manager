/**
 * 规则建议 —— AI 的第二个通道(spec §9C.5 b)。
 *
 * **单独一次调用**,不塞进归类那次:归类那次的输出是一个裸 JSON 数组,真机验证过
 * 小模型能吃住那个形状;改成 `{assignments, ruleSuggestions}` 会让输出变难,
 * 有把已经跑通的那条路弄坏的实际风险。而建议只在"有没归上的条目"时才需要 ——
 * 单独一次调用只在需要时付费,而且那次的提问更简单,对小模型更友好。
 */
import type Database from 'better-sqlite3';
import { getItem, type ItemRow } from '../db/repo/items.js';
import { listFolders, isLockedFolder } from '../db/repo/folders.js';
import { listRules } from '../db/repo/rules.js';
import { listWorkFolders, workItemIds } from '../db/repo/workbench.js';
import { itemTagIds, listTagsWithParent, subtreeSets } from '../db/repo/tags.js';
import { complete, type ModelConfig } from '../llm/provider.js';
import { parseJsonArray } from './parse.js';
import {
  matchAll, renderConditions, validateSuggestions, mergeSuggestions,
  type RawSuggestion, type RuleItem, type ValidSuggestion,
} from './rules.js';

export interface SuggestionFolder {
  folderId: number;
  name: string;
  /** 它现在的规则(渲染好的);空串 = 还没有规则 */
  rule: string;
  /** 没有规则的夹子才有 —— 几条已有标题,让它知道自己是放什么的 */
  samples?: readonly string[];
}

/**
 * 导出是为了让测试能钉住"必须给证据条目"这句 ——
 * 提示词是这条链上唯一的防线(和 classifier.ts 的 PASS2_SYSTEM 同一个理由)。
 */
export const SUGGESTION_SYSTEM = `你是 bilibili 收藏整理管家。用户在本地维护了一套"规则",
规则决定哪条收藏该进哪个夹子,规则命中的条目会 0 token 直接归位,不需要你归类。

现在有一批条目**没能归上**。请提出**规则建议**:哪些夹子应该加一条什么规则,才能接住它们。

硬要求:
1. field 只能是 "title" / "intro" / "upper" 三个之一。
2. **any 必须是一个字符串数组**,哪怕只有一个词也要放[]里 —— 写成字符串会被直接丢掉:
     错:"any":"Python"      对:"any":["Python"]
     错:"any":"前端 技术"    对:"any":["前端 技术"]
   一个词最多 20 个。**不要为了"更细"把一句话拆成几个短词** —— "技术" 这种词太宽,
   会把一大片不相干的条目捞走。
3. 每条建议要能**成批**接住一类条目 —— 不要一条条目配一条规则。两个词能接住 30 条,
   那才是好建议;只为某一条视频写一条只接得住它自己的规则,没有意义。
   **最多 10 条建议**,宁可少给几条,也要每条都真的成批。
4. **每条建议必须给出 evidenceItemIds** —— 你**真的看过的**、这条规则能命中的条目 id。
   服务端会拿这组词当场跑一遍匹配:打不中你给的那些条目,这条建议就会被丢掉。
   所以别猜,只写你真的在下面列表里看到的条目。
5. because 用一句话说清依据。
6. **只输出一个 JSON 数组**,不要别的东西,不要解释,不要 markdown 围栏。`;

export function buildSuggestionPrompt(opts: {
  folders: readonly SuggestionFolder[];
  items: readonly ItemRow[];
}): string {
  const folders = opts.folders
    .map((f) => {
      const head = `[${f.folderId}] ${f.name}${f.rule ? ` —— ${f.rule}` : '(还没有规则)'}`;
      const samples = f.samples ?? [];
      return samples.length
        ? `${head}\n    现有条目:${samples.map((s) => `「${s}」`).join(' ')}`
        : head;
    })
    .join('\n');

  return [
    '## 收藏夹体系',
    folders,
    '',
    `## 这些条目没归上(${opts.items.length} 条)`,
    opts.items.map((i) => renderItem(i)).join('\n\n'),
    '',
    '给规则建议。输出 JSON 数组,字段:folderTempId / field / any / because / evidenceItemIds',
  ].join('\n');
}

const toRuleItem = (i: ItemRow): RuleItem => ({
  id: i.id, title: i.title, intro: i.intro, upperName: i.upper_name,
});

/** 建一次 itemId → tagIds 的表,闭包给下面用 —— 别在 toRuleItem 里逐条查 */
const toRuleItemWith = (tagsOf: ReadonlyMap<string, number[]>) => (i: ItemRow): RuleItem => ({
  ...toRuleItem(i),
  tagIds: tagsOf.get(i.id) ?? [],
});

/**
 * 攒一次建议调用的**全部输入**。
 *
 * **两条路共用这一个函数** —— 归类后自动给(`run-pass-2`)和面板上主动要
 * (`POST /api/rules/suggest`)必须看到同一套东西,否则同一个模型会给出两套
 * 互相矛盾的建议。放在这里而不是各自的调用点:那样就成了两份会分叉的近似拷贝。
 *
 * `pool` = **规则没覆盖住的条目**(不是"AI 说 null 的那些") —— 理由见下面
 * `runSuggestions` 的注释。
 */
export function suggestionInput(db: Database.Database): {
  folders: SuggestionFolder[];
  /** 规则没覆盖住的条目 —— 进 prompt 的就是这些(还要再被 cap 切一次) */
  pool: ItemRow[];
  /** 全库条目 —— 自证时查它,它可能引用一条已经归到别处的条目当证据 */
  allItems: ItemRow[];
} {
  const rules = listRules(db);
  const ruleOf = new Map(rules.map((r) => [r.folderId, r]));
  const all = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
  // 规则里的 tag 条件存的是 id —— 给模型看的那份必须翻成词名(见 renderConditions)
  const tagNameOf = new Map(listTagsWithParent(db).map((r) => [r.id, r.name]));

  // **锁定的夹子(默认收藏夹)不能加规则**(spec §9C.6 约束 4)—— 那就别让模型给它提建议。
  //
  // 不排除的话这条几乎必然发生,而且是最难堪的一种:默认收藏夹条目最多,它的条目永远
  // 落在"规则没覆盖住"的池子里,所以模型会自然地想给它写一条规则接住它们 —— 而用户
  // 点「采纳」只会收到一句 400。一条看得见、点不动的建议,比没有建议更糟。
  const snapshots = new Map(listFolders(db).map((f) => [f.id, f]));
  const usable = listWorkFolders(db).filter((w) => {
    const origin = w.originId === null ? undefined : snapshots.get(w.originId);
    return origin === undefined || !isLockedFolder(db, origin);
  });

  const folders: SuggestionFolder[] = usable.map((w) => {
    const rule = renderConditions(ruleOf.get(w.id)?.conditions ?? [], tagNameOf);
    // 有规则的夹子不用带样本(规则已经说清它是放什么的);没规则的才要 ——
    // 只看名字模型会自信地猜错,这是 §9C.0 那次真机事故的教训
    const samples = rule
      ? []
      : workItemIds(db, w.id)
          .slice(0, 3)
          .map((iid) => getItem(db, iid)?.title)
          .filter((t): t is string => !!t);
    return { folderId: w.id, name: w.name, rule, ...(samples.length ? { samples } : {}) };
  });

  // 口径必须和归类那条路一致 —— 算错"规则覆盖了哪些条目",就会把已经归好的又建议一遍
  const covered = matchAll(
    all.map(toRuleItemWith(itemTagIds(db))),
    rules,
    { subtree: subtreeSets(db) },
  );
  return { folders, pool: all.filter((i) => !covered.has(i.id)), allItems: all };
}

/** 和 buildPass2Prompt 里的 renderItem 同一口径(不导出:这边只需要标题+简介+UP) */
function renderItem(i: ItemRow, maxIntro = 120): string {
  const lines = [`[${i.id}] ${i.title}`];
  if (i.intro) {
    const intro = i.intro.length > maxIntro ? `${i.intro.slice(0, maxIntro)}…` : i.intro;
    lines.push(`  简介:${intro}`);
  }
  if (i.upper_name) lines.push(`  UP:${i.upper_name}`);
  return lines.join('\n');
}

/**
 * 跑一次建议调用。**返回的一定是过了自证的**(spec §9C.5 R7)。
 *
 * **"用不了"必须抛出去,只有"确实没有"才是安静的空数组。** 这两件事长得一样但完全不同:
 *   - `pool` 空 / `homelessIds` 空 / 模型老实回了个 `[]` → 返回空数组(正常的"没建议可提")
 *   - 模型吐的东西解析不出来,或者提了但一条都没过自证 → **抛**(用户为此等了几十秒,
 *     不能让他看到面板毫无变化 —— 真机上"什么都没发生"就是这么来的)
 *
 * 抛出去之后由调用方决定:归类那条路 `.catch` 掉、退化成 `[]` 加一条 warning(建议不该
 * 拖垮归类),而面板上那个按钮把 502 摊给用户看(他是**主动**要的,得知道失败了)。
 * **新增第三个调用点时别忘了自己接。** LLM provider 自身的 rejection 同样原样抛出。
 *
 * ── 关于 `pool` / `homelessIds` / `cap` 这三个口径 ──────────────
 *
 * spec §9C.5 只说"给没归上的条目提建议",**没定到底喂哪一批**。这里定成:
 *
 * ① **pool = 规则没覆盖住的条目**(不是"AI 说 null 的那些")。依据:
 *    §9C.5(c) 第一条的字面原文就是"规则没覆盖住的条目聚成建议";而且它自己举的
 *    `because` 例子是"8 条**被归进别的夹子的**条目,标题都含这几个词" ——
 *    被归进别处 = AI 归成功了,所以输入必须包含 AI 归成功的条目。
 *    §9C.8 那句"AI 看到'这些条目没地方去'时就会提规则"说的是 AI 在输入里**注意到**
 *    什么,不是输入集合本身。
 * ② **cap = `batchSize(ctx)`**。这一条是必须的:第一次跑时一个夹子都没有规则,
 *    pool 就是全库 3250 条,每条带标题+简介约 250 token → 80 万 token,
 *    任何上下文窗口都装不下。复用 §3 已经算好的批大小,而不是另定一个魔数。
 * ③ **homeless 排最前**。cap 切的是尾巴,所以最该被看见的(AI 亲口说"拿不准"的)
 *    必须排最前,否则它们会被前面的条目挤掉。
 */
export async function runSuggestions(opts: {
  config: ModelConfig;
  folders: readonly SuggestionFolder[];
  /** 规则没覆盖住的条目 */
  pool: readonly ItemRow[];
  /** 归类时 AI 说"拿不准"的 id;空集 = 没什么可建议的,不调。不传 = 没有这个信息 */
  homelessIds?: ReadonlySet<string>;
  cap: number;
  allItems: readonly ItemRow[];
}): Promise<ValidSuggestion[]> {
  if (opts.folders.length === 0) return [];
  // 没有可提的东西就不调 —— 只在需要时付费(spec §9C.5 b)
  if (opts.pool.length === 0) return [];
  // 传了 homelessIds 就是"归类跑过"的场景:一条都没归上说明规则没漏掉什么
  if (opts.homelessIds && opts.homelessIds.size === 0) return [];

  const ordered = opts.homelessIds
    ? [
        ...opts.pool.filter((i) => opts.homelessIds!.has(i.id)),
        ...opts.pool.filter((i) => !opts.homelessIds!.has(i.id)),
      ]
    : [...opts.pool];
  const chosen = ordered.slice(0, Math.max(1, opts.cap));

  const raw = await complete({
    config: opts.config,
    messages: [
      { role: 'system', content: SUGGESTION_SYSTEM },
      { role: 'user', content: buildSuggestionPrompt({ folders: opts.folders, items: chosen }) },
    ],
    // 建议同属批量:一次塞进一批条目(首跑最坏是全库),要的是一段规则 JSON —— 不是"想清楚"
    thinking: false,
  });

  const list = parseJsonArray(raw);
  if (!list) {
    // 抛,不吞 —— 见上面 JSDoc:"用不了"和"确实没有"是两件事。
    // 真机上小模型会写出 `{"folderTempId:22,...}` 这种缺引号的 JSON,整个数组解析失败;
    // 那时候安静返回空数组,用户看到的就是"点了没反应"。
    throw new Error(
      'AI 的返回读不出来(不是合法的 JSON)—— 再点一次,或在「授权」页换个更大的模型',
    );
  }

  const valid = validateSuggestions(list, {
    validFolderIds: new Set(opts.folders.map((f) => f.folderId)),
    // 自证查**全库** —— 它可能引用一条已经归到别处的条目当证据(spec 的例子就是)
    //
    // 这里不带 tagIds:自证的探针字段只能是 VALID_FIELDS 里那三个文本字段
    // —— tag 建议根本进不来(见 VALID_FIELDS 那条注释),所以这个字段在这儿是
    // **用不上的数据**,不是取不到(把 tagsOf 经 opts 传进来是能做到的)。
    // 往一个纯调用函数里塞 db 只为喂一个没人读的字段,不值。
    itemsById: new Map(opts.allItems.map((i) => [i.id, toRuleItem(i)])),
  });

  if (list.length > 0 && valid.length === 0) {
    // 提了,全被刷掉 —— 这也是"用不了",同样不能安静。
    //
    // **别猜原因,数出来。** 两个原因指向完全不同的处置,而真机上的主力是第一个:
    //   ① 它引用的 bvid 是**编的**(库里根本没有)—— 这是模型在幻觉,唯一出路是换模型
    //   ② 条目是真的,但关键词打不中它 —— 这是模型没读懂数据
    // 真机实测:qwen2.5:14b 引用的 8 个 bvid 里 7 个不存在。写死成"关键词打不中"
    // 会把用户指错方向(去找关键词的问题,而其实是模型在编)。
    const known = new Set(opts.allItems.map((i) => i.id));
    let fabricated = 0;
    for (const r of list) {
      const ev = (r as RawSuggestion | null)?.evidenceItemIds;
      if (!Array.isArray(ev)) continue;
      for (const id of ev) if (typeof id === 'string' && !known.has(id)) fabricated += 1;
    }

    throw new Error(
      `AI 提了 ${list.length} 条建议,但一条都没通过自证校验` +
        (fabricated > 0
          ? `—— 它引用的条目里有 ${fabricated} 个 id 在库里根本不存在(那是它编的)`
          : `—— 它引用的条目被自己的关键词打不中`) +
        `。再点一次,或换个更大的模型`,
    );
  }

  return mergeSuggestions(valid);
}
