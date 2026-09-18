## 4. 目录结构

```
bilibili_favorite_manager/
├─ package.json              # 根:并发跑 dev 的脚本
├─ server/                   # 后端,所有核心逻辑
│   └─ src/
│       ├─ bilibili/         # 客户端:签名、限速、错误分类(不含业务)
│       ├─ sync/             # 同步引擎:全量/增量/断点续传
│       ├─ llm/              # 薄配置层:AI SDK provider 初始化 + LlmConfig(见 §3)
│       ├─ curator/          # 两遍分类引擎
│       ├─ plan/             # 提案数据结构 + 校验 + 差异计算
│       ├─ execute/          # 执行引擎:分批、退避、undo
│       ├─ db/               # SQLite schema + repository
│       ├─ logger/           # 统一日志入口(stdout / events / api_calls)
│       └─ http/             # Fastify 路由(只做 HTTP 层)
└─ web/                      # Umi Max + antd 5
```

核心逻辑是 `server/src/` 下的**平级目录**,不抽 `packages/core` —— 只有一个消费方,
抽出去是纯负担。将来要加 CLI / MCP 壳时再提取,目录边界已经画好,提取是机械操作。

### 依赖方向(只能向下)

```
http (Fastify 路由)
  ↓
curator / execute / sync      ← 业务编排
  ↓
plan / db / llm / logger      ← 领域模型与外部能力
  ↓
bilibili (client)             ← 唯一出口,只发请求
```

**硬规矩**:`bilibili/` 不许 import `db/`,`db/` 不许 import `bilibili/`。
同步引擎负责把前者拉到的数据写进后者。这条让客户端可以脱离数据库单测。

## 5. 数据模型

```sql
-- 收藏夹
folders(
  id INTEGER PRIMARY KEY,      -- media_id
  type INTEGER,                -- 11=视频夹  21=文章夹
  title TEXT, intro TEXT,
  privacy INTEGER,             -- 0=公开 1=私密
  media_count INTEGER,         -- B站报告的条目数 ← 增量判据
  mtime INTEGER,               -- B站报告的修改时间 ← 增量判据
  raw TEXT, synced_at INTEGER  -- raw 存原始 JSON 保底
)

-- 条目(视频/文章)
items(
  id TEXT PRIMARY KEY,         -- bvid 或 cvid
  type INTEGER,                -- 2=视频 12=文章
  title TEXT, intro TEXT, cover TEXT,
  upper_mid INTEGER, upper_name TEXT,
  duration INTEGER, pubtime INTEGER,
  invalid INTEGER DEFAULT 0,           -- 1 = 已失效
  invalid_checked_at INTEGER,
  -- ↓ AI 派生字段,与上面的同步字段物理隔离(C8)
  ai_tags TEXT, ai_summary TEXT, ai_checked_at INTEGER
  -- §9F(2026-09-18)起:ai_kind 存形态(教学/娱乐/…),ai_checked_at 复用为标注水位线,
  -- ai_tags / ai_summary **已废弃**(标签改走下面的 tags 树,见 §9F)
)

-- 多对多:一个视频可以同时在多个收藏夹里
folder_items(folder_id, item_id, fav_time, PRIMARY KEY(folder_id, item_id))
CREATE INDEX idx_fi_item ON folder_items(item_id);

-- ↓ §9F 词库树(2026-09-18):取代 items.ai_tags
tags(id, name, parent_id, created_at)              -- parent_id NULL = 根(大类)
  UNIQUE(parent_id, name)
tag_aliases(name TEXT PRIMARY KEY, tag_id)         -- 见过的所有写法 → 规范节点
item_tags(item_id, tag_id, source, PRIMARY KEY(item_id, tag_id))

-- 同步断点续传游标
sync_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)

-- 设置:LLM 配置 / cookie / 速率
settings(key TEXT PRIMARY KEY, value TEXT)

-- 提案
plans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  stage TEXT,         -- 'taxonomy'(体系草案) | 'ops'(可执行操作)
  status TEXT,        -- draft | approved | executing | paused | done | failed
  parent_id INTEGER,  -- ops plan 关联到它评审通过的那份 taxonomy
  payload TEXT,       -- JSON
  created_at INTEGER, updated_at INTEGER
)

-- 执行记录(进度 + undo)
executions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER, seq INTEGER,
  op TEXT,            -- JSON,正向操作
  inverse TEXT,       -- JSON,反向操作(不可撤销时为 NULL)
  status TEXT,        -- pending | running | ok | failed | skipped
  error TEXT, executed_at INTEGER
)

-- AI 对话会话(历史可续)
sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,                 -- 如「整理文件夹 2026-09-15」
  preview TEXT,               -- 会话列表只显摘要(红队 2026-09-15:长会话加载优化)
  status TEXT,                -- active | archived
  summary TEXT,               -- 滚动摘要:旧轮压缩后的内容(context 超限时用)
  created_at INTEGER, updated_at INTEGER
)

-- AI 对话的每条消息(只存聊天本质,不含结构化操作)
-- 红队 2026-09-15:结构化操作(改名/合并/拆分)不进消息流,只进 taxonomy_draft。
session_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES sessions(id),
  role TEXT,                  -- user | assistant | system
  content TEXT,               -- 原始消息
  ts INTEGER
)
CREATE INDEX idx_msg_session ON session_messages(session_id);

-- 体系草稿(用户在聊天窗里直接编辑的体系状态)
-- ⚠️ 2026-09-16:这张表已不再读写,由 `m4b-curator-workbench.md` 的
--    work_state / work_folders / work_folder_items 取代(按会话存草稿
--    与"全局唯一一份结构"矛盾)。表保留是为了不静默删掉已有数据。
taxonomy_draft(
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id),
  folders_json TEXT,         -- JSON: [{tempId, name, description, rule, estCount, reuseFolderId?}]
  constraints_json TEXT,      -- JSON: 用户的硬约束(夹数限制、保留夹子等)
  summary TEXT,               -- 当前结构化快照的简短说明
  updated_at INTEGER
);

-- 审计报告(本地整理审计 + 同步审计,分开存)
audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,                  -- 'reorganize'(本地整理) | 'sync'(写回B站)
  title TEXT,                 -- 人类可读标题
  summary TEXT,               -- 一段话总结
  before_json TEXT,           -- 之前状态(夹子结构)
  after_json TEXT,            -- 之后状态
  detail_json TEXT,           -- 完整差异(建夹/移动/改名/删除 明细)
  trace_id TEXT,              -- 关联 api_calls(仅 sync 有)
  created_at INTEGER
)
```

