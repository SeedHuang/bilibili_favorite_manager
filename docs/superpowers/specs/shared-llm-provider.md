## 3. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node 22.12 / npm 10.9 | 已验证本机环境(若用 DeepSeek Harness 需升 22.19,但**本方案不用 harness**) |
| 后端 | Fastify 5.12.4 | 轻、内置 pino、原生 SSE |
| 数据库 | better-sqlite3 **12.11.1** | 同步 API,无构建链。`node:sqlite` 在 Node 22.12 尚未开放。**不用 13.x** —— 实测其 win32 预编译二进制在本机 dlopen 段错误 |
| 前端 | `@umijs/max` 4.7.17 + **antd 5** | 用户指定 umi/max + AntD |
| 图标 | `lucide-react`(静态)+ `morphicons`(状态形变) | 见 §11.6。**不用 `@ant-design/icons`** |
| **LLM** | **Vercel AI SDK(`ai@7.x`)+ `@ai-sdk/deepseek`** | **官方 DeepSeek provider,成熟稳定(7.x),非预发布** |
| 检索 | SQLite FTS5 | 跨夹子全文搜索 |

### ⚠️ antd 版本冲突

`@umijs/max@4.7.17` 内置的 antd 插件锁定 `antd@^4.20.6`,而当前最新是 antd 6。
**方案**:`.umirc.ts` 里设 `antd: false` 关掉内置插件,自己装 **antd 5**(生态最稳,
pro-components 都在 5 上)。

### LLM Provider 配置 —— 用 Vercel AI SDK

**决策(2026-09-14,用户拍板)**:不用自研 LLM 客户端,改用 **Vercel AI SDK**。

理由(用户明确提出,认同):
- **自研的可用性、扩展性、兼容性无法保证** —— 自己写几百行 `llm/` 层,和一个被大量项目使用、有完整生态的 SDK 差距是实打实的
- **`@ai-sdk/deepseek` 官方包存在**(版本 3.0.44,已实测确认) —— DeepSeek 模型直接用,不用适配
- **`ai@7.x` 成熟稳定**(非预发布),不像 DeepSeek Harness 是 `0.1.x-rc`、快速迭代、可能破坏兼容
- 我们的前端已是 Umi + React → AI SDK 的 `useChat` / `useCompletion` hooks 天然融合

**淘汰的方案**:~~DeepSeek Harness~~(评估后放弃:它是完整 agent 平台,`engines` 要求 Node ≥22.19,
需升级 Node,且预发布不稳定。作为"给 agent 套 UI"的平台它很强,但对我们"嵌一块 AI 进现有 App"
的场景过重);~~自研 OpenAI 兼容客户端~~(可用性/扩展性无保证)。

**用法**:

```ts
// 后端:结构化调用(分类批处理)
import { generateText } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });
const { text } = await generateText({
  model: deepseek('deepseek-v4-flash'),
  prompt: '...',
});
```

```tsx
// 前端:流式对话(/curator 输入框)
import { useChat } from 'ai/react';
const { messages, input, handleInputChange, handleSubmit } = useChat();
```

**模型选择**:`@ai-sdk/deepseek` 支持 `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro`,
支持 `thinking` / `reasoningEffort`(DeepSeek 推理模式)。也支持 `@ai-sdk/ollama`(本地模型,以后要本地跑就加这个,业务代码不动)。

### 多模型接入层(2026-09-15 用户扩展,可插拔)

**核心原则**:一切模型走 **OpenAI 兼容 `/chat/completions`** 或 **Anthropic 兼容**,
一个通用客户端 + 一个**模型注册表**覆盖全部 provider —— 不写 per-provider 适配器。

```ts
interface ModelMeta {
  provider: 'ollama' | 'ark' | 'deepseek' | 'minimax' | 'anthropic-compatible' | 'custom';
  model: string;            // 调用时填的模型名
  contextWindow: number;    // 输入上下文(token)
  maxOutput: number;        // 最大输出(token)
  verified: boolean;        // false = 默认值/估算,UI 显眼标 ⚠️ 待确认
  note?: string;            // 附加说明(如"方舟端限 128K")
}

interface ModelConfig {
  id: string;              // 显示名
  baseUrl: string;
  apiKey: string;
  model: string;
  // provider 由选中模型的元数据决定
}
```

### 模型注册表(初始默认值,UI 可改)

**数据来源标注**:官=官方文档;测=第三方实测;估=估算默认值。`verified:false` 的一律 UI 标 ⚠️ 待确认。

| 模型 | 输入上下文 | 最大输出 | 来源 | 备注 |
|---|---|---|---|---|
| `ark-code-latest`(火山 Coding Plan) | 256K | 32K | 官 | 实际模型由控制台选定 |
| `claude-sonnet-4.5`(火山 Coding Plan) | 200K | 64K | 官 | 1M 需 Beta |
| `claude-opus-4.1`(火山 Coding Plan) | 200K | 64K | 官 | |
| `doubao-seed-evolving` | 1024K | 256K | 测 | ⚠️ 输出与输入同量级 |
| `doubao-seed-2.1-turbo` | 256K | 256K | 测 | |
| `doubao-seed-2.0-lite` | 256K | 128K | 测 | |
| `minimax-m3` | 1024K | 128K | 测 | 方舟端限 128K(M3 原生更大) |
| `glm-5.3` | 1024K | 128K | 测 | |
| `glm-5.3-flash` | 1024K | 128K | 测 | |
| `deepseekk-v4-flash` | 1024K | 384K | 测 | |
| `deepseek-v4-pro` | 1024K | 384K | 测 | |
| `kimi-k2.7-code` | 256K | 32K | 测 | K2.7 ≠ K3 |
| `kimi-k3` | 1024K | 128K | 测 | |
| `deepseek-chat` | 128K | 8K | 官 | DeepSeek 普通 API |
| `deepseek-reasoner` | 128K | 8K | 官 | DeepSeek 普通 API |
| `MiniMax-M2.7` | 204.8K | 8K(估) | 官/估 | MiniMax 直连 |

**本地 Ollama 模型不入表** —— 运行时调 `/api/show` 拿 `context_length` 等真实值,自动 `verified:true`。

**⚠️ 待补**:MiniMax Coding Plan 专属模型清单(用户待确认截图后补)。

### 上下文自适应(多模型可扩展的关键)

分类引擎**不硬编码批次大小**,而是按当前选中模型的 `contextWindow` 动态算:

```ts
// 每条收藏约 200~300 token(标题+简介+UP+时长)
const estTokensPerItem = 250;
const reservedForSystem = 1500;  // system prompt + 体系规则 + 输出预留
const batchSize = Math.floor((contextWindow - reservedForSystem) / estTokensPerItem);
// 本地 14b(32K)≈ 120 条/批;DeepSeek(128K)≈ 500 条/批;1M 上下文可一次全塞
```

**超限兜底**:不管模型多大,只要 `batchSize * estTokens > maxOutput` 就**自动分多批**。
这样任何模型都能跑,只是批次数不同。

### UI:模型管理页(settings 内)

```
选服务商 ▾(Ollama / 火山方舟 / DeepSeek / MiniMax / 自定义)
  → 列该服务商的模型(本地实时拉,Ollama 自动 verified)
  → 选模型 → 自动填 contextWindow / maxOutput(可编辑)
  → 标 ⚠️ 若 verified=false
  →「测试连接」按钮 → 发最小请求验证
  →「保存」
```

**校验**:`contextWindow > 0 && maxOutput > 0`,否则不能保存(防 0 提交崩溃)。

### 本地模型选择(RTX 4090 / 24GB,2026-09 决定)

**默认本地主力 = `qwen2.5:14b`(Q4 量化,~9-10GB)**。理由:

- 任务本质是**中文语义理解 + 稳定 JSON 输出**,不是复杂推理 —— 不需要 32B
- **14B 在 24GB 上留足显存余量**(权重 ~10GB)→ 不 OOM、速度快、批量分类稳
- 32B Q4(~19GB)在 24GB 上贴边,KV cache + 运行时一上来就危险,批量任务中断代价高
- **"跑得稳 > 理论智商高一点"** —— 批量、结构化场景下这是硬道理

**备用升级**:若 14B 在"发现 42 个夹子可合并"这种结构洞察上不够,可试 `qwen3:30b` 或 27B 级
(Q4_K_M ~17GB)。但**当前不选它** —— 稳定性优先。

**⚠️ 踩坑记录**:曾有外部模型建议 `Qwen3.8-27B` —— **该型号在 Ollama registry 不存在(404)**。
外部答案要逐条核实,不能因为论证专业就盲信细节。

**切换策略**:本地 `qwen2.5:14b` 作隐私/离线主力,云端 DeepSeek 作能力更强的备选。
切换 = 在模型管理页换选中模型,业务代码不变。

> **对本项目各部分的连锁影响**:
> - `server/src/llm/` 目录不再需要自研客户端 → M4 直接用 AI SDK,`llm/` 层降级为"薄配置层"
> - M4 的两遍分类引擎用 `generateText`(结构化 JSON 输出 + schema 校验)替代自拼 HTTP
> - `/curator` 的对话块用 `useChat`(前端流式)
> - C6(LLM 输出结构化 + 可重试)不变 —— AI SDK 的 `generateObject` / `experimental_` 校验替代自研兜底

