# 移除聊天对话(AI 助手)与 AI 归类链路 — 设计

日期:2026-09-22
状态:已批准(用户确认"执行吧")

## 1. 目标

删除「聊天对话(AI 助手)」与骑在会话上的「AI 归类 / 规则建议 / 审计」整条链路。
**保留**全部独立 AI 辅助决策能力:夹子方案生成、审查、规则、标签(打标 + 质检)。
不留死代码、死导出、死样式、死依赖、死表(前后端一致)。

## 2. 决策依据

- 聊天模块本身是孤岛:`chat.ts` 只被聊天端点引用,方案/审查/标签都不 import 它。
- 真正的耦合点是「归类 / 应用」动作骑在会话 session 上,前端唯一入口是 ChatDrawer。
- AI 建议栏的唯一数据源是归类跑完顺手给的建议(第二个来源 /rules 页已删)。
- 规则 AI 主力(方案生成 + 审查)、标签 AI(打标 + 质检)走独立路由/表/LLM 用途,零耦合。
- 归类已被新能力(三分类 + 规则命中 + tidy 纯本地 0 token)取代,无独立入口,不值得另造入口。

## 3. 删除范围

### 3.1 整文件删除 — Web

| 文件 | 说明 |
|---|---|
| `web/src/components/ChatDrawer.tsx` | 聊天抽屉本体(聊天 + 归类 + 应用) |
| `web/src/components/AIAssistantIcon.tsx` | 顶栏悬浮图标 |
| `web/src/components/assistant.tsx` | AssistantProvider context |
| `web/src/components/Markdown.tsx` | markdown 渲染,唯一消费者是 ChatDrawer |

### 3.2 整文件删除 — Server

| 文件 | 说明 |
|---|---|
| `server/src/curator/chat.ts` | 聊天流 + buildContext |
| `server/src/curator/classifier.ts` | Pass1 / Pass2 归类 |
| `server/src/curator/keyword.ts` | 仅 classifier 引用 |
| `server/src/curator/suggestions.ts` | 规则建议(归类附属) |
| `server/src/curator/audit.ts` | 整理审计 |
| `server/src/db/repo/sessions.ts` | 会话 repo |
| `server/src/db/repo/classifications.ts` | 归类结果 repo |

### 3.3 整文件删除 — 测试

| 文件 | 说明 |
|---|---|
| `chat.test.ts` / `classifier.test.ts` / `keyword.test.ts` / `suggestions.test.ts` / `sessions.test.ts` / `integration.test.ts` | 聊天 + 归类测试 |
| `server/src/llm/context.test.ts` | 测的全是已删函数(batchSize/estimateTokens/trimToContext/RESERVED_FOR_SYSTEM) |
| `server/src/db/migrations.test.ts` | 5 个 describe 全是聊天表断言 |

### 3.4 文件内手术

**`server/src/curator/routes.ts`**
- 删路由:会话 CRUD、`/messages`(聊天流)、`/run-pass-1`、`/run-pass-2`(归类 SSE)、`/apply`、`/classification`、`/context`、`/audit/*`
- 删死 helper:`shapeSession`、`existingFolders`、`requireLlm`
- 删 import:`chat.js`、`classifier.js`、`suggestions.js`、`audit.js`、`sessions.js`、`classifications.js`、`matchAll`、`renderConditions`、`toRuleItem`、`renderProfiles`、`batchSize`、`type ValidSuggestion`
- 保留:`complete`(test-llm 用)、`buildFolderProfiles`(workbench 用)、全部 `/api/settings/*`
- **坑**:`readLlmSettings(db, 'chat')` 在 `remote-models`(apiKey 回落)与 `test-llm`(apiKey 回落)里当"已存凭证"用 → 改为读 `listEntries` 第一条已配置凭证(不依赖任何 purpose)

**`server/src/llm/config.ts`**
- `LlmPurpose` / `PURPOSES` / `PURPOSE_LABELS` 去掉 `'chat'` 与 `'classify'`

**`server/src/llm/provider.ts`**
- 删 `stream` 导出(唯一用户 chat.ts)+ `streamText` import;`complete` 保留
- 顺带清理 `complete` 注释里对聊天的引用(thinking 参数文案)

**`server/src/llm/context.ts`**
- 只留 `ChatMessage` 接口(provider/tagger/tagcheck 用)
- 删:`batchSize` / `estimateTokens` / `trimToContext` / `RESERVED_FOR_SYSTEM` / `EST_TOKENS_PER_ITEM` / `EST_OUTPUT_PER_ITEM`

**`server/src/curator/folderProfile.ts`**
- 删 `renderProfiles`(唯一消费者是归类);`buildFolderProfiles` 保留(审查 + workbench 用)

**`server/src/curator/rules.ts`**
- 删建议机制整段:`validateSuggestion` / `validateSuggestions` / `mergeSuggestions` + `RawSuggestion` / `ValidSuggestion` / `SuggestionCtx`
- 保留:`matchAll` / `matchItem` / `renderConditions` / `toRuleItem`(方案/审查/规则用)

**`server/src/curator/ruleRoutes.ts`**
- 删 `/api/rules/:folderId/adopt` 端点(唯一调用方是前端 `rulesApi.adopt`,随建议栏一起删)

**`server/src/db/schema.ts`**
- 删 5 张表 DDL:`sessions` / `session_messages` / `taxonomy_draft` / `audit_logs` / `classifications`

**`server/src/db/index.ts`**
- 新增幂等 `applyLegacyDrops(db)`:PRAGMA 查存在才 DROP 上面 5 张表;查 `operation_log` 有 `session_id` 列才 `ALTER TABLE DROP COLUMN session_id`(实施前先 grep 确认无保留代码写该列)

**`web/src/layouts/index.tsx`**
- 删 `AssistantProvider` 包裹、`<AIAssistantIcon />`、`<ChatDrawer />` + 3 行 import

**`web/src/pages/curator.tsx`**
- 删 `useAssistant`、「打开 AI 助手」按钮、整段 AI 建议栏、`takeSuggestion` / `dropSuggestion` / `actSuggestion`
- 清理未用 lucide import(`Bot` 必删;`Check`/`Pencil`/`X` 视剩余使用)

**`web/src/api.ts`**
- 删整个 `curatorApi` + `streamMessage` + `classifyStream` + `rulesApi.adopt`
- 更新 `api.ts` 里「无 body 的调用有八个」注释(归档会话/归类已删)
- 清理相关 type import(`FolderSpec` / `RuleSuggestion` / `Pass1Response` / `Pass2Response` / `ProgressPayload` / `SessionDetail` / `SessionSummary` / `AuditReport` / `AuditSummary` / `ChatMessage`)

**`web/src/types.ts`**
- 删:`ChatMessage` / `SessionSummary` / `SessionDetail` / `Assignment` / `FailedBatch` / `TaxonomyProposal` / `ValidationReport` / `FolderSpec` / `AuditReport` / `AuditSummary` / `Pass1Response` / `Pass2Response` / `ProgressPayload` / `RuleSuggestion`
- `LlmPurpose` 去掉 `'chat' | 'classify'`

**`web/src/components/TaskSettings.tsx`**
- `PURPOSE_LABELS` 删 `chat: '聊天'`、`classify: '归类'` 两行(轮询/批次 `POLL_PURPOSES` 本来不含它们,不动)

**`web/src/components/WorkFolderTree.tsx`**
- 默认收藏夹提示文案「请用归类」改为「请展开后单独挑」

**`web/src/global.css`**
- 删:`bfm-spin`、`.bfm-msg`(+ 2 变体)、`.bfm-caret`、两处 `bfm-blink`、`.bfm-md` 整组
- **保留**:`.bfm-drawer`(TaskLogDrawer 共用)、`.bfm-indeterminate`(生成方案进度条)、`--ai` 变量(FolderRuleSection/OperationLog/TagLogDrawer/ReviewDrafts 用)

**`web/package.json`**
- 删 `markdown-it` + `@types/markdown-it`(唯一消费者 Markdown.tsx 已删);`npm install` 刷新 lockfile

### 3.5 测试手术

**`server/src/curator/routes.test.ts`**
- 整段删:会话路由 / 草稿路由 / 发消息 SSE / Pass1 / Pass2 / 应用 AI 结论 / 审计报告
- 模型管理段修:
  - `a.assignments.chat` 断言 → 删/改(用途 map 无此键)
  - PUT `{chat:'m_nope'}` → 改保留用途 key
  - 「用途没分配 → curator 接口 400」测试 → 删(端点没了;proposals 同类 400 已被 proposalRoutes.test.ts 覆盖)
  - `setAssignment/readLlmSettings(db,'chat')` → 改 `'proposals'`
- 删顶部 import:`getLatestDraft` / `getMessages` / `getSession` / `saveClassification` / `getClassification`

**`server/src/llm/config.test.ts`**
- 8 处 `'chat'` → 统一改 `'rules'`(纯机制测试,purpose 无关)

**`server/src/curator/ruleRoutes.test.ts`**
- 删 3 个 adopt 测试(锁定采纳被拒 / 追加条件 origin=ai / 自证不过 400);PUT/DELETE 测试保留

**`server/src/curator/rules.test.ts`**
- 删 `validateSuggestion` / `validateSuggestions` / `mergeSuggestions` 三个 describe + 对应 import;`matchAll` / `renderConditions` 测试保留

**`server/src/llm/provider.test.ts`**
- 删 `describe('stream')` 块 + `streamText` mock + 相关 ReadableStream fixtures

## 4. 保留红线(不可误删)

- `server/src/curator/parse.ts` — 方案/审查/标签四模块共用
- `ChatMessage` 接口(context.ts 内) — provider/tagger/tagcheck 用
- `complete`(provider.ts) — 方案/审查/标签/test-llm 用
- `buildFolderProfiles` — 审查 + workbench 用
- `.bfm-drawer` / `.bfm-indeterminate` / `--ai` — 保留组件用
- 方案生成、审查、规则、标签全链 + 三分类 + tidy + workbench — 零引用聊天,不得改动

## 5. 验证门禁

1. 每编辑一个文件 → `npx tsc --noEmit --pretty 2>&1 | grep "<该文件目录>"`
2. 全部改完 → 全量 `npx tsc --noEmit --pretty`(忽略既有 3 个已知错误:`app.tsx` / `404/index.tsx` / `setup/theme.tsx`)
3. `server` 下 `npx vitest run` 全绿(保留模块测试不许红)
4. `web` 无测试,靠 tsc + 编译通过
5. 禁止并行 SearchReplace 同一文件;import 变更与代码变更合并到同一次 SearchReplace

## 6. 非目标(明确不做)

- 不引入 user_version 迁移框架(用幂等 DROP 助手解决老库)
- 不动方案生成 / 审查 / 标签 / 规则的任何行为
- 不清理 `llm/ollama.ts` / `llm/models.ts` 注释里对已删函数的提及(仅注释,低价值,避免无关改动)
