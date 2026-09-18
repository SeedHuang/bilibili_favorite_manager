/**
 * 条目 AI 标注引擎(spec §9E)。两段式的第一段:
 * 本地小模型逐条得出"这是什么类型",写进 ai_tags —— 归类(第二段)把它当补充信号。
 *
 * **用本地小模型是特性不是妥协**:标注是逐条判断,4b 免费 + 全库 5 分钟;
 * 语义理解的重活留给第二段的强模型(§9E.0)。
 */
import type Database from 'better-sqlite3';
import type { ItemRow } from '../db/repo/items.js';
import { setItemTagging } from '../db/repo/tagging.js';
import { complete } from '../llm/provider.js';
import { parseJsonArray } from './parse.js';
import type { ModelConfig } from '../llm/provider.js';
import type { ChatMessage } from '../llm/context.js';
import type { ModelMeta } from '../llm/registry.js';

/** kind 受控枚举(spec C3)—— 实测不受控会同义词泛滥("教程/教学/学习") */
export const TAG_KINDS = ['教学', '娱乐', '评测', '资讯', '工具', '其它'] as const;

export const TAG_SYSTEM = `你是 bilibili 收藏的标注助手。对每条视频,从简介和标题判断:
1. kind:内容类型,**只能**是「${TAG_KINDS.join(' / ')}」之一 —— 这是硬约束,不属于任何类就写「其它」。
2. tags:2-4 个主题标签(如 Python、Stable Diffusion、黑神话),用视频里实际出现的词。

只输出 JSON 数组:[{"id":"...","tags":["..."],"kind":"..."}],不要解释,不要围栏。每条输入都必须出现在输出里。`;

/** kind 越界 → 「其它」;tags 非字符串 → 丢;这不是宽容,是受控词表的定义(C3) */
function coerceTag(raw: { id?: unknown; tags?: unknown; kind?: unknown }): { id: string; tags: string[]; kind: string } | null {
  if (typeof raw?.id !== 'string' || !raw.id) return null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, 6)
    : [];
  const kind = TAG_KINDS.includes(raw.kind as never) ? (raw.kind as string) : '其它';
  return { id: raw.id, tags, kind };
}

export interface TagBatchProgress {
  done: number;
  total: number;
  tagged: number;
  failedBatches: { firstItemId: string; size: number; reason: string }[];
}

export async function runTagging(opts: {
  config: ModelConfig;
  ctx: ModelMeta;
  items: readonly ItemRow[];
  onBatch?: (b: TagBatchProgress) => void;
  signal?: AbortSignal;
  db: Database.Database;
}): Promise<{ tagged: number; failedBatches: { firstItemId: string; size: number; reason: string }[] }> {
  const failedBatches: { firstItemId: string; size: number; reason: string }[] = [];
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
    const list = parseJsonArray(raw) ?? [];
    const out = new Set<string>();
    for (const r of list) {
      const c = coerceTag(r as never);
      if (!c) continue;
      // **只收本批的 id** —— 模型编别的条目无效(和归类同款纪律)
      if (!batch.some((i) => i.id === c.id)) continue;
      setItemTagging(opts.db, c.id, { tags: c.tags, kind: c.kind });
      out.add(c.id);
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
          opts.onBatch?.({ done, total, tagged, failedBatches });
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

  return { tagged, failedBatches };
}
