/**
 * LLM 配置:三层存储(spec 2026-09-17-model-config-redesign)。
 *
 *   凭证(llm.providers)→ 条目(llm.models)→ 用途分配(llm.purpose.*)
 *
 * 条目不存 contextWindow / maxOutput —— 数字一律查注册表;ollama 用运行时
 * `/api/show` 拉回来的 `llm.ollama.meta`(models 发现路由顺手写入)。
 * 旧版"手填数字 + tag 逐项回落主模型"已整体删除:回落语义制造过真实 bug
 * (把主模型的 baseUrl 冒充成打标卡已配置)。
 *
 * apiKey 与 cookie 同等对待(DPAPI 加密)—— 都在同一个威胁模型里:本机 SQLite
 * 文件可能被别的程序读走。
 */
import type Database from 'better-sqlite3';
import { getSetting, setSetting, deleteSetting } from '../db/repo/state.js';
import { encryptSecret, decryptSecret } from '../security/dpapi.js';
import { getModelMeta, type ModelMeta } from './registry.js';
import type { ModelConfig } from './provider.js';
import { assertUsableBaseUrl } from './provider.js';

// proposals(夹子方案生成)2026-09-20 起独立于 rules:两者量级与要求不同,
// 混用会让规则页和方案页互相抢同一档模型
export type LlmPurpose = 'proposals' | 'rules' | 'tag' | 'tagcheck';
export const PURPOSES: readonly LlmPurpose[] = ['proposals', 'rules', 'tag', 'tagcheck'];
/** 面向用户展示的用途名 —— 报错里别漏内部 key */
const PURPOSE_LABELS: Record<LlmPurpose, string> = {
  proposals: '夹子方案生成',
  rules: '规则建议',
  tag: '打标',
  // 质检只对新词开口,判的是"这个词在树里该站哪" —— 量小但要准,和打标的要求相反
  tagcheck: '标签质检',
};

const PROVIDERS_KEY = 'llm.providers';
const MODELS_KEY = 'llm.models';
const OLLAMA_META_KEY = 'llm.ollama.meta';
const purposeKey = (p: LlmPurpose) => `llm.purpose.${p}`;

export interface ProviderEntry {
  id: string;
  /** registry.ts 里的 provider 名(ollama / ark / deepseek / minimax / custom) */
  provider: string;
  /** 留空 = 用 DEFAULT_BASE_URLS 的默认地址 */
  baseUrl: string;
  /** DPAPI 密文。HTTP 层只回 hasApiKey,永不回本字段明文 */
  apiKeyEnc: string;
}

export interface ModelEntry {
  id: string;
  providerId: string;
  model: string;
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

function readJson<T>(db: Database.Database, key: string, fallback: T): T {
  const v = getSetting(db, key);
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback; // 脏数据当没有,别让整个设置页挂掉
  }
}

const writeJson = (db: Database.Database, key: string, value: unknown) =>
  setSetting(db, key, JSON.stringify(value));

// ── 凭证层 ───────────────────────────────────────────

export function listProviders(db: Database.Database): ProviderEntry[] {
  return readJson<ProviderEntry[]>(db, PROVIDERS_KEY, []);
}

export function saveProvider(
  db: Database.Database,
  input: { id?: string; provider: string; baseUrl?: string; apiKey?: string },
): ProviderEntry {
  if (!input.provider?.trim()) throw new Error('没有选服务商');
  assertUsableBaseUrl(input.baseUrl ?? '');

  const list = listProviders(db);
  const existing = input.id ? list.find((p) => p.id === input.id) : undefined;
  if (input.id && !existing) throw new Error('凭证不存在');

  // undefined = 不改动已存的 key;'' = 清空;新增时 undefined 按空处理
  const apiKeyEnc =
    input.apiKey !== undefined
      ? input.apiKey
        ? encryptSecret(input.apiKey)
        : ''
      : existing?.apiKeyEnc ?? '';

  // baseUrl 与 apiKey 同规矩:undefined = 保留已存、'' = 清空、有值 = 覆写。
  // 否则"只换 key"的调用会把端点冲成空 —— 对没有 DEFAULT_BASE_URLS 的
  // provider(custom / anthropic-compatible)就是把地址弄丢了。
  const baseUrl = input.baseUrl !== undefined ? input.baseUrl.trim() : existing?.baseUrl ?? '';

  const entry: ProviderEntry = {
    id: existing?.id ?? newId('p'),
    provider: input.provider.trim(),
    baseUrl,
    apiKeyEnc,
  };
  writeJson(db, PROVIDERS_KEY, existing ? list.map((p) => (p.id === entry.id ? entry : p)) : [...list, entry]);
  return entry;
}

export function deleteProvider(db: Database.Database, id: string): void {
  if (listEntries(db).some((e) => e.providerId === id)) {
    throw new Error('这条凭证还有模型条目在用 —— 先删掉对应条目');
  }
  writeJson(db, PROVIDERS_KEY, listProviders(db).filter((p) => p.id !== id));
}

// ── 条目层 ───────────────────────────────────────────

export function listEntries(db: Database.Database): ModelEntry[] {
  return readJson<ModelEntry[]>(db, MODELS_KEY, []);
}

export function addEntry(db: Database.Database, input: { providerId: string; model: string }): ModelEntry {
  if (!input.model?.trim()) throw new Error('没有选模型');
  if (!listProviders(db).some((p) => p.id === input.providerId)) throw new Error('凭证不存在');

  const entry: ModelEntry = { id: newId('m'), providerId: input.providerId, model: input.model.trim() };
  writeJson(db, MODELS_KEY, [...listEntries(db), entry]);

  // 首条条目自动全分配 —— 避免配完一个模型,所有用途全是"未配置"
  const assigned = getAssignments(db);
  if (PURPOSES.every((p) => assigned[p] === null)) {
    for (const p of PURPOSES) setSetting(db, purposeKey(p), entry.id);
  }
  return entry;
}

export function deleteEntry(db: Database.Database, id: string): void {
  const holders = PURPOSES.filter((p) => getAssignments(db)[p] === id);
  if (holders.length > 0) {
    throw new Error(
      `这个条目正被用途引用(${holders.map((p) => PURPOSE_LABELS[p]).join(' / ')})—— 先在「用途分配」里改指别的条目`,
    );
  }
  writeJson(db, MODELS_KEY, listEntries(db).filter((e) => e.id !== id));
}

// ── 用途分配 ─────────────────────────────────────────

export function getAssignments(db: Database.Database): Record<LlmPurpose, string | null> {
  const out = {} as Record<LlmPurpose, string | null>;
  for (const p of PURPOSES) out[p] = getSetting(db, purposeKey(p)) ?? null;
  return out;
}

export function setAssignment(db: Database.Database, purpose: LlmPurpose, entryId: string | null): void {
  if (entryId !== null && !listEntries(db).some((e) => e.id === entryId)) {
    throw new Error('条目不存在');
  }
  if (entryId === null) deleteSetting(db, purposeKey(purpose));
  else setSetting(db, purposeKey(purpose), entryId);
}

// ── 读取(消费方入口,签名与旧版兼容)─────────────────

/** ollama 运行时真实数字(`/api/show` 拉的),ollama-models 路由写入;键是模型名 */
export function ollamaMeta(db: Database.Database): Record<string, { contextWindow: number; maxOutput: number }> {
  return readJson<Record<string, { contextWindow: number; maxOutput: number }>>(db, OLLAMA_META_KEY, {});
}

export interface LlmSettings {
  config: ModelConfig;
  ctx: ModelMeta;
}

export function readLlmSettings(db: Database.Database, purpose: LlmPurpose): LlmSettings | null {
  const entryId = getAssignments(db)[purpose];
  if (!entryId) return null;
  const entry = listEntries(db).find((e) => e.id === entryId);
  if (!entry) return null; // 分配指向的条目没了(脏数据)→ 当没配
  const provider = listProviders(db).find((p) => p.id === entry.providerId);
  if (!provider) return null;

  const apiKey = provider.apiKeyEnc ? (decryptSecret(provider.apiKeyEnc) ?? '') : '';
  const base = getModelMeta(provider.provider, entry.model);

  let ctx: ModelMeta;
  if (provider.provider === 'ollama') {
    // 本地模型的真实数字优先 —— 拉过就有,没拉过退兜底(verified:false,UI 标 ⚠️)
    const real = ollamaMeta(db)[entry.model];
    ctx = real ? { ...base, ...real, verified: true } : base;
  } else {
    ctx = base;
  }

  return {
    config: {
      id: entry.model,
      provider: provider.provider,
      baseUrl: provider.baseUrl,
      apiKey,
      model: entry.model,
    },
    ctx,
  };
}

/**
 * 已保存凭证里的第一个可用 apiKey(解密后)。空 = 没配任何带 key 的凭证。
 *
 * 聊天用途删除后,test-llm / remote-models 还需要一个"拿已存 key 当回落"的
 * 来源 —— 取第一个**真正带 key** 的条目,不依赖任何具体用途(用途无关)。
 * 跳过没配 key 的(Ollama 凭证、或用户清空过 key),否则拿空 key 发请求。
 */
export function firstSavedApiKey(db: Database.Database): string {
  const providers = new Map(listProviders(db).map((p) => [p.id, p]));
  for (const entry of listEntries(db)) {
    const enc = providers.get(entry.providerId)?.apiKeyEnc;
    if (enc) return decryptSecret(enc) ?? '';
  }
  return '';
}

// ── 测试铺底(生产代码不 import)─────────────────────

/** 一条命令铺好 1 凭证 + 1 条目 + 全部用途指它。只在测试里用 */
export function seedLlm(
  db: Database.Database,
  opts: { provider?: string; model?: string; baseUrl?: string; apiKey?: string } = {},
): void {
  const p = saveProvider(db, {
    provider: opts.provider ?? 'ollama',
    baseUrl: opts.baseUrl ?? '',
    apiKey: opts.apiKey ?? '',
  });
  const e = addEntry(db, { providerId: p.id, model: opts.model ?? 'qwen2.5:14b' });
  for (const purpose of PURPOSES) setAssignment(db, purpose, e.id);
}
