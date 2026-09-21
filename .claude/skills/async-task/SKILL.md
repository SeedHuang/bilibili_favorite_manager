---
name: async-task
description: 项目里做任何异步任务时的组件用法 —— 凡是批次任务(分批处理多单位数据)、AI 调用任务、大数据量处理(现有如 AI 标注/质检/方案生成,未来新增任务同样适用)。覆盖三件套、轮询 hook、日志抽屉、设置页接入、启动/中止约定。凡要"跑任务、看进度、看日志、能停"先读这个。
---

# 异步任务三件套用法

spec(权威):`docs/superpowers/specs/2026-09-20-批次任务UX设计.md` §2 十条规则。本 skill 是组件层面的操作手册,冲突以 spec 为准。

## 一句话决策树

```
要做一个异步任务(AI 调用/批次处理/大数量)?
├─ 有批次语义(分批处理多单位数据)?
│   ├─ 是 → 批大小配 poll.<taskType>.batch,启动时 readPoll 读
│   │   └─ 先定语义:**批上限**(实际大小随模型上下文收缩,设置只是松紧上限,
│   │      照 tagRoutes→tagger 传 cap)还是**定长**(每批恒等,照 tagRoutes→tagcheck 传 batch)?
│   │      两者接线不同,别混
│   └─ 否(单次 LLM 调用)→ 不配 batch(前端批次列显示「—」),只配 interval_ms
├─ 轮询怎么写?(三条路,按复杂度选)
│   ├─ 纯哑轮询(拿到结果 setState 就完)→ useTaskProgress
│   ├─ 轮询+自有写入通道/收尾(如 RulesPanel:loadProposal 是唯一写入通道)→
│   │   仍用 useTaskProgress,fetcher 包一层自己的函数传进去
│   └─ 轮询里有停止条件/日志长度判等/错误收尾(如 TagPanel)→ 自写递归 setTimeout,
│       只从 settingsApi.getPolls() 读间隔(照 TagPanel 的 intervalRef 写法)
├─ 有逐行日志要展示?→ TaskLogDrawer(泛型壳);后端日志量大时轮询侧记得判等
│   (照 TagPanel:`prev.length === p.logs.length ? prev : p.logs`,没新行不 set)
└─ 设置页 → TaskSettings 的 POLL_PURPOSES 加你的 taskType
```

## 组件契约(签名逐字,别凭记忆)

### useTaskProgress —— 哑轮询 hook(`web/src/hooks/useTaskProgress.ts`)

```ts
useTaskProgress<T>({ taskType: string; fetcher: () => Promise<T>; enabled: boolean }): T | null
```

- `enabled=true` 立即拉一次 + 递归 setTimeout(单拍失败下一拍重试,出 `console.warn`)
- `fetcher` 用 ref 每渲染更新,内联函数安全;返回值自己从结果读业务状态
- **只用它做哑轮询**。轮询里有停止条件/多路写入(如 RulesPanel 的 loadProposal 是唯一写入通道)→ fetcher 包一层自己的函数传进去,别硬套

### TaskLogDrawer —— 泛型日志抽屉(`web/src/components/TaskLogDrawer.tsx`)

```ts
<TaskLogDrawer<T>
  open onClose onClear title lines={T[]}
  renderLine={(line, index) => ReactNode}   // 行渲染交给调用方
  serialize?={(lines) => string}            // 下载内容,缺省 JSON
  downloadName?: string                     // 缺省 `${title}-${日期}.txt` —— 是 string 不是函数
  warnCount?: number                        // 调用方数好传入(壳不知道哪行是 warn)
  waiting?: boolean                         // 跑着但还没日志 → 空态文案
  top?: ReactNode                           // 日志区之前的插槽(标签页「上一轮变化」用)
/>
```

- 日志缓冲区**放调用方**,不放抽屉 —— 关抽屉不丢
- `index` 是缓冲区绝对下标(封顶窗口下也对)
- 特殊行渲染(如 TagLogLine 四类帧)写一个自己的包装组件(照 TagLogDrawer),别直接把业务塞进壳

### 设置页接入(`web/src/components/TaskSettings.tsx`)

1. server `server/src/db/repo/state.ts`:`POLL_TASKS` 加 taskType,`DEFAULTS` 加默认值
2. web `TaskSettings.tsx`:`POLL_PURPOSES` 加 taskType(purpose 名即 taskType);无批次语义的任务自动显示「—」
3. **前端 setPoll 对有批次的任务恒发数值 batch**(不发 null/不缺省 —— HTTP 层没有恢复默认路径);**无批次语义的任务只发 intervalMs**(如 proposals,server 侧本就忽略 batch 字段)

## 启动/中止(后端)

- 启动:`202 {ok:true}`;运行中再启动 `409`;启动时 `readPoll(db, taskType)` 读配置(改设置下次启动生效)
- 中止:显式接口(照 `POST /api/proposals/abort`);abort 后 running→idle、已落库保留;未在跑 `409`
- **僵尸态自愈**:落库 generating 但内存没在跑(进程重启遗留)→ abort 端点解锁回 idle 返回 ok,别让用户手改库
- 进度接口形状:`{ running, scope?, done, total, error?, logs }`(单次调用类任务可按 spec §3 括号条款沿用现有形状)
- 日志绑当前 run:内存数组,run 开始清空重记,run 结束不清(留下载),重启丢(已知代价)

## 话术模板(启动弹窗,照 confirmTagRun/confirmTagCheck)

- 按钮恒名,只表明任务(「AI 标注」「词库质检」),**不带数据状态**;空库不渲染
- 弹窗说明行:一句话任务说明 + 当前状态数字(`toLocaleString`)
- 选项模板:`继续X —— 只V还没V过的(来源)`(默认)/ `全部重X —— 对所有对象重新V,包括已有的。` + 后果红字 `+ 慎选`
- 非受控 Radio:`content` 只求值一次,onChange 更新闭包变量供 onOk 读(照现实现)

## 必须有 console 日志(硬要求)

**每个异步任务的前端与后端都要打日志,前缀 `[<task>-ui]` / `[<task>]`** —— 照 `[check-ui]`/`[check-poll]`/`[tags/check]` 的数量与位置。这不是调试残留,是这类功能唯一的定位手段:页面状态不对时(按钮常驻、进度不走、卡"生成中"),没有日志就只能猜根因。

前端至少四处:UI 动作(点启动/点中止)、接口受理回执、**每次拉取的状态快照**(`status/drafts/logs` 一起打 —— 「页面为什么显示生成中」的第一现场)、启动失败。
后端至少五处:请求到达、每个拒绝分支(带原因)、受理、状态流转(**只在变化时**打,轮询接口每拍都打会刷屏)、收尾(带耗时 + 结果)。

反例(实测代价):`proposals` 整条链路一条 console 都没有 —— 页面出现"一进来就是生成中 + 中止"时前后端无迹可查,只能靠人读代码猜。

## 卡在"运行中"怎么查(实测有效的三步)

1. **查库里那行**:`status` + 业务字段 + `created_at`。proposals 的例子:
   `uncovered_count IS NULL` = `startProposal` 跑过但没产出(成功会写数字),`created_at` 就是最后一次启动的时刻。
2. **查落库事件表**:正常结束有 `*_READY`,失败/中止有 `*_FAILED`/`*_ABORTED`。
   **一条终止事件都没有 ⇒ run 没走到收尾(进程被杀)**,不是"还在跑"。
3. **看前端 console 的状态快照**(`[<task>-ui] current → {…}`)—— 确认前端拿到的到底是什么。

第 1、2 步在 proposals 上曾经完全查不了(0 日志 + 无诊断记录),只能靠读代码猜;补日志之后三步都能落地。

## 反面清单(实测踩过/审查抓过)

- ❌ 按钮上带「重新标注全部」类范围词 —— 范围决定在弹窗,不占按钮名
- ❌ 哑轮询用 `setInterval` —— 慢响应堆叠、旧覆盖新;一律递归 setTimeout
- ❌ error 级日志渲染成暗点 —— 非 info 一律扎眼(⚠+警示色),徽标计数含 error
- ❌ 抽屉 key/index 用封顶窗口的相对 i —— 用 `hidden + i` 绝对下标
- ❌ `URL.revokeObjectURL` 同步调 —— 延一拍,否则 Firefox/Safari 掐掉下载
- ❌ 批次循环无下界 —— `Math.max(1, batch)`(tagcheck.ts 同款)
- ❌ abort 只看内存 running —— 落库态与内存态分叉(重启)会死锁,abort 要兼做解锁
- ❌ 把「批上限」当定长用(或反之)—— 两种语义接线不同,见决策树第一个分支
- ❌ 长日志列表每拍全量 set —— 后端 append-only 时先判等(`prev.length === p.logs.length ? prev : p.logs`)
