# Spec 索引

> 拆分自 `2026-09-14-bilibili-favorite-manager-design.md`(2026-09-15)。
> 任何 milestone 实施前,按"你要做的事"读以下文件:

## 你要做的事 → 读这些

| 你要做 | 必读 |
|---|---|
| 实施 M4(AI 整理) | `m4-curator-classification.md` + `shared-llm-provider.md` + `shared-data-model.md` + `shared-frontend.md` + `shared-testing.md` |
| 重做整理工作台(2026-09-16) | `m4b-curator-workbench.md` + `shared-data-model.md` + `shared-testing.md` |
| 做「规则」(整理的核心资产,2026-09-16) | `m4c-folder-rules.md` + `m4b-curator-workbench.md` + `shared-data-model.md` |
| 做可中止的 AI 调用 + 归类进度(2026-09-17) | `m4d-abort-and-progress.md` + `m4-curator-classification.md` + `shared-frontend.md` |
| 做条目 AI 标注(2026-09-17) | `m4e-item-tagging.md` + `m4d-abort-and-progress.md` + `shared-data-model.md` |
| 改模型管理(三层凭证/条目/用途,2026-09-17) | `2026-09-17-model-config-redesign.md` + `shared-llm-provider.md` |
| 做标签体系(词库树/质检/规则接入,2026-09-18) | `m4f-tag-library.md` + `m4e-item-tagging.md` + `shared-data-model.md` |
| 写 M5 plan(写回 B 站) | `m5-writeback.md` + `shared-data-model.md` + `shared-logging.md` + `shared-frontend.md` + `shared-testing.md` |
| 改 M1/M2/M3 实现 | `m1-sync-foundation.md` + `shared-logging.md` + `shared-data-model.md` |
| 看 §1 背景 / §2 硬性约束 / §15 非目标 | `shared-charter.md` |
| 看 §3 模型接入 / 多模型表 / 上下文自适应 | `shared-llm-provider.md` |
| 看 §4 目录 / §5 数据模型(含 M4 新增 4 表的标注) | `shared-data-model.md` |
| 看 §6 日志与脱敏(含测试连接脱敏) | `shared-logging.md` |
| 看 §7 同步 / §8 风控(M1/M2 基础) | `m1-sync-foundation.md` |
| 看 §9 AI 整理流程 / 删除保险 / 上下文压缩 / Pass 1 输出校验 | `m4-curator-classification.md` |
| 看 §10 提案 / 执行 / 删除保险 / 写回快照 / 撤回 | `m5-writeback.md` |
| 看 §11 设计语言 / HUD / 4 tab / AI 助手 / 封面代理 | `shared-frontend.md` |
| 看 §12 测试原则 | `shared-testing.md` |
| 看 §13 实施顺序 / §14 已验证 / §15 非目标 | `shared-roadmap-history.md` |

## 拆分原则

- `shared-*` = 跨里程碑通用规则(任何 milestone 都可能参考)
- `m1-* / m4-* / m5-*` = 该 milestone 专属内容
- 拆分依据是"哪些章节被哪个 plan 实际引用",不按数字顺序硬切

## 跨文件共享的关键设计决定(2026-09-15 红队 + 聊定)

以下决定在多个文件里都有交叉引用:

- **删除保险**(shared-charter + m4 + m5 多处):AI 永不产生 remove_item,只能 userId 手动
- **撤回诚实边界**(m5):撤回只对"本地已应用、尚未写回"有效;写回后给审计报告 + 可撤销清单
- **写回前快照**(m5):防止覆盖写回期间的外部修改
- **上下文压缩**(m4):聊天消息 vs taxonomy_draft 拆分,压缩只动聊天
- **测试连接脱敏**(shared-logging):测试请求的 params 走脱敏,禁止记录明文 apiKey
- **整理工作台只显示一份结构**(m4b):快照只读、编辑只写工作副本、AI 只在对话框、留痕记决策不记数据变更
- **规则是核心资产**(m4c):结构化可执行、规则先跑 AI 只补边界、AI 的建议必须能自证

## 注意

- 拆分后**不存在"主 spec"文件**,每个文件地位平等
- 文件开头的 `> split from 2026-09-14-bilibili-favorite-manager-design.md (2026-09-15)` 是追溯标记,可删,不影响内容
