## 6. 日志与可观测性

三个出口,一个入口。业务代码只能调 `logger/`,脱敏在这唯一的地方做。

| 出口 | 内容 | 用途 |
|---|---|---|
| stdout | **事件**(info/warn/error) | 开发时 `tail -f`;`silent` 可关(测试用) |
| `events` 表 | info/warn/error,人话描述 + 上下文 | UI `/logs`,回答「出什么事了」 |
| `api_calls` 表 | 每次 B站请求一行 | UI 请求流水,回答「为什么」 |

**⚠️ 关于 stdout 的修正(M2 实施后,2026-09-14)**:原设计写的「stdout 输出全部,
含 api_calls」是错的 —— 一次 3,480 条的同步会产生 200+ 行请求流水刷屏,而**同样的
信息在 `api_calls` 表里带 `trace_id`,按 trace 聚合查询严格更有用**。所以 stdout 只出事件。
`pino` 随 Fastify 在 M3 引入。

**不做日志文件轮转** —— 已经有 SQLite,日志进表比进文件更好查、可筛选、免轮转代码。

```sql
events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, level TEXT,        -- info | warn | error
  category TEXT,                 -- sync | api | llm | execute | auth
  code TEXT,                     -- -412 / -101 / LLM_JSON_PARSE / HTTP_5XX
  message TEXT NOT NULL,         -- 人话:「同步收藏夹『游戏』失败」
  detail TEXT,                   -- JSON,完整上下文(见下表)
  plan_id INTEGER, folder_id INTEGER,
  resolved INTEGER DEFAULT 0     -- UI 里标记「已处理」
)

api_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, trace_id TEXT,     -- 一次同步/一次执行 = 一个 trace_id
  method TEXT, path TEXT,        -- GET /x/v3/fav/resource/list
  params TEXT,                   -- JSON(不含 cookie)
  http_status INTEGER, code INTEGER,   -- code: 0 成功 / -412 / -101
  duration_ms INTEGER, attempt INTEGER,  -- attempt 记第几次尝试
  response_excerpt TEXT          -- 出错存全量,成功存前 300 字符
)
```

### 「为什么出错」靠 `detail` 回答

| 场景 | `detail` 必须包含 |
|---|---|
| API 报错 | 请求路径、参数、B站原始返回体、重试次数 |
| **触发风控** | 当时在做什么操作、**已连续请求多少次**、**距上次写操作多久** |
| LLM 失败 | 哪个模型、prompt token 数、**原始返回前 500 字符** |
| 执行失败 | 哪个 op、第几步、已成功多少条、能否续跑 |

风控那两条数字是刻意记的 —— 它们直接告诉你是不是请求太快了。

### 其他决策

- **`api_calls` 永远全记,不做开关**。加了配置项就得维护它,而数据量不是问题(首次全量
  约 300 行,日常增量几十行)。改成 UI 默认只显示 warn/error,要全看就展开筛选。
- **`api_calls` 保留 90 天**,一条 DELETE 定期清理。`events` 表不自动删。
- **`api_calls` 不记 header**(cookie 全在 header 里),只记 `buvid3 是否存在`。
  `w_rid`/`wts` 正常记 —— 签名错的时候要能对着它验算。
- **脱敏必须覆盖到所有写 `api_calls`/`events` 的路径(2026-09-15 红队加固)**:
  - 测试连接按钮 → 测试请求的 params 走脱敏(只记 `redacted: '<apiKey>'`),**禁止记录明文 apiKey**
  - 模型管理 → 保存配置时 `params` 字段不写入实际 key,只记 `{provider, model}` 不含 key
  - 直发 B 站时不要把 cookie / apiKey 写进 params(本来就遵守,这里再强调)
  - 红队规则:**任何新加的"把用户凭证送到后端"的入口,默认带脱敏**,写完自检
- **成功操作也记**。不记成功就无法回答「昨天那批移动到底成了几条」。
- **出错必须 toast + 导航栏红点,不许静默失败**。同步断了你却在看一个「看起来正常」的
  旧缓存,是这个应用最危险的失败模式。

