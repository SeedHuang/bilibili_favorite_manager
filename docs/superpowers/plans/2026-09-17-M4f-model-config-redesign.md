# 模型管理三层拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把模型配置拆成三层 —— 服务商凭证(`llm.providers`)/ 模型条目(`llm.models`)/ 用途分配(四个用途各指一个条目),删除手填上下文数字与 tag 回落主模型逻辑。

**Architecture:** settings 表存两个 JSON 键 + 四个 purpose 键;`readLlmSettings(db, purpose)` 签名不变、内部改为三层查找,curator 消费方只改 purpose 实参;`/api/settings/llm` 三件套替换为 providers / entries / assignments 路由组;前端 ModelManager 拆成凭证卡 + 条目卡 + 分配卡。

**Tech Stack:** Fastify 5 / better-sqlite3 12.11.1 / vitest / @umijs/max + antd 5 + lucide-react

**Spec:** `docs/superpowers/specs/2026-09-17-model-config-redesign.md`

## Global Constraints

- Node 22.12 / better-sqlite3 **12.11.1**(不升级 —— 13.x 在本机 win32 dlopen 段错误)
- antd **5**;图标用 `lucide-react`,不用 `@ant-design/icons`
- apiKey 走 DPAPI 加密存储;**任何 HTTP 响应、日志、测试断言里不得出现明文 key**(§6)
- 路由测试绝不打真实 LLM API —— mock `../llm/provider.js` 的 `complete`/`stream`(沿用 importOriginal 铺开真模块再覆盖的既有模式)
- **web build 退出码恒为 1(既有 esbuild 问题)** —— 门禁看 `typecheck` 通过 + build 输出含 `Compiled successfully`
- 旧配置键(`llm.provider` 等散键)不读不迁不删 —— 用户已拍板清空重配
- 中文 UI 文案;注释密度照抄现有文件(现有代码注释都讲"为什么")

## 对 spec 的两个落地细节(不改设计,只定实现)

1. 条目路由用 **`/api/settings/entries`**;`GET /api/settings/models`(内置注册表列表)保持原语义 —— 前端"厂商列表拉不到时退回内置表"依赖它。
2. 新增设置键 **`llm.ollama.meta`**(JSON:`Record<modelName, {contextWindow, maxOutput}>`):`/api/settings/ollama-models` 每次成功拉取就合并写入;`readLlmSettings` 对 ollama 条目优先读它。否则"条目不存数字"会让本地模型退回 32K 兜底,违反 spec §2"ollama 运行时 /api/show 现有逻辑不变"。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `server/src/llm/config.ts` | 重写 | 三层存储读写 + `readLlmSettings`(签名不变,purpose 扩为四用途)+ `seedLlm` 测试铺底 |
| `server/src/llm/config.test.ts` | 重写 | 新结构读写测试 |
| `server/src/curator/routes.ts` | 改 | `requireLlm` 带 purpose 参数;设置路由段替换为 providers/entries/assignments |
| `server/src/curator/ruleRoutes.ts` | 改 | 两处 purpose 实参 `'rules'` |
| `server/src/curator/tagRoutes.ts` | 改 | status 去掉回落语义;run 读 `'tag'` |
| `server/src/curator/routes.test.ts` | 改 | makeApp 换 seedLlm;设置路由用例替换 |
| `server/src/curator/{ruleRoutes,tagRoutes,integration}.test.ts` | 改 | makeApp 换 seedLlm |
| `web/src/api.ts` | 改 | llmApi 重写为 providers/entries/assignments 三组 |
| `web/src/types.ts` | 改 | LlmSettingsView 删,加 ProviderView / EntryView / AssignmentsView |
| `web/src/components/ModelManager.tsx` | 重写 | 凭证卡 + 条目卡 + 分配卡三块 |
| `web/src/pages/auth.tsx` | 改 | 渲染一处 ModelManager(去掉 purpose="tag") |

---

### Task 1: config.ts 三层存储重写(TDD)

**Files:**
- Modify: `server/src/llm/config.ts`(整个文件重写)
- Test: `server/src/llm/config.test.ts`(整个文件重写)

**Interfaces:**
- Consumes: `getSetting/setSetting/deleteSetting`(`../db/repo/state.js`,均已存在)、`encryptSecret/decryptSecret`(`../security/dpapi.js`)、`getModelMeta`(`./registry.js`)、`assertUsableBaseUrl`(`./provider.js`)
- Produces(后续任务依赖,签名逐字):
  - `export type LlmPurpose = 'chat' | 'classify' | 'rules' | 'tag'`
  - `export const PURPOSES: readonly LlmPurpose[]`
  - `export interface ProviderEntry { id: string; provider: string; baseUrl: string; apiKeyEnc: string }`
  - `export interface ModelEntry { id: string; providerId: string; model: string }`
  - `export function listProviders(db): ProviderEntry[]`
  - `export function saveProvider(db, input: {id?: string; provider: string; baseUrl?: string; apiKey?: string}): ProviderEntry`(apiKey undefined = 保留已存;'' = 清空;新增时 undefined 按空处理)
  - `export function deleteProvider(db, id): void`(被条目引用时 throw)
  - `export function listEntries(db): ModelEntry[]`
  - `export function addEntry(db, input: {providerId: string; model: string}): ModelEntry`(四用途全空时自动全分配到它)
  - `export function deleteEntry(db, id): void`(被用途引用时 throw)
  - `export function getAssignments(db): Record<LlmPurpose, string | null>`
  - `export function setAssignment(db, purpose: LlmPurpose, entryId: string | null): void`(entryId 不存在时 throw)
  - `export function ollamaMeta(db): Record<string, {contextWindow: number; maxOutput: number}>`(读 `llm.ollama.meta`)
  - `export function readLlmSettings(db, purpose: LlmPurpose): LlmSettings | null`(形状不变:`{config: ModelConfig, ctx: ModelMeta}`)
  - `export function seedLlm(db, opts?: {provider?; model?; baseUrl?; apiKey?}): void`——测试铺底专用,生产代码不 import

- [ ] **Step 1: 写失败测试**(整文件替换 `server/src/llm/config.test.ts`)

```ts
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
    saveProvider(db, { id: p.id, provider: 'deepseek', baseUrl: 'http://x/v1' });
    expect(readLlmSettings(db, 'chat')!.config.apiKey).toBe('sk-keep-me-1234');
    saveProvider(db, { id: p.id, provider: 'deepseek', apiKey: '' });
    expect(readLlmSettings(db, 'chat')!.config.apiKey).toBe('');
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
    deleteEntry(db, listEntries(db)[0]!.id);
    expect(() => deleteProvider(db, p!.id)).not.toThrow();
    expect(listProviders(db)).toHaveLength(0);
  });
});

describe('条目层', () => {
  it('添加条目:四用途全空 → 自动全分配', () => {
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
    const e2 = addEntry(db, { providerId: p2.id, model: 'deepseek-chat' });
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
    expect(() => setAssignment(db, 'chat', 'm_nope')).toThrow();
  });
});

describe('readLlmSettings(三层查找)', () => {
  it('purpose 有分配 → 拼 config + ctx;apiKey 解密;数字来自注册表', () => {
    const db = fresh();
    seedLlm(db, { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-x-12345678' });
    const s = readLlmSettings(db, 'rules')!;
    expect(s.config).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-x-12345678' });
    expect(s.ctx.contextWindow).toBe(128_000); // 注册表里的,不是手填
    expect(s.ctx.maxOutput).toBe(8_192);
    expect(s.ctx.verified).toBe(true);
  });

  it('用途没分配 → null;分配指向不存在的条目(脏数据)→ null', () => {
    expect(readLlmSettings(fresh(), 'chat')).toBeNull();
    const db2 = fresh();
    setAssignment(db2, 'chat', 'm_gone');
    expect(readLlmSettings(db2, 'chat')).toBeNull();
  });

  it('ollama 条目:llm.ollama.meta 有真实值 → 用它且 verified:true', () => {
    const db = fresh();
    seedLlm(db, { provider: 'ollama', model: 'qwen3-custom:latest' });
    setRaw(db, 'llm.ollama.meta', JSON.stringify({ 'qwen3-custom:latest': { contextWindow: 40_960, maxOutput: 8_192 } }));
    const s = readLlmSettings(db, 'chat')!;
    expect(s.ctx.contextWindow).toBe(40_960);
    expect(s.ctx.verified).toBe(true);
  });

  it('ollama 条目:meta 没有 → 兜底 32K/4K + verified:false', () => {
    const db = fresh();
    seedLlm(db, { provider: 'ollama', model: 'never-seen:latest' });
    const s = readLlmSettings(db, 'chat')!;
    expect(s.ctx.contextWindow).toBe(32_768);
    expect(s.ctx.verified).toBe(false);
  });

  it('seedLlm:铺好凭证+条目+四用途(测试基建自证)', () => {
    const db = fresh();
    seedLlm(db);
    expect(listProviders(db)).toHaveLength(1);
    expect(listEntries(db)).toHaveLength(1);
    const a = getAssignments(db);
    for (const purpose of PURPOSES) expect(a[purpose]).toBe(listEntries(db)[0]!.id);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/llm/config.test.ts`
Expected: FAIL —— `saveProvider` 等导出不存在(编译错也算失败)。

- [ ] **Step 3: 重写 `server/src/llm/config.ts`**

```ts
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

export type LlmPurpose = 'chat' | 'classify' | 'rules' | 'tag';
export const PURPOSES: readonly LlmPurpose[] = ['chat', 'classify', 'rules', 'tag'];

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

  const entry: ProviderEntry = {
    id: existing?.id ?? newId('p'),
    provider: input.provider.trim(),
    baseUrl: input.baseUrl?.trim() ?? '',
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

  // 首条条目自动全分配 —— 避免配完一个模型,四个用途全是"未配置"
  const assigned = getAssignments(db);
  if (PURPOSES.every((p) => assigned[p] === null)) {
    for (const p of PURPOSES) setSetting(db, purposeKey(p), entry.id);
  }
  return entry;
}

export function deleteEntry(db: Database.Database, id: string): void {
  const holders = PURPOSES.filter((p) => getAssignments(db)[p] === id);
  if (holders.length > 0) {
    throw new Error(`这个条目正被用途引用(${holders.join(' / ')})—— 先在「用途分配」里改指别的条目`);
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
  return readJson(db, OLLAMA_META_KEY, {});
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

// ── 测试铺底(生产代码不 import)─────────────────────

/** 一条命令铺好 1 凭证 + 1 条目 + 四用途全指它。只在测试里用 */
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
```

注:`crypto.randomUUID` Node 22 全局可用,无需 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run src/llm/config.test.ts`
Expected: PASS(全部用例)

- [ ] **Step 5: Commit**

```bash
git add server/src/llm/config.ts server/src/llm/config.test.ts
git commit -m "feat(llm): three-layer config store (providers/entries/assignments)"
```

---

### Task 2: curator 消费方切 purpose + 设置路由替换(TDD)

**Files:**
- Modify: `server/src/curator/routes.ts`(requireLlm 约 L96-105;设置路由段约 L885-1038)
- Modify: `server/src/curator/ruleRoutes.ts:198,228`
- Modify: `server/src/curator/tagRoutes.ts:9,25-31,42`
- Test: `server/src/curator/routes.test.ts`(makeApp + 设置路由用例替换)
- Test: `server/src/curator/ruleRoutes.test.ts`、`tagRoutes.test.ts`、`integration.test.ts`(makeApp 换 seedLlm)

**Interfaces:**
- Consumes: Task 1 全部导出(`seedLlm` / `readLlmSettings` / `PURPOSES` / `listProviders` / `saveProvider` / `deleteProvider` / `listEntries` / `addEntry` / `deleteEntry` / `getAssignments` / `setAssignment` / `ollamaMeta`)
- Produces(前端 Task 3 依赖的 HTTP API):
  - `GET /api/settings/providers` → `{providers: [{id, provider, baseUrl, hasApiKey}]}`
  - `PUT /api/settings/providers` body `{id?, provider, baseUrl?, apiKey?}` → `{ok, id}` | 400
  - `DELETE /api/settings/providers/:id` → `{ok}` | 400 `{ok:false, reason}`
  - `GET /api/settings/entries` → `{entries: [{id, providerId, provider, model, contextWindow, maxOutput, verified, note?}]}`(数字服务端拼好)
  - `POST /api/settings/entries` body `{providerId, model}` → `{ok, id}` | 400
  - `DELETE /api/settings/entries/:id` → `{ok}` | 400
  - `GET /api/settings/assignments` → `{assignments: {chat, classify, rules, tag}}`(entryId | null)
  - `PUT /api/settings/assignments` body `{chat?, classify?, rules?, tag?}` → `{ok}` | 400
  - `/api/settings/ollama-models` 保留,成功时把真实数字合并写进 `llm.ollama.meta`
  - `/api/settings/test-llm`、`/api/settings/remote-models`、`GET /api/settings/models` 原样保留

- [ ] **Step 1: 改测试铺底与用例**

`routes.test.ts` makeApp(约 L38-40):import 行 `import { saveLlmSettings } from '../llm/config.js'` 改为 `import { seedLlm, saveProvider, listProviders, listEntries } from '../llm/config.js'`,铺底改为:

```ts
  if (opts.llm !== false) {
    seedLlm(db); // 1 凭证 + 1 条目(ollama/qwen2.5:14b)+ 四用途全指它
  }
```

`ruleRoutes.test.ts:25`、`tagRoutes.test.ts` makeApp、`integration.test.ts:65` 同样替换(import 按需精简)。
`integration.test.ts:258` 的"把上下文压小"改为:

```ts
db.prepare(`INSERT INTO settings (key,value) VALUES ('llm.ollama.meta',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
  .run(JSON.stringify({ 'qwen2.5:14b': { contextWindow: 6_000, maxOutput: 1_000 } }));
```

`routes.test.ts` 里设置段的旧用例(读配置不回传 apiKey / configured:false / purpose=tag 回落两例 / 保存成功 / 两个数字校验)整段替换为:

```ts
describe('模型配置(三层)', () => {
  it('providers 列表不回传明文 key', async () => {
    const { app, db } = makeApp();
    saveProvider(db, { provider: 'deepseek', apiKey: 'sk-secret-xyz' });
    const body = (await app.inject({ method: 'GET', url: '/api/settings/providers' })).json();
    expect(body.providers).toHaveLength(2); // seedLlm 的 + 这个
    expect(JSON.stringify(body)).not.toContain('sk-secret-xyz');
    const ds = body.providers.find((p: { provider: string }) => p.provider === 'deepseek');
    expect(ds.hasApiKey).toBe(true);
    await app.close();
  });

  it('PUT providers 更新时 apiKey 不带 = 保留已存', async () => {
    const { app, db } = makeApp();
    const p = listProviders(db)[0]!;
    saveProvider(db, { id: p.id, provider: 'ollama', apiKey: 'sk-keep-123456' });
    const res = await app.inject({
      method: 'PUT', url: '/api/settings/providers',
      payload: { id: p.id, provider: 'ollama', baseUrl: 'http://x/v1' }, // 无 apiKey
    });
    expect(res.statusCode).toBe(200);
    const body = (await app.inject({ method: 'GET', url: '/api/settings/providers' })).json();
    expect(body.providers[0]!.hasApiKey).toBe(true);
    await app.close();
  });

  it('DELETE 被条目引用的凭证 → 400', async () => {
    const { app, db } = makeApp();
    const p = listProviders(db)[0]!;
    const res = await app.inject({ method: 'DELETE', url: `/api/settings/providers/${p.id}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('entries 带注册表解析的数字;新增自动全分配', async () => {
    const { app, db } = makeApp({ llm: false });
    const p = await app.inject({ method: 'PUT', url: '/api/settings/providers', payload: { provider: 'deepseek' } });
    const pid = p.json().id;
    const e = await app.inject({ method: 'POST', url: '/api/settings/entries', payload: { providerId: pid, model: 'deepseek-chat' } });
    expect(e.statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/settings/entries' })).json();
    expect(list.entries[0]).toMatchObject({ model: 'deepseek-chat', contextWindow: 128_000, maxOutput: 8_192, verified: true });
    const a = (await app.inject({ method: 'GET', url: '/api/settings/assignments' })).json();
    expect(a.assignments).toEqual({
      chat: list.entries[0].id, classify: list.entries[0].id, rules: list.entries[0].id, tag: list.entries[0].id,
    });
    await app.close();
  });

  it('DELETE 被用途引用的条目 → 400', async () => {
    const { app, db } = makeApp();
    const e = listEntries(db)[0]!;
    const res = await app.inject({ method: 'DELETE', url: `/api/settings/entries/${e.id}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PUT assignments 改单个用途;指向不存在的条目 → 400', async () => {
    const { app, db } = makeApp();
    const e2 = await app.inject({
      method: 'POST', url: '/api/settings/entries',
      payload: { providerId: listProviders(db)[0]!.id, model: 'qwen2.5:14b' },
    }); // 第二条不触发自动分配(用途已被 seed 占住)
    const res = await app.inject({ method: 'PUT', url: '/api/settings/assignments', payload: { tag: e2.json().id } });
    expect(res.statusCode).toBe(200);
    const a = (await app.inject({ method: 'GET', url: '/api/settings/assignments' })).json();
    expect(a.assignments.tag).toBe(e2.json().id);
    expect(a.assignments.chat).not.toBe(e2.json().id);
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/assignments', payload: { chat: 'm_nope' } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('用途没分配 → curator 接口 400 提示去配置', async () => {
    const { app } = makeApp();
    await app.inject({ method: 'PUT', url: '/api/settings/assignments', payload: { chat: null } });
    const sid = (await app.inject({ method: 'POST', url: '/api/curator/sessions', payload: {} })).json().id as number;
    const r = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/chat`, payload: { content: 'hi' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().reason).toContain('模型');
    await app.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/routes.test.ts src/curator/tagRoutes.test.ts src/curator/ruleRoutes.test.ts src/curator/integration.test.ts`
Expected: FAIL —— 新路由 404、旧 `/api/settings/llm` 已删、`seedLlm` 未 import 等。

- [ ] **Step 3: 改消费方 + 替换设置路由段**

**`routes.ts` import(L32 附近)改为:**

```ts
import {
  readLlmSettings, type LlmPurpose, PURPOSES,
  listProviders, saveProvider, deleteProvider,
  listEntries, addEntry, deleteEntry,
  getAssignments, setAssignment, ollamaMeta,
} from '../llm/config.js';
```

(import 里补 `setSetting`:`import { setSetting } from '../db/repo/state.js';` —— 检查现有 import,若已有合并进去。)

**requireLlm(约 L96-105)改为带 purpose:**

```ts
  /** 取当前模型配置;没配过就回 400 并给一句人话。purpose:这段路由属于哪个用途 */
  const requireLlm = (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    purpose: LlmPurpose = 'chat',
  ) => {
    const llm = readLlmSettings(db, purpose);
    if (!llm) {
      reply.code(400).send({ ok: false, reason: '还没配模型 —— 先去「授权」页的模型管理里选一个' });
      return null;
    }
    return llm;
  };
```

**routes.ts 内调用点语义对号:**
- L154(聊天 SSE)、L1044(sessions/:id/context):`requireLlm(reply)` 保持 —— 默认 chat。
- L242(run-pass-1)、L306(run-pass-2):`requireLlm(reply, 'classify')`。
- L930(remote-models 取已存 key)、L1009(test-llm 取已存 key):`readLlmSettings(db)` → `readLlmSettings(db, 'chat')`。

**`ruleRoutes.ts` L198、L228:** `readLlmSettings(db)` → `readLlmSettings(db, 'rules')`。

**`tagRoutes.ts`:**
- L9 import 去掉 `isPurposeConfigured`。
- L25-31 status 路由整段换成:

```ts
  app.get('/api/tags/status', async () => {
    const tag = readLlmSettings(db, 'tag');
    // 用途平级后没有"回落"了:tag 没配就是没配,界面照实说
    return {
      ...tagStats(db),
      model: tag ? { provider: tag.config.provider, model: tag.config.model, source: 'tag' as const } : null,
    };
  });
```

- L42 `readLlmSettings(db, 'tag')` 不动(签名兼容)。tagRoutes.test.ts 里断言 `source:'main'` 回落的用例按新语义改(无 tag → model:null)。

**设置路由段(routes.ts 约 L885-989)替换** —— `purposeOf`、`GET/PUT /api/settings/llm` 删除,换成:

```ts
  // ── 模型管理:三层(凭证 / 条目 / 用途分配)──────────────
  // spec 2026-09-17-model-config-redesign。GET /api/settings/models(内置注册表)
  // 原样保留 —— 前端"厂商列表拉不到时退回内置表"靠它。

  app.get('/api/settings/providers', async () => {
    // **绝不回传 apiKey** —— 只回"有没有配"(沿用旧 /api/settings/llm 的规矩)
    return {
      providers: listProviders(db).map(({ id, provider, baseUrl, apiKeyEnc }) => ({
        id, provider, baseUrl, hasApiKey: apiKeyEnc !== '',
      })),
    };
  });

  app.put('/api/settings/providers', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string; provider?: string; baseUrl?: string; apiKey?: string };
    try {
      const p = saveProvider(db, body);
      log.event({ level: 'info', category: 'llm', message: `服务商凭证已保存:${p.provider}` });
      return { ok: true, id: p.id };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.delete('/api/settings/providers/:id', async (req, reply) => {
    try {
      deleteProvider(db, (req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.get('/api/settings/entries', async () => {
    const providers = listProviders(db);
    const meta = ollamaMeta(db);
    return {
      entries: listEntries(db).map((e) => {
        const provider = providers.find((p) => p.id === e.providerId);
        // 数字服务端拼好 —— 前端不算,也不存(spec §2:条目不存数字)
        const ctx = provider
          ? (provider.provider === 'ollama' && meta[e.model]
            ? { ...getModelMeta(provider.provider, e.model), ...meta[e.model], verified: true }
            : getModelMeta(provider.provider, e.model))
          : getModelMeta('custom', e.model); // 凭证已删的脏数据:兜底显示
        return {
          id: e.id, providerId: e.providerId,
          provider: provider?.provider ?? '?',
          model: e.model,
          contextWindow: ctx.contextWindow, maxOutput: ctx.maxOutput,
          verified: ctx.verified, ...(ctx.note ? { note: ctx.note } : {}),
        };
      }),
    };
  });

  app.post('/api/settings/entries', async (req, reply) => {
    const body = (req.body ?? {}) as { providerId?: string; model?: string };
    try {
      const e = addEntry(db, { providerId: body.providerId ?? '', model: body.model ?? '' });
      log.event({ level: 'info', category: 'llm', message: `模型条目已添加:${e.model}` });
      return { ok: true, id: e.id };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.delete('/api/settings/entries/:id', async (req, reply) => {
    try {
      deleteEntry(db, (req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.get('/api/settings/assignments', async () => ({ assignments: getAssignments(db) }));

  app.put('/api/settings/assignments', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<Record<LlmPurpose, string | null>>;
    try {
      for (const purpose of PURPOSES) {
        if (body[purpose] !== undefined) setAssignment(db, purpose, body[purpose]!);
      }
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });
```

(routes.ts 需要 `PURPOSES` —— 加进上面的 config import 行。)

**`/api/settings/ollama-models`(约 L895-914)成功分支追加写入:**

```ts
    try {
      const models = await listOllamaModels(baseUrl, deps.ollamaFetchImpl ?? fetch);
      // 真实数字落地:readLlmSettings 对 ollama 条目优先读这里(spec §2:ollama 现有逻辑不变)
      const prev = ollamaMeta(db);
      for (const m of models) prev[m.name] = { contextWindow: m.contextWindow, maxOutput: m.maxOutput };
      setSetting(db, 'llm.ollama.meta', JSON.stringify(prev));
      return { models };
    } catch (e) {
      // ……原有 catch 原样保留……
```

- [ ] **Step 4: 跑全部 server 测试**

Run: `cd server && npx vitest run`
Expected: PASS。旧用例因语义变化失败(如 tag status 的 source 回落)按新语义修断言,**不许跳过**。

- [ ] **Step 5: Commit**

```bash
git add server/src
git commit -m "feat(llm): wire consumers to purposes; replace /api/settings/llm with providers/entries/assignments"
```

---

### Task 3: 前端三块卡片(门禁 typecheck + build)

**Files:**
- Modify: `web/src/types.ts`(删 L120-134 的 `LlmSettingsView`,加三个 View)
- Modify: `web/src/api.ts:240-280`(`llmApi` 重写)
- Rewrite: `web/src/components/ModelManager.tsx`
- Modify: `web/src/pages/auth.tsx:103-104,168-169`(两处渲染各改一处)

**Interfaces:**
- Consumes: Task 2 的八个 HTTP 路由
- Produces: `<ModelManager />`(无 props);`llmApi.{providers, saveProvider, deleteProvider, entries, addEntry, deleteEntry, assignments, setAssignments, test, listModels, listRemoteModels}`

- [ ] **Step 1: types.ts** —— 删 `LlmSettingsView`,在其位置加:

```ts
export interface ProviderView {
  id: string;
  provider: string;
  baseUrl: string;
  /** 后端**只**回这个,永远不回传 apiKey 本身 */
  hasApiKey: boolean;
}

export interface EntryView {
  id: string;
  providerId: string;
  provider: string;
  model: string;
  /** 服务端查注册表/ollama meta 拼好的数字 —— 前端不存不算 */
  contextWindow: number;
  maxOutput: number;
  verified: boolean;
  note?: string;
}

export type LlmPurpose = 'chat' | 'classify' | 'rules' | 'tag';

export interface AssignmentsView {
  assignments: Record<LlmPurpose, string | null>;
}
```

同时把 `TagRunStatus.model` 注释(L283-287)里"回落主模型是 'main'"的说明改为"用途平级后 tag 没配就是 null;'main' 仅为兼容保留"。

- [ ] **Step 2: api.ts `llmApi` 重写**(L240-280 整段替换;import 行补 `ProviderView, EntryView, AssignmentsView, LlmPurpose`,删 `LlmSettingsView`):

```ts
export const llmApi = {
  /** 内置注册表(厂商列表拉不到时的兜底,语义同旧) */
  listModels: (provider?: string) =>
    api<{ models: ModelMeta[] }>(
      `/api/settings/models${provider ? `?provider=${provider}` : ''}`,
    ).then((r) => r.models),

  /**
   * 从厂商的 `/models` 拉真实模型名。apiKey 留空 = 用已存的那个(凭证表单里
   * 从来拿不到明文 key,首次配只能靠用户现填的这个)。
   */
  listRemoteModels: (input: { provider: string; baseUrl?: string; apiKey?: string }) =>
    json<{ models: ModelMeta[] }>('POST', '/api/settings/remote-models', input).then(
      (r) => r.models,
    ),

  providers: () =>
    api<{ providers: ProviderView[] }>('/api/settings/providers').then((r) => r.providers),

  saveProvider: (input: { id?: string; provider: string; baseUrl?: string; apiKey?: string }) =>
    json<{ ok: true; id: string }>('PUT', '/api/settings/providers', input),

  deleteProvider: (id: string) =>
    json<{ ok: true }>('DELETE', `/api/settings/providers/${id}`),

  entries: () =>
    api<{ entries: EntryView[] }>('/api/settings/entries').then((r) => r.entries),

  addEntry: (input: { providerId: string; model: string }) =>
    json<{ ok: true; id: string }>('POST', '/api/settings/entries', input),

  deleteEntry: (id: string) =>
    json<{ ok: true }>('DELETE', `/api/settings/entries/${id}`),

  assignments: () =>
    api<AssignmentsView>('/api/settings/assignments').then((r) => r.assignments),

  setAssignments: (input: Partial<Record<LlmPurpose, string | null>>) =>
    json<{ ok: true }>('PUT', '/api/settings/assignments', input),

  test: (input: { provider: string; model: string; baseUrl?: string; apiKey?: string }) =>
    json<{ ok: true; reply: string }>('POST', '/api/settings/test-llm', input),
};
```

- [ ] **Step 3: `ModelManager.tsx` 重写**

**保留旧文件的这些资产(照搬,别重写):**
- `Field` 组件(L359-370,含 label/id 与浏览器自动填充的注释)
- `PROVIDERS` 常量(L17-23)
- `loadModels` 的 ollama / remote 双路逻辑(L72-125,**含**"故意不把 apiKey 放进依赖"的注释与 `/api/settings/ollama-models` fetch)
- `changeProvider` 换服务商清字段逻辑(L138-145)
- unverified 判定(L160-161)与模型 tags 模式 Select 的注释(L236-239)

**整体骨架:**

```tsx
/**
 * 模型管理:三层(服务商凭证 → 模型条目 → 用途分配)。
 * spec 2026-09-17-model-config-redesign —— 每层一张卡,配置只下沉不回落。
 */
export default function ModelManager() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [entries, setEntries] = useState<EntryView[]>([]);
  const [assignments, setAssignments] = useState<Record<LlmPurpose, string | null> | null>(null);
  const reload = useCallback(async () => {
    const [p, e, a] = await Promise.all([llmApi.providers(), llmApi.entries(), llmApi.assignments()]);
    setProviders(p);
    setEntries(e);
    setAssignments(a);
  }, []);
  useEffect(() => { reload().catch(() => {}); }, [reload]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      <ProviderCard providers={providers} onDone={reload} />
      <EntryCard providers={providers} entries={entries} onDone={reload} />
      <AssignCard entries={entries} assignments={assignments} onDone={reload} />
    </div>
  );
}
```

**卡 1 `ProviderCard`:** 凭证列表(每条一行:`provider 名 · baseUrl 或「默认地址」 · 已存 key`,带 编辑/删除 小按钮)+ 内嵌表单(provider Select、baseUrl Input、API Key Input.Password、「保存」Button、可选「测试连接」)。要点:
- 编辑:点编辑回填表单并存 `editingId`,提交带 `id`;`apiKey` 留空 = 不改动(placeholder `hasApiKey ? '已保存,留空表示不改动' : '粘贴 API Key'`)。
- 保存成功后清 apiKey 字段、退出编辑态、`onDone()`。
- 删除:`llmApi.deleteProvider(id)`,catch 里把 400 的 reason 放 Alert error 原样展示("还有模型条目在用"正是要让用户看到的)。
- 「测试连接」需要模型名:表单里加一个 tags 模式的 Select(照搬旧 L236-239 的注释与实现),选项用 `loadModels` 拉的列表,失败退内置表(旧 L99-110 逻辑)。选中后有模型名才启用测试按钮,调 `llmApi.test({provider, model, baseUrl, ...(apiKey ? {apiKey} : {})})`。

**卡 2 `EntryCard`:** 两个下拉(凭证:label `${p.provider}`,disabled 当 providers 为空并提示先建凭证;模型名:tags 模式 Select + 刷新按钮,选项按所选凭证的 provider 走 `loadModels`)+「添加」按钮(`llmApi.addEntry`)。下方条目列表:每条 `${e.provider} · ${e.model} · ${Math.round(e.contextWindow/1000)}K / ${Math.round(e.maxOutput/1000)}K`,verified false 前缀 `⚠️ `(note 有则附上),行尾删除按钮(400 reason 原样展示)。添加成功清模型名、`onDone()`。

**卡 3 `AssignCard`:** `assignments === null` 时渲染 `<p className="hud-label">加载中…</p>`;否则四行下拉:

```tsx
const PURPOSE_LABELS: Record<LlmPurpose, string> = {
  chat: '聊天', classify: '归类', rules: '规则建议', tag: '打标',
};
```

options = entries(`label: \`${e.provider} · ${e.model}\``)+ 一项 `{value: '', label: '未配置'}`(提交时转 null);value 取 `assignments[p] ?? ''`;onChange 调 `llmApi.setAssignments({[p]: v || null})` 后 `onDone()`。entries 为空时下拉禁用并提示"先在下面加一个模型条目"。(布局:label 92px 的 Field 同旧。)

**视觉 token 照旧:** `hud-panel` 卡容器(padding 20)、`hud-label`、`var(--accent)` / `var(--warn)` / `var(--text-dim)` / `var(--fs-12)`;卡片标题行沿用旧 Zap 图标样式(lucide `Zap` / 凭证卡可用 `KeyRound`,14-16px,`color: 'var(--accent)'`)。

- [ ] **Step 4: auth.tsx** —— L103-104 与 L168-169 的 `<ModelManager />` + `<ModelManager purpose="tag" />` 各改为一处 `<ModelManager />`;L102 附近那条"打标是第二张卡片"的注释改为"模型管理:凭证 / 条目 / 用途分配三层(2026-09-17 重构)"。

- [ ] **Step 5: 门禁**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors(`TagRunStatus.source` 类型没动,RulesPanel 不受影响)

Run: `cd web && npm run build 2>&1 | tail -5`
Expected: 退出码 1 是既有 esbuild 问题**忽略**;输出含 `Compiled successfully` 才算过。

- [ ] **Step 6: 手测清单**(起 `cd server && npm run dev` + `cd web && npm run dev`,在 /auth 页):
  1. 建凭证(ollama,baseUrl 留空)→ 列表出现
  2. 加条目(如 qwen2.5:14b)→ 四用途自动指它;条目行显示真实上下文(Ollama 在跑时)
  3. 改「打标」指另一条 → /rules 页打标提示跟着变
  4. 删被引用条目 → 400 文案原样显示
  5. curator 聊天 / 规则建议 / 打标各跑一次冒烟

- [ ] **Step 7: Commit**

```bash
git add web/src
git commit -m "feat(web): model manager as three cards (providers/entries/assignments)"
```

---

### Task 4: 全量门禁 + 收尾

**Files:**
- Modify: `docs/superpowers/specs/README.md`(索引加一行)

- [ ] **Step 1: 全量测试 + typecheck**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: 全 PASS,0 type errors

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: 确认旧语义死净**

```bash
grep -rn "isPurposeConfigured\|saveLlmSettings\|ownConfigured\|'main'" server/src web/src --include="*.ts" --include="*.tsx"
```
Expected: 无命中(`'main'` 若在注释里讲历史可留,代码引用必须为 0)。

- [ ] **Step 3: README 索引** —— `docs/superpowers/specs/README.md` 的「你要做的事 → 读这些」表格加一行:

```markdown
| 改模型管理(三层凭证/条目/用途,2026-09-17) | `2026-09-17-model-config-redesign.md` + `shared-llm-provider.md` |
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/README.md
git commit -m "docs: index model-config-redesign spec"
```
