import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { ModelConfig } from './provider.js';

/**
 * 这里刻意**不 mock `ai` 本身**,只 mock provider 工厂(返回一个假 model)。
 *
 * 为什么:先前把 `ai` 整个 mock 掉,于是我们传了 v7 已经不接受的
 * `role:'system'` 进 `messages`,而测试全绿 —— 真机上第一次调用就炸
 * `InvalidPromptError: System messages are not allowed...`。
 * 现在 SDK 是真的,只有"模型"是假的,参数校验因此真的会跑。
 *
 * generateText 用 spy 包住**真实现**(不是替换),这样既能验参数
 * 又保留校验。
 */
const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  createDeepSeek: vi.fn(),
  createOpenAICompatible: vi.fn(),
}));

vi.mock('ai', async (orig) => {
  const actual = await orig<typeof import('ai')>();
  mocks.generateText.mockImplementation(actual.generateText as never);
  return { ...actual, generateText: mocks.generateText };
});
vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek: mocks.createDeepSeek }));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

const { complete } = await import('./provider.js');

/** v7 的 finishReason / usage 是结构化对象,不是裸字符串(运行时宽松,类型不宽松) */
const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
const STOP = { unified: 'stop' as const, raw: 'stop' };

/** 假的「模型」:记录收到的调用,回一段固定文本 */
function fakeModel() {
  return new MockLanguageModelV3({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: '结果' }],
      finishReason: STOP,
      usage: USAGE,
      warnings: [],
    }),
  });
}

const deepseekCfg: ModelConfig = {
  id: '云端 DeepSeek',
  provider: 'deepseek',
  baseUrl: '',
  apiKey: 'sk-test',
  model: 'deepseek-flash',
};
const ollamaCfg: ModelConfig = {
  id: '本地 14b',
  provider: 'ollama',
  baseUrl: '',
  apiKey: '',
  model: 'qwen2.5:14b',
};

let model: MockLanguageModelV3;

beforeEach(() => {
  vi.clearAllMocks();
  model = fakeModel();
  mocks.createDeepSeek.mockReturnValue(() => model);
  mocks.createOpenAICompatible.mockReturnValue(() => model);
});

describe('complete', () => {
  it('返回模型产出的文本', async () => {
    expect(await complete({ config: deepseekCfg, messages: [{ role: 'user', content: '嗨' }] })).toBe(
      '结果',
    );
  });

  // ★ 回归测试:用户真机上第一次调用就撞的那个错误
  it('带 system 消息不抛错 —— v7 不接受 messages 里的 system(spec 真机踩过)', async () => {
    await expect(
      complete({
        config: deepseekCfg,
        messages: [
          { role: 'system', content: '你是整理管家' },
          { role: 'user', content: '嗨' },
        ],
      }),
    ).resolves.toBe('结果');
  });

  it('system 走 instructions,**不留在 messages 里**', async () => {
    await complete({
      config: deepseekCfg,
      messages: [
        { role: 'system', content: '你是整理管家' },
        { role: 'user', content: '嗨' },
      ],
    });

    const opts = mocks.generateText.mock.calls[0]![0] as {
      instructions?: unknown;
      messages: { role: string }[];
    };
    expect(JSON.stringify(opts.instructions)).toContain('你是整理管家');
    expect(opts.messages.every((m) => m.role !== 'system')).toBe(true);
    expect(opts.messages).toHaveLength(1);
  });

  it('system 内容确实抵达了模型(SDK 把它映射进了 provider prompt)', async () => {
    await complete({
      config: deepseekCfg,
      messages: [
        { role: 'system', content: '你是整理管家' },
        { role: 'user', content: '嗨' },
      ],
    });
    const prompt = model.doGenerateCalls[0]!.prompt;
    expect(JSON.stringify(prompt)).toContain('你是整理管家');
  });

  it('多条 system 按顺序都带上', async () => {
    await complete({
      config: deepseekCfg,
      messages: [
        { role: 'system', content: '第一条指令' },
        { role: 'system', content: '第二条指令' },
        { role: 'user', content: '嗨' },
      ],
    });
    const sent = JSON.stringify(mocks.generateText.mock.calls[0]![0]);
    expect(sent).toContain('第一条指令');
    expect(sent).toContain('第二条指令');
    // 顺序不能反 —— 后一条指令通常是更具体的覆盖
    expect(sent.indexOf('第一条指令')).toBeLessThan(sent.indexOf('第二条指令'));
  });

  it('没有 system 时不传 instructions(别塞个空数组)', async () => {
    await complete({ config: deepseekCfg, messages: [{ role: 'user', content: '嗨' }] });
    expect(mocks.generateText.mock.calls[0]![0]).not.toHaveProperty('instructions');
  });

  // ★ 用户点「停止」时,信号必须真的到 SDK —— 否则 provider 照旧把 token 生成完,
  // 用户看到"停了",账单和上游还在跑
  it('complete 把 abortSignal 透传给 generateText(用户点停止时 SDK 能中断)', async () => {
    const controller = new AbortController();
    await complete({
      config: deepseekCfg,
      messages: [{ role: 'user', content: 'hi' }],
      abortSignal: controller.signal,
    });
    // mock 出来的 generateText 被调时,abortSignal 必须原样在参数里
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal }),
    );
  });

  it('不传 abortSignal 时也不炸(可选参数)', async () => {
    await expect(
      complete({ config: deepseekCfg, messages: [{ role: 'user', content: 'hi' }] }),
    ).resolves.toBeDefined();
    // 不传时这个键**整个不出现**,而不是塞个 undefined 进去
    const args = mocks.generateText.mock.calls[0]![0] as { abortSignal?: unknown };
    expect(args.abortSignal).toBeUndefined();
  });

  it('thinking=false → providerOptions 里关了思考', async () => {
    mocks.createDeepSeek.mockReturnValue(() => fakeModel());
    await complete({
      config: deepseekCfg,
      messages: [{ role: 'user', content: '嗨' }],
      thinking: false,
    });
    const arg = mocks.generateText.mock.calls.at(-1)![0] as { providerOptions?: unknown };
    expect(JSON.stringify(arg.providerOptions)).toContain('disabled');
  });

  it('不传 thinking → providerOptions 里没有这个字段(请求形状不变)', async () => {
    mocks.createDeepSeek.mockReturnValue(() => fakeModel());
    await complete({ config: deepseekCfg, messages: [{ role: 'user', content: '嗨' }] });
    const arg = mocks.generateText.mock.calls.at(-1)![0] as { providerOptions?: unknown };
    expect(JSON.stringify(arg.providerOptions ?? {})).not.toContain('thinking');
  });

  // ★ 回归测试:本地 4b 挂起(OOM/卡死/网络黑洞)时 `generateText` 永不 resolve,
  //   整轮标注卡死、`running` 永久 true、用户停止不生效 —— 用户报的那一串症状。
  //   timeoutMs 必须在挂起时抛"超时"(不是伪装成用户中止的 AbortError)
  it('模型挂起时 timeoutMs 抛"超时"错误(不装成用户中止)', async () => {
    const hung = new MockLanguageModelV3({
      // 永不 resolve —— 模拟 4b 卡死
      doGenerate: () => new Promise(() => {}),
    });
    mocks.createOpenAICompatible.mockReturnValue(() => hung);

    await expect(
      complete({
        config: ollamaCfg,
        messages: [{ role: 'user', content: 'x' }],
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/超时/);
  });

  it('正常生成不受 timeoutMs 影响(超时只在挂起时触发)', async () => {
    await expect(
      complete({
        config: deepseekCfg,
        messages: [{ role: 'user', content: '嗨' }],
        timeoutMs: 5_000,
      }),
    ).resolves.toBe('结果');
  });

  it('不传 timeoutMs 就没有超时(请求形状不变)', async () => {
    await complete({ config: deepseekCfg, messages: [{ role: 'user', content: '嗨' }] });
    const arg = mocks.generateText.mock.calls[0]![0] as { abortSignal?: unknown };
    // 没有超时 controller 注入的 abortSignal —— 只有用户传来的才算数
    expect(arg.abortSignal).toBeUndefined();
  });
});

describe('provider 选择', () => {
  it('deepseek 走官方包(带 apiKey)', async () => {
    await complete({ config: deepseekCfg, messages: [{ role: 'user', content: 'x' }] });
    expect(mocks.createDeepSeek).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-test' }));
    expect(mocks.createOpenAICompatible).not.toHaveBeenCalled();
  });

  it('把模型名交给了模型工厂', async () => {
    await complete({ config: deepseekCfg, messages: [{ role: 'user', content: 'x' }] });
    const factory = mocks.createDeepSeek.mock.results[0]!.value as (m: string) => unknown;
    expect(factory).toBeInstanceOf(Function);
    expect(model.modelId).toBeDefined();
  });

  it('ollama 走 OpenAI 兼容 —— 本地模型不需要单独的包', async () => {
    await complete({ config: ollamaCfg, messages: [{ role: 'user', content: 'x' }] });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ollama', baseURL: 'http://127.0.0.1:11434/v1' }),
    );
    expect(mocks.createDeepSeek).not.toHaveBeenCalled();
  });

  it('没填 baseUrl 时套用 provider 默认地址', async () => {
    await complete({
      config: { ...deepseekCfg, provider: 'ark', model: 'kimi-k3' },
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://ark.cn-beijing.volces.com/api/v3' }),
    );
  });

  it('填了 baseUrl 就用填的,不被默认值覆盖', async () => {
    await complete({
      config: { ...ollamaCfg, baseUrl: 'http://192.168.1.9:11434/v1' },
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://192.168.1.9:11434/v1' }),
    );
  });

  it('没配 apiKey 时给个占位符,不传空串', async () => {
    await complete({ config: ollamaCfg, messages: [{ role: 'user', content: 'x' }] });
    expect(mocks.createOpenAICompatible.mock.calls[0]![0].apiKey).toBeTruthy();
  });

  // 自动填充踩过的坑:baseUrl 被浏览器填成用户名
  it('非法 baseUrl 报一句能照着修的话', async () => {
    await expect(
      complete({ config: { ...ollamaCfg, baseUrl: 'huangchunhua' }, messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/接口地址看起来不对/);
  });
});
