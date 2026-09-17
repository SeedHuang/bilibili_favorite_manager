## 12. 测试策略

不搞 per-function suite,只覆盖关键路径。

| # | 测试 | 为什么 |
|---|---|---|
| 1 | `wbi.test.ts` — 固定 mixinKey + 参数的黄金值 | 最容易错且错得最隐蔽 |
| 2 | `rateLimiter.test.ts` — 抖动落在区间、写档确实更慢 | 风控第一道防线 |
| 3 | `plan/diff.test.ts` — 已在目标夹子不生成 op、tempId 解析、拓扑序 | 防止发出无意义写请求 |
| 4 | `execute/guards.test.ts` — **非失效条目 remove 必须抛 PolicyError** | **安全红线,必须有** |
| 5 | `curator/parse.test.ts` — 坏 JSON 的四层兜底 | 本地小模型必然遇到 |
| 6 | `sync/incremental.test.ts` — media_count 含失效条目时的增量判据 | 防「每次都全量重拉」 |
| 7 | `execute.test.ts` — mock client,验证 -412 停队列、executions 状态、undo 正确 | 风控响应正确性 |

**只手动验证**:真实 API 连通性、wbi 签名在真实环境是否被接受、LLM 真实分类质量。

**不测**:Fastify 路由(太薄)、AntD 组件(无逻辑)。

