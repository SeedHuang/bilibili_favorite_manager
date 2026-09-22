# 移除聊天对话(AI 助手)与 AI 归类链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除聊天对话 + AI 归类/规则建议/审计整条链路,前后端不留死代码、死导出、死样式、死依赖、死表,同时保证方案生成/审查/规则/标签等保留模块零行为变化。

**Architecture:** 删除按"依赖逆序"推进:先 DB,再后端路由手术 → 叶子模块删除 → LLM 通用层清理 → 规则孤儿链,再前端整体清理,最后门禁复跑。每任务结束 tsc 与受影响的 vitest 必须绿,不允许出现"先拆坏再补"的中间态。

**Tech Stack:** TypeScript / Fastify / better-sqlite3 / vitest / React(umi) / antd / lucide-react

**Spec:** `docs/superpowers/specs/2026-09-22-remove-chat-ai-assistant-design.md`

## Global Constraints

- 不自动 `git add` / `git commit`(沿用本项目既有约定);验证靠 `tsc` + `vitest`。
- **同一文件禁止并行 SearchReplace**;import 变更与代码变更必须在同一次 SearchReplace 内完成。
- 每编辑一个 `.ts/.tsx` 文件后立即跑 `npx tsc --noEmit --pretty 2>&1 | grep "<该文件所在目录>"` 检查该目录编译错误;全部完成后跑一次不带 grep 的全量 `npx tsc --noEmit --pretty`。
- 忽略既有的 3 个已知编译错误(非本次引入):`src/app.tsx`(location)、`src/pages/404/index.tsx`(back)、`src/setup/theme.tsx`(token)。
- 门禁:`server` 下 `npx vitest run` 全绿;`web` 无测试,靠 `npx tsc --noEmit` + `max build`("Compiled successfully" 视为 exit 1 通过)。
- 保留红线(不可删):`server/src/curator/parse.ts`、`ChatMessage` 接口、`complete`(provider.ts)、`buildFolderProfiles`、`.bfm-drawer`、`.bfm-indeterminate`、`--ai` 变量、方案/审查/标签/规则全链 + 三分类 + tidy + workbench。

---

### Task 1: DB 清表 — schema DDL 移除 + 幂等 DROP 助手

**Files:**
- Modify: `server/src/db/schema.ts`(删 5 张表 DDL 块)
- Modify: `server/src/db/index.ts`(加 `applyLegacyDrops` 并在 `applySchema` 末尾调用)
- Delete: `server/src/db/migrations.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `db/index.ts` 新增 `applyLegacyDrops(db: Database.Database): void`,`applySchema` 内部自动执行;后续任务不依赖它。

- [ ] **Step 1: 删 schema.ts 里 5 张聊天表 DDL**

`server/src/db/schema.ts` 从 `-- M4 AI 整理 增量 schema(2026-09-15)` 到 `classifications` 表结束(含 `idx_msg_session` 索引)整块删除。精确锚点:以注释行 `-- M4 AI 整理 增量 schema(2026-09-15)` 为起点,到 `classifications` 表的 `failed_json` 列定义及后续字段为止(保留其后的 `work_state` 表注释)。被删的 DDL:`sessions`、`session_messages`(+`idx_msg_session`)、`taxonomy_draft`、`audit_logs`、`classifications`。

- [ ] **Step 2: 改 db/index.ts — 加幂等 DROP 助手**

在 `db/index.ts` 里,`ensureColumn` 之后新增(沿用"PRAGMA 查存在才动手"的幂等风格,不引入迁移框架):

```ts
/**
 * 删掉聊天/归类时代遗留的表与列,幂等。
 *
 * 这些表(Chat 子系统)已整体移除;新库的 SCHEMA_SQL 里根本没有它们,
 * 老库里的则是空表 + 一个恒 null 的列 —— 一并 DROP,不留孤儿。
 * 沿用 ensureColumn 的套路:先查存在与否,不存在就不动(幂等,可反复跑)。
 */
const LEGACY_CHAT_TABLES = ['sessions', 'session_messages', 'taxonomy_draft', 'audit_logs', 'classifications'] as const;

function tableExists(db: Database.Database, name: string): boolean {
  return (
    (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name) as
      | Record<string, unknown>
      | undefined) !== undefined
  );
}

function applyLegacyDrops(db: Database.Database): void {
  for (const t of LEGACY_CHAT_TABLES) {
    if (tableExists(db, t)) db.exec(`DROP TABLE ${t}`);
  }
  // operation_log.session_id 只被已删的 apply 端点写过,删后恒 null → 也清掉。
  // 实施前已 grep 确认:无保留代码写该列(proposals/review 采纳不写 session_id)。
  const cols = db.prepare(`PRAGMA table_info(operation_log)`).all() as { name: string }[];
  if (cols.some((c) => c.name === 'session_id')) {
    db.exec(`ALTER TABLE operation_log DROP COLUMN session_id`);
  }
}
```

在 `applySchema` 末尾、`ensureColumn` 之后追加一行 `applyLegacyDrops(db);`。

- [ ] **Step 3: 删 migrations.test.ts**

`DeleteFile` 删除 `server/src/db/migrations.test.ts`(5 个 describe 全部断言已删的聊天表/列)。

- [ ] **Step 4: 验证**

运行(在 `server/` 目录):
```
npx tsc --noEmit --pretty 2>&1 | grep "src/db"
npx vitest run src/db 2>&1 | tail -20
```
期望:`src/db` 无 tsc 错误;`migrations.test.ts` 已删、`schema.test.ts` 等其余 db 测试全绿。
同时确认 `openDb(':memory:')` 后 `sessions` 等表不存在(可临时用 `node -e` 或信任 vitest 通过)。

---

### Task 2: 后端路由手术 — 移除会话/归类/审计路由

**Files:**
- Modify: `server/src/curator/routes.ts`
- Modify: `server/src/curator/routes.test.ts`

**Interfaces:**
- Consumes: 无(叶子模块文件仍存在,只是不再被 routes.ts 引用)。
- Produces: `routes.ts` 只剩 workbench + settings + 模型管理;聊天/归类/审计端点全部消失。`readLlmSettings(db, 'chat')` 的两处回落(test-llm / remote-models)**本轮保留不动**(Task 4 一并换掉)。

- [ ] **Step 1: 改 routes.ts — 删 import**

一次 SearchReplace,删这些 import 行:
- `import { chatStream, buildContext } from './chat.js';`
- `import { runPass1, runPass2, TaxonomyValidationError, describeReport, type FolderLite } from './classifier.js';`
- `import { matchAll, renderConditions, toRuleItem, type ValidSuggestion } from './rules.js';`(整行删)
- `import { renderProfiles } from './folderProfile.js';`(改成 `import { buildFolderProfiles } from './folderProfile.js';`)
- `import { runSuggestions, suggestionInput } from './suggestions.js';`
- `import { buildReorganizeAudit, saveAudit, listAudits } from './audit.js';`
- `import { batchSize } from '../llm/context.js';`
- `from '../db/repo/sessions.js'` 那段(`newSession/listSessions/getSession/getMessages/archiveSession/upsertDraft/getLatestDraft/type FolderSpec`)
- `from '../db/repo/classifications.js'` 那段(`saveClassification/getClassification/deleteClassification/type Assignment`)

注意:这是同一个文件的多次删行,必须**合并成一次** SearchReplace(old_str 从第一处 import 延伸到最后一处,new_str 为保留的 import 列表),绝不分多次。

- [ ] **Step 2: 改 routes.ts — 删死 helper**

删 `shapeSession` 函数与 `existingFolders` 函数(只剩 `registerCuratorRoutes` 用不到它们)。同时删 `registerCuratorRoutes` 里顶部的 `requireLlm` 闭包(它只被会话/归类路由用,默认参数是 `purpose='chat'`)。

- [ ] **Step 3: 改 routes.ts — 删路由块**

按路由 path 删以下 handler(每个都是独立 `app.xxx(...)` 块,一次 SearchReplace 删一个或合并相邻删):
- `POST /api/curator/sessions`、`GET /api/curator/sessions`、`GET /api/curator/sessions/:id`、`DELETE /api/curator/sessions/:id`
- `GET/PUT /api/curator/sessions/:id/draft`
- `POST /api/curator/sessions/:id/messages`(聊天 SSE)
- `POST /api/curator/sessions/:id/run-pass-1`
- `POST /api/curator/sessions/:id/run-pass-2`(归类 SSE,含建议段)
- `POST /api/curator/sessions/:id/apply`
- `DELETE /api/curator/sessions/:id/classification`
- `GET /api/curator/sessions/:id/context`
- `POST /api/curator/audit/reorganize`、`GET /api/curator/audit`

**必须保留**:`/api/workbench/*` 全部、`/api/settings/*` 全部、`/api/settings/test-llm`、`/api/settings/models`、`/api/settings/ollama-models`、`/api/settings/remote-models`、`/api/settings/providers`、`/api/settings/entries`、`/api/settings/assignments`。删完 `routes.ts` 里 `buildFolderProfiles` 仍被 `/api/workbench` 使用、`complete` 仍被 `/api/settings/test-llm` 使用。

- [ ] **Step 4: 改 routes.test.ts — 删七大段**

按 `describe` 名删(每段一次 SearchReplace):
`会话路由`、`草稿路由`、`发消息(SSE)`、`Pass 1`、`Pass 2`、`应用 AI 结论`、`审计报告`。
同时删文件顶部 import 里的 `getLatestDraft, getMessages, getSession`(来自 sessions)与 `saveClassification, getClassification`(来自 classifications)。

- [ ] **Step 5: 改 routes.test.ts — 修模型管理段 3 处**

一次 SearchReplace 处理(都在「模型配置(三层)」describe 内):
- `expect(a.assignments.chat).not.toBe(e2.json().id);` → 删掉该行(用途 map 不再有 `chat` 键)
- PUT payload `{ chat: 'm_nope' }` → 改为 `{ proposals: 'm_nope' }`
- 整段 `it('用途没分配 → curator 接口 400 提示去配置', ...)` → 删(用的 `/sessions` + `/messages` 已删;proposals 同类 400 已被 `proposalRoutes.test.ts` 覆盖)
- 另一处 `setAssignment(db, 'chat', e.id);` + `readLlmSettings(db, 'chat')!`(ollama-meta 测试)→ `'chat'` 改 `'proposals'`

- [ ] **Step 6: 验证**

运行(在 `server/`):
```
npx tsc --noEmit --pretty 2>&1 | grep "src/curator"
npx vitest run src/curator/routes.test.ts 2>&1 | tail -30
```
期望:`src/curator` 无 tsc 错误;`routes.test.ts` 剩余测试(模型管理/工作台/上锁)全绿。

---

### Task 3: 后端叶子模块删除

**Files:**
- Delete: `server/src/curator/chat.ts`、`server/src/curator/classifier.ts`、`server/src/curator/keyword.ts`、`server/src/curator/suggestions.ts`、`server/src/curator/audit.ts`、`server/src/db/repo/sessions.ts`、`server/src/db/repo/classifications.ts`
- Delete: `server/src/curator/chat.test.ts`、`server/src/curator/classifier.test.ts`、`server/src/curator/keyword.test.ts`、`server/src/curator/suggestions.test.ts`、`server/src/db/repo/sessions.test.ts`、`server/src/curator/integration.test.ts`

**Interfaces:**
- Consumes: Task 2 已移除 routes.ts 对这些文件的引用。
- Produces: 无(纯删除)。

- [ ] **Step 1: 确认无残留引用**

运行(在 `server/`):
```
npx grep -rn "curator/chat\|curator/classifier\|curator/keyword\|curator/suggestions\|curator/audit\|repo/sessions\|repo/classifications" src
```
期望:除测试自身外无命中(Task 2 已清)。若 `audit`/`classifications` 还有别的引用,停下来核对再删。

- [ ] **Step 2: 删除 7 个源文件 + 6 个测试文件**

用 `DeleteFile` 一次删掉上述 13 个文件。

- [ ] **Step 3: 验证**

运行(在 `server/`):
```
npx tsc --noEmit --pretty 2>&1 | grep "src/curator"
npx vitest run 2>&1 | tail -25
```
期望:无 `src/curator` tsc 错误;全量 vitest 通过(此刻仍含 context/config 相关测试,Task 4 处理)。

---

### Task 4: LLM 通用层清理 — 用途/上下文/流式

**Files:**
- Modify: `server/src/llm/config.ts`(去 purposes + 加 `firstSavedApiKey`)
- Modify: `server/src/curator/routes.ts`(两处 `readLlmSettings(db,'chat')` 回落换 `firstSavedApiKey`)
- Modify: `server/src/llm/config.test.ts`(`'chat'` → `'rules'`)
- Modify: `server/src/llm/context.ts`(只留 `ChatMessage`)
- Modify: `server/src/llm/provider.ts`(删 `stream`)
- Modify: `server/src/llm/provider.test.ts`(删 stream describe + mock + fixtures)
- Delete: `server/src/llm/context.test.ts`

**Interfaces:**
- Consumes: Task 3 后 `stream` / `batchSize` 等生产用户已清空。
- Produces: `config.ts` 新增 `firstSavedApiKey(db: Database.Database): string`(返回第一条已配置凭证的解密 apiKey,空则 `''`);routes.ts 用它替代 `readLlmSettings(db,'chat')`。

- [ ] **Step 1: 改 config.ts — 去用途 + 加 firstSavedApiKey**

一次 SearchReplace:
- `LlmPurpose` 联合去掉 `'chat' | 'classify'` → `'proposals' | 'rules' | 'tag' | 'tagcheck'`
- `PURPOSES` 去掉 `'chat', 'classify'`
- `PURPOSE_LABELS` 删 `chat: '聊天',` 与 `classify: '归类',` 两行
- 新增导出(放在 `readLlmSettings` 附近):

```ts
/**
 * 已保存凭证里的第一个可用 apiKey(解密后)。空 = 没配任何凭证。
 *
 * 聊天用途删除后,test-llm / remote-models 还需要一个"拿已存 key 当回落"的
 * 来源 —— 直接取第一条已配置条目,不依赖任何具体用途(用途无关)。
 */
export function firstSavedApiKey(db: Database.Database): string {
  const entry = listEntries(db)[0];
  if (!entry) return '';
  const provider = listProviders(db).find((p) => p.id === entry.providerId);
  return provider?.apiKeyEnc ? decryptSecret(provider.apiKeyEnc) : '';
}
```

- [ ] **Step 2: 改 routes.ts — 换回落**

两处 `readLlmSettings(db, 'chat')`(remote-models 与 test-llm 的 apiKey 回落)→ 换成 `firstSavedApiKey(db)`。在同一次 SearchReplace 中,把 `firstSavedApiKey` 加进 `from '../llm/config.js'` 的 import 列表。若 import 后 `readLlmSettings` 不再被 routes.ts 使用,则一并从 import 移除(否则保留)。

- [ ] **Step 3: 改 config.test.ts — 8 处 'chat' → 'rules'**

8 处 `'chat'`(行 32/34/97/113/117/124/132)统一改 `'rules'`。分多次 SearchReplace(不同行段),每次改完检查。

- [ ] **Step 4: 改 context.ts — 瘦身到只剩 ChatMessage**

一次 SearchReplace:`context.ts` 删掉 `EST_TOKENS_PER_ITEM`、`EST_OUTPUT_PER_ITEM`、`RESERVED_FOR_SYSTEM`、`batchSize`、`estimateTokens`、`trimToContext` 全部定义与 import(`ModelMeta` 不再需要),只留 `ChatMessage` 接口。删除 `server/src/llm/context.test.ts`。

- [ ] **Step 5: 改 provider.ts — 删 stream**

一次 SearchReplace:删 `stream` 函数 + `import { generateText, streamText } from 'ai'` 里的 `streamText`(改 `generateText`),以及 `splitPrompt` 若只被 `complete` 用则保留(`complete` 用)。顺带把 `complete` 的 `thinking` 参数注释里"聊天要它"字样改成不含聊天的描述。
`provider.test.ts`:删 `describe('stream', ...)` 整段 + 顶部 `streamText: vi.fn()` mock 及相关 `ReadableStream` fixtures(仅 stream 测试用);import 列表里去掉 `stream`。

- [ ] **Step 6: 验证**

运行(在 `server/`):
```
npx tsc --noEmit --pretty 2>&1 | grep "src/llm"
npx tsc --noEmit --pretty 2>&1 | grep "src/curator/routes"
npx vitest run 2>&1 | tail -25
```
期望:`src/llm` 与 `src/curator/routes` 无 tsc 错误;全量 vitest 全绿。

---

### Task 5: 规则建议孤儿链删除

**Files:**
- Modify: `server/src/curator/rules.ts`(删建议机制整段)
- Modify: `server/src/curator/ruleRoutes.ts`(删 `/adopt` 端点)
- Modify: `server/src/curator/rules.test.ts`(删 3 个 describe)
- Modify: `server/src/curator/ruleRoutes.test.ts`(删 3 个 adopt 测试)
- Modify: `server/src/curator/folderProfile.ts`(删 `renderProfiles`)

**Interfaces:**
- Consumes: suggestions.ts 已删(Task 3),routes.ts 已删 ValidSuggestion 引用(Task 2)。
- Produces: `rules.ts` 只剩 `toRuleItem`/`matchItem`/`matchAll`/`renderConditions` 及其类型;`folderProfile.ts` 只剩 `buildFolderProfiles`。

- [ ] **Step 1: 改 rules.ts — 删建议机制**

删 `RawSuggestion`、`ValidSuggestion`、`SuggestionCtx`、`validateSuggestion`、`validateSuggestions`、`mergeSuggestions` 整段(从 `export interface RawSuggestion` 到 `mergeSuggestions` 函数结束)。保留 `renderConditions` 及之前的 `matchAll`/`toRuleItem` 等。

- [ ] **Step 2: 改 ruleRoutes.ts — 删 adopt 端点**

删 `app.post('/api/rules/:folderId/adopt', ...)` 整个 handler,并清理 `validateSuggestion` 的 import(从 `import { matchAll, toRuleItem, validateSuggestion } from './rules.js';` 改成 `import { matchAll, toRuleItem } from './rules.js';`)。一次 SearchReplace 完成。

- [ ] **Step 3: 改 rules.test.ts — 删建议测试**

删 `describe('validateSuggestion')`、`describe('validateSuggestions')`、`describe('mergeSuggestions')` 三个块;import 列表去掉 `validateSuggestion` / `validateSuggestions` / `mergeSuggestions` / `type ValidSuggestion`(只留 `matchAll` 等)。

- [ ] **Step 4: 改 ruleRoutes.test.ts — 删 adopt 测试**

删 3 个 it:`锁定夹子的采纳也被拒,且库里一行没写`、`POST adopt 追加一条条件,origin 记 ai`、`POST adopt 一条自证不过的建议 → 400,库里没有它`。

- [ ] **Step 5: 改 folderProfile.ts — 删 renderProfiles**

删 `renderProfiles` 函数(从导出到函数结束);保留 `buildFolderProfiles` 与相关类型。`folderProfile.test.ts` 无 renderProfiles 测试,不动。

- [ ] **Step 6: 验证**

运行(在 `server/`):
```
npx tsc --noEmit --pretty 2>&1 | grep "src/curator"
npx vitest run src/curator/rules.test.ts src/curator/ruleRoutes.test.ts src/curator/folderProfile.test.ts 2>&1 | tail -20
npx vitest run 2>&1 | tail -25
```
期望:无 `src/curator` tsc 错误;三个测试文件 + 全量 vitest 全绿。

---

### Task 6: 前端整体清理

**Files:**
- Delete: `web/src/components/ChatDrawer.tsx`、`web/src/components/AIAssistantIcon.tsx`、`web/src/components/assistant.tsx`、`web/src/components/Markdown.tsx`
- Modify: `web/src/layouts/index.tsx`、`web/src/pages/curator.tsx`、`web/src/api.ts`、`web/src/types.ts`、`web/src/components/TaskSettings.tsx`、`web/src/components/WorkFolderTree.tsx`、`web/src/global.css`、`web/package.json`

**Interfaces:**
- Consumes: 无(web 无测试,靠 tsc + build)。
- Produces: 前端不再有 `useAssistant` / `curatorApi` / `classifyStream` / `streamMessage` / `rulesApi.adopt` / 聊天组件 / 聊天样式。

- [ ] **Step 1: 删 4 个组件文件**

`DeleteFile`:`ChatDrawer.tsx`、`AIAssistantIcon.tsx`、`assistant.tsx`、`Markdown.tsx`(均位于 `web/src/components/`)。

- [ ] **Step 2: 改 layouts/index.tsx**

删 3 行 import(`AssistantProvider` / `AIAssistantIcon` / `ChatDrawer`),删 `<AssistantProvider>` 包裹(连同注释),删顶栏 `<AIAssistantIcon />` 与文件尾 `<ChatDrawer />` + `</AssistantProvider>`。保持 `<AntApp>` 结构与缩进正确。一次 SearchReplace 完成。

- [ ] **Step 3: 改 curator.tsx**

删 `import { useAssistant } ...`、`const { openWith, suggestions, setSuggestions } = useAssistant();`、`<Button key="ai" ...>打开 AI 助手</Button>`、整段 `{suggestions.length > 0 && (...)}`(AI 建议栏)以及 `takeSuggestion` / `dropSuggestion` / `actSuggestion` 相关代码与 `Bot` icon import(`Check`/`Pencil`/`X` 若只在建议栏用也删;改完 grep 确认 `Bot` 无残留)。

- [ ] **Step 4: 改 api.ts**

删整个 `curatorApi` 对象、`streamMessage`、`classifyStream`、`rulesApi.adopt`;清理 import(`FolderSpec`、`RuleSuggestion`、`Pass1Response`、`Pass2Response`、`ProgressPayload`、`SessionDetail`、`SessionSummary`、`AuditReport`、`AuditSummary`、`ChatMessage` 若不再用);更新 `api.ts` 里「无 body 的调用有八个」注释(去掉"归档会话/归类")。一次 SearchReplace 完成。

- [ ] **Step 5: 改 types.ts**

删类型:`ChatMessage`、`SessionSummary`、`SessionDetail`、`Assignment`、`FailedBatch`、`TaxonomyProposal`、`ValidationReport`、`FolderSpec`、`AuditReport`、`AuditSummary`、`Pass1Response`、`Pass2Response`、`ProgressPayload`、`RuleSuggestion`;`LlmPurpose` 去掉 `'chat' | 'classify'`。确认 `TagProgressPayload`/`TagCheckProgressPayload`/`Item`/`RuleView` 等保留类型不动。

- [ ] **Step 6: 改 TaskSettings.tsx**

`PURPOSE_LABELS` 删 `chat: '聊天',` 与 `classify: '归类',` 两行(`POLL_PURPOSES` 不动)。

- [ ] **Step 7: 改 WorkFolderTree.tsx**

文案「里面的条目请用归类或展开后单独挑」→「里面的条目请展开后单独挑」。

- [ ] **Step 8: 改 global.css**

删:`@keyframes bfm-spin`、`.bfm-msg`(+`.bfm-msg--user`/`.bfm-msg--ai`)、`.bfm-caret`(+第一个 `bfm-blink`)、`.bfm-md` 整组、第二个 `bfm-blink`(眼睛眨眼)。**保留** `.bfm-drawer`(TaskLogDrawer 用)、`.bfm-indeterminate`(curator 生成方案用)、`.bfm-spin` 之外的其余。清理「M4:AI 助手」注释块头。

- [ ] **Step 9: 改 package.json + 刷新 lockfile**

`web/package.json` 删 `"markdown-it"` 与 `"@types/markdown-it"`。运行:
```
cd web && npm install
```

- [ ] **Step 10: 验证**

运行(在 `web/`):
```
npx tsc --noEmit --pretty 2>&1 | grep "src/pages/curator"
npx tsc --noEmit --pretty 2>&1 | grep "src/components"
npx tsc --noEmit --pretty 2>&1 | grep "src/layouts"
npx tsc --noEmit --pretty 2>&1 | grep "src/api"
npx tsc --noEmit --pretty 2>&1 | grep "src/types"
```
再全量 `npx tsc --noEmit --pretty`(忽略 3 个已知错误),`npm run build`("Compiled successfully")。

---

### Task 7: 门禁复跑 + 汇报收尾(不做代码改动)

**Files:** 无

- [ ] **Step 1: 全量门禁**

在 `server/` 跑 `npx tsc --noEmit --pretty`(忽略 3 个已知错误)+ `npx vitest run` 全绿;在 `web/` 跑 `npx tsc --noEmit --pretty`(忽略 3 个已知错误)+ `npm run build`("Compiled successfully")。

- [ ] **Step 2: 残留扫描**

```
grep -rn "curatorApi\|useAssistant\|ChatDrawer\|classifyStream\|streamMessage\|readLlmSettings(db, 'chat')\|renderProfiles\|validateSuggestion\|bfm-msg\|bfm-blink" web/src server/src
```
期望:无命中(除 spec/plan 文档)。

- [ ] **Step 3: 汇报**

汇报删除清单执行情况、门禁结果、保留模块的 vitest 通过数、以及任何需要用户留意的事项(如老库遗留空表已被幂等 DROP 清理)。
