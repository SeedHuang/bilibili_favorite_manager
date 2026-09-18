import { describe, it, expect } from 'vitest';
import { getModelMeta } from './registry.js';
import {
  batchSize,
  estimateTokens,
  trimToContext,
  EST_TOKENS_PER_ITEM,
  RESERVED_FOR_SYSTEM,
  type ChatMessage,
} from './context.js';

/** 本地 14b 的实测值(spec §3):32K 上下文 / 8K 输出 */
const local14b = {
  provider: 'ollama' as const,
  model: 'qwen2.5:14b',
  contextWindow: 32_768,
  maxOutput: 8_192,
  verified: true,
};

describe('batchSize', () => {
  it('本地 14b(32K)一批至少 100 条 —— 否则 3000 条要跑 30 批', () => {
    expect(batchSize(local14b)).toBeGreaterThanOrEqual(100);
  });

  it('1M 上下文:典型 3000 条的库一批装得下', () => {
    expect(batchSize(getModelMeta('ark', 'doubao-seed-evolving'))).toBeGreaterThanOrEqual(3000);
  });

  it('大上下文但小输出上限 → 按输出预算压批次(防 JSON 写一半被截断)', () => {
    // MiniMax-M2.7 是 204.8K 输入 / 8K 输出:输入装得下 800 条,输出写不完
    expect(batchSize(getModelMeta('minimax', 'MiniMax-M2.7'))).toBeLessThanOrEqual(200);
  });

  it('批次永远 ≥ 1 —— 上下文小到装不下预留量时也不能返回 0 或负数', () => {
    expect(batchSize({ ...local14b, contextWindow: 1_000 })).toBe(1);
  });

  it('输入侧的估算不超上下文预算', () => {
    for (const m of [local14b, getModelMeta('ark', 'kimi-k3'), getModelMeta('deepseek', 'deepseek-flash')]) {
      expect(batchSize(m) * EST_TOKENS_PER_ITEM).toBeLessThanOrEqual(
        m.contextWindow - RESERVED_FOR_SYSTEM + EST_TOKENS_PER_ITEM,
      );
    }
  });
});

describe('estimateTokens', () => {
  it('中文比同长度的 ASCII 贵得多(中文 ≈ 1 token/字)', () => {
    expect(estimateTokens('中文标题四个字')).toBeGreaterThan(
      estimateTokens('abcdefgh'),
    );
  });

  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('永不返回负数', () => {
    expect(estimateTokens('x')).toBeGreaterThanOrEqual(0);
  });
});

describe('trimToContext', () => {
  const ctx = { ...local14b, contextWindow: 6_000, maxOutput: 1_000 }; // 预算 = 6000-1000-1500 = 3500
  const sys: ChatMessage = { role: 'system', content: '你是整理管家' };
  /** 每条正好 1000 token 的中文消息 */
  const big = (role: ChatMessage['role'], tag: string): ChatMessage => ({
    role,
    content: tag + '中'.repeat(999),
  });

  it('预算内原样返回', () => {
    const msgs = [sys, { role: 'user' as const, content: '你好' }];
    expect(trimToContext(msgs, ctx)).toHaveLength(2);
  });

  it('超预算丢最旧的,保留最新的', () => {
    const msgs = [big('user', 'a'), big('assistant', 'b'), big('user', 'c'), big('user', 'd')];
    const kept = trimToContext(msgs, ctx);
    expect(kept).toHaveLength(3); // 3500 预算 / 每条 1000 token
    expect(kept.at(-1)!.content).toBe(msgs.at(-1)!.content);
    expect(kept.map((m) => m.content.slice(0, 1))).not.toContain('a'); // 最旧的被丢了
  });

  it('system 永远保留 —— 丢了就不是同一个助手了', () => {
    const kept = trimToContext([big('user', 'a'), big('user', 'b'), big('user', 'c'), sys], ctx);
    expect(kept.some((m) => m.role === 'system')).toBe(true);
  });

  it('至少留一条对话 —— 当前这轮提问不能被裁掉', () => {
    const kept = trimToContext([big('user', 'a'), big('user', 'b')], ctx);
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.at(-1)!.content.slice(0, 1)).toBe('b');
  });
});
