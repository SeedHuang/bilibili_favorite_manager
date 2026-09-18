/**
 * 条目 AI 标注(spec §9F.3)—— 两段式的第一段:本地小模型逐条产出**树标签**。
 *
 * **用本地小模型是特性不是妥协**(§9E.0 实测):标注是逐条判断,4b 免费 + 全库 5 分钟;
 * 语义理解的重活留给第二段的强模型。
 *
 * **两步不是一次**(§9F C5):先说这条视频属于哪些领域(1-3 个,可以是新的),
 * 再在领域下取词。为什么不是一把梭出一串词 —— 第一步是给模型的思考台阶,让它先
 * 想"这是什么世界"再选词;而且领域名**不受已有树约束**(早期版本要求"必须是已有根"
 * 是错的:新领域第一次出现时树上什么都没有,逼它选等于逼它瞎猜)。
 */
import type Database from 'better-sqlite3';
import type { ItemRow } from '../db/repo/items.js';
import { markItemTagged } from '../db/repo/tagging.js';
import { ensureTag, linkItemTag, normalizeTagName, setTagParent } from '../db/repo/tags.js';
import { complete } from '../llm/provider.js';
import { parseJsonArray } from './parse.js';
import type { ModelConfig } from '../llm/provider.js';
import type { ChatMessage } from '../llm/context.js';
import type { ModelMeta } from '../llm/registry.js';

/** kind 受控枚举(spec C3)—— 实测不受控会同义词泛滥("教程/教学/学习") */
export const TAG_KINDS = ['教学', '娱乐', '评测', '资讯', '工具', '其它'] as const;

export const TAG_SYSTEM = `你是 bilibili 收藏的标注助手。对每条视频,分两步想:

第一步 **domains**:这条视频属于哪 1~3 个**领域**(如 美食、户外、动漫、体育、学习、游戏)。
  领域名可以是新的,不要为了迁就已有词汇而硬套。

第二步 **tags**:在每个领域下,给出这条视频的**具体词**(2~6 个)。
  要具体到能区分内容:作品名、角色名、赛事名、菜系、技术名都行(如 海贼王 / 路飞 / NBA / 粤菜 / Stable Diffusion)。
  **不要写泛词** —— "视频""教程""AI""分享"这类词没有任何区分力,一律不要。
  不要写标题里没有依据的词。

另外给一个 **kind**:内容形态,**只能**是「${TAG_KINDS.join(' / ')}」之一。

只输出 JSON 数组,不要解释,不要围栏。每条输入都必须出现在输出里:
[{"id":"BV1xx","kind":"娱乐","domains":["美食","户外"],"tags":["露营","烤羊肉"]}]`;

export interface TagOutput {
  id: string;
  kind: string;
  domains: string[];
  tags: string[];
}

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 8)
    : [];

/** 收窄模型输出。**只收本批的 id** —— 模型编别的条目无效(和归类同款纪律) */
export function coerceTagOutput(raw: unknown, batchIds: ReadonlySet<string>): TagOutput[] {
  // `raw` 是模型的原样输出(字符串)。**只认字符串** —— 和 `coerceAssignments` /
  // Task 3 的 `coerceVerdicts` 同一个口径,别在这儿开第二个方言
  const list = parseJsonArray(raw) ?? [];
  const out: TagOutput[] = [];
  for (const r of list) {
    const o = r as { id?: unknown; kind?: unknown; domains?: unknown; tags?: unknown };
    if (typeof o?.id !== 'string' || !batchIds.has(o.id)) continue;

    const domains = strList(o.domains);
    const tags = strList(o.tags);
    // **一个标签都没给 → 整条丢弃,当没标**(C6 "不合法的整条丢弃")。
    //
    // 收下它的话会写 `ai_checked_at`,于是这条**再也不会被重标** ——
    // 增量只挑 `ai_checked_at IS NULL` 的。而它一个标签都没拿到,等于永久漏掉。
    // 丢掉才是对的:下一轮它还在增量池里,有机会重新被标上。
    if (domains.length === 0 && tags.length === 0) continue;

    out.push({
      id: o.id,
      // kind 越界 → 空串;落库时按「其它」处理。受控词表的定义(C3)
      kind: TAG_KINDS.includes(o.kind as never) ? (o.kind as string) : '',
      domains,
      tags,
    });
  }
  return out;
}

/**
 * 落库(§9F C5/C6):领域建根 → 词挂到**第一个**领域下 → 别名表记一笔 → 写 item_tags。
 *
 * 为什么词只挂第一个领域:一条视频可能同时属于"美食"和"户外",但**词**在树里
 * 只能有一个父(树不是图)。挂第一个是"模型自己排的序"—— 它在 domains 里把最
 * 主要的放前面。挂错了不要紧:跑完的集合判据(C9)会按数据把它挪对。
 */
export function applyTagOutput(db: Database.Database, o: TagOutput): { created: string[] } {
  // 快照"建之前有哪些节点" —— 差集就是本轮新建的词。质检(§9F C8)只对它们开口,
  // 所以这份名单必须有,而且不能猜
  const before = new Set(
    (db.prepare(`SELECT id FROM tags`).all() as { id: number }[]).map((r) => r.id),
  );

  const domainIds: number[] = [];
  for (const d of o.domains) {
    const id = ensureTag(db, d, null);
    /**
     * **模型这次把它当"领域"说了 —— 如果它现在挂在别人下面,就把它提成根。**
     *
     * 不提的话"新大类诞生"这条路是死的:全局唯一让 `ensureTag` 复用已有节点,
     * 于是一个词**一旦当过子节点就永远是**。判据只挪根、质检的 move 也只能挪到
     * 另一个词下面 —— 没有任何一条路能把它提上来。
     *
     * 而模型把它放进 `domains` 正是在说"这是一个领域",这是那条路唯一的信号源。
     * 提错了不要紧:下一轮判据发现它的视频全落在某个词里,会把它挂回去(C9 的
     * reparent 只动根 —— 所以"提成根"是它能被纠正的前提)。
     */
    const cur = db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(id) as
      | { parent_id: number | null }
      | undefined;
    if (cur && cur.parent_id !== null) setTagParent(db, id, null);
    domainIds.push(id);
  }
  const host = domainIds[0] ?? null;

  // ⚠ 悬挂问题(已上报,未决):这里的挂靠是**累加**的 —— `linkItemTag` 的
  // ON CONFLICT DO NOTHING 只保证不重复挂,不淘汰上一轮挂上的词。于是 `scope=all`
  // 重标会让一条视频留着历次的词,而集合判据(C9)吃的正是这份数据。
  // 「重新标注全部」该是"重做"还是"叠加"是产品决定,不在这儿私自选边;
  // 定了要淘汰的话,在这行前面加 `DELETE FROM item_tags WHERE item_id=? AND source='ai'`。
  for (const name of o.tags) {
    // 领域名自己不重复挂一遍(模型偶尔把 domains 也写进 tags)
    if (o.domains.some((d) => normalizeTagName(d) === normalizeTagName(name))) continue;
    linkItemTag(db, o.id, ensureTag(db, name, host), 'ai');
  }
  for (const id of domainIds) linkItemTag(db, o.id, id, 'ai');
  markItemTagged(db, o.id, o.kind || '其它');

  return {
    created: (db.prepare(`SELECT id, name FROM tags`).all() as { id: number; name: string }[])
      .filter((r) => !before.has(r.id))
      .map((r) => r.name),
  };
}

export interface TagBatchProgress {
  done: number;
  total: number;
  tagged: number;
  failedBatches: { firstItemId: string; size: number; reason: string }[];
  /** 本轮新建的词 —— 质检(C8)只对它们开口 */
  newWords: string[];
}

export async function runTagging(opts: {
  config: ModelConfig;
  ctx: ModelMeta;
  items: readonly ItemRow[];
  onBatch?: (b: TagBatchProgress) => void;
  signal?: AbortSignal;
  db: Database.Database;
}): Promise<{
  tagged: number;
  failedBatches: { firstItemId: string; size: number; reason: string }[];
  /** 本轮新建的词 —— 质检(§9F C8)只对它们开口,所以这份名单必须报出来 */
  newWords: string[];
}> {
  const failedBatches: { firstItemId: string; size: number; reason: string }[] = [];
  // 本轮建出来的词。`applyTagOutput` 用"建之前有哪些节点"的差集算,不猜
  const newWords = new Set<string>();
  let tagged = 0;
  const total = opts.items.length;
  let done = 0;

  /** 一次调用标一批;返回标到的 id 集合。调用的原料由 pending 提供(补轮时是"缺的那些") */
  const askOnce = async (batch: readonly ItemRow[]): Promise<Set<string>> => {
    const messages: ChatMessage[] = [
      { role: 'system', content: TAG_SYSTEM },
      {
        role: 'user',
        content: batch
          .map((i) => `- [${i.id}] ${i.title}\n  简介:${(i.intro ?? '').slice(0, 150)}`)
          .join('\n'),
      },
    ];
    const raw = await complete({
      config: opts.config,
      messages,
      // 标注是批量:一整批的输入本就大,再开着思考模式就是每条都多吐一长串推理
      thinking: false,
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    });
    // **只收本批的 id** —— 模型编别的条目无效(和归类同款纪律)
    const got = coerceTagOutput(raw, new Set(batch.map((i) => i.id)));
    const out = new Set<string>();
    for (const o of got) {
      const applied = applyTagOutput(opts.db, o);
      for (const n of applied.created) newWords.add(n);
      out.add(o.id);
    }
    return out;
  };

  // 批大小:标注的输出很小(每条 ~30 token),输入才是瓶颈 —— 复用 ctx 的窗口,
  // 但按**条数**上限 16 切(spec §9E.2 写的 16 条/批)。
  // 曾经的 32 站不住:它引用的实测数据("4b 超过 ~8 条会漏")量的是**8 条时**的表现,
  // 没有谁量过 32 —— 唯一的数据点指向更小,而 16 是唯一写死的数。
  // 模型偶尔漏条由下面那两轮补轮兜底,所以切小只多花轮次,不会漏标。
  const size = Math.max(1, Math.min(16, Math.floor((opts.ctx.contextWindow - 1500) / 250)));
  for (let i = 0; i < opts.items.length; i += size) {
    if (opts.signal?.aborted) break; // §9D B2:发起新调用前先看信号
    const batch = opts.items.slice(i, i + size);
    const pending = new Map(batch.map((it) => [it.id, it]));

    // **逐条覆盖断言(C4)**:实测模型会漏条 —— 缺的单独补,最多 2 轮
    for (let round = 0; round < 3 && pending.size > 0; round++) {
      if (opts.signal?.aborted) break; // §9D B2:补轮也是一次新调用,同样先看信号
      try {
        const got = await askOnce([...pending.values()]);
        for (const id of got) pending.delete(id);
        if (got.size > 0) {
          tagged += got.size;
          done += got.size;
          opts.onBatch?.({ done, total, tagged, failedBatches, newWords: [...newWords] });
        }
      } catch (e) {
        if (opts.signal?.aborted) break; // 中止不记失败(§9D B5)
        failedBatches.push({ firstItemId: [...pending.keys()][0]!, size: pending.size, reason: `请求失败:${(e as Error)?.message ?? e}` });
        pending.clear();
        break;
      }
    }
    // 中止时上面两条 break 会带着 pending 落到这里 —— 用户点了停止不是"数据坏了",
    // 不记失败(§9D B5);只有真标不上的才进这笔账
    if (pending.size > 0 && !opts.signal?.aborted) {
      failedBatches.push({ firstItemId: [...pending.keys()][0]!, size: pending.size, reason: '模型两轮补标后仍未覆盖这些条目' });
    }
  }

  return { tagged, failedBatches, newWords: [...newWords] };
}
