import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { readLlmSettings, saveLlmSettings, isPurposeConfigured, LLM_KEYS } from './config.js';

const fresh = () => {
  const db = openDb(':memory:');
  saveLlmSettings(db, { provider: 'ollama', model: 'qwen2.5:14b', baseUrl: '', apiKey: '' });
  return db;
};

const set = (db: ReturnType<typeof openDb>, key: string, v: string) =>
  db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, v);

describe('LLM 配置读写', () => {
  it('配过能读回来,apiKey 加解密一通', () => {
    const db = fresh();
    saveLlmSettings(db, { provider: 'deepseek', model: 'deepseek-chat', baseUrl: '', apiKey: 'sk-x-12345678' });
    const s = readLlmSettings(db)!;
    expect(s.config.provider).toBe('deepseek');
    expect(s.config.apiKey).toBe('sk-x-12345678');
  });

  it('没配过返回 null', () => {
    expect(readLlmSettings(openDb(':memory:'))).toBeNull();
  });

  it('apiKey 留 undefined = 不改动已存的', () => {
    const db = fresh();
    saveLlmSettings(db, { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-keep-me-1234' });
    saveLlmSettings(db, { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'http://x/v1' });
    expect(readLlmSettings(db)!.config.apiKey).toBe('sk-keep-me-1234');
  });

  it('apiKey 传空串 = 清空', () => {
    const db = fresh();
    saveLlmSettings(db, { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-drop-me-1234' });
    saveLlmSettings(db, { provider: 'deepseek', model: 'deepseek-chat', apiKey: '' });
    expect(readLlmSettings(db)!.config.apiKey).toBe('');
  });

  it('上下文/输出为 0 拒绝保存', () => {
    const db = fresh();
    expect(() => saveLlmSettings(db, { provider: 'ollama', model: 'x', contextWindow: 0 })).toThrow();
    expect(() => saveLlmSettings(db, { provider: 'ollama', model: 'x', maxOutput: 0 })).toThrow();
  });

  // 输入和输出共享窗口 —— 相等就等于输入预算为 0,而后果是静默的
  it('最大输出等于上下文也拒绝(不是只有大于才拒)', () => {
    const db = fresh();
    expect(() => saveLlmSettings(db, { provider: 'ollama', model: 'x', contextWindow: 8192, maxOutput: 8192 })).toThrow(
      /小于上下文/,
    );
  });

  it('最大输出大于上下文拒绝', () => {
    const db = fresh();
    expect(() => saveLlmSettings(db, { provider: 'ollama', model: 'x', contextWindow: 8000, maxOutput: 99000 })).toThrow();
  });

  it('非法 baseUrl 拒绝保存', () => {
    const db = fresh();
    expect(() => saveLlmSettings(db, { provider: 'ollama', model: 'x', baseUrl: 'huangchunhua' })).toThrow(
      /接口地址看起来不对/,
    );
  });

  // 老版本存下的坏组合不能让聊天静默失去上下文
  it('读到 maxOutput ≥ contextWindow 的坏数据时退回默认值,输入预算保持为正', () => {
    const db = fresh();
    set(db, LLM_KEYS.contextWindow, '32768');
    set(db, LLM_KEYS.maxOutput, '32768');
    const s = readLlmSettings(db)!;
    expect(s.ctx.maxOutput).toBeLessThan(s.ctx.contextWindow);
    expect(s.ctx.contextWindow - s.ctx.maxOutput - 1500).toBeGreaterThan(0);
    expect(s.ctx.verified).toBe(false); // 退回默认值了,该标 ⚠️
  });

  it('正常的手填值仍然生效', () => {
    const db = fresh();
    set(db, LLM_KEYS.contextWindow, '32768');
    set(db, LLM_KEYS.maxOutput, '8192');
    const s = readLlmSettings(db)!;
    expect(s.ctx.contextWindow).toBe(32768);
    expect(s.ctx.maxOutput).toBe(8192);
    expect(s.ctx.verified).toBe(true);
  });
});

// ── 用途分组(§3:不同功能可以用不同的模型)──────────────

describe('打标模型(tag 用途)', () => {
  it('没配打标模型 → 读到的是主模型(底层共享)', () => {
    const db = fresh();
    saveLlmSettings(db, { provider: 'deepseek', model: 'deepseek-flash', baseUrl: '', apiKey: 'sk-main' });

    const s = readLlmSettings(db, 'tag');
    expect(s).not.toBeNull();
    expect(s!.config.model).toBe('deepseek-flash');
    expect(s!.config.apiKey).toBe('sk-main');
  });

  it('配了打标模型 → 用它自己的;没填的 key/baseUrl 逐项沿用主模型', () => {
    const db = fresh();
    saveLlmSettings(db, { provider: 'deepseek', model: 'deepseek-flash', baseUrl: '', apiKey: 'sk-main' });
    // 打标只换模型名和厂商 —— key/baseUrl 故意留空,就是"沿用主模型"的常见形态
    saveLlmSettings(db, { provider: 'ollama', model: 'qwen3-4b-instruct-2507:latest' }, 'tag');

    const s = readLlmSettings(db, 'tag')!;
    expect(s.config.provider).toBe('ollama');
    expect(s.config.model).toBe('qwen3-4b-instruct-2507:latest');
    // key 从主模型沿用(解密后的明文)—— 否则本地模型不用 key,云端打标反而没凭证
    expect(s.config.apiKey).toBe('sk-main');
    // 主模型不动
    expect(readLlmSettings(db)!.config.model).toBe('deepseek-flash');
  });

  it('主模型没配、打标模型配了 → tag 能读到,main 返回 null', () => {
    // **不能用 fresh()** —— 它预置了主模型,这个用例要的恰恰是"主模型不存在"
    const db = openDb(':memory:');
    saveLlmSettings(db, { provider: 'ollama', model: 'qwen3-4b-instruct-2507:latest' }, 'tag');

    expect(readLlmSettings(db)).toBeNull();
    expect(readLlmSettings(db, 'tag')!.config.model).toBe('qwen3-4b-instruct-2507:latest');
  });

  it('打标模型只配了一半(有 provider 没 model)→ 视为没配,整体回落主模型', () => {
    const db = fresh();
    saveLlmSettings(db, { provider: 'deepseek', model: 'deepseek-flash', baseUrl: '', apiKey: 'sk-main' });
    set(db, 'tag.provider', 'ollama'); // 只写一个键,模拟半截配置

    expect(readLlmSettings(db, 'tag')!.config.model).toBe('deepseek-flash');
  });

  // ★ 这个判据是**给 UI 回填用的**:readLlmSettings 的逐项回落让"这张卡配过没有"
  //   从外面看不出来 —— 实测的坑就是打标卡拿回落值回填,把主模型的 baseUrl
  //   冒充成打标模型的,用户改选 ollama 后本地模型列表直接空掉。
  it('isPurposeConfigured:主模型配了、打标没配 → tag 必须是 false(哪怕 readLlmSettings 非 null)', () => {
    const db = fresh(); // fresh() 预置了主模型 ollama/qwen2.5:14b

    expect(readLlmSettings(db, 'tag')).not.toBeNull(); // 回落让"配过没有"看不出来
    expect(isPurposeConfigured(db, 'main')).toBe(true);
    expect(isPurposeConfigured(db, 'tag')).toBe(false);
  });

  it('isPurposeConfigured:半截配置(只有 provider)不算配过,两个键都在才算', () => {
    const db = fresh();
    set(db, 'tag.provider', 'ollama');
    expect(isPurposeConfigured(db, 'tag')).toBe(false);

    set(db, 'tag.model', 'qwen3-4b-instruct-2507:latest');
    expect(isPurposeConfigured(db, 'tag')).toBe(true);
  });

  it('isPurposeConfigured:空串不算配过(与 readLlmSettings 的取键口径一致)', () => {
    const db = fresh();
    set(db, 'tag.provider', 'ollama');
    set(db, 'tag.model', '');
    expect(isPurposeConfigured(db, 'tag')).toBe(false);
  });

  it('保存打标模型不动主模型的任何键', () => {
    const db = fresh();
    saveLlmSettings(db, { provider: 'deepseek', model: 'deepseek-flash', baseUrl: '', apiKey: 'sk-main', contextWindow: 1000, maxOutput: 500 });
    saveLlmSettings(db, { provider: 'ollama', model: 'qwen3-4b-instruct-2507:latest' }, 'tag');

    const main = readLlmSettings(db)!;
    expect(main.config.model).toBe('deepseek-flash');
    expect(main.ctx.contextWindow).toBe(1000);
    expect(main.config.apiKey).toBe('sk-main');
  });
});
