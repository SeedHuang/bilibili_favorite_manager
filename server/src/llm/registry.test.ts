import { describe, it, expect } from 'vitest';
import { MODELS, getModelMeta, listModels } from './registry.js';

describe('模型注册表', () => {
  it('已知模型返回实测的 contextWindow / maxOutput', () => {
    const m = getModelMeta('deepseek', 'deepseek-chat');
    expect(m.contextWindow).toBe(128_000);
    expect(m.maxOutput).toBe(8_192);
    expect(m.verified).toBe(true);
  });

  it('1M 上下文的模型按 1024K 记', () => {
    const m = getModelMeta('ark', 'kimi-k3');
    expect(m.contextWindow).toBe(1_024_000);
    expect(m.verified).toBe(true);
    expect(m.provider).toBe('ark');
  });

  // 2026-09-16 真机:某账号的 /models 只回 flash 与 pro,而表里当时没有 flash →
  // 它带着兜底 32768/4096 和 ⚠️ 出现。数字从官方价格页补上(那一页 flash/pro 共用
  // 1M / 384K),这样它一露面就是已确认的。
  it('deepseek-flash 已收录 —— 1M / 384K,而不是兜底值', () => {
    const m = getModelMeta('deepseek', 'deepseek-flash');
    expect(m.contextWindow).toBe(1_024_000);
    expect(m.maxOutput).toBe(384_000);
    expect(m.verified).toBe(true);
  });

  // 查表按模型名、与 provider 无关(getModelMeta 的既定约定),所以同名模型换个端点
  // 也会命中同一条。这里把它钉住:deepseek 直连查出 pro 时,数字必须还是对的。
  it('deepseek-v4-pro 从 deepseek 端点查也拿到对的值', () => {
    const m = getModelMeta('deepseek', 'deepseek-v4-pro');
    expect(m.contextWindow).toBe(1_024_000);
    expect(m.maxOutput).toBe(384_000);
  });

  it('同一模型名换 provider 查,数值不变(上下文是模型的属性,不是 provider 的)', () => {
    expect(getModelMeta('custom', 'kimi-k3').contextWindow).toBe(1_024_000);
  });

  it('未收录的模型 → 保守默认值 + verified:false(UI 标 ⚠️ 待确认)', () => {
    const m = getModelMeta('custom', 'some-unknown-model');
    expect(m.verified).toBe(false);
    expect(m.provider).toBe('custom');
    expect(m.model).toBe('some-unknown-model');
    expect(m.contextWindow).toBeGreaterThan(0);
    expect(m.maxOutput).toBeGreaterThan(0);
    // 输出预算不可能比整个上下文还大 —— 兜底值也必须自洽
    expect(m.maxOutput).toBeLessThanOrEqual(m.contextWindow);
    expect(m.note).toBeTruthy();
  });

  // 用 <= 而不是 <:doubao 系(doubao-seed-2.1-turbo 256K/256K)本来就"输出与输入同量级",
  // 相等是合法的。这条断言要拦的是**倒挂**(给 128K 上下文配 256K 输出)这种笔误。
  it('表里每个条目都自洽 —— 防手滑把 maxOutput 写得比 contextWindow 大', () => {
    for (const [key, m] of Object.entries(MODELS)) {
      expect(m.contextWindow, key).toBeGreaterThan(0);
      expect(m.maxOutput, key).toBeGreaterThan(0);
      expect(m.maxOutput, key).toBeLessThanOrEqual(m.contextWindow);
      expect(m.model, key).toBe(key);
      expect(m.verified, key).toBe(true);
    }
  });

  it('listModels 可按 provider 过滤,供设置页下拉用', () => {
    const deepseek = listModels('deepseek');
    // 3 条 = chat / reasoner / flash。这是**兜底列表**(拉不到厂商列表时用),
    // 所以它该有点东西,但不该被当成"你账号有哪些模型"的答案 —— 那个只有 /models 知道。
    expect(deepseek).toHaveLength(3);
    expect(deepseek.every((m) => m.provider === 'deepseek')).toBe(true);
    expect(listModels()).toHaveLength(Object.keys(MODELS).length);
  });
});
