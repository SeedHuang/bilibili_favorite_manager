/**
 * Ollama 模型发现(spec §3:本地模型不入注册表,运行时拿真实值)。
 *
 * 为什么不入表:用户装了什么模型、量化到多少、`context_length` 被改成多少,
 * 只有 Ollama 自己知道。手填这些数很容易填错 —— 而填错就意味着
 * batchSize 算错,要么批次过大批到超上下文,要么批次过小跑一整天。
 */
import { assertUsableBaseUrl, DEFAULT_BASE_URLS } from './provider.js';

export interface OllamaModel {
  name: string;
  /** 真实上下文长度(Ollama 按模型报,不是我们猜的) */
  contextWindow: number;
  /** 预留给输出的份额 —— 见 outputBudget() 的说明 */
  maxOutput: number;
  /** 量化档位等,给用户认模型用 */
  detail?: string;
}

/** 单次生成最多写这么多 token 就够了(我们只要 JSON 列表,不要长文) */
const OUTPUT_CEILING = 8_192;
/** 输出最多占上下文窗口的这个比例 */
const OUTPUT_SHARE = 0.25;

/**
 * 给输出留多少。
 *
 * **不能等于 contextWindow** —— 输入和输出是**共享**同一个窗口的,
 * 把 maxOutput 设成整个窗口会让输入预算变成 0:
 *   budget = contextWindow - maxOutput - 1500 = -1500
 * 后果不是"报错"而是两个静默退化:
 *   - trimToContext 只剩最后一条消息 → **聊天彻底没有上下文**
 *   - compact 每轮都以为超预算 → 每轮白烧一次摘要调用
 * (这是我第一版写错的地方,真机上才暴露。)
 *
 * 取窗口的 1/4 并封顶 8192:对 32K 的 14b 正好留 8192,配 60 token/条的输出估算
 * 得到 136 条/批的上限,与输入侧的 125 取小 → 125,对得上 spec §3 的"≈120 条/批"。
 */
function outputBudget(contextWindow: number): number {
  return Math.max(1, Math.min(Math.floor(contextWindow * OUTPUT_SHARE), OUTPUT_CEILING));
}

/** 把 OpenAI 兼容地址(`…/v1`)还原成 Ollama 原生根地址 */
export function ollamaRoot(baseUrl: string): string {
  // 先校验再套默认 —— 非法地址要报"接口地址看起来不对",不是让 fetch 抛
  // "Failed to parse URL from xxx",那句话用户没法照着修
  const base = assertUsableBaseUrl(baseUrl) || DEFAULT_BASE_URLS.ollama!;
  return base.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

/** 从 /api/show 的返回里抠出上下文长度。抠不到返回 null,不瞎猜 */
export function extractContextLength(show: unknown): number | null {
  if (!show || typeof show !== 'object') return null;
  const info = (show as { model_info?: Record<string, unknown> }).model_info;
  if (!info) return null;

  // 键名是 `<架构>.context_length`,架构得从 general.architecture 拿
  const arch = info['general.architecture'];
  if (typeof arch === 'string') {
    const v = info[`${arch}.context_length`];
    if (typeof v === 'number' && v > 0) return v;
  }
  // 退一步:任何以 .context_length 结尾的键
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) return v;
  }
  return null;
}

/**
 * 列出本地已装模型。
 *
 * 拿不到(没装 Ollama / 没在跑)就抛 —— 路由转成一句人话,
 * 而不是静默返回空列表让用户以为"一个模型都没装"。
 */
export async function listOllamaModels(
  baseUrl = '',
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaModel[]> {
  const root = ollamaRoot(baseUrl);

  const tagsRes = await fetchImpl(`${root}/api/tags`);
  if (!tagsRes.ok) throw new Error(`Ollama 返回 ${tagsRes.status} —— 确认它正在运行`);
  const tags = (await tagsRes.json()) as { models?: { name?: string }[] };
  const names = (tags.models ?? []).map((m) => m.name).filter((n): n is string => !!n);

  // /api/show 每个模型一次。本地调用,几百毫秒级,不值得做并发池
  const out: OllamaModel[] = [];
  for (const name of names) {
    try {
      const showRes = await fetchImpl(`${root}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const show = showRes.ok ? await showRes.json() : null;
      const contextWindow = extractContextLength(show);
      if (contextWindow === null) continue; // 拿不到真实值就不进列表 —— 宁缺勿错
      out.push({
        name,
        contextWindow,
        maxOutput: outputBudget(contextWindow),
        detail: (show as { details?: { parameter_size?: string; quantization_level?: string } })
          ?.details
          ? [
              (show as { details: { parameter_size?: string } }).details.parameter_size,
              (show as { details: { quantization_level?: string } }).details.quantization_level,
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined,
      });
    } catch {
      // 单个模型查不到就跳过,不让它拖垮整个列表
    }
  }
  return out;
}
