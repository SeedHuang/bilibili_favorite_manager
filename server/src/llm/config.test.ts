import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import {
  listProviders, saveProvider, deleteProvider,
  listEntries, addEntry, deleteEntry,
  getAssignments, setAssignment,
  readLlmSettings, seedLlm, PURPOSES,
} from './config.js';

const fresh = () => openDb(':memory:');

const setRaw = (db: ReturnType<typeof openDb>, key: string, v: string) =>
  db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, v);

describe('凭证层', () => {
  it('保存→列出,apiKey 加密落库', () => {
    const db = fresh();
    const p = saveProvider(db, { provider: 'deepseek', baseUrl: '', apiKey: 'sk-x-12345678' });
    expect(p.id).toBeTruthy();
    const list = listProviders(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.provider).toBe('deepseek');
    expect(list[0]!.apiKeyEnc).not.toContain('sk-x-12345678'); // DPAPI 密文
  });

  it('更新:apiKey undefined = 保留已存;空串 = 清空', () => {
    const db = fresh();
    const p = saveProvider(db, { provider: 'deepseek', apiKey: 'sk-keep-me-1234' });
    // 读取走三层(凭证→条目→分配),所以要有一条被用途引用的条目才读得到
    addEntry(db, { providerId: p.id, model: 'deepseek-flash' });
    saveProvider(db, { id: p.id, provider: 'deepseek', baseUrl: 'http://x/v1' });
    expect(readLlmSettings(db, 'rules')!.config.apiKey).toBe('sk-keep-me-1234');
    saveProvider(db, { id: p.id, provider: 'deepseek', apiKey: '' });
    expect(readLlmSettings(db, 'rules')!.config.apiKey).toBe('');
  });

  it('更新:baseUrl undefined = 保留已存;空串 = 清空(与 apiKey 同规矩)', () => {
    const db = fresh();
    // custom 不在 DEFAULT_BASE_URLS 里 —— 端点被冲掉就彻底丢了
    const p = saveProvider(db, { provider: 'custom', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'sk-old-1234' });
    saveProvider(db, { id: p.id, provider: 'custom', apiKey: 'sk-rotated-9999' }); // 只换 key
    expect(listProviders(db)[0]!.baseUrl).toBe('http://127.0.0.1:9999/v1');
    saveProvider(db, { id: p.id, provider: 'custom', baseUrl: '' });
    expect(listProviders(db)[0]!.baseUrl).toBe('');
  });

  it('非法 baseUrl 抛错(沿用 provider.ts 的报错文案)', () => {
    const db = fresh();
    expect(() => saveProvider(db, { provider: 'ollama', baseUrl: 'huangchunhua' })).toThrow(/接口地址看起来不对/);
  });

  it('删除被条目引用的凭证 → throw;无引用可删', () => {
    const db = fresh();
    seedLlm(db);
    const [p] = listProviders(db);
    expect(() => deleteProvider(db, p!.id)).toThrow(/先删/);
    // 条目被用途引用时不让删,先解引用(与「删除被用途引用的条目」同一套规矩)
    for (const purpose of PURPOSES) setAssignment(db, purpose, null);
    deleteEntry(db, listEntries(db)[0]!.id);
    expect(() => deleteProvider(db, p!.id)).not.toThrow();
    expect(listProviders(db)).toHaveLength(0);
  });
});

describe('条目层', () => {
  it('添加条目:用途全空 → 自动全分配', () => {
    const db2 = fresh();
    const p = saveProvider(db2, { provider: 'ollama' });
    const e = addEntry(db2, { providerId: p.id, model: 'qwen2.5:14b' });
    const a = getAssignments(db2);
    for (const purpose of PURPOSES) expect(a[purpose]).toBe(e.id);
  });

  it('已有分配时,新条目不动现有用途', () => {
    const db = fresh();
    seedLlm(db);
    const [first] = listEntries(db);
    const p2 = saveProvider(db, { provider: 'deepseek', apiKey: 'sk-second-1234' });
    const e2 = addEntry(db, { providerId: p2.id, model: 'deepseek-flash' });
    const a = getAssignments(db);
    for (const purpose of PURPOSES) expect(a[purpose]).toBe(first!.id);
    expect(e2.id).not.toBe(first!.id);
  });

  it('删除被用途引用的条目 → throw;改指后可删', () => {
    const db = fresh();
    seedLlm(db);
    const [e] = listEntries(db);
    expect(() => deleteEntry(db, e!.id)).toThrow(/用途/);
    for (const purpose of PURPOSES) setAssignment(db, purpose, null);
    expect(() => deleteEntry(db, e!.id)).not.toThrow();
    expect(listEntries(db)).toHaveLength(0);
  });

  it('setAssignment 指向不存在的条目 → throw', () => {
    const db = fresh();
    expect(() => setAssignment(db, 'rules', 'm_nope')).toThrow();
  });
});

describe('readLlmSettings(三层查找)', () => {
  it('purpose 有分配 → 拼 config + ctx;apiKey 解密;数字来自注册表', () => {
    const db = fresh();
    seedLlm(db, { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-x-12345678' });
    const s = readLlmSettings(db, 'rules')!;
    expect(s.config).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-x-12345678' });
    expect(s.ctx.contextWindow).toBe(1_024_000); // 注册表里的,不是手填
    expect(s.ctx.maxOutput).toBe(384_000);
    expect(s.ctx.verified).toBe(true);
  });

  it('用途没分配 → null;分配指向不存在的条目(脏数据)→ null', () => {
    expect(readLlmSettings(fresh(), 'rules')).toBeNull();
    const db2 = fresh();
    // setAssignment 自己会拦不存在的条目,脏数据只能绕过它直接落库
    setRaw(db2, 'llm.purpose.rules', 'm_gone');
    expect(readLlmSettings(db2, 'rules')).toBeNull();
  });

  it('ollama 条目:llm.ollama.meta 有真实值 → 用它且 verified:true', () => {
    const db = fresh();
    seedLlm(db, { provider: 'ollama', model: 'qwen3-custom:latest' });
    setRaw(db, 'llm.ollama.meta', JSON.stringify({ 'qwen3-custom:latest': { contextWindow: 40_960, maxOutput: 8_192 } }));
    const s = readLlmSettings(db, 'rules')!;
    expect(s.ctx.contextWindow).toBe(40_960);
    expect(s.ctx.verified).toBe(true);
  });

  it('ollama 条目:meta 没有 → 兜底 32K/4K + verified:false', () => {
    const db = fresh();
    seedLlm(db, { provider: 'ollama', model: 'never-seen:latest' });
    const s = readLlmSettings(db, 'rules')!;
    expect(s.ctx.contextWindow).toBe(32_768);
    expect(s.ctx.verified).toBe(false);
  });

  it('seedLlm:铺好凭证+条目+用途分配(测试基建自证)', () => {
    const db = fresh();
    seedLlm(db);
    expect(listProviders(db)).toHaveLength(1);
    expect(listEntries(db)).toHaveLength(1);
    const a = getAssignments(db);
    for (const purpose of PURPOSES) expect(a[purpose]).toBe(listEntries(db)[0]!.id);
  });
});
