# 模型管理三层拆分(2026-09-17)

> 用户拍板(2026-09-17,brainstorming 会话):模型管理只管模型,凭证/条目/用途分离。
> 改 `shared-llm-provider.md` §3 的「UI:模型管理页」一节描述的形态;本文件取代其 UI 与配置存储描述。

## 1. 为什么

现状:`llm.*` 一整套配置(服务商/baseUrl/apiKey/模型/两个数字)按用途 main/tag 各存一份,
tag 没配的项逐项回落主模型。问题:

- 想单独给某个功能换模型,得把 key/地址抄一遍或理解"回落"规则
- contextWindow / maxOutput 手填,和注册表两套真相,还要校验 maxOutput < contextWindow
- 「打标卡沿用主模型」的回落语义制造过真实 bug(baseUrl 冒充已配置)

## 2. 三层模型

| 层 | 存什么 | 键 |
|---|---|---|
| **服务商凭证** | provider / baseUrl / apiKey(密文) | `llm.providers`(JSON 数组) |
| **模型条目** | 凭证引用 + 模型名 | `llm.models`(JSON 数组) |
| **用途分配** | 四个用途各指一个条目 id | `llm.purpose.chat` / `.classify` / `.rules` / `.tag` |

用户拍板的四个决定:

1. **清空重配**:旧键(`llm.*` / `tag.*`)启动时不读不迁,UI 一保存新键就接管。
2. **模型名即条目**:条目上不存 contextWindow / maxOutput,数字一律由后端查注册表
   (ollama 运行时 `/api/show` 的现有逻辑不变)。注册表没收录 → 兜底值 + `verified:false`,
   UI 标 ⚠️,和现在一样。**"手填数字"功能删除**。
3. **四用途各自选**:聊天 / 归类 / 规则建议 / 打标 各一个下拉,选条目。
4. **删条目引用中拦截**:被任何用途引用的条目删除时 400,提示先改用途指向。
   删凭证同理(被条目引用则 400)。

## 3. 数据形状(settings 表,值全是字符串)

```jsonc
// llm.providers
[{ "id": "p_xxx", "provider": "deepseek", "baseUrl": "", "apiKey": "<DPAPI 密文>" }]

// llm.models
[{ "id": "m_xxx", "providerId": "p_xxx", "model": "deepseek-v4-flash" }]
```

- id 由后端生成(`crypto.randomUUID()`),不透明,前端只透传。
- baseUrl 留空 = 用 `DEFAULT_BASE_URLS` 的 provider 默认(现有语义不变)。
- **首条条目自动全分配**:添加条目时若四个用途均未分配,四键全部指向它 ——
  避免配完一个模型四处"未配置"。后续条目不动已分配的用途。

## 4. API(替换 `/api/settings/llm` 三件套)

| 路由 | 作用 |
|---|---|
| `GET /api/settings/providers` | 列凭证,**不含明文 key**(只回 hasApiKey) |
| `PUT /api/settings/providers` | 增/改一个凭证 `{id?, provider, baseUrl, apiKey}`;apiKey 留空 = 不改动已存 |
| `DELETE /api/settings/providers/:id` | 删凭证;被条目引用 → 400 |
| `GET /api/settings/models` | 列条目 + 查注册表解析出的 ctx(现有同名路由改语义) |
| `POST /api/settings/models` | 加条目 `{providerId, model}` |
| `DELETE /api/settings/models/:id` | 删条目;被用途引用 → 400 |
| `GET /api/settings/assignments` | 四用途 → 当前条目(含未配置状态) |
| `PUT /api/settings/assignments` | `{chat?, classify?, rules?, tag?}` 各设条目 id |

保留不动:`/api/settings/ollama-models`、`/api/settings/remote-models`、
`/api/settings/test-llm`(入参仍为散字段 `{provider, baseUrl, apiKey, model}`,凭证表单的
测试连接用)。

## 5. 服务端读取侧(消费方零改动)

`readLlmSettings(db, purpose)` 签名不变,`LlmPurpose` 从 `'main' | 'tag'` 扩为
`'chat' | 'classify' | 'rules' | 'tag'`。内部改为:查 `llm.purpose.*` → 找条目 → 找凭证 →
拼 `ModelConfig` + `ModelMeta`。未配置返回 null(调用方现有 `requireLlm` 提示不变)。

- **tag 回落主模型的逻辑删除** —— 四用途平级,未配置就是未配置。
- `isPurposeConfigured` / `keysFor` / 逐项回落代码删除。
- 四个消费方(curator 路由的 chat / classify / ruleRoutes / tagRoutes)**一行不改**:
  chat/classify/rules 继续读默认(现在是 `chat`,由 PUT assignments 时四键都有值保证),
  tagRoutes 读 `tag`。**注意**:routes.ts 里 `readLlmSettings(db)` 不带 purpose 的调用点
  改为显式 `readLlmSettings(db, 'chat')` / `'classify'` / `'rules'` 按各自语义传。

## 6. 前端(ModelManager.tsx 拆三块)

- **服务商凭证卡**:provider 下拉 + baseUrl + API Key,保存进凭证表;测试连接保留。
- **模型条目区**:选凭证 → 选模型(现有刷新/内置表兜底逻辑照搬)→ 添加;列表可删
  (引用中被拦的 400 原样显示)。
- **用途分配区**:四个下拉,选项 = 条目,显示 `provider · model`。

`ModelManager` 的 `purpose="tag"` props 复用模式删除;auth.tsx 渲染一套新组件。

## 7. 测试

- config.ts:新结构的读写测试(分配 → 拼 config;条目/凭证删除拦截;首条自动全分配)。
- routes.test.ts:`/api/settings/llm` 用例改写为新路由;curator 四路由测试不动
  (它们只关心 `readLlmSettings` 的返回形状,签名没变)。
- 前端:auth 页手测 —— 配凭证 → 加条目 → 四用途出现并指向它 → 改一个用途 → 删被引用条目被拦。
