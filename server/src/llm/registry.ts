/**
 * 模型注册表(spec §3)。
 *
 * 只在**一张表**里描述所有 provider —— 不写 per-provider 适配器。
 * 调用协议全走 OpenAI 兼容 / Anthropic 兼容,provider 的差别只体现在
 * baseUrl / apiKey / 模型名,以及下面这些上下文数字上。
 *
 * 数据来源:官 = 官方文档;测 = 第三方实测;估 = 估算。
 * `verified:false` 的一律在 UI 标 ⚠️ 待确认 —— 数字不准只会让批次变小,不会出错,
 * 但用户得知道这个数不是实测来的。
 */
export type ModelProvider =
  | 'ollama'
  | 'ark'
  | 'deepseek'
  | 'minimax'
  | 'anthropic-compatible'
  | 'custom';

export interface ModelMeta {
  provider: ModelProvider;
  /** 调用时填的模型名 */
  model: string;
  /** 输入上下文(token) */
  contextWindow: number;
  /** 最大输出(token) */
  maxOutput: number;
  /** false = 默认值/估算,UI 显眼标 ⚠️ 待确认 */
  verified: boolean;
  note?: string;
}

/** 未收录模型的兜底 —— 保守到任何模型都能跑,代价只是批次小 */
const FALLBACK: Omit<ModelMeta, 'provider' | 'model'> = {
  contextWindow: 32_768,
  maxOutput: 4_096,
  verified: false,
  note: '未收录 —— 用的保守默认值,批次会偏小但不影响正确性',
};

/**
 * 模型表。key 就是模型名(也是 ModelMeta.model)。
 *
 * **本地 Ollama 模型刻意不入表** —— 运行时调 `/api/show` 拿真实的
 * `context_length`,自动 verified:true(spec §3)。
 */
export const MODELS: Record<string, ModelMeta> = {
  // ── 火山方舟 Coding Plan ─────────────────────────
  'ark-code-latest': {
    provider: 'ark',
    model: 'ark-code-latest',
    contextWindow: 256_000,
    maxOutput: 32_000,
    verified: true,
    note: '实际模型由控制台选定',
  },
  'claude-sonnet-4.5': {
    provider: 'ark',
    model: 'claude-sonnet-4.5',
    contextWindow: 200_000,
    maxOutput: 64_000,
    verified: true,
    note: '1M 需 Beta',
  },
  'claude-opus-4.1': {
    provider: 'ark',
    model: 'claude-opus-4.1',
    contextWindow: 200_000,
    maxOutput: 64_000,
    verified: true,
  },

  // ── 火山方舟通用 ─────────────────────────────────
  'doubao-seed-evolving': {
    provider: 'ark',
    model: 'doubao-seed-evolving',
    contextWindow: 1_024_000,
    maxOutput: 256_000,
    verified: true,
    note: '输出与输入同量级',
  },
  'doubao-seed-2.1-turbo': {
    provider: 'ark',
    model: 'doubao-seed-2.1-turbo',
    contextWindow: 256_000,
    maxOutput: 256_000,
    verified: true,
  },
  'doubao-seed-2.0-lite': {
    provider: 'ark',
    model: 'doubao-seed-2.0-lite',
    contextWindow: 256_000,
    maxOutput: 128_000,
    verified: true,
  },
  'minimax-m3': {
    provider: 'ark',
    model: 'minimax-m3',
    contextWindow: 1_024_000,
    maxOutput: 128_000,
    verified: true,
    note: '方舟端限 128K(M3 原生更大)',
  },
  'glm-5.3': {
    provider: 'ark',
    model: 'glm-5.3',
    contextWindow: 1_024_000,
    maxOutput: 128_000,
    verified: true,
  },
  'glm-5.3-flash': {
    provider: 'ark',
    model: 'glm-5.3-flash',
    contextWindow: 1_024_000,
    maxOutput: 128_000,
    verified: true,
  },
  // 2026-09-18:方舟段原来还收着 `deepseek-v4-flash`,已删 —— 官方文档脚注写明它
  // **已退役**,请求由 DeepSeek-V4.1-Flash 服务、按 Flash 价计费。留着等于让「模型管理」
  // 的下拉能选到一个已下架的名字。详见下面「DeepSeek 普通 API」那段。
  'deepseek-v4-pro': {
    provider: 'ark',
    model: 'deepseek-v4-pro',
    contextWindow: 1_024_000,
    maxOutput: 384_000,
    verified: true,
    // 同名的模型换个端点查也会命中这一条(查表按模型名,与 provider 无关,见 getModelMeta)。
    // 数字对得上:官方价格页给 flash / pro 的是同一组 1M / 384K。
    note: 'DeepSeek-V4-Pro-0813',
  },
  'kimi-k2.7-code': {
    provider: 'ark',
    model: 'kimi-k2.7-code',
    contextWindow: 256_000,
    maxOutput: 32_000,
    verified: true,
    note: 'K2.7 ≠ K3',
  },
  'kimi-k3': {
    provider: 'ark',
    model: 'kimi-k3',
    contextWindow: 1_024_000,
    maxOutput: 128_000,
    verified: true,
  },

  // ── DeepSeek 普通 API ────────────────────────────
  //
  // **这张表不跟账号走。** key 实际服务哪些模型只有厂商知道,以「模型管理」里点「刷新」
  // 拉回来的为准。
  //
  // 2026-09-18:官方模型表**只剩两个模型** —— `deepseek-flash`(V4.1-Flash)与
  // `deepseek-v4-pro`(V4-Pro-0813)。这一段原来还有 chat / reasoner 两条兜底,已删:
  // 官方表里不再列它们,而留着等于让「模型管理」的下拉能选到已下架的模型。
  // (pro 记在**方舟段** —— getModelMeta 按模型名查、与 provider 无关,所以 deepseek 直连
  // 拉到 pro 也命中同一条,数字照样对。见 registry.test.ts 那条测试。)
  //
  // 数字来源:官方价格页。那一页 flash / pro 两行是 `colspan=2` —— 两个模型**共用**
  // 1M 上下文 / 384K 输出。
  'deepseek-flash': {
    provider: 'deepseek',
    model: 'deepseek-flash',
    contextWindow: 1_024_000,
    maxOutput: 384_000,
    verified: true,
    note: 'DeepSeek-V4.1-Flash',
  },

  // ── MiniMax 直连 ─────────────────────────────────
  'MiniMax-M2.7': {
    provider: 'minimax',
    model: 'MiniMax-M2.7',
    contextWindow: 204_800,
    maxOutput: 8_192,
    verified: true,
    note: '输出为估算值',
  },
};

/**
 * 查模型元数据。
 *
 * 按**模型名**查 —— 上下文窗口是模型的属性,不是 provider 的,所以同一个模型
 * 换个 baseUrl 接进来也拿同一组数字。查不到就返回保守兜底(verified:false)。
 */
export function getModelMeta(provider: string, model: string): ModelMeta {
  return MODELS[model] ?? { ...FALLBACK, provider: provider as ModelProvider, model };
}

/** 列模型 —— 设置页的模型下拉用;不传 provider 则全列 */
export function listModels(provider?: string): ModelMeta[] {
  const all = Object.values(MODELS);
  return provider ? all.filter((m) => m.provider === provider) : all;
}
