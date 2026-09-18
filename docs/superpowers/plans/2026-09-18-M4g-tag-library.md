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
| `server/src/db/repo/tagging.ts` | 改 | 删 `setItemTagging`/`parseItemTagging`(被 tags.ts 取代),加 `setItemKind` |
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

四处(都在 `curator/`):

- `tagger.ts` 的 `complete(...)` → `thinking: false`
- `classifier.ts` 的 `runPass1` / `runPass2` 两处 `complete(...)` → `thinking: false`
- `tagcheck.ts` 的 `complete(...)` → `thinking: false`
- `chat.ts` 的 `compact()`(滚动摘要,也是批量) → `thinking: false`
- **`chatStream` 不传** —— 聊天要思考流(§9D.5)

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
  - `export function mergeTags(db, fromId: number, toId: number): void`
  - `export function setTagParent(db, id: number, parentId: number | null): void`
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
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(child)).toEqual({ parentId: keep });
    expect(findTag(db, normalizeTagName('鲁夫'))).toBe(keep);
  });
});

describe('setTagParent / renameTag / deleteTag', () => {
  it('挂父后子树跟着走', () => {
    const db = fresh();
    const sport = ensureTag(db, '体育', null);
    const camp = ensureTag(db, '露营', null);
    setTagParent(db, camp, sport);
    expect(subtreeSets(db).get(sport)!.has(camp)).toBe(true);
  });

  it('renameTag 换 name 与 norm', () => {
    const db = fresh();
    const id = ensureTag(db, 'NBA', null);
    renameTag(db, id, '美职篮');
    expect(findTag(db, normalizeTagName('美职篮'))).toBe(id);
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

/** 先查别名表,再查根节点。命中就回 id,否则 null */
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
  // 新节点自己也记一笔别名,这样以后拿名字直接查得到(不必先知道父)
  addAlias(db, norm, id);
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
export function mergeTags(db: Database.Database, fromId: number, toId: number): void {
  if (fromId === toId) return;
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
}

export function setTagParent(db: Database.Database, id: number, parentId: number | null): void {
  if (id === parentId) return;
  db.prepare(`UPDATE tags SET parent_id = ? WHERE id = ?`).run(parentId, id);
}

export function renameTag(db: Database.Database, id: number, name: string): void {
  const norm = normalizeTagName(name);
  if (!norm) return;
  db.transaction(() => {
    db.prepare(`UPDATE tags SET name = ?, norm = ? WHERE id = ?`).run(name.trim(), norm, id);
    addAlias(db, name, id);
  })();
}

export function deleteTag(db: Database.Database, id: number): void {
  db.transaction(() => {
    // 子节点提一级,别连带删掉一整棵 —— 删一个词不该毁掉它底下所有东西
    db.prepare(`UPDATE tags SET parent_id = NULL WHERE parent_id = ?`).run(id);
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
- Modify: `server/src/db/repo/tagging.ts`(删两个导出,加 `setItemKind`)
- Rewrite: `server/src/curator/tagger.ts`
- Rewrite: `server/src/curator/tagger.test.ts`
- Modify: `server/src/curator/classifier.ts`(`renderItem` + 两个 prompt builder 签名)
- Modify: `server/src/curator/classifier.test.ts`(跟着改)
- Modify: `server/src/curator/routes.ts`(run-pass-1 / run-pass-2 建标签 map)

**Interfaces:**
- Consumes: Task 1 的 `ensureTag` / `addAlias` / `linkItemTag` / `itemTagIds` / `normalizeTagName`
- Produces:
  - `export function setItemKind(db, itemId: string, kind: string): void`(`db/repo/tagging.ts`)
  - `export interface TagOutput { id: string; kind: string; domains: string[]; tags: string[] }`
  - `export function coerceTagOutput(raw: unknown, batchIds: ReadonlySet<string>): TagOutput[]`(`curator/tagger.ts`)
  - `export function applyTagOutput(db, o: TagOutput): { created: string[] }`(`curator/tagger.ts`)
  - `export function tagNamesByItem(db): Map<string, string[]>`(写到 `db/repo/tags.ts`)
  - `export function renderItem(i: ItemRow, maxIntro: number, tagNames?: readonly string[]): string`(`curator/classifier.ts`)
  - `export function buildPass1Prompt(opts: {…; tagNames: ReadonlyMap<string, readonly string[]>})` / `buildPass2Prompt(opts: {…; tagNames: ReadonlyMap<string, readonly string[]>})`

- [ ] **Step 1: 改 `db/repo/tagging.ts`**

删掉 `ItemTagging` / `parseItemTagging` / `getItemTagging` / `setItemTagging`(被 tags.ts 取代),加:

```ts
/**
 * 形态(教学/娱乐/…)—— §9F C7 明文规定它是**独立的正交轴**,不并入主题树。
 * 混进树会让集合判据的合并/挂父要给保留节点开一堆例外;一列比一套例外便宜。
 *
 * 和 ai_checked_at 一样属于 C8 的 AI 派生列 —— 同步永不写它。
 */
export function setItemKind(db: Database.Database, id: string, kind: string): void {
  db.prepare(`UPDATE items SET ai_kind = ? WHERE id = ?`).run(kind, id);
}
```

`listUntaggedItemIds` / `tagStats` 原样保留(`ai_checked_at` 继续当增量水位线)。

- [ ] **Step 2: 写失败测试 `server/src/curator/tagger.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
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

  it('模型漏 items 字段时整条丢弃(不猜)', () => {
    expect(coerceTagOutput([{ id: 'BV1' }], new Set(['BV1']))).toEqual([
      { id: 'BV1', kind: '', domains: [], tags: [] },
    ]);
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
    out.push({
      id: o.id,
      // kind 越界 → 空串;落库时按「其它」处理。受控词表的定义(C3)
      kind: TAG_KINDS.includes(o.kind as never) ? (o.kind as string) : '',
      domains: strList(o.domains),
      tags: strList(o.tags),
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
  setItemKind(db, o.id, o.kind || '其它');

  return {
    created: (db.prepare(`SELECT id, name FROM tags`).all() as { id: number; name: string }[])
      .filter((r) => !before.has(r.id))
      .map((r) => r.name),
  };
}
```

`askOnce` 里改成调 `coerceTagOutput` + `applyTagOutput`,返回收到 id 的集合。
**删掉** `setItemTagging` 调用与 `setItemTagging` 之后那行里的 `opts.db` 依赖保持原样。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && npx vitest run src/curator/tagger.test.ts`
Expected: PASS

- [ ] **Step 6: 改 `classifier.ts` 的 renderItem 与两个 prompt builder**

```ts
/** 把一条收藏渲染成模型读的文本。**不带 fav_time** —— 那是"你什么时候收藏的",与主题无关(§9.3) */
function renderItem(i: ItemRow, maxIntro = 120, tagNames?: readonly string[]): string {
  const lines = [`[${i.id}] ${i.title}`];
  if (i.intro) {
    const intro = i.intro.length > maxIntro ? `${i.intro.slice(0, maxIntro)}…` : i.intro;
    lines.push(`  简介:${intro}`);
  }
  if (i.upper_name) lines.push(`  UP:${i.upper_name}`);
  if (i.duration) lines.push(`  时长:${Math.round(i.duration / 60)} 分钟`);
  // §9F:标签是**补充信号**,原始标题/简介仍在场(C6 的"冲突时以原始数据为准")
  if (tagNames?.length) lines.push(`  标签:${tagNames.join('·')}`);
  return lines.join('\n');
}
```

两个 builder 的 opts 各加 `tagNames: ReadonlyMap<string, readonly string[]>`(调用方一次算好,避免 N+1),`opts.items.map((i) => renderItem(i, 120, opts.tagNames.get(i.id)))`。

`buildPass1Prompt` 同样处理 `opts.sample`。

- [ ] **Step 7: 改 `routes.ts` 的两处调用**

`run-pass-1` 与 `run-pass-2` 各加一行,并把结果传进去:

```ts
// §9F:标签名一次取齐(避免 renderItem 里每条一次查询变成 N+1)
const tagNameOf = tagNamesByItem(db);
```

**这个助手加到 `db/repo/tags.ts`**(Task 1 建的文件)—— 它不只这一处用:Task 7 的夹子画像、Task 9 的「浏览」页都要按 itemId 拿标签名。

```ts
/** itemId → 标签显示名。**一次查完** —— 归类一批几百条,别在渲染里逐条查 */
export function tagNamesByItem(db: Database.Database): Map<string, string[]> {
  const rows = db
    .prepare(`SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
              ORDER BY it.item_id, t.name`)
    .all() as { item_id: string; name: string }[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const arr = out.get(r.item_id);
    if (arr) arr.push(r.name);
    else out.set(r.item_id, [r.name]);
  }
  return out;
}
```

- [ ] **Step 8: 改 `classifier.test.ts` 里 renderItem 相关用例**

把断言从 `AI标签:…` 改成 `标签:…`,并把 `item(..., { ai_tags: '…' })` 的构造改成传 `tagNames` map。原有那条"没标签不占行"的用例保留(传 `undefined`)。

- [ ] **Step 9: 全量测试 + 提交**

Run: `cd server && npm test`
Expected: 全部通过

```bash
git add server/src/db/repo/tagging.ts server/src/db/repo/tags.ts server/src/curator/tagger.ts server/src/curator/tagger.test.ts server/src/curator/classifier.ts server/src/curator/classifier.test.ts server/src/curator/routes.ts
git commit -m "feat(tags): 标注产出树标签,归类看得到树标签(ai_tags 停用)"
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
  it('target 必须是已有词(编的一律丢掉),action 越界丢', () => {
    const got = coerceVerdicts(
      [
        { name: 'AI', action: 'drop' },
        { name: '鲁夫', action: 'merge', target: '路飞' },
        { name: '鲁夫', action: 'merge', target: '不存在的词' },
        { name: 'x', action: '乱写' },
      ],
      new Set(['路飞']),
    );
    expect(got).toEqual([
      { name: 'AI', action: 'drop' },
      { name: '鲁夫', action: 'merge', target: undefined },
    ]);
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
  listTagTree, mergeTags, normalizeTagName, setTagParent, deleteTag,
  wouldExceedDepth, type TagNode,
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

/** 收窄。**target 必须是已有词** —— 模型编的目标一律丢掉,落回 keep */
export function coerceVerdicts(raw: unknown, known: ReadonlySet<string>): TagVerdict[] {
  const list = parseJsonArray(raw) ?? [];
  const out: TagVerdict[] = [];
  for (const r of list) {
    const o = r as { name?: unknown; action?: unknown; target?: unknown };
    if (typeof o?.name !== 'string' || !o.name.trim()) continue;
    const action = o.action === 'drop' || o.action === 'merge' || o.action === 'move' ? o.action : 'keep';
    const target = typeof o.target === 'string' && known.has(o.target.trim()) ? o.target.trim() : undefined;
    // merge/move 没有有效目标 = 做不到,退回 keep(不是 drop —— 别把"没听懂"当"该删")
    out.push(action !== 'keep' && !target ? { name: o.name.trim(), action: 'keep' } : { name: o.name.trim(), action, ...(target ? { target } : {}) });
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

  const verdicts = coerceVerdicts(await complete({ config: opts.config, messages }), known);

  let dropped = 0, merged = 0, moved = 0;
  for (const v of verdicts) {
    const id = byName(db, v.name);
    if (id === null) continue;
    if (v.action === 'drop') { deleteTag(db, id); dropped++; continue; }
    if (v.action === 'merge' && v.target) {
      const targetId = byName(db, v.target);
      if (targetId !== null && targetId !== id) { mergeTags(db, id, targetId); merged++; }
      continue;
    }
    if (v.action === 'move' && v.target) {
      const parentId = byName(db, v.target);
      // 挂父前先过深度闸(C2 封顶 4 层)。超了就**留原位** —— 不截断:
      // 截断会把这棵子树底下的东西整段丢掉
      if (parentId !== null && parentId !== id && !wouldExceedDepth(db, id, parentId)) {
        setTagParent(db, id, parentId);
        moved++;
      }
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

**Interfaces:**
- Consumes: Task 1 的 `listTagTree` / `itemTagIds` / `subtreeSets` / `mergeTags` / `setTagParent`
- Produces:
  - `export interface Coverage { a: number; b: number; ratio: number }`
  - `export function coverageOf(sets: ReadonlyMap<number, ReadonlySet<string>>): Coverage[]`
  - `export interface TreeChange { kind: 'merge' | 'reparent'; from: string; to: string; detail: string }`
  - `export function reconcile(db, opts?: { minSample?: number; cover?: number }): TreeChange[]`

- [ ] **Step 1: 写失败测试 `server/src/curator/tagtree.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
import { ensureTag, linkItemTag, listTagTree } from '../db/repo/tags.js';
import { reconcile, coverageOf } from './tagtree.js';

/** 建 N 条视频,前 k 条挂 tagIds 里的全部标签 */
function seed(db: ReturnType<typeof openDb>, n: number, tagIds: number[], from = 0) {
  for (let i = from; i < from + n; i++) {
    const id = `BV${i}`;
    upsertItem(db, { id, type: 2, title: id });
    for (const t of tagIds) linkItemTag(db, id, t, 'ai');
  }
}

describe('coverageOf', () => {
  it('算出 |A∩B| / |A|', () => {
    const sets = new Map<number, ReadonlySet<string>>([
      [1, new Set(['a', 'b', 'c', 'd'])],
      [2, new Set(['a', 'b'])],
    ]);
    const [c] = coverageOf(sets);
    expect(c!.ratio).toBe(0.5); // B 有 100% 落在 A 里 → A 覆盖 B 的比是 2/4
  });
});

describe('reconcile', () => {
  it('A 挂的几乎全在 B 里 → A 挂到 B 下', () => {
    const db = openDb(':memory:');
    const food = ensureTag(db, '美食', null);
    const roast = ensureTag(db, '烤羊肉', null);
    seed(db, 20, [food]);
    seed(db, 18, [food, roast], 20);   // 烤羊肉的 18 条全都在美食里
    const changes = reconcile(db);
    expect(changes.some((c) => c.kind === 'reparent')).toBe(true);
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(roast)).toEqual({ parentId: food });
  });

  it('双向都 ≥90% → 合并', () => {
    const db = openDb(':memory:');
    const a = ensureTag(db, '路飞', null);
    const b = ensureTag(db, '鲁夫', null);
    seed(db, 10, [a, b]);
    seed(db, 2, [a], 100);
    const changes = reconcile(db);
    expect(changes.some((c) => c.kind === 'merge')).toBe(true);
    expect(listTagTree(db).map((n) => n.name)).toEqual(['路飞']);
  });

  it('各挂各的 → 平级,什么都不做(露营 vs 美食)', () => {
    const db = openDb(':memory:');
    const food = ensureTag(db, '美食', null);
    const camp = ensureTag(db, '露营', null);
    seed(db, 30, [food]);
    seed(db, 5, [camp], 100);
    seed(db, 2, [food], 200);       // 只有 2 条重叠
    expect(reconcile(db)).toEqual([]);
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(camp)).toEqual({ parentId: null });
  });

  it('样本 <5 条不判(统计下限)', () => {
    const db = openDb(':memory:');
    const a = ensureTag(db, '小词', null);
    const b = ensureTag(db, '大词', null);
    seed(db, 50, [b]);
    seed(db, 3, [a, b], 100);       // 覆盖率 100% 但只有 3 条
    expect(reconcile(db)).toEqual([]);
  });

  it('互为父子时不来回改(已经是 B 的孩子就不再报)', () => {
    const db = openDb(':memory:');
    const parent = ensureTag(db, '美食', null);
    const child = ensureTag(db, '烤羊肉', parent);
    seed(db, 20, [parent]);
    seed(db, 18, [parent, child], 20);
    expect(reconcile(db)).toEqual([]);
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
  listTagsWithParent, mergeTags, setTagParent, tagSets, wouldExceedDepth, type TagRow,
} from '../db/repo/tags.js';

export interface Coverage {
  a: number;
  b: number;
  /** |A∩B| / |A| —— A 有多大比例落在 B 里 */
  ratio: number;
}

export interface TreeChange {
  kind: 'merge' | 'reparent';
  from: string;
  to: string;
  detail: string;
}

/** A → B 的覆盖率。**只算候选对**(共现过的)—— 全量两两是 O(n²) */
export function coverageOf(
  sets: ReadonlyMap<number, ReadonlySet<string>>,
): Coverage[] {
  const ids = [...sets.keys()];
  const out: Coverage[] = [];
  for (const a of ids) {
    const A = sets.get(a)!;
    if (A.size === 0) continue;
    for (const b of ids) {
      if (a === b) continue;
      const B = sets.get(b)!;
      let hit = 0;
      for (const x of A) if (B.has(x)) hit++;
      out.push({ a, b, ratio: hit / A.size });
    }
  }
  return out;
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

  const rows: TagRow[] = listTagsWithParent(db);
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
  const nameOf = new Map(rows.map((r) => [r.id, r.name]));
  const sets = tagSets(db);

  const changes: TreeChange[] = [];
  const dead = new Set<number>();

  // ── ① 合并:双向都 ≥cover 且都够样本 ──────────────────
  for (const { a, b, ratio } of coverageOf(sets)) {
    if (dead.has(a) || dead.has(b)) continue;
    if (a > b) continue;                       // 每对只处理一次(用 id 排序定方向)
    const sizeA = sets.get(a)!.size;
    const sizeB = sets.get(b)!.size;
    if (sizeA < minSample || sizeB < minSample) continue;
    const back = coverageOf(new Map([[b, sets.get(b)!], [a, sets.get(a)!]]))[0]!.ratio;
    if (ratio < cover || back < cover) continue;

    // 保留挂得多的那个(信息更全),把另一个并进来
    const [keep, drop] = sizeA >= sizeB ? [a, b] : [b, a];
    mergeTags(db, drop, keep);
    dead.add(drop);
    changes.push({
      kind: 'merge',
      from: nameOf.get(drop) ?? String(drop),
      to: nameOf.get(keep) ?? String(keep),
      detail: `挂的是同一批视频(${Math.round(Math.max(ratio, back) * 100)}% 重合)`,
    });
  }

  // ── ② 挂父:单向外包 ≥cover,且样本够 ────────────────
  for (const { a, b, ratio } of coverageOf(sets)) {
    if (dead.has(a) || dead.has(b) || a === b) continue;
    if (ratio < cover) continue;
    if (sets.get(a)!.size < minSample || sets.get(b)!.size < minSample) continue;
    // 已经是 b 的孩子(或 b 已在 a 的子树里)→ 不动,免得来回改
    if (parentOf.get(a) === b || isAncestor(parentOf, b, a)) continue;
    // 根与根之间才挂;已经有父的不动(那是质检给的判断,数据只纠正"没有父"的)
    if (parentOf.get(a) !== null) continue;
    // 深度闸(C2 封顶 4 层)—— 超了就不挂
    if (wouldExceedDepth(db, a, b)) continue;

    setTagParent(db, a, b);
    parentOf.set(a, b);
    changes.push({
      kind: 'reparent',
      from: nameOf.get(a) ?? String(a),
      to: nameOf.get(b) ?? String(b),
      detail: `${Math.round(ratio * 100)}% 的视频也挂着「${nameOf.get(b) ?? b}」`,
    });
  }

  return changes;
}

/** node 是不是 anc 的后代 —— 防环 */
function isAncestor(parentOf: ReadonlyMap<number, number | null>, node: number, anc: number): boolean {
  let cur: number | null | undefined = node;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    if (cur === anc) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
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
Expected: PASS(6 条)

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

- [ ] **Step 1: 写失败测试**(追加到 `tagRoutes.test.ts`)

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
    mergeTags(db, fromId, toId);
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
      if (body.parentId !== null && (!tagsExist(db, [body.parentId]) || body.parentId === id)) {
        return reply.code(400).send({ ok: false, reason: '父节点不合法' });
      }
      setTagParent(db, id, body.parentId);
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

- [ ] **Step 5: `run` 路由末尾接上质检 + 判据**

`runTagging` 返回后、写 `done` 帧前插入:

```ts
      // ── 跑完自动整理(§9F C8 + C9 + C10)────────────────
      // 顺序不能反:先质检(定新词的归宿、剔泛词),再让数据说话(合并/挂父)。
      // 反过来判据会把证据吃掉 —— 详见 tagtree.ts 开头那段。
      let check = { dropped: 0, merged: 0, moved: 0 };
      try {
        check = await runTagCheck({
          config: llm.config,
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

      // 「树的变化」= 质检做的 + 判据做的。清单要**看得见**(C10),
      // 但不设审批闸 —— 用户只要求"看得见它在长什么"
      const changes: TreeChange[] = [];
      if (check.merged > 0) {
        changes.push({ kind: 'merge', from: '（质检）', to: '', detail: `合并了 ${check.merged} 组同义词` });
      }
      if (check.moved > 0) {
        changes.push({ kind: 'reparent', from: '（质检）', to: '', detail: `挪了 ${check.moved} 个词的位置` });
      }
      changes.push(...reconcile(db));
      setSetting(db, CHANGES_KEY, JSON.stringify(changes));

      if (check.dropped > 0) {
        log.event({ level: 'info', category: 'llm', message: `质检剔除了 ${check.dropped} 个泛词` });
      }
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
- Modify: `server/src/curator/rules.ts` / `rules.test.ts`
- Modify: `server/src/curator/ruleRoutes.ts` / `ruleRoutes.test.ts`
- Modify: `server/src/curator/routes.ts`(run-pass-2 的 matchAll 传子树)
- Modify: `server/src/curator/suggestions.ts`(它自己算"规则覆盖了哪些条目",算错会把归好的又建议一遍)

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

- [ ] **Step 4: 改 `ruleRoutes.ts`**

`:102` 的字段白名单加 `'tag'`:

```ts
    if (o.field !== 'title' && o.field !== 'intro' && o.field !== 'upper' && o.field !== 'tag') {
      return 'field 只能是 title / intro / upper / tag';
    }
```

`:226` 的试跑(`/api/rules/dry-run`)建 ctx:

```ts
    const ctx = { subtree: subtreeSets(db) };
    const matched = matchAll(items.map(toRuleItem), rules, ctx);
```

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

- [ ] **Step 6: 跑测试 + 提交**

Run: `cd server && npm test`
Expected: PASS

```bash
git add server/src/db/repo/rules.ts server/src/curator/rules.ts server/src/curator/rules.test.ts server/src/curator/ruleRoutes.ts server/src/curator/routes.ts
git commit -m "feat(rules): 第四字段 tag,选中即匹配整棵子树"
```

---

### Task 7: 夹子画像 + 离群标记 + 提体系换输入

**Files:**
- Create: `server/src/curator/folderProfile.ts` / `folderProfile.test.ts`
- Modify: `server/src/curator/classifier.ts`(`buildPass1Prompt` 加画像与规则)
- Modify: `server/src/curator/routes.ts`(run-pass-1 传画像)
- Modify: `server/src/http/routes/items.ts`(`/api/items/:id` 带标签)
- Modify: `server/src/curator/routes.ts`(`GET /api/workbench/folders/:id/items` 带标签)

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

opts 加 `profiles?: string` 与 `rules?: string`,在拼 prompt 时插到"用户现有的收藏夹"那块**下面**(比夹子名更靠前的实况):

```ts
  const parts = [
    `## 用户现有的收藏夹(${opts.existingFolders.length} 个)`,
    folders,
  ];
  // §9F C15:画像 = "这个夹子里**实际**是什么"。没有它,模型只能看名字猜 ——
  // §9C.0 那次事故(4 条 AI 教程被归进「黑神话」)就是这个猜造成的。
  if (opts.profiles) parts.push('', '### 每个夹子里实际是什么(按标签统计)', opts.profiles);
  if (opts.sample.length) parts.push('', `## 收藏样本(${opts.sample.length} 条,从整个收藏库里均衡抽取)`, opts.sample.map((i) => renderItem(i, 120, opts.tagNames.get(i.id))).join('\n\n'));
  if (opts.rules) parts.push('', '### 现有的归类规则', opts.rules);
  // …clusterNote / userConstraint / 收尾 照旧…
```

`runPass1` 的 opts 一并透传。`routes.ts` 的 `run-pass-1` 里:

```ts
        profiles: renderProfiles(buildFolderProfiles(db)),
        rules: listRules(db).map((r) => `${r.folderId}: ${renderConditions(r.conditions) || '(空)'}`).join('\n'),
```

- [ ] **Step 5: `/api/items/:id` 与工作台条目接口带标签**

`http/routes/items.ts` 的 `shapeItem` 保持原样(注释要求"出口形状单一口径"),**标签走同级字段**:

```ts
  app.get('/api/items/:id', async (req, reply) => {
    // …原有逻辑…
    return {
      item: shapeItem(row, favTime),
      folders: [...],                                  // 已有
      tags: itemTagIds(db, [id]).get(id) ?? [],        // §9F:这条挂的标签 id
      tagNames: tagNamesByItem(db).get(id) ?? [],      // 显示用
    };
  });
```

工作台那条(`curator/routes.ts:874`)同样加 `tagNames`,让展开夹子时能顺带显示。

- [ ] **Step 6: 跑测试 + 提交**

Run: `cd server && npm test`
Expected: PASS

```bash
git add server/src/curator/folderProfile.ts server/src/curator/folderProfile.test.ts server/src/curator/classifier.ts server/src/curator/routes.ts server/src/http/routes/items.ts
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

- [ ] **Step 5: `components/TagPanel.tsx`**

要点(照 `WorkFolderTree.tsx` 手写树 + `RulesPanel.tsx` 的状态处理):

```tsx
/**
 * 词库治理 —— 三层:顶上的"树的变化"清单、中间的树、底下的手动操作。
 *
 * 树是**手写**的(照 WorkFolderTree),不用 antd `Tree`:仓库里它零使用,
 * 而且现有树形 UI 自成一套样式(缩进 + 展开三角 + hover 操作),混用会打架。
 *
 * 这一页**不做自动整理** —— 整理在标注跑完时自动发生(§9F C10)。这里只有
 * "看它变成了什么"和"手动纠正"。
 */
export default function TagPanel() {
  const { data: tree, refresh: refreshTree } = useRequest(() => tagApi.tree(), { formatResult: rawResult });
  const { data: changes } = useRequest(() => tagApi.changes(), { formatResult: rawResult });
  const { modal } = AntApp.useApp();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  // …改名 inline input、合并目标选择、父节点选择…

  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError('');
    setBusy(true);
    try { await fn(); await refreshTree(); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  // …渲染:error 走 <Alert type="error" showIcon closable>…
  // …删除/合并走 modal.confirm,content 说清"会发生什么"…
}
```

节点的行内结构照 `WorkFolderTree.tsx:413-428` 的 `label + checkbox` 骨架改造成 `div + 展开三角 + 名字 + count + hover 操作`。**count 用 `<span className="num">`**。

- [ ] **Step 6: typecheck + build 门禁**

Run: `cd web && npm run typecheck`
Expected: 无输出(通过)

Run: `cd web && npm run build 2>&1 | tail -3`
Expected:输出含 `Compiled successfully`(**退出码恒为 1,不是失败**)

- [ ] **Step 7: 提交**

```bash
git add web/.umirc.ts web/src/layouts/index.tsx web/src/pages/tag.tsx web/src/components/TagPanel.tsx web/src/api.ts web/src/types.ts
git commit -m "feat(web): 「标签」治理页 —— 手写树 + 变化清单 + 手动合并/改名/删"
```

---

### Task 9: 前端「浏览」按标签看收藏

**Files:**
- Create: `web/src/pages/browse.tsx` / `web/src/components/BrowsePanel.tsx`
- Modify: `web/src/api.ts` / `web/src/types.ts` / `web/src/components/ContextPane.tsx`
- Modify: `server/src/curator/tagRoutes.ts`(加 `GET /api/tags/:id/items`)

**Interfaces:**
- Produces: `GET /api/tags/:id/items?page&pageSize` → `{ items; total; foldersOf: Record<string, {id,title}[]> }`

- [ ] **Step 1: 写失败测试(服务端)**

```ts
  it('GET /api/tags/:id/items 回条目 + 每条散在哪些夹子', async () => {
    const { app, db } = makeApp();
    const t = ensureTag(db, '露营', null);
    // …塞 2 条条目 + 关联 + 工作副本归属…
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
    };
  });
```

- [ ] **Step 4: 前端页 + 面板 + 详情栏显示标签**

`pages/browse.tsx` 照 `pages/tag.tsx` 的壳。`BrowsePanel.tsx` 的要点:

```tsx
/**
 * 按标签看收藏 —— 复用 ItemGrid(条目渲染只有一套口径),只在上面加一层
 * 标签选择 + 归属提示。
 *
 * 选中的标签用 `useSearchParams` 存,这样"从「标签」页点一个词跳过来"是同一个路径。
 */
export default function BrowsePanel() {
  const [params, setParams] = useSearchParams();
  const tagId = Number(params.get('tag')) || null;
  const [page, setPage] = useState(1);
  const { data: tree } = useRequest(() => tagApi.tree(), { formatResult: rawResult });
  const { data } = useRequest(
    () => (tagId ? tagApi.items(tagId, page) : Promise.resolve({ items: [], total: 0, foldersOf: {} })),
    { refreshDeps: [tagId, page], formatResult: rawResult },
  );
  // 左:词库树(复用 TagPanel 的树渲染,抽成 components/TagTree.tsx 两页共用)
  // 右:ItemGrid + 每张卡片下的归属 chips(foldersOf[item.id])
}
```

**`TagPanel` 与 `BrowsePanel` 共用的树渲染抽成 `components/TagTree.tsx`** —— 两页都要树,分两份写迟早分叉(和 `shapeItem` 注释里那条同理)。

`ContextPane.tsx` 的 `dl` 表格加一行。**props 加一个 `tags`,不由组件自己请求** —— 在 `ContextPane` 里发请求会让详情栏每选一条都打一次接口:

```tsx
export default function ContextPane({ item, tags }: { item: Item | null; tags: string[] }) {
  // …原有渲染…
  // <dl> 里插:
  //   <dt>标签</dt><dd>{tags.length ? tags.join(' · ') : '—'}</dd>
```

`tags` 的值:**从筛选结果里拿**。`BrowsePanel` 调 `tagApi.items(tagId)` 时已经知道当前标签集合,但一条视频可能还挂着别的词 —— 这正是"看它散在哪些夹子"的同类需求。所以 Task 9 Step 3 的服务端接口**再加一个同级字段 `tagsOf: Record<string, string[]>`**,和 `foldersOf` 一次查完:

```ts
      // 和 foldersOf 同一批查完 —— 详情栏要显示"这条挂的全部标签",
      // 只显示当前筛的那个词会让人以为它没有别的标签
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

返回值加 `tagsOf`;`GET /api/items/:id`(Task 7 已改)那条路上,`Index` 页的 `ContextPane` 用它自己的 `GET /api/items/:id` 结果里的 `tagNames`。

> **index.tsx 也要传 `tags`** —— 它用了 `ContextPane`。给它一个默认 `tags={item?.tagNames ?? []}`;`Item` 类型加一个可选 `tagNames?: string[]`,由 `GET /api/items/:id` 填(列表接口不带,那里不需要)。

- [ ] **Step 5: typecheck + build 门禁**

Run: `cd web && npm run typecheck && npm run build 2>&1 | tail -3`
Expected:typecheck 通过;build 输出含 `Compiled successfully`

- [ ] **Step 6: 全量测试 + 提交**

Run: `cd server && npm test`
Expected: PASS

```bash
git add server/src/curator/tagRoutes.ts server/src/curator/tagRoutes.test.ts web/src/pages/browse.tsx web/src/components/BrowsePanel.tsx web/src/components/TagTree.tsx web/src/components/ContextPane.tsx web/src/api.ts web/src/types.ts
git commit -m "feat(web): 「浏览」按标签看收藏(子树匹配)+ 详情栏显示标签"
```

---

## 收尾检查

全部任务完成后:

- [ ] `cd server && npm test` 全绿
- [ ] `cd server && npm run typecheck` 干净
- [ ] `cd web && npm run typecheck` 干净;`npm run build` 输出含 `Compiled successfully`
- [ ] `grep -rn "ai_tags" server/src --include=*.ts | grep -v test` **只剩 schema.ts 的 DDL 和注释** —— 生产代码里没有任何读写
- [ ] 真机跑一轮:点「AI 标注」→ 看「标签」页长出树 → 检查「树的变化」清单是否合理 → 在「浏览」页点一个词能捞出视频
