/**
 * 从厂商的 OpenAI 兼容端点拉模型列表(spec §3 的"模型发现")。
 *
 * **名字实时拉,数字查表 —— 这两件事刻意分开:**
 *
 * - **名字以厂商为准。** 它才知道自己现在服务哪些模型。手抄一张表必然又旧又错:
 *   实测 DeepSeek 官方文档给的 `/models` 示例里就有我们表里没有的 `deepseek-flash`,
 *   而表里那个 `deepseek-v4-flash` 又被记在了方舟名下。
 * - **数字以注册表为准。** 那个接口只回 `{id, object, owned_by}`,**没有任何 token
 *   上限信息** —— 而这两个数字填错就等于 `batchSize` 算错(`llm/ollama.ts` 开头那段
 *   讲的就是这个:批太大批到超上下文,批太小跑一整天)。所以查得到就用表里的真值,
 *   查不到就交给 `getModelMeta` 的兜底(32768 / 4096)并在界面上标 ⚠️ 让用户核对。
 *
 * **本地 Ollama 不走这里** —— 它有原生 `/api/show`,能报出真实的 `context_length`,
 * 那比"查表 + 兜底"强,所以那条路留着(见 `llm/ollama.ts`)。
 */
import { assertUsableBaseUrl, DEFAULT_BASE_URLS } from './provider.js';
import { getModelMeta, type ModelMeta } from './registry.js';

export async function listRemoteModels(opts: {
  provider: string;
  baseUrl?: string;
  /** 留空 = 用一个占位值(有些自建端点不校验 key) */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<ModelMeta[]> {
  // 先校验再套默认 —— 非法地址要报"接口地址看起来不对",不是让 fetch 抛
  // "Failed to parse URL from xxx",那句话用户没法照着修
  const base = assertUsableBaseUrl(opts.baseUrl ?? '') || DEFAULT_BASE_URLS[opts.provider] || '';
  if (!base) throw new Error(`「${opts.provider}」没有默认接口地址 —— 请先填一个`);

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base.replace(/\/+$/, '')}/models`, {
    headers: { authorization: `Bearer ${opts.apiKey || 'not-needed'}` },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error('这个 key 拉不到模型列表 —— 检查 API Key 是不是填错了');
  }
  if (!res.ok) throw new Error(`拉模型列表失败:HTTP ${res.status}`);

  const body = (await res.json()) as { data?: unknown };
  const ids = (Array.isArray(body?.data) ? body.data : [])
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '');

  // 排序:下拉里顺序稳定,换一次服务商不会跳来跳去
  return [...new Set(ids)].sort().map((id) => getModelMeta(opts.provider, id));
}
