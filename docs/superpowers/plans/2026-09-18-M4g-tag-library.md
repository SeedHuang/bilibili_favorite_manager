# 标签体系(词库树)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 §9E 的"扁平自由文本标签"换成 §9F 的一棵会自己生长的词库树 —— 三张新表取代 `items.ai_tags`,本地小模型生产、flash 质检,词与词的关系由**集合覆盖**算出来(不是拍的阈值),规则引擎多一个 `tag` 字段按**子树**匹配。

**Architecture:** 存储从"条目上存一串字符串"换成 `tags` / `tag_aliases` / `item_tags` 三张关联表 —— 因为"合并两个词"必须能一次改所有挂它的视频。生产链路:本地 4b 两步标注(说领域 → 在领域下取词)产出路径 → 落库走别名表 + (父,名) 去重 → 跑完由 flash 质检新词 → **集合判据(0 token)** 算合并/挂父。规则匹配靠预计算的祖先闭包做子树展开。

**Tech Stack:** Fastify 5 / better-sqlite3 12.11.1 / vitest / @umijs/max + antd 5 + lucide-react

**Spec:** `docs/superpowers/specs/m4f-tag-library.md`(§9F)

## Global Constraints

- Node 22.12 / better-sqlite3 **12.11.1**(不升级 —— 13.x 在本机 win32 dlopen 段错误)
- antd **5**;图标用 `lucide-react`,不用 `@ant-design/icons`
- **弹窗必须走 `App.useApp()`**(`const { modal } = AntApp.useApp()`),静态 `Modal.confirm` 在另一个 React root、读不到 darkAlgorithm
- 路由测试绝不打真实 LLM API —— mock `../llm/provider.js` 的 `complete`/`stream`(沿用 importOriginal 铺开真模块再覆盖的既有模式)
- **web build 退出码恒为 1(既有 esbuild 问题)** —— 门禁看 `typecheck` 通过 + build 输出含 `Compiled successfully`
- **同步永不写 `ai_*` 列**(§9E C8 硬约束)—— 新增的 `ai_kind` 同受此约束,`upsertItem` 的 UPDATE 分支一个字都不能动
- 中文 UI 文案;注释密度照抄现有文件(现有代码注释都讲"为什么")
- **不引入新依赖**:前端不装图形库、后端不装分词/向量库

## 对 spec 的落地细节(不改设计,只定实现)

1. **`tags` 表多一列 `norm`**。spec §9F.2 的 DDL 是 `UNIQUE(parent_id, name)`,但 `name` 要留作**显示**(否则 `NBA` 会被迫存成 `nba`)。拆成:`name` 存首次见到的写法、`norm` 存归一化结果,唯一索引建在 `(COALESCE(parent_id,0), norm)` 上。**`COALESCE` 不能省** —— SQLite 里 NULL 互不相等,裸 `UNIQUE(parent_id, norm)` 拦不住两个同名根。
2. **`items.ai_kind` 走 `ALTER TABLE`**。schema.ts 开头写着"等真的需要改列时再引入 user_version 迁移";这里用一个九行的 `ensureColumn`(查 `PRAGMA table_info` → 没有才 ALTER)顶上,幂等且不引入迁移框架。三张新表仍走 `CREATE TABLE IF NOT EXISTS`。
3. **规则里的 tag 条件存 id 不存名字**。`RuleCondition.any` 是 `string[]`,所以 tag 条件写作 `{field:'tag', any:['42','57']}` —— 存名字的话,改一次词名就悄悄改掉了规则语义。
4. **不做迁移**。`items.ai_tags` 里的旧扁平标签不灌进新树(§9F C1),旧库从零跑一轮。旧列留着不读不写,不 DROP。
5. **`ContextPane` 是显示"这条视频的标签"的落点** —— 它已经在渲染 UP/时长/收藏时间/状态。
6. **标签树的 UI 抄 `WorkFolderTree.tsx` 手写,不用 antd `Tree`** —— 仓库零使用,样式会打架(已回写进 spec C12)。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `server/src/db/schema.ts` | 改 | 加 `tags` / `tag_aliases` / `item_tags` 三表 |
| `server/src/db/index.ts` | 改 | 加 `ensureColumn`,`applySchema` 里给 items 补 `ai_kind` |
| `server/src/db/repo/tags.ts` | **新建** | 词库树的唯一写手:归一化、别名、建树、合并、挂父、覆盖统计 |
| `server/src/db/repo/tags.test.ts` | **新建** | 上面这些的测试 |
| `server/src/db/repo/tagging.ts` | 改 | 删 `ItemTagging`/`parseItemTagging`/`getItemTagging`/`setItemTagging`,加 `markItemTagged`(写 `ai_kind` **和 `ai_checked_at`**) |
| `server/src/db/repo/tagging.test.ts` | 改 | 上面四个被删函数的测试 —— 整个文件重写 |
| `server/src/curator/routes.test.ts` | 改 | `:11` import 了 `setItemTagging`、`:396` 断言 `AI标签:…` |
| `server/src/curator/tagger.ts` | 重写 | 两步标注(说领域 → 取词)+ 路径落库 |
| `server/src/curator/tagger.test.ts` | 重写 | 新输出形状的测试 |
| `server/src/curator/classifier.ts` | 改 | `renderItem` 渲染树标签(需传入 map,避免 N+1) |
| `server/src/curator/classifier.test.ts` | 改 | 跟着 renderItem 改 |
| `server/src/curator/routes.ts` | 改 | run-pass-1/2 建标签 map 传给 prompt;matchAll 传子树 |
| `server/src/curator/tagcheck.ts` | **新建** | 质检:剔泛词 + 定位置 + 首轮组树 |
| `server/src/curator/tagcheck.test.ts` | **新建** | |
| `server/src/curator/tagtree.ts` | **新建** | 集合判据:覆盖、合并、挂父、树变化清单 |
| `server/src/curator/tagtree.test.ts` | **新建** | |
| `server/src/curator/tagRoutes.ts` | 改 | 加 `GET /api/tags/tree`、`/changes`,手动操作路由 |
| `server/src/curator/tagRoutes.test.ts` | 改 | |
| `server/src/llm/config.ts` | 改 | `LlmPurpose` 加 `'tagcheck'` |
| `server/src/curator/rules.ts` | 改 | `matchItem` 支持 `tag` 字段 + 子树展开 |
| `server/src/curator/rules.test.ts` | 改 | |
| `server/src/db/repo/rules.ts` | 改 | `RuleField` 加 `'tag'` |
| `server/src/curator/ruleRoutes.ts` | 改 | 条件校验收 tag;试跑传子树 |
| `server/src/curator/folderProfile.ts` | **新建** | 夹子画像 + 离群标记 |
| `server/src/curator/folderProfile.test.ts` | **新建** | |
| `server/src/http/routes/items.ts` | 改 | `/api/items/:id` 返回该条的标签 |
| `web/.umirc.ts` | 改 | 加 `/tag`、`/browse` 两条路由 |
| `web/src/layouts/index.tsx` | 改 | 导航加两个 tab |
| `web/src/pages/tag.tsx` | **新建** | 「标签」页壳 |
| `web/src/pages/browse.tsx` | **新建** | 「浏览」页壳 |
| `web/src/components/TagTree.tsx` | **新建** | 词库树(手写)—— 两页共用 |
| `web/src/components/TagPanel.tsx` | **新建** | 词库治理实体 |
| `web/src/components/BrowsePanel.tsx` | **新建** | 按标签筛条目 |
| `web/src/components/ContextPane.tsx` | 改 | 详情栏显示标签 |
| `web/src/components/ModelManager.tsx` | 改 | 第五个用途 |
| `web/src/api.ts` | 改 | tagApi 追加词库方法 |
| `web/src/types.ts` | 改 | 新类型 + `LlmPurpose` 加 `'tagcheck'` |

---

### Task 0: thinking 开关(provider 层)

**为什么放最前**:`deepseek-flash` **默认走思考模式**(spec §3 末已记),而这条链路里除聊天之外**全是批量调用** —— 标注 250-400 次、归类一次发几十万 token。开满推理会让输出 token 涨数倍、整体变慢,是整套流程里**唯一能让费用翻倍的杠杆**(§9F.4 的五个杠杆里排第一)。后面每个任务都会跑批,所以先把它做掉。

**Files:**
- Modify: `server/src/llm/provider.ts`
- Test: `server/src/llm/provider.test.ts`

**Interfaces:**
- Produces:
  - `export async function complete(opts: { config; messages; abortSignal?; thinking?: boolean }): Promise<string>`
  - `export async function stream(opts: { …; thinking?: boolean }): Promise<string>`
  - `thinking` **缺省 = 不传这个参数**,交给厂商默认(聊天那条路什么都不用改)

- [ ] **Step 1: 查证 SDK 到底怎么关**

```bash
cd server && grep -rn "thinking\|reasoning" node_modules/@ai-sdk/deepseek/dist/index.d.ts | head -20
grep -rn "deepseek" node_modules/@ai-sdk/deepseek/dist/index.js | grep -i "providerOptions\|thinking" | head
```

两种可能的结果:

- **有对应的 providerOptions 键** → 按它写(下面 Step 3 的 `providerOptions` 处替换成实际键名)
- **没有** → 走兜底:开关做成 no-op,记一条 TODO 注释说明"SDK 不支持,等它支持或换 raw fetch",
  并把结论回写进 `docs/superpowers/specs/shared-llm-provider.md` 那节。**不要**为了这个去手写 HTTP 请求 ——
  那会把 wbi/重试/错误映射那一套重新实现一遍,不值得

- [ ] **Step 2: 写失败测试**(追加到 `provider.test.ts`)

这个文件**不 mock HTTP**,而是用 spy 包住真的 `generateText`(`mocks.generateText`),断言**传进去的参数**:

```ts
  it('thinking=false → providerOptions 里关了思考', async () => {
    mocks.createDeepSeek.mockReturnValue(() => fakeModel());
    await complete({
      config: deepseekCfg,
      messages: [{ role: 'user', content: '嗨' }],
      thinking: false,
    });
    const arg = mocks.generateText.mock.calls.at(-1)![0] as { providerOptions?: unknown };
    expect(JSON.stringify(arg.providerOptions)).toContain('disabled');
  });

  it('不传 thinking → providerOptions 里没有这个字段(聊天那条路一行不变)', async () => {
    mocks.createDeepSeek.mockReturnValue(() => fakeModel());
    await complete({ config: deepseekCfg, messages: [{ role: 'user', content: '嗨' }] });
    const arg = mocks.generateText.mock.calls.at(-1)![0] as { providerOptions?: unknown };
    expect(JSON.stringify(arg.providerOptions ?? {})).not.toContain('thinking');
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd server && npx vitest run src/llm/provider.test.ts`
Expected: FAIL —— 第一个用例断言不成立(参数没传下去)

- [ ] **Step 4: 实现**

`provider.ts` 两个函数的 opts 各加一个字段,并透传给 SDK:

```ts
export async function complete(opts: {
  config: ModelConfig;
  messages: ChatMessage[];
  abortSignal?: AbortSignal;
  /**
   * 要不要走思考模式。**缺省 = 不传**,交给厂商默认(聊天要它,下面 §9D.5 的思考流靠它)。
   *
   * 批量调用必须传 `false`:标注/归类/质检要的是"照格式吐 JSON",不是"想清楚" ——
   * 每批吐一长串推理,输出 token 涨数倍、整体变慢(spec §3 末)。
   */
  thinking?: boolean;
}): Promise<string> {
  // …
  const { text } = await generateText({
    model: languageModel(opts.config),
    ...(instructions ? { instructions } : {}),
    messages: rest,
    ...(opts.thinking === undefined ? {} : { providerOptions: { deepseek: { thinking: { type: opts.thinking ? 'enabled' : 'disabled' } } } }),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
```

`stream` 同样处理(它的调用方是聊天,不传 `thinking` → 行为一行不变)。

> `providerOptions` 的具体形状以 Step 1 查到的为准 —— 上面是 DeepSeek 官方文档的 `thinking.type` 形状;换成 SDK 自己的键名也行,只要 Step 2 的断言改成实际的。

- [ ] **Step 5: 批量调用方传 `false`**

**这个任务排在最先,所以这里只能改"现在就已经存在"的调用点** —— 后面任务新写的
模块(比如 Task 3 的 `tagcheck.ts`)在各自的任务里带上这个参数。清单:

- `curator/tagger.ts` 的 `complete(...)`
- `curator/classifier.ts` 的 `runPass1` / `runPass2` 两处 `complete(...)`
- `curator/chat.ts` 的 `compact()`(滚动摘要,也是批量)
- `curator/routes.ts` 的 `/api/settings/test-llm` —— 连通性测试发的是"回复两个字",
  开满推理会让用户白等十几秒,还以为连不上
- **`chatStream` / `/api/curator/sessions/:id/messages` 不传** —— 聊天要思考流(§9D.5)

> Task 3 写 `tagcheck.ts` 时,它的 `complete` 也要带 `thinking: false` ——
> 那行已经在 Task 3 的代码里了。

- [ ] **Step 6: 跑全量 + 提交**

Run: `cd server && npm test`
Expected: PASS

```bash
git add server/src/llm/provider.ts server/src/llm/provider.test.ts server/src/curator/tagger.ts server/src/curator/classifier.ts server/src/curator/chat.ts
git commit -m "feat(llm): thinking 开关 —— 批量环节关掉思考模式"
```

---

### Task 1: 数据模型 + 词库仓储

**Files:**
- Modify: `server/src/db/schema.ts`(末尾追加三表)
- Modify: `server/src/db/index.ts`
- Create: `server/src/db/repo/tags.ts`
- Test: `server/src/db/repo/tags.test.ts`

**Interfaces:**
- Consumes: `openDb`(已有)
- Produces(后续任务逐字依赖):
  - `export type TagSource = 'ai' | 'rule' | 'user'`
  - `export interface TagRow { id: number; name: string; parentId: number | null }`
  - `export interface TagNode extends TagRow { count: number; children: TagNode[] }`
  - `export function normalizeTagName(raw: string): string`
  - `export function findTag(db, norm: string): number | null` —— 先查别名表,再查根
  - `export function ensureTag(db, name: string, parentId: number | null): number`
  - `export function addAlias(db, name: string, tagId: number): void`
  - `export function linkItemTag(db, itemId: string, tagId: number, source: TagSource): void`
  - `export function itemTagIds(db, itemIds?: readonly string[]): Map<string, number[]>`
  - `export function tagCounts(db): Map<number, number>`
  - `export function listTagTree(db): TagNode[]`
  - `export function subtreeSets(db): Map<number, Set<number>>`
  - `export function mergeTags(db, fromId: number, toId: number): boolean` —— false = 这两个词不能并(会成环/超深),**不是抛错**
  - `export function setTagParent(db, id: number, parentId: number | null): boolean` —— 树结构的**唯一收口**,内置防环 + 深度闸
  - `export function renameTag(db, id: number, name: string): void`
  - `export function deleteTag(db, id: number): void`
  - `export const MAX_TAG_DEPTH = 4`
  - `export function depthOf(db, id: number): number` —— 根的深度是 1
  - `export function wouldExceedDepth(db, id: number, parentId: number | null): boolean`

- [ ] **Step 1: 加三张表(schema.ts 末尾)**

```sql
-- ── §9F 词库树(2026-09-18)──────────────────────────────
-- 取代 items.ai_tags 那一列(它从此不读不写)。为什么是关联表而不是一列 JSON:
-- 「合并两个词」要能一次改掉所有挂它的视频 —— 字符串数组做不到这件事。
--
-- **name 是显示、norm 是身份**。分开的理由:英文名要被小写化才拦得住
-- "NBA"/"nba" 重复,但界面上不该显示成小写。
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  norm       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES tags(id),
  created_at INTEGER NOT NULL
);
-- COALESCE 不能省:SQLite 里 NULL 互不相等,裸 UNIQUE(parent_id, norm)
-- 拦不住两个同名根(NULL, 'nba') 插两次。
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_parent_norm
  ON tags(COALESCE(parent_id, 0), norm);
CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);

-- 见过的所有写法 → 规范节点。**"不重复建立"的物理保证**:合并掉的旧名、
-- 大小写/简繁变体、质检问出来的答案,全在这张表里。查词先查它。
CREATE TABLE IF NOT EXISTS tag_aliases (
  name   TEXT PRIMARY KEY,        -- 归一化后的写法
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE
);

-- 视频 ↔ 词。source 区分谁挂的:'ai' 标注 / 'rule' 规则 / 'user' 手动
CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id),
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source  TEXT NOT NULL,
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);
```

- [ ] **Step 2: db/index.ts 加 ensureColumn 并补 ai_kind**

```ts
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

/**
 * 给**已存在**的表加一列,幂等。
 *
 * items 是既有表,加列走不了 CREATE TABLE IF NOT EXISTS —— 而 schema.ts 开头写着
 * "等真的需要改列时再引入 user_version 迁移"。这里用最小手段顶上:查 PRAGMA
 * 里有没有,没有才 ALTER。够用、幂等、不引入迁移框架。
 * ponytail: 只支持 ADD COLUMN;真要做改类型 / 删列时再上 user_version。
 */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** 幂等应用 DDL */
export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  // §9F C7:kind 是独立的正交轴(形态),迁到自己的列;ai_tags 自此不读不写
  ensureColumn(db, 'items', 'ai_kind', 'ai_kind TEXT');
}
```

- [ ] **Step 3: 写失败测试 `server/src/db/repo/tags.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertItem } from './items.js';
import {
  normalizeTagName, findTag, ensureTag, addAlias, linkItemTag,
  itemTagIds, tagCounts, listTagTree, subtreeSets, mergeTags, setTagParent, deleteTag, renameTag,
} from './tags.js';

const fresh = () => {
  const db = openDb(':memory:');
  upsertItem(db, { id: 'BV1', type: 2, title: '露营装备开箱' });
  upsertItem(db, { id: 'BV2', type: 2, title: '烤羊肉' });
  upsertItem(db, { id: 'BV3', type: 2, title: '天幕怎么搭' });
  return db;
};

describe('normalizeTagName', () => {
  it('trim + 全角转半角 + 小写', () => {
    expect(normalizeTagName('  ＮＢＡ ')).toBe('nba');
    expect(normalizeTagName('NBA')).toBe('nba');
    expect(normalizeTagName('粤菜')).toBe('粤菜');
  });
});

describe('ensureTag', () => {
  it('同一父下同名只建一次,name 保留首次写法', () => {
    const db = fresh();
    const a = ensureTag(db, 'NBA', null);
    const b = ensureTag(db, 'nba', null);
    expect(b).toBe(a);
    expect(db.prepare(`SELECT name FROM tags WHERE id = ?`).get(a)).toEqual({ name: 'NBA' });
  });

  it('COALESCE 索引拦得住两个同名根', () => {
    const db = fresh();
    ensureTag(db, '体育', null);
    ensureTag(db, '体育', null);
    expect(db.prepare(`SELECT COUNT(*) n FROM tags`).get()).toEqual({ n: 1 });
  });

  it('不同父下可以同名', () => {
    const db = fresh();
    const sport = ensureTag(db, '体育', null);
    const food = ensureTag(db, '美食', null);
    expect(ensureTag(db, '篮球', sport)).not.toBe(ensureTag(db, '篮球', food));
  });

  it('子节点不自动记别名 —— 否则"不同父同名"做不到', () => {
    const db = fresh();
    const sport = ensureTag(db, '体育', null);
    const ball = ensureTag(db, '篮球', sport);
    // 别名表是**全局身份**,只有根配得上它;子节点的身份是 (父, 名)
    expect(findTag(db, normalizeTagName('篮球'))).toBeNull();
    // 但同一父下重复调用仍然复用同一个节点(靠 (父,名) 那条唯一索引)
    expect(ensureTag(db, '篮球', sport)).toBe(ball);
  });

  it('根在创建时记一笔别名 —— 拿名字直接查得到', () => {
    const db = fresh();
    const sport = ensureTag(db, '体育', null);
    expect(findTag(db, normalizeTagName('体育'))).toBe(sport);
  });
});

describe('别名表', () => {
  it('addAlias 之后 findTag 命中别名', () => {
    const db = fresh();
    const id = ensureTag(db, '路飞', null);
    addAlias(db, '鲁夫', id);
    expect(findTag(db, normalizeTagName('鲁夫'))).toBe(id);
  });

  it('ensureTag 查不到别名时按 (父,名) 新建', () => {
    const db = fresh();
    const id = findTag(db, normalizeTagName('从没见过的词'));
    expect(id).toBeNull();
  });
});

describe('item_tags 与统计', () => {
  it('linkItemTag 幂等;itemTagIds 只回请求的那些', () => {
    const db = fresh();
    const t = ensureTag(db, '露营', null);
    linkItemTag(db, 'BV1', t, 'ai');
    linkItemTag(db, 'BV1', t, 'ai');
    linkItemTag(db, 'BV3', t, 'ai');
    expect(itemTagIds(db, ['BV1', 'BV2'])).toEqual(new Map([['BV1', [t]]]));
    expect(tagCounts(db).get(t)).toBe(2);
  });
});

describe('listTagTree', () => {
  it('按父子组装,count 是直达条目数(不含子孙)', () => {
    const db = fresh();
    const food = ensureTag(db, '美食', null);
    const roast = ensureTag(db, '烤羊肉', food);
    linkItemTag(db, 'BV2', food, 'ai');
    linkItemTag(db, 'BV2', roast, 'ai');
    const tree = listTagTree(db);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe('美食');
    expect(tree[0]!.count).toBe(1);
    expect(tree[0]!.children[0]!.name).toBe('烤羊肉');
    expect(tree[0]!.children[0]!.count).toBe(1);
  });
});

describe('subtreeSets', () => {
  it('每个节点带上自己和全部后代', () => {
    const db = fresh();
    const food = ensureTag(db, '美食', null);
    const roast = ensureTag(db, '烤羊肉', food);
    const lamb = ensureTag(db, '羊', roast);
    expect(subtreeSets(db).get(food)).toEqual(new Set([food, roast, lamb]));
  });
});

describe('mergeTags', () => {
  it('条目改挂、子节点改挂、旧名进别名表、旧节点消失', () => {
    const db = fresh();
    const keep = ensureTag(db, '路飞', null);
    const drop = ensureTag(db, '鲁夫', null);
    const child = ensureTag(db, '橡胶果实', drop);
    linkItemTag(db, 'BV1', drop, 'ai');

    mergeTags(db, drop, keep);

    expect(db.prepare(`SELECT id FROM tags WHERE id = ?`).get(drop)).toBeUndefined();
    expect(itemTagIds(db, ['BV1']).get('BV1')).toEqual([keep]);
    // 列名是 parent_id —— better-sqlite3 原样回列名,所以断言用 snake_case
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(child)).toEqual({ parent_id: keep });
    expect(findTag(db, normalizeTagName('鲁夫'))).toBe(keep);
  });

  it('不让自己并进自己的后代(会成环)', () => {
    const db = fresh();
    const parent = ensureTag(db, '美食', null);
    const child = ensureTag(db, '烤羊肉', parent);
    expect(mergeTags(db, parent, child)).toBe(false);
    // 反过来可以:子是孙的后代,但孙不是子的后代
    const grand = ensureTag(db, '羊', child);
    expect(mergeTags(db, child, grand)).toBe(false);
    expect(mergeTags(db, grand, parent)).toBe(true);
  });
});

describe('setTagParent / renameTag / deleteTag', () => {
  it('挂父后子树跟着走', () => {
    const db = fresh();
    const sport = ensureTag(db, '体育', null);
    const camp = ensureTag(db, '露营', null);
    expect(setTagParent(db, camp, sport)).toBe(true);
    expect(subtreeSets(db).get(sport)!.has(camp)).toBe(true);
  });

  it('拒绝自己挂自己、挂到自己后代(防环)', () => {
    const db = fresh();
    const parent = ensureTag(db, '美食', null);
    const child = ensureTag(db, '烤羊肉', parent);
    expect(setTagParent(db, parent, parent)).toBe(false);
    expect(setTagParent(db, parent, child)).toBe(false);
    // 环没造出来 —— 两个节点仍在正常的父子关系上
    expect(listTagTree(db)).toHaveLength(1);
    expect(listTagTree(db)[0]!.children).toHaveLength(1);
  });

  it('拒绝挂到会超深的位置', () => {
    const db = fresh();
    const a = ensureTag(db, 'L1', null);
    const b = ensureTag(db, 'L2', a);
    const c = ensureTag(db, 'L3', b);
    const d = ensureTag(db, 'L4', c);
    // a 这棵子树高 4,挂到 d(深度 4)下面会到 7 层,超封顶
    expect(setTagParent(db, a, d)).toBe(false);
    expect(depthOf(db, a)).toBe(1);
    // 挂到 b(深度 2)下 → a 在最深第 4 层,允许
    expect(setTagParent(db, a, b)).toBe(true);
    expect(depthOf(db, d)).toBe(4);
  });

  it('renameTag 换 name 与 norm,并把**旧名**留进别名表', () => {
    const db = fresh();
    const id = ensureTag(db, 'NBA', null);
    renameTag(db, id, '美职篮');
    expect(findTag(db, normalizeTagName('美职篮'))).toBe(id);
    expect(findTag(db, normalizeTagName('NBA'))).toBe(id); // 老引用还找得到
    expect(db.prepare(`SELECT name FROM tags WHERE id = ?`).get(id)).toEqual({ name: '美职篮' });
  });

  it('deleteTag 连带删掉它的条目关联与别名', () => {
    const db = fresh();
    const id = ensureTag(db, '临时', null);
    addAlias(db, 'temp', id);
    linkItemTag(db, 'BV1', id, 'ai');
    deleteTag(db, id);
    expect(itemTagIds(db, ['BV1']).get('BV1')).toBeUndefined();
    expect(findTag(db, normalizeTagName('temp'))).toBeNull();
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd server && npx vitest run src/db/repo/tags.test.ts`
Expected: FAIL —— `Failed to resolve import "./tags.js"`

- [ ] **Step 5: 写 `server/src/db/repo/tags.ts`**

```ts
import type Database from 'better-sqlite3';

/**
 * 词库树 —— §9F 的存储层。
 *
 * 三张表(tags / tag_aliases / item_tags)的唯一写手。只有一条不变量:
 * **任何走过的名字都能查到归宿** —— 先查别名表,再查 (父, 归一化名)。
 * 这条不变量就是"不重复建立"的物理保证:合并一次,永久记住。
 */
export type TagSource = 'ai' | 'rule' | 'user';

export interface TagRow {
  id: number;
  name: string;
  parentId: number | null;
}

export interface TagNode extends TagRow {
  /** 直达这个节点的条目数 —— **不含子孙**(子孙的数在它自己那儿) */
  count: number;
  children: TagNode[];
}

/**
 * 归一化(C3):**只做确定性的那几样**。
 *
 * 简繁和译名差异(路飞/鲁夫)字符串规则做不到,硬做只会做错 —— 那交给别名表
 * 和集合判据(C9)。这里只管大小写、全角和首尾标点。
 */
export function normalizeTagName(raw: string): string {
  return raw
    .replace(/　/g, ' ')                                   // 全角空格
    .replace(/[！-～]/g, (c) =>                         // 全角 ASCII → 半角
      String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/^[\s·・、,，.。:：;；!！?？'"“”‘’\-—]+/, '')
    .replace(/[\s·・、,，.。:：;；!！?？'"“”‘’\-—]+$/, '')
    .toLowerCase();
}

/**
 * 按名字找节点 —— 查的是**全局身份**:先查别名表,再查根。
 *
 * **它故意不查子节点**。子节点的身份是 (父, 名),同名可以有好几个,
 * 所以"按名字返回唯一一个"对它没有意义 —— 那种查找要用 `ensureTag(name, parentId)`
 * 或者直接按 `norm` 查表(`tagcheck.ts` 的 `byName` 就是后者)。
 */
export function findTag(db: Database.Database, norm: string): number | null {
  const aliased = db.prepare(`SELECT tag_id FROM tag_aliases WHERE name = ?`).get(norm) as
    | { tag_id: number }
    | undefined;
  if (aliased) return aliased.tag_id;
  const root = db.prepare(`SELECT id FROM tags WHERE parent_id IS NULL AND norm = ?`).get(norm) as
    | { id: number }
    | undefined;
  return root ? root.id : null;
}

/** 记一笔"这个写法归到那个节点"。重复写入是幂等的(同一个写法只属于一个节点) */
export function addAlias(db: Database.Database, name: string, tagId: number): void {
  const norm = normalizeTagName(name);
  if (!norm) return;
  db.prepare(
    `INSERT INTO tag_aliases (name, tag_id) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET tag_id = excluded.tag_id`,
  ).run(norm, tagId);
}

/**
 * 找到或建出 (父, 名) 这个节点,返回 id。
 *
 * **先查别名表再查 (父,名)** —— 顺序不能反:一个词被合并过之后,别名表里
 * 记着它的归宿,而 (父,名) 下已经没有它了。反过来的话,模型每吐一次旧名就
 * 新建一个节点,别名表形同虚设。
 */
export function ensureTag(
  db: Database.Database,
  name: string,
  parentId: number | null,
): number {
  const norm = normalizeTagName(name);
  const known = findTag(db, norm);
  if (known !== null) return known;

  const existing = parentId === null
    ? db.prepare(`SELECT id FROM tags WHERE parent_id IS NULL AND norm = ?`).get(norm)
    : db.prepare(`SELECT id FROM tags WHERE parent_id = ? AND norm = ?`).get(parentId, norm);
  if (existing) return (existing as { id: number }).id;

  const info = db
    .prepare(`INSERT INTO tags (name, norm, parent_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(name.trim() || norm, norm, parentId, Date.now());
  const id = Number(info.lastInsertRowid);
  // **只有根记别名,子节点不记。**
  //
  // 别名表是**全局身份**(一个写法 → 一个节点),而子节点的身份是 **(父, 名)** ——
  // 不同父下同名是合法的,`UNIQUE(parent_id, norm)` 保的就是这个。
  // 给子节点也记一笔的话,`findTag` 会短路:第二次 `ensureTag('篮球', 别的父)`
  // 在别名表命中、返回**同一个节点**,"不同父可以同名"就永远做不到,那个唯一索引
  // 成了死条款。(这一版初稿就是这么写的,测试和实现直接对不上。)
  if (parentId === null) addAlias(db, norm, id);
  return id;
}

export function linkItemTag(
  db: Database.Database,
  itemId: string,
  tagId: number,
  source: TagSource,
): void {
  db.prepare(
    `INSERT INTO item_tags (item_id, tag_id, source) VALUES (?, ?, ?)
     ON CONFLICT(item_id, tag_id) DO NOTHING`,
  ).run(itemId, tagId, source);
}

/** itemId → 它挂的 tag id。**不传 ids 就是全库** —— 调用方按需选,别默认全量 */
export function itemTagIds(
  db: Database.Database,
  itemIds?: readonly string[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (itemIds && itemIds.length === 0) return out;

  let rows: { item_id: string; tag_id: number }[];
  if (itemIds) {
    // 分批 IN —— SQLite 的变量上限是 32766,归类批最多几千条,一批就够
    rows = db
      .prepare(
        `SELECT item_id, tag_id FROM item_tags
          WHERE item_id IN (${itemIds.map(() => '?').join(',')})
          ORDER BY item_id, tag_id`,
      )
      .all(...itemIds) as { item_id: string; tag_id: number }[];
  } else {
    rows = db
      .prepare(`SELECT item_id, tag_id FROM item_tags ORDER BY item_id, tag_id`)
      .all() as { item_id: string; tag_id: number }[];
  }

  for (const r of rows) {
    const arr = out.get(r.item_id);
    if (arr) arr.push(r.tag_id);
    else out.set(r.item_id, [r.tag_id]);
  }
  return out;
}

/** tagId → 直达条目数。集合判据(C9)的原料 */
export function tagCounts(db: Database.Database): Map<number, number> {
  const rows = db
    .prepare(`SELECT tag_id, COUNT(*) n FROM item_tags GROUP BY tag_id`)
    .all() as { tag_id: number; n: number }[];
  return new Map(rows.map((r) => [r.tag_id, r.n]));
}

/** 整棵树。count 用 tagCounts,不递归求和 */
export function listTagTree(db: Database.Database): TagNode[] {
  const rows = db
    .prepare(`SELECT id, name, parent_id FROM tags ORDER BY name`)
    .all() as { id: number; name: string; parent_id: number | null }[];
  const counts = tagCounts(db);

  const byId = new Map<number, TagNode>();
  for (const r of rows) {
    byId.set(r.id, { id: r.id, name: r.name, parentId: r.parent_id, count: counts.get(r.id) ?? 0, children: [] });
  }
  const roots: TagNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    const parent = r.parent_id === null ? null : byId.get(r.parent_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * tagId → 它的子树(含自己)。规则匹配(C11 选父命中所有后代)和集合判据都靠它。
 *
 * 一次遍历算完再回填 —— 不用递归 SQL:词库是几千个量级,全内存比递归 CTE 好读。
 */
export function subtreeSets(db: Database.Database): Map<number, Set<number>> {
  const rows = db.prepare(`SELECT id, parent_id FROM tags`).all() as
    { id: number; parent_id: number | null }[];
  const childrenOf = new Map<number, number[]>();
  for (const r of rows) {
    if (r.parent_id === null) continue;
    const arr = childrenOf.get(r.parent_id);
    if (arr) arr.push(r.id);
    else childrenOf.set(r.parent_id, [r.id]);
  }

  const out = new Map<number, Set<number>>();
  const build = (id: number): Set<number> => {
    const cached = out.get(id);
    if (cached) return cached;
    const set = new Set<number>([id]);
    out.set(id, set); // 先放进去,防环(手改库造出环时不至于死循环)
    for (const c of childrenOf.get(id) ?? []) for (const x of build(c)) set.add(x);
    return set;
  };
  for (const r of rows) build(r.id);
  return out;
}

/**
 * 把 fromId 并进 toId:条目改挂、子节点改挂、旧名进别名表、旧节点删掉。
 *
 * **这就是为什么要用关联表而不是一列 JSON** —— 字符串数组做不到"改一次词,
 * 所有视频跟着走"。
 */
/**
 * 把 from 并进 to。**先过和挂父同一套闸。**
 *
 * 它换的是整棵子树(子节点跟着改父),所以两条都可能踩:并进**自己的后代**会造环,
 * 并进深层节点会超深。而它走的是裸 SQL,绕过了 `setTagParent` —— 闸必须在这儿
 * 再查一次。
 *
 * 返回 false = 这两个词不能并(**不是抛错**):用户在下拉里挑错目标很正常,
 * 质检判错也很正常,那都该是"这次不动",不该炸掉整轮。
 */
export function mergeTags(db: Database.Database, fromId: number, toId: number): boolean {
  if (fromId === toId) return false;
  if (isDescendant(db, toId, fromId)) return false; // to 是 from 的后代 → 会成环
  if (wouldExceedDepth(db, fromId, toId)) return false;
  db.transaction(() => {
    const from = db.prepare(`SELECT name FROM tags WHERE id = ?`).get(fromId) as
      | { name: string }
      | undefined;
    // 已经挂到目标的条目:直接丢,别撞 PK
    db.prepare(
      `UPDATE item_tags SET tag_id = ?
        WHERE tag_id = ? AND item_id NOT IN (SELECT item_id FROM item_tags WHERE tag_id = ?)`,
    ).run(toId, fromId, toId);
    db.prepare(`DELETE FROM item_tags WHERE tag_id = ?`).run(fromId);
    db.prepare(`UPDATE tags SET parent_id = ? WHERE parent_id = ?`).run(toId, fromId);
    if (from) addAlias(db, from.name, toId);
    db.prepare(`UPDATE tag_aliases SET tag_id = ? WHERE tag_id = ?`).run(toId, fromId);
    db.prepare(`DELETE FROM tags WHERE id = ?`).run(fromId);
  })();
  return true;
}

/**
 * 挂父 —— **树结构的唯一收口**,两道闸都在这儿。
 *
 * 为什么不放在各调用点:挂父有四条路(质检的 move、判据的 reparent、手动 PATCH、
 * 手动合并的批量改父)。分散着写必然漏,而漏掉**挂到自己后代**那一处的后果是
 * **造出环** —— 环上的节点全都不是 root,`listTagTree` 把它们塞进自己的 children,
 * 于是整段子树从页面上消失(库里还在)。
 *
 * 返回 false = 这次挂父被拒(自己挂自己 / 挂到自己后代 / 会超深)。调用方**不该**
 * 因此报错 —— 这是"这条改动不合法",不是"出故障了"。
 *
 * `ponytail: 每次全表读一遍父边。树是几千个词、挂父是低频操作(每轮几十次),
 * 值不上把父边缓存在调用方传进来。真变成热点再说。`
 */
export function setTagParent(
  db: Database.Database,
  id: number,
  parentId: number | null,
): boolean {
  if (id === parentId) return false;
  if (parentId !== null && isDescendant(db, parentId, id)) return false; // 挂到自己后代 → 成环
  if (parentId !== null && wouldExceedDepth(db, id, parentId)) return false;
  db.prepare(`UPDATE tags SET parent_id = ? WHERE id = ?`).run(parentId, id);
  return true;
}

/** node 是不是 anc 的后代(anc 自己在不在它的祖先链上)—— 防环 */
function isDescendant(db: Database.Database, node: number, anc: number): boolean {
  const parentOf = new Map(
    (db.prepare(`SELECT id, parent_id FROM tags`).all() as
      { id: number; parent_id: number | null }[]).map((r) => [r.id, r.parent_id]),
  );
  let cur: number | null | undefined = node;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    if (cur === anc) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

export function renameTag(db: Database.Database, id: number, name: string): void {
  const norm = normalizeTagName(name);
  if (!norm) return;
  db.transaction(() => {
    const prev = db.prepare(`SELECT name, parent_id FROM tags WHERE id = ?`).get(id) as
      | { name: string; parent_id: number | null }
      | undefined;
    db.prepare(`UPDATE tags SET name = ?, norm = ? WHERE id = ?`).run(name.trim(), norm, id);
    // **旧名进别名表**(老的引用还找得到它);**根**顺带把新名也记一笔 ——
    // 子节点的新名不进别名表,理由和 `ensureTag` 那条一样:别名是全局身份,
    // 而子节点的身份是 (父, 名)
    if (prev) addAlias(db, prev.name, id);
    if (prev?.parent_id === null) addAlias(db, norm, id);
  })();
}

export function deleteTag(db: Database.Database, id: number): void {
  db.transaction(() => {
    // 子节点提一级,别连带删掉一整棵 —— 删一个词不该毁掉它底下所有东西
    const kids = db.prepare(`SELECT id, name FROM tags WHERE parent_id = ?`).all(id) as
      { id: number; name: string }[];
    db.prepare(`UPDATE tags SET parent_id = NULL WHERE parent_id = ?`).run(id);
    // 提上来的子节点**现在是根了** —— 根要能被名字直接查到(见 findTag),
    // 所以补一笔别名。漏了这一步会出现"查不到自己的根"
    for (const k of kids) addAlias(db, k.name, k.id);

    db.prepare(`DELETE FROM item_tags WHERE tag_id = ?`).run(id);
    db.prepare(`DELETE FROM tag_aliases WHERE tag_id = ?`).run(id);
    db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
  })();
}

/**
 * 树深封顶(spec §9F C2):**根的深度是 1**。
 *
 * 为什么封顶:模型和判据都可能越走越深(`体育/篮球/NBA/湖人/詹姆斯`),而一棵
 * 深成一条线的树是**目录**不是分类 —— 它再也帮不上"各个象限上的分类"。
 */
export const MAX_TAG_DEPTH = 4;

/** 节点自己的深度。找不到(脏数据)→ 1,宁可按浅的算 */
export function depthOf(db: Database.Database, id: number): number {
  const parentOf = new Map(
    (db.prepare(`SELECT id, parent_id FROM tags`).all() as
      { id: number; parent_id: number | null }[]).map((r) => [r.id, r.parent_id]),
  );
  let depth = 0;
  let cur: number | null | undefined = id;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    depth += 1;
    cur = parentOf.get(cur) ?? null;
  }
  return Math.max(1, depth);
}

/**
 * 把 id 挂到 parentId 下会不会超深。**挂父的每一处都要先问这一句** ——
 * 质检的 move 和判据的 reparent 各一处。超了就留原位,不是截断(截断会丢掉整棵子树)。
 */
export function wouldExceedDepth(
  db: Database.Database,
  id: number,
  parentId: number | null,
): boolean {
  if (parentId === null) return false;                 // 归到根永远不超
  if (parentId === id) return true;                    // 自己挂自己
  // 目标父的深度 + 这棵子树的**高度**(不是 id 自己的深度)
  const heightOf = (root: number): number => {
    const kids = new Map<number, number[]>();
    for (const r of db.prepare(`SELECT id, parent_id FROM tags`).all() as
      { id: number; parent_id: number | null }[]) {
      if (r.parent_id === null) continue;
      (kids.get(r.parent_id) ?? kids.set(r.parent_id, []).get(r.parent_id)!).push(r.id);
    }
    const walk = (n: number): number =>
      1 + Math.max(0, ...(kids.get(n) ?? []).map(walk));
    return walk(root);
  };
  return depthOf(db, parentId) + heightOf(id) - 1 > MAX_TAG_DEPTH;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd server && npx vitest run src/db/repo/tags.test.ts`
Expected: PASS(13 条)

- [ ] **Step 7: 提交**

```bash
git add server/src/db/schema.ts server/src/db/index.ts server/src/db/repo/tags.ts server/src/db/repo/tags.test.ts
git commit -m "feat(tags): 词库树三张表 + 仓储层(归一化/别名/建树/合并)"
```

---

### Task 2: 标签进 AI 链路(标注产出 + 归类消费)

一次切换:`items.ai_tags` 停止读写,标注产出树标签,归类看到树标签。**这两件事必须同一个任务** —— 分开的话中间那一步 `classifier.ts` 会 import 一个已被删掉的函数。

**Files:**
- Modify: `server/src/db/repo/tagging.ts`(删四个导出,加 `markItemTagged`)
- Rewrite: `server/src/curator/tagger.ts` / `tagger.test.ts`
- Modify: `server/src/curator/classifier.ts`(`renderItem` + 两个 prompt builder 签名)
- Modify: `server/src/curator/classifier.test.ts`(跟着改)
- Modify: `server/src/curator/routes.ts`(run-pass-1 / run-pass-2 建 tagInfo map)
- **Modify**: `server/src/db/repo/tagging.test.ts` —— 整个文件,它 import 了被删的四个函数
- **Modify**: `server/src/curator/routes.test.ts` —— `:11` 的 import、`:384` 的调用、`:396` 的 `AI标签:…` 断言

**Interfaces:**
- Consumes: Task 1 的 `ensureTag` / `addAlias` / `linkItemTag` / `itemTagIds` / `normalizeTagName`
- Produces:
  - `export function markItemTagged(db, itemId: string, kind: string): void`(`db/repo/tagging.ts`)—— 同时写 `ai_kind` 与 `ai_checked_at`(增量水位线)
  - `export interface TagOutput { id: string; kind: string; domains: string[]; tags: string[] }`
  - `export function coerceTagOutput(raw: unknown, batchIds: ReadonlySet<string>): TagOutput[]`(`curator/tagger.ts`)
  - `export function applyTagOutput(db, o: TagOutput): { created: string[] }`(`curator/tagger.ts`)
  - `export function tagInfoByItem(db): Map<string, { names: string[]; kind: string | null }>`(写到 `db/repo/tags.ts`)
  - `export function renderItem(i: ItemRow, maxIntro: number, tagNames?: readonly string[]): string`(`curator/classifier.ts`)
  - `export function buildPass1Prompt(opts: {…; tagNames: ReadonlyMap<string, readonly string[]>})` / `buildPass2Prompt(opts: {…; tagNames: ReadonlyMap<string, readonly string[]>})`

- [ ] **Step 1: 改 `db/repo/tagging.ts`**

删掉 `ItemTagging` / `parseItemTagging` / `getItemTagging` / `setItemTagging`(被 tags.ts 取代),加:

```ts
/**
 * 标注落地的那两个 AI 列:形态 + **水位线**。
 *
 * 形态(教学/娱乐/…)是 §9F C7 明文规定的**独立正交轴**,不并入主题树 ——
 * 混进树会让集合判据的合并/挂父要给保留节点开一堆例外,一列比一套例外便宜。
 *
 * **`ai_checked_at` 是增量标注的唯一依据**(`listUntaggedItemIds` 查的就是
 * `ai_checked_at IS NULL`)。它必须在这儿写:原来写它的那个函数
 * (`setItemTagging`)被这次改造删掉了 —— 忘了接手的话,「AI 标注」每次都把
 * 全库 3250 条重标一遍,「增量」和「重新标注全部」不再有区别,而界面上
 * **看不出任何异常**(进度条照跑,「已标 N/M」恒为 0)。
 *
 * 两列都属于 C8 的 AI 派生列 —— 同步永不写它们。
 */
export function markItemTagged(db: Database.Database, id: string, kind: string): void {
  db.prepare(`UPDATE items SET ai_kind = ?, ai_checked_at = ? WHERE id = ?`)
    .run(kind, Date.now(), id);
}
```

`listUntaggedItemIds` / `tagStats` 原样保留 —— **它们现在靠 `markItemTagged` 喂**。

被删掉的 `ItemTagging` / `parseItemTagging` / `getItemTagging` / `setItemTagging`
没有一个生产调用方(`parseItemTagging` 只有 `classifier.ts` 的 `renderItem` 用,
Step 7 会改掉),但**两个测试文件直接 import 它们**:

- `server/src/db/repo/tagging.test.ts` —— 整个文件
- `server/src/curator/routes.test.ts`(`:11` 的 import、`:384` 的调用、`:396` 的断言)

这两个必须**同一个任务里改掉**,否则 import 期就崩、整个文件红。它们钉的
两条守卫要在新测试里补回来:① 标注写 `ai_checked_at`(增量靠它);
② 同步的 `upsertItem` 不碰 `ai_*` 列(§9E C8 硬规矩)。

- [ ] **Step 2: 写失败测试 `server/src/curator/tagger.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
import { listUntaggedItemIds } from '../db/repo/tagging.js';
import { itemTagIds, listTagTree, normalizeTagName, findTag } from '../db/repo/tags.js';
import type { ItemRow } from '../db/repo/items.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

const { runTagging, coerceTagOutput } = await import('./tagger.js');

const ctx = { provider: 'ollama', model: 'qwen3-4b', contextWindow: 262_144, maxOutput: 8_192, verified: true };
const config = { id: '本地', provider: 'ollama', baseUrl: '', apiKey: '', model: 'qwen3-4b' };

const item = (id: string, title: string): ItemRow => ({
  id, type: 2, title, intro: null, cover: null, upper_mid: null, upper_name: null,
  duration: null, pubtime: null, invalid: 0, invalid_checked_at: null,
  ai_tags: null, ai_summary: null, ai_checked_at: null, raw: null,
} as ItemRow);

beforeEach(() => vi.clearAllMocks());

describe('coerceTagOutput', () => {
  it('只收本批的 id;tags/domains 非数组或空串一律丢掉', () => {
    const got = coerceTagOutput(
      [
        { id: 'BV1', kind: '娱乐', domains: ['美食'], tags: ['烤羊肉', ''] },
        { id: 'BV9', kind: '娱乐', domains: ['美食'], tags: ['不该收'] },
        { id: 'BV2', kind: '教学', domains: 'not-array', tags: ['x'] },
      ],
      new Set(['BV1', 'BV2']),
    );
    expect(got.map((o) => o.id)).toEqual(['BV1', 'BV2']);
    expect(got[0]!.tags).toEqual(['烤羊肉']);
    expect(got[1]!.domains).toEqual([]);
  });

  it('领域和标签都空 → 整条丢弃,当没标(留给下一轮重试)', () => {
    // 收下它的话会写 ai_checked_at、于是这条**再也不会被重标**(增量只挑
    // ai_checked_at IS NULL),而它一个标签都没拿到 —— 等于永久漏掉
    expect(coerceTagOutput([{ id: 'BV1' }], new Set(['BV1']))).toEqual([]);
  });

  it('只有 kind、没有标签 → 也算没标上(标签才是这条链路的目的)', () => {
    expect(coerceTagOutput([{ id: 'BV1', kind: '教学' }], new Set(['BV1']))).toEqual([]);
  });
});

describe('runTagging', () => {
  it('领域成为根,词挂在领域下;别名表记下每个词', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: '我在新疆野外烤羊肉' });
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { id: 'BV1', kind: '娱乐', domains: ['美食', '户外'], tags: ['露营', '烤羊肉'] },
      ]),
    );

    const r = await runTagging({ config, ctx, items: [item('BV1', '我在新疆野外烤羊肉')], db });
    expect(r.tagged).toBe(1);

    const tree = listTagTree(db);
    expect(tree.map((n) => n.name).sort()).toEqual(['户外', '美食']);
    const ids = itemTagIds(db, ['BV1']).get('BV1')!;
    expect(ids).toHaveLength(4); // 2 个领域 + 2 个词
    expect(findTag(db, normalizeTagName('露营'))).not.toBeNull();
  });

  it('跑第二遍同样的输入不新建节点(别名表的用处)', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
    const out = JSON.stringify([{ id: 'BV1', kind: '娱乐', domains: ['美食'], tags: ['露营'] }]);
    mocks.complete.mockResolvedValue(out);
    await runTagging({ config, ctx, items: [item('BV1', 'a')], db });
    const before = db.prepare(`SELECT COUNT(*) n FROM tags`).get();
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ id: 'BV2', kind: '娱乐', domains: ['美食'], tags: ['露营'] }]),
    );
    await runTagging({ config, ctx, items: [item('BV2', 'b')], db });
    expect(db.prepare(`SELECT COUNT(*) n FROM tags`).get()).toEqual(before);
  });

  it('模型漏条 → 补轮(逐条覆盖断言)', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
    mocks.complete
      .mockResolvedValueOnce(JSON.stringify([{ id: 'BV1', kind: '娱乐', domains: ['x'], tags: ['y'] }]))
      .mockResolvedValueOnce(JSON.stringify([{ id: 'BV2', kind: '娱乐', domains: ['x'], tags: ['z'] }]));
    const r = await runTagging({ config, ctx, items: [item('BV1', 'a'), item('BV2', 'b')], db });
    expect(r.tagged).toBe(2);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it('中止时不记失败,已完成的保留', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    const ctrl = new AbortController();
    mocks.complete.mockImplementation(async () => {
      ctrl.abort();
      throw new DOMException('已中止', 'AbortError');
    });
    const r = await runTagging({ config, ctx, items: [item('BV1', 'a')], db, signal: ctrl.signal });
    expect(r.failedBatches).toHaveLength(0);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/tagger.test.ts`
Expected: FAIL —— `coerceTagOutput is not a function`

- [ ] **Step 4: 重写 `server/src/curator/tagger.ts`**

替换 `TAG_SYSTEM`、`coerceTag`、`askOnce`;其余骨架(批大小 16、逐条覆盖断言、缩批、abort、落库时机)照旧。

```ts
/**
 * 条目 AI 标注(spec §9F.3)—— 两段式的第一段:本地小模型逐条产出**树标签**。
 *
 * **用本地小模型是特性不是妥协**(§9E.0 实测):标注是逐条判断,4b 免费 + 全库 5 分钟;
 * 语义理解的重活留给第二段的强模型。
 *
 * **两步不是一次**(§9F C5):先说这条视频属于哪些领域(1-3 个,可以是新的),
 * 再在领域下取词。为什么不是一把梭出一串词 —— 第一步是给模型的思考台阶,让它先
 * 想"这是什么世界"再选词;而且领域名**不受已有树约束**(早期版本要求"必须是已有根"
 * 是错的:新领域第一次出现时树上什么都没有,逼它选等于逼它瞎猜)。
 */
export const TAG_SYSTEM = `你是 bilibili 收藏的标注助手。对每条视频,分两步想:

第一步 **domains**:这条视频属于哪 1~3 个**领域**(如 美食、户外、动漫、体育、学习、游戏)。
  领域名可以是新的,不要为了迁就已有词汇而硬套。

第二步 **tags**:在每个领域下,给出这条视频的**具体词**(2~6 个)。
  要具体到能区分内容:作品名、角色名、赛事名、菜系、技术名都行(如 海贼王 / 路飞 / NBA / 粤菜 / Stable Diffusion)。
  **不要写泛词** —— "视频""教程""AI""分享"这类词没有任何区分力,一律不要。
  不要写标题里没有依据的词。

另外给一个 **kind**:内容形态,**只能**是「${TAG_KINDS.join(' / ')}」之一。

只输出 JSON 数组,不要解释,不要围栏。每条输入都必须出现在输出里:
[{"id":"BV1xx","kind":"娱乐","domains":["美食","户外"],"tags":["露营","烤羊肉"]}]`;
```

`coerceTagOutput`:

```ts
export interface TagOutput {
  id: string;
  kind: string;
  domains: string[];
  tags: string[];
}

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 8)
    : [];

/** 收窄模型输出。**只收本批的 id** —— 模型编别的条目无效(和归类同款纪律) */
export function coerceTagOutput(raw: unknown, batchIds: ReadonlySet<string>): TagOutput[] {
  const list = parseJsonArray(raw) ?? [];
  const out: TagOutput[] = [];
  for (const r of list) {
    const o = r as { id?: unknown; kind?: unknown; domains?: unknown; tags?: unknown };
    if (typeof o?.id !== 'string' || !batchIds.has(o.id)) continue;

    const domains = strList(o.domains);
    const tags = strList(o.tags);
    // **一个标签都没给 → 整条丢弃,当没标**(C6 "不合法的整条丢弃")。
    //
    // 收下它的话会写 `ai_checked_at`,于是这条**再也不会被重标** ——
    // 增量只挑 `ai_checked_at IS NULL` 的。而它一个标签都没拿到,等于永久漏掉。
    // 丢掉才是对的:下一轮它还在增量池里,有机会重新被标上。
    if (domains.length === 0 && tags.length === 0) continue;

    out.push({
      id: o.id,
      // kind 越界 → 空串;落库时按「其它」处理。受控词表的定义(C3)
      kind: TAG_KINDS.includes(o.kind as never) ? (o.kind as string) : '',
      domains,
      tags,
    });
  }
  return out;
}
```

`applyTagOutput`(落库,0 token):

```ts
/**
 * 落库(§9F C5/C6):领域建根 → 词挂到**第一个**领域下 → 别名表记一笔 → 写 item_tags。
 *
 * 为什么词只挂第一个领域:一条视频可能同时属于"美食"和"户外",但**词**在树里
 * 只能有一个父(树不是图)。挂第一个是"模型自己排的序"—— 它在 domains 里把最
 * 主要的放前面。挂错了不要紧:跑完的集合判据(C9)会按数据把它挪对。
 */
export function applyTagOutput(db: Database.Database, o: TagOutput): { created: string[] } {
  // 快照"建之前有哪些节点" —— 差集就是本轮新建的词。质检(§9F C8)只对它们开口,
  // 所以这份名单必须有,而且不能猜
  const before = new Set(
    (db.prepare(`SELECT id FROM tags`).all() as { id: number }[]).map((r) => r.id),
  );

  const domainIds = o.domains.map((d) => ensureTag(db, d, null));
  const host = domainIds[0] ?? null;

  for (const name of o.tags) {
    // 领域名自己不重复挂一遍(模型偶尔把 domains 也写进 tags)
    if (o.domains.some((d) => normalizeTagName(d) === normalizeTagName(name))) continue;
    linkItemTag(db, o.id, ensureTag(db, name, host), 'ai');
  }
  for (const id of domainIds) linkItemTag(db, o.id, id, 'ai');
  markItemTagged(db, o.id, o.kind || '其它');

  return {
    created: (db.prepare(`SELECT id, name FROM tags`).all() as { id: number; name: string }[])
      .filter((r) => !before.has(r.id))
      .map((r) => r.name),
  };
}
```

`askOnce` 里把原来的 `coerceTag` + `setItemTagging` 换成 `coerceTagOutput` + `applyTagOutput`,
仍然只收本批的 id、仍然返回"标到了哪些 id"的集合。**批大小(16)、逐条覆盖断言(最多 2 轮补标)、
缩批、abort 判定一律照旧** —— 这一步换的是"怎么落库",不是"怎么跑批"。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && npx vitest run src/curator/tagger.test.ts`
Expected: PASS

- [ ] **Step 6: 改 `classifier.ts` 的 renderItem 与两个 prompt builder**

```ts
/** 把一条收藏渲染成模型读的文本。**不带 fav_time** —— 那是"你什么时候收藏的",与主题无关(§9.3) */
export function renderItem(
  i: ItemRow,
  maxIntro = 120,
  tagNames?: readonly string[],
  kind?: string | null,
): string {
  const lines = [`[${i.id}] ${i.title}`];
  if (i.intro) {
    const intro = i.intro.length > maxIntro ? `${i.intro.slice(0, maxIntro)}…` : i.intro;
    lines.push(`  简介:${intro}`);
  }
  if (i.upper_name) lines.push(`  UP:${i.upper_name}`);
  if (i.duration) lines.push(`  时长:${Math.round(i.duration / 60)} 分钟`);

  // §9F:标签和 kind 都是**补充信号**,原始标题/简介仍在场(C6 的"冲突时以原始数据为准")
  //
  // **kind 必须继续出现在这儿。** 它是 §9E 实测唯一被验证过有用的那个信号
  // (4b 把"Stable Diffusion"判成教学、"玄幻"判成娱乐,分对了)。只渲染标签的话,
  // `ai_kind` 就成了只写不读的死列 —— 占一列、占标注的输出 token、进不了 prompt、
  // 界面上也不显示。C7 特意论证它是"独立的正交轴",那就得让它继续有用。
  //
  // kind 为「其它」时**不占行** —— 它跟"没有 kind"是一个意思,写出来只是噪音
  // (§9E 的旧实现踩过这个:渲染出一行光秃秃的「AI标签:」)
  const tagPart = tagNames?.length ? tagNames.join('·') : '';
  const kindPart = kind && kind !== '其它' ? `[${kind}]` : '';
  if (tagPart || kindPart) {
    lines.push(`  标签:${tagPart}${tagPart && kindPart ? ' ' : ''}${kindPart}`);
  }
  return lines.join('\n');
}
```

两个 builder 的 opts 各加两个 map(**调用方一次算好** —— 一批几百条,别在渲染里逐条查):

```ts
  /** itemId → 标签显示名 */
  tagInfo: ReadonlyMap<string, { names: readonly string[]; kind: string | null }>;
```

渲染处改成:

```ts
opts.items.map((i) => {
  const t = opts.tagInfo.get(i.id);
  return renderItem(i, 120, t?.names, t?.kind);
})
```

`buildPass1Prompt` 的 `opts.sample` 同样处理。

- [ ] **Step 7: 改 `routes.ts` 的两处调用**

`run-pass-1` 与 `run-pass-2` 各加一行,并把它传进 prompt builder:

```ts
// §9F:标签和 kind 一次取齐 —— 一批几百条,别在 renderItem 里逐条查(那就是 N+1)
const tagInfo = tagInfoByItem(db);
```

**这个助手加到 `db/repo/tags.ts`**(Task 1 建的文件)—— 它不只这一处用:Task 7 的夹子画像、Task 9 的「浏览」页都要按 itemId 拿标签。

```ts
/**
 * itemId → { 标签显示名, 形态 }。**一次查完** —— 归类一批几百条,别在渲染里逐条查。
 *
 * 两样一起回:它们同源(都是 `items` 上的 AI 派生列)、同一批消费者
 * (renderItem / 详情栏),分两个函数就是两次全表扫。
 */
export function tagInfoByItem(
  db: Database.Database,
): Map<string, { names: string[]; kind: string | null }> {
  const out = new Map<string, { names: string[]; kind: string | null }>();
  const get = (id: string) => {
    const cur = out.get(id);
    if (cur) return cur;
    const fresh = { names: [] as string[], kind: null as string | null };
    out.set(id, fresh);
    return fresh;
  };

  const rows = db
    .prepare(
      `SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
        ORDER BY it.item_id, t.name`,
    )
    .all() as { item_id: string; name: string }[];
  for (const r of rows) get(r.item_id).names.push(r.name);

  const kinds = db
    .prepare(`SELECT id, ai_kind FROM items WHERE ai_kind IS NOT NULL`)
    .all() as { id: string; ai_kind: string }[];
  for (const r of kinds) get(r.id).kind = r.ai_kind;

  return out;
}
```

- [ ] **Step 8: 改 `classifier.test.ts` 里 renderItem 相关用例**

新签名是 `renderItem(i, maxIntro, tagNames?, kind?)`,断言要跟着改:

- 把 `item(..., { ai_tags: '…' })` 那种构造改成**直接传参**:`renderItem(i, 120, ['Stable Diffusion'], '教学')`
- 断言字符串从 `AI标签:` 改成 `标签:`
- **kind 的三条用例必须保留并改对**(原 `classifier.test.ts:379/385/407` 测的
  "有标签有 kind" / "只有 kind" / "只有标签" 三种排版)—— 它们是 §9E 踩过的坑,
  而且正是 C7"kind 不能断链"的守卫:
  - `(i, 120, [], '教学')` → `标签:[教学]`,**中间不能多一个空格**
    (旧实现渲染出过一行光秃秃的「AI标签:」)
  - `(i, 120, ['随手拍'], '其它')` → `标签:随手拍` ——「其它」不占位
  - `(i, 120, ['随手拍'], null)` → `标签:随手拍`
- 保留"没标签也不占行"那条(全传 `undefined`)

**另外补一条守卫**:标注必须写 `ai_checked_at`。加进 `tagger.test.ts`:

```ts
  it('标注写 ai_checked_at —— 增量靠它(漏了就是每次全库重标)', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ id: 'BV1', kind: '娱乐', domains: ['美食'], tags: ['露营'] }]),
    );
    await runTagging({ config, ctx, items: [item('BV1', 'a')], db });
    const row = db.prepare(`SELECT ai_kind, ai_checked_at FROM items WHERE id='BV1'`).get() as
      { ai_kind: string | null; ai_checked_at: number | null };
    expect(row.ai_kind).toBe('娱乐');
    expect(row.ai_checked_at).not.toBeNull();
    // 反过来说:水位线一落，增量池里就没有它了
    expect(listUntaggedItemIds(db)).toEqual([]);
  });
```

- [ ] **Step 9: 全量测试 + 提交**

Run: `cd server && npm test`
Expected: 全部通过

```bash
git add server/src/db/repo/tagging.ts server/src/db/repo/tagging.test.ts server/src/db/repo/tags.ts \
        server/src/curator/tagger.ts server/src/curator/tagger.test.ts \
        server/src/curator/classifier.ts server/src/curator/classifier.test.ts \
        server/src/curator/routes.ts server/src/curator/routes.test.ts
git commit -m "feat(tags): 标注产出树标签,归类看得到树标签(ai_tags 停用)"
```
```

---

### Task 3: 标签质检(第五个用途)

**Files:**
- Modify: `server/src/llm/config.ts`
- Modify: `web/src/types.ts` / `web/src/components/ModelManager.tsx`
- Create: `server/src/curator/tagcheck.ts` / `tagcheck.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `listTagTree` / `tagCounts` / `mergeTags` / `setTagParent` / `renameTag` / `addAlias` / `normalizeTagName`
- Produces:
  - `export type LlmPurpose = 'chat' | 'classify' | 'rules' | 'tag' | 'tagcheck'`
  - `export interface TagVerdict { name: string; action: 'keep' | 'drop' | 'merge' | 'move'; target?: string }`
  - `export function coerceVerdicts(raw: unknown, known: ReadonlySet<string>): TagVerdict[]`
  - `export function runTagCheck(opts: { config; tree; newNames: readonly string[]; db }): Promise<{ dropped: number; merged: number; moved: number }>`

- [ ] **Step 1: `llm/config.ts` 加用途**

```ts
export type LlmPurpose = 'chat' | 'classify' | 'rules' | 'tag' | 'tagcheck';
export const PURPOSES: readonly LlmPurpose[] = ['chat', 'classify', 'rules', 'tag', 'tagcheck'];
const PURPOSE_LABELS: Record<LlmPurpose, string> = {
  chat: '聊天',
  classify: '归类',
  rules: '规则建议',
  tag: '打标',
  // 质检只对新词开口,判的是"这个词在树里该站哪" —— 量小但要准,和打标的要求相反
  tagcheck: '标签质检',
};
```

- [ ] **Step 2: 前端两处跟着加**

`web/src/types.ts`:`export type LlmPurpose = 'chat' | 'classify' | 'rules' | 'tag' | 'tagcheck';`
`web/src/components/ModelManager.tsx`: `PURPOSE_LABELS` 加 `tagcheck: '标签质检'`;两处写死的文案「四个用途平级」改成「五个用途平级」;`:542` 那句「首条会自动指给四个用途」改成五个。

- [ ] **Step 3: 写失败测试 `server/src/curator/tagcheck.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { ensureTag, listTagTree, normalizeTagName, findTag } from '../db/repo/tags.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

const { coerceVerdicts, runTagCheck } = await import('./tagcheck.js');
const config = { id: 'flash', provider: 'deepseek', baseUrl: '', apiKey: 'k', model: 'deepseek-flash' };

beforeEach(() => vi.clearAllMocks());

describe('coerceVerdicts', () => {
  it('drop 原样留着(它不需要 target);merge/move 的目标必须存在,否则退回 keep', () => {
    const got = coerceVerdicts(
      [
        { name: 'AI', action: 'drop' },                              // 泛词:留着,别被降级
        { name: '鲁夫', action: 'merge', target: '路飞' },            // 目标合法 → 保留
        { name: '鲁夫', action: 'merge', target: '不存在的词' },       // 目标编的 → keep
        { name: 'x', action: '乱写' },                                // action 越界 → keep
      ],
      new Set(['路飞']),
    );
    expect(got).toEqual([
      { name: 'AI', action: 'drop' },
      { name: '鲁夫', action: 'merge', target: '路飞' },
      { name: '鲁夫', action: 'keep' },
      { name: 'x', action: 'keep' },
    ]);
  });

  it('目标按归一化比 —— 显示名是 NBA、模型吐 nba 也算命中', () => {
    const got = coerceVerdicts([{ name: '美职篮', action: 'merge', target: 'nba' }], new Set(['NBA']));
    expect(got).toEqual([{ name: '美职篮', action: 'merge', target: 'NBA' }]);
  });

  it('move 没有目标 → keep(别把"没听懂"当"该删")', () => {
    const got = coerceVerdicts([{ name: '露营', action: 'move' }], new Set(['户外']));
    expect(got).toEqual([{ name: '露营', action: 'keep' }]);
  });
});

describe('runTagCheck', () => {
  it('drop 的词从树里连根拔掉', async () => {
    const db = openDb(':memory:');
    ensureTag(db, 'AI', null);
    ensureTag(db, '美食', null);
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { name: 'AI', action: 'drop' },
        { name: '美食', action: 'keep' },
      ]),
    );
    const r = await runTagCheck({ config, tree: listTagTree(db), newNames: ['AI'], db });
    expect(r.dropped).toBe(1);
    expect(listTagTree(db).map((n) => n.name)).toEqual(['美食']);
  });

  it('merge 走的词把名字留给目标(别名表记住)', async () => {
    const db = openDb(':memory:');
    const keep = ensureTag(db, '路飞', null);
    const drop = ensureTag(db, '鲁夫', null);
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ name: '鲁夫', action: 'merge', target: '路飞' }]),
    );
    await runTagCheck({ config, tree: listTagTree(db), newNames: ['鲁夫'], db });
    expect(findTag(db, normalizeTagName('鲁夫'))).toBe(keep);
    expect(db.prepare(`SELECT id FROM tags WHERE id = ?`).get(drop)).toBeUndefined();
  });

  it('模型没回的词一律留着(不删 —— 漏了不等于该删)', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '露营', null);
    mocks.complete.mockResolvedValue(JSON.stringify([]));
    const r = await runTagCheck({ config, tree: listTagTree(db), newNames: ['露营'], db });
    expect(r.dropped).toBe(0);
    expect(listTagTree(db)).toHaveLength(1);
  });

  it('newNames 为空 → 一次 LLM 都不调(闸门在函数里)', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '美食', null);
    await runTagCheck({ config, tree: listTagTree(db), newNames: [], db });
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/tagcheck.test.ts`
Expected: FAIL —— `Failed to resolve import "./tagcheck.js"`

- [ ] **Step 5: 写 `server/src/curator/tagcheck.ts`**

```ts
/**
 * 标签质检(spec §9F C8)—— flash 在这一整条链路里**唯一**的出场点。
 *
 * 分界线:本地模型做生产,flash 只当质检员,而且**只对新的东西开口**。
 * 首轮 500-1500 个新词 ≈ 十几次调用;之后每轮只剩几十个 ≈ 一次。几轮之后趋近于零。
 *
 * 它回答三件事(§9F C8):① 这个词是不是太泛、根本不该进词库 ② 它是不是
 * 已经存在的东西的另一种写法 ③ 它该不该换个位置。
 *
 * **为什么泛词必须在这里挡**:集合判据(C9)对付不了泛词 —— 一个挂遍全库的词,
 * 在覆盖关系上"所有词都在它里面",判据会把它推到树顶。这是那套判据唯一的软肋,
 * 而这道闸就在这儿。
 */
import type Database from 'better-sqlite3';
import type { ModelConfig } from '../llm/provider.js';
import { complete } from '../llm/provider.js';
import { parseJsonArray } from './parse.js';
import type { ChatMessage } from '../llm/context.js';
import {
  listTagTree, mergeTags, normalizeTagName, setTagParent, deleteTag, type TagNode,
} from '../db/repo/tags.js';

export const CHECK_SYSTEM = `你是标签词库的质检员。用户给你一棵标签树和一批**新出现的词**,判断每个词该怎么办。

- **drop**:这个词太泛,没有区分力,不该存在于词库里。典型:"AI""视频""教程""分享""合集"。
  判断标准是:它能不能把一类内容和其他内容**分开**?分不开就是 drop。
- **merge**:它其实是已有某个词的另一种写法(译名差异、简写、同义词)。填 target 为已有的那个词。
- **move**:它该挂在另一个已有词下面。填 target 为父节点。
- **keep**:没问题,它是个有区分力的具体词。

**拿不准就 keep** —— 漏掉一个泛词只是让树脏一点,误删一个好词是丢掉信息。
只输出 JSON 数组:[{"name":"AI","action":"drop"},{"name":"鲁夫","action":"merge","target":"路飞"}]`;

export interface TagVerdict {
  name: string;
  action: 'keep' | 'drop' | 'merge' | 'move';
  target?: string;
}

/** 收窄。**target 必须是已有词** —— 模型编的目标一律丢掉,退回 keep */
export function coerceVerdicts(raw: unknown, known: ReadonlySet<string>): TagVerdict[] {
  const list = parseJsonArray(raw) ?? [];
  const out: TagVerdict[] = [];

  // 名字比较走**归一化** —— 树里存的是显示名("NBA"),模型可能吐 "nba"。
  // 用精确串比会把合法目标当成"编的"丢掉,然后静默退回 keep —— 而 keep 是"什么都不做",
  // 用户看不出任何异常,只会觉得"质检好像不太灵"
  const knownNorm = new Map([...known].map((n) => [normalizeTagName(n), n]));

  for (const r of list) {
    const o = r as { name?: unknown; action?: unknown; target?: unknown };
    if (typeof o?.name !== 'string' || !o.name.trim()) continue;

    const name = o.name.trim();
    const action =
      o.action === 'drop' || o.action === 'merge' || o.action === 'move' ? o.action : 'keep';
    const targetNorm = typeof o.target === 'string' ? normalizeTagName(o.target) : '';
    const target = targetNorm ? knownNorm.get(targetNorm) : undefined;

    // **只有 merge / move 需要目标。**
    //
    // 这里原来写成 `action !== 'keep' && !target` —— 而 `drop` 天然没有目标,
    // 于是条件恒真、**每个 drop 都被改写成 keep**,「剔泛词」那道闸门整轮失效。
    // §9F.6 明说"剔除裸泛词是这套判据**唯一**的软肋",那唯一的闸门却是关着的。
    if ((action === 'merge' || action === 'move') && !target) {
      out.push({ name, action: 'keep' });
      continue;
    }
    out.push({ name, action, ...(target ? { target } : {}) });
  }
  return out;
}

function renderTree(nodes: readonly TagNode[], depth = 0): string {
  return nodes
    .map((n) => `${'  '.repeat(depth)}- ${n.name}(${n.count} 条)\n${renderTree(n.children, depth + 1)}`)
    .join('');
}

export async function runTagCheck(opts: {
  config: ModelConfig;
  tree: readonly TagNode[];
  newNames: readonly string[];
  db: Database.Database;
}): Promise<{ dropped: number; merged: number; moved: number }> {
  const { db } = opts;
  // 闸门:**没有新词就一次 LLM 都不调** —— 所以放在每轮末尾是免费的
  if (opts.newNames.length === 0) return { dropped: 0, merged: 0, moved: 0 };

  const known = new Set<string>();
  const collect = (nodes: readonly TagNode[]) => {
    for (const n of nodes) { known.add(n.name); collect(n.children); }
  };
  collect(opts.tree);

  const messages: ChatMessage[] = [
    { role: 'system', content: CHECK_SYSTEM },
    {
      role: 'user',
      content:
        `## 现有标签树\n${renderTree(opts.tree) || '(空)'}\n\n` +
        `## 本轮新出现的词(${opts.newNames.length} 个)\n${opts.newNames.join('、')}\n\n` +
        `请逐个判定。`,
    },
  ];

  const verdicts = coerceVerdicts(
    // 批量判断:关思考模式(Task 0)。它要的是"照格式吐 JSON",不是"想清楚"
    await complete({ config: opts.config, messages, thinking: false }),
    known,
  );

  let dropped = 0, merged = 0, moved = 0;
  for (const v of verdicts) {
    const id = byName(db, v.name);
    if (id === null) continue;

    if (v.action === 'drop') {
      // **泛词从词库里删掉,不是"留原地"** —— 它没有任何区分力,留着只会被
      // 集合判据推到树顶(§9F.6 说的那个软肋)。这是整套系统里唯一的防线
      deleteTag(db, id);
      dropped++;
      continue;
    }
    if (v.action === 'merge' && v.target) {
      const targetId = byName(db, v.target);
      // 闸在 mergeTags 里(防环 + 深度):false = 这两个词不能并 —— 跳过,不是抛错
      if (targetId !== null && targetId !== id && mergeTags(db, id, targetId)) merged++;
      continue;
    }
    if (v.action === 'move' && v.target) {
      const parentId = byName(db, v.target);
      // 闸在 setTagParent 里(唯一收口):false = 这次挂父不合法 → 留原位
      if (parentId !== null && setTagParent(db, id, parentId)) moved++;
    }
  }
  return { dropped, merged, moved };
}

/** 按名字(含别名)找节点。质检的输出用名字而不是 id —— 模型认名字 */
function byName(db: Database.Database, name: string): number | null {
  const row = db
    .prepare(
      `SELECT id FROM tags WHERE norm = ?
        UNION ALL
       SELECT tag_id AS id FROM tag_aliases WHERE name = ?
        LIMIT 1`,
    )
    .get(normalizeTagName(name), normalizeTagName(name)) as { id: number } | undefined;
  return row ? row.id : null;
}
```

> 质检**不该改词的名字** —— 改名是人工操作,在「标签」页。所以 `renameTag` 不在 import 里。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd server && npx vitest run src/curator/tagcheck.test.ts`
Expected: PASS(5 条)

- [ ] **Step 7: 提交**

```bash
git add server/src/llm/config.ts server/src/curator/tagcheck.ts server/src/curator/tagcheck.test.ts web/src/types.ts web/src/components/ModelManager.tsx
git commit -m "feat(tags): 标签质检(第五个用途 tagcheck)—— 剔泛词/合并/挪位"
```

---

### Task 4: 集合判据(合并 / 挂父 / 树变化清单)

**Files:**
- Create: `server/src/curator/tagtree.ts` / `tagtree.test.ts`
- Modify: `server/src/db/repo/tags.ts`(补 `listTagsWithParent` / `tagSets`,Step 4)

**Interfaces:**
- Consumes: Task 1 的 `listTagTree` / `itemTagIds` / `subtreeSets` / `mergeTags` / `setTagParent`
- Produces:
  - `export interface Coverage { a: number; b: number; ratio: number }`
  - `export function coverageMap(sets: ReadonlyMap<number, ReadonlySet<string>>): Map<string, number>` —— `"a,b" → |A∩B|/|A|`,一次算完;零交集的不存
  - `export interface TreeChange { kind: 'merge' | 'reparent'; from: string; to: string; detail: string }`
  - `export function reconcile(db, opts?: { minSample?: number; cover?: number }): TreeChange[]`

- [ ] **Step 1: 写失败测试 `server/src/curator/tagtree.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
import { ensureTag, linkItemTag, listTagTree } from '../db/repo/tags.js';
import { reconcile, coverageMap } from './tagtree.js';

/**
 * 建 n 条视频,每条挂 tagIds 里的全部标签。
 *
 * `from` 是编号起点 —— 用不同的起点把几批视频**分开**,这样"重叠多少"
 * 完全由测试说了算。
 */
function seed(db: ReturnType<typeof openDb>, n: number, tagIds: number[], from = 0) {
  for (let i = from; i < from + n; i++) {
    const id = `BV${i}`;
    upsertItem(db, { id, type: 2, title: id });
    for (const t of tagIds) linkItemTag(db, id, t, 'ai');
  }
}

describe('coverageMap', () => {
  it('一次算完两个方向', () => {
    const sets = new Map<number, ReadonlySet<string>>([
      [1, new Set(['a', 'b', 'c', 'd'])],
      [2, new Set(['a', 'b'])],
    ]);
    const m = coverageMap(sets);
    expect(m.get('1,2')).toBe(0.5); // |1∩2| / |1| = 2/4
    expect(m.get('2,1')).toBe(1);   // |2∩1| / |2| = 2/2
  });

  it('零交集的对不存 —— 缺席即 0', () => {
    const sets = new Map<number, ReadonlySet<string>>([
      [1, new Set(['a'])],
      [2, new Set(['b'])],
    ]);
    expect(coverageMap(sets).size).toBe(0);
  });
});

describe('reconcile', () => {
  it('A 挂的几乎全在 B 里 → A 挂到 B 下', () => {
    const db = openDb(':memory:');
    const food = ensureTag(db, '美食', null);
    const roast = ensureTag(db, '烤羊肉', null);
    // 美食 40 条(其中 18 条也挂烤羊肉),烤羊肉 18 条
    // → cover(烤羊肉→美食)=1.0,cover(美食→烤羊肉)=18/40=0.45
    //   单向高 → 挂父,不是合并(双向都高才是合并)
    seed(db, 40, [food]);
    seed(db, 18, [food, roast], 40);
    const changes = reconcile(db);
    expect(changes.some((c) => c.kind === 'reparent')).toBe(true);
    expect(changes.some((c) => c.kind === 'merge')).toBe(false);
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(roast)).toEqual({ parent_id: food });
  });

  it('双向都 ≥90% → 合并,保留挂得多的那个', () => {
    const db = openDb(':memory:');
    const a = ensureTag(db, '路飞', null);
    const b = ensureTag(db, '鲁夫', null);
    seed(db, 10, [a, b]);            // 10 条同时挂两个
    seed(db, 1, [a], 100);           // 只有 a 多一条 → |a|=11 |b|=10
    // cover(a→b)=10/11=0.909 ≥0.9,cover(b→a)=10/10=1.0 → 合并
    const changes = reconcile(db);
    expect(changes.some((c) => c.kind === 'merge')).toBe(true);
    expect(db.prepare(`SELECT name FROM tags`).all()).toEqual([{ name: '路飞' }]); // 挂得多的留下
  });

  it('各挂各的 → 平级,什么都不做(露营 vs 美食)', () => {
    const db = openDb(':memory:');
    const food = ensureTag(db, '美食', null);
    const camp = ensureTag(db, '露营', null);
    seed(db, 30, [food]);
    seed(db, 5, [camp], 100);
    seed(db, 2, [food, camp], 200);  // 只有 2 条同时挂两个
    // cover(露营→美食)=2/7=0.29,cover(美食→露营)=2/32=0.06 → 两边都低
    expect(reconcile(db)).toEqual([]);
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(camp)).toEqual({ parent_id: null });
  });

  it('样本 <5 条不判(统计下限)', () => {
    const db = openDb(':memory:');
    const a = ensureTag(db, '小词', null);
    const b = ensureTag(db, '大词', null);
    seed(db, 50, [b]);
    seed(db, 3, [a, b], 100);        // 覆盖率 100% 但只有 3 条
    expect(reconcile(db)).toEqual([]);
  });

  it('已经是父子的一对不合并 —— 否则会把树压塌', () => {
    const db = openDb(':memory:');
    const parent = ensureTag(db, '体育', null);
    const child = ensureTag(db, '篮球', parent);  // 树里**已经**是父子
    seed(db, 10, [parent, child]);                // 篮球的视频全都挂着体育
    // 双向都 100%,但树里已经表达过这个包含关系了 —— 合并就等于把篮球删掉
    expect(reconcile(db)).toEqual([]);
    expect(listTagTree(db)[0]!.children.map((n) => n.name)).toEqual(['篮球']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/tagtree.test.ts`
Expected: FAIL —— `Failed to resolve import "./tagtree.js"`

- [ ] **Step 3: 写 `server/src/curator/tagtree.ts`**

```ts
/**
 * 词与词的关系 —— **可算的判据,不是拍的阈值**(spec §9F C9)。
 *
 * 一个词在你收藏里的真实含义,写在"它挂了哪些视频"里。所以判据是集合关系:
 *
 *   A 挂的几乎全在 B 里(≥90%) → A 是 B 的子
 *   A 和 B 几乎重合(双向都 ≥90%) → 同一个东西 → 合并
 *   各挂各的 → 平级
 *
 * **为什么不是阈值晋升**(早期版本想用"子词数 ≥3 且覆盖 ≥20 条"):那两个数
 * 没有任何依据,是拍出来的;更糟的是它会和质检打架 —— 质检判"露营是根",计数判
 * "它只有 3 条视频、降级",一个建一个拆,结构来回晃。降级还是破坏性的。
 *
 * 唯一剩下的两个数都是**可解释判据的临界值**,不是魔法数:覆盖面 0.9
 * (调高 → 层级更浅、更多平级;调低 → 更多嵌套)和统计下限 5 条
 * (少于它,重合率没有统计意义 —— "两个词各挂 1 条、恰好是同一条"说明不了任何事)。
 */
import type Database from 'better-sqlite3';
import {
  listTagsWithParent, mergeTags, setTagParent, tagSets, type TagRow,
} from '../db/repo/tags.js';

export interface TreeChange {
  kind: 'merge' | 'reparent';
  from: string;
  to: string;
  detail: string;
}

/** `${a},${b}` → |A∩B| / |A|。缺席即 0 */
type RatioMap = Map<string, number>;
const k = (a: number, b: number) => `${a},${b}`;

/**
 * 一次算完全部有向覆盖率。
 *
 * **必须一次算完。** 在循环里为每一对现算,等于把 O(n²) 的活做成 O(n⁴)
 * —— 初稿就这么写的(还在循环里临时构造一个 2 项 Map 再调一次自己)。
 *
 * **只存非 0 的**:两个词的视频集毫无交集时覆盖率必然是 0,存它只是占内存。
 * 查的时候 `?? 0`。
 */
export function coverageMap(sets: ReadonlyMap<number, ReadonlySet<string>>): RatioMap {
  const ids = [...sets.keys()].sort((x, y) => x - y);
  const out: RatioMap = new Map();
  for (const a of ids) {
    const A = sets.get(a)!;
    if (A.size === 0) continue;
    for (const b of ids) {
      if (a === b) continue;
      const B = sets.get(b)!;
      if (B.size === 0) continue;
      let hit = 0;
      for (const x of A) if (B.has(x)) hit++;
      if (hit > 0) out.set(k(a, b), hit / A.size);
    }
  }
  return out;
}

/** 无序对,每对只出一次 —— 双向判断在循环里自己做(查 `k(a,b)` 和 `k(b,a)`) */
function pairs(sets: ReadonlyMap<number, ReadonlySet<string>>): [number, number][] {
  const ids = [...sets.keys()].sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) out.push([ids[i]!, ids[j]!]);
  return out;
}

/** node 是不是 anc 的后代(anc 在不在它的祖先链上)*/
function isAncestor(
  parentOf: ReadonlyMap<number, number | null>,
  node: number,
  anc: number,
): boolean {
  let cur: number | null | undefined = node;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    if (cur === anc) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/**
 * 按数据核对整棵树,返回**变化清单**并落到结构上。
 *
 * 顺序不能反:**先合并,再挂父**。反过来的话,判据看到"90% 的漫剧视频也挂了 AI"
 * 就会把漫剧挂到 AI 底下 —— 它自己把证据吃掉了,然后 AI 就永远洗不白了。
 *
 * 每轮跑完调一次(§9F C10 的"自动整理"),不设人工审批闸。
 */
export function reconcile(
  db: Database.Database,
  opts: { minSample?: number; cover?: number } = {},
): TreeChange[] {
  const minSample = opts.minSample ?? 5;
  const cover = opts.cover ?? 0.9;

  const changes: TreeChange[] = [];
  const take = () => {
    const rows: TagRow[] = listTagsWithParent(db);
    const sets = tagSets(db);
    return {
      sets,
      cov: coverageMap(sets),
      nameOf: new Map(rows.map((r) => [r.id, r.name])),
      parentOf: new Map(rows.map((r) => [r.id, r.parentId])),
    };
  };

  let { sets, cov, nameOf, parentOf } = take();

  // ── ① 合并:双向都 ≥cover 且都够样本 ──────────────────
  for (const [a, b] of pairs(sets)) {
    const sizeA = sets.get(a)!.size;
    const sizeB = sets.get(b)!.size;
    if (sizeA < minSample || sizeB < minSample) continue;

    // **已经是父子关系的一对不合并。** 树里已经表达过这个包含关系了 ——
    // 再合并一次就是把树压塌。(父子挂的视频高度重合是完全正常的:
    // 篮球的视频本来就都挂着体育。测试夹具也特别容易造出"父和子一模一样"。)
    if (isAncestor(parentOf, b, a) || isAncestor(parentOf, a, b)) continue;

    const fwd = cov.get(k(a, b)) ?? 0;
    const back = cov.get(k(b, a)) ?? 0;
    if (fwd < cover || back < cover) continue;

    // 保留挂得多的那个(信息更全),把另一个并进来
    const [keep, drop] = sizeA >= sizeB ? [a, b] : [b, a];
    if (!mergeTags(db, drop, keep)) continue; // 防环 + 深度闸(mergeTags 内置)
    changes.push({
      kind: 'merge',
      from: nameOf.get(drop) ?? String(drop),
      to: nameOf.get(keep) ?? String(keep),
      detail: `挂的是同一批视频(${Math.round(Math.max(fwd, back) * 100)}% 重合)`,
    });
  }

  // **合并之后必须重取快照。** 覆盖数据、父边、名字全变了。
  // 不重取的话第二段拿着合并前的集合判"该挂哪",而上面刚合并掉的两个词
  // 还在集合里 —— 计划初稿宣称的"先合并再挂父"就成了一句做不到的话。
  if (changes.length > 0) ({ sets, cov, nameOf, parentOf } = take());

  // ── ② 挂父:单向外包 ≥cover,且样本够 ────────────────
  for (const [a, b] of pairs(sets)) {
    // 只动**根**:已经有父的那是质检给的判断,数据只纠正"没有父"的。
    // 两个都得是根 —— 一个已经有父的节点不该被数据再挪一次
    if (parentOf.get(a) !== null || parentOf.get(b) !== null) continue;
    if (sets.get(a)!.size < minSample || sets.get(b)!.size < minSample) continue;

    // **方向要两边都看**:`pairs` 是无序对,a 可能是子也可能是父。
    // 只看 `k(a,b)` 的话,谁先建谁就永远是"父",挂父整天不触发
    const fwd = cov.get(k(a, b)) ?? 0;
    const back = cov.get(k(b, a)) ?? 0;
    const child = fwd >= cover ? a : back >= cover ? b : null;
    if (child === null) continue;
    const parent = child === a ? b : a;
    const ratio = child === a ? fwd : back;

    // 闸在 setTagParent 里(防环 + 深度):false = 这次不合法 → 留原位
    if (!setTagParent(db, child, parent)) continue;
    parentOf.set(child, parent);
    changes.push({
      kind: 'reparent',
      from: nameOf.get(child) ?? String(child),
      to: nameOf.get(parent) ?? String(parent),
      detail: `${Math.round(ratio * 100)}% 的视频也挂着「${nameOf.get(parent) ?? parent}」`,
    });
  }

  return changes;
}
```

- [ ] **Step 4: `db/repo/tags.ts` 补两个导出**(Task 1 没写,这里按需加)

```ts
/** 只要 id / name / parent_id,不要 count 和 children —— 判据用它做轻量遍历 */
export function listTagsWithParent(db: Database.Database): TagRow[] {
  return (db.prepare(`SELECT id, name, parent_id FROM tags`).all() as
    { id: number; name: string; parent_id: number | null }[])
    .map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
}

/**
 * tagId → 挂它的**视频 id 集合**。集合判据的原料。
 *
 * 用 Set<string> 而不是 bitset:3250 条 × 几千个词的规模下,内存和速度都够,
 * 可读性值这个差价。真到几万条再说。
 * ponytail: 全量集合,几万条视频时再考虑 bitset 或 minhash。
 */
export function tagSets(db: Database.Database): Map<number, Set<string>> {
  const rows = db.prepare(`SELECT tag_id, item_id FROM item_tags`).all() as
    { tag_id: number; item_id: string }[];
  const out = new Map<number, Set<string>>();
  for (const r of rows) {
    const s = out.get(r.tag_id);
    if (s) s.add(r.item_id);
    else out.set(r.tag_id, new Set([r.item_id]));
  }
  return out;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && npx vitest run src/curator/tagtree.test.ts`
Expected: PASS(7 条)

- [ ] **Step 6: 提交**

```bash
git add server/src/curator/tagtree.ts server/src/curator/tagtree.test.ts server/src/db/repo/tags.ts
git commit -m "feat(tags): 集合判据 —— 覆盖/合并/挂父,替掉拍的阈值"
```

---

### Task 5: 标签路由(树 / 手动操作 / 每轮串起来)

**Files:**
- Modify: `server/src/curator/tagRoutes.ts` / `tagRoutes.test.ts`

**Interfaces:**
- Consumes: Task 1–4 的全部
- Produces(前端依赖的 HTTP 契约):
  - `GET /api/tags/tree` → `{ tree: TagNode[]; total: number }`
  - `POST /api/tags/merge` `{fromId, toId}` → `{ok:true}`
  - `PATCH /api/tags/:id` `{name?, parentId?}` → `{ok:true}`
  - `DELETE /api/tags/:id` → `{ok:true}`
  - `POST /api/tags/run?scope=missing|all` —— 跑完自动接质检 + `reconcile`,`done` 帧加 `changes` 与 `newWords`
  - `GET /api/tags/changes` → 最近一轮的变化清单(存在 settings 键 `tags.lastChanges`)

- [ ] **Step 1: 先修既有断言,再写新测试**

`tagRoutes.test.ts` **有两处既有断言会红** —— 它们读的是被停用的 `ai_tags` 列:

- `:82-83` —— `JSON.parse(row.ai_tags).kind === '娱乐'`
- `:123` —— `COUNT(*) WHERE ai_tags IS NOT NULL` 断言 `> 0`

改成读新表 / 新列:`items.ai_kind` 与 `item_tags` 的计数(`SELECT COUNT(*) FROM item_tags`)。

然后追加下面这些新用例:

```ts
import { itemTagIds, ensureTag, linkItemTag, listTagTree } from '../db/repo/tags.js';

describe('标签树路由', () => {
  it('GET /api/tags/tree 回整棵树 + 总数', async () => {
    const { app, db } = makeApp();
    const food = ensureTag(db, '美食', null);
    ensureTag(db, '烤羊肉', food);
    const r = await app.inject({ method: 'GET', url: '/api/tags/tree' });
    const body = r.json();
    expect(body.total).toBe(2);
    expect(body.tree[0].name).toBe('美食');
    expect(body.tree[0].children[0].name).toBe('烤羊肉');
  });

  it('POST /api/tags/merge 把 from 并进 to', async () => {
    const { app, db } = makeApp();
    const a = ensureTag(db, '路飞', null);
    const b = ensureTag(db, '鲁夫', null);
    const r = await app.inject({ method: 'POST', url: '/api/tags/merge', payload: { fromId: b, toId: a } });
    expect(r.statusCode).toBe(200);
    expect(listTagTree(db).map((n) => n.name)).toEqual(['路飞']);
  });

  it('merge 的 fromId === toId → 400', async () => {
    const { app, db } = makeApp();
    const a = ensureTag(db, 'x', null);
    const r = await app.inject({ method: 'POST', url: '/api/tags/merge', payload: { fromId: a, toId: a } });
    expect(r.statusCode).toBe(400);
  });

  it('PATCH 改名 + 换父;DELETE 删词', async () => {
    const { app, db } = makeApp();
    const sport = ensureTag(db, '体育', null);
    const camp = ensureTag(db, '露营', null);
    expect((await app.inject({ method: 'PATCH', url: `/api/tags/${camp}`, payload: { name: '野外露营', parentId: sport } })).statusCode).toBe(200);
    expect(listTagTree(db)[0]!.children[0]!.name).toBe('野外露营');
    expect((await app.inject({ method: 'DELETE', url: `/api/tags/${sport}` })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/tagRoutes.test.ts`
Expected: FAIL —— 404(路由不存在)

- [ ] **Step 3: 在 `tagRoutes.ts` 里加路由**

沿用文件既有风格(`registerTagRoutes(app, deps)` 里继续加):

```ts
  // ── 词库树(§9F)────────────────────────────────────
  app.get('/api/tags/tree', async () => {
    const tree = listTagTree(db);
    const count = (nodes: TagNode[]): number =>
      nodes.reduce((n, x) => n + 1 + count(x.children), 0);
    return { tree, total: count(tree) };
  });

  /**
   * 手动合并。**要校验 fromId !== toId** —— 自己并自己没有意义,而且会让
   * mergeTags 里那条 DELETE 把节点删掉。
   */
  app.post('/api/tags/merge', async (req, reply) => {
    const { fromId, toId } = (req.body ?? {}) as { fromId?: number; toId?: number };
    if (typeof fromId !== 'number' || typeof toId !== 'number') {
      return reply.code(400).send({ ok: false, reason: '要给出 fromId 和 toId' });
    }
    if (fromId === toId) return reply.code(400).send({ ok: false, reason: '不能并到自己身上' });
    if (!tagsExist(db, [fromId, toId])) {
      return reply.code(404).send({ ok: false, reason: '词库里没有这个标签' });
    }
    // 闸在 mergeTags 里(防环 + 超深)—— false 是"这两个词不能并",不是故障
    if (!mergeTags(db, fromId, toId)) {
      return reply.code(400).send({ ok: false, reason: '这两个词不能合并(会成环或超出 4 层)' });
    }
    log.event({ level: 'info', category: 'llm', message: `标签合并:${fromId} → ${toId}` });
    return { ok: true };
  });

  /** 改名 / 换父。两个都可选,给哪个改哪个 */
  app.patch('/api/tags/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { name?: string; parentId?: number | null };
    if (!tagsExist(db, [id])) return reply.code(404).send({ ok: false, reason: '词库里没有这个标签' });
    if (body.name !== undefined) {
      if (!body.name.trim()) return reply.code(400).send({ ok: false, reason: '名字不能为空' });
      renameTag(db, id, body.name);
    }
    if (body.parentId !== undefined) {
      if (body.parentId !== null && !tagsExist(db, [body.parentId])) {
        return reply.code(400).send({ ok: false, reason: '父节点不存在' });
      }
      // 闸在 setTagParent 里(自己挂自己 / 挂到自己的后代 / 超 4 层):
      // false 就是"这次不合法",不是故障
      if (!setTagParent(db, id, body.parentId)) {
        return reply.code(400).send({ ok: false, reason: '不能挂到这个位置(会成环或超出 4 层)' });
      }
    }
    return { ok: true };
  });

  app.delete('/api/tags/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!tagsExist(db, [id])) return reply.code(404).send({ ok: false, reason: '词库里没有这个标签' });
    deleteTag(db, id);
    return { ok: true };
  });

  app.get('/api/tags/changes', async () => {
    const raw = getSetting(db, CHANGES_KEY);
    return { changes: raw ? (JSON.parse(raw) as TreeChange[]) : [] };
  });
```

助手与常量放文件顶部:

```ts
/** 最近一轮「树的变化」清单存这个键 —— 刷新页面还在(§9F C10 要"看得见") */
const CHANGES_KEY = 'tags.lastChanges';

/** 这些 id 是不是全都在词库里 —— 手动操作都要先过这一句,否则 404 变成静默无操作 */
const tagsExist = (db: Database.Database, ids: number[]): boolean => {
  const uniq = [...new Set(ids)];
  const n = (db
    .prepare(`SELECT COUNT(*) n FROM tags WHERE id IN (${uniq.map(() => '?').join(',')})`)
    .get(...uniq) as { n: number }).n;
  return n === uniq.length;
};
```

配套 import 追加到 `tagRoutes.ts` 顶部:

```ts
import {
  listTagTree, mergeTags, setTagParent, renameTag, deleteTag, type TagNode,
} from '../db/repo/tags.js';
import { runTagCheck } from './tagcheck.js';
import { reconcile, type TreeChange } from './tagtree.js';
import { getSetting, setSetting } from '../db/repo/state.js';
```

- [ ] **Step 4: 让 `runTagging` 把新词报出来**

Task 2 已经把 `applyTagOutput` 写成返回 `{created}` 了。这里只做两件事:

`TagBatchProgress` 加一个字段:

```ts
export interface TagBatchProgress {
  done: number;
  total: number;
  tagged: number;
  failedBatches: { firstItemId: string; size: number; reason: string }[];
  /** 本轮新建的词 —— 质检(C8)只对它们开口 */
  newWords: string[];
}
```

`runTagging` 的返回值从 `{tagged, failedBatches}` 改成:

```ts
Promise<{ tagged: number; failedBatches: {…}[]; newWords: string[] }>
```

内部维护 `const newWords = new Set<string>()`,`askOnce` 里 `for (const n of applied.created) newWords.add(n)`,返回值带上 `newWords: [...newWords]`。

**`onBatch` 的实参也要跟着加** —— 它是逐批回调,漏了这个字段 TS 直接报错:

```ts
          opts.onBatch?.({ done, total, tagged, failedBatches, newWords: [...newWords] });
```

路由那侧不用改:`tagRoutes.ts` 的 progress 帧只取 `b.done/b.total/b.tagged`,多出来的字段它不看。

- [ ] **Step 5: `run` 路由末尾接上质检 + 判据**

`runTagging` 返回后、写 `done` 帧前插入:

```ts
      // ── 跑完自动整理(§9F C8 + C9 + C10)────────────────
      // 顺序不能反:先质检(定新词的归宿、剔泛词),再让数据说话(合并/挂父)。
      // 反过来判据会把证据吃掉 —— 详见 tagtree.ts 开头那段。

      /**
       * **质检用的是「标签质检」那个用途的模型,不是打标那个。**
       *
       * 两个要求是相反的:打标要便宜、能丢给本地 4b 跑全库;质检判的是**词性**
       * (量小,十几到几十个词),要准。共用一个槽必然二选一都不对。
       * 所以第五个用途**必须真的被读到** —— 漏了这一行的话它在界面上是个
       * 配置了却永远不生效的下拉,而质检会跟着打标一起跑在本地 4b 上。
       */
      const checker = readLlmSettings(db, 'tagcheck');
      let check = { dropped: 0, merged: 0, moved: 0 };
      if (!checker) {
        log.event({
          level: 'info', category: 'llm',
          message: '没配「标签质检」模型 —— 跳过质检(泛词闸门这轮没跑)',
        });
      } else {
        try {
          check = await runTagCheck({
            config: checker.config,
            tree: listTagTree(db),
            newNames: r.newWords,
            db,
          });
        } catch (e) {
          // 质检失败**不该**把已经标好的东西废掉 —— 下一轮还会再判一次
          log.event({
            level: 'warn', category: 'llm', code: 'TAGCHECK_FAILED',
            message: (e as Error)?.message ?? String(e),
          });
        }
      }

      // 「树的变化」= 质检做的 + 判据做的。清单要**看得见**(C10),
      // 但不设审批闸 —— 用户只要求"看得见它在长什么"
      const changes: TreeChange[] = [];
      if (check.merged > 0 || check.moved > 0 || check.dropped > 0) {
        changes.push({
          kind: 'merge',
          from: '（质检）',
          to: '',
          detail: `合并 ${check.merged} 组 · 挪位 ${check.moved} 个 · 剔除泛词 ${check.dropped} 个`,
        });
      }
      // **判据单独 try** —— 它和质检一样是"锦上添花",不该把已经跑通的标注
      // 连 done 帧一起带崩(质检那步是包着的,这里不包就是两套待遇)
      try {
        changes.push(...reconcile(db));
      } catch (e) {
        log.event({
          level: 'warn', category: 'llm', code: 'TREE_RECONCILE_FAILED',
          message: (e as Error)?.message ?? String(e),
        });
      }
      setSetting(db, CHANGES_KEY, JSON.stringify(changes));
```

`done` 帧载荷改成(前端 Task 8 的 `TagRunResult` 按这个来):

```ts
reply.raw.write(`event: done\ndata: ${JSON.stringify({
  tagged: r.tagged,
  failedBatches: r.failedBatches,
  check,
  changes,
  // 只报**个数**不报名单:界面上要的是"这轮长了多少新词",名单没人看,
  // 而它可能上千条 —— 塞进 SSE 帧是白占带宽
  newWordCount: r.newWords.length,
})}\n\n`);
```

- [ ] **Step 6: 跑测试 + 全量 + 提交**

Run: `cd server && npx vitest run src/curator/tagRoutes.test.ts && npm test`
Expected: PASS

```bash
git add server/src/curator/tagRoutes.ts server/src/curator/tagRoutes.test.ts server/src/curator/tagger.ts
git commit -m "feat(tags): 词库路由 + 每轮自动质检与整理"
```

---

### Task 6: 规则第四字段 `tag`(子树匹配)

**Files:**
- Modify: `server/src/db/repo/rules.ts`
- Modify: `server/src/curator/rules.ts` / `rules.test.ts`(`matchItem` 加 tag 字段 + **`renderConditions` 印名字不印 id**)
- Modify: `server/src/curator/ruleRoutes.ts` / `ruleRoutes.test.ts`(字段白名单 + 试跑传 ctx;另外 `rulesWithHits` 也要传)
- Modify: `server/src/curator/routes.ts`(run-pass-2 的 matchAll 传子树)
- Modify: `server/src/curator/suggestions.ts`(它自己算"规则覆盖了哪些条目",算错会把归好的又建议一遍)
- Modify: `server/src/curator/chat.ts`(`renderConditions` 的调用点,要多传一个名字表)
- **Modify**: `web/src/types.ts`(`RuleField` 加 `'tag'`)
- **Modify**: `web/src/components/RulesPanel.tsx`(字段下拉加一项 + `FIELD_LABEL` 加一行)—— **漏了它 tag 规则在界面上就建不出来**,File Structure 表里原先也没有这个文件

**Interfaces:**
- Produces:
  - `export type RuleField = 'title' | 'intro' | 'upper' | 'tag'`
  - `export interface RuleItem { id; title; intro?; upperName?; tagIds?: readonly number[] }`
  - `export interface RuleContext { subtree?: ReadonlyMap<number, ReadonlySet<number>> }`
  - `export function matchItem(item, rules, ctx?: RuleContext): RuleHit[]`
  - `export function matchAll(items, rules, ctx?: RuleContext): Map<string, RuleHit[]>`

- [ ] **Step 1: 写失败测试**(追加到 `server/src/curator/rules.test.ts`)

```ts
describe('tag 字段(子树匹配)', () => {
  const ctx = { subtree: new Map([[1, new Set([1, 2, 3])], [2, new Set([2])]]) };
  const rule = (any: string[]): FolderRule => ({
    folderId: 7, conditions: [{ field: 'tag', any }], origin: 'user', updatedAt: 0,
  });

  it('条件选父 → 命中它的所有后代', () => {
    const item = { id: 'BV1', title: 'x', tagIds: [3] };   // 3 是 1 的后代
    expect(matchItem(item, [rule(['1'])], ctx)).toHaveLength(1);
  });

  it('条件选子 → 不命中它的父', () => {
    const item = { id: 'BV1', title: 'x', tagIds: [1] };
    expect(matchItem(item, [rule(['2'])], ctx)).toEqual([]);
  });

  it('没有标签的条目不会误命中空条件', () => {
    expect(matchItem({ id: 'BV1', title: 'x' }, [rule(['1'])], ctx)).toEqual([]);
  });

  it('缺 subtree ctx 时 tag 条件一律不命中(不是"命中一切")', () => {
    expect(matchItem({ id: 'BV1', title: 'x', tagIds: [1] }, [rule(['1'])])).toEqual([]);
  });

  it('命中的 token 报的是条件里那个词,不是条目挂的那个', () => {
    const item = { id: 'BV1', title: 'x', tagIds: [3] };
    expect(matchItem(item, [rule(['1'])], ctx)[0]!.tokens[0]!.token).toBe('1');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/rules.test.ts`
Expected: FAIL —— tag 条件全部不命中(当前实现只会查 title/intro/upper)

- [ ] **Step 3: 改 `db/repo/rules.ts` 与 `curator/rules.ts`**

`rules.ts`(repo):`export type RuleField = 'title' | 'intro' | 'upper' | 'tag';`

`curator/rules.ts`:

```ts
export interface RuleItem {
  id: string;
  title: string;
  intro?: string | null;
  upperName?: string | null;
  /** 条目挂的标签 id。规则 field='tag' 时用它(C11) */
  tagIds?: readonly number[];
}

export interface RuleContext {
  /**
   * tagId → 它的子树(含自己)。**必传才能用 tag 条件** ——
   * 缺了就当没有标签,而不是"命中一切"。
   */
  subtree?: ReadonlyMap<number, ReadonlySet<number>>;
}

const FIELD_LABEL: Record<RuleField, string> = {
  title: '标题', intro: '简介', upper: 'UP 名', tag: '标签',
};

export function matchItem(
  item: RuleItem,
  rules: readonly FolderRule[],
  ctx: RuleContext = {},
): RuleHit[] {
  const text: Record<'title' | 'intro' | 'upper', string> = {
    title: (item.title ?? '').toLowerCase(),
    intro: (item.intro ?? '').toLowerCase(),
    upper: (item.upperName ?? '').toLowerCase(),
  };

  const hits: RuleHit[] = [];

  for (const rule of rules) {
    const tokens: RuleHitToken[] = [];
    for (const cond of rule.conditions) {
      if (cond.field === 'tag') {
        // 选中任何一个标签 = 匹配它**整棵子树**(§9F C11):选「体育」命中
        // 所有体育下的条目,选「NBA」只命 NBA 那条线。条件里存的是 tag id 的
        // 字符串形式(存名字的话,改一次词名就悄悄改掉了规则语义)。
        const ids = item.tagIds ?? [];
        const sub = ctx.subtree;
        if (!sub || ids.length === 0) continue;
        for (const kw of cond.any) {
          if (!kw) continue;
          const root = Number(kw);
          if (!Number.isInteger(root)) continue;
          const want = sub.get(root);
          if (!want) continue;                       // 词库里没有这个词 → 不命中(不是命中一切)
          if (ids.some((t) => want.has(t))) tokens.push({ field: 'tag', token: kw });
        }
        continue;
      }
      const hay = text[cond.field];
      if (!hay) continue;
      for (const kw of cond.any) {
        if (!kw) continue;
        if (hay.includes(kw.toLowerCase())) tokens.push({ field: cond.field, token: kw });
      }
    }
    if (tokens.length > 0) hits.push({ folderId: rule.folderId, tokens });
  }

  return hits;
}
```

`matchAll` 加第三个参数 `ctx` 并透传。

**还有一处必须一起改:`renderConditions` 会印出 tag **id**。**

`curator/rules.ts:86-92` 的实现是"FIELD_LABEL + 原样打印关键词",而按落地细节 3,
tag 条件里存的是 id。于是模型会读到 **「标签含 42、57」** —— 这正是 C15 所说的
"依据就是标签和规则"里的那一半,变成一串数字就全废了。

改法:多收一个名字表,渲染前把 id 翻成词名(翻不到就跳过那一条,别印数字)。

```ts
export function renderConditions(
  conditions: readonly RuleCondition[],
  tagNameOf: ReadonlyMap<number, string> = new Map(),
): string {
  // …原有逻辑…
  //   field === 'tag' 时:cond.any.map(Number).map(id => tagNameOf.get(id)).filter(Boolean)
  //   一个都没翻出来的话这条条件渲染成空串(和"关键词还空着"一样,不占行)
}
```

**四个调用方都要传这个名字表**(不传的会静默退化成"不渲染 tag 条件",比印数字好,
但白丢一半依据):

- `curator/chat.ts:80`(聊天给模型看的结构)
- `curator/routes.ts:338`(Pass 2 的夹子体系)
- `curator/suggestions.ts:117`(规则建议)
- `curator/routes.ts` 里 Task 7 新加的那个 `rules:` 入参

名字表的构造:`new Map(listTagsWithParent(db).map((r) => [r.id, r.name]))` —— 几行,不用助手。

- [ ] **Step 4: 改 `ruleRoutes.ts`**

`:102` 的字段白名单加 `'tag'`:

```ts
    if (o.field !== 'title' && o.field !== 'intro' && o.field !== 'upper' && o.field !== 'tag') {
      return 'field 只能是 title / intro / upper / tag';
    }
```

**要改的是 `rulesWithHits()`,不是路由里那段。**

**初稿这里指错了行**(写的是 `:226` 的 `/api/rules/dry-run`)。那一段只调
`rulesWithHits()`,自己**没有 `items`、也没有 `matchAll`** —— 照抄会写出引用不存在
变量的代码;而真正该加 ctx 的地方没人改,于是**tag 规则的命中数在界面上永远显示 0**
(那正是用户调规则时唯一有用的反馈)。

真正的位置是 `ruleRoutes.ts:60-86` 的 `rulesWithHits()`,`matchAll` 在 `:64`:

```ts
function rulesWithHits(db: Database.Database) {
  const rules = listRules(db);
  const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
  const tagsOf = itemTagIds(db);

  // §9F:不传 ctx 的话 tag 条件一律不命中(缺 subtree 时实现刻意返回"没有标签"),
  // 于是界面上"命中 N 条"恒为 0,而规则看起来是配好的
  const matched = matchAll(
    items.map((i) => ({
      id: i.id, title: i.title, intro: i.intro, upperName: i.upper_name,
      tagIds: tagsOf.get(i.id) ?? [],
    })),
    rules,
    { subtree: subtreeSets(db) },
  );
  // …原有的形状转换不变…
}
```

`/api/rules/dry-run`(`:226`)只消费 `rulesWithHits()` 的结果,**不用动**。

其中 `toRuleItem` 现在要带 `tagIds`:

```ts
const tagsOf = itemTagIds(db);
items.map((i) => ({
  id: i.id, title: i.title, intro: i.intro, upperName: i.upper_name,
  tagIds: tagsOf.get(i.id) ?? [],
}))
```

**`suggestions.ts` 也必须跟上**(否则 tag 规则在建议那条路上永远不命中 —— 它自己算"规则覆盖了哪些条目",算错了会把已经归好的条目又建议一遍):

`toRuleItem`(`suggestions.ts:80`)改成带 `tagIds`,并让 `matchAll` 拿到 ctx:

```ts
/** 建一次 itemId → tagIds 的表,闭包给下面用 —— 别在 toRuleItem 里逐条查 */
const toRuleItemWith = (tagsOf: ReadonlyMap<string, number[]>) => (i: ItemRow): RuleItem => ({
  id: i.id, title: i.title, intro: i.intro, upperName: i.upper_name,
  tagIds: tagsOf.get(i.id) ?? [],
});
```

`suggestionInput`(`suggestions.ts:129`)改成:

```ts
  const ctx = { subtree: subtreeSets(db) };
  const toRuleItem = toRuleItemWith(itemTagIds(db));
  const covered = matchAll(all.map(toRuleItem), rules, ctx);
```

`itemsById` 那处(`suggestions.ts:217`)同样用 `toRuleItem`,保持一致 —— 两处口径不同的话,建议的"证据条目"会指错东西。

- [ ] **Step 5: 改 `routes.ts` 的 run-pass-2**

`:364` 的 `matchAll` 加 ctx,并让 `aiRules` 保持一致:

```ts
    const tagsOf = itemTagIds(db);
    const matched = matchAll(
      items.map((i) => ({
        id: i.id, title: i.title, intro: i.intro, upperName: i.upper_name,
        tagIds: tagsOf.get(i.id) ?? [],
      })),
      rules,
      { subtree: subtreeSets(db) },
    );
```

- [ ] **Step 6: 前端加这个字段 —— 不然规则在界面上建不出来**

后端能存 tag 条件、能匹配,但用户**配不出来**。三处(缺一处就白做):

`web/src/types.ts` 的 `RuleField` 加一个值:

```ts
export type RuleField = 'title' | 'intro' | 'upper' | 'tag';
```

`web/src/components/RulesPanel.tsx` 的 `FIELD_LABEL`(它是 `Record<RuleField, string>`,
**不加这一行类型立刻报错**):

```tsx
const FIELD_LABEL: Record<RuleField, string> = {
  title: '标题', intro: '简介', upper: 'UP 名', tag: '标签',
};
```

字段下拉(同一文件 `:600` 附近的 `Select options`)加一项:

```tsx
{ value: 'tag', label: '标签' },
```

**还要处理"选哪个标签"**:其他三个字段是自由输入关键词,而 tag 要**从词库里选**
(存的是 id)。所以在 `RulesPanel` 里按 `field === 'tag'` 分支渲染一个
`Select showSearch`(数据源 `tagApi.tree()` 摊平后的词表,`optionFilterProp="label"`),
选中后把 `String(id)` 写进 `any`。**不要**让用户手打 id —— 那跟"填数字不填名字"
那条纪律是两回事:那条说的是**给模型看**的时候填数字,而这里是**给人选**的时候。

- [ ] **Step 7: 跑测试 + 提交**

Run: `cd server && npm test` 然后 `cd web && npm run typecheck`
Expected: 两边都过

```bash
git add server/src/db/repo/rules.ts server/src/curator/rules.ts server/src/curator/rules.test.ts \
        server/src/curator/ruleRoutes.ts server/src/curator/ruleRoutes.test.ts \
        server/src/curator/suggestions.ts server/src/curator/chat.ts server/src/curator/routes.ts \
        web/src/types.ts web/src/components/RulesPanel.tsx
git commit -m "feat(rules): 第四字段 tag,选中即匹配整棵子树"
```

---

### Task 7: 夹子画像 + 离群标记 + 提体系换输入

**Files:**
- Create: `server/src/curator/folderProfile.ts` / `folderProfile.test.ts`
- Modify: `server/src/curator/classifier.ts`(`buildPass1Prompt` 加画像与规则)
- Modify: `server/src/curator/routes.ts`(run-pass-1 传画像与规则;**`GET /api/workbench` 加 `profiles`**)
- Modify: `server/src/http/routes/items.ts`(`/api/items/:id` 带 `tagNames`)
- Modify: `web/src/components/WorkFolderTree.tsx` + `web/src/pages/curator.tsx`(夹子行的 ⚠)

**Interfaces:**
- Produces:
  - `export interface FolderProfile { folderId: number; name: string; itemCount: number; topTags: {name: string; count: number}[]; outliers: string[] }`
  - `export function buildFolderProfiles(db): FolderProfile[]`
  - `export function renderProfiles(profiles: readonly FolderProfile[]): string`

- [ ] **Step 1: 写失败测试 `folderProfile.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
import { ensureTag, linkItemTag } from '../db/repo/tags.js';
import { buildFolderProfiles } from './folderProfile.js';

function fixture() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO work_folders (id, origin_id, name, created_at) VALUES (1, NULL, '美食', 0), (2, NULL, '看球', 0)`)
    .run();
  const food = ensureTag(db, '美食', null);
  const sport = ensureTag(db, 'NBA', null);

  for (let i = 0; i < 10; i++) {
    const id = `BV${i}`;
    upsertItem(db, { id, type: 2, title: `菜谱 ${i}` });
    linkItemTag(db, id, food, 'ai');
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (1, ?)`).run(id);
  }
  // 一条走错门的:挂着 NBA,却躺在美食夹子里
  upsertItem(db, { id: 'BVX', type: 2, title: '湖人 vs 勇士' });
  linkItemTag(db, 'BVX', sport, 'ai');
  db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (1, 'BVX')`).run('BVX');
  return db;
}

describe('buildFolderProfiles', () => {
  it('画像列出该夹子的高频标签', () => {
    const p = buildFolderProfiles(fixture());
    const food = p.find((x) => x.name === '美食')!;
    expect(food.itemCount).toBe(11);
    expect(food.topTags[0]).toEqual({ name: '美食', count: 10 });
  });

  it('离群:每个标签在夹子里都没有同伴 —— 零参数判据', () => {
    const p = buildFolderProfiles(fixture());
    expect(p.find((x) => x.name === '美食')!.outliers).toEqual(['BVX']);
  });

  it('夹子条目 <5 不判(样本不足,统计下限同 C9)', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO work_folders (id, origin_id, name, created_at) VALUES (1, NULL, '小夹子', 0)`).run();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (1, 'BV1')`).run();
    expect(buildFolderProfiles(db)[0]!.outliers).toEqual([]);
  });

  it('没有标签的条目不判离群(没依据,不是可疑)', () => {
    const db = fixture();
    upsertItem(db, { id: 'BVY', type: 2, title: '还没标' });
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (1, 'BVY')`).run();
    expect(buildFolderProfiles(db).find((x) => x.name === '美食')!.outliers).toEqual(['BVX']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/folderProfile.test.ts`
Expected: FAIL —— `Failed to resolve import "./folderProfile.js"`

- [ ] **Step 3: 写 `server/src/curator/folderProfile.ts`**

```ts
/**
 * 夹子画像 + 离群标记(spec §9F C14/C15)。
 *
 * 两件事刻意分开:
 *
 * - **画像**是**喂给模型的输入**(C15:让"提体系"那一环看得见夹子里实际有什么,
 *   而不是只会看夹子名瞎猜 —— §9C.0 的事故就是这个猜造成的),顺便给人看。
 * - **离群标记**是**零参数判据**:一条视频若它**每一个**标签在该夹子的其他视频
 *   身上都不出现,就是可疑。没有"多少算不搭"这种要拍的数。
 *
 * **它照的是镜子,不是裁判**:夹子本来就一半放错了,画像就是错的,离群也跟着不准。
 */
import type Database from 'better-sqlite3';
import { listWorkFolders, workItemIds } from '../db/repo/workbench.js';
import { itemTagIds, listTagsWithParent } from '../db/repo/tags.js';

/** 离群判定外的统计下限 —— 与 C9 同一个数,理由也一样:少于它没有统计意义 */
export const MIN_SAMPLE = 5;

export interface FolderProfile {
  folderId: number;
  name: string;
  itemCount: number;
  /** 高频标签,降序。模型据此知道"这个夹子实际是什么" */
  topTags: { name: string; count: number }[];
  /** 可疑的条目 id:它每个标签在这个夹子里都没有同伴 */
  outliers: string[];
}

export function buildFolderProfiles(db: Database.Database): FolderProfile[] {
  const nameOf = new Map(listTagsWithParent(db).map((r) => [r.id, r.name]));
  const tagsOf = itemTagIds(db);

  return listWorkFolders(db).map((f) => {
    const ids = workItemIds(db, f.id);
    const freq = new Map<number, number>();
    const own = new Map<string, Set<number>>();

    for (const itemId of ids) {
      const tags = tagsOf.get(itemId) ?? [];
      if (tags.length === 0) continue;
      own.set(itemId, new Set(tags));
      for (const t of tags) freq.set(t, (freq.get(t) ?? 0) + 1);
    }

    // 离群:样本够 + 这条有标签 + 它的每个标签在这个夹子里**只**出现在它身上
    const outliers: string[] = [];
    if (ids.length >= MIN_SAMPLE) {
      for (const [itemId, mine] of own) {
        const lonely = [...mine].every((t) => (freq.get(t) ?? 0) <= 1);
        if (lonely) outliers.push(itemId);
      }
    }

    return {
      folderId: f.id,
      name: f.name,
      itemCount: ids.length,
      topTags: [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([t, count]) => ({ name: nameOf.get(t) ?? String(t), count })),
      outliers: outliers.sort(),
    };
  });
}

/**
 * 渲染成给模型看的一段。**空画像不占行** —— 和 renderItem 的标签行同一个规矩。
 */
export function renderProfiles(profiles: readonly FolderProfile[]): string {
  return profiles
    .filter((p) => p.topTags.length > 0)
    .map((p) => {
      const mix = p.topTags.map((t) => `${t.name} ${Math.round((t.count / Math.max(1, p.itemCount)) * 100)}%`).join('、');
      return `- ${p.name}(${p.itemCount} 条)—— 实际构成:${mix}`;
    })
    .join('\n');
}
```

- [ ] **Step 4: `buildPass1Prompt` 换输入**

opts 加 `profiles?: string` 与 **`rulesText?: string`**,插到"用户现有的收藏夹"那块下面。

> ⚠️ **参数名必须是 `rulesText`,不能叫 `rules`。** `runPass1` 的 opts 里已经有一个
> `rules?: ReadonlyMap<string, readonly string[]>`(keyword 初分用的词表,
> `classifier.ts:461`),同一层再加一个同名的 `string` 直接**编译不过**。
> 名字里带 `Text` 也正好说明它是"给人/给模型看的那段文本",不是数据。

```ts
  const parts = [
    `## 用户现有的收藏夹(${opts.existingFolders.length} 个)`,
    folders,
  ];
  // §9F C15:画像 = "这个夹子里**实际**是什么"。没有它,模型只能看名字猜 ——
  // §9C.0 那次事故(4 条 AI 教程被归进「黑神话」)就是这个猜造成的。
  if (opts.profiles) parts.push('', '### 每个夹子里实际是什么(按标签统计)', opts.profiles);
  if (opts.sample.length) {
    parts.push(
      '',
      `## 收藏样本(${opts.sample.length} 条,从整个收藏库里均衡抽取)`,
      opts.sample
        .map((i) => {
          const t = opts.tagInfo.get(i.id);
          return renderItem(i, 120, t?.names, t?.kind);
        })
        .join('\n\n'),
    );
  }
  if (opts.rulesText) parts.push('', '### 现有的归类规则', opts.rulesText);
  // …clusterNote / userConstraint / 收尾 照旧…
```

`runPass1` 的 opts 加 `profilesText?: string` / `rulesText?: string` 并透传
(**别叫 `rules`** —— 那个名字已经被 keyword 词表占了)。

`routes.ts` 的 `run-pass-1` 里:

```ts
        profilesText: renderProfiles(buildFolderProfiles(db)),
        // renderConditions 要拿到名字表,否则 tag 条件会印成一串 id(Task 6)
        rulesText: listRules(db)
          .map((r) => `${r.folderId}: ${renderConditions(r.conditions, tagNameOf) || '(空)'}`)
          .join('\n'),
        tagInfo: tagInfoByItem(db),
```

- [ ] **Step 5: `/api/items/:id` 与工作台条目接口带标签**

`http/routes/items.ts` 的 `shapeItem` 保持原样(它的注释要求"出口形状单一口径"),
**标签走同级字段**:

```ts
    // 在**原有返回值**上加一个字段 —— 别整段重写。
    // 初稿给的那段抄了不存在的变量名(`row` / `favTime`),照抄编译错;
    // 这个 handler 里的局部变量和返回值以它本来的写法为准。
    const info = tagInfoByItem(db).get(id);
    return {
      ...原有字段,                    // item: shapeItem(...) / folders: [...] 一个字都不改
      tagNames: info?.names ?? [],   // §9F:这条挂的标签,详情栏显示用
    };
```

`curator/routes.ts:874` 那条工作台条目接口**先别动** —— 它的出口是 `{items, total}`,
目前没有任何前端消费方需要标签;加了就是死字段。

- [ ] **Step 6: 给离群标记一个出口**

C14 的离群判定算出来了,**但没地方能看到它** —— 画像只喂给了 Pass 1,离群条目
没有任何路由暴露。只算不露的判据等于没做。

出口放在 `GET /api/workbench`(`curator/routes.ts:699`):它已经在返回工作副本的
整个视图,再加一个 `profiles` 字段最省事(不新增路由)。

```ts
  app.get('/api/workbench', async () => {
    const view = buildWorkbenchView(db);
    const state = getWorkState(db);
    // …
    return {
      // …原有字段…
      /**
       * §9F C14:每个夹子的标签画像 + 离群条目。
       *
       * **一次算完整个数组**(几十个夹子,内存统计),不要在字段里按需算 ——
       * 那会让这个本来一次查询的接口变成 N 次。
       */
      profiles: buildFolderProfiles(db),
    };
  });
```

前端(`web/src/components/WorkFolderTree.tsx` 的夹子行)在有离群时加一个 ⚠:

```tsx
        {/* §9F C14:这个夹子里有几条和其余内容对不上(零参数判据 —— 它每个标签
            在夹子里都没有同伴)。点开能看是哪几条,不自动改任何东西 */}
        {outliers.length > 0 && (
          <span
            role="img"
            aria-label={`${outliers.length} 条可能放错了`}
            title={`${outliers.length} 条可能放错了:${outliers.slice(0, 3).join('、')}${outliers.length > 3 ? ' …' : ''}`}
            style={{ fontSize: 11, color: 'var(--warn)', flex: 'none', cursor: 'help' }}
          >
            ⚠
          </span>
        )}
```

`outliers` 由 `WorkFolderTree` 的 props 传进来(在 `curator.tsx` 里从 `/api/workbench`
的 `profiles` 按 `folderId` 取)。**只提示、不自动移** —— 夹子本来就一半放错时画像
也是错的,它照的是镜子不是裁判(§9F.6)。

- [ ] **Step 7: 跑测试 + 提交**

Run: `cd server && npm test` 然后 `cd web && npm run typecheck`
Expected: 两边都过

```bash
git add server/src/curator/folderProfile.ts server/src/curator/folderProfile.test.ts \
        server/src/curator/classifier.ts server/src/curator/routes.ts server/src/http/routes/items.ts \
        web/src/components/WorkFolderTree.tsx web/src/pages/curator.tsx
git commit -m "feat(tags): 夹子画像 + 离群标记;提体系看得见夹子实况"
```

---

### Task 8: 前端「标签」治理页

**Files:**
- Modify: `web/.umirc.ts` / `web/src/layouts/index.tsx` / `web/src/api.ts` / `web/src/types.ts`
- Create: `web/src/pages/tag.tsx` / `web/src/components/TagPanel.tsx`

**Interfaces:**
- Consumes: Task 5 的四个路由;Task 3 的 `done` 帧新字段
- Produces: `export const tagApi` 追加的方法、`web/src/types.ts` 的新类型

- [ ] **Step 1: 类型(`types.ts`,新开一节)**

```ts
// ── M4g:标签体系(词库树)──────────────────────────────

export interface TagNode {
  id: number;
  name: string;
  parentId: number | null;
  /** 直达这个节点的条目数,不含子孙 */
  count: number;
  children: TagNode[];
}

export interface TagTreeView {
  tree: TagNode[];
  total: number;
}

/** 一轮整理对树做了什么 —— 「标签」页顶部的清单(§9F C10) */
export interface TreeChange {
  kind: 'merge' | 'reparent';
  from: string;
  to: string;
  detail: string;
}

export interface TagRunResult {
  tagged: number;
  failedBatches: { firstItemId: string; size: number; reason: string }[];
  /** 质检做了什么 —— 剔了几个泛词、合了几组、挪了几个 */
  check: { dropped: number; merged: number; moved: number };
  /** 这轮树发生了什么(质检的 + 判据的),「标签」页顶部那张清单 */
  changes: TreeChange[];
  /** 本轮新建了多少个词 */
  newWordCount: number;
}
```

- [ ] **Step 2: api.ts 追加**

```ts
  tree: () => api<TagTreeView>('/api/tags/tree'),
  changes: () => api<{ changes: TreeChange[] }>('/api/tags/changes'),
  merge: (fromId: number, toId: number) => json<{ ok: true }>('POST', '/api/tags/merge', { fromId, toId }),
  update: (id: number, patch: { name?: string; parentId?: number | null }) =>
    json<{ ok: true }>('PATCH', `/api/tags/${id}`, patch),
  remove: (id: number) => json<{ ok: true }>('DELETE', `/api/tags/${id}`),
```

`tagApi.run` 的 `done` 类型从 `{tagged, failedBatches}` 换成 `TagRunResult` —— 其余流式骨架**一字不改**。

- [ ] **Step 3: 路由与导航**

`.umirc.ts` 的 `routes` 加两行:

```ts
      { path: '/tag', component: 'tag' },
      { path: '/browse', component: 'browse' },
```

`layouts/index.tsx:16-21` 的 nav 加(图标都从 `lucide-react` 取):

```tsx
      { to: '/tag', label: '标签', en: 'TAGS', icon: Tags },
      { to: '/browse', label: '浏览', en: 'BROWSE', icon: Compass },
```

- [ ] **Step 4: `pages/tag.tsx`(照 `rules.tsx` 的三行模式)**

```tsx
import TagPanel from '../components/TagPanel';

/**
 * /tag 标签 —— 词库的治理页。
 *
 * 为什么单开一页而不是挂在「规则」底下:标签是规则的**地基**(规则第四字段直接
 * 按标签子树匹配),但它比规则更基础 —— 规则是"谁进哪个夹子",标签是"这是什么"。
 */
export default function TagPage() {
  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="hud-label" style={{ color: 'var(--accent)' }}>标签</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          由 AI 标注长出来的词库。结构每轮自动整理,你也能手动改
        </span>
      </div>
      <TagPanel />
      <div style={{ height: 56, flex: 'none' }} aria-hidden />
    </div>
  );
}
```

- [ ] **Step 5: `components/TagTree.tsx`(两页共用的手写树)**

```tsx
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { TagNode } from '../types';

/**
 * 词库树 —— **手写**的,不用 antd `Tree`。
 *
 * 为什么手写:仓库里夹子/条目那棵树就是手写的(WorkFolderTree.tsx),它自成
 * 一套样式(缩进 + 展开三角 + 操作按钮 + 计数贴右)。antd Tree 一次没用过,
 * 混进来会多一套要调的样式和一套要学的 API,换不到任何东西。
 *
 * 这个组件**只管显示和展开/选中**,操作按钮由调用方经 `renderActions` 注入
 * ——「标签」页要改名/合并/删除,「浏览」页只选中,两边共用同一棵树。
 * 分两份写迟早分叉(和 shapeItem 注释里那条同理)。
 */
export default function TagTree({
  nodes,
  expanded,
  selectedId,
  onToggleExpand,
  onSelect,
  renderActions,
  depth = 0,
}: {
  nodes: TagNode[];
  expanded: Set<number>;
  selectedId?: number | null;
  onToggleExpand: (id: number) => void;
  /** 不传 = 只读(「浏览」页选了才有意义) */
  onSelect?: (id: number) => void;
  renderActions?: (node: TagNode) => React.ReactNode;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((n) => {
        const open = expanded.has(n.id);
        const hasKids = n.children.length > 0;
        return (
          <div key={n.id}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 4px',
                paddingLeft: 4 + depth * 16,
                borderBottom: '1px solid var(--rule)',
                background: n.id === selectedId ? 'var(--surface-2)' : 'none',
              }}
            >
              {hasKids ? (
                <button
                  type="button"
                  aria-label={open ? '收起' : '展开'}
                  aria-expanded={open}
                  onClick={() => onToggleExpand(n.id)}
                  style={{
                    flex: 'none', border: 'none', background: 'none', padding: 0,
                    cursor: 'pointer', color: 'var(--text-dim)', lineHeight: 0,
                  }}
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : (
                // 没有孩子也占同样的位置,否则同级节点名字对不齐
                <span style={{ width: 14, flex: 'none' }} aria-hidden />
              )}

              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  style={{
                    border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                    font: 'inherit', fontSize: 'var(--fs-13)', textAlign: 'left',
                    color: n.id === selectedId ? 'var(--accent)' : 'var(--text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {n.name}
                </button>
              ) : (
                <span
                  style={{
                    fontSize: 'var(--fs-13)', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {n.name}
                </span>
              )}

              {renderActions?.(n)}

              <span
                className="num"
                style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)', color: 'var(--text-dim)', flex: 'none' }}
              >
                {n.count}
              </span>
            </div>

            {open && (
              <TagTree
                nodes={n.children}
                expanded={expanded}
                selectedId={selectedId ?? null}
                onToggleExpand={onToggleExpand}
                {...(onSelect ? { onSelect } : {})}
                {...(renderActions ? { renderActions } : {})}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
```

- [ ] **Step 6: `components/TagPanel.tsx`**

```tsx
import { useState } from 'react';
import { Alert, App as AntApp, Select, Spin } from 'antd';
import { Combine, Pencil, Check, X, Trash2 } from 'lucide-react';
import { useRequest } from '@umijs/max';
import { rawResult, tagApi } from '../api';
import type { TagNode } from '../types';
import TagTree from './TagTree';

/**
 * 词库治理 —— 三层:顶上「树的变化」清单、中间那棵树、行内操作。
 *
 * **这一页不做自动整理** —— 整理在标注跑完时自动发生(§9F C10)。这里只有
 * "看它变成了什么"和"手动纠正"。用户的原话是"我不想管",所以不设审批闸;
 * 但结构必须**看得见**在长什么,这一页就是那个"看得见"。
 */
export default function TagPanel() {
  const { data: tree, loading, refresh: refreshTree } = useRequest(() => tagApi.tree(), {
    formatResult: rawResult,
  });
  // 变化清单跟着树一起刷 —— 手动合并/删除也会改变"上一轮变化"的读法,
  // 只挂载时拉一次的话,你改完词库回头看顶部那块,数字还是旧的
  const { data: changes, refresh: refreshChanges } = useRequest(() => tagApi.changes(), {
    formatResult: rawResult,
  });
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题,必须走 App.useApp()
  const { modal } = AntApp.useApp();

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  /** 写操作的统一外壳:清错误 → 忙 → 执行 → 重拉 → 失败报错。返回成功与否 */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await Promise.all([refreshTree(), refreshChanges()]);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * **没有"新建词"入口** —— 这是刻意的。
   *
   * 词库靠标注自己长(§9F C5),用户说过"我不想管标注 tag 的事情"。手动建的词
   * 没有视频挂它,在树上就是一个 count=0 的孤点,只会让画面变脏。真要加一个领域,
   * 正确做法是去「规则」页加一条规则把它喂出来。
   *
   * 手动操作只留三件**纠正**的事:改名(模型的写法不对)、合并(重复了)、
   * 删除(那是个泛词)。它们都是"把已经长歪的掰回来"。
   */

  /**
   * 合并 —— 目标用 Select 现选,选之前「合并」是禁着的。
   * 少了这一步,用户点确定会毫无反应,而"点了没反应"比报错更难查。
   */
  const confirmMerge = (node: TagNode, flat: TagNode[]) => {
    let targetId: number | null = null;
    const others = flat.filter((n) => n.id !== node.id);
    const inst = modal.confirm({
      title: `把「${node.name}」并进哪个词?`,
      content: (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>
            挂着它的 {node.count} 条视频会一起改挂过去,之后这个词就不在了。
            它的旧名字会记进别名表 —— 下次模型再吐「{node.name}」也认得出。
          </div>
          <Select
            autoFocus
            showSearch
            optionFilterProp="label"
            placeholder="并进哪个词(打字可以搜)"
            style={{ width: '100%' }}
            options={others.map((n) => ({ value: n.id, label: `${n.name}(${n.count} 条)` }))}
            onChange={(v: number) => {
              targetId = v;
              inst.update({ okButtonProps: { disabled: false } });
            }}
          />
        </div>
      ),
      okText: '合并',
      cancelText: '算了',
      okButtonProps: { disabled: true },
      onOk: () => {
        if (targetId !== null) act(() => tagApi.merge(node.id, targetId));
      },
    });
  };

  const confirmDelete = (node: TagNode) =>
    modal.confirm({
      title: `从词库里删掉「${node.name}」?`,
      content:
        node.children.length > 0
          ? `它下面还有 ${node.children.length} 个词,那些词会提到上一级,不会被删。`
          : `挂着它的 ${node.count} 条视频会失去这个标签,视频本身不会动。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '算了',
      onOk: () => act(() => tagApi.remove(node.id)),
    });

  // 把树摊平 —— 合并的目标选择要跨层级搜,不能只在同级里挑
  const flat: TagNode[] = [];
  const walk = (nodes: TagNode[]) => { for (const n of nodes) { flat.push(n); walk(n.children); } };
  walk(tree?.tree ?? []);

  const actions = (node: TagNode) =>
    editing === node.id ? (
      <>
        <input
          autoFocus
          aria-label={`重命名「${node.name}」`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { setEditing(null); if (draft.trim()) void act(() => tagApi.update(node.id, { name: draft.trim() })); }
            if (e.key === 'Escape') setEditing(null);
          }}
          style={{
            flex: 1, minWidth: 0, font: 'inherit', fontSize: 'var(--fs-13)',
            background: 'var(--surface-2)', color: 'var(--text)',
            border: '1px solid var(--accent)', padding: '1px 5px',
          }}
        />
        <button type="button" aria-label="确认"
          onClick={() => { setEditing(null); if (draft.trim()) void act(() => tagApi.update(node.id, { name: draft.trim() })); }}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ok)', lineHeight: 0 }}>
          <Check size={13} />
        </button>
        <button type="button" aria-label="取消" onClick={() => setEditing(null)}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-dim)', lineHeight: 0 }}>
          <X size={13} />
        </button>
      </>
    ) : (
      <>
        <button type="button" aria-label={`重命名「${node.name}」`}
          onClick={() => { setEditing(node.id); setDraft(node.name); }}
          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5, lineHeight: 0 }}>
          <Pencil size={11} />
        </button>
        {flat.length > 1 && (
          <button type="button" aria-label={`把「${node.name}」并进别的词`}
            title="并进别的词(挂着它的视频会一起改挂过去)"
            onClick={() => confirmMerge(node, flat)}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5, lineHeight: 0 }}>
            <Combine size={11} />
          </button>
        )}
        <button type="button" aria-label={`删除「${node.name}」`}
          title={node.children.length > 0 ? '它下面的词会提到上一级' : '从词库里删掉这个词'}
          onClick={() => confirmDelete(node)}
          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5, lineHeight: 0 }}>
          <Trash2 size={11} />
        </button>
      </>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <Alert type="error" showIcon closable message={error} onClose={() => setError('')} />}

      <div className="hud-panel" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span className="hud-label">上一轮变化</span>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            每轮标注跑完自动整理一次,结果是这些 —— 不需要你确认
          </span>
        </div>
        {(changes?.changes ?? []).length === 0 ? (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            还没有跑过标注,或者上一轮什么都没变
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 'var(--fs-12)' }}>
            {changes!.changes.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 8 }}>
                <span style={{ color: c.kind === 'merge' ? 'var(--ok)' : 'var(--accent)', flex: 'none' }}>
                  {c.kind === 'merge' ? '→' : '↑'}
                </span>
                <span>{c.from}{c.to ? ` → ${c.to}` : ''}</span>
                <span style={{ color: 'var(--text-dim)' }}>{c.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hud-panel" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span className="hud-label">词库</span>
          <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            {tree?.total ?? 0} 个词
          </span>
          {busy && <Spin size="small" />}
        </div>

        {loading ? (
          <div style={{ padding: 20, textAlign: 'center' }}><Spin /></div>
        ) : (tree?.tree ?? []).length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-13)' }}>
            词库还是空的。去「规则」页点一次「AI 标注」,它会自己长出来
          </div>
        ) : (
          <TagTree
            nodes={tree!.tree}
            expanded={expanded}
            onToggleExpand={toggle}
            renderActions={actions}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: typecheck + build 门禁**

Run: `cd web && npm run typecheck`
Expected: 无输出(通过)

Run: `cd web && npm run build 2>&1 | tail -3`
Expected:输出含 `Compiled successfully`(**退出码恒为 1,不是失败**)

- [ ] **Step 8: 提交**

```bash
git add web/.umirc.ts web/src/layouts/index.tsx web/src/pages/tag.tsx web/src/components/TagTree.tsx web/src/components/TagPanel.tsx web/src/api.ts web/src/types.ts
git commit -m "feat(web): 「标签」治理页 —— 手写树 + 变化清单 + 手动合并/改名/删"
```

---

### Task 9: 前端「浏览」按标签看收藏

**Files:**
- Create: `web/src/pages/browse.tsx` / `web/src/components/BrowsePanel.tsx`
- Modify: `web/src/api.ts` / `web/src/types.ts` / `web/src/components/ContextPane.tsx`
- **Modify**: `web/src/pages/index.tsx` —— 它用了 `ContextPane`,多出来的 `tags` prop 要传
- Modify: `server/src/curator/tagRoutes.ts`(加 `GET /api/tags/:id/items`)

**Interfaces:**
- Produces: `GET /api/tags/:id/items?page&pageSize` → `{ items; total; foldersOf: Record<string, {id,title}[]> }`

- [ ] **Step 1: 写失败测试(服务端)**

```ts
  it('GET /api/tags/:id/items 回条目 + 每条散在哪些夹子', async () => {
    const { app, db } = makeApp();
    const t = ensureTag(db, '露营', null);
    // 两条挂「露营」的视频,都在工作副本的同一个夹子里 —— 归属要跟着回来
    db.prepare(`INSERT INTO work_folders (id, origin_id, name, created_at) VALUES (1, NULL, '露营', 0)`).run();
    for (const id of ['BV1', 'BV2']) {
      upsertItem(db, { id, type: 2, title: `露营 ${id}` });
      linkItemTag(db, id, t, 'ai');
      db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (1, ?)`).run(id);
    }

    const r = await app.inject({ method: 'GET', url: `/api/tags/${t}/items` });
    const body = r.json();
    expect(body.total).toBe(2);
    // shapeItem 的字段一个不少(出口形状单一口径)
    expect(Object.keys(body.items[0]).sort()).toEqual(
      ['cover', 'duration', 'favTime', 'id', 'invalid', 'pubtime', 'title', 'upperName'].sort(),
    );
    // 夹子归属走**同级字段**,不塞进 item 里 —— 免得破坏 shapeItem 的单一口径
    expect(body.foldersOf[body.items[0].id]).toEqual([{ id: 1, title: '露营' }]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/tagRoutes.test.ts`
Expected: FAIL —— 404

- [ ] **Step 3: 服务端加路由**

`tagRoutes.ts` 的 import 要补上这条新路由用到的东西(Task 5 那批里没有):

```ts
import { getItem } from '../db/repo/items.js';
import { listWorkFolders } from '../db/repo/workbench.js';
import { subtreeSets } from '../db/repo/tags.js';
import { shapeItem } from '../http/routes/items.js';
```


```ts
  /**
   * 按标签筛条目(§9F C12「浏览」页)。
   *
   * **用子树**:选「体育」要能捞出 NBA、世界杯那些 —— 和规则的匹配语义(C11)一致,
   * 否则用户点一下发现"体育 只有 3 条"会以为标签没用。
   *
   * 夹子归属走**同级字段 `foldersOf`**,不塞进 item 里:shapeItem 是"出口形状
   * 单一口径"(见它的注释),加字段会让前端两套渲染分叉。
   */
  app.get('/api/tags/:id/items', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!tagsExist(db, [id])) return reply.code(404).send({ ok: false, reason: '词库里没有这个标签' });
    const q = req.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const pageSize = Math.max(1, Number(q.pageSize ?? 60) || 60);

    const sub = subtreeSets(db).get(id) ?? new Set([id]);
    const ids = db
      .prepare(
        `SELECT DISTINCT item_id FROM item_tags
          WHERE tag_id IN (${[...sub].map(() => '?').join(',')})
          ORDER BY item_id`,
      )
      .all(...sub) as { item_id: string }[];

    const total = ids.length;
    const slice = ids.slice((page - 1) * pageSize, page * pageSize).map((r) => r.item_id);

    // 归属一次查完(工作副本口径 —— 「浏览」看的是"你桌上这份")
    const foldersOf: Record<string, { id: number; title: string }[]> = {};
    const folderName = new Map(listWorkFolders(db).map((f) => [f.id, f.name]));
    if (slice.length) {
      const rows = db
        .prepare(
          `SELECT item_id, folder_id FROM work_folder_items
            WHERE item_id IN (${slice.map(() => '?').join(',')})`,
        )
        .all(...slice) as { item_id: string; folder_id: number }[];
      for (const r of rows) {
        (foldersOf[r.item_id] ??= []).push({ id: r.folder_id, title: folderName.get(r.folder_id) ?? `#${r.folder_id}` });
      }
    }

    return {
      items: slice
        .map((iid) => getItem(db, iid))
        .filter((x): x is ItemRow => x !== undefined)
        .map((x) => shapeItem(x, null)),
      total,
      foldersOf,
      // 详情栏要显示"这条挂的**全部**标签" —— 只显示当前筛的那个词会让人
      // 以为它没有别的标签。和 foldersOf 同一批查完,不多一次往返
      tagsOf,
    };
  });
```

`tagsOf` 的算法和 `foldersOf` 并列,放在它**后面**:

```ts
    const tagsOf: Record<string, string[]> = {};
    if (slice.length) {
      const rows = db
        .prepare(
          `SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
            WHERE it.item_id IN (${slice.map(() => '?').join(',')})
            ORDER BY it.item_id, t.name`,
        )
        .all(...slice) as { item_id: string; name: string }[];
      for (const r of rows) (tagsOf[r.item_id] ??= []).push(r.name);
    }
```

前端 `api.ts` 加一个方法(**Task 8 的 `tagApi` 里追加**):

```ts
  items: (id: number, page = 1) =>
    api<{ items: Item[]; total: number; foldersOf: Record<string, { id: number; title: string }[]>; tagsOf: Record<string, string[]> }>(
      `/api/tags/${id}/items?page=${page}&pageSize=60`,
    ),
```

- [ ] **Step 4: 前端页 + 面板 + 详情栏显示标签**

`pages/browse.tsx`:

```tsx
import BrowsePanel from '../components/BrowsePanel';

/**
 * /browse 浏览 —— 按标签看收藏。
 *
 * 和「标签」页分开的理由:那一页是**治理**(改词库),这一页是**使用**(挑视频)。
 * 混在一页会让人以为点标签就改了词。用户明确要了两个页面。
 */
export default function BrowsePage() {
  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="hud-label" style={{ color: 'var(--accent)' }}>浏览</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          按标签看收藏 —— 选一个词,它**连同下面所有的词**一起捞出来
        </span>
      </div>
      <BrowsePanel />
      <div style={{ height: 56, flex: 'none' }} aria-hidden />
    </div>
  );
}
```

`components/BrowsePanel.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Spin } from 'antd';
import { useRequest, useSearchParams } from '@umijs/max';
import { rawResult, tagApi } from '../api';
import type { Item } from '../types';
import ContextPane from './ContextPane';
import ItemGrid from './ItemGrid';
import TagTree from './TagTree';

const PAGE_SIZE = 60;
/**
 * 空结果。
 *
 * **四个字段都要显式类型** —— 光写 `{ foldersOf: {} }` 的话,`web/tsconfig.json` 的
 * `strict` 会把它推成 `{}`,下面 `foldersOf[it.id]` 的索引直接报 **TS7053**,
 * Task 9 的 typecheck 门禁过不去。(初稿就是这么写的,实测复现过。)
 */
const EMPTY: {
  items: Item[];
  total: number;
  foldersOf: Record<string, { id: number; title: string }[]>;
  tagsOf: Record<string, string[]>;
} = { items: [], total: 0, foldersOf: {}, tagsOf: {} };

/**
 * 按标签看收藏 —— 复用 ItemGrid(条目渲染只有一套口径),只在旁边加一层标签选择。
 *
 * 选中的标签存在 URL 上(`?tag=`),不放在 state 里 —— 这样"从「标签」页点一个词
 * 跳过来"和"在这一页点"走的是同一条路,而且刷新/后退都还在原地。
 */
export default function BrowsePanel() {
  const [params, setParams] = useSearchParams();
  const tagId = Number(params.get('tag')) || null;
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Item | null>(null);
  const [error, setError] = useState('');

  const { data: tree } = useRequest(() => tagApi.tree(), { formatResult: rawResult });
  const { data, loading } = useRequest(
    () => (tagId ? tagApi.items(tagId, page).catch((e: Error) => { setError(e.message); return EMPTY; }) : Promise.resolve(EMPTY)),
    { refreshDeps: [tagId, page], formatResult: rawResult },
  );

  /**
   * 选词。**页码必须归零** —— 不归的话从"有 5 页的词"跳到"只有 1 页的词",
   * 画面是空的,而用户会以为那个词没视频。
   */
  const pick = (id: number) => {
    setPage(1);
    setSelected(null);
    setParams({ tag: String(id) });
  };

  const icon = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const foldersOf = data?.foldersOf ?? {};
  const tagsOf = data?.tagsOf ?? {};
  const current = tree?.tree ? findName(tree.tree, tagId) : null;

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div className="hud-panel" style={{ width: 300, flex: 'none', padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span className="hud-label">词库</span>
          {tagId !== null && (
            <button
              type="button"
              onClick={() => { setPage(1); setSelected(null); setParams({}); }}
              style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 'var(--fs-12)' }}
            >
              清除
            </button>
          )}
        </div>
        {(tree?.tree ?? []).length === 0 ? (
          <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-12)', padding: '12px 0' }}>
            词库还是空的 —— 先去「规则」页点一次「AI 标注」
          </div>
        ) : (
          <TagTree
            nodes={tree!.tree}
            expanded={expanded}
            selectedId={tagId}
            onToggleExpand={icon}
            onSelect={pick}
          />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {error && <Alert type="error" showIcon closable message={error} onClose={() => setError('')} />}

        {tagId === null ? (
          <div className="hud-panel" style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-13)' }}>
            左边选一个词
          </div>
        ) : loading ? (
          <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
        ) : (
          <>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
              「{current ?? tagId}」连同它下面的词,一共{' '}
              <span className="num" style={{ color: 'var(--accent)' }}>{data?.total ?? 0}</span> 条
            </div>

            {/* 归属 chips —— 一条视频散在哪些夹子里。这正是标签存在的理由:
                夹子分不干净,标签能跨着看 */}
            {(data?.items ?? []).some((it) => (foldersOf[it.id] ?? []).length > 0) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {(data?.items ?? []).map((it) => {
                  const fs = foldersOf[it.id] ?? [];
                  if (fs.length === 0) return null;
                  return (
                    <div key={it.id} style={{ display: 'flex', gap: 8, fontSize: 'var(--fs-12)', alignItems: 'baseline' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>
                        {it.title}
                      </span>
                      <span style={{ color: 'var(--text-dim)' }}>
                        在 {fs.map((f) => `「${f.title}」`).join(' ')}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <ItemGrid
              items={data?.items ?? []}
              total={data?.total ?? 0}
              page={page}
              pageSize={PAGE_SIZE}
              onPage={setPage}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          </>
        )}
      </div>

      {/* tags 从筛选结果里带下来 —— 详情栏自己发请求会让每选一条都打一次接口 */}
      <ContextPane item={selected} tags={selected ? tagsOf[selected.id] ?? [] : []} />
    </div>
  );
}

/** 树里按 id 找名字(只用于顶部那句「选了谁」) */
function findName(nodes: { id: number; name: string; children: any[] }[], id: number | null): string | null {
  if (id === null) return null;
  for (const n of nodes) {
    if (n.id === id) return n.name;
    const hit = findName(n.children, id);
    if (hit) return hit;
  }
  return null;
}
```

`components/ContextPane.tsx` —— **加一个 `tags` prop,组件自己不发请求**:

```tsx
export default function ContextPane({ item, tags = [] }: { item: Item | null; tags?: string[] }) {
```

`<dl>` 里「状态」之后插一行:

```tsx
            <dt className="hud-label" style={{ margin: 0 }}>标签</dt>
            <dd style={{ margin: 0, color: 'var(--text)' }}>
              {tags.length ? tags.join(' · ') : '—'}
            </dd>
```

`pages/index.tsx` 用了 `ContextPane`,**也要传**:它选中条目时带一个 `tagNames`(由 `GET /api/items/:id` 返回,Task 7 已改)。给 `Item` 类型加可选 `tagNames?: string[]`,列表接口不带(那里不需要),详情接口带。

- [ ] **Step 5: typecheck + build 门禁**

Run: `cd web && npm run typecheck && npm run build 2>&1 | tail -3`
Expected:typecheck 通过;build 输出含 `Compiled successfully`

- [ ] **Step 6: 全量测试 + 提交**

Run: `cd server && npm test`
Expected: PASS

```bash
git add server/src/curator/tagRoutes.ts server/src/curator/tagRoutes.test.ts \
        web/src/pages/browse.tsx web/src/components/BrowsePanel.tsx \
        web/src/components/ContextPane.tsx web/src/pages/index.tsx \
        web/src/api.ts web/src/types.ts
git commit -m "feat(web): 「浏览」按标签看收藏(子树匹配)+ 详情栏显示标签"
```

---

## 收尾检查

全部任务完成后:

- [ ] `cd server && npm test` 全绿
- [ ] `cd server && npm run typecheck` 干净
- [ ] `cd web && npm run typecheck` 干净;`npm run build` 输出含 `Compiled successfully`
- [ ] **`ai_tags` 在生产代码里没有任何读写。** 列本身留在 schema 和 `ItemRow` 上
      (§9F C1:不迁移、不 DROP),所以 grep **会**命中它 —— 要核的是**没有使用**:

      ```bash
      grep -rn "ai_tags" server/src --include=*.ts | grep -v test
      ```

      Expected:只有 `db/schema.ts` 的 DDL 与注释、`db/repo/items.ts` 的 `ItemRow`
      字段声明和那两条注释。**不该出现 `.ai_tags`、`SET ai_tags`、`SELECT *, ai_tags`。**
      (初稿把这条门禁写成了"只剩 schema.ts",按字面永远过不了。)

- [ ] **反向核水位线** —— 增量标注全靠它,而它这次换了写手:

      ```bash
      grep -rn "ai_checked_at" server/src --include=*.ts | grep -v test
      ```

      Expected:`db/repo/tagging.ts` 里有**读**(`listUntaggedItemIds` / `tagStats`)
      也有**写**(`markItemTagged`)。只读不写 = 那个"每次全库重标"的坑又回来了。
- [ ] 真机跑一轮:点「AI 标注」→ 看「标签」页长出树 → 检查「树的变化」清单是否合理 → 在「浏览」页点一个词能捞出视频
