/**
 * 全部 DDL。用 CREATE TABLE IF NOT EXISTS 保证幂等 —— M2 阶段够用,
 * 等真的需要改列时再引入 user_version 迁移。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS folders (
  id           INTEGER PRIMARY KEY,   -- media_id
  type         INTEGER,               -- 11=视频 21=文章;list-all 的 type 参数被忽略,
                                      -- 实测拿不到,由条目的 type 反推,允许 NULL
  title        TEXT NOT NULL,
  intro        TEXT,
  privacy      INTEGER,
  media_count  INTEGER NOT NULL DEFAULT 0,
  mtime        INTEGER,               -- 实测未确认 list-all 是否返回,允许 NULL
  raw          TEXT,
  synced_at    INTEGER
);

CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,      -- bvid / cvid
  type         INTEGER,               -- 2=视频 12=文章
  title        TEXT NOT NULL,
  intro        TEXT,                  -- 实测是完整简介段落,M4 分类的主力信号
  cover        TEXT,
  upper_mid    INTEGER,
  upper_name   TEXT,
  duration     INTEGER,               -- 秒
  pubtime      INTEGER,
  invalid      INTEGER NOT NULL DEFAULT 0,
  invalid_checked_at INTEGER,
  -- ↓ AI 派生列,与上面的同步列物理隔离(C8):同步绝不写这三列
  ai_tags      TEXT,
  ai_summary   TEXT,
  ai_checked_at INTEGER,
  raw          TEXT
);

CREATE TABLE IF NOT EXISTS folder_items (
  folder_id  INTEGER NOT NULL,
  item_id    TEXT NOT NULL,
  fav_time   INTEGER,
  PRIMARY KEY (folder_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_fi_item   ON folder_items(item_id);
CREATE INDEX IF NOT EXISTS idx_fi_folder ON folder_items(folder_id);

CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  level     TEXT NOT NULL,
  category  TEXT NOT NULL,
  code      TEXT,
  message   TEXT NOT NULL,
  detail    TEXT,
  plan_id   INTEGER,
  folder_id INTEGER,
  resolved  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS api_calls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  trace_id         TEXT,
  method           TEXT NOT NULL,
  path             TEXT NOT NULL,
  params           TEXT,
  http_status      INTEGER,
  code             INTEGER,
  duration_ms      INTEGER,
  attempt          INTEGER,
  response_excerpt TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_trace ON api_calls(trace_id);

-- M4 AI 整理 增量 schema(2026-09-15)
-- sessions: AI 整理会话(可续)
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT,
  preview    TEXT,
  status     TEXT,
  summary    TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
-- session_messages: 只存聊天本质,不含结构化编辑(红队 2026-09-15)
CREATE TABLE IF NOT EXISTS session_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  ts         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_session ON session_messages(session_id);
-- taxonomy_draft: 用户在聊天窗里直接编辑的体系状态(不进消息流)
CREATE TABLE IF NOT EXISTS taxonomy_draft (
  session_id       INTEGER PRIMARY KEY REFERENCES sessions(id),
  folders_json     TEXT NOT NULL,
  constraints_json  TEXT,
  summary          TEXT,
  updated_at       INTEGER
);
-- M5 审计报告
CREATE TABLE IF NOT EXISTS audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  title        TEXT,
  summary      TEXT,
  before_json  TEXT,
  after_json   TEXT,
  detail_json  TEXT,
  trace_id     TEXT,
  created_at   INTEGER
);

-- classifications: Pass 2 的归类结果(M4)。一条会话一份,重跑覆盖。
-- 为什么要落库:条目级 ai_reason 要能点开看(spec §9.0 Step 4),
-- 而重跑 3000 条的 Pass 2 是实打实花钱的,不能每次刷新页面都重来。
-- 刻意**不用** §5 的 plans 表 —— 那是 M5 写回流程的表,等 M5 自己建。
CREATE TABLE IF NOT EXISTS classifications (
  session_id       INTEGER PRIMARY KEY REFERENCES sessions(id),
  assignments_json TEXT NOT NULL,
  failed_json      TEXT,
  updated_at       INTEGER
);

-- ── M4b 整理工作台(2026-09-16)──────────────────────────
-- 同步快照(folders / folder_items)与工作副本分离:快照只读、编辑只写下面这几张。
-- 破了这条「还原」就没有意义 —— 改动和 B站 真相混在一起就分不出谁是谁。

-- 工作副本的存在性 + 它基于哪一次同步。
-- CHECK(id = 1) 把"全局唯一一份"钉在数据库层,不靠应用代码自觉。
CREATE TABLE IF NOT EXISTS work_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  based_on   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 目标夹子。
CREATE TABLE IF NOT EXISTS work_folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 指向快照里的哪个夹子。非空 = 现有夹子(可能改了名);空 = 新建的。
  -- 改动标记 ✎ 靠它算:origin_id 非空且名字不同 → 改名
  origin_id  INTEGER REFERENCES folders(id),
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 目标归属(多对多 —— B站 允许一个视频同时在多个夹子里)
CREATE TABLE IF NOT EXISTS work_folder_items (
  folder_id INTEGER NOT NULL REFERENCES work_folders(id) ON DELETE CASCADE,
  item_id   TEXT NOT NULL REFERENCES items(id),
  PRIMARY KEY (folder_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_wfi_item ON work_folder_items(item_id);

-- 操作日志:一次**操作**一条,不是一行数据一条。
-- 拖 412 条视频记 412 行日志 = 垃圾,不是留痕。
CREATE TABLE IF NOT EXISTS operation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,   -- 'user' | 'ai'
  session_id  INTEGER,         -- actor='ai' 时是哪次对话
  summary     TEXT NOT NULL,   -- 人类可读一句话,界面直接显示
  detail_json TEXT
);

-- ── M4c 规则(2026-09-16)────────────────────────────────
-- 谁该进哪个夹子的判据。bilibili 有夹子但没有逻辑 —— 夹子只是个筐,
-- 谁进去全靠手。规则是本产品唯一比 B站 多的东西,所以它是核心资产。
--
-- 刻意**不做** ALTER TABLE work_folders ADD COLUMN:那张表已经存在,加列要走迁移;
-- 新建一张表用 CREATE TABLE IF NOT EXISTS 就够了,而且 FK 上的 ON DELETE CASCADE
-- 顺手解决"删夹子 / 一键还原时规则跟着走",不用写额外代码。
CREATE TABLE IF NOT EXISTS work_folder_rules (
  folder_id       INTEGER PRIMARY KEY REFERENCES work_folders(id) ON DELETE CASCADE,
  conditions_json TEXT NOT NULL,
  -- 'ai' | 'user' —— 谁写的。界面上一眼看出这是谁的主意(§11.2 颜色是信息)
  origin          TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- ── §9F 词库树(2026-09-18)──────────────────────────────
-- 取代 items.ai_tags 那一列(它从此不读不写)。为什么是关联表而不是一列 JSON:
-- 「合并两个词」要能一次改掉所有挂它的视频 —— 字符串数组做不到这件事。
--
-- **name 是显示、norm 是身份**。分开的理由:英文名要被小写化才拦得住
-- "NBA"/"nba" 重复,但界面上不该显示成小写。
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  norm       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES tags(id),
  created_at INTEGER NOT NULL
);
-- **norm 全局唯一**(C4):一个名字在整棵树里只有一处。
-- 父**不**参与唯一性 —— 允许"不同父下同名"会造出两个 \`篮球\`、两个 \`露营\`,
-- 那正是用户要避免的重复("相同的 tag 不要重复建立")。
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_norm ON tags(norm);
CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);

-- 见过的写法 → 它现在归哪个节点。装的是**不再是任何节点规范名**的那些写法:
-- 合并掉的旧名、改名前的旧名、大小写/简繁变体。
-- 查词 = 先查 tags.norm,再查这张表(findTag 一份逻辑)。
CREATE TABLE IF NOT EXISTS tag_aliases (
  name   TEXT PRIMARY KEY,        -- 归一化后的写法
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE
);

-- 视频 ↔ 词。source 区分谁挂的:'ai' 标注 / 'rule' 规则 / 'user' 手动
CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id),
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source  TEXT NOT NULL,
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);
`;
