# Plan:词库整理(reconcile)活跃层化 —— 实施步骤

> 依据:`docs/superpowers/specs/m4h-reconcile-active-layer.md`。按此 plan 实施,每步做完跑对应测试。

## 前置:读代码

先完整读这几个文件,理解现状(主 session 已改过其中两个性能点):
- `server/src/curator/tagtree.ts`(reconcile / coverageMap / pairs,已剪枝+内存 ancestor)
- `server/src/curator/tagRoutes.ts`(run 路由,currentRun 状态机)
- `server/src/db/repo/tags.ts`(tagSets / listTagsWithParent / MIN_SAMPLE 依赖)
- `server/src/curator/tagtree.test.ts`、`tagRoutes.test.ts`(现有测试)

## Task 1:活跃层定义与统计

**目标**:把"挂 ≥5 条视频的词"显式化为可查询、可监控的概念。

1. 在 `tags.ts` 加一个查询(或在 tagtree 里):
   ```sql
   -- 活跃词数(挂 ≥5 条视频)
   SELECT COUNT(*) FROM (
     SELECT tag_id FROM item_tags GROUP BY tag_id HAVING COUNT(*) >= 5
   )
   ```
   以及"总词数" `SELECT COUNT(*) FROM tags`。

2. 在 `tagRoutes.ts` 注册:
   ```
   GET /api/tags/reconcile-stats
   → { totalTags, activeTags, reconcileMs, lastRunAt }
   ```
   `reconcileMs`/`lastRunAt`:reconcile 每次运行后把耗时写进一个模块级变量(在
   currentRun 旁边加 `lastReconcile = { ms, at }`)。

**验证**:`GET /api/tags/reconcile-stats` 返回合理数字(真实库 totalTags≈12005,
activeTags≈212)。

## Task 2:树变了才整理(reconcile 触发时机)

**目标**:点 AI 标注、池子为空时不再同步跑 reconcile(治"点标注就卡死"直接一枪);
真实标注(池子非空)仍整理,历史同义词不丢。

在 `tagRoutes.ts` 的 run 路由里,当前结构是:
```js
const r = pool.length === 0 ? {tagged:0,...} : await runTagging(...)
// ...质检...
try { changes.push(...reconcile(db)) } catch ...
```
改为:`pool.length === 0` 时(空池子,没标任何条目)**跳过质检和 reconcile**,
只发 note("没有需要标注的条目"),直接进入收尾。用一个布尔 `skipReconcile`
包住质检 + reconcile 两段(质检的闸门本来就是"没新词不调模型",空池子必走无事
早退,跳过它语义不变)。

**为什么不能"空池子永远跳过"(spec §2.2 的完整推理)**:reconcile 还整理历史同义词。
但空池子场景用户高频点,同步跑会被拖慢(词库 3000 活跃 = 2.5s)。折中:
**空池子跳过 + 真实标注时整理** —— 高频场景不卡,历史同义词在下次真实增量标注时
一并合并。已知限制(用户全标完且再无新条目时,同义词暂停整理)记录在 spec,接受。

**关键**:reconcile 是同步的,这段改动同时要**记录 reconcile 耗时到 lastReconcile**
(Task 1 的指标)。

**验证**:
- 新增测试:`POST /api/tags/run`(池空)后,断言 reconcile **零调用**(mock 或统计),
  且 `run-progress` 立即返回 `running:false`。
- 现有空池子测试(`run(空池子):零模型调用...`)更新:它断言"判据照跑"(reconcile 合并了
  体育/篮球)——**这条会冲突**。空池子跳过 reconcile 后,行为变成"判据不跑、树不变"。
  **改测试断言以匹配新行为**,注释写明"空池子不整理"。
- 保留一条**池子非空**测试:标注真跑(reconcile 照常跑),断言同义词仍被合并 ——
  证明"树变了才整理"不丢功能。

## Task 3:reconcile 加运行预算(超时守卫)

**目标**:即使活跃词暴涨,reconcile 也只花有限时间,不卡死事件循环。

**与 Task 2 的关系**:Task 2 已让**空池子**不调 reconcile;Task 3 覆盖的是
**池子非空但活跃词暴涨**(比如词库 3000+ 活跃)的场景 —— 那时 reconcile 仍会同步跑,
预算守卫保证它最多花 5s 就收手,不占死事件循环。两者互补。

在 `tagtree.ts` 的 `reconcile` 签名加 `opts.budgetMs?: number`(默认 5000)。
在循环体(合并段 + 挂父段)的**每次迭代里检查耗时**,超预算就:
- 停止当前循环,返回已产生的 `changes`(部分整理,不丢已做的)。
- 调用方(tagRoutes)检测"是否超时",记一条 warn:
  `log.event({ level:'warn', category:'llm', code:'TREE_RECONCILE_TIMEOUT', message:'词库整理超时,本轮部分整理 —— 活跃词过多需要治理' })`。

实现方式:`const deadline = Date.now() + budgetMs`;循环里 `if (Date.now() > deadline) { timedOut = true; break; }`。
返回 `{ changes, timedOut }` 或用一个 out-param。**保持 reconcile 现有签名兼容**:
可以用 `return { changes, timedOut }` 但注意现有调用处 `changes.push(...reconcile(db))`
—— 需要改成解构。或者让 reconcile 继续返回 `TreeChange[]`,另加一个
`reconcileWithBudget(db, budgetMs): { changes, timedOut }`。**建议后者,不动现有调用**。

**验证**:
- 合成数据:活跃词 10,000(不重叠,各挂 10 条)→ reconcile 在 ≤5s 返回且 timedOut=true。
- 活跃词 3,000 → reconcile 正常完成(2.5s,预算内),timedOut=false。
- 现有测试不受影响(它们的数据量小,不触发超时)。

## Task 4:合并阈值自适应(可选,但推荐做)

**目标**:活跃词数涨到上限时,自动调高 minSample,让整理成本保持可控。

在 reconcile 加:
```js
if (activeTagCount > 3000) minSample = 10; // 阈值定 3000,依据 spec 1.5 曲线
```
`activeTagCount` 在 reconcile 开头算一次(Task 1 的查询)。
注意:minSample 变化会影响判据行为 —— 这是**有意的**(词库大时只用更保守的统计)。
日志里记一条 info("活跃词 N 个,超过 3000,统计下限提到 10")。

**验证**:合成数据,活跃词 4000 → reconcile 用 minSample=10,耗时回落到预算内,
且日志有这条 info。

## Task 5:前端显示词库健康度(可选)

**目标**:用户能看到"词库在膨胀"的早期信号,而不是等到卡死。

在 `TagPanel.tsx` 的「词库」块(显示 `tree?.total`)旁边,加一行:
`活跃词 N / 总词 M · 上次整理 Xms`(数据来自 Task 1 的 reconcile-stats)。
`api.ts` 加 `tagApi.reconcileStats()`。

**验证**:前端「标签」页显示这些数字,且标注跑完会刷新。

## Task 6:全量验证

1. `npm run typecheck`(server + web)全绿。
2. `npx vitest run` 全绿(含新增用例)。
3. 基准脚本(照 spec 1.5 修正后的形态,活跃词互不重叠、各挂 ~10 条)确认:
   - 活跃词 1,000 → ≤500ms(实测 307ms)
   - 活跃词 3,000 → ≤5s(实测 2.5s)
   - 活跃词 10,000 → 触发超时守卫,≤5s 返回
4. 真实库(只读):reconcile ≤200ms(当前 ~100ms)。
5. 手动:点 AI 标注(池空)→ 前端立即显示"没有需要标注的条目",无 pending。

## 边界与注意

- **reconcile 返回形状变化**(若改成带 timedOut)要同步所有调用处,不止 tagRoutes。
  先 grep `reconcile(` 找全调用点。
- **空池子跳过 reconcile 会改现有测试行为** —— Task 2 明确说了,改断言而不是硬凑。
- **minSample 自适应会改变合并行为** —— 这是有意的治理,不是 bug。测试要覆盖"超阈值
  用新下限"和"未超阈值用默认 5"两条。
- 涉及文件都列在 spec 第五节,别动范围外的东西。

## 完成后

在 spec 文件顶部把状态从"待实施"改成"已实施 + 日期",并更新
`docs/superpowers/specs/m4h-reconcile-active-layer.md` 的"已修"段(把本 plan 做的补进去)。
