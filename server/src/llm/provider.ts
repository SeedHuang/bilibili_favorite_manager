/**
 * LLM 的唯一出口(spec §3)。
 *
 * **所有**对模型的调用都走这里 —— 业务代码不许直接 import `ai`。
 * 这样换模型/换 provider 是改配置,不是改业务。
 *
 * 协议只用两种:DeepSeek 官方包,和 OpenAI 兼容(覆盖 Ollama / 方舟 / MiniMax / 自定义)。
 * 不写 per-provider 适配器(spec §3)。
 */
import { generateText, streamText } from 'ai';
import type { ModelMessage, SystemModelMessage } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ChatMessage } from './context.js';
import { registerSecret } from '../logger/redact.js';

export interface ModelConfig {
  /** 显示名 —— 只为 UI/日志可读 */
  id: string;
  /**
   * 用户选的服务商。**显式带上,不从模型名反推** ——
   * 自定义 baseUrl 接一个和方舟同名的模型时,反推会选错协议。
   */
  provider: string;
  /** 留空则用该 provider 的默认地址 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 常用 provider 的默认地址 —— 省得用户在设置页手抄一遍 */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: 'http://127.0.0.1:11434/v1',
  ark: 'https://ark.cn-beijing.volces.com/api/v3',
  deepseek: 'https://api.deepseek.com/v1',
  minimax: 'https://api.minimaxi.com/v1',
};

/** Ollama 不校验 key,但也不接受空字符串 */
const NO_KEY = 'not-needed';

/**
 * 校验接口地址,并把「留空」原样放行(调用方自己套默认值)。
 *
 * 为什么要在**这一层**拦:baseUrl 是不可信输入(用户手填 / 浏览器自动填充),
 * 而 `fetch('huangchunhua/api/tags')` 抛出来的是一句
 * `Failed to parse URL from huangchunhua/api/tags` —— 用户看到这个完全不知道
 * 该去改哪儿。这里换成一句能照着修的话。
 */
export function assertUsableBaseUrl(baseUrl: string): string {
  const v = baseUrl.trim();
  if (!v) return v; // 留空 = 用该 provider 的默认地址
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' || u.protocol === 'https:') return v;
  } catch {
    // 落到下面统一报错
  }
  throw new Error(
    `接口地址看起来不对:「${v}」—— 要写成 http://主机:端口 的形式,或者直接留空用默认地址`,
  );
}

/**
 * 按 config 造一个 AI SDK 的 LanguageModel。
 *
 * DeepSeek 用官方包(spec §3 拍板);其余一律走 OpenAI 兼容 ——
 * Ollama 的 `/v1` 端点就是 OpenAI 兼容的,所以本地模型不需要单独的包。
 */
function languageModel(config: ModelConfig) {
  // 每次用 key 之前登记它 —— 之后即使上游把 key 回显进错误信息,
  // 日志入口也能按值抹掉(C9:脱敏在唯一入口做,业务代码没有漏的机会)
  registerSecret(config.apiKey);

  const baseUrl = assertUsableBaseUrl(config.baseUrl) || DEFAULT_BASE_URLS[config.provider] || '';

  if (config.provider === 'deepseek') {
    return createDeepSeek({
      apiKey: config.apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    })(config.model);
  }

  return createOpenAICompatible({
    name: config.provider,
    baseURL: baseUrl,
    apiKey: config.apiKey || NO_KEY,
  })(config.model);
}

/**
 * 把我们的 ChatMessage 拆成 AI SDK 7 要的形状。
 *
 * **v7 的 `messages` 里不允许出现 `role:'system'`**(`allowSystemInMessages` 默认
 * false),传了会抛 `InvalidPromptError: System messages are not allowed in the
 * prompt or messages fields`。system 必须走 `instructions`。
 *
 * 这是 v6 → v7 的破坏性变更,而且**只有真跑 SDK 才会暴露** ——
 * 把 `ai` 整个 mock 掉的测试永远发现不了(踩过一次,已改成用 mock model)。
 */
function splitPrompt(messages: ChatMessage[]): {
  instructions: SystemModelMessage[] | undefined;
  rest: ModelMessage[];
} {
  const instructions: SystemModelMessage[] = [];
  const rest: ModelMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') instructions.push({ role: 'system', content: m.content });
    else rest.push({ role: m.role, content: m.content });
  }

  return { instructions: instructions.length ? instructions : undefined, rest };
}

/**
 * 一次性拿完整输出(分类批处理用)。
 * system prompt 就走 messages 里的 role:'system' —— 只留一条通道,
 * 免得"有的在参数里、有的在数组里"两处都能出错。
 */
export async function complete(opts: {
  config: ModelConfig;
  messages: ChatMessage[];
  /** 调用方断开(用户点了停止)时中断生成 —— §9D B2。不传 = 不可中断(和旧行为一致) */
  abortSignal?: AbortSignal;
  /**
   * 要不要走思考模式。**缺省 = 不传**,交给厂商默认(聊天要它,下面 §9D.5 的思考流靠它)。
   *
   * 批量调用必须传 `false`:标注/归类/质检要的是"照格式吐 JSON",不是"想清楚" ——
   * 每批吐一长串推理,输出 token 涨数倍、整体变慢(spec §3 末)。
   */
  thinking?: boolean;
  /**
   * 单次模型调用的超时(ms)。**没有这个,本地 4b 挂起(OOM/卡死/网络黑洞)时
   * `generateText` 永不 resolve** —— 整轮标注卡死、`running` 永久 true、
   * 用户点停止 abort 不生效(用户报的正是这一串)。超时触发 = 抛错,调用方把
   * 这批记失败继续,而不是卡死整轮。只给批量路径传,聊天不传(聊到一半被砍
   * 是打断,不是超时)。
   */
  timeoutMs?: number;
}): Promise<string> {
  const { instructions, rest } = splitPrompt(opts.messages);
  // 超时与用户中止**合成一个 signal**:AI SDK 只认一个 abortSignal。超时 abort 时
  // 抛的错和用户中止一样是 AbortError,但调用方靠**自己的 controller** 分辨 ——
  // 路由的 controller(用户停)没 aborted,所以超时会走"记失败批次"而不是"中止"。
  // 但光靠 abort 不够 —— SDK 的 abort 只在中途检查,`doGenerate` 的 promise 挂起
  // 时不 settle,abort 根本轮不到。所以超时用 `Promise.race` 在**这一层**拦:
  // 到点直接 reject,同时 abort 合成 controller 给 SDK 一个清理的机会。
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;
  let signal = opts.abortSignal;
  if (opts.timeoutMs !== undefined) {
    const c = new AbortController();
    if (opts.abortSignal?.aborted) c.abort();
    else {
      // listener 存下来、finally 里 remove —— 同一轮多个批共享同一个 signal,
      // 不清理的话每批都挂一个监听,一长串跑完就超出 EventTarget 的默认上限
      onCallerAbort = () => c.abort();
      opts.abortSignal?.addEventListener('abort', onCallerAbort);
    }
    timer = setTimeout(() => c.abort(), opts.timeoutMs);
    signal = c.signal;
  }
  try {
    const call = generateText({
      model: languageModel(opts.config),
      ...(instructions ? { instructions } : {}),
      messages: rest,
      // `@ai-sdk/deepseek` 原生认这个键(3.0.44:`providerOptions.deepseek.thinking.type`,
      // 缺省 `enabled`)。**判 undefined,而不是给个默认值** —— 缺省的语义是
      // "这个参数一个字都不出现",聊天那条路的请求因此和加开关之前逐字一致
      ...(opts.thinking === undefined
        ? {}
        : { providerOptions: { deepseek: { thinking: { type: opts.thinking ? 'enabled' : 'disabled' } } } }),
      // **省了这行,用户点停止就只是浏览器断开,provider 照样把 token 生成完** ——
      // "钱花了、结果没人接"。AI SDK 原生接受 signal,透传即可
      ...(signal ? { abortSignal: signal } : {}),
    });
    const { text } = opts.timeoutMs === undefined
      ? await call
      : await Promise.race([
          call,
          // 到点不 resolve → 直接以"超时"收场(不装成用户中止的 AbortError)
          // handle 存下来 finally 里清 —— 正常路径(model 先回)不清的话这个 timer
          // 会一直挂到超时点,空占 Node 的定时器队列
          new Promise<never>((_, reject) => {
            raceTimer = setTimeout(
              () => reject(new Error(`模型调用超时(${opts.timeoutMs}ms)`)),
              opts.timeoutMs,
            );
          }),
        ]);
    return text;
  } finally {
    if (timer) clearTimeout(timer);
    if (raceTimer) clearTimeout(raceTimer);
    if (onCallerAbort) opts.abortSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * 流式产出(聊天窗用)。逐块回调,同时返回全文。
 * 调用方拿全文去落库 —— 流断了也不会存半条。
 */
export async function stream(opts: {
  config: ModelConfig;
  messages: ChatMessage[];
  onChunk: (delta: string) => void;
  /** 思考流(推理型模型才有,§9D.5)。回调参数是本段 reasoning 的增量 */
  onReasoning?: (delta: string) => void;
  /** 同 complete:用户点停止时让 SDK 真的停下来,而不是我们这边不再读流 */
  abortSignal?: AbortSignal;
  /** 同 complete。**聊天不传** —— 要的正是思考流(§9D.5),关掉就没得看了 */
  thinking?: boolean;
}): Promise<string> {
  let streamError: unknown;
  const { instructions, rest } = splitPrompt(opts.messages);
  const result = streamText({
    model: languageModel(opts.config),
    ...(instructions ? { instructions } : {}),
    messages: rest,
    // 同 complete:不传就是厂商默认,不塞空对象
    ...(opts.thinking === undefined
      ? {}
      : { providerOptions: { deepseek: { thinking: { type: opts.thinking ? 'enabled' : 'disabled' } } } }),
    // 不传 signal 的话,我们只是不再读流,上游还在为这条请求烧 token
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    // streamText **不抛错** —— 参数校验失败、上游报错都只进 onError,
    // 然后流"正常结束"。不接住的话,一次失败看起来就是"模型回了空话"
    onError: ({ error }) => {
      streamError = error;
    },
  });

  let full = '';
  // 用 fullStream 而不是 textStream:textStream 只有文本,**推理型模型的思考过程
  // (reasoning-delta)在这里被丢掉** —— 用户看着几分钟空白,以为卡了(§9D.5 实测)。
  // 没有思考的模型不吐这种 part,回调根本不会触发,零成本。
  //
  // **type 谓词收窄不了 reasoning-delta** —— SDK 的公共 fullStream 类型没收录它
  // (运行时确实会发,真模型实测 82 字符),所以按 type 判别的分支里它是 never。
  // 用 in 判据手动收窄,别用 as 硬翻;判据取运行时真实形状(探针验证过),不是类型名。
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      full += part.text;
      opts.onChunk(part.text);
    } else if ('text' in part && (part as { type?: string }).type === 'reasoning-delta') {
      opts.onReasoning?.(part.text);
    }
  }

  if (streamError) throw streamError;
  return full;
}
