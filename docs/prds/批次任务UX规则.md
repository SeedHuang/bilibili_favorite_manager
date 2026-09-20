# 批次任务 UX 规则（项目级标准）

> 2026-09-20 brainstorming 定稿。覆盖三个当前异步任务：`tag`(标注)、`tagcheck`(质检)、`proposals`(方案生成)。`classify`(整理页 SSE 归类)暂不入规约——后续整页重构时再处理。

## 背景

项目里多个后台任务分批跑 AI 调 LLM，但 UX 水平参差：

| 任务 | 进度 | 日志 | 中止 | 轮询方式 |
|------|------|------|------|---------|
| AI 标注 `tag` | ✅ | ✅ 日志抽屉 | ✅ 停止按钮 | 轮询 2s 硬编码 |
| 手动质检 `tagcheck` | ✅ | ✅ 日志抽屉 | ✅ 停止按钮 | 轮询 3s 硬编码 |
| 夹子方案生成 `proposals` | ✅ 轮询 | ❌ 只落 events 表 | ❌ 无中止 | 轮询 3s 硬编码 |

各自能跑、各自有 UX，但**没有共享规则、没有可配置项、没有下载日志、没有统一的「任务三件套」**。这条规则把这些立成项目标准。

## §1 规则：批次任务与 AI 任务 UX 标准

凡是 **批次任务（分批处理多单位数据）、AI 调用任务、大数据量处理**，必须满足：

### 三件套

1. **进度条 + 日志抽屉 + 启动/中止控件**。三者缺一不可。
2. **断点在数据，不在任务**：任务的「跑过没」由业务表字段自证（`ai_checked_at` / `checked_at` / 已落地 `work_folders` 等）。**不**额外造任务级 checkpoint 表。
3. **三能力**：能开始、能续、能强制重跑。
   - 「开始」与「续」**合用一个按钮**，按数据状态自动换文案（未跑过显示「开始」，跑过一部分显示「继续」，背后都是「按当前 scope 跑一遍」）
   - 「重新开始」是**弹窗里的 scope 选项**（`continue` / `all`），不并列三按钮

### 日志三能力

4. **可看**：抽屉/日志按钮打开
5. **可清**：重开/续跑时自动清空（旧日志随新 run 重记）
6. **可下载**：抽屉顶部第三个图标按钮，导出当前缓冲区为 `.txt`

### 任务三件套（设置页一对一配置）

7. **轮询间隔**：每个任务在设置页有独立轮询间隔下拉（5 档：1s / 2s / 3s / 5s / 10s），存 `poll.<taskType>.interval_ms`
8. **批次大小**：每个任务有独立批次大小下拉（1 / 2 / 5 / 10 / 20 / 30 / 40 / 50 + 自定义 1~500），存 `poll.<taskType>.batch`
9. **AI 模型**：每个任务有独立模型下拉，沿用现有 `LlmPurpose` 机制，存 `llm.purpose.<taskType>`

### 进度契约

10. **统一形状**：所有异步任务 progress 接口返回 `{ running, scope?, done, total, error?, logs }`。**不**各搞一套 progress 端点。
11. **后端日志寿命 = 当前 run**：内存数组绑 run；run 结束不清空（留着给用户下载/翻查）；下次启动清旧记新。刷新页面/重启后端 = 历史日志丢失（已知代价）
12. **中止 = 用户主动**：每个运行态任务必须显式中止接口；abort 后 `running`→`idle`，已落库批次保留，未跑丢失

## §2 数据约定

### settings 表新增 key（不加表不加列）

```
settings.key='poll.tag.interval_ms',       value='2000'   // AI 标注
settings.key='poll.tag.batch',              value='30'
settings.key='poll.tagcheck.interval_ms',   value='3000'   // 手动质检
settings.key='poll.tagcheck.batch',         value='60'
settings.key='poll.proposals.interval_ms',  value='3000'   // 方案生成
settings.key='poll.proposals.batch',        value='1'
```

默认值在代码里兜底，缺 key 时用默认值。

### 默认值表

| taskType | intervalMs | batch | 已有 LLM 模型? |
|----------|-----------|-------|--------------|
| `tag` | 2000 | 30 | ✅ 已有 |
| `tagcheck` | 3000 | 60 | ✅ 已有 |
| `proposals` | 3000 | 1 | ⚠️ 临时复用 `rules` 模型 → 节三并入 |

### 后端契约

任务进度接口统一形状（命名沿用 `*Progress` 后缀）：

```ts
type AsyncTaskProgress = {
  running: boolean;
  scope?: 'continue' | 'all';
  done: number;
  total: number;
  error?: string;
  logs: { ts: number; level: 'info' | 'warn' | 'error'; text: string }[];
};
```

任务启动约定：返回 `202 {ok:true}`；运行中再启动返回 `409`。

### settings 配置读写接口

```
GET  /api/settings/polls                 → Record<taskType, PollConfig>
PUT  /api/settings/polls/:taskType       → body { intervalMs, batch } → { ok: true }
```

```ts
type PollConfig = { intervalMs: number; batch: number };
```

后端启动任务时从 settings 读 `poll.<taskType>.batch` 决定批次大小。**改设置后下次启动生效**（正在跑的不能改）。

## §3 前端架构

### 共享代码（[web/src/hooks/useTaskProgress.ts](web/src/hooks/useTaskProgress.ts) 与 [web/src/components/TaskLogDrawer.tsx](web/src/components/TaskLogDrawer.tsx)）

**1. `useTaskProgress` hook**

```ts
function useTaskProgress<T>(opts: {
  taskType: string;                                // 'tag' | 'tagcheck' | 'proposals' | ...
  fetcher: () => Promise<T>;                       // 现有 tagApi.getRunProgress / getCheckProgress / proposalsApi.current
  toProgress: (raw: T) => AsyncTaskProgress;       // 统一映射到契约形状
}): {
  progress: AsyncTaskProgress | null;
  error: string | null;
  reload: () => Promise<void>;
};
```

内部：
- 挂载时拉一次 `GET /settings/polls` 拿 `intervalMs`
- `setInterval(fetcher, intervalMs)`，只在 `running=true` 时轮询
- 设置页改了轮询间隔 → 重新拉配置 → 重启 interval（订阅 settings 变更事件或定时重拉）

抽象代价：每个调用方要写一个 `toProgress` 映射函数（不同任务原接口形状略有差异）。代价换来的是 hook 通用、不绑死特定任务。

**2. `TaskLogDrawer` 组件**

复用现有 `TagLogDrawer` 的「纯渲染器」设计（props + lines + onClear），扩展：
- props：`{ open, onClose, lines, onClear, waiting?, changes?, title, running }`
- 顶部新增下载图标（lucide `Download`），onClick 把 `lines` 拼成 `.txt` Blob 触发下载
- `title` 默认 = 任务名（标注 / 质检 / 方案）
- 不绑死任何任务；调用方控制 `onClear` 与 `changes`

### 设置页：合一表（[web/src/components/TaskSettings.tsx](web/src/components/TaskSettings.tsx)，从 `ModelManager.tsx` 重命名）

```
任务设置
─────────────────────────────────────────────────────────────────
任务名    │ 轮询间隔  │ 批次大小  │ AI 模型
─────────┼──────────┼──────────┼─────────────────────
标注      │ [2s ▾]   │ [30 ▾]   │ [qwen2.5:14b ▾]
质检      │ [3s ▾]   │ [60 ▾]   │ [qwen2.5:14b ▾]
方案生成  │ [3s ▾]   │ [1 ▾]    │ [（临时借用 rules）▾]
```

- 轮询下拉：1s / 2s / 3s / 5s / 10s
- 批次下拉：1 / 2 / 5 / 10 / 20 / 30 / 40 / 50 + 自定义输入（1~500）
- 模型下拉：沿用现有 `ModelManager` 逻辑（`LlmPurpose` 列表 + 已注册模型下拉）
- 改任意一项 → 立即 `PUT /api/settings/polls/:taskType` 或 `setAssignment`

### 类型（[web/src/types.ts](web/src/types.ts) 末尾追加）

```ts
export type LogLevel = 'info' | 'warn' | 'error';
export interface LogLine {
  ts: number;
  level: LogLevel;
  text: string;
}
export type AsyncTaskProgress = {
  running: boolean;
  scope?: 'continue' | 'all';
  done: number;
  total: number;
  error?: string;
  logs: LogLine[];
};
export type PollConfig = { intervalMs: number; batch: number };
```

## §4 实施拆分（3 个 plan 顺序执行）

**Plan A：基建**
- 写这份规则文档（已完成）
- settings 表新增 key 兜底 + `readPoll/listPolls/writePoll` 三个 repo 函数
- 后端 `GET/PUT /api/settings/polls` 两个路由
- 前端 `useTaskProgress` hook + `TaskLogDrawer` 组件（含下载按钮）
- 前端 `TaskSettings.tsx` 合一表（从 `ModelManager.tsx` 重命名）
- 通用类型 `LogLine` / `AsyncTaskProgress` / `PollConfig`
- 不动任何既有任务的代码

**Plan B：迁移 `tag` 和 `tagcheck`**
- 两个任务的启动接口改成「启动前读 `poll.<taskType>.batch`」
- 两个任务的 UI 改用 `useTaskProgress` hook（替换现有硬编码 setInterval）
- 两个任务的日志抽屉改用 `TaskLogDrawer`（替换现有 `TagLogDrawer`，保留 `changes` 顶部区域）
- 后端进度接口已是合规形状，**不改**

**Plan C：迁移 `proposals`（从零补齐）**
- 后端：加中止接口（路由 `POST /api/proposals/abort` + `runGeneration` 接 abortSignal）；启动前读 `poll.proposals.batch`；把 `readLlmSettings(db, 'rules')` 改成读 `'proposals'`（前提：扩 `LlmPurpose` 加入 `'proposals'`）
- 前端：UI 加中止按钮 + 日志抽屉（用 `TaskLogDrawer`）+ `useTaskProgress` hook；改用 `TaskSettings` 里的独立模型下拉
- 节三的最后一步：扩 `PURPOSES` 数组把 `proposals` 独立出来，让 `TaskSettings` 里有它专属的模型下拉

## §5 明确不做（YAGNI）

- **多份历史日志存档**：内存数组寿命 = 当前 run，刷新即丢。要历史看 events 表（已存在），不复制到 progress 接口里
- **任务级 checkpoint 表**：业务表字段自证状态，不额外造
- **「重新开始」独立按钮**：藏在弹窗 scope 选项里，与标注/质检一致
- **`classify`（整理页 SSE 归类）**：整理页整页重构时再入规约，本次不动
- **轮询接口统一端点（`GET /api/progress`）**：保留各任务自己的 `*Progress` 路径（`tag-run-progress`、`tag-check-progress`、`proposals/current`），契约形状统一即可，端点路径不动
