# 浏览合并进标签页 — 设计文档

日期:2026-09-20
状态:已与用户确认

## 背景与目标

「浏览」页(/browse)与「标签」页(/tag)功能重叠:浏览页的"左树 + 视频列表 + 条目详情"在标签页也能达成,单独一个页面是累赘。目标:

1. 删掉「浏览」页,其能力合并进「标签」页。
2. 浏览页视频列表上方的 summary(选中的词名 + 总数)和"归属 chips"(每条视频列在哪些收藏夹)都删除 —— 词名和数量树里已有,跨词条信息改用封面角标。
3. 标签页整页锁死不滚动,滚动只发生在树列和视频列表内部 —— 解决"树往下滚把上面的模块顶出可视范围"的问题。

## 页面结构(合并后的 /tag)

```
┌─────────────────────────────────────────────────────────┐
│ AI 标注横栏(压缩版:按钮行 + 状态行 + 进度条,锁顶不动) │
├───────────┬───────────────────────────────┬─────────────┤
│ 词库树     │ 视频列表(内部只滚 Y)        │ 条目详情     │
│ 300px     │ flex:1                        │ ContextPane │
│ 内部滚动   │                               │ 268px       │
└───────────┴───────────────────────────────┴─────────────┘
```

- [web/src/pages/tag.tsx](../../../web/src/pages/tag.tsx) 改成 `height:100%; overflow:hidden` 的三段 flex 布局,滚动只发生在树列和视频区内部,整页锁死。
- 「AI 标注」面板(TagPanel 现有顶部面板)压缩成一条横栏锁在页顶:按钮行 + 状态行 + 进度条照旧,运行中只留「停止」+「日志」的逻辑不变。
- 「上一轮变化」清单收进现有 TagLogDrawer,加一个"变化"区块;顶部不再放独立面板。
- 「浏览」删除:`/browse` 路由、[web/src/pages/browse.tsx](../../../web/src/pages/browse.tsx)、[web/src/components/BrowsePanel.tsx](../../../web/src/components/BrowsePanel.tsx) 整个删除,nav 删「浏览」。本地工具,不做重定向。

## 抽共享组件:TagItemPane

新建 `web/src/components/TagItemPane.tsx`,把 BrowsePanel 右半边(取数 + ItemGrid + 分页)搬进去:

- **删除**顶部 summary「xxx 连同它下面的词,一共 N 条」。
- **删除**归属 chips 区块。后端 `foldersOf` 字段留着不动,前端不再读。
- props:`tagId`、`selectedId`、`onSelect(item)`。
- 视频列表在组件内滚动,**只有 Y 轴滚动**。
- 详情栏数据:选中视频后由父层从列表响应的 `tagsOf` 传给 ContextPane(和现在 BrowsePanel 的做法一致,不多打接口)。

TagPanel 里的树:加 `onSelect`(选中词存 URL `?tag=`,刷新/后退不丢)、清除按钮;`pick` 时 page 归 1 + 清选中(逻辑原样从 BrowsePanel 搬来)。没选词时右侧显示"左边选一个词"。

## 封面角标(替代 summary 的"跨词条"信息)

[web/src/components/ItemGrid.tsx](../../../web/src/components/ItemGrid.tsx) 加可选 prop `badgesOf?: Record<string, string[]>`(调用方算好的、每条视频要显示的词):

- 渲染成封面**左上角**的小 chips —— 右上角已被「已失效」角标占用。
- absolute 定位在封面图内,不占卡片外部空间,卡片高度天然一致。
- TagItemPane 负责算内容:`tagsOf` 里排除当前选中的词,最多显示 3 个,超出补 `+N`。
- 样式:半透明深底 + accent 色,和现有失效角标同一套语言。
- 总览页的 ItemGrid 用法不动(不传 `badgesOf` 就没有角标)。

## 空态文案

ItemGrid 现有空态文案"选择左侧收藏夹,或在上方搜索"在标签页语境不对,加 `emptyText` prop;标签页传"这个词下面还没有视频"。

## 不改的东西

- ContextPane 原样复用(自带折叠)。
- 后端 API 一个不改。

## 验证

- typecheck + `max build`(退出码恒为 1 是既有 esbuild 问题,门禁看 typecheck + "Compiled successfully")。
- 手动过一遍页面:树滚动不再顶飞其他模块、选词出列表、点封面出详情、角标显示正确、标注/质检流程不受影响。
- 布局搬运无分支逻辑,不加单测。
