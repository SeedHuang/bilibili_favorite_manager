# AI 公共套件抽取到 ai_suit_tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 BFM 的 AI 配置 + 请求能力（`server/src/llm/` + 前端三卡）抽成一个可发布 npm 包 `@seedhuang/ai_suit_tool`，落在独立仓库 `D:\Seed\ai_suit_tool`，BFM 切到 npm link 消费，原代码彻底删除不留死代码。

**Architecture:** 单包 + exports 子路径（`.`, `./core`, `./fastify`, `./react`, `./contract`, `./tokens.css`）。核心 `createAiCore` 框架无关，storage/secrets/purposes/logger/fetch 全注入；Fastify 适配器挂 `/api/settings/*` 12 条路由；React 组件只做 AI 配置三卡（轮询/批次留 BFM）。迁移按"包侧建好 → BFM 切换 → 删除"三段推进，每段目录级 tsc 验证，不允许先拆坏再补。

**Tech Stack:** TypeScript ^5.9.3 (ESM, strict + noUncheckedIndexedAccess)、Vercel AI SDK `ai@7`、`@ai-sdk/deepseek`、`@ai-sdk/openai-compatible`、Fastify 5（BFM 侧）、React 18 + antd 5（BFM 侧）、vitest

**Spec:** `docs/superpowers/specs/2026-09-22-ai-suit-tool-design.md`

## Global Constraints

- **包名 `@seedhuang/ai_suit_tool` 为占位**（spec §10 待定项）。若用户改 scope，全局替换字符串后执行，其余不动。
- 新仓库 `D:\Seed\ai_suit_tool` 当前为空。包内文件全部新建；**BFM 侧改动遵循项目既有约定：不自动 `git add`/`git commit`**，验证靠 `tsc` + `vitest`。ai_suit_tool 自己的 git 提交照计划执行。
- Node 22.12、TypeScript ^5.9.3、ESM（类型一律 `import type`）；`strict` + `noUncheckedIndexedAccess`。
- 依赖方向（包内）：`contract ← core ← fastify / react`。`core` 不许 import `fastify`/`react`；`fastify`/`react` 只依赖 `core`/`contract` 的公开导出。
- **同一文件禁止并行 SearchReplace**；import 变更与代码变更必须在同一次 SearchReplace 内完成。
- 每编辑一个 `.ts/.tsx` 文件后立即跑 `npx tsc --noEmit --pretty 2>&1 | grep "<该文件所在目录>"`；全部完成后跑一次无 grep 的全量 `npx tsc --noEmit --pretty`。
- **BFM 删除纪律**：按依赖逆序推进，被迁移的代码从 BFM 删干净（死导出/死 import/死样式/死依赖/死测试一个不留），Grep 确认迁移符号在 BFM 内零引用。
- 协议层只认 DeepSeek 官方包 + OpenAI 兼容；**不写 per-provider 适配器**。加 provider = 注册表加默认地址 + 模型数字。
- 安全不变量：API Key 只存在于服务端（secrets 加密），HTTP 层**永不回传明文 key**（只回 `hasApiKey`）。

---

## 包侧目录结构（Tasks 1-6 的产出）

```
D:\Seed\ai_suit_tool\
├── package.json / tsconfig.json / vitest.config.ts / .gitignore
├── src\
│   ├── index.ts                      # 聚合导出（core + contract 类型）
│   ├── contract\
│   │   ├── types.ts                  # ModelMeta / ProviderView / EntryView / LlmPurpose / AssignmentsView / PurposeDef
│   │   ├── endpoints.ts              # 路由表 + 请求/响应类型
│   │   └── runContractTests.ts       # 契约测试 runner
│   ├── core\
│   │   ├── index.ts                  # createAiCore + AiCore 类型
│   │   ├── config.ts                 # 三层配置（storage/secrets/purposes 注入）
│   │   ├── provider.ts               # complete()（原样迁）
│   │   ├── registry.ts               # MODELS 内置表 + extend
│   │   ├── models.ts                 # listRemoteModels（原样迁）
│   │   ├── ollama.ts                 # listOllamaModels 等（原样迁）
│   │   ├── context.ts                # ChatMessage（原样迁）
│   │   └── redact.ts                 # registerSecret/redact/redactDeep（原样迁）
│   ├── fastify\
│   │   └── index.ts                  # registerAiSettings
│   └── react\
│       ├── index.ts                  # AiSettingsProvider + 三卡导出
│       ├── client.ts                 # createAiClient
│       ├── ProviderCard.tsx / EntryCard.tsx / PurposeCard.tsx / Card.tsx / Field.tsx / ModelPicker.tsx
│       └── tokens.css                # 默认 CSS 变量（迁自 BFM tokens.css 的 AI 部分）
├── src/**/*.test.ts                  # 测试随代码迁入
```

---

### Task 1: ai_suit_tool 骨架（可 npm link 的空包）

**Files:**
- Create: `D:\Seed\ai_suit_tool\package.json`
- Create: `D:\Seed\ai_suit_tool\tsconfig.json`
- Create: `D:\Seed\ai_suit_tool\vitest.config.ts`
- Create: `D:\Seed\ai_suit_tool\.gitignore`
- Create: `D:\Seed\ai_suit_tool\src\index.ts`
- Create: `D:\Seed\ai_suit_tool\src\core\index.ts`（空壳，Task 3 填实）

**Interfaces:**
- Produces: `npm test` 在空包上绿；`npm link` 可用；后续任务往 `src/` 填实现。

- [ ] **Step 1: 初始化仓库与 package.json**

若 `D:\Seed\ai_suit_tool` 下无 `.git`，先 `git init`。然后写 `package.json`：

```jsonc
{
  "name": "@seedhuang/ai_suit_tool",
  "version": "0.1.0",
  "type": "module",
  "description": "AI 配置与请求公共套件：三层模型配置 + 唯一请求出口 + 设置 UI，前后端可合可拆",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".":            { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./core":       { "types": "./dist/core/index.d.ts", "default": "./dist/core/index.js" },
    "./fastify":    { "types": "./dist/fastify/index.d.ts", "default": "./dist/fastify/index.js" },
    "./react":      { "types": "./dist/react/index.d.ts", "default": "./dist/react/index.js" },
    "./contract":   { "types": "./dist/contract/index.d.ts", "default": "./dist/contract/index.js" },
    "./tokens.css": "./src/react/tokens.css"
  },
  "files": ["dist", "src/react/tokens.css"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "build:watch": "tsc -p tsconfig.build.json --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ai-sdk/deepseek": "^3.0.44",
    "@ai-sdk/openai-compatible": "^3.0.48",
    "ai": "^7.0.101"
  },
  "peerDependencies": {
    "react": ">=18",
    "react-dom": ">=18",
    "antd": ">=5"
  },
  "devDependencies": {
    "@types/node": "^22.20.2",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "antd": "^5.21.0",
    "fastify": "^5.12.4",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tsx": "^4.23.13",
    "typescript": "^5.9.3",
    "vitest": "^3.2.7"
  }
}
```

`tsconfig.json`（开发/类型检查用，`noEmit`）:

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

`tsconfig.build.json`（产物编译，输出 d.ts + js 到 dist）:

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "declarationMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
```

`.gitignore`:

```
node_modules/
dist/
```

- [ ] **Step 2: 空壳入口文件**

`src/index.ts`:

```ts
// 聚合入口：前后端合起来用时的全部公开导出
export * from './contract/types.js';
```

`src/core/index.ts`（空壳，Task 3 填）:

```ts
export {};
```

- [ ] **Step 3: 安装依赖并验证骨架**

```bash
cd D:\Seed\ai_suit_tool
npm install
npm run typecheck
npm test
```

Expected: 安装成功；typecheck 零错误；vitest 提示 "No test files found"（空包正常）或零用例绿。

- [ ] **Step 4: npm link 立桩**

```bash
cd D:\Seed\ai_suit_tool
npm link
```

Expected: 输出 `up to date / linked @seedhuang/ai_suit_tool`。

- [ ] **Step 5: Commit**

```bash
cd D:\Seed\ai_suit_tool
git add -A
git commit -m "chore: ai_suit_tool 骨架（可 npm link 的空包）"
```

---

### Task 2: 契约层 `src/contract/`

**Files:**
- Create: `D:\Seed\ai_suit_tool\src\contract\types.ts`
- Create: `D:\Seed\ai_suit_tool\src\contract\endpoints.ts`
- Create: `D:\Seed\ai_suit_tool\src\contract\runContractTests.ts`
- Test: `D:\Seed\ai_suit_tool\src\contract\runContractTests.test.ts`

**Interfaces:**
- Consumes: Task 1 的 tsconfig（strict + noUncheckedIndexedAccess）
- Produces（后续 core/fastify/react 与 BFM 全部引用这些类型）:
  - `ModelMeta { provider: string; model: string; contextWindow: number; maxOutput: number; verified: boolean; note?: string }`
  - `ProviderView { id: string; provider: string; baseUrl: string; hasApiKey: boolean }`
  - `EntryView { id: string; providerId: string; provider: string; model: string; contextWindow: number; maxOutput: number; verified: boolean; note?: string }`
  - `PurposeDef { key: string; label: string }`
  - `AssignmentsView { assignments: Record<string, string | null> }`
  - `OllamaModelView { name: string; contextWindow: number; maxOutput: number; detail?: string }`
  - `runContractTests(opts: { baseUrl: string; fetchImpl?: typeof fetch }): void` —— 在 vitest 内调用，跑全部契约用例

- [ ] **Step 1: 写类型文件**

`src/contract/types.ts`（从 BFM `web/src/types.ts` 的 AI 部分迁出；`LlmPurpose` 泛化为 `string`，具体用途由 `PurposeDef[]` 定义）:

```ts
/** 模型元数据 —— 前后端共同语言。数字由服务端查注册表/ollama meta 拼好，前端不存不算 */
export interface ModelMeta {
  provider: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
  /** false = 估算值，UI 标 ⚠️ 待确认 */
  verified: boolean;
  note?: string;
}

/** 服务商凭证的 HTTP 视图。后端**只**回这个，永不回传 apiKey 本身 */
export interface ProviderView {
  id: string;
  provider: string;
  baseUrl: string;
  hasApiKey: boolean;
}

/** 模型条目的 HTTP 视图。数字服务端拼好（注册表 / ollama 运行时真值 / 兜底） */
export interface EntryView {
  id: string;
  providerId: string;
  provider: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
  verified: boolean;
  note?: string;
}

/** 一个用途的展示定义 —— 消费方传 createAiCore 的 purposes 用 */
export interface PurposeDef {
  key: string;
  label: string;
}

/** 用途分配视图 */
export interface AssignmentsView {
  assignments: Record<string, string | null>;
}

/** 本地 Ollama 模型发现的一行（前端下拉用） */
export interface OllamaModelView {
  name: string;
  contextWindow: number;
  maxOutput: number;
  detail?: string;
}
```

- [ ] **Step 2: 写端点契约**

`src/contract/endpoints.ts`（路由表即契约，从 BFM `curator/routes.ts` settings 段 + `web/src/api.ts` llmApi 归纳）:

```ts
import type { AssignmentsView, EntryView, ModelMeta, OllamaModelView, ProviderView } from './types.js';

/** 契约端点清单 —— 实现方照此实现即合规。key 只走 body，永不进 query（防落日志） */
export const AI_ENDPOINTS = [
  { method: 'GET', path: '/api/settings/models' },
  { method: 'POST', path: '/api/settings/remote-models' },
  { method: 'GET', path: '/api/settings/ollama-models' },
  { method: 'GET', path: '/api/settings/providers' },
  { method: 'PUT', path: '/api/settings/providers' },
  { method: 'DELETE', path: '/api/settings/providers/:id' },
  { method: 'GET', path: '/api/settings/entries' },
  { method: 'POST', path: '/api/settings/entries' },
  { method: 'DELETE', path: '/api/settings/entries/:id' },
  { method: 'GET', path: '/api/settings/assignments' },
  { method: 'PUT', path: '/api/settings/assignments' },
  { method: 'POST', path: '/api/settings/test-llm' },
] as const;

export interface RemoteModelsRequest { provider: string; baseUrl?: string; apiKey?: string }
export interface SaveProviderRequest { id?: string; provider: string; baseUrl?: string; apiKey?: string }
export interface AddEntryRequest { providerId: string; model: string }
export interface TestLlmRequest { provider: string; model: string; baseUrl?: string; apiKey?: string }

export interface ListModelsResponse { models: ModelMeta[] }
export interface RemoteModelsResponse { models: ModelMeta[] }
export interface OllamaModelsResponse { models: OllamaModelView[]; reason?: string }
export interface ProvidersResponse { providers: ProviderView[] }
export interface EntriesResponse { entries: EntryView[] }
export interface AssignmentsResponse { assignments: Record<string, string | null> }
export interface TestLlmResponse { ok: true; reply: string; contextWindow: number; maxOutput: number }
```

- [ ] **Step 3: 写契约测试 runner + 用例**

`src/contract/runContractTests.ts`（不变量从 BFM `curator/routes.test.ts` 的模型管理段迁出，跑在任意 `baseUrl` 上）:

```ts
import { describe, expect, it } from 'vitest';
import type { EntryView, ProviderView } from './types.js';

export interface ContractTestOpts {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/** 实现方自证合规：对任意 baseUrl 跑全部契约用例。seedLlm 语义由实现方保证 */
export function runContractTests(opts: ContractTestOpts): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const call = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
    const res = await fetchImpl(`${opts.baseUrl}${path}`, init);
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  };

  describe('AI 设置契约（runContractTests）', () => {
    it('providers 列表不回传明文 key', async () => {
      const { body } = await call<{ providers: ProviderView[] }>('/api/settings/providers');
      expect(JSON.stringify(body)).not.toContain('sk-secret');
      for (const p of body.providers) {
        expect(Object.keys(p).sort()).toEqual(['id', 'provider', 'baseUrl', 'hasApiKey'].sort());
      }
    });

    it('PUT providers 更新时 apiKey 不带 = 保留已存', async () => {
      const { body: list } = await call<{ providers: ProviderView[] }>('/api/settings/providers');
      const p = list.providers[0];
      if (!p) throw new Error('契约测试需要至少一条已 seed 的凭证');
      const res = await call<{ ok: true }>('/api/settings/providers', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: p.id, provider: p.provider, baseUrl: 'http://x/v1' }), // 无 apiKey
      });
      expect(res.status).toBe(200);
      const { body: after } = await call<{ providers: ProviderView[] }>('/api/settings/providers');
      expect(after.providers.find((x) => x.id === p.id)?.hasApiKey).toBe(true);
    });

    it('DELETE 被条目引用的凭证 → 400 且带 reason', async () => {
      const { body: list } = await call<{ providers: ProviderView[] }>('/api/settings/providers');
      const p = list.providers.find((x) => x.hasApiKey) ?? list.providers[0];
      if (!p) throw new Error('需要至少一条凭证');
      const res = await call<{ ok: false; reason: string }>(
        `/api/settings/providers/${p.id}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(400);
      expect((res.body as { reason?: string }).reason).toBeTruthy();
    });

    it('entries 视图带服务端拼好的数字', async () => {
      const { body } = await call<{ entries: EntryView[] }>('/api/settings/entries');
      for (const e of body.entries) {
        expect(typeof e.contextWindow).toBe('number');
        expect(typeof e.maxOutput).toBe('number');
        expect(typeof e.verified).toBe('boolean');
      }
    });

    it('assignments 覆盖全部用途键', async () => {
      const { body } = await call<{ assignments: Record<string, string | null> }>(
        '/api/settings/assignments',
      );
      expect(Object.keys(body.assignments).length).toBeGreaterThan(0);
    });

    it('test-llm 缺参数 → 400', async () => {
      const res = await call<{ ok: false; reason: string }>('/api/settings/test-llm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });
}
```

- [ ] **Step 4: 写 runner 的最小自测**

`src/contract/runContractTests.test.ts`（用一个内存 stub 后端验证 runner 本身的断言逻辑正确；不依赖真实服务器）:

```ts
import { describe, it, expect } from 'vitest';
import { runContractTests } from './runContractTests.js';

// 极小的内存后端，实现 runContractTests 所需的最小面
const stub = (baseUrl: string) => {
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(baseUrl, '');
    if (path === '/api/settings/providers' && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ providers: [{ id: 'p1', provider: 'ollama', baseUrl: '', hasApiKey: true }] }), { status: 200 });
    }
    if (path === '/api/settings/entries') return new Response(JSON.stringify({ entries: [{ id: 'm1', providerId: 'p1', provider: 'ollama', model: 'q', contextWindow: 100, maxOutput: 50, verified: true }] }), { status: 200 });
    if (path === '/api/settings/assignments') return new Response(JSON.stringify({ assignments: { tag: 'm1' } }), { status: 200 });
    if (path === '/api/settings/test-llm') return new Response(JSON.stringify({ ok: false, reason: '先选服务商和模型' }), { status: 400 });
    if (path === '/api/settings/providers' && init?.method === 'PUT') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (path.startsWith('/api/settings/providers/') && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ ok: false, reason: '这条凭证还有模型条目在用' }), { status: 400 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };
  return fetchImpl;
};

describe('runContractTests 自测', () => {
  it('全部用例通过', async () => {
    // 把 fetchImpl 传进 runner 的唯一手段是包一层，这里直接验证函数可调用且不抛
    // （用例体内用 opts.fetchImpl；vitest 会把用例当 describe 注册，跑在真实 runner 调用中）
    await import('./runContractTests.js').then(() => { expect(typeof runContractTests).toBe('function'); });
    expect(typeof stub('http://x')).toBe('function');
  });
});
```

> 注：`runContractTests` 定义的是 `describe/it`（vitest 顶层注册），因此它只能在 vitest 进程内被调用；BFM 集成时在 `routes.test.ts` 里调它即可复用全部用例。

- [ ] **Step 5: 验证**

```bash
cd D:\Seed\ai_suit_tool
npm run typecheck
npm test
```

Expected: typecheck 零错误；`runContractTests 自测` 绿。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(contract): 契约类型 + 端点清单 + runContractTests"
```

---

### Task 3: core 配置层（createAiCore + 三层存储注入）

**Files:**
- Create: `D:\Seed\ai_suit_tool\src\core\config.ts`
- Modify: `D:\Seed\ai_suit_tool\src\core\index.ts`
- Create: `D:\Seed\ai_suit_tool\src\core\registry.ts`（Task 4 填模型表，本任务只放类型壳）
- Test: `D:\Seed\ai_suit_tool\src\core\config.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `PurposeDef`
- Produces（Task 4/5/6 与 BFM 引用）:
  - `interface KvStorage { get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void }`
  - `interface SecretsCipher { encrypt(plain: string): string; decrypt(stored: string): string | null }`
  - `interface AiLogger { event(e: { level: 'info' | 'warn' | 'error'; category: string; code?: string; message: string }): void }`
  - `interface AiCoreOptions { purposes: PurposeDef[]; storage: KvStorage; secrets?: SecretsCipher; registry?: { extend?: Record<string, ModelMeta> }; logger?: AiLogger; fetchImpl?: typeof fetch }`
  - `interface AiCore { ...config 方法 + complete + 模型发现，Task 4 补全 }`
  - `createAiCore(opts: AiCoreOptions): AiCore`
  - `plainSecretCipher(): SecretsCipher`（不传 secrets 时的明文降级，`plain:` 前缀）

- [ ] **Step 1: 先写 `plainSecretCipher` + 注入化 config（含测试）**

`src/core/config.ts` 从 BFM `server/src/llm/config.ts` 泛化。核心改动：
1. `db: Database.Database` 参数 → `storage: KvStorage`（`getSetting/setSetting/deleteSetting` 换成 `storage.get/set/delete`）
2. `encryptSecret/decryptSecret` → 注入的 `secrets`（无注入用 `plainSecretCipher`）
3. `PURPOSES` 常量 + `PURPOSE_LABELS` → 注入的 `purposes: PurposeDef[]`
4. 其余逻辑（三层查找、首条自动分配、被引用 400、ollamaMeta 合并）**逐字保留**

```ts
import type { PurposeDef } from '../contract/types.js';
import type { ModelMeta } from '../contract/types.js';
import { getModelMeta } from './registry.js';
import type { ModelConfig } from './provider.js';
import { assertUsableBaseUrl } from './provider.js';

export interface KvStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface SecretsCipher {
  encrypt(plain: string): string;
  decrypt(stored: string): string | null;
}

/** 不传 secrets 时的降级：明文 + `plain:` 前缀，decrypt 能读回（测试/无敏感场景） */
export function plainSecretCipher(): SecretsCipher {
  return {
    encrypt: (plain: string) => (plain ? `plain:${plain}` : ''),
    decrypt: (stored: string) => (stored.startsWith('plain:') ? stored.slice('plain:'.length) : null),
  };
}

export interface ProviderEntry {
  id: string;
  provider: string;
  /** 留空 = 用 DEFAULT_BASE_URLS 的默认地址 */
  baseUrl: string;
  /** 密文。HTTP 层只回 hasApiKey，永不回本字段明文 */
  apiKeyEnc: string;
}

export interface ModelEntry {
  id: string;
  providerId: string;
  model: string;
}

const PROVIDERS_KEY = 'llm.providers';
const MODELS_KEY = 'llm.models';
const OLLAMA_META_KEY = 'llm.ollama.meta';
const purposeKey = (p: string) => `llm.purpose.${p}`;

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

function readJson<T>(storage: KvStorage, key: string, fallback: T): T {
  const v = storage.get(key);
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback; // 脏数据当没有，别让整个设置页挂掉
  }
}

const writeJson = (storage: KvStorage, key: string, value: unknown) =>
  storage.set(key, JSON.stringify(value));

export interface ConfigApi {
  listProviders(): ProviderEntry[];
  saveProvider(input: { id?: string; provider: string; baseUrl?: string; apiKey?: string }): ProviderEntry;
  deleteProvider(id: string): void;
  listEntries(): ModelEntry[];
  addEntry(input: { providerId: string; model: string }): ModelEntry;
  deleteEntry(id: string): void;
  getAssignments(): Record<string, string | null>;
  setAssignment(purpose: string, entryId: string | null): void;
  ollamaMeta(): Record<string, { contextWindow: number; maxOutput: number }>;
  setOllamaMeta(meta: Record<string, { contextWindow: number; maxOutput: number }>): void;
  readLlmSettings(purpose: string): { config: ModelConfig; ctx: ModelMeta } | null;
  firstSavedApiKey(): string;
}

export function createConfigApi(deps: {
  purposes: PurposeDef[];
  storage: KvStorage;
  secrets: SecretsCipher;
}): ConfigApi {
  const { purposes, storage, secrets } = deps;
  const purposeKeys = () => purposes.map((p) => p.key);
  const purposeLabel = (key: string) => purposes.find((p) => p.key === key)?.label ?? key;

  return {
    listProviders: () => readJson<ProviderEntry[]>(storage, PROVIDERS_KEY, []),

    saveProvider(input) {
      if (!input.provider?.trim()) throw new Error('没有选服务商');
      assertUsableBaseUrl(input.baseUrl ?? '');

      const list = readJson<ProviderEntry[]>(storage, PROVIDERS_KEY, []);
      const existing = input.id ? list.find((p) => p.id === input.id) : undefined;
      if (input.id && !existing) throw new Error('凭证不存在');

      const apiKeyEnc =
        input.apiKey !== undefined
          ? input.apiKey
            ? secrets.encrypt(input.apiKey)
            : ''
          : existing?.apiKeyEnc ?? '';

      const baseUrl = input.baseUrl !== undefined ? input.baseUrl.trim() : existing?.baseUrl ?? '';

      const entry: ProviderEntry = {
        id: existing?.id ?? newId('p'),
        provider: input.provider.trim(),
        baseUrl,
        apiKeyEnc,
      };
      writeJson(storage, PROVIDERS_KEY, existing ? list.map((p) => (p.id === entry.id ? entry : p)) : [...list, entry]);
      return entry;
    },

    deleteProvider(id) {
      if (readJson<ModelEntry[]>(storage, MODELS_KEY, []).some((e) => e.providerId === id)) {
        throw new Error('这条凭证还有模型条目在用 —— 先删掉对应条目');
      }
      writeJson(storage, PROVIDERS_KEY, readJson<ProviderEntry[]>(storage, PROVIDERS_KEY, []).filter((p) => p.id !== id));
    },

    listEntries: () => readJson<ModelEntry[]>(storage, MODELS_KEY, []),

    addEntry(input) {
      if (!input.model?.trim()) throw new Error('没有选模型');
      if (!readJson<ProviderEntry[]>(storage, PROVIDERS_KEY, []).some((p) => p.id === input.providerId)) {
        throw new Error('凭证不存在');
      }
      const entry: ModelEntry = { id: newId('m'), providerId: input.providerId, model: input.model.trim() };
      writeJson(storage, MODELS_KEY, [...readJson<ModelEntry[]>(storage, MODELS_KEY, []), entry]);
      // 首条条目自动全分配 —— 避免配完一个模型，所有用途全是"未配置"
      const assigned = this.getAssignments();
      if (purposeKeys().every((p) => assigned[p] === null)) {
        for (const p of purposeKeys()) storage.set(purposeKey(p), entry.id);
      }
      return entry;
    },

    deleteEntry(id) {
      const holders = purposeKeys().filter((p) => this.getAssignments()[p] === id);
      if (holders.length > 0) {
        throw new Error(
          `这个条目正被用途引用(${holders.map(purposeLabel).join(' / ')})—— 先在「用途分配」里改指别的条目`,
        );
      }
      writeJson(storage, MODELS_KEY, readJson<ModelEntry[]>(storage, MODELS_KEY, []).filter((e) => e.id !== id));
    },

    getAssignments() {
      const out: Record<string, string | null> = {};
      for (const p of purposeKeys()) out[p] = storage.get(purposeKey(p)) ?? null;
      return out;
    },

    setAssignment(purpose, entryId) {
      if (entryId !== null && !readJson<ModelEntry[]>(storage, MODELS_KEY, []).some((e) => e.id === entryId)) {
        throw new Error('条目不存在');
      }
      if (entryId === null) storage.delete(purposeKey(purpose));
      else storage.set(purposeKey(purpose), entryId);
    },

    ollamaMeta: () =>
      readJson<Record<string, { contextWindow: number; maxOutput: number }>>(storage, OLLAMA_META_KEY, {}),

    setOllamaMeta(meta) {
      writeJson(storage, OLLAMA_META_KEY, meta);
    },

    readLlmSettings(purpose) {
      const entryId = this.getAssignments()[purpose];
      if (!entryId) return null;
      const entry = readJson<ModelEntry[]>(storage, MODELS_KEY, []).find((e) => e.id === entryId);
      if (!entry) return null;
      const provider = readJson<ProviderEntry[]>(storage, PROVIDERS_KEY, []).find((p) => p.id === entry.providerId);
      if (!provider) return null;

      const apiKey = provider.apiKeyEnc ? (secrets.decrypt(provider.apiKeyEnc) ?? '') : '';
      const base = getModelMeta(provider.provider, entry.model);

      let ctx: ModelMeta;
      if (provider.provider === 'ollama') {
        const real = this.ollamaMeta()[entry.model];
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
    },

    firstSavedApiKey() {
      const providers = new Map(readJson<ProviderEntry[]>(storage, PROVIDERS_KEY, []).map((p) => [p.id, p]));
      for (const entry of readJson<ModelEntry[]>(storage, MODELS_KEY, [])) {
        const enc = providers.get(entry.providerId)?.apiKeyEnc;
        if (enc) return secrets.decrypt(enc) ?? '';
      }
      return '';
    },
  };
}
```

> `addEntry` / `deleteEntry` / `readLlmSettings` 里用 `this.getAssignments()` 访问兄弟方法——对象字面量方法里 `this` 指向该对象，可行。若执行中遇类型告警，改为捕获局部引用 `const getAssignments = () => ...` 再自调用。

- [ ] **Step 2: registry 类型壳**

`src/core/registry.ts` 先放类型壳（Task 4 填 `MODELS` 表）:

```ts
import type { ModelMeta } from '../contract/types.js';

export function getModelMeta(provider: string, model: string): ModelMeta {
  return MODELS[model] ?? { ...FALLBACK, provider, model };
}

const FALLBACK: Omit<ModelMeta, 'provider' | 'model'> = {
  contextWindow: 32_768,
  maxOutput: 4_096,
  verified: false,
  note: '未收录 —— 用的保守默认值，批次会偏小但不影响正确性',
};

export const MODELS: Record<string, ModelMeta> = {};
```

> Task 4 会把 BFM `registry.ts` 的完整 `MODELS` 表替换进来并加 `extend`。此步先让 config 通过编译。

- [ ] **Step 3: provider 类型壳（Task 4 填 complete）**

`src/core/provider.ts` 先放 `ModelConfig` + `assertUsableBaseUrl`（从 BFM `llm/provider.ts` 复制这两个导出，其余 Task 4 补）:

```ts
export interface ModelConfig {
  /** 显示名 —— 只为 UI/日志可读 */
  id: string;
  provider: string;
  /** 留空则用该 provider 的默认地址 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: 'http://127.0.0.1:11434/v1',
  ark: 'https://ark.cn-beijing.volces.com/api/v3',
  deepseek: 'https://api.deepseek.com/v1',
  minimax: 'https://api.minimaxi.com/v1',
};

export function assertUsableBaseUrl(baseUrl: string): string {
  const v = baseUrl.trim();
  if (!v) return v;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' || u.protocol === 'https:') return v;
  } catch {
    // 落到下面统一报错
  }
  throw new Error(
    `接口地址看起来不对:「${v}」—— 要写成 http://主机:端口 的形式，或者直接留空用默认地址`,
  );
}
```

- [ ] **Step 4: 测试注入化 config**

`src/core/config.test.ts`（从 BFM `server/src/llm/config.test.ts` 迁入并改造：`better-sqlite3` 内存库 → `memoryStorage()`）:

```ts
import { describe, expect, it } from 'vitest';
import { createConfigApi, plainSecretCipher, type KvStorage } from './config.js';
import { createAiCore } from './index.js'; // Task 3 末才存在，先按 createConfigApi 直接测
```

写内存 storage helper（本文件顶部）：

```ts
function memoryStorage(): KvStorage & { _map: Map<string, string> } {
  const _map = new Map<string, string>();
  return {
    _map,
    get: (k) => _map.get(k),
    set: (k, v) => void _map.set(k, v),
    delete: (k) => void _map.delete(k),
  };
}

const PURPOSES = [
  { key: 'proposals', label: '夹子方案生成' },
  { key: 'rules', label: '规则建议' },
  { key: 'tag', label: '打标' },
  { key: 'tagcheck', label: '标签质检' },
];

const api = (storage = memoryStorage()) =>
  createConfigApi({ purposes: PURPOSES, storage, secrets: plainSecretCipher() });

function seed(storage: KvStorage) {
  const a = api(storage);
  const p = a.saveProvider({ provider: 'ollama', baseUrl: '', apiKey: '' });
  const e = a.addEntry({ providerId: p.id, model: 'qwen2.5:14b' });
  for (const { key } of PURPOSES) a.setAssignment(key, e.id);
  return { a, p, e };
}
```

用例（覆盖 BFM 原测试的关键不变量）:

```ts
describe('createConfigApi 三层存储', () => {
  it('saveProvider 加密存储、listProviders 带回密文', () => {
    const a = api();
    const p = a.saveProvider({ provider: 'deepseek', apiKey: 'sk-keep-me-1234' });
    expect(p.apiKeyEnc).toContain('plain:');
    expect(a.firstSavedApiKey()).toBe('sk-keep-me-1234');
  });

  it('saveProvider 无 apiKey = 保留已存', () => {
    const { a, p } = seed();
    const again = a.saveProvider({ id: p.id, provider: 'ollama', baseUrl: 'http://x/v1' });
    expect(again.apiKeyEnc).toBe(p.apiKeyEnc);
  });

  it('首条条目自动全分配', () => {
    const a = api();
    const p = a.saveProvider({ provider: 'ollama' });
    a.addEntry({ providerId: p.id, model: 'qwen2.5:14b' });
    const assigned = a.getAssignments();
    for (const { key } of PURPOSES) expect(assigned[key]).not.toBeNull();
  });

  it('deleteEntry 被用途引用 → 抛错', () => {
    const { a, e } = seed();
    expect(() => a.deleteEntry(e.id)).toThrow(/用途引用/);
  });

  it('deleteProvider 被条目引用 → 抛错', () => {
    const { a, p } = seed();
    expect(() => a.deleteProvider(p.id)).toThrow(/模型条目在用/);
  });

  it('readLlmSettings 三层查找 + ollama 真实数字', () => {
    const { a, e } = seed();
    a.setOllamaMeta({ 'qwen2.5:14b': { contextWindow: 32_768, maxOutput: 8_192 } });
    const s = a.readLlmSettings('rules')!;
    expect(s.config.model).toBe('qwen2.5:14b');
    expect(s.ctx.verified).toBe(true);
    expect(s.ctx.contextWindow).toBe(32_768);
    expect(s.config.apiKey).toBe('');
  });

  it('readLlmSettings 未分配 → null', () => {
    const a = api();
    expect(a.readLlmSettings('rules')).toBeNull();
  });

  it('firstSavedApiKey 跳过无 key 凭证', () => {
    const a = api();
    const p = a.saveProvider({ provider: 'ollama' }); // 无 key
    a.addEntry({ providerId: p.id, model: 'm' });
    expect(a.firstSavedApiKey()).toBe('');
  });
});
```

- [ ] **Step 5: 填 createAiCore 壳并跑测试**

`src/core/index.ts` 补全（Task 4 会继续加 complete / 模型发现，先让 config 走通）:

```ts
import type { AiLogger } from './config.js';
import { createConfigApi, plainSecretCipher, type KvStorage, type SecretsCipher } from './config.js';
import type { PurposeDef } from '../contract/types.js';

export interface AiCoreOptions {
  purposes: PurposeDef[];
  storage: KvStorage;
  secrets?: SecretsCipher;
  logger?: AiLogger;
  fetchImpl?: typeof fetch;
}

export function createAiCore(opts: AiCoreOptions) {
  const secrets = opts.secrets ?? plainSecretCipher();
  const config = createConfigApi({ purposes: opts.purposes, storage: opts.storage, secrets });
  return { ...config };
}
```

- [ ] **Step 6: 验证**

```bash
cd D:\Seed\ai_suit_tool
npm run typecheck
npm test
```

Expected: typecheck 零错误；config.test.ts 全部绿。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): createAiCore 三层配置存储（storage/secrets/purposes 注入）"
```

---

### Task 4: core 请求层（redact / registry / provider / models / ollama / context）

**Files:**
- Create: `D:\Seed\ai_suit_tool\src\core\redact.ts`（从 BFM `server/src/logger/redact.ts` 整文件复制）
- Create: `D:\Seed\ai_suit_tool\src\core\redact.test.ts`（从 BFM `server/src/logger/redact.test.ts` 复制）
- Modify: `D:\Seed\ai_suit_tool\src\core\registry.ts`（填完整 MODELS 表 + extend）
- Modify: `D:\Seed\ai_suit_tool\src\core\provider.ts`（补 complete() + languageModel）
- Create: `D:\Seed\ai_suit_tool\src\core\models.ts`（从 BFM 复制，改 import 相对路径）
- Create: `D:\Seed\ai_suit_tool\src\core\ollama.ts`（从 BFM 复制，改 import 相对路径）
- Create: `D:\Seed\ai_suit_tool\src\core\context.ts`（从 BFM 复制）
- Create: `D:\Seed\ai_suit_tool\src\core\models.test.ts`、`ollama.test.ts`、`registry.test.ts`、`provider.test.ts`（从 BFM 复制并修 import）
- Modify: `D:\Seed\ai_suit_tool\src\core\index.ts`（把 complete/模型发现挂到 AiCore 上）

**Interfaces:**
- Consumes: Task 3 的 `KvStorage` / `SecretsCipher` / `createConfigApi`
- Produces:
  - `complete(opts: { config: ModelConfig; messages: ChatMessage[]; abortSignal?; thinking?; timeoutMs?; maxOutputTokens? }): Promise<string>`（原样迁自 BFM）
  - `listRemoteModels(opts: { provider: string; baseUrl?; apiKey?; fetchImpl? }): Promise<ModelMeta[]>`
  - `listOllamaModels(baseUrl?: string, fetchImpl?: typeof fetch): Promise<OllamaModel[]>`、`ollamaRoot(baseUrl): string`
  - `registerSecret` / `redact` / `redactDeep`（BFM logger 后续也从这里 import）
  - AiCore 实例增加：`complete(opts)`、`listRemoteModels(opts)`、`listOllamaModels(baseUrl?, fetchImpl?)`、`ollamaRoot(baseUrl)`

- [ ] **Step 1: 复制 redact + 测试**

从 BFM 复制两份文件（内容逐字）：

```bash
cp d:\Seed\bilibili_favorite_manager\server\src\logger\redact.ts d:\Seed\ai_suit_tool\src\core\redact.ts
cp d:\Seed\bilibili_favorite_manager\server\src\logger\redact.test.ts d:\Seed\ai_suit_tool\src\core\redact.test.ts
```

修改 `redact.ts` 顶部注释第一行「日志脱敏 —— C9 的唯一落实点」为「日志脱敏 —— 包内 complete() 与消费方日志共用」，其余一字不动。

- [ ] **Step 2: registry 填完整表 + extend**

把 BFM `server/src/llm/registry.ts` 的 `MODELS` 表（`ark-code-latest` 到 `MiniMax-M2.7` 全部条目）、`ModelProvider` 类型、`FALLBACK`、`listModels` 复制进 `src/core/registry.ts`，替换 Task 3 的壳。增加 `extend` 支持：

```ts
/** 消费方追加模型条目 —— 内置表 + extend 合并（extend 优先） */
export function extendRegistry(extra: Record<string, ModelMeta>): void {
  Object.assign(MODELS, extra);
}
```

`listModels` 一并复制（`provider ? all.filter((m) => m.provider === provider) : all`）。注意 `ModelProvider` 联合类型里的 `'custom'` 等保持原样。

- [ ] **Step 3: provider 补 complete()**

把 BFM `server/src/llm/provider.ts` 的 `languageModel` / `splitPrompt` / `complete` 全部复制进 `src/core/provider.ts`，替换 Task 3 的壳。改动：
- import `./redact.js` 的 `registerSecret`（原来 `../logger/redact.js`）
- import `./context.js` 的 `ChatMessage`（原样）
- `console.log` 的 `[llm]` 前缀保留

- [ ] **Step 4: models / ollama / context**

复制 BFM 三个文件到 `src/core/`：
- `models.ts`：import 改 `./provider.js`、`./registry.js`（原来 `'../...'` 不需要改，本来就在 llm/ 内）
- `ollama.ts`：import 改 `./provider.js`
- `context.ts`：逐字

由于 BFM 的 `llm/models.ts` / `ollama.ts` / `context.ts` 已经在 `server/src/llm/` 目录内（import 是 `./provider.js`），**复制后无需改 import**，直接 `cp` 即可。

- [ ] **Step 5: 测试迁入并修 import**

复制 BFM 的 `models.test.ts` / `ollama.test.ts` / `registry.test.ts` / `provider.test.ts` 到 `src/core/`。这些测试 import `./xxx.js` 的相对路径在包内成立；`provider.test.ts` 若 mock 了 `ai` 或用了 BFM 特有路径，检查并改相对路径。跑 `npm test` 修到全绿。

- [ ] **Step 6: AiCore 实例挂 complete / 模型发现**

`src/core/index.ts` 改为:

```ts
import { complete, type ModelConfig } from './provider.js';
import { listRemoteModels } from './models.js';
import { listOllamaModels, ollamaRoot, type OllamaModel } from './ollama.js';
import { extendRegistry } from './registry.js';
import type { ChatMessage } from './context.js';
import type { ModelMeta, PurposeDef } from '../contract/types.js';
import { createConfigApi, plainSecretCipher, type AiLogger, type KvStorage, type SecretsCipher } from './config.js';

export interface AiCoreOptions {
  purposes: PurposeDef[];
  storage: KvStorage;
  secrets?: SecretsCipher;
  registry?: { extend?: Record<string, ModelMeta> };
  logger?: AiLogger;
  fetchImpl?: typeof fetch;
}

export function createAiCore(opts: AiCoreOptions) {
  const secrets = opts.secrets ?? plainSecretCipher();
  const config = createConfigApi({ purposes: opts.purposes, storage: opts.storage, secrets });
  if (opts.registry?.extend) extendRegistry(opts.registry.extend);

  return {
    ...config,
    complete(opts2: {
      config: ModelConfig;
      messages: ChatMessage[];
      abortSignal?: AbortSignal;
      thinking?: boolean;
      timeoutMs?: number;
      maxOutputTokens?: number;
    }) {
      return complete(opts2);
    },
    listRemoteModels: (o: { provider: string; baseUrl?: string; apiKey?: string; fetchImpl?: typeof fetch }) =>
      listRemoteModels({ fetchImpl: opts.fetchImpl, ...o }),
    listOllamaModels: (baseUrl = '', fetchImpl?: typeof fetch) =>
      listOllamaModels(baseUrl, fetchImpl ?? opts.fetchImpl),
    ollamaRoot,
  };
}

export type AiCore = ReturnType<typeof createAiCore>;
export type { AiLogger, KvStorage, SecretsCipher };
export type { ModelConfig } from './provider.js';
export type { ChatMessage } from './context.js';
export type { OllamaModel } from './ollama.js';
export { redact, redactDeep, registerSecret } from './redact.js';
```

- [ ] **Step 7: 验证 + Commit**

```bash
cd D:\Seed\ai_suit_tool
npm run typecheck
npm test
```

Expected: 全部测试绿（redact / config / models / ollama / registry / provider）。

```bash
git add -A
git commit -m "feat(core): complete 唯一出口 + 模型注册表/发现 + 脱敏迁入"
```

---

### Task 5: fastify 适配器 `src/fastify/`

**Files:**
- Create: `D:\Seed\ai_suit_tool\src\fastify\index.ts`
- Test: `D:\Seed\ai_suit_tool\src\fastify\index.test.ts`

**Interfaces:**
- Consumes: Task 3/4 的 `createAiCore` / `AiCore` 类型、Task 2 的契约类型
- Produces:
  - `registerAiSettings(app: FastifyInstance, opts: { ai: AiCore; logger?: AiLogger; fetchImpl?: typeof fetch }): void`
  - 挂载 §4.2 路由表全部 12 条，响应形状与 BFM 现状逐字段一致

- [ ] **Step 1: 写适配器**

`src/fastify/index.ts` 从 BFM `curator/routes.ts` 的 settings 段（L328-533）迁出，改动点：
- `db` → 全部走 `ai` 实例方法（`listProviders()` 等不再传 db）
- `listOllamaModels(baseUrl, deps.ollamaFetchImpl ?? fetch)` → `ai.listOllamaModels(baseUrl, fetchImpl)`
- ollama 路由写回 `llm.ollama.meta` → `ai.setOllamaMeta(...)`
- `log.event(...)` → `logger.event(...)`（opts.logger 可选，缺省用 `console` 适配器）
- `LlmPurpose`/`PURPOSES` 泛化 → `ai.getAssignments()` 的键就是 purposes

```ts
import type { FastifyInstance } from 'fastify';
import type { AiCore } from '../core/index.js';
import type { AiLogger } from '../core/index.js';
import type { ModelMeta } from '../contract/types.js';

export interface AiSettingsPluginOptions {
  ai: AiCore;
  logger?: AiLogger;
  /** 注入点：Ollama 模型发现的 fetch（测试用假的） */
  fetchImpl?: typeof fetch;
}

const consoleLogger: AiLogger = {
  event: (e) => console.log(`[ai] ${e.level} ${e.category}${e.code ? `:${e.code}` : ''} ${e.message}`),
};

export function registerAiSettings(app: FastifyInstance, opts: AiSettingsPluginOptions): void {
  const { ai } = opts;
  const logger = opts.logger ?? consoleLogger;
  const fetchImpl = opts.fetchImpl ?? fetch;

  app.get('/api/settings/models', async (req) => {
    const provider = (req.query as { provider?: string }).provider;
    return { models: provider ? listModelsFiltered(provider) : listModelsAll() };
  });
  // …（全部 12 条路由，逐条从 BFM routes.ts L328-533 迁入，db→ai 方法）
}
```

路由实现细节（从 BFM 逐字迁，仅替换数据源）：

```ts
  app.get('/api/settings/ollama-models', async (req, reply) => {
    const baseUrl = (req.query as { baseUrl?: string }).baseUrl ?? '';
    try {
      const models = await ai.listOllamaModels(baseUrl, fetchImpl);
      const prev = ai.ollamaMeta();
      for (const m of models) prev[m.name] = { contextWindow: m.contextWindow, maxOutput: m.maxOutput };
      ai.setOllamaMeta(prev);
      return { models };
    } catch (e) {
      let tried = baseUrl;
      try {
        tried = ai.ollamaRoot(baseUrl);
      } catch {
        // 地址本身非法，原样显示更好定位
      }
      return reply
        .code(502)
        .send({ ok: false, reason: `连不上本地 Ollama(${tried}):${(e as Error)?.message ?? e}` });
    }
  });

  app.post('/api/settings/remote-models', async (req, reply) => {
    const body = (req.body ?? {}) as { provider?: string; baseUrl?: string; apiKey?: string };
    if (!body.provider) return reply.code(400).send({ ok: false, reason: '先选服务商' });
    const saved = ai.firstSavedApiKey();
    const apiKey = body.apiKey?.trim() || saved || '';
    try {
      const models = await ai.listRemoteModels({
        provider: body.provider,
        baseUrl: body.baseUrl?.trim() ?? '',
        apiKey,
      });
      return { models };
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      logger.event({ level: 'warn', category: 'llm', code: 'LIST_MODELS_FAILED', message });
      return reply.code(502).send({ ok: false, reason: message });
    }
  });

  app.get('/api/settings/providers', async () => ({
    providers: ai.listProviders().map(({ id, provider, baseUrl, apiKeyEnc }) => ({
      id, provider, baseUrl, hasApiKey: apiKeyEnc !== '',
    })),
  }));

  app.put('/api/settings/providers', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string; provider: string; baseUrl?: string; apiKey?: string };
    try {
      const p = ai.saveProvider(body);
      logger.event({ level: 'info', category: 'llm', message: `服务商凭证已保存:${p.provider}` });
      return { ok: true, id: p.id };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.delete('/api/settings/providers/:id', async (req, reply) => {
    try {
      ai.deleteProvider((req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.get('/api/settings/entries', async () => {
    const providers = ai.listProviders();
    const meta = ai.ollamaMeta();
    return {
      entries: ai.listEntries().map((e) => {
        const provider = providers.find((p) => p.id === e.providerId);
        const ctx = provider
          ? (provider.provider === 'ollama' && meta[e.model]
            ? { ...modelMeta(provider.provider, e.model), ...meta[e.model], verified: true }
            : modelMeta(provider.provider, e.model))
          : modelMeta('custom', e.model);
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
      const e = ai.addEntry({ providerId: body.providerId ?? '', model: body.model ?? '' });
      logger.event({ level: 'info', category: 'llm', message: `模型条目已添加:${e.model}` });
      return { ok: true, id: e.id };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.delete('/api/settings/entries/:id', async (req, reply) => {
    try {
      ai.deleteEntry((req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.get('/api/settings/assignments', async () => ({ assignments: ai.getAssignments() }));

  app.put('/api/settings/assignments', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | null>;
    try {
      for (const purpose of Object.keys(ai.getAssignments())) {
        if (body[purpose] !== undefined) ai.setAssignment(purpose, body[purpose]);
      }
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.post('/api/settings/test-llm', async (req, reply) => {
    const body = (req.body ?? {}) as {
      provider?: string; baseUrl?: string; apiKey?: string; model?: string;
    };
    if (!body.provider || !body.model) {
      return reply.code(400).send({ ok: false, reason: '先选服务商和模型' });
    }
    const saved = ai.firstSavedApiKey();
    const apiKey = body.apiKey?.trim() || saved || '';
    const meta: ModelMeta = modelMeta(body.provider, body.model);
    try {
      const started = Date.now();
      const text = await ai.complete({
        config: {
          id: body.model,
          provider: body.provider,
          baseUrl: body.baseUrl?.trim() ?? '',
          apiKey,
          model: body.model,
        },
        messages: [{ role: 'user', content: '回复两个字:可以' }],
        thinking: false,
      });
      logger.event({
        level: 'info',
        category: 'llm',
        message: `测试连接成功:${body.provider}/${body.model}(${Date.now() - started}ms)`,
      });
      return { ok: true, reply: text.slice(0, 100), contextWindow: meta.contextWindow, maxOutput: meta.maxOutput };
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      logger.event({ level: 'warn', category: 'llm', code: 'LLM_TEST_FAILED', message });
      return reply.code(502).send({ ok: false, reason: message });
    }
  });
```

其中 `listModelsFiltered` / `listModelsAll` / `modelMeta` 三个 helper 放文件底部：

```ts
import { listModels as registryListModels, getModelMeta } from '../core/registry.js';

function listModelsAll(): ModelMeta[] { return registryListModels(); }
function listModelsFiltered(provider: string): ModelMeta[] { return registryListModels(provider); }
function modelMeta(provider: string, model: string): ModelMeta { return getModelMeta(provider, model); }
```

> 注意：`GET /api/settings/models` 路由保留在包内（它是契约的一部分，前端兜底表靠它）。`models.test.ts` 已覆盖 registry，路由不重复测。

- [ ] **Step 2: 写适配器测试（内存 storage + seed）**

`src/fastify/index.test.ts`:

```ts
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiCore, type KvStorage } from '../core/index.js';
import { registerAiSettings } from './index.js';

const PURPOSES = [
  { key: 'proposals', label: '夹子方案生成' },
  { key: 'rules', label: '规则建议' },
  { key: 'tag', label: '打标' },
  { key: 'tagcheck', label: '标签质检' },
];

function memoryStorage(): KvStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k) };
}

async function makeApp() {
  const app = Fastify();
  const storage = memoryStorage();
  const ai = createAiCore({ purposes: PURPOSES, storage });
  // seed：1 凭证（带 key）+ 1 条目 + 全分配
  const p = ai.saveProvider({ provider: 'deepseek', apiKey: 'sk-secret-xyz' });
  const e = ai.addEntry({ providerId: p.id, model: 'deepseek-flash' });
  for (const { key } of PURPOSES) ai.setAssignment(key, e.id);
  await app.register(registerAiSettings, { ai });
  await app.ready();
  return { app, ai };
}

describe('registerAiSettings 路由', () => {
  afterEach(() => {}); // app.close 在各用例内做

  it('providers 不回传明文 key', async () => {
    const { app } = await makeApp();
    const body = (await app.inject({ method: 'GET', url: '/api/settings/providers' })).json();
    expect(JSON.stringify(body)).not.toContain('sk-secret-xyz');
    expect(body.providers[0].hasApiKey).toBe(true);
    await app.close();
  });

  it('PUT providers 无 apiKey 保留已存', async () => {
    const { app } = await makeApp();
    const p = (await app.inject({ method: 'GET', url: '/api/settings/providers' })).json().providers[0];
    const res = await app.inject({
      method: 'PUT', url: '/api/settings/providers',
      payload: { id: p.id, provider: 'deepseek', baseUrl: 'http://x/v1' },
    });
    expect(res.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/settings/providers' })).json();
    expect(after.providers[0].hasApiKey).toBe(true);
    await app.close();
  });

  it('DELETE 被条目引用的凭证 → 400', async () => {
    const { app } = await makeApp();
    const p = (await app.inject({ method: 'GET', url: '/api/settings/providers' })).json().providers[0];
    const res = await app.inject({ method: 'DELETE', url: `/api/settings/providers/${p.id}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('entries 服务端拼好数字', async () => {
    const { app } = await makeApp();
    const body = (await app.inject({ method: 'GET', url: '/api/settings/entries' })).json();
    expect(body.entries[0].contextWindow).toBeTypeOf('number');
    expect(body.entries[0].model).toBe('deepseek-flash');
    await app.close();
  });

  it('test-llm 缺参数 → 400', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/settings/test-llm', payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 3: 验证 + Commit**

```bash
cd D:\Seed\ai_suit_tool
npm run typecheck
npm test
```

Expected: 全绿。

```bash
git add -A
git commit -m "feat(fastify): registerAiSettings 挂载 /api/settings/* 契约路由"
```

---

### Task 6: react 组件 `src/react/`

**Files:**
- Create: `D:\Seed\ai_suit_tool\src\react\client.ts`
- Create: `D:\Seed\ai_suit_tool\src\react\Card.tsx`、`Field.tsx`、`ModelPicker.tsx`、`ProviderCard.tsx`、`EntryCard.tsx`、`PurposeCard.tsx`
- Create: `D:\Seed\ai_suit_tool\src\react\index.tsx`
- Create: `D:\Seed\ai_suit_tool\src\react\tokens.css`
- Modify: `D:\Seed\ai_suit_tool\src\index.ts`（补 react 导出说明——react 侧走 `@seedhuang/ai_suit_tool/react` 子路径，聚合入口不含 react 组件避免纯后端拖 react 类型）

**Interfaces:**
- Consumes: Task 2 契约类型、antd/react（peerDeps）
- Produces:
  - `createAiClient(opts: { baseURL: string; fetchImpl?: typeof fetch }): AiClient`
  - `AiSettingsProvider({ baseURL, fetchImpl, children })` — React context：`useAiClient()` / `useAiReload()`
  - `ProviderCard` / `EntryCard` / `PurposeCard`（props 均为 `{ onDone?: () => void }` 或从 context 自取）

- [ ] **Step 1: client**

`src/react/client.ts`（从 BFM `web/src/api.ts` 的 `llmApi` + `API_BASE` 泛化）:

```ts
import type {
  AssignmentsView, EntryView, ModelMeta, OllamaModelView, ProviderView,
} from '../contract/types.js';

export interface AiClient {
  listModels(provider?: string): Promise<ModelMeta[]>;
  listRemoteModels(input: { provider: string; baseUrl?: string; apiKey?: string }): Promise<ModelMeta[]>;
  ollamaModels(baseUrl: string): Promise<OllamaModelView[]>;
  providers(): Promise<ProviderView[]>;
  saveProvider(input: { id?: string; provider: string; baseUrl?: string; apiKey?: string }): Promise<{ ok: true; id: string }>;
  deleteProvider(id: string): Promise<{ ok: true }>;
  entries(): Promise<EntryView[]>;
  addEntry(input: { providerId: string; model: string }): Promise<{ ok: true; id: string }>;
  deleteEntry(id: string): Promise<{ ok: true }>;
  assignments(): Promise<AssignmentsView>;
  setAssignments(input: Record<string, string | null>): Promise<{ ok: true }>;
  test(input: { provider: string; model: string; baseUrl?: string; apiKey?: string }): Promise<{ ok: true; reply: string }>;
}

export function createAiClient(opts: { baseURL: string; fetchImpl?: typeof fetch }): AiClient {
  const baseURL = opts.baseURL.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`${baseURL}${path}`, init);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error((body as { reason?: string }).reason ?? `请求失败 ${res.status}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return res.json() as Promise<T>;
  }

  function json<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return api<T>(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  }

  return {
    listModels: (provider) =>
      api<{ models: ModelMeta[] }>(`/api/settings/models${provider ? `?provider=${provider}` : ''}`).then((r) => r.models),
    listRemoteModels: (input) =>
      json<{ models: ModelMeta[] }>('POST', '/api/settings/remote-models', input).then((r) => r.models),
    ollamaModels: (baseUrl) =>
      api<{ models: OllamaModelView[] }>(`/api/settings/ollama-models?baseUrl=${encodeURIComponent(baseUrl)}`).then((r) => r.models),
    providers: () => api<{ providers: ProviderView[] }>('/api/settings/providers').then((r) => r.providers),
    saveProvider: (input) => json<{ ok: true; id: string }>('PUT', '/api/settings/providers', input),
    deleteProvider: (id) => json<{ ok: true }>('DELETE', `/api/settings/providers/${id}`),
    entries: () => api<{ entries: EntryView[] }>('/api/settings/entries').then((r) => r.entries),
    addEntry: (input) => json<{ ok: true; id: string }>('POST', '/api/settings/entries', input),
    deleteEntry: (id) => json<{ ok: true }>('DELETE', `/api/settings/entries/${id}`),
    assignments: () => api<AssignmentsView>('/api/settings/assignments').then((r) => r.assignments),
    setAssignments: (input) => json<{ ok: true }>('PUT', '/api/settings/assignments', input),
    test: (input) => json<{ ok: true; reply: string }>('POST', '/api/settings/test-llm', input),
  };
}
```

- [ ] **Step 2: Provider + context + tokens.css**

`src/react/index.tsx`（Provider + context + 导出）:

```tsx
import React, { createContext, useCallback, useContext, useState } from 'react';
import type { AiClient } from './client.js';
import { createAiClient } from './client.js';

const ClientCtx = createContext<AiClient | null>(null);
const ReloadCtx = createContext<() => Promise<void>>(async () => {});

export function AiSettingsProvider({
  baseURL,
  fetchImpl,
  children,
}: {
  baseURL: string;
  fetchImpl?: typeof fetch;
  children: React.ReactNode;
}) {
  const [tick, setTick] = useState(0);
  const client = createAiClient({ baseURL, fetchImpl });
  const reload = useCallback(async () => setTick((t) => t + 1), []);
  // client 随 baseURL 重建；reload 触发重渲染让三卡重新拉数据
  return (
    <ClientCtx.Provider value={client}>
      <ReloadCtx.Provider value={reload}>
        <div key={tick}>{children}</div>
      </ReloadCtx.Provider>
    </ClientCtx.Provider>
  );
}

export function useAiClient(): AiClient {
  const c = useContext(ClientCtx);
  if (!c) throw new Error('useAiClient 必须在 <AiSettingsProvider> 内使用');
  return c;
}

export function useAiReload(): () => Promise<void> {
  return useContext(ReloadCtx);
}

export { ProviderCard } from './ProviderCard.js';
export { EntryCard } from './EntryCard.js';
export { PurposeCard } from './PurposeCard.js';
export type { AiClient } from './client.js';
export { createAiClient } from './client.js';
```

`src/react/tokens.css`（从 BFM `web/src/tokens.css` 复制 AI 三卡用到的变量子集，默认值兜底）:

```css
/* AI 套件默认令牌 —— 消费方可覆盖 */
:root {
  --ai-accent: #1677ff;
  --ai-text-dim: rgba(0, 0, 0, 0.45);
  --ai-warn: #faad14;
  --ai-ok: #52c41a;
  --ai-rule: rgba(0, 0, 0, 0.06);
  --ai-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
```

> BFM 的 `tokens.css` 变量名是 `--accent` / `--text-dim` 等。包内组件用 `--ai-*` 命名空间避免与消费方冲突；BFM 消费时在 `:root` 上把 `--ai-*` 映射到自己的主题（Task 8）。

- [ ] **Step 3: 三卡 + 壳组件**

从 BFM `TaskSettings.tsx` 拆出，轮询/批次逻辑**全部剔除**。壳组件 `Card.tsx` / `Field.tsx` / `ModelPicker.tsx` 从 BFM 复制（`var(--accent)` 改 `var(--ai-accent)` 等）。三卡从 BFM 复制但数据源改为 `useAiClient()` / `useAiReload()`，`llmApi` → `client`，`settingsApi`/`polls` → 删除。

`ProviderCard.tsx` 关键差异（相对 BFM 原文件）：
- `PROVIDERS` 常量保留（服务商下拉是包的默认知识，消费方可接受 props 覆盖——本版先内置，够用）
- `fetchModels` 里的 `API_BASE` → `client.ollamaModels(baseUrl)` / `client.listRemoteModels(...)` / `client.listModels(provider)`
- `llmApi.providers()` → `client.providers()` 等
- `onDone` → `useAiReload()`

`EntryCard.tsx` 同上，去掉 poll 相关。`PurposeCard.tsx` = BFM `AssignCard` 只保留模型分配列（`llmApi.setAssignments` + `client.entries()`），删除轮询/批次下拉、`customBatch`、`POLL_*` 常量、`settingsApi`。

- [ ] **Step 4: 类型检查**

```bash
cd D:\Seed\ai_suit_tool
npm run typecheck
```

Expected: 零错误（react/jsx 类型由 `tsconfig.json` 的 `jsx: react-jsx` 支持）。若 `verbatimModuleSyntax` 对 `.tsx` 报 React 命名空间问题，import 用 `import type React from 'react'` 或按报错调整。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(react): AiSettingsProvider + 凭证/条目/用途三卡 + client"
```

> react 组件暂不写单测（spec §7：靠 BFM 集成验证）。

---

### Task 7: BFM 后端切换（删 llm/ + 用包）

**Files:**
- Modify: `d:\Seed\bilibili_favorite_manager\server\package.json`（加 `@seedhuang/ai_suit_tool`，删 `ai`/`@ai-sdk/deepseek`/`@ai-sdk/openai-compatible`/`@primno/dpapi`——先查引用）
- Modify: `d:\Seed\bilibili_favorite_manager\server\src\http\index.ts`（createAiCore 实例 + registerAiSettings + 传 ai 进 curator 相关 deps）
- Modify: `d:\Seed\bilibili_favorite_manager\server\src\curator\routes.ts`（删 settings 路由段 + 相关 import）
- Modify: `d:\Seed\bilibili_favorite_manager\server\src\curator\proposal.ts`、`proposalRoutes.ts`、`reviewRoutes.ts`、`tagRoutes.ts`、`tagger.ts`、`tagcheck.ts`（`readLlmSettings(db, p)` → `ai.readLlmSettings(p)`；`complete(...)` → `ai.complete(...)`）
- Modify: `d:\Seed\bilibili_favorite_manager\server\src\logger\index.ts`（redact/redactDeep/registerSecret 改从 `@seedhuang/ai_suit_tool/core` import）
- Delete: `d:\Seed\bilibili_favorite_manager\server\src\llm\`（整目录）
- Modify: 6 个 `*.test.ts`（routes / ruleRoutes / tagger / tagRoutes / reviewRoutes / proposalRoutes / tagcheck）的 import 与调用
- Delete: `d:\Seed\bilibili_favorite_manager\server\src\llm\*.test.ts`（随目录删）

**关键设计：BFM 的 ai 实例放哪**

在 `server/src/llm/` 删除后，BFM 需要一个持有 `createAiCore` 实例的模块。建 `server/src/ai.ts`：

```ts
// server/src/ai.ts —— BFM 的 AI 套件实例（单例）
import { createAiCore } from '@seedhuang/ai_suit_tool/core';
import type Database from 'better-sqlite3';
import { getSetting, setSetting, deleteSetting } from './db/repo/state.js';
import { encryptSecret, decryptSecret } from './security/dpapi.js';
import type { Logger } from './logger/index.js';

export const AI_PURPOSES = [
  { key: 'proposals', label: '夹子方案生成' },
  { key: 'rules', label: '规则建议' },
  { key: 'tag', label: '打标' },
  { key: 'tagcheck', label: '标签质检' },
];

const storageOf = (db: Database.Database) => ({
  get: (k: string) => getSetting(db, k),
  set: (k: string, v: string) => setSetting(db, k, v),
  delete: (k: string) => deleteSetting(db, k),
});

export function makeAi(db: Database.Database, log: Logger) {
  return createAiCore({
    purposes: AI_PURPOSES,
    storage: storageOf(db),
    secrets: { encrypt: encryptSecret, decrypt: decryptSecret },
    logger: {
      event: (e) => log.event({ ...e, category: e.category }),
    },
  });
}

export type AiCore = ReturnType<typeof makeAi>;
```

> `Logger.event` 签名是否与 `AiLogger` 兼容需在实现时核对 `server/src/logger/index.ts`；不兼容则在 `makeAi` 里转一层。

**HttpDeps 增加 `ai`**：`createServer(deps)` 里 `registerCuratorRoutes(app, { db, log, ai, ollamaFetchImpl })`；`registerAiSettings` 由 http/index.ts 直接注册（settings 路由不再属于 curator）。

**curator 业务模块改造**：`proposal.ts` / `tagRoutes.ts` 等的 deps 加 `ai: AiCore`，调用 `readLlmSettings(db, 'proposals')` → `ai.readLlmSettings('proposals')`，`complete({...})` → `ai.complete({...})`，`getModelMeta(...)` → 从 `ai` 或 `@seedhuang/ai_suit_tool/core` import。逐个文件在同一次 SearchReplace 里改 import + 调用。

- [ ] **Step 1: 建 ai.ts + 改 http/index.ts**

新建 `server/src/ai.ts`（见上）。改 `server/src/http/index.ts`：
- import 加 `import { makeAi } from '../ai.js';` 与 `import { registerAiSettings } from '@seedhuang/ai_suit_tool/fastify';`
- `HttpDeps` 不需要改（ai 由 makeAi 从 db/log 构造，或加到 deps——选加到 deps 以便测试注入）。**二选一，执行时统一**：本计划选 `HttpDeps` 加 `ai?: AiCore`，`createServer` 内 `const ai = deps.ai ?? makeAi(db, log)`。
- 注册：`registerAiSettings(app, { ai, logger: aiLogger, fetchImpl: deps.ollamaFetchImpl })`
- `registerCuratorRoutes(app, { db, log, ai, ...(deps.ollamaFetchImpl ? { ollamaFetchImpl: deps.ollamaFetchImpl } : {}) })`

- [ ] **Step 2: routes.ts 删 settings 段**

`server/src/curator/routes.ts` 删除 L328-533（模型管理全部路由），同一次 SearchReplace 里把不再使用的 import 清掉：`firstSavedApiKey`、`listProviders/saveProvider/deleteProvider/listEntries/addEntry/deleteEntry/getAssignments/setAssignment/ollamaMeta`、`listModels/getModelMeta/ModelMeta`、`listOllamaModels/ollamaRoot`、`listRemoteModels`、`complete`。保留 `LlmPurpose`/`PURPOSES` 若仍被其余路由使用——检查后按需留。deps 加 `ai: AiCore`（若 settings 段删后 routes.ts 不再直接用 ai，则不加，仅 http/index.ts 用）。

- [ ] **Step 3: 业务模块逐个换**

对 `proposal.ts` / `proposalRoutes.ts` / `reviewRoutes.ts` / `tagRoutes.ts` / `tagger.ts` / `tagcheck.ts`，逐个文件（**每次一个 SearchReplace**）：
- import 行：`import { readLlmSettings } from '../llm/config.js'` → `import type { AiCore } from '../ai.js'`（或从现有 deps 类型引入）
- 函数签名/解构 deps 加 `ai`
- 调用 `readLlmSettings(db, 'rules')` → `ai.readLlmSettings('rules')`；`complete({...})` → `ai.complete({...})`
- 若有 `getModelMeta` 直接调用 → 用 `ai` 或从 `@seedhuang/ai_suit_tool/core` import

- [ ] **Step 4: logger 换 import**

`server/src/logger/index.ts`：`import { redact, redactDeep, registerSecret } from './redact.js'` → `import { redact, redactDeep, registerSecret } from '@seedhuang/ai_suit_tool/core'`。删除 `server/src/logger/redact.ts` 与 `redact.test.ts`（随 Task 8 前端一起确认无引用后删）。

> 先 grep `redact` 在 BFM 的引用：`logger/index.ts` 消费 redact/redactDeep；`provider.ts`（已迁）消费 registerSecret；`redact.test.ts` 自身。确认 bilibili client 或 security 是否也引用，若有则一并改。

- [ ] **Step 5: 删 llm/ 目录 + 依赖清理**

```bash
cd d:\Seed\bilibili_favorite_manager
Remove-Item -Recurse -Force server\src\llm
```

`server/package.json`：加 `"@seedhuang/ai_suit_tool": "file:../ai_suit_tool"` 到 dependencies；删 `ai` / `@ai-sdk/deepseek` / `@ai-sdk/openai-compatible` / `@primno/dpapi`（先 grep 确认 BFM 无引用：`@primno/dpapi` 只剩 `security/dpapi.ts` 用——**保留 dpapi.ts 但依赖进 ai.ts 的 secrets 适配**，所以 `@primno/dpapi` 仍留在 BFM 的 dependencies；`ai`/`@ai-sdk/*` 只被 llm/ 用，删）。

```bash
cd d:\Seed\bilibili_favorite_manager\server
npm install
```

- [ ] **Step 6: 测试文件改造**

`routes.test.ts` / `ruleRoutes.test.ts` / `tagger.test.ts` / `tagRoutes.test.ts` / `reviewRoutes.test.ts` / `proposalRoutes.test.ts` / `tagcheck.test.ts`：
- `import { seedLlm, ... } from '../llm/config.js'` → 从 `../ai.js` 或 `@seedhuang/ai_suit_tool/core`（测试内 `makeAi(db, log)` 或直接 `createAiCore` + memoryStorage）构造实例，传入 `registerXxxRoutes(app, { ..., ai })`
- `readLlmSettings(db, 'x')` → `ai.readLlmSettings('x')`
- 逐个文件修到该目录 tsc 绿 + 对应 vitest 绿

- [ ] **Step 7: 目录级 + 全量验证**

```bash
cd d:\Seed\bilibili_favorite_manager\server
npx tsc --noEmit --pretty 2>&1 | grep "src/curator\|src/http\|src/ai.ts\|src/logger"
npx vitest run
```

Expected: 目标目录零错误；vitest 全绿（settings 路由测试迁到包的 fastify 测试，BFM routes.test.ts 里 settings 段删除）。

> 若 BFM 路由测试里有契约相关用例（providers 不回明文等），**删除**——由包内 `fastify/index.test.ts` + `runContractTests` 覆盖，不留死测试。

---

### Task 8: BFM 前端切换

**Files:**
- Modify: `d:\Seed\bilibili_favorite_manager\web\package.json`（加 `@seedhuang/ai_suit_tool` file: 依赖）
- Modify: `d:\Seed\bilibili_favorite_manager\web\src\pages\index.tsx` 或承载 TaskSettings 的页面（把 AI 三卡换为 `@seedhuang/ai_suit_tool/react` 组件，polls 部分保留自绘）
- Modify: `d:\Seed\bilibili_favorite_manager\web\src\api.ts`（删 `llmApi`）
- Modify: `d:\Seed\bilibili_favorite_manager\web\src\types.ts`（删 AI 相关类型：ModelMeta / ProviderView / EntryView / LlmPurpose / AssignmentsView）
- Modify: `d:\Seed\bilibili_favorite_manager\web\src\components\TaskSettings.tsx`（删迁移走的三卡，保留 poll 配置 UI；或整文件删除，poll UI 迁到消费处）
- Modify: `d:\Seed\bilibili_favorite_manager\web\src\tokens.css` / `global.css`（把 `--ai-*` 映射到现有主题变量）
- Modify: `.umirc.ts`（若 web 需要 transpile node_modules 里的包——umi 默认处理；npm link 的包走 alias，检查 `mfsu`/`esm` 配置，必要时加 `chainWebpack` alias 到 `file:` 包的 src）

- [ ] **Step 1: web 依赖 + 消费组件**

`web/package.json` dependencies 加 `"@seedhuang/ai_suit_tool": "file:../ai_suit_tool"`，`npm install`。

`TaskSettings.tsx` 改为：AI 三卡由包组件承担，poll 部分（轮询/批次下拉）保留为 BFM 自己的卡片。若整卡结构复杂，方案：`TaskSettings` 渲染 `<AiSettingsProvider baseURL={API_BASE}><ProviderCard/><EntryCard/><PurposeCard/></AiSettingsProvider>` + 下方 BFM 自绘的"轮询/批次"卡（从原 AssignCard 的 poll 部分抽出）。轮询/批次卡需要的 `settingsApi.getPolls/setPoll` 保留在 BFM `api.ts`。

- [ ] **Step 2: 删 web 侧死代码**

`api.ts` 删 `llmApi` 整段（含其 import 的类型）。`types.ts` 删 `ModelMeta` / `ProviderView` / `EntryView` / `LlmPurpose` / `AssignmentsView`。若 `api.ts` 其他段引用这些类型，改从 `@seedhuang/ai_suit_tool/contract` import 或用 `import type` 引用包的。

`TaskSettings.tsx` 删迁移走的三卡组件（ProviderCard/EntryCard/AssignCard/Card/Field/ModelPicker/ModelsNote/fetchModels/PROVIDERS）与其 import（antd 部分保留、lucide 部分按需）。

- [ ] **Step 3: 主题映射**

`global.css` 或 `tokens.css` 末尾加：

```css
:root {
  --ai-accent: var(--accent);
  --ai-text-dim: var(--text-dim);
  --ai-warn: var(--warn);
  --ai-ok: var(--ok);
  --ai-rule: var(--rule);
  --ai-font-mono: var(--font-mono);
}
```

- [ ] **Step 4: umi 对 npm link 包的处理**

`web/.umirc.ts` 检查；npm link 的 ESM 包在 umi dev 下若解析失败，加：

```ts
// .umirc.ts
chainWebpack(config) {
  // npm link 的 @seedhuang/ai_suit_tool 指向 ../ai_suit_tool 的源码，umi 默认不走 src，
  // 需要让 webpack 编译它（或 alias 到 dist）
  config.module.rule('mjs-jsx').include?.add(path.resolve(__dirname, '..', 'ai_suit_tool', 'src'));
},
```

> 实际取舍在实现时定：优先让 umi 消费 `dist`（`npm run build` 产物），避免编译 node_modules 源码。`file:` 依赖在 `npm install` 后 node_modules 里是符号链接，umi 的 babel 默认不编译 node_modules——若报错，按上文 chainWebpack include 修复。

- [ ] **Step 5: 验证**

```bash
cd d:\Seed\bilibili_favorite_manager\web
npx tsc --noEmit --pretty 2>&1 | grep "src/pages\|src/components\|src/api.ts\|src/types.ts"
```

Expected: 目标目录零错误。跑 `npm run dev` 手工冒烟设置页三卡 + 轮询/批次卡。

---

### Task 9: BFM 全量验证 + 死代码清零

- [ ] **Step 1: 全量 tsc + vitest**

```bash
cd d:\Seed\bilibili_favorite_manager\server
npx tsc --noEmit --pretty 2>&1
cd d:\Seed\bilibili_favorite_manager\web
npx tsc --noEmit --pretty 2>&1
cd d:\Seed\bilibili_favorite_manager
npm run test  # 根 package.json 的聚合脚本（若有）；否则分别跑 server/web 的 vitest
```

Expected: 只允许出现已知错误清单（app.tsx / 404 / setup/theme.tsx，见项目约定），无新错误；vitest 全绿。

- [ ] **Step 2: 死引用 Grep**

```bash
grep -rn "llm/\|llmApi\|readLlmSettings\|PURPOSES\|registerSecret\|listRemoteModels\|listOllamaModels\|getModelMeta\|firstSavedApiKey" --include="*.ts" --include="*.tsx" server/src web/src
```

Expected: 零命中（`server/src/ai.ts` 里 `createAiCore` 的 import 除外，它 import 的是 `@seedhuang/ai_suit_tool/core`）。

- [ ] **Step 3: 死依赖 Grep**

```bash
grep -rn "from 'ai'\|from \"ai\"\|@ai-sdk/\|@primno" server/src web/src
```

Expected: 零命中（`security/dpapi.ts` 的 `@primno/dpapi` 若被 ai.ts secrets 适配使用则保留，确认其存在于 `server/package.json`）。

- [ ] **Step 4: 冒烟**

```bash
cd d:\Seed\bilibili_favorite_manager\server && npm run dev   # 或项目既有启动方式
cd d:\Seed\bilibili_favorite_manager\web && npm run dev      # 设置页
```

手工验证：设置页三卡增删改查、测试连接、Ollama 模型发现、轮询/批次卡（含主题为 darkAlgorithm）；纯后端启动无 react 报错。

> **2026-09-22 实施后修正**：本条原写「`npm link` 下改包代码 `build:watch` 即时生效」，已作废 —— 实际用 `file:../../ai_suit_tool` + 根 `.npmrc`(`install-links=true`) 的**复制**安装，改包后必须跑刷新配方（见 spec §8）：
> `cd ai_suit_tool && npm run build` → `Remove-Item -Recurse -Force node_modules\@seedhuang\ai_suit_tool` → `npm install`（判据：打印 `added 1 package`）。注意 `npm install` 单独跑**不会**刷新副本，且忘了会**零报错**地用旧 dist。

- [ ] **Step 5: 收尾**

BFM 侧不做 git 提交（项目约定）。确认 `docs/superpowers/specs/2026-09-22-ai-suit-tool-design.md` 与本文档反映最终实现；如 scope 名等待定项已定，回填 spec §10。

---

## Self-Review 记录

- **Spec 覆盖**：§2 三种用法（Task 5 fastify + Task 6 react + Task 2 contract 各自独立可装）✓；§3 exports（Task 1）✓；§4.1 core（Task 3/4）✓；§4.2 路由表 12 条（Task 5）✓；§4.3 react（Task 6）✓；§4.4 contract（Task 2）✓；§5 注入点（Task 3 storage/secrets/purposes、Task 4 redact 内置）✓；§6 阶段 1-6（Task 1/2/3+4/5/6/7+8）✓；§6 阶段 6 不留死代码（Task 7/8/9 删除清单 + Grep 验证）✓；§7 测试（Task 2 contract runner、Task 4 core 单测、Task 5 fastify、Task 9 集成）✓；§8 npm link（Task 1 Step 4、Task 7 Step 5、Task 9）✓；§9 非目标（无浏览器直连 / 无 poll UI 进包 / 无 headless / 无 per-provider）✓。
- **占位符**：无 TBD；`provider.test.ts` / `registry.test.ts` 的完整用例未逐条复制（指令为"从 BFM 复制并修 import"），执行时以 BFM 源文件为准——这是复制而非编写，属可执行指令。
- **类型一致性**：`createAiCore` 在 Task 3 定义、Task 4 扩展、Task 5/6/7 消费，签名前后一致；`registerAiSettings` / `AiSettingsProvider` / `AiClient` 跨任务引用一致；`readLlmSettings(purpose)` 实例方法在 Task 3 产出、Task 7 消费，一致。
