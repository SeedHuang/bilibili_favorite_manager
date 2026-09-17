/**
 * LLM 配置的读写(spec §3 模型管理页的数据面)。
 *
 * 配置存 `settings` 表,apiKey 与 cookie 同等对待(DPAPI 加密)—— 都在同一个
 * 威胁模型里:本机 SQLite 文件可能被别的程序读走。
 */
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../db/repo/state.js';
import { encryptSecret, decryptSecret } from '../security/dpapi.js';
import { getModelMeta, type ModelMeta } from './registry.js';
import { assertUsableBaseUrl, type ModelConfig } from './provider.js';

export const LLM_KEYS = {
  provider: 'llm.provider',
  baseUrl: 'llm.baseUrl',
  apiKey: 'llm.apiKey',
  model: 'llm.model',
  contextWindow: 'llm.contextWindow',
  maxOutput: 'llm.maxOutput',
} as const;

/**
 * 按用途分组的配置键(§3:不同功能可以用不同的模型)。
 *
 * **底层共享,按用途覆盖**:打标模型(`tag.*`)没配的项回落到主模型(`llm.*`)——
 * 用户只想换模型名、不想再填一遍 key/baseUrl 时,留空就是"沿用主模型"。
 */
export type LlmPurpose = 'main' | 'tag';

const PURPOSE_PREFIX: Record<LlmPurpose, string> = { main: 'llm', tag: 'tag' };

/** 某用途的完整键组;main 的键就是 LLM_KEYS(兼容已存的旧数据) */
function keysFor(purpose: LlmPurpose) {
  if (purpose === 'main') return LLM_KEYS;
  const p = PURPOSE_PREFIX[purpose];
  return {
    provider: `${p}.provider`,
    baseUrl: `${p}.baseUrl`,
    apiKey: `${p}.apiKey`,
    model: `${p}.model`,
    contextWindow: `${p}.contextWindow`,
    maxOutput: `${p}.maxOutput`,
  } as const;
}

export interface LlmSettings {
  config: ModelConfig;
  ctx: ModelMeta;
}

/** 只接受正数 —— 0 / NaN / 负数一律当作"没填" */
function positive(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 这个用途**自己**配过没有 —— **不看**回落主模型。
 *
 * 为什么不能拿 `readLlmSettings(...) !== null` 代替:`readLlmSettings` 逐项回落,
 * 主模型一配好,`purpose='tag'` 就永远非 null。UI 用它回填会把主模型的值冒充成
 * "这张卡已经配好" —— 实测过一次:打标卡因此把 baseUrl 填成主模型的
 * `https://api.deepseek.com`,用户改选 ollama 后拿这个地址去问本地 `/api/tags`,
 * 401 → 下拉直接空掉,而报错还说"确认 Ollama 正在运行"。
 *
 * 判据与 readLlmSettings 保持一致:provider + model **两个键都在**才算配过
 * (只想换模型名、key/地址留着沿用主模型,是正常的"配过")。
 */
export function isPurposeConfigured(db: Database.Database, purpose: LlmPurpose = 'main'): boolean {
  const keys = keysFor(purpose);
  const own = (k: string): boolean => {
    const v = getSetting(db, k);
    return v !== undefined && v !== '';
  };
  return own(keys.provider) && own(keys.model);
}

/**
 * 读出某个用途当前生效的模型配置。没配过返回 null(调用方给用户一句"先去设置页配模型")。
 *
 * **底层共享(§3)**:`purpose='tag'` 时,没配的项**逐项**回落到主模型 ——
 * 常见形态是打标只换模型名(本地 4b),key/baseUrl 留空沿用主模型。
 * provider+model 是"配没配过"的判据:这两项回落还缺,就是真的没配。
 *
 * contextWindow / maxOutput 优先用用户手填的值(§3:选完模型可编辑),
 * 没填才用注册表的默认值。
 */
export function readLlmSettings(db: Database.Database, purpose: LlmPurpose = 'main'): LlmSettings | null {
  const keys = keysFor(purpose);
  // tag 键 → 主模型键的字段名映射('tag.provider' → 'llm.provider'):底层共享的回落就靠它
  const mainKeyOf: Record<string, string> = purpose === 'main'
    ? {}
    : Object.fromEntries(Object.entries(keys).map(([field, k]) => [k, LLM_KEYS[field as keyof typeof LLM_KEYS]]));
  const get = (k: string): string | undefined => {
    const v = getSetting(db, k);
    if (v !== undefined && v !== '') return v;
    // 非主模型:这一项没配 → 沿用主模型的(底层共享)
    if (purpose !== 'main') return getSetting(db, mainKeyOf[k] ?? k);
    return undefined;
  };

  const provider = get(keys.provider);
  const model = get(keys.model);
  if (!provider || !model) return null;

  const storedKey = get(keys.apiKey);
  const apiKey = storedKey ? (decryptSecret(storedKey) ?? '') : '';

  const base = getModelMeta(provider, model);
  const contextWindow = positive(get(keys.contextWindow));
  let maxOutput = positive(get(keys.maxOutput));

  // 输入和输出**共享**同一个窗口 —— maxOutput ≥ contextWindow 等于没给输入留地方,
  // 而后果是静默的:预算变负 → 聊天上下文被裁到只剩最后一条,且每轮白烧一次摘要。
  // 这种组合可能是老版本存下的 / 手滑填的,读到就当没填,退回模型默认值。
  const nonsensical = maxOutput !== null && contextWindow !== null && maxOutput >= contextWindow;
  if (nonsensical) maxOutput = null;

  // 用户手填过 = 他确认过这两个数,不该再在 UI 上标 ⚠️ 待确认
  const overridden = contextWindow !== null || maxOutput !== null;

  return {
    config: {
      id: model,
      provider,
      baseUrl: get(keys.baseUrl) ?? '',
      apiKey,
      model,
    },
    ctx: {
      ...base,
      ...(contextWindow === null ? {} : { contextWindow }),
      ...(maxOutput === null ? {} : { maxOutput }),
      ...(overridden && !nonsensical ? { verified: true } : {}),
    },
  };
}

export interface LlmInput {
  provider: string;
  model: string;
  baseUrl?: string;
  /** undefined = 不改动已存的 key(用户不用每次重打);'' = 清空 */
  apiKey?: string;
  contextWindow?: number;
  maxOutput?: number;
}

/** 写入。校验不过直接抛 —— 路由转成 400(§3:0 提交会让分类器算出 0 批次) */
export function saveLlmSettings(db: Database.Database, input: LlmInput, purpose: LlmPurpose = 'main'): void {
  if (!input.provider?.trim()) throw new Error('没有选服务商');
  if (!input.model?.trim()) throw new Error('没有选模型');

  const cw = positive(input.contextWindow === undefined ? undefined : String(input.contextWindow));
  const mo = positive(input.maxOutput === undefined ? undefined : String(input.maxOutput));
  if (input.contextWindow !== undefined && cw === null) throw new Error('上下文长度必须大于 0');
  if (input.maxOutput !== undefined && mo === null) throw new Error('最大输出必须大于 0');
  // 必须**严格小于**:输入和输出共享同一个窗口,相等就意味着输入预算为 0,
  // 而那个后果是静默的(聊天丢上下文),所以在这里硬拦
  if (cw !== null && mo !== null && mo >= cw) {
    throw new Error('最大输出必须小于上下文长度 —— 输入和输出共享同一个窗口,相等等于没给输入留地方');
  }
  // 在这里就报错,而不是等第一次调模型才炸 —— 用户填错时当场告诉他
  assertUsableBaseUrl(input.baseUrl ?? '');

  const keys = keysFor(purpose);
  setSetting(db, keys.provider, input.provider.trim());
  setSetting(db, keys.model, input.model.trim());
  setSetting(db, keys.baseUrl, input.baseUrl?.trim() ?? '');
  if (cw !== null) setSetting(db, keys.contextWindow, String(cw));
  if (mo !== null) setSetting(db, keys.maxOutput, String(mo));

  if (input.apiKey !== undefined) {
    setSetting(db, keys.apiKey, input.apiKey ? encryptSecret(input.apiKey) : '');
  }
}
