# Spec:词级质检台账(checked_at)—— 「继续质检所有未完成」

> 状态:**已实施(2026-09-19)**。改动在工作区待用户提交(全局规则:AI 不 commit)。
> 验证:server 785 测试全绿 + 双端 typecheck 干净。手动验收清单见 spec 第三节。
> 关联代码:`server/src/db/schema.ts`、`server/src/db/repo/tags.ts`、
> `server/src/curator/tagcheck.ts`、`server/src/curator/tagRoutes.ts`、`web/src/components/TagPanel.tsx`。

## 一、背景

### 1.1 现状缺口:系统不知道哪些词质检过

- `tags` 表没有质检标记 —— 判定过的词和没检过的词在库里无法区分。
- 「只查这次新的」靠 `lastRunNewWords`(**内存变量,重启即丢**),且它记的是
  "上一轮标注长出的词",不是"质检过的词"。
- 用户点名的第三种情况:自动质检失败(如 TAGCHECK_EMPTY)后这批词"欠了质检",
  下一轮标注的新词覆盖 `lastRunNewWords` → **欠的那批永远漏检**。

### 1.2 用户决策(2026-09-19 对话确认)

- **判过的都算**:词被质检判定(无论 keep / drop / merge / move)即视为已质检。
- **入库即待检**:新词创建时就是"待质检",不需要 lastRunNewWords 内存变量。

→ 按钮从两个范围选项简化为:**继续质检**(默认,检所有未质检的词)/ **全部审查**(强制全库重检)。

## 二、方案

### 2.1 数据模型:tags.checked_at 列

- `tags` 加列 `checked_at INTEGER`(NULL = 从没质检过)。迁移用现有 `ensureColumn`
  幂等机制(db/index.ts)。
- **盖章点**(判定即时间戳,四种动作统一):
  - tagcheck.ts `applyVerdict` 尾部:drop/merge/move/keep 四路都打
    `checked_at = Date.now()`。
  - **注意**:drop 的词被删了不用盖;merge 的被并词也没了 —— 实际盖章只发生在
    **还活着的词**上(keep 全盖;merge/move 盖的是 id 对应的词,若 mergeTags 删了它,
    那条本来就不盖章 —— 动手成功的 merge,目标词留下来了,要不要顺带盖目标?
    **不盖**:目标词没被"判定",它可能本来就没检过,下次继续质检应该轮到它)。
- **待检来源**(取代 lastRunNewWords):
  - `ensureTag` 新建词 → 默认 NULL = 待检(天然成立,不用改)。
  - 查待检:`SELECT name FROM tags WHERE checked_at IS NULL`(含"欠账+新词")。
- **清账点**:
  - `clearTagLibrary`(清空标注)删全表,自然清零。
  - `renameTag` 不改 checked_at(改名不算重检)。
  - **alias 命中不算已检**:被合并掉的词的旧写法在别名表里,查待检只查 tags 表,
    不涉及。

### 2.2 质检范围改为「未完成」驱动

- `runTagCheck` 的 `allTags: boolean` 改为 `scope: 'continue' | 'all'`:
  - `'continue'`:待检词 = `checked_at IS NULL` 的词(自动接住新词+历史欠账)。
  - `'all'`:待检词 = 全库词(强制重检;判定完照常盖章)。
  - **fresh 闸门随之退役**:scope='continue' 检的就是没检过的词,不再需要
    "只碰新词"限制 —— 老词(欠账)也在范围内。标注后自动质检同样改用
    `scope='continue'`(只检未质检的,成本随词库收敛而下降)。
- `lastRunNewWords` 内存变量删除(连同 run 路由的赋值)。
- **fresh 闸门相关测试**(「只动本轮新词」等)改为对应的 continue/all 语义。

### 2.3 路由与前端

- `POST /api/tags/tagcheck` body `{ scope: 'continue' | 'all' }`(默认 continue;
  非法值 400)。
- 返回加 `remaining`(盖章后仍待检的词数,正常应为 0,给前端提示用)。
- 前端弹窗两个选项:
  - `继续质检`(默认)—— 检所有还没质检过的词(之前没检完的 + 这次新长的)。
  - `全部审查` —— 强制全库重检,**删词不可逆**,慎选。
- 「词库」块的健康度行加 `待检 N`(checked_at IS NULL 计数,reconcile-stats 返回)——
  用户随时看得到欠了多少账。

## 三、验收

1. 新词(ensureTag)→ checked_at NULL;「继续质检」能查到它。
2. 判定 keep → 盖章,下次「继续质检」不再查它。
3. drop/merge/move 成功 → 对应活词盖章;被删/被并的词不存在,不盖章。
4. 全部审查 → 全库重检,判完全库 checked_at 非空(除检查中新建的)。
5. 自动质检失败(TAGCHECK_EMPTY)后,这批词仍 NULL → 下次「继续质检」接得住(核心诉求)。
6. 清空标注 → 全库回到待检(NULL)。
7. reconcile-stats 返回 `unchecked` 数,前端健康度行显示「待检 N」。
8. 现有测试全绿(fresh 闸门用例改写为 continue 语义)。

## 四、不做的事

- 不做质检历史记录(谁在哪次被判成什么)—— 台账只记"检没检过"。
- 不给 alias 表加标记 —— 别名是"旧写法索引",不参与质检账本。
- 不改「标注后自动质检」的触发时机(仍标注跑完自动跑,只是范围变成 continue)。
