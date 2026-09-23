# AI 公共套件抽取 — 设计文档（2026-09-22）

> 目标仓库：`D:\Seed\ai_suit_tool`（独立仓库，非 monorepo）
> 消费方：`bilibili_favorite_manager`（第一个真实消费者），后续新项目

## 1. 背景与目标

BFM 中散落着 AI 相关能力：后端 `server/src/llm/` 已是一层相当完整的 LLM 通用层（三层配置 + 唯一请求出口 + 模型注册表），前端 `web/src/` 有对应的配置 UI（TaskSettings.tsx）和 API 封装（llmApi）。后续会有新项目同样需要"AI 配置 + AI 请求"能力。

目标：把这些能力抽取成一个**可发布的 npm 包**，开箱即用，支持三种用法。

## 2. 三种用法（核心验收标准）

| 用法 | 消费方安装 | 做什么 |
|---|---|---|
| 前后端合起来 | `@seedhuang/ai_suit_tool` | Fastify 插件挂 `/api/settings/*` 路由 + React 组件直接拼出完整设置页 |
| 纯后端 | `@seedhuang/ai_suit_tool/core` + `@seedhuang/ai_suit_tool/fastify` | 只拿配置存储 + 模型请求能力，自带配置管理路由，无前端 |
| 纯前端 | `@seedhuang/ai_suit_tool/react` + `@seedhuang/ai_suit_tool/contract` | 只拿设置 UI + API client，接入**任何实现了契约的后端**（跑契约测试自证合规） |

安全模型统一：**API Key 只存在于服务端**（可选加密存储），浏览器永不接触明文 key。前端包不提供"浏览器直连 AI 厂商"模式——真实厂商 CORS 放不下，且 key 暴露给浏览器是安全倒退。

## 3. 包形态：单包 + exports 子路径

`ai_suit_tool` 是**一个**可发布 npm 包，用 exports 划分前后端与契约。**不是 monorepo**。

```jsonc
// ai_suit_tool/package.json（结构示意，scope 已定：@seedhuang）
{
  "name": "@seedhuang/ai_suit_tool",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".":            { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./core":       { "types": "./dist/core/index.d.ts", "default": "./dist/core/index.js" },
    "./fastify":    { "types": "./dist/fastify/index.d.ts", "default": "./dist/fastify/index.js" },
    "./react":      { "types": "./dist/react/index.d.ts", "default": "./dist/react/index.js" },
    "./contract":   { "types": "./dist/contract/index.d.ts", "default": "./dist/contract/index.js" },
    // 契约自证 runner 专用子路径：它 import vitest，所以单独开一条，
    // 让生产入口 ./contract 保持零运行时依赖（见 §4.4）
    "./contract-tests": {
      "types": "./dist/contract/runContractTests.d.ts",
      "default": "./dist/contract/runContractTests.js"
    },
    "./tokens.css": "./src/react/tokens.css"
  },
  "peerDependencies": {
    "react": ">=18",
    "react-dom": ">=18",
    "antd": ">=5",
    "@ant-design/icons": ">=5"
  }
}
```

> 2026-09-23 实施后回填：`./contract-tests` 与 `@ant-design/icons` 是实施中补的两项 —— 前者为了守住 `./contract` 的零依赖（自证 runner 要 import vitest），后者是三卡图标的直接来源。

- `react` / `react-dom` / `antd` / `@ant-design/icons` 是 peerDependencies：纯后端项目安装不会拖上 React；`@ant-design/icons` 由三卡（`ProviderCard` / `EntryCard` / `PurposeCard`）直接 import，纯前端消费方**必须**提供
- `./contract-tests` 只服务"想跑契约自证"的消费方，不跑自证的人不引它，也就不会被拖上 vitest
- 一个版本号 = 一份契约 = 前后端永远对齐（对比多包方案省掉跨包版本协调）
- 运行时依赖：`ai`（Vercel AI SDK）、`@ai-sdk/deepseek`、`@ai-sdk/openai-compatible`

## 4. 公开接口

### 4.1 `@seedhuang/ai_suit_tool/core` — 框架无关后端核心

```ts
import { createAiCore } from '@seedhuang/ai_suit_tool/core';

const ai = createAiCore({
  purposes: [
    { key: 'proposals', label: '夹子方案生成' },
    { key: 'rules',     label: '规则建议' },
    // 消费方任意定义
  ],
  storage: myKvStorage,           // 必填：{ get, set, delete } 三方法
  secrets: dpapiSecrets,          // 可选：{ encrypt, decrypt }；不传 = 明文存储（测试/无敏感场景）
  registry: { extend: myModels }, // 可选：追加模型条目
});

// 消费方业务代码：
const s = ai.readLlmSettings('rules');          // null = 该用途未配置
await ai.complete({ config: s.config, messages, timeoutMs, abortSignal, thinking });
```

### 4.2 `@seedhuang/ai_suit_tool/fastify` — 后端适配器

```ts
import { registerAiSettings } from '@seedhuang/ai_suit_tool/fastify';
await app.register(registerAiSettings, { ai });   // 挂载 /api/settings/* 全套路由
```

路由清单（原样迁自 `curator/routes.ts`）：

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/api/settings/models` | 内置注册表（provider 过滤） |
| POST | `/api/settings/remote-models` | 厂商 `/models` 发现（key 走 body） |
| GET | `/api/settings/ollama-models` | 本地模型发现 |
| GET | `/api/settings/providers` | 凭证列表（**只回 hasApiKey，永不回明文**） |
| PUT | `/api/settings/providers` | 新建/更新凭证（无 apiKey = 保留已存） |
| DELETE | `/api/settings/providers/:id` | 被条目引用时 400 |
| GET | `/api/settings/entries` | 条目列表 |
| POST | `/api/settings/entries` | 新建条目（首条自动全分配） |
| DELETE | `/api/settings/entries/:id` | 被用途引用时 400 |
| GET | `/api/settings/assignments` | 用途分配 |
| PUT | `/api/settings/assignments` | 更新用途分配 |
| POST | `/api/settings/test-llm` | 连接测试 |

### 4.3 `@seedhuang/ai_suit_tool/react` — 前端组件

```tsx
import { AiSettingsProvider, ProviderCard, EntryCard, PurposeCard } from '@seedhuang/ai_suit_tool/react';
import '@seedhuang/ai_suit_tool/tokens.css';

<AiSettingsProvider baseURL="http://127.0.0.1:3001">
  <ProviderCard />   {/* 凭证：key 只存服务端、永不回明文 */}
  <EntryCard />
  <PurposeCard />    {/* 只管模型分配；不包含轮询/批次 */}
</AiSettingsProvider>
```

- `AiSettingsProvider` 接受 `baseURL`（必填，替换现在硬编码的 `127.0.0.1:3001`）与可选 `fetchImpl`
- `PurposeCard` 只做模型分配——BFM 里 AssignCard 混着的轮询间隔/批次大小是**本项目业务**，不进包
- 样式用默认 CSS 变量（迁自 tokens.css），可覆盖

### 4.4 `@seedhuang/ai_suit_tool/contract` — 契约层（零依赖）

- 类型：`ModelMeta` / `ProviderView` / `EntryView` / `PurposeDef` / `AssignmentsView`（迁自 web/src/types.ts）
- 端点契约：路由表 + 请求/响应类型（迁自 llmApi + 服务端形状）
- 契约测试 runner：`runContractTests({ baseUrl })` 产出标准 vitest 用例，入口是 `@seedhuang/ai_suit_tool/contract-tests`（见下）

> 2026-09-23 实施后回填（本节原稿与此两处不符，以实现为准）：
> - 类型 `LlmPurpose` 泛化成了 `PurposeDef`（即 `{ key, label }`）：用途是业务语义，由消费方在 `createAiCore({ purposes })` 里声明，包不内置固定联合类型。`runContractTests` 拿到的 assignments 键集合就是消费方声明的那组 purpose。
> - runner 从 `./contract` 拆到 `@seedhuang/ai_suit_tool/contract-tests`：生产入口 `./contract` 只有 types + endpoints（零运行时依赖，**不引 vitest**），`runContractTests` 是唯一 import vitest 的模块，所以单独一条子路径。消费方在自己的 vitest 文件顶层调 `runContractTests({ baseUrl })` 即注册全部契约用例。

## 5. 注入点（为什么这样切）

现有代码焊死的三个"环境假设"拆成注入：

| 现状焊死 | 抽出后 | 解决问题 |
|---|---|---|
| `better-sqlite3` KV | `storage: { get, set, delete }` | 包零 Node 存储依赖；sqlite/文件/electron-store 皆可 |
| Windows `@primno/dpapi` | `secrets?: { encrypt, decrypt }` | DPAPI 是 Windows-only，发布后 Linux/Mac 装不上；加密必须随消费方 |
| 四个硬编码用途 | `purposes: [{ key, label }]` | 用途是业务语义；包只管"按 key 分配、按 label 报错" |
| `logger/redact.ts` 的 `registerSecret` | **内置进 core（非注入）** | 脱敏是 AI 安全关键（C9）：key 每次调用前登记、日志入口按值抹掉。`complete()` 依赖它，这个机制必须随调用能力一起进包，不能留给消费方 |

协议层保持不变（这是核心设计资产）：只认 **DeepSeek 官方包 + OpenAI 兼容**（覆盖 Ollama / 方舟 / MiniMax / 任意自定义端点）。"Coding Plan" 不是特殊机制，只是某个 provider 下的一组模型条目——任何家的 coding plan 只要暴露 OpenAI 兼容端点就能配。**加 provider = 注册表加默认地址 + 模型数字，不写适配器。**

本地模型（Ollama 等）是一等公民：走 OpenAI 兼容协议，模型发现用本地实时接口，上下文数字用运行时 `/api/show` 真值。

## 6. 迁移步骤

### 阶段 1：搭 ai_suit_tool 骨架
- package.json（exports 子路径、peerDeps、运行时依赖）
- tsconfig（strict + noUncheckedIndexedAccess，ESM，declaration 输出 dist）
- vitest.config.ts

### 阶段 2：契约层 `src/contract/`
- 类型迁自 `web/src/types.ts`（AI 相关部分）
- 契约测试 runner（不变量迁自 `curator/routes.test.ts`）

### 阶段 3：后端核心 `src/core/`
- `llm/config.ts` → 泛化：storage/secrets/purposes 注入；`readLlmSettings` / `firstSavedApiKey` 原样
- `llm/provider.ts` → `complete()` 原样搬（超时/中止/thinking/脱敏/日志全保留）
- `llm/registry.ts` → 内置表 + `extend`
- `llm/models.ts` / `llm/ollama.ts` / `llm/context.ts` 原样搬

### 阶段 4：fastify 适配器 `src/fastify/`
- `curator/routes.ts` 的 settings 路由段（清单见 §4.2）→ `registerAiSettings(app, { ai })`
- db 访问改走注入的 storage
- **`/api/settings/polls` 两个路由不迁**——轮询间隔/批次大小是 BFM 业务（批次任务 UX），留在 BFM 的 `curator/settingsPolls.ts`

### 阶段 5：前端 `src/react/`
- `TaskSettings.tsx` 拆出 ProviderCard / EntryCard / PurposeCard（952 行 → 三组件 + Provider 壳）
- `llmApi` → 可注入 baseURL/fetchImpl 的 client
- 样式 → `tokens.css`（默认 CSS 变量）
- polls/批次部分**留在 BFM**，不进包

### 阶段 6：BFM 切换消费（**迁移完成的原代码彻底删除，不留死代码**）

> 硬约束：被迁移的代码从 BFM 删干净，死导出 / 死 import / 死样式 / 死依赖 / 死测试一个不留。迁移不是"复制过去"而是"搬走"——包里的每一行都必须在 BFM 里找到对应的删除。

- `server/package.json` / `web/package.json` 加 `@seedhuang/ai_suit_tool` 依赖（npm link）
- **BFM 删除清单**：
  - `server/src/llm/` 整目录删除（config / provider / registry / models / ollama / context / 全部 `*.test.ts`）
  - `server/src/curator/routes.ts` 中迁移走的 settings 路由段删除；`buildFolderProfiles` 若仅此处用则一并删（先查引用再删）
  - `server/src/http/index.ts`：settings 路由注册改为 `registerAiSettings(app, { ai })`
  - `server/src/logger/redact.ts` 迁出的脱敏部分清理（如 registerSecret 只剩 AI 用，整段删除）
  - web 侧：`TaskSettings.tsx` 迁移走的三卡相关代码删除（无剩余内容则整文件删）；`llmApi` 删除；`types.ts` 中迁走的类型删除（ModelMeta / ProviderView / EntryView / LlmPurpose / AssignmentsView）；`tokens.css` 迁走的样式变量删除
  - 测试：随代码迁移走的后端测试从 BFM 删除（config / provider / models / ollama / registry 的 `*.test.ts`、`routes.test.ts` 中的 settings 路由段、`llm/` 相关契约断言）
  - `package.json` 移出随包走的依赖：`ai`、`@ai-sdk/deepseek`、`@ai-sdk/openai-compatible`、`@primno/dpapi`（先确认 BFM 其余代码不再引用再移除）
- **删除纪律（沿用本项目 remove-chat-ai-assistant 的既有约定）**：按依赖逆序推进，每删一步跑目录级 `tsc` 检查，不允许出现"先拆坏再补"的中间态；删完跑一次无 grep 的全量 `tsc --noEmit` 捕获跨文件连锁错误
- 验证：BFM 全量 `npx tsc --noEmit` + `vitest run` 全绿；Grep 确认被迁移的符号在 BFM 内**零引用**；设置页三种模式手工冒烟

## 7. 测试策略

| 层 | 做法 |
|---|---|
| 契约测试（进包） | `runContractTests({ baseUrl })`；不变量：providers 永不回明文 key、PUT 留空保留已存、DELETE 被引用 400、首条自动分配、baseUrl 校验 |
| core 单测（进包） | 现有 config/provider/models/ollama/registry 测试迁入，storage/secrets 用 mock 注入 |
| react 组件 | 暂不写单测（BFM 前端无既有测试），靠 BFM 集成验证 |
| BFM 验证 | 全量 tsc + vitest 全绿；迁移走的测试随代码一起从 BFM 删除（不留死测试）；设置页三种模式手工冒烟 |

## 8. 引用方式（2026-09-22 实施后回填：改用 file: 依赖，弃用 npm link）

**调试/开发期：`file:` 依赖 + 复制安装**

```jsonc
// bilibili_favorite_manager/web/package.json 与 server/package.json
"@seedhuang/ai_suit_tool": "file:../../ai_suit_tool"
```

```bash
// 仓库根 .npmrc
install-links=true
```

- 包在 `D:\Seed\ai_suit_tool`，与 BFM 仓库**同级**，故路径是 `../../ai_suit_tool`（不是 `../`）
- `.npmrc` 的 `install-links=true` 让 `file:` 依赖按**复制**安装而非 junction —— 否则 webpack 会沿真实路径逐级向上解析，命中包目录自带的 `node_modules`（antd / react 各一份），同一个 `antd/es/button/button.js` 出现两个模块实例，antd 主题 context 失效（三卡读不到 `darkAlgorithm`，退回浅色）
- 这也让本地语义**提前对齐**"从 registry 安装"的复制语义（终局形态），消除"本地好、发出去双实例"的陷阱

**为什么不用 npm link**：link 产物是 symlink，webpack 同样会解析到包目录自带的 `node_modules`，踩同一个多副本问题；且 link 依赖机器全局状态、不可 clone 复现。`file:` 是声明式的。

**改包后如何刷新消费方副本**（实测结论，2026-09-22）：

```bash
cd D:\Seed\ai_suit_tool && npm run build      # exports 指向 dist，必须先构建
cd D:\Seed\bilibili_favorite_manager
Remove-Item -Recurse -Force node_modules\@seedhuang\ai_suit_tool
npm install                                   # 成功判据：打印 "added 1 package"
```

**`npm install` / `--force` / `npm update` 都不会刷新副本** —— lock 里该条目只有 `version: 0.1.0` + `resolved: file:../ai_suit_tool`、**没有 integrity**，版本号未变时 npm 认为节点已满足直接跳过（`--force` 只改策略位、不改过期判定）。因此必须显式删掉副本目录再装。**风险**：忘跑配方时**零报错**，BFM 静默使用旧 `dist`。

**稳定后：发布 + 版本号**

```bash
npm publish   # 或私有 registry
cd bilibili_favorite_manager && npm install @seedhuang/ai_suit_tool@^1.0.0
```

发布后即可删除根 `.npmrc`（它是开发期桥接，只为 file: 依赖服务）。

## 9. 非目标（YAGNI）

- ❌ 不做"浏览器直连 AI 厂商"模式（key 暴露 + 厂商 CORS 不支持）
- ❌ 不提供轮询/批次配置 UI（BFM 业务，非 AI 公共能力）
- ❌ 不为未来未知消费者预先抽象 headless 层——按 React + antd / Node 做实，接口留缝
- ❌ 不做 per-provider 适配器（协议只认 DeepSeek 官方 + OpenAI 兼容）
- ❌ 迁移后 BFM 不留任何死代码：被迁移的模块从 BFM 删干净（死代码 / 死依赖 / 死样式 / 死测试），不允许留"已迁移但还挂着"的残骸（详见 §6 阶段 6）

## 10. 待定项

- ✅ 已定：npm 包 scope 名为 `@seedhuang`（包名 `@seedhuang/ai_suit_tool`）
- 发布目标：公开 npm 还是私有 registry（GitHub Packages / 私有源）
- 包版本起始号
