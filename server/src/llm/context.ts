import type { ModelMeta } from './registry.js';

/** 一条收藏喂给模型的估算开销(标题+简介+UP+时长),spec §3 */
export const EST_TOKENS_PER_ITEM = 250;
/**
 * 一条归类结果的估算开销(`{itemId, folderTempId, confidence, reason}`)。
 * 这个数决定**输出侧**的批次上限 —— 小输出模型的真正瓶颈在这里,
 * 不是输入装不装得下。
 */
export const EST_OUTPUT_PER_ITEM = 60;
/** system prompt + 体系规则 + 输出预留(spec §3) */
export const RESERVED_FOR_SYSTEM = 1500;

/**
 * 一批塞多少条。由当前模型的 `contextWindow` 动态算,**不硬编码** ——
 * 这是换模型不用改业务代码的关键(spec §3 上下文自适应)。
 *
 * 输入侧和输出侧各算一遍取小的:
 * - 输入侧:塞进去的条目不能超上下文
 * - 输出侧:写出来的 JSON 不能超 maxOutput,否则小模型会把结果写一半就断
 *
 * 兜底 ≥1:上下文小到连预留量都装不下时也得能跑,只是每批 1 条。
 */
export function batchSize(ctx: ModelMeta): number {
  const byInput = Math.floor((ctx.contextWindow - RESERVED_FOR_SYSTEM) / EST_TOKENS_PER_ITEM);
  const byOutput = Math.floor(ctx.maxOutput / EST_OUTPUT_PER_ITEM);
  return Math.max(1, Math.min(byInput, byOutput));
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * 估算一段文本的 token 数。
 *
 * 中文 ≈ 1 token/字,ASCII ≈ 0.25 token/字符 —— 保守估计,偏高一点没关系
 * (偏高只会让我们早点压缩,不会撑爆上下文)。
 * ponytail: 字符数启发式,不是真分词器;要精确就接 tiktoken,但那是每模型一个词表。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[⺀-￿]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) * 0.25);
}

/**
 * 把消息裁进上下文预算。
 *
 * 策略:**从最新往回装**,装不下的最旧的先丢 —— 丢掉的正是调用方要另外用
 * 滚动摘要接住的部分(见 curator/chat.ts)。system 消息永远保留,
 * 且**至少留一条对话**,否则当前这轮提问会被裁掉,模型答非所问。
 */
export function trimToContext(messages: ChatMessage[], ctx: ModelMeta): ChatMessage[] {
  const budget = Math.max(0, ctx.contextWindow - ctx.maxOutput - RESERVED_FOR_SYSTEM);

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  let used = system.reduce((n, m) => n + estimateTokens(m.content), 0);
  const kept: ChatMessage[] = [];

  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i]!;
    const cost = estimateTokens(m.content);
    if (used + cost > budget && kept.length > 0) break;
    used += cost;
    kept.unshift(m);
  }

  return [...system, ...kept];
}
