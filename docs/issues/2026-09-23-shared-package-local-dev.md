# 共享包本地开发：内循环问题（进行中）

> 状态：**未解决，待验证**　最后更新：2026-09-23
> 相关计划：[2026-09-22-ai-suit-tool.md](../superpowers/plans/2026-09-22-ai-suit-tool.md)
> 台账：`.superpowers/sdd/2026-09-22-ai-suit-tool/progress.md`

---

## 一、目标

在**两个独立仓库**（不使用 monorepo / workspace）的前提下，实现共享包的本地开发闭环：

```
改共享包源码 → 消费方页面生效
```

要求：**零手动操作、延迟尽量低（目标 1s 内）**。

---

## 二、已做到哪里（已定案，不要重新讨论）

| 项 | 现状 |
|---|---|
| **公共包** | `@seedhuang/ai_suit_tool`（`D:\Seed\ai_suit_tool`）。exports 子路径：`core` / `fastify` / `react` / `contract` / `contract-tests` / `tokens.css` |
| **BFM 消费方式** | `server/package.json`、`web/package.json` 声明 `"@seedhuang/ai_suit_tool": "file:../../ai_suit_tool"`；根 `.npmrc` 设 `install-links=true`（**复制语义**） |
| **迁移已完成** | `server/src/llm/` 整目录、`logger/redact.ts`、前端 `llmApi`、5 个 AI 类型已删除；BFM 侧由 `server/src/ai.ts` 注入 sqlite / DPAPI / Logger，`server/src/http/index.ts` 挂包路由 |
| **同步工具** | `scripts/sync-local-packages.mjs`（零依赖 ESM）。命令：`npm run sync:local`（build→删副本→install→校验）、`sync:local:check`（只校验）、`sync:local:check:strict`（CI 门禁）。含内容哈希比对、软链穿透防护 |
| **打包器** | **utoopack 已启用**：`web/.umirc.ts` 一行 `utoopack: {}`。实测 dev 热启 **2935ms**、生产 build **2111ms**。深色主题经人工确认正常 |
| **服务** | 后端 3001、前端 8000 可正常启动（根目录 `npm run dev` 同时起两者） |
| **多 CLI 架构** | `D:\Seed\local-pack-manager`（localpack 本体，spec+plan 已写、未实施）+ `D:\Seed\seedcli`（hub 注册中心，oclif plugins 挂载）。**与本文问题无依赖关系** |

---

## 三、核心未解问题

**改共享包源码后，必须手动执行 `sync:local`（删副本 + `npm install`，耗时 6–16s）。每次改一行源码都要付一遍，对开发是灾难。**

### 根因（一句话）

**存在两个 install root → 同一个包有两个物理路径。**

```
D:\Seed\ai_suit_tool\node_modules\...\antd               ← install root ①
D:\Seed\bilibili_favorite_manager\node_modules\...\antd  ← install root ②
```

打包器按**解析后的物理路径**判定模块身份（不按包名、不按版本、不按 inode），两个路径 = 两个模块实例。

### link 路线为何被堵

在 utoopack 下把依赖改成软链后，构建直接失败：

```
Module not found: Can't resolve '@seedhuang/ai_suit_tool/react'
Module not found: Can't resolve '@seedhuang/ai_suit_tool/tokens.css'
```

- 包产物存在、junction 路径通
- **Node 自己能解析**：`require.resolve('@seedhuang/ai_suit_tool/react')` → `D:\Seed\ai_suit_tool\dist\react\index.js` ✅
- 清空 utoopack 持久化缓存后重试 → 依旧失败（**不是缓存问题**）

结论：**utoopack 的解析器不支持"真实路径位于项目根之外的链接包"的子路径导出**。

---

## 四、已证伪的路线（避免重踩）

| 路线 | 结论 | 原因 |
|---|---|---|
| `npm link` / `link:` + utoopack | ❌ 不可行 | 解析失败（见上） |
| **版本对齐** | ❌ 无效 | 实测两份都是 antd **5.29.3** —— 同版本、两个路径，照样两份。版本对齐只治"同一棵树内的多版本嵌套" |
| **peerDependencies** | ❌ 无效 | 它是**安装期声明**，管不了**打包期解析**；且包的 `devDependencies` 让 `node_modules/antd` 物理存在。peer 仅在"存在共同祖先 root"时生效（即 monorepo） |
| **换 pnpm（默认配置）** | ❌ 无效 | 仍是两个 install root。pnpm 的共享只到**磁盘 inode** 层（硬链接），不到**解析路径**层；其去重能力只在**单个 root 内部**生效 |
| pnpm workspace | ✅ 有效 | 但 = monorepo（已明确否决） |
| webpack `resolve.modules.prepend(根 node_modules)` | ❌ 打挂构建 | 全局强制优先根 node_modules，短路了 antd 嵌套的 `@babel/runtime@7.29`（根上那份 7.23.6 缺 `helpers/esm/callSuper`） |
| webpack `resolve.symlinks: false` | ⚠️ 当年实测"无效" | 但**试得不认真**（当时 MFSU 在链路上，可能干扰判断）。值得在 webpack 模式下重测 |

---

## 五、后续要做什么（待验证路线，按优先级）

| # | 路线 | 预期 | 验证判据 |
|---|---|---|---|
| **1** | **utoopack `resolve.alias` 直指源包 dist**（不拷贝、不软链） | ✅ 解析侧成功（antd 单份、深色主题正常），❌ **watch 侧失败**（判据③ 不通过） | ① 产物中 `antd/es/button/button.js` 只有一份 ✅ ② 深色主题正常 ✅ ③ 改源包后 1s 内页面生效 ❌ |
| **2** | **pnpm 全局虚拟 store**（global virtual store）—— 若两项目共享同一套虚拟 store 路径，antd 的 realpath 收敛为同一条 | ❌ **已查证不可行**（2026-09-23，纯查证未实测） | 见第七节第 2 条详述 |
| **3** | **sync 改为直接拷文件**（绕过 `npm install`，只拷 `files` 字段声明的产物） | 6–16s → **~1s** | 耗时可直接测量 |
| **4** | **watch 自动化**（即 localpack 的 `dev` 命令） | 改源码后自动生效，零手动 | 改源码后无需任何命令即可看到变化 |

**说明**：3 + 4 是兜底方案，**不依赖 bundler 能力，必然可行**；1、2 是"零拷贝"的希望所在，需实测。本机 Vite 官方文档对"链接依赖去重问题"的官方建议同样是 `npm pack`（= 复制语义），故 copy 路线是业界认可的兜底做法。

---

## 六、关键路径

```
BFM                d:\Seed\bilibili_favorite_manager
公共包             D:\Seed\ai_suit_tool
localpack 项目     D:\Seed\local-pack-manager     （spec + plan 已写，未实施）
hub                D:\Seed\seedcli                （占位 README）
台账               d:\Seed\bilibili_favorite_manager\.superpowers\sdd\2026-09-22-ai-suit-tool\progress.md
包设计文档         docs\superpowers\specs\2026-09-22-ai-suit-tool-design.md
localpack spec     D:\Seed\local-pack-manager\docs\superpowers\specs\2026-09-23-localpack-design.md
localpack plan     D:\Seed\local-pack-manager\docs\superpowers\plans\2026-09-23-localpack-mvp.md
同步脚本           scripts\sync-local-packages.mjs
```

### 全局约束

- **git 只读**：未经明确要求，禁止一切 git 写操作（不 add / commit / init）
- **Windows + PowerShell**：spawn 子进程必须 `shell: true`（直接 spawn `npm.cmd` 会 `EINVAL`）
- 对**软链 / junction 路径**只用非递归删除（`Directory.Delete(path, false)`），**禁止** `Remove-Item -Recurse`（曾顺着 junction 遍历进源仓库，被沙箱拦下）
- 未经明确要求不提交代码

---

## 七、下一步建议顺序

1. **跑实验 1**（utoopack `resolve.alias`）—— ✅ 已跑（2026-09-23）。结果：**alias 有效但不够**。
   - 判据① 通过：`alias` 让源包 `dist` 内所有裸依赖（含 antd）都解析到 BFM 根 node_modules，日志中源包 antd 物理路径 0 次、BFM antd 577 次；页面控制台无 antd 重复实例警告。
   - 判据② 通过：深色主题正常（body 背景 `rgb(14,14,23)`，auth 页三卡正常渲染）。
   - 判据③ **失败**：utoopack 的 filesystem watcher 只监听 `D:\Seed\bilibili_favorite_manager`（`start filesystem watching{path=...}`），**不覆盖 alias 指向的根外路径** `D:\Seed\ai_suit_tool\dist`。改 dist 后 15s 无 `file change` 记录、页面不更新。alias 解决"身份/解析"，解决不了"watch"。
   - 已按约定回滚：`.umirc.ts` 恢复 `utoopack: {}`、源包 `EntryCard.js` 恢复原样、dev 已停；复制语义（`install-links=true` + 真目录副本）+ `sync:local` 可用（`sync:local:check` 通过）。
   - 结论：route 1 不能单独实现内循环；「alias + watch」需 watch 覆盖源包路径（当前 utoopack 配置无此选项），否则仍需拷贝引擎。→ 推进实验 2
2. **查实验 2**（pnpm 全局虚拟 store）—— ✅ 已查证（2026-09-23，纯查证，未装 pnpm、未改环境）。结论：**不可行**。
   - 能力存在：pnpm ≥11.23 有 `virtualStoreType: global`（旧名 `enableGlobalVirtualStore`），node_modules 只含 symlink，物理文件集中在 `<store-path>/links/<hash>/node_modules/<pkg>`（store-path 默认在用户目录，**项目根外**）。
   - 但它是**实验特性**：项目安装默认禁用，官方明示 "some tools may not work correctly with symlinked node_modules"。
   - 判据①（antd 收敛）**不保证**：包目录按**依赖图哈希**命名，BFM 与 ai_suit_tool 的 antd 依赖图（peer 不同）几乎必然分属不同 hash 目录 → antd 仍可能两份。
   - 判据③（watch 根外）**不支持**：utoopack watcher 只覆盖项目根（实验 1 实测 `start filesystem watching{path=...}` 只含 BFM）；`watch.nodeModulesRegexes` 只能调整对**项目内** node_modules 的忽略策略，不能添加根外 watch 路径。全局虚拟 store 反而把所有依赖的物理文件挪到项目根外。
   - pnpm 的 `file:` 协议是**链接语义**（symlink/hardlink 到源目录，改源码自动反映、不复制）—— 与 npm `install-links=true`（复制）相反。它解决了"内容同步"，但物理路径仍在项目根外，watcher 依然覆盖不到。
   - 落地成本：需 BFM 从 npm 换 pnpm（node_modules 全量重装，破坏现有复制语义与 sync 脚本），收益不成立。
   - → 结论：**1、2 皆不通，实施 3 + 4**
3. **实施 3 + 4**，把内循环压到 ~1s —— ✅ 实验 3 实测已过（2026-09-23）：
   - **实测①（方案 A watch 前提）✅**：`utoopack.watch.nodeModulesRegexes: ['@seedhuang/ai_suit_tool']` 生效 —— 改 `node_modules` 副本 `dist/react/EntryCard.js` 后，watcher 日志出现 `file change{name=...node_modules\@seedhuang\ai_suit_tool\dist\react\EntryCard.js}`（14 条），页面 HMR 生效（标题实时变为 -HMR）。**方案 A 成立，拷贝目标 = 根 node_modules 副本**（含 server 共享、on/off 靠 npm install 闭环、类型解析天然闭环）。
   - **实测②（Turbopack 缓存失效）✅**：连续改动副本（-HMR → -HMR2）均触发 HMR → 缓存按**内容**失效；仅 touch（改 mtime、内容不变）也产生 file change 事件（+6）→ 印证**产物哈希闸门**（内容没变不拷）是必须的，否则事件风暴。
   - **实测③（拷贝耗时）✅**：直接拷 files 产物（69 文件 / 129KB）**全量 101ms、增量 22ms**，对照 `sync:local` 的 6–16s（build + 删副本 + npm install + 校验）→ 两个数量级提升。内循环总延迟 ≈ debounce(100ms) + tsc 增量 + 拷贝(<100ms) + Turbopack 增量重编译。
   - 已回滚：`.umirc.ts` 恢复 `utoopack: {}`、副本与源包 dist 哈希一致、`sync:local:check` 通过。
   - **实验 4（watch 自动化）✅ 全链路验证通过（2026-09-23）**：
     - **build 策略关键发现**：源包 `tsc` 全量 build **2.9s**（超 1s 预算），`--incremental` 无效（no-op 也 5s）；**`tsc --watch` 常驻增量编译 = 423ms**（改 src → dist 更新，精确计时）→ 满足 1s 预算。**localpack dev 采用"spawn tsc --watch + watch dist → 拷贝"形态**（原型 `scripts/dev-local-watch.mjs`）。
     - **环境前置**：沙箱拦截"长驻进程写源包 dist"（tsc --watch EPERM ×69）—— 在 `global.json` 的 `readWrite` 加 `D:\Seed\ai_suit_tool` 目录授权后解决（顺带加 c-drive-cleaner 目录止住 7000+ 逐文件条目增长）。
     - **全链路自动生效**：改 src(`模型条目HMR5`) → 页面**自动**更新为 HMR5，零手动命令（tsc 增量 423ms + 拷贝 ~200ms + 消费方 HMR ~300ms ≈ **~900ms**）；深色主题正常；原型启动时自动首次 build+拷贝。
     - 已回滚：src 恢复、原型/tsc watch/dev 已停、`.umirc.ts` 恢复 `utoopack: {}`、副本与源包哈希一致、临时测量脚本已删。
4. **修订 localpack spec**：`sync` / `dev` 从"v2 可选"升级为 **v1 核心功能**（因 link 已证伪 → copy 是唯一可行路径 → "让副本跟上源包"即其核心价值）

---

## 八、遗留事项

- BFM 工作区有未提交改动：包名替换、`scripts/sync-local-packages.mjs`、`.umirc.ts` 的 utoopack 行、相关文档 —— **提交时机由用户决定**
- localpack spec / plan 需按第七节第 4 条修订
- 实验期间 BFM 的 `.npmrc` 曾临时改为软链；**已恢复** `install-links=true`，副本为真目录
