# Spec:质检分批 + 手动质检按钮(范围可选) —— 修 TAGCHECK_EMPTY,给用户质检入口

> 状态:**已实施(2026-09-19)**。由 `docs/superpowers/plans/2026-09-19-manual-tagcheck.md` 实施完成。
> 后端 783 测试全绿(含手动质检端点用例)、前端 typecheck 干净。
> 手动验收(起 dev 服务点「词库质检」按钮选范围)未执行,留给用户按第四节验收。
> 关联代码:`server/src/curator/tagcheck.ts`、`server/src/curator/tagRoutes.ts`、
> `web/src/components/TagPanel.tsx`、`web/src/api.ts`、`web/src/types.ts`。

## 一、背景与为什么必须改

### 1.1 症状

用户清空标注后重新 AI 标注,一轮长出 **5524 个新词**。标注跑完后的质检把 5524 个词
**一次性**塞给 deepseek-flash 判定,模型吐不出完整 JSON(被输入淹没),`parseJsonArray`
拿不到数组 → **0 条判定** → 记 `TAGCHECK_EMPTY`:
`标签质检一个词都没判回来:5524 个新词送出去、0 条判定 —— 本轮的变化清单是空的`。

### 1.2 根因

`tagcheck.ts` 的 `runTagCheck` 把 `newNames`(本轮所有新词)**一次性**拼进 user message
让模型逐个判。词一多就超单次请求的实际处理能力,模型要么吐空、要么输出被截断。

**注释自己都写了**:`tagcheck.ts` 里那段「几百条 verdict(每条 ~20 token)撞上服务商的
默认输出上限就会被截断」—— 知道这个坑,但实现没做分批。

### 1.3 第二个诉求

用户要一个**手动触发质检**的按钮 —— 不依赖标注跑完,随时可以对词库跑一遍质检。
用户明确:弹窗里给**两个范围选项** ——「全部审查」(对词库里所有词判定,含老词)和
「只查这次新的」(只对刚长出来的新词判定,不碰老词)。话术要说清楚,
特别是「全部审查」的**删词不可逆**风险。

### 1.4 第三个问题:质检判定参照太单薄

deepseek 判断一个词"太泛、该删"的依据,只有 `CHECK_SYSTEM` 里 5 个干巴巴的例子
("AI""视频""教程""分享""合集"),加上整棵树每词的挂载数。**角度太少、只有"该删"的方向,
没有"该留"的正面参照**。对标注后质检(只看新词)勉强够;对「全部审查」要判 12000 个
老词时严重不足 —— 模型会把挂得多的大类词("美食""学习")误判成泛词。

**要求**:增强 `CHECK_SYSTEM`,给成对的**正反例子** —— 每个动作(drop / merge / move /
keep)配「该做」和「不该做」的对照,让模型有更完整的参照系。不引入外部数据,只改提示词。

## 二、方案

### 2.1 质检分批(修 TAGCHECK_EMPTY)

`runTagCheck` 内部把待检词按批切,逐批调模型,合并所有 verdicts。

- **批大小**:`TAGCHECK_BATCH = 200`(词/批)。200 个词 × ~20 token 判定 = 4k 输出,
  deepseek-flash(384k maxOutput)轻松容纳;输入侧 200 个词也远在窗口内。
- **循环**:把 `newNames` 切成 `[200, 200, ...]`,每批构建 user message + 调 `complete` +
  `coerceVerdicts`,结果**累积**进同一个 `verdicts` 数组。
- **零批(闸门)**:`newNames.length === 0` 仍早退,不调模型。
- **单批空**:某批 `coerceVerdicts` 返回空时,照旧走 `TAGCHECK_EMPTY` 告警逻辑
  (只报一次,说明"第 X/N 批 0 判定")。不因为某一批空就整轮失败。
- **耗时**:每批打一行 console 日志(`[tags/check] 批 i/n 判定 k 个`),和标注日志同节奏,
  让用户看得见。

### 2.2 质检提示词增强(判词参照)

重写 `CHECK_SYSTEM`,从"5 个泛词例子"升级为**每个动作的成对正反例**:

```
你是标签词库的质检员。用户给你一棵标签树和一批词,判断每个词该怎么办。

- **drop**(太泛,删掉):这个词不能把一类内容和其它内容**分开**。
  该删的例:"AI""视频""教程""分享""合集""超清" —— 几乎每条都挂,没有区分力。
  不该删的例:"露营"(只挂户外内容)、"烤羊肉"(只挂美食内容) —— 能分开一类,留着。
- **merge**(同义,并入已有词):它是已有词的另一种写法(译名/简写/同义词)。
  例:"鲁夫"→"路飞","漫威"→"Marvel"。
  不该并的例:"露营"和"烤羊肉" —— 意思不同,并了反而丢信息。
- **move**(归错层,挪位):它该挂在另一个已有词下面。
  例:"篮球"该挂到"体育"下。
  不该挪的例:"露营"挂在根上 —— 它是独立大类,不归任何词管。
- **keep**(留):没问题。
  例:"露营""烤羊肉""NBA"。

**拿不准就 keep** —— 漏掉一个泛词只是让树脏一点,误删一个好词是丢掉信息。
只输出 JSON 数组:[{"name":"AI","action":"drop"},{"name":"鲁夫","action":"merge","target":"路飞"}]
```

要点:每个动作都给"该做/不该做"**两个方向**;drop 的"不该删"例子(露营/烤羊肉)正好是
「全部审查」时最容易误判的大类词,让模型明白"挂得多不等于该删"。不引入外部数据。

### 2.3 手动质检按钮 + 弹窗选项

**后端新端点** `POST /api/tags/tagcheck`(手动质检):

- 输入 body:`{ scope: 'all' | 'new' }`。
  - `scope: 'new'` → 只检「本轮标注新长出来的词」,和标注后自动质检完全一样
    (含 fresh 闸门:老词一律不碰)。
  - `scope: 'all'` → 检「词库里所有词」(含已有老词)。**删除(泛词)不可逆** ——
    弹窗话术会明说,用户勾了全部审查即视为知情。
- 待检词:`scope='new'` 用调用方传入的新词列表;`scope='all'` 用 `listTagsWithParent` 全库词名。
- 复用 `runTagCheck` 的判定与执行逻辑。`scope='all'` 时绕开 fresh 闸门:
  模型可对老词 drop/merge/move。
- `currentRun.running` 时 409(标注跑着不能同时质检,和 clear-tags 同款守卫)。
- 记 `TAGCHECK_MANUAL` info event(记录跑了一次手动质检)。
- 返回 `{ ok: true, scope, dropped, merged, moved }`(同步执行完返回)。

**前端**(`TagPanel.tsx`):

- 「AI 标注」按钮区加一个「词库质检」按钮(放清空标注旁边)。
- 点击弹 `Modal.confirm`,单选范围,话术:

  > **标题**:词库质检
  > **说明**:跑一遍质检,模型会逐个判定词的去向 —— 泛词该删、重复词该并、
  > 归错层的该挪。
  > **范围(单选)**:
  > - `全部审查` —— 对词库里**所有词**判定,包括已经存在的词。**删词不可逆**,慎选。
  > - `只查这次新的` —— 只对这一轮 AI 标注新长出来的词判定,不碰已有词。
  > 确定按钮:`开始质检`

- 默认勾 `只查这次新的`(安全默认:不碰已有词)。
- 确定 → 调 `tagApi.tagcheck(scope)` → 成功刷新 tree/changes/stats,提示
  `质检完成:删 X · 合 Y · 挪 Z`。

**`web/src/api.ts`**:加 `tagcheck(scope: 'all' | 'new') => json('POST', '/api/tags/tagcheck', { scope })`。

**`web/src/types.ts`**:无新增类型(复用现有返回形状)。

### 2.4 质检分批的共用

`runTagCheck` 的分批逻辑,**标注后质检和手动质检共用**。为最小改动,新增参数控制范围:
- `runTagCheck` 加 `opts.allTags?: boolean`(默认 false = 现有只检新词 + fresh 闸门;
  true = 全库词,绕过 fresh 闸门)。
- 分批逻辑无条件应用(不管 allTags 与否)。
- 路由把 `scope` 映射到 `allTags`: `scope='all'` → `allTags: true`;`scope='new'` → 默认。

## 三、验收标准

0. **提示词增强**:`CHECK_SYSTEM` 含每个动作的成对正反例(该做/不该做);
   特别是 drop 的"不该删"例(露营/烤羊肉 等大类词)。
1. **质检分批**:5524 个新词 → 不再 `TAGCHECK_EMPTY`;分 N 批跑完,verdicts 累积;
   每批 console 有日志。真实标注后质检正常判定(drop/merge/move 生效)。
2. **手动质检**:
   - `POST /api/tags/tagcheck` 同步执行,返回 `{ ok, scope, dropped, merged, moved }`。
   - `scope='new'`:只检本轮新词,fresh 闸门生效(老词一律不碰)。
   - `scope='all'`:检全库词,绕过 fresh 闸门(老词可能被删,不可逆)。
   - `currentRun.running` 时 409。
   - events 表有 `TAGCHECK_MANUAL` 记录。
3. **前端**:
   - 「词库质检」按钮可点,弹窗两个范围选项话术清楚,默认勾「只查这次新的」。
   - 跑完提示「删 X · 合 Y · 挪 Z」,tree/changes/stats 刷新。
4. **现有测试全绿**(标注后质检行为不变:仍只检新词 + fresh 闸门)。

## 四、不做的事(范围外)

- **不做质检的异步进度轮询**:全库质检同步执行(词多时可能几秒),前端等响应。
  若将来词库上万导致超时,再改异步。
- **不做质检的历史记录页**:只记 event,不做 UI 历史。
- **不改变「标注后自动质检」的触发时机**:它仍在标注跑完后自动跑,只是内部改成分批。
- **不区分质检模型的 provider**:deepseek-flash 用方舟段配置,复用现有 tagcheck 用途。

## 五、涉及文件

- `server/src/curator/tagcheck.ts` —— 分批循环 + allTags 参数 + CHECK_SYSTEM 提示词增强。
- `server/src/curator/tagRoutes.ts` —— 注册 `POST /api/tags/tagcheck` + 守卫 + event。
- `server/src/curator/tagcheck.test.ts` —— 新增分批 + allTags 用例。
- `server/src/curator/tagRoutes.test.ts` —— 新增手动质检端点用例。
- `web/src/api.ts` —— 加 `tagcheck`。
- `web/src/components/TagPanel.tsx` —— 加按钮 + 弹窗选项。
