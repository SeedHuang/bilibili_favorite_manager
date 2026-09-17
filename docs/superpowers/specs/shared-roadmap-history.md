## 13. 实施顺序(2026-09-15 更新)

```
M1 握手   脚手架 + wbi 签名 + 限速器 + 能拉到收藏夹列表          ✅ 已完成
M2 同步   数据模型 + 全量/增量 + 断点续传 + logger(events/api_calls)
          + settings 表 + 封面磁盘缓存 + 交互式 cookie
M3 只读UI Fastify + SSE + Umi Max + HUD 视觉(CP2077 移植)
          + 封面墙 + FTS 搜索 + 授权页 + DPAPI 加密                   ✅ 已完成
M4 整理   LLM 接入层(AI SDK + 模型注册表 + 上下文自适应)
          + 两遍分类引擎(调整为按 contextWindow 算批次)
          + /curator 手动编辑工作台(可手动移/合并/改)
          + AI 助手悬浮图标(常驻,默认动作「整理文件夹」)
          + sessions/session_messages 表(对话历史可续)
          + 会话历史侧栏 + 滚动摘要(自动压缩超限部分)
          + 整理审计报告(reorganize kind)
M5 执行   Plan + diff + 拓扑序 + execute guards
          + 删除保险(AI 永不产生 remove_item,只能 userId→manually)
          + 写回 B站(慢速 + 二次确认 + 风控止步 + 同步审计报告)
          + /review(两栏对比 + ai_reason + 撤回)
M6 收尾   /logs(三 tab:事件 / 请求流水 / 审计)
          + /settings(模型管理 + cookie + 同步触发)
          + 失效文件夹 UI + 打包分发
```

**M3 是设计落地的关口** —— §11 的令牌、图标分工、授权流程都在这里一次做对。

**M4 的关键原则**:
- **「开始整理」是手动编辑状态,AI 不弹**(2026-09-15 用户拍板)
- **AI 管家是悬浮图标**(右下角,常驻,任何页面可调)
- **删除保险**:AI 永不产生 `remove_item`,只能 userId 在 UI 手动标失效删(防 C5 漏洞)
- **上下文自适应**:批次 = (contextWindow - reserved) / avgPerItem,**不硬编码**
- **会话历史可续**:Vercel AI SDK 不管上下文,我们用「最近 N 轮 + 旧轮滚动摘要 + 结构化状态」拼

**M5 的关键原则**:
- **写回只做差异**:Plan 已 diff,零多余请求
- **慢速 + 风控止步**:遇 -412 立即停不重试,3~5s/次
- **红色 + 二次确认**:UI 醒目 + 阻断式确认
- **撤回边界诚实**:撤回只对「本地已应用、未写 B站」有效;写回后给审计报告 + 可撤销清单

### M1 完成记录(2026-09-14)

13 个 commit,46/46 测试通过,typecheck 通过。产出 `server/src/bilibili/` 下 5 个模块
(wbi / rateLimiter / errors / fingerprint / client)+ 手工探针 `probes/verify-live.ts`。

**实测发现(重要)**:实施当天 `space/wbi/arc/search` 从早上的 `code 0` 变为
**HTTP 412 风控拦截**,而同一时刻 `nav` / 推荐流 / www 仍返回 200。
说明风控是**动态的、按接口收放的**。探针正确检测并停止(未重试)—— 验证了 C4 的设计。
收藏夹列表接口 `fav/folder/created/list-all` 不受影响,仍 `code 0` 且不需要 wbi。

### M2 完成记录(2026-09-14)

16 个 commit,153+5 = **158 测试通过**,typecheck 通过。产出:

```
server/src/
├─ db/         schema(7 表)+ openDb + repo(folders/items/state)
├─ logger/     redact(脱敏,零 import)+ Logger(events/api_calls/stdout)
├─ bilibili/   client 加 onRequest 钩子 + setRequestListener(api_calls 数据源)
├─ sync/       parse + folders + items(分页+断点续传+对账)+ engine(增量)
└─ probes/     prompt(交互式 cookie,多行)+ sync-live(验收探针)+ verify-live
```

**最终 review 抓到的跨任务缺陷(单任务 review 拦不住)**:
- **风控必须停止队列** —— `runSync` 的 catch 原本不区分错误类型,`RiskControlError` 被吞成
  "单夹子失败",循环继续 → 在被拦截的端点上连打 ~63 次。已修:re-throw 停止整个队列。
- **对账** —— 原无任何 `DELETE FROM folder_items`,远端删掉的收藏本地永远留着,且
  `localCount > media_count` 会让 `needsSync` 永远为真、每次全量重拉。已修:干净跑完
  一轮后 `DELETE ... NOT IN (seen)`。

**验收探针实测**(真实账号,64 夹 / 3480 条):
104s、91 次 API 调用、平均 1145ms/次、0 错误、未触发风控。详见 §14。

**交互式 cookie 的坑**:`readline.question` 只读一行,而 `Copy as cURL` 是多行
(带 `\` 续行符) → 多行粘贴会丢后半段。已改为逐行读直到空行,抽 `extractCreds` 纯函数
并加测试。

## 14. 待验证事项

### 已验证 ✅(2026-09-14,真实 API 实测)

| # | 事项 | 结论 |
|---|---|---|
| 1 | wbi 签名算法 | ✅ 算法正确,见 §8 实现要点 |
| 5 | 收藏夹列表是否需要 wbi | ✅ **不需要**,直接 `code 0` |
| — | 风控指纹 | ✅ `buvid3` 必需且充分(对 `arc/search` 类接口) |
| — | **风控是动态按接口收放的** | ✅ `arc/search` 同机几分钟内**时通时拦**(412),按速率触发、会自行恢复;而 `nav` / `list-all` 一直宽容 |
| — | **空数据契约** | ✅ `list-all` 在用户没有某类收藏夹时合法返回 `{code:0, data:null}`。`get<T>` 契约是 `T \| null`,**不能当错误抛**(跑探针时发现的真 bug) |

**对 M2 的意义**:M2 依赖的 `fav/folder/created/list-all` + `fav/resource/list` 属于
「宽容」那一类,不是被盯的 `arc/search`。当前 1200ms 读间隔对它们够用。

### 已用真实账号实测 ✅(2026-09-14,64 个收藏夹 / 3,480 条)

| # | 事项 | 结论 |
|---|---|---|
| 2 | `fav/resource/list` 返回结构 | ✅ **`fav/resource/list` 不需要 wbi** —— 这大幅简化了 M2 |
| 2 | 可用作分类信号的字段 | ✅ `title` / **`intro`(完整段落)** / `upper.name` / `duration` / `pubtime` / `fav_time` / `cnt_info` |
| 2 | **分区名 `tname` 是否返回** | ❌ **不返回**。分区信号不可用 —— 但 `intro` 是完整简介,是更好的替代 |
| — | 收藏规模 | ✅ 64 个收藏夹,共 3,480 条 |
| 3 | **失效条目标记** | ✅ **`attr !== 0` 即失效。** 全量同步实测:`invalid=0` 763 条、`invalid=1` 24 条。抽检 `invalid=1` 的标题几乎全是「已失效视频」,判定基本准确 |
| — | **失效条目在 `resource/list` 里被过滤** | ⚠️ **大发现**。「默认收藏夹」远端 `media_count=2920`,但 `resource/list` 只返回 239 条有效条目(fav_time 完整降序、分页干净)。**B站对这个 2920 条的夹子只返回了 239 条,中间大量失效/重复内容根本不在响应里** |
| — | 全量同步实测 | ✅ 64 夹 / 3480 条,**耗时 104s**,91 次 API 调用,平均 1145ms/次,**0 错误,未触发风控**。1200ms 读间隔够用 |
| — | `list-all` 是否返回 `mtime` | ✅ **返回**。64 个夹子全部同步无异常,增量判据的 mtime 分支可用 |

**`fav/resource/list` 完整字段清单**(实测):
```
id, type, title, cover, intro, page, duration, upper, attr,
cnt_info, link, ctime, pubtime, fav_time, bv_id, bvid,
season, ogv, ugc, media_list_link
```

- `type: 2` = 视频(`12` = 文章)
- `attr: 0` = 正常条目(失效条目的取值待确认,见下)
- `intro` 实测是**完整的一段简介**(几十字),不是截断 —— 这是 AI 分类的主力信号
- `cnt_info` 含 `collect` / `play` / `danmaku` / `reply`,可作辅助信号
- `duration` 单位秒;`pubtime` / `ctime` / `fav_time` 均为 Unix 秒

### 新发现的两个坑(M2 必须处理)

**⚠️ `list-all` 的 `type` 参数似乎被忽略。**
用 `type=11`(视频)和 `type=21`(文章)各请求一次,返回**完全相同**:
都是「64 个,共 3480 条」。所以**不能用 `type` 区分视频夹和文章夹**。
M2 需要另找区分方式(候选:逐夹看 `fav/resource/list` 返回的条目 `type`,或
查其它接口)。**这是 M2 的第一个待解问题。**

**⚠️ 失效条目的标记 —— 已确认(见上表)。**

**⚠️ 失效条目被过滤 ⇒ 增量判据的深层影响(必须理解)**
实测「默认收藏夹」`media_count=2920` 但只拉到 239 条有效条目。这意味着
`resource/list` 的**实际返回数可能远小于 `media_count`**。于是:

- 本地 `localCount` 与远端 `media_count` **可能长期不相等**,`needsSync` 判据会一直为真
- 但这是**对的**:每次同步确实把「有效条目」完整拉了(因为失效的不在响应里)
- **对用户也是对的**:AI 整理一个「2920 条但 2680 条已失效」的夹子,应该只看那 239 条

**所以对 M2 的正确理解**:不是"只同步了 23%"的 bug,而是 **`media_count` 是含失效的
总量,`resource/list` 只返回有效条目**。本地 239 条是**有效内容的完整集合**。
增量判据保持 `!==` 即可 —— 虽然每次会重拉这个夹子,但重拉本身是幂等的。

> 若未来想让"未变化的夹子"也跳过,需要给 `needsSync` 加一个"上次拉到的有效条数"的
> 记忆字段,而不是用 `media_count`。这是一个 M4/M5 再看的优化,不是 M2 的 bug。

### 仍待实测 ⏳

4. **`fav/resource/deal` 的移动语义** —— `old_media_id` + `media_id` 的确切用法。
   **需要真实写操作,只能在 M5 首次执行时用一个单条探针确认**(M1/M2 都不做写操作)。
6. **真实风控阈值** —— 读 1200ms 的保守估计对 `list-all` / `resource/list` 够用
   (实测通过),但 `arc/search` 这类敏感接口 1.2s 明显不够。M2 跑全量同步时观察。

## 15. 明确的非目标(v1 不做)

| 不做 | 原因 |
|---|---|
| 扫码登录 | 多两个风控暴露面,cookie 有效期够长 |
| 向量聚类 | 先跑通纯 LLM 方案,慢/不准再上(§9.5) |
| 全自动无人值守 | 用户明确选择建议模式。执行层已设计成可复用 —— 将来只是「自动批准 Plan」 |
| MCP / CLI 壳 | 目录边界已画好,需要时再提取 |
| 多账号 / 代理池 | 单账号用不上,且代理是异常信号 |
| 视频内容理解(字幕/转码) | 成本和吞吐的无底洞。元数据已覆盖 90% 的信号 |
| 定时后台任务 | v1 是「打开时同步」,不做常驻调度 |
