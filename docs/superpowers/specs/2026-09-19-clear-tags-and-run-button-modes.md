# Spec:清空标注按钮 + 标注按钮三态 —— 为「继续标注」性能测试开路

> 状态:**已实施(2026-09-19)**。由 `docs/superpowers/plans/2026-09-19-clear-tags-and-run-button-modes.md` 实施完成。
> 后端 778 测试全绿(含 clear-tags 2 条)、前端 runButtons 4/4、双端 typecheck 干净。
> 手动验收(起 dev 服务点按钮)未执行,留给用户按第四节验收。
> 关联代码:`server/src/db/repo/tags.ts`、`server/src/curator/tagRoutes.ts`、
> `web/src/components/TagPanel.tsx`、`web/src/api.ts`。

## 一、背景

### 1.1 为什么需要「清空标注」

用户要测「继续 AI 标注」的性能 —— 词库已经长到一定规模后,增量标注的真实耗时
(这正是 M4h 活跃层方案要守护的场景)。为了回到初始状态反复测,需要一键把 AI
长出的**整棵词库树** + **所有条目的标注**清零,而不是手动一个个删。

### 1.2 为什么需要按钮三态

当前「AI 标注」和「重新标注全部」两个按钮**恒常并列显示**,不跟随标注状态。用户看到
的按钮和「该做什么」对不上:
- 从没标过,点「重新标注全部」没有意义(本来就全都没标)。
- 全标完了,点「AI 标注」是空池子(会走 M4h 的空池子跳过,提示"没有需要标注的条目")。
- 标了一半,「AI 标注」的文案暗示"从零开始",而实际是增量 —— 应该叫「继续标注」。

### 1.3 已有基础

- `tagStats`(tagging.ts)已返回 `{ tagged, total, invalid }`,**都排除 invalid**:
  `tagged` = 有效条目里标过的,`total` = 有效条目总数。按钮态的判断基于它,无需新查询。
- `rewriteRuleTagIds`(rules.ts)能把规则条件里的 tag id 移除 —— 清词库树时用来
  清掉规则里的死引用(§9F C16 纪律)。
- `tag_aliases` / `item_tags` 的 `tag_id` 都是 `REFERENCES tags(id) ON DELETE CASCADE`,
  `DELETE FROM tags` 会连带清掉它们,不用逐表删。

## 二、方案

### 2.1 清空标注(高危,二次确认)

**后端**:新路由 `POST /api/tags/clear-tags`,单个事务:

1. 守卫:`currentRun.running` 时 409(标注跑着不能清,清到一半标注回来是脏状态)。
2. `rewriteRuleTagIds(db, () => null)` —— 规则里所有 tag 条件移除。
   **顺序:必须在删 tags 之前跑**(C16:反了规则里留一串死 id,静默失效)。
3. `DELETE FROM tags` —— `item_tags` / `tag_aliases` 靠 FK 级联带走。
4. `UPDATE items SET ai_kind = NULL, ai_checked_at = NULL` —— 水位线清零,
   所有条目回「未标注」。同步列(两列之外)不碰,upsertItem 的 UPDATE 分支本来就不写它们。
5. 记一条 `TAGS_CLEARED` info event。
6. 返回 `{ ok: true }`。**幂等**:空库再清也 ok(表都空、UPDATE 影响 0 行)。

**前端**:按钮放「重新标注全部」旁边,红色 danger。点击弹 `Modal.confirm`:
- content 里放一个输入框,必须**输入「清空」二字**，「确定」才可点(二次确认)。
- 确定后调 `clearTags()`,成功刷新 tree / changes / reconcile-stats / status。

### 2.2 按钮三态

在 `tagStatus` 上算(每次 status 刷新后重新渲染):

| `tagged` 与 `total` | 显示 |
|---|---|
| `tagged === 0` | 只「AI 标注」 |
| `tagged === total` | 只「重新标注全部」 |
| `0 < tagged < total` | 「继续标注」+「重新标注全部」 |

- 「AI 标注」和「继续标注」走**同一个** `runTag('missing')`(增量池语义相同,
  补没标过的),只是文案区分。运行中照旧只显示「停止」。
- 「重新标注全部」语义不变(覆盖重标),保留原确认弹窗。

### 2.3 前端 API

`web/src/api.ts` 加 `clearTags(): Promise<{ ok: true }>` → `json('POST', '/api/tags/clear-tags')`。

## 三、验收标准

1. `POST /api/tags/clear-tags` 后:
   - 词库树空(`listTagTree` 为空)、`item_tags` 空。
   - 所有有效条目的 `ai_checked_at` 变 NULL(未标注)、`ai_kind` 清空。
   - 规则条件里的 tag 引用被移除。
   - events 表有 `TAGS_CLEARED` info 记录。
2. **幂等**:空库再清也返回 ok。
3. **运行中拒绝**:标注跑着时调用 → 409。
4. **按钮三态**:
   - 从没标过(tagged=0)→ 只显示「AI 标注」。
   - 全标完(tagged=total)→ 只显示「重新标注全部」。
   - 标了一半 → 显示「继续标注」+「重新标注全部」。
5. **二次确认**:不输入「清空」时确定键禁用;输入后才能提交。
6. 清空成功后界面回到「从没标过」态(只有「AI 标注」),可立刻开始测「继续标注」。
7. 现有测试全绿。

## 四、不做的事(范围外)

- **不区分 `item_tags.source` 只清 'ai'**:用户选择「连词库树一起清」,规则挂的、
  手动挂的都一并清(反正 tags 表整体删了)。
- **不改「重新标注全部」的语义和确认文案**:它是"覆盖重标",保持原名。
- **不加独立的「清空」历史/撤销**:这是测试辅助功能,不是产品功能,不可撤销
  (二次确认已经是唯一的防线)。
- **不动 reconcile / 活跃层**:清空后第一次「AI 标注」自然从零长词库,现有逻辑照跑。

## 五、涉及文件

- `server/src/db/repo/tags.ts` —— 加 `clearTagLibrary(db)`(上面的事务)。
- `server/src/curator/tagRoutes.ts` —— 注册 `POST /api/tags/clear-tags`,接 `currentRun` 守卫。
- `server/src/curator/tagRoutes.test.ts` —— 新增清空用例(清掉词库/水位线/规则条件、
  幂等、运行中 409)。
- `web/src/api.ts` —— 加 `clearTags()`。
- `web/src/components/TagPanel.tsx` —— 按钮三态 + 清空按钮 + 输「清空」确认弹窗。
- `web/src/types.ts` —— 无需改(`TagRunStatus` 已含 tagged/total)。
