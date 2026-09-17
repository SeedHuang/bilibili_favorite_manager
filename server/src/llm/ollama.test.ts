import { describe, it, expect, vi } from 'vitest';
import { listOllamaModels, extractContextLength, ollamaRoot } from './ollama.js';

describe('ollamaRoot', () => {
  it('把 OpenAI 兼容地址还原成原生根地址', () => {
    expect(ollamaRoot('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(ollamaRoot('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434');
  });

  it('没填时用默认地址', () => {
    expect(ollamaRoot('')).toBe('http://127.0.0.1:11434');
  });

  it('本来就是根地址就不动它', () => {
    expect(ollamaRoot('http://192.168.1.9:11434')).toBe('http://192.168.1.9:11434');
  });
});

describe('extractContextLength', () => {
  it('按 general.architecture 找对应的 context_length', () => {
    const show = {
      model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 },
    };
    expect(extractContextLength(show)).toBe(32768);
  });

  it('架构键对不上时退而取任意 *context_length', () => {
    const show = { model_info: { 'llama.context_length': 8192 } };
    expect(extractContextLength(show)).toBe(8192);
  });

  it('拿不到就返回 null —— 不瞎猜一个数', () => {
    expect(extractContextLength({ model_info: {} })).toBeNull();
    expect(extractContextLength({})).toBeNull();
    expect(extractContextLength(null)).toBeNull();
    expect(extractContextLength('nope')).toBeNull();
  });

  it('0 和负数当作没拿到', () => {
    expect(extractContextLength({ model_info: { 'qwen2.context_length': 0 } })).toBeNull();
  });
});

describe('listOllamaModels', () => {
  const mkFetch = (tags: unknown, show: unknown, ok = true) =>
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.endsWith('/api/tags') ? tags : show;
      return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
    }) as unknown as typeof fetch;

  it('列出模型并带上真实上下文长度', async () => {
    const f = mkFetch(
      { models: [{ name: 'qwen2.5:14b' }] },
      {
        model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 },
        details: { parameter_size: '14.8B', quantization_level: 'Q4_K_M' },
      },
    );
    const list = await listOllamaModels('http://127.0.0.1:11434/v1', f);

    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('qwen2.5:14b');
    expect(list[0]!.contextWindow).toBe(32768);
    expect(list[0]!.detail).toContain('Q4_K_M');
  });

  // 真机踩的坑:maxOutput 一开始被我设成 contextWindow,于是
  // budget = contextWindow - maxOutput - 1500 变成负数 →
  // 聊天上下文被裁到只剩最后一条,compact 每轮空烧一次
  it('给输出留份额,不把整个窗口都算成输出', async () => {
    const f = mkFetch(
      { models: [{ name: 'qwen2.5:14b' }] },
      { model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 } },
    );
    const m = (await listOllamaModels('', f))[0]!;
    expect(m.maxOutput).toBeLessThan(m.contextWindow);
    // 输入预算必须为正 —— 这是"聊天还能记得上一轮"的前提
    expect(m.contextWindow - m.maxOutput - 1500).toBeGreaterThan(0);
    // 且仍要能撑住 spec §3 说的"本地 14b ≈ 120 条/批"
    expect(Math.floor((m.contextWindow - 1500) / 250)).toBeGreaterThanOrEqual(100);
  });

  it('查不到上下文长度的模型不进列表 —— 宁缺勿错', async () => {
    const f = mkFetch({ models: [{ name: 'mystery:latest' }] }, { model_info: {} });
    expect(await listOllamaModels('', f)).toEqual([]);
  });

  it('单个模型查询抛错不影响其它模型', async () => {
    let call = 0;
    const f = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: [{ name: 'a' }, { name: 'b' }] }) } as Response;
      }
      call++;
      if (call === 1) throw new Error('boom');
      return {
        ok: true,
        status: 200,
        json: async () => ({ model_info: { 'x.context_length': 4096 } }),
      } as Response;
    }) as unknown as typeof fetch;

    const list = await listOllamaModels('', f);
    expect(list.map((m) => m.name)).toEqual(['b']);
  });

  it('Ollama 没在跑 → 抛错,而不是静默返回空列表', async () => {
    const f = mkFetch({}, {}, false);
    await expect(listOllamaModels('', f)).rejects.toThrow(/Ollama/);
  });

  it('用的是原生根地址,不是 /v1 那个 OpenAI 兼容前缀', async () => {
    const f = mkFetch({ models: [] }, {});
    await listOllamaModels('http://127.0.0.1:11434/v1', f);
    expect(String((f as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0])).toBe(
      'http://127.0.0.1:11434/api/tags',
    );
  });
});

// 真实踩到的坑:浏览器自动填充把用户名塞进了「接口地址」框,
// 于是 fetch('huangchunhua/api/tags') 抛出 "Failed to parse URL from ..." ——
// 用户看到那句话完全不知道该改哪儿。要在这一层换成能照着修的提示。
describe('非法接口地址', () => {
  it('不是 URL 的值报一句能照着修的话,而不是 Failed to parse URL', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    await expect(listOllamaModels('huangchunhua', f)).rejects.toThrow(/接口地址看起来不对/);
    expect(f).not.toHaveBeenCalled();
  });

  it('报错里带上原值,用户知道该删什么', async () => {
    await expect(listOllamaModels('huangchunhua')).rejects.toThrow(/huangchunhua/);
  });

  it('只有协议没主机也拦掉', async () => {
    expect(() => ollamaRoot('http://')).toThrow();
  });

  it('合法的地址照常放行', () => {
    expect(ollamaRoot('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(ollamaRoot('https://ollama.example.com/v1')).toBe('https://ollama.example.com');
  });
});
