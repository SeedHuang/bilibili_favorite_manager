# M4c 规则(整理的核心资产)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「规则」成为可视、可改、可执行的本地资产 —— 归类时规则先跑(0 token、可复现),AI 只处理规则没覆盖的语义边界;而且 AI 发现体系不合理时**给你建议**而不是硬塞。

**Architecture:** 规则是**结构化可执行**的(`{字段, 关键词[]}`,条件之间 OR),挂在工作副本的夹子上(新表 `work_folder_rules`,不 ALTER 已有表)。归类流程改成两段:**规则匹配(纯函数、0 token)→ 剩下的才给 AI**。AI 多一个通道:**规则建议**,而且每条建议必须**自证**(附上它声称会命中的条目 id,服务端当场跑匹配验证,验不过就丢)。

**Tech Stack:** TypeScript ^5.9.3(ESM)、better-sqlite3 ^12.11.1、Fastify 5、vitest 3、@umijs/max 4.7 + antd 5 + lucide-react

**Spec:** `docs/superpowers/specs/m4c-folder-rules.md`(§9C,冲突时以它为准)。它**取代** `m4b-curator-workbench.md` §9B.4 里"从工作副本取体系"那一段 —— 现在取的**不只是夹子名,还有规则**。
另需读:`shared-data-model.md`(§5)、`shared-testing.md`(§12)、`shared-frontend.md`(§11.2 颜色语义)。

## Global Constraints

- Node 22.12、TypeScript ^5.9.3、better-sqlite3 ^12.11.1、ESM(**类型一律 `import type`**)
- `strict` + `noUncheckedIndexedAccess`(下标访问要 `!` 或判空)
- 依赖方向:`http → curator → db / logger`。`db/` 不许 import `curator/`
- 注释写中文,解释"为什么";commit trailer **严格** `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- **规则只能写 `work_folder_rules`**;快照(`folders` / `folder_items`)一行不碰(spec §9C.6 约束 1)
- **AI 产生的规则建议必须过 `validateSuggestion` 才能入库** —— 没验过的连"待采纳"都不给(spec §9C.6 约束 2)
- **锁定的夹子不能加规则**(和改名/删除/移动并删除同一条规则,spec §9C.6 约束 4)
- **规则变更不进 `operation_log`**:§9B.3 的 `OpKind` 是"一次定全"的枚举(原文:「以后加功能不该改这张表」),而 §9C 只要求规则的 `updated_at` 和 `origin` —— 两者都在规则表自己身上。这是一条**明确决定,不是遗漏**
- 测试**不调真实 API**,LLM 一律 mock
- 每个任务收尾跑:`npm test -w server` 全绿;涉及前端时再加 `cd web && npm run typecheck && npx max build`
- **全局测试与 typecheck 必须串行跑**,不要并行 —— 套件里有一条既有的时序敏感测试(`bilibili/rateLimiter.test.ts`),CPU 争抢时会随机红

---

## 先读这段:这个仓库现在的样子

一个**本地 Web 应用**,把 bilibili 收藏用 AI 整理后写回。四个概念要分清:

| | 是什么 | 谁能写 |
|---|---|---|
| **快照** `folders` / `folder_items` | B站 现在的样子 | 只有 sync |
| **工作副本** `work_folders` / `work_folder_items` | 你要改成什么样 | 只有 `curator/workbench.ts` 里的编辑动作 |
| **操作日志** `operation_log` | 一次操作一行(记决策,不记数据变更) | `db/repo/operations.ts` |
| **规则**(本计划新增) | 谁该进哪个夹子的判据 | 你(spec §9C.6 之外的路径)/ AI(过验证后) |

```
server/src/
├─ db/
│  ├─ schema.ts              全部 DDL(一个模板字符串 SCHEMA_SQL,末尾反引号之前追加)
│  └─ repo/
│     ├─ workbench.ts        工作副本:克隆 / 查 / 清空
│     ├─ items.ts            ItemRow(蛇形字段)+ upsertItem / linkFolderItem / getItem
│     ├─ folders.ts          FolderRow + listFolders / isLockedFolder
│     ├─ operations.ts       logOperation / listOperations / OpKind / OpActor
│     └─ rules.ts            ← 本计划新建
├─ curator/
│  ├─ workbench.ts           编辑动作(改名/合并/移动/…),每个都记日志
│  ├─ rules.ts               ← 本计划新建:匹配引擎 + 建议验证(纯函数)
│  ├─ ruleRoutes.ts          ← 本计划新建:/api/rules/* 路由
│  ├─ suggestions.ts         ← 本计划新建:规则建议那次 LLM 调用
│  ├─ classifier.ts          Pass 1 / Pass 2 / 匹配收窄 / prompt 组装
│  ├─ chat.ts                聊天流 + 上下文(renderStructure 在这里)
│  └─ routes.ts              /api/curator/* 与 /api/workbench/* 全部路由
├─ llm/                      config(readLlmSettings)/ registry(ModelMeta)/ context(batchSize)/ provider
└─ http/index.ts             createServer,把各 registerXxxRoutes 组装起来
web/src/
├─ api.ts                    workbenchApi / curatorApi / llmApi(本计划加 rulesApi)
├─ types.ts                  前端类型
├─ pages/{index,curator,rules,auth}.tsx
├─ components/{WorkFolderTree,RulesPanel,ChatDrawer,…}.tsx
└─ layouts/index.tsx         顶栏 4 tab(总览/整理/规则/授权)—— **已经就位,不用改**
```

**几件已经就位、别重复做的事**:

- `/rules` 路由(`web/.umirc.ts:11`)和顶栏「规则」tab(`web/src/layouts/index.tsx:19`)都在了。本计划不动它们。
- `RulesPanel.tsx` 现在是**只有假数据的界面原型**(commit `437f92d`)。T11 整体替换它。
- `curator/keyword.ts` 的 `DEFAULT_RULES` **保留不动** —— 它是 Pass 1 的写死种子,和"用户/AI 维护的规则"是两回事(spec §9C.9)。同名不同物,别合并。

**跑测试的口径**:`npm test -w server`(vitest);单文件 `npm test -w server -- src/curator/rules.test.ts`。前端没有测试框架,`npm run typecheck` 是唯一可跑的验证。

---

### Task 1: 规则表 + 仓储

**Files:**
- Modify: `server/src/db/schema.ts`(在**末尾反引号之前**追加,即所有现有 DDL 之后)
- Create: `server/src/db/repo/rules.ts`
- Test: `server/src/db/repo/rules.test.ts`

**Interfaces:**
- Consumes: 无(只依赖 `better-sqlite3` 的 `Database` 类型)
- Produces:
  ```ts
  export type RuleField = 'title' | 'intro' | 'upper';
  export interface RuleCondition { field: RuleField; any: string[] }
  export type RuleOrigin = 'ai' | 'user';
  export interface FolderRule {
    folderId: number;
    conditions: RuleCondition[];
    origin: RuleOrigin;
    updatedAt: number;
  }
  function listRules(db): FolderRule[]
  function getRule(db, folderId: number): FolderRule | null
  function saveRule(db, folderId: number, conditions: RuleCondition[], origin: RuleOrigin): void
  function deleteRule(db, folderId: number): void
  ```

- [ ] **Step 1: 加表**

在 `server/src/db/schema.ts` 的**最后一个反引号之前**追加(紧接 `operation_log` 的 `);` 之后):

```sql
-- ── M4c 规则(2026-09-16)────────────────────────────────
-- 谁该进哪个夹子的判据。bilibili 有夹子但没有逻辑 —— 夹子只是个筐,
-- 谁进去全靠手。规则是本产品唯一比 B站 多的东西,所以它是核心资产。
--
-- 刻意**不做** ALTER TABLE work_folders ADD COLUMN:那张表已经存在,加列要走迁移;
-- 新建一张表用 CREATE TABLE IF NOT EXISTS 就够了,而且 FK 上的 ON DELETE CASCADE
-- 顺手解决"删夹子 / 一键还原时规则跟着走",不用写额外代码。
CREATE TABLE IF NOT EXISTS work_folder_rules (
  folder_id       INTEGER PRIMARY KEY REFERENCES work_folders(id) ON DELETE CASCADE,
  conditions_json TEXT NOT NULL,
  -- 'ai' | 'user' —— 谁写的。界面上一眼看出这是谁的主意(§11.2 颜色是信息)
  origin          TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

> `folder_id` 是 **PRIMARY KEY**,所以一个夹子只有一组条件 —— 那是刻意的:条件之间本来就是 OR(§9C.1 R3),再复杂就该归 AI。

- [ ] **Step 2: 写失败的测试**

`server/src/db/repo/rules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertFolder } from './folders.js';
import { upsertItem, linkFolderItem } from './items.js';
import { ensureWorkcopy, listWorkFolders, resetWorkcopy } from './workbench.js';
import { listRules, getRule, saveRule, deleteRule } from './rules.js';

/** 种一个快照 + 克隆出工作副本,返回工作夹子的 id */
function seeded() {
  const db = openDb(':memory:');
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 1 });
  upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
  linkFolderItem(db, 7, 'BV1', 1);
  ensureWorkcopy(db);
  const work = listWorkFolders(db)[0]!;
  return { db, folderId: work.id };
}

describe('规则仓储', () => {
  it('没存过时 listRules 是空的(克隆不继承规则)', () => {
    const { db } = seeded();
    expect(listRules(db)).toEqual([]);
  });

  it('存了能读回完整结构', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['Python', 'JS'] }], 'user');

    const r = getRule(db, folderId)!;
    expect(r.folderId).toBe(folderId);
    expect(r.conditions).toEqual([{ field: 'title', any: ['Python', 'JS'] }]);
    expect(r.origin).toBe('user');
    expect(r.updatedAt).toBeGreaterThan(0);
  });

  it('一个夹子只有一组规则 —— 再存是覆盖不是追加', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['A'] }], 'user');
    saveRule(db, folderId, [{ field: 'intro', any: ['B'] }], 'ai');

    expect(listRules(db)).toHaveLength(1);
    expect(getRule(db, folderId)!.conditions[0]!.field).toBe('intro');
    // origin 跟着最后一次写的人走 —— 否则界面上的 🤖/✎ 会撒谎
    expect(getRule(db, folderId)!.origin).toBe('ai');
  });

  it('删掉规则后读回来是 null,列表里也不留空行', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['A'] }], 'user');
    deleteRule(db, folderId);

    expect(getRule(db, folderId)).toBeNull();
    expect(listRules(db)).toEqual([]);
  });

  it('删掉规则不碰夹子本身', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['A'] }], 'user');
    deleteRule(db, folderId);
    expect(listWorkFolders(db).some((f) => f.id === folderId)).toBe(true);
  });

  // 一键还原是"清空 work_folders" → CASCADE 应该把规则一起带走。
  // 不带走的话会留下孤儿规则,"命中几条"就开始骗人(spec §9C.6 约束 5)。
  it('一键还原 → 规则跟着走(CASCADE)', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['A'] }], 'user');
    resetWorkcopy(db);
    expect(listRules(db)).toEqual([]);
  });

  it('删夹子 → 它的规则跟着走(CASCADE)', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['A'] }], 'user');
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(folderId);
    expect(listRules(db)).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -w server -- src/db/repo/rules.test.ts`
Expected: FAIL —— `Cannot find module './rules.js'`

- [ ] **Step 4: 实现**

`server/src/db/repo/rules.ts`:

```ts
import type Database from 'better-sqlite3';

/**
 * 规则 —— 谁该进哪个夹子的判据。
 *
 * **结构化可执行**,不是一段自由文本:能执行才叫资产,否则它只是 prompt。
 * 而且只有能执行才算得出「命中几条」—— 那是调规则时唯一有用的反馈。
 *
 * 字段只留三个(不加正则、不加与或非、不加权重):表达力换"你一眼看懂它在干什么"。
 */
export type RuleField = 'title' | 'intro' | 'upper';

/** 一条条件 = "某字段里命中任一关键词"。条件之间 OR */
export interface RuleCondition {
  field: RuleField;
  any: string[];
}

/** 谁写的 —— 界面上一眼看出这是谁的主意 */
export type RuleOrigin = 'ai' | 'user';

export interface FolderRule {
  folderId: number;
  conditions: RuleCondition[];
  origin: RuleOrigin;
  updatedAt: number;
}

interface RuleRow {
  folder_id: number;
  conditions_json: string;
  origin: string;
  updated_at: number;
}

function shape(r: RuleRow): FolderRule {
  return {
    folderId: r.folder_id,
    // 坏 JSON 直接抛 —— 静默当成"没有规则"会让归类悄悄少一层依据
    conditions: JSON.parse(r.conditions_json) as RuleCondition[],
    origin: r.origin === 'ai' ? 'ai' : 'user',
    updatedAt: r.updated_at,
  };
}

export function listRules(db: Database.Database): FolderRule[] {
  return (db.prepare(`SELECT * FROM work_folder_rules ORDER BY folder_id`).all() as RuleRow[]).map(
    shape,
  );
}

export function getRule(db: Database.Database, folderId: number): FolderRule | null {
  const row = db.prepare(`SELECT * FROM work_folder_rules WHERE folder_id = ?`).get(folderId) as
    | RuleRow
    | undefined;
  return row ? shape(row) : null;
}

/** 存规则。同一夹子**覆盖**(一个夹子一组条件 —— 条件之间本来就是 OR) */
export function saveRule(
  db: Database.Database,
  folderId: number,
  conditions: RuleCondition[],
  origin: RuleOrigin,
): void {
  db.prepare(
    `INSERT INTO work_folder_rules (folder_id, conditions_json, origin, updated_at)
     VALUES (@folderId, @conditions, @origin, @updatedAt)
     ON CONFLICT(folder_id) DO UPDATE SET
       conditions_json = excluded.conditions_json,
       origin          = excluded.origin,
       updated_at      = excluded.updated_at`,
  ).run({
    folderId,
    conditions: JSON.stringify(conditions),
    origin,
    updatedAt: Date.now(),
  });
}

export function deleteRule(db: Database.Database, folderId: number): void {
  db.prepare(`DELETE FROM work_folder_rules WHERE folder_id = ?`).run(folderId);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -w server -- src/db/repo/rules.test.ts`
Expected: PASS(7 tests)

- [ ] **Step 6: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/db/schema.ts server/src/db/repo/rules.ts server/src/db/repo/rules.test.ts
git commit -m "feat(db): 规则表 + 仓储 —— 整理的核心资产

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 匹配引擎(纯函数)

**Files:**
- Create: `server/src/curator/rules.ts`
- Test: `server/src/curator/rules.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FolderRule` / `RuleCondition` / `RuleField`
- Produces:
  ```ts
  export interface RuleItem { id: string; title: string; intro?: string | null; upperName?: string | null }
  export interface RuleHitToken { field: RuleField; token: string }
  export interface RuleHit { folderId: number; tokens: RuleHitToken[] }
  function matchItem(item: RuleItem, rules: readonly FolderRule[]): RuleHit[]
  function matchAll(items: readonly RuleItem[], rules: readonly FolderRule[]): Map<string, RuleHit[]>
  function renderConditions(conditions: readonly RuleCondition[]): string
  ```

- [ ] **Step 1: 写失败的测试**

`server/src/curator/rules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchItem, matchAll, renderConditions, type RuleItem } from './rules.js';
import type { FolderRule } from '../db/repo/rules.js';

const item = (p: Partial<RuleItem>): RuleItem => ({
  id: 'BV1', title: '', intro: null, upperName: null, ...p,
});

const rule = (folderId: number, conditions: FolderRule['conditions']): FolderRule => ({
  folderId, conditions, origin: 'user', updatedAt: 0,
});

describe('matchItem', () => {
  it('标题命中', () => {
    const hits = matchItem(item({ title: 'Python 从入门到精通' }), [
      rule(42, [{ field: 'title', any: ['Python'] }]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.folderId).toBe(42);
    expect(hits[0]!.tokens).toEqual([{ field: 'title', token: 'Python' }]);
  });

  it('简介命中', () => {
    const hits = matchItem(item({ intro: '本视频讲算法' }), [
      rule(42, [{ field: 'intro', any: ['算法'] }]),
    ]);
    expect(hits[0]!.tokens[0]).toEqual({ field: 'intro', token: '算法' });
  });

  it('UP 名命中', () => {
    const hits = matchItem(item({ upperName: '某UP' }), [
      rule(42, [{ field: 'upper', any: ['某UP'] }]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.tokens[0]).toEqual({ field: 'upper', token: '某UP' });
  });

  it('大小写不敏感', () => {
    const r = [rule(42, [{ field: 'title', any: ['Python'] }])];
    expect(matchItem(item({ title: 'python 教程' }), r)).toHaveLength(1);
    expect(matchItem(item({ title: 'PYTHON 教程' }), r)).toHaveLength(1);
  });

  it('字段看错了就不命中 —— 标题里的词不该被简介的规则捞走', () => {
    const hits = matchItem(item({ title: '算法' }), [rule(42, [{ field: 'intro', any: ['算法'] }])]);
    expect(hits).toEqual([]);
  });

  // R4:一条条目同时命中多个夹子 → 都归。猜错就是悄悄少一份归属
  it('命中两个夹子 → 两条都返回', () => {
    const hits = matchItem(item({ title: 'Python 算法' }), [
      rule(42, [{ field: 'title', any: ['Python'] }]),
      rule(43, [{ field: 'title', any: ['算法'] }]),
    ]);
    expect(hits.map((h) => h.folderId).sort()).toEqual([42, 43]);
  });

  // 同一个夹子里多个条件都命中 → 只出一条(不然界面上会重复计数)
  it('同一个夹子里多个条件命中 → 只出一条,但 tokens 都带上', () => {
    const hits = matchItem(item({ title: 'Python', intro: '讲算法' }), [
      rule(42, [
        { field: 'title', any: ['Python'] },
        { field: 'intro', any: ['算法'] },
      ]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.tokens).toHaveLength(2);
  });

  it('空关键词列表不命中(半写的规则不该捞走任何东西)', () => {
    expect(
      matchItem(item({ title: 'Python' }), [rule(42, [{ field: 'title', any: [] }])]),
    ).toEqual([]);
  });

  it('条件列表为空不命中', () => {
    expect(matchItem(item({ title: 'Python' }), [rule(42, [])])).toEqual([]);
  });

  it('intro / upperName 为 null 不炸', () => {
    expect(() =>
      matchItem(item({ title: 'x' }), [rule(42, [{ field: 'intro', any: ['y'] }])]),
    ).not.toThrow();
  });
});

describe('matchAll', () => {
  it('按 itemId 归组,没命中的条目根本不进 Map', () => {
    const items = [item({ id: 'BV1', title: 'Python' }), item({ id: 'BV2', title: '别的东西' })];
    const got = matchAll(items, [rule(42, [{ field: 'title', any: ['Python'] }])]);

    expect(got.get('BV1')).toHaveLength(1);
    expect(got.has('BV2')).toBe(false);
  });
});

describe('renderConditions', () => {
  // 这句话会原样进 Pass 2 的 prompt(§9C.3 ②),也会出现在聊天上下文里
  it('渲染成一句给模型看的话', () => {
    expect(
      renderConditions([
        { field: 'title', any: ['Python', 'JS'] },
        { field: 'intro', any: ['算法'] },
      ]),
    ).toBe('标题含 Python/JS;或 简介含 算法');
  });

  it('空条件渲染成空串(调用方据此不写那一行)', () => {
    expect(renderConditions([])).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/rules.test.ts`
Expected: FAIL —— `Cannot find module './rules.js'`

- [ ] **Step 3: 实现**

`server/src/curator/rules.ts`:

```ts
import type { FolderRule, RuleCondition, RuleField } from '../db/repo/rules.js';

/**
 * 规则匹配 —— **纯函数,无 IO**。
 *
 * 它是归类的第一段:规则命中的条目 0 token、毫秒级归位,而且是**确定性的**
 * (改一条规则、重跑、结果可预测),AI 只处理规则没覆盖的语义边界。
 *
 * 命中即成员:一条条目可以同时命中多个夹子,那就都归(R4)。
 * B站 本来就支持一条视频在多个夹子里,所以"命中多个"不是冲突,是事实。
 */

export interface RuleItem {
  id: string;
  title: string;
  intro?: string | null;
  upperName?: string | null;
}

export interface RuleHitToken {
  field: RuleField;
  token: string;
}

export interface RuleHit {
  folderId: number;
  /** 命中的条件,可能多条(同一个夹子的多个条件都命中时) */
  tokens: RuleHitToken[];
}

const FIELD_LABEL: Record<RuleField, string> = { title: '标题', intro: '简介', upper: 'UP 名' };

/** 一条条目命中哪些夹子的规则。**可多个** —— 命中即成员 */
export function matchItem(item: RuleItem, rules: readonly FolderRule[]): RuleHit[] {
  const text: Record<RuleField, string> = {
    title: (item.title ?? '').toLowerCase(),
    intro: (item.intro ?? '').toLowerCase(),
    upper: (item.upperName ?? '').toLowerCase(),
  };

  const hits: RuleHit[] = [];

  for (const rule of rules) {
    const tokens: RuleHitToken[] = [];
    for (const cond of rule.conditions) {
      const hay = text[cond.field];
      if (!hay) continue;
      for (const kw of cond.any) {
        // 空关键词会匹配一切 —— 半写的规则不该捞走任何东西
        if (!kw) continue;
        if (hay.includes(kw.toLowerCase())) tokens.push({ field: cond.field, token: kw });
      }
    }
    // 同一个夹子的多个条件都命中 → 只出一条,但 tokens 都带上
    if (tokens.length > 0) hits.push({ folderId: rule.folderId, tokens });
  }

  return hits;
}

/**
 * 批量版本。**没命中的条目根本不进 Map** —— 调用方据此算"剩下多少要给 AI"(§9C.3 ②)
 * 和"规则覆盖了多少条"(§9C.4 试跑)。
 */
export function matchAll(
  items: readonly RuleItem[],
  rules: readonly FolderRule[],
): Map<string, RuleHit[]> {
  const out = new Map<string, RuleHit[]>();
  for (const item of items) {
    const hits = matchItem(item, rules);
    if (hits.length > 0) out.set(item.id, hits);
  }
  return out;
}

/** 把一组条件渲染成给模型看的一句话(空条件 → 空串,调用方据此不写那一行) */
export function renderConditions(conditions: readonly RuleCondition[]): string {
  return conditions
    .map((c) => `${FIELD_LABEL[c.field]}含 ${c.any.join('/')}`)
    .join(';或 ');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/rules.test.ts`
Expected: PASS(13 tests)

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/rules.ts server/src/curator/rules.test.ts
git commit -m "feat(curator): 规则匹配引擎(纯函数,命中即成员)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 建议的验证与合并(防幻觉)

**Files:**
- Modify: `server/src/curator/rules.ts`(追加)
- Modify: `server/src/curator/rules.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 `RuleField`;Task 2 的 `matchItem` / `RuleItem`
- Produces:
  ```ts
  export interface RawSuggestion {
    folderTempId?: unknown; field?: unknown; any?: unknown;
    because?: unknown; evidenceItemIds?: unknown;
  }
  export interface ValidSuggestion {
    folderId: number; field: RuleField; any: string[];
    because: string; evidenceItemIds: string[];
  }
  /** 一条建议过不了任一校验 → null(丢掉,不入库) */
  function validateSuggestion(raw: RawSuggestion, ctx: SuggestionCtx): ValidSuggestion | null
  function validateSuggestions(raw: unknown, ctx: SuggestionCtx): ValidSuggestion[]
  /** 按 夹子 + 字段 + 排序后的词表 去重,并把各批的证据并起来 */
  function mergeSuggestions(list: readonly ValidSuggestion[]): ValidSuggestion[]
  export interface SuggestionCtx {
    validFolderIds: ReadonlySet<number>;
    itemsById: ReadonlyMap<string, RuleItem>;
  }
  ```

**为什么有这个任务**:真机验证过,模型会编。它说"这些词管用"时必须**当场跑一遍匹配证明**,否则就是幻觉。这和 §9.1.1 拦 Pass 1 幻觉是同一个思路(spec §9C.5 R7 原文自述)。

- [ ] **Step 1: 写失败的测试**

追加到 `server/src/curator/rules.test.ts`:

```ts
// ── 建议的自证与合并(spec §9C.5 R7)─────────────────────
import { validateSuggestion, validateSuggestions, mergeSuggestions } from './rules.js';

describe('validateSuggestion', () => {
  const items = new Map<string, RuleItem>([
    ['BV1', item({ id: 'BV1', title: 'Agent 入门到精通' })],
    ['BV2', item({ id: 'BV2', title: '今天天气不错' })],
  ]);
  const ctx = { validFolderIds: new Set([42]), itemsById: items };

  const good = {
    folderTempId: 42,
    field: 'title',
    any: ['Agent'],
    because: '这几条都是讲 Agent 的',
    evidenceItemIds: ['BV1'],
  };

  it('干净的建议能过', () => {
    const v = validateSuggestion(good, ctx)!;
    expect(v.folderId).toBe(42);
    expect(v.field).toBe('title');
    expect(v.any).toEqual(['Agent']);
    expect(v.because).toBe('这几条都是讲 Agent 的');
    expect(v.evidenceItemIds).toEqual(['BV1']);
  });

  it('folderTempId 是字符串也认(模型常把 id 吐成字符串)', () => {
    expect(validateSuggestion({ ...good, folderTempId: '42' }, ctx)).not.toBeNull();
  });

  it('引用不存在的夹子 → 丢掉', () => {
    expect(validateSuggestion({ ...good, folderTempId: 999 }, ctx)).toBeNull();
  });

  it('字段不是三个之一 → 丢掉', () => {
    expect(validateSuggestion({ ...good, field: '简介' }, ctx)).toBeNull();
  });

  it('关键词为空 / 全是空串与空白 → 丢掉', () => {
    expect(validateSuggestion({ ...good, any: [] }, ctx)).toBeNull();
    expect(validateSuggestion({ ...good, any: ['', '  '] }, ctx)).toBeNull();
  });

  it('关键词超过 20 个 → 截断(截断比丢整条宽厚,但不放行一堆噪音)', () => {
    const many = Array.from({ length: 30 }, (_, i) => `kw${i}`);
    const v = validateSuggestion({ ...good, any: many }, ctx)!;
    expect(v.any).toHaveLength(20);
  });

  // ★ 这条是关键:它编的词打不中它自己给的证据
  it('**词打不中它给的证据条目 → 丢掉**', () => {
    expect(validateSuggestion({ ...good, any: ['根本不存在'] }, ctx)).toBeNull();
  });

  it('证据条目有一半打不中 → 也丢掉(不给"部分正确"留宽容)', () => {
    expect(validateSuggestion({ ...good, evidenceItemIds: ['BV1', 'BV2'] }, ctx)).toBeNull();
  });

  it('没有证据条目 → 丢掉(无法自证的建议不收)', () => {
    expect(validateSuggestion({ ...good, evidenceItemIds: [] }, ctx)).toBeNull();
  });

  it('证据条目里有不存在的 id → 丢掉', () => {
    expect(validateSuggestion({ ...good, evidenceItemIds: ['BV1', 'BV999'] }, ctx)).toBeNull();
  });

  it('整条不是对象 → 丢掉', () => {
    expect(validateSuggestion(null as never, ctx)).toBeNull();
    expect(validateSuggestion('随便一句话' as never, ctx)).toBeNull();
  });

  it('because 缺了就空串,不因此丢建议', () => {
    const v = validateSuggestion({ ...good, because: undefined }, ctx)!;
    expect(v.because).toBe('');
  });
});

describe('validateSuggestions', () => {
  const ctx = {
    validFolderIds: new Set([42]),
    itemsById: new Map<string, RuleItem>([['BV1', item({ id: 'BV1', title: 'Agent 入门' })]]),
  };

  it('数组里好的留下、坏的丢掉', () => {
    const got = validateSuggestions(
      [
        { folderTempId: 42, field: 'title', any: ['Agent'], evidenceItemIds: ['BV1'] },
        { folderTempId: 999, field: 'title', any: ['x'], evidenceItemIds: ['BV1'] },
      ],
      ctx,
    );
    expect(got).toHaveLength(1);
  });

  it('不是数组 → 空数组(不是抛错)', () => {
    expect(validateSuggestions('坏东西', ctx)).toEqual([]);
    expect(validateSuggestions(null, ctx)).toEqual([]);
  });
});

describe('mergeSuggestions', () => {
  const s = (over: Partial<ValidSuggestion>): ValidSuggestion => ({
    folderId: 42, field: 'title', any: ['Agent'], because: 'b', evidenceItemIds: ['BV1'], ...over,
  });

  it('同一组词只留一条 —— 不同批看到同一类时不该列两遍', () => {
    const got = mergeSuggestions([s({ evidenceItemIds: ['BV1'] }), s({ evidenceItemIds: ['BV2'] })]);
    expect(got).toHaveLength(1);
  });

  // 证据更多 → 你更容易判断该不该采纳(spec §9C.5 c)
  it('证据并起来,依顺序不重不漏', () => {
    const got = mergeSuggestions([
      s({ evidenceItemIds: ['BV1'] }),
      s({ evidenceItemIds: ['BV2', 'BV1'] }),
    ]);
    expect(got[0]!.evidenceItemIds).toEqual(['BV1', 'BV2']);
  });

  it('词表顺序不同但内容相同 → 仍算同一条', () => {
    const got = mergeSuggestions([s({ any: ['B', 'A'] }), s({ any: ['A', 'B'] })]);
    expect(got).toHaveLength(1);
  });

  it('夹子或字段不同 → 是两条', () => {
    expect(mergeSuggestions([s({}), s({ folderId: 43 })])).toHaveLength(2);
    expect(mergeSuggestions([s({}), s({ field: 'intro' })])).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/rules.test.ts`
Expected: FAIL —— `validateSuggestion is not a function`

- [ ] **Step 3: 实现**

把 `server/src/curator/rules.ts` 顶部的 import 改成带上 `RuleField` 之外不需要新增的东西(`RuleField` 已经在),然后在文件**末尾**追加:

```ts
// ── 建议的自证(spec §9C.5 R7)─────────────────────────────

/** 模型原始输出 —— 全是 unknown,因为它是不可信输入 */
export interface RawSuggestion {
  folderTempId?: unknown;
  field?: unknown;
  any?: unknown;
  because?: unknown;
  evidenceItemIds?: unknown;
}

/** 过了自证的建议。形状与 spec §9C.5 的返回形状一一对应,少一层翻译 */
export interface ValidSuggestion {
  folderId: number;
  field: RuleField;
  any: string[];
  because: string;
  evidenceItemIds: string[];
}

export interface SuggestionCtx {
  validFolderIds: ReadonlySet<number>;
  /** 全库条目 —— 自证时要拿它当场跑匹配 */
  itemsById: ReadonlyMap<string, RuleItem>;
}

const VALID_FIELDS: readonly RuleField[] = ['title', 'intro', 'upper'];
/** 一条规则最多这么多词 —— 防模型塞一堆噪音把规则变垃圾 */
const MAX_KEYWORDS = 20;

/**
 * 验证一条 AI 建议。**过不了任一关就丢**。
 *
 * 最后那一关是关键:**它说"这些词管用"就必须真的管用** —— 拿它给的证据条目
 * 当场跑一遍匹配,打不中就是它编的。不给"部分正确"留宽容:一个词打不中,
 * 说明它没真在读数据,那另外几个词也不可信。
 */
export function validateSuggestion(
  raw: RawSuggestion,
  ctx: SuggestionCtx,
): ValidSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;

  // 模型常把数字 id 吐成字符串,两边都认
  const rawId = raw.folderTempId;
  const folderId = typeof rawId === 'number' ? rawId : Number(rawId);
  if (!Number.isInteger(folderId) || !ctx.validFolderIds.has(folderId)) return null;

  if (typeof raw.field !== 'string' || !VALID_FIELDS.includes(raw.field as RuleField)) return null;

  if (!Array.isArray(raw.any)) return null;
  const any = raw.any
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter((k) => k !== '')
    .slice(0, MAX_KEYWORDS);
  if (any.length === 0) return null;

  if (!Array.isArray(raw.evidenceItemIds) || raw.evidenceItemIds.length === 0) return null;
  const evidenceItemIds = raw.evidenceItemIds.filter((x): x is string => typeof x === 'string');
  if (evidenceItemIds.length === 0) return null;

  // ★ 自证:每个证据条目都必须被这组词命中
  const probe: FolderRule[] = [
    { folderId, conditions: [{ field: raw.field as RuleField, any }], origin: 'ai', updatedAt: 0 },
  ];
  for (const id of evidenceItemIds) {
    const item = ctx.itemsById.get(id);
    if (!item) return null; // 它引用了一条不存在的条目
    if (matchItem(item, probe).length === 0) return null; // 词打不中它自己给的证据 —— 那就是编的
  }

  return {
    folderId,
    field: raw.field as RuleField,
    any,
    because: typeof raw.because === 'string' ? raw.because : '',
    evidenceItemIds,
  };
}

export function validateSuggestions(raw: unknown, ctx: SuggestionCtx): ValidSuggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => validateSuggestion(r as RawSuggestion, ctx))
    .filter((v): v is ValidSuggestion => v !== null);
}

/**
 * 按 `夹子 + 字段 + 排序后的词表` 去重,并把各批的 `evidenceItemIds` 并起来。
 *
 * 不同批看到的是同一类条目时,合成一条**更强的**建议 —— 证据更多,
 * 你更容易判断该不该采纳(spec §9C.5 c)。
 */
export function mergeSuggestions(list: readonly ValidSuggestion[]): ValidSuggestion[] {
  const out = new Map<string, ValidSuggestion>();

  for (const s of list) {
    const key = `${s.folderId}|${s.field}|${[...s.any].sort().join(',')}`;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...s, evidenceItemIds: [...new Set(s.evidenceItemIds)] });
      continue;
    }
    // 保留先看到的那条(它的 because 也是先看到的),只把证据并进来
    prev.evidenceItemIds = [...new Set([...prev.evidenceItemIds, ...s.evidenceItemIds])];
  }

  return [...out.values()];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/rules.test.ts`
Expected: PASS(26 tests)

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/rules.ts server/src/curator/rules.test.ts
git commit -m "feat(curator): AI 规则建议必须自证 —— 词打不中它给的证据就丢掉

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `apply` 支持一条条目归进多个夹子(都归的最后一公里)

**Files:**
- Modify: `server/src/curator/workbench.ts`(追加 `assignItems`)
- Modify: `server/src/curator/routes.ts`(`apply` 路由改用它)
- Test: `server/src/curator/workbench.test.ts`(追加)、`server/src/curator/routes.test.ts`(追加)

**Interfaces:**
- Consumes: 同文件私有的 `workFolderOrThrow`;`ensureWorkcopy` / `listWorkFolders`(`db/repo/workbench.ts`);`logOperation` / `OpActor`;`Actor` / `USER`(本文件)
- Produces:
  ```ts
  /** 把这批条目从**所有**当前夹子里拿走一次,然后加进 toFolderIds 里的每一个(一条日志) */
  function assignItems(
    db, itemIds: readonly string[], toFolderIds: readonly number[], who?: Actor,
  ): { moved: number }
  ```

**为什么必须做**:`apply` 现在是**按夹子**调 `moveItems`,而 `moveItems` 会先
`DELETE FROM work_folder_items WHERE item_id = ?`(不带 `folder_id` 条件)再插入 —— 同一条条目被指派到两个夹子时,**第二次会把第一次删掉**,最后只剩一个。而 R4 说规则命中多个夹子应该都归。不做这一步,"都归"会在最后一公里静默失效。

- [ ] **Step 1: 写失败的测试**

在 `server/src/curator/workbench.test.ts` 顶部的 `./workbench.js` import 里加上 `assignItems`(它现在是 `renameFolder, createFolder, deleteFolder, mergeFolders, moveItems, addItems, removeItems, resetWorkbench`),然后追加:

```ts
// ── 一条条目归进多个夹子(R4 的最后一公里)──────────────
describe('assignItems', () => {
  it('加进多个夹子 —— 全都在,一个不少', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    const b = originIdOf(db, 8);

    const r = assignItems(db, ['BV2'], [a, b]);

    expect(r.moved).toBe(1);
    expect(workItemIds(db, a)).toContain('BV2');
    expect(workItemIds(db, b)).toContain('BV2');
  });

  it('先从原处拿走 —— 不是"再加一份"', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    const b = originIdOf(db, 8);
    // BV2 本来只在 7 里(seed 里 linkFolderItem(7,'BV2'))

    assignItems(db, ['BV2'], [b]);

    expect(workItemIds(db, a)).not.toContain('BV2'); // 从 7 拿走了
    expect(workItemIds(db, b)).toContain('BV2');     // 进了 8
  });

  it('**一次操作一条日志**,不是每个夹子一条', () => {
    const db = seeded();
    assignItems(db, ['BV2'], [originIdOf(db, 7), originIdOf(db, 8)]);
    expect(listOperations(db)).toHaveLength(1);
  });

  it('空目标 = 把这批条目从所有夹子里拿走(等于移出)', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    assignItems(db, ['BV2'], []);
    expect(workItemIds(db, a)).not.toContain('BV2');
  });

  it('空条目数组什么都不做(不克隆、不记日志)', () => {
    const db = seeded();
    assignItems(db, [], [originIdOf(db, 7)]);
    expect(listOperations(db)).toHaveLength(0);
  });

  it('目标夹子不存在 → 抛错,且什么都不改', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    expect(() => assignItems(db, ['BV2'], [a, 999])).toThrow(/没有夹子/);
    expect(workItemIds(db, a)).toContain('BV2'); // 没动
  });
});
```

> `seeded()` 种了 4 个夹子(7=深度学习 / 8=不常用 / 9=默认收藏夹)和 4 条条目,其中 `BV2` 只在夹子 7 里。`originIdOf(db, snapshotId)` 是文件里已有的 helper(快照 id → 工作副本夹子 id)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/workbench.test.ts`
Expected: FAIL —— `assignItems is not a function`

- [ ] **Step 3: 实现**

追加到 `server/src/curator/workbench.ts`(放在 `moveItems` 之后):

```ts
/**
 * 把这批条目从**所有**当前夹子里拿走一次,然后加进 `toFolderIds` 里的每一个。
 *
 * 为什么不复用 `moveItems` 循环:**`moveItems` 会先删光这个条目的所有归属再插入**,
 * 所以对同一条条目调两次(归进 A、再归进 B)会**把 A 那次删掉** ——
 * "一条条目同时在多个夹子里"(R4)会在最后一公里静默失效。
 *
 * `toFolderIds` 传空数组 = 把这批条目从所有夹子里拿走(等于移出,落「未归类」)。
 */
export function assignItems(
  db: Database.Database,
  itemIds: readonly string[],
  toFolderIds: readonly number[],
  who: Actor = USER,
): { moved: number } {
  // 空数组必须在 ensureWorkcopy **之前**早返回:否则"归 0 条"会把工作副本克隆出来
  // —— 那是一次真实的状态变更 —— 却不记任何日志(和 moveItems 同一条契约)
  if (itemIds.length === 0) return { moved: 0 };
  ensureWorkcopy(db);

  const targets = [...new Set(toFolderIds)];
  // 目标先全部校验再动数据 —— 有一个不存在就整个不执行,不留半个改动的副本
  const names = targets.map((id) => workFolderOrThrow(db, id).name);

  const ids = [...new Set(itemIds)];
  db.transaction(() => {
    const clear = db.prepare(`DELETE FROM work_folder_items WHERE item_id = ?`);
    const add = db.prepare(
      `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
    );
    for (const itemId of ids) {
      clear.run(itemId);
      for (const folderId of targets) add.run(folderId, itemId);
    }
  })();

  logOperation(db, {
    kind: 'move_items',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: targets.length
      ? `把 ${ids.length} 条归进「${names.join('」「')}」`
      : `把 ${ids.length} 条移出所有夹子(变成未归类)`,
    detail: { itemIds: ids, toFolderIds: targets },
  });

  return { moved: ids.length };
}
```

- [ ] **Step 4: 改 `apply` 路由用它**

在 `server/src/curator/routes.ts` 的 `/api/curator/sessions/:id/apply` 里,把"按夹子分组调 `moveItems`"那段:

```ts
      const byFolder = new Map<number, string[]>();
      // AI 拿不准的条目(folderTempId === null)**原地不动** —— 这些必须单列出来。
      // 生成侧的提示词明确写着"拿不准就填 null",整批失败也是 null,所以这是常态
      // 而不是异常。既不算 applied 也不算 skipped 的话,接口会回一句"全部成功",
      // 而用户被告知归类完成、实际有一批还停在手工整理前的归属上,完全不知道。
      let unclassified = 0;
      for (const a of stored.assignments) {
        if (a.folderTempId === null) {
          unclassified += 1;
          continue;
        }
        const folderId = Number(a.folderTempId);
        if (!Number.isInteger(folderId)) continue; // 编出来的 id 丢掉
        const list = byFolder.get(folderId);
        if (list) list.push(a.itemId);
        else byFolder.set(folderId, [a.itemId]);
      }

      let applied = 0;
      let skipped = 0;
      for (const [folderId, itemIds] of byFolder) {
        try {
          moveItems(db, itemIds, folderId, { actor: 'ai', sessionId });
          applied += itemIds.length;
        } catch {
          // 那个夹子可能在你手改时被删了 —— 跳过它,其余照常
          skipped += itemIds.length;
        }
      }
```

换成:

```ts
      // **按"目标夹子集合"分组,而不是按单个夹子** —— 一条条目可以同时归进多个夹子
      // (规则命中的都归,R4)。按单个夹子分组会把它拆成多次调用,而每次 assignItems
      // 都会先清空该条目的归属,后一次会把前一次删掉。
      const targetOf = new Map<string, number[]>();
      // AI 拿不准的条目(folderTempId === null)**原地不动** —— 这些必须单列出来。
      // 生成侧的提示词明确写着"拿不准就填 null",整批失败也是 null,所以这是常态
      // 而不是异常。既不算 applied 也不算 skipped 的话,接口会回一句"全部成功",
      // 而用户被告知归类完成、实际有一批还停在手工整理前的归属上,完全不知道。
      let unclassified = 0;
      for (const a of stored.assignments) {
        if (a.folderTempId === null) {
          unclassified += 1;
          continue;
        }
        const folderId = Number(a.folderTempId);
        if (!Number.isInteger(folderId)) continue; // 编出来的 id 丢掉
        const list = targetOf.get(a.itemId);
        if (list) {
          if (!list.includes(folderId)) list.push(folderId);
        } else {
          targetOf.set(a.itemId, [folderId]);
        }
      }

      // 目标集合相同的条目合成一次调用 —— 一次操作一条日志
      const byTargetSet = new Map<string, string[]>();
      for (const [itemId, folderIds] of targetOf) {
        const key = [...folderIds].sort((x, y) => x - y).join(',');
        const list = byTargetSet.get(key);
        if (list) list.push(itemId);
        else byTargetSet.set(key, [itemId]);
      }

      let applied = 0;
      let skipped = 0;
      for (const [key, itemIds] of byTargetSet) {
        const folderIds = key.split(',').map(Number);
        try {
          assignItems(db, itemIds, folderIds, { actor: 'ai', sessionId });
          applied += itemIds.length;
        } catch {
          // 目标夹子可能在你手改时被删了 —— 跳过这批,其余照常
          skipped += itemIds.length;
        }
      }
```

并把同一条日志里的 `${byFolder.size} 个夹子` 改成 `${targetOf.size} 条条目`(下面那一行 `log.event` 里):

```ts
      log.event({
        level: 'info',
        category: 'llm',
        message: `应用 AI 结论:${applied} 条落到 ${targetOf.size} 条条目上,跳过 ${skipped} 条,` +
          `未归类 ${unclassified} 条`,
      });
```

最后在 `routes.ts` 顶部的 `from './workbench.js'` import 里加上 `assignItems`:

```ts
import {
  renameFolder, createFolder, deleteFolder, mergeFolders,
  moveItems, addItems, removeItems, resetWorkbench, assignItems,
} from './workbench.js';
```

> `moveItems` / `addItems` 仍然留着 —— `/api/workbench/items/move|add` 还在用它们。

- [ ] **Step 5: 加一条 route 级测试**

追加到 `server/src/curator/routes.test.ts` 的 `describe('应用 AI 结论')` 里:

```ts
  it('apply:一条条目被指派到两个夹子 → 两个里都有(都归)', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const a = await seedWorkcopy(app); // 克隆出来的「深度学习」

    // 再建一个新夹子当第二个目标
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '待整理' } });
    const view = (await app.inject({ url: '/api/workbench' })).json();
    const b = view.folders.find((f: { name: string }) => f.name === '待整理').id as number;
    expect(b).not.toBe(a);

    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(a), confidence: 0.9, reason: 'r1' },
      { itemId: 'BV1', folderTempId: String(b), confidence: 0.8, reason: 'r2' },
    ]);

    const res = await app.inject({
      method: 'POST', url: `/api/curator/sessions/${sid}/apply`, payload: { force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(1);

    for (const fid of [a, b]) {
      const items = (await app.inject({ url: `/api/workbench/folders/${fid}/items` })).json();
      expect(items.items.map((i: { id: string }) => i.id)).toContain('BV1');
    }
    await app.close();
  });
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npm test -w server -- src/curator/workbench.test.ts src/curator/routes.test.ts`
Expected: PASS

- [ ] **Step 7: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/workbench.ts server/src/curator/workbench.test.ts server/src/curator/routes.ts server/src/curator/routes.test.ts
git commit -m "fix(curator): apply 支持一条条目归进多个夹子 —— 修都归的最后一公里

moveItems 会先删光该条目的所有归属再插入,所以对同一条调两次(归 A、再归 B)
会把 A 那次删掉。改成按"目标夹子集合"分组调新的 assignItems(一次清空 + 全加)。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Pass 2 改成「规则先跑,AI 只补边界」

**Files:**
- Modify: `server/src/curator/classifier.ts`(`buildPass2Prompt` 加 `samples`、`runPass2` 透传)
- Modify: `server/src/curator/routes.ts`(`run-pass-2` 路由)
- Test: `server/src/curator/classifier.test.ts`、`server/src/curator/routes.test.ts`

**Interfaces:**
- Consumes: Task 1 `listRules`;Task 2 `matchAll` / `renderConditions`;`batchSize`(`llm/context.ts`);`getItem` / `workItemIds`(routes.ts 已 import)
- Produces:
  - `buildPass2Prompt({folders, items, samples?})`,`samples?: ReadonlyMap<number, readonly string[]>`(folderId → 几条标题)
  - `runPass2` 的 `opts` 多一个 `samples?: ReadonlyMap<number, readonly string[]>`
  - `run-pass-2` 响应多两个字段:`ruleCount: number`(规则归了几条条目)、`aiCount: number`(AI 归了几条)

**spec §9C.3 的运行方式**:

```
① 规则匹配 —— 0 token,一次全表扫描 → 命中的直接归(可多个,都归)
② 剩下的分批交给 AI —— 体系里每个夹子带:它的规则;没有规则的带 3 条已有标题
③ 结果如实分栏:规则覆盖 X · AI 归了 Y · 未归类 Z
```

**②里"带已有标题"是必须的**,理由就是 §9C.0 那次事故:一个没有规则的夹子,模型只看名字就会瞎猜(实测 4 条明确的 AI 教程被归进了「黑神话」,而且全标 90% 置信度)。

- [ ] **Step 1: 写失败的测试**

追加到 `server/src/curator/classifier.test.ts` 的 `describe('buildPass2Prompt')` 里(若没有就新建一个 `describe('buildPass2Prompt · 规则与样本')`):

```ts
  it('Pass 2 渲染规则 —— 这个字段从 spec §9.1 起就写着"必须可执行"', () => {
    const p = buildPass2Prompt({
      folders: [folder('42', 'AI/编程')],
      items: [item('BV1', '题')],
    });
    // folder() helper 默认 rule 是 '看标题'
    expect(p).toContain('[42] AI/编程 —— 看标题');
  });

  it('Pass 2 带样本标题 —— 没有规则的夹子靠它们表达"我是放什么的"', () => {
    const p = buildPass2Prompt({
      folders: [folder('42', '黑神话')],
      items: [item('BV1', '题')],
      samples: new Map([[42, ['黑神话悟空 第一回', '黑神话 全成就攻略']]]),
    });
    expect(p).toContain('黑神话悟空 第一回');
    expect(p).toContain('黑神话 全成就攻略');
  });

  it('Pass 2 不带样本时不留空行', () => {
    const p = buildPass2Prompt({ folders: [folder('42', 'AI/编程')], items: [item('BV1', '题')] });
    expect(p).not.toContain('现有条目');
  });
```

> `folder(tempId, name, reuseFolderId?)` 是文件里已有的 helper,`tempId` 是字符串 —— **`samples` 的 key 是 `Number(tempId)`**(见实现)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/classifier.test.ts`
Expected: FAIL —— 带 `samples` 的两条 TS 报错、断言失败

- [ ] **Step 3: 实现**

把 `server/src/curator/classifier.ts:297-317` 的 `buildPass2Prompt` 换成:

```ts
export function buildPass2Prompt(opts: {
  folders: readonly FolderSpec[];
  items: readonly ItemRow[];
  /**
   * 每个夹子里已有的几条标题 —— 给**没有规则的**夹子用。
   *
   * 这一条是必须的,来自一次真机事故:一个没有规则的夹子,模型只看名字就会瞎猜
   * (实测 4 条明确的 AI 教程被归进了「黑神话」,而且全标 90% 置信度)。
   * 给它三条标题,它立刻知道那夹子是放什么的。
   */
  samples?: ReadonlyMap<number, readonly string[]>;
}): string {
  // 只带 tempId + name + rule —— description/estCount 对归类没用,纯占 token(spec §9.3)。
  // **tempId 用方括号单独框出来**:它现在是裸数字(工作夹子 id),写成 `63:健身` 时
  // 实测小模型会填名字而不是数字,于是整批归类全落空(而界面上看起来是"完成")。
  const folders = opts.folders
    .map((f) => {
      const head = `[${f.tempId}] ${f.name}${f.rule ? ` —— ${f.rule}` : ''}`;
      const samples = opts.samples?.get(Number(f.tempId)) ?? [];
      return samples.length
        ? `${head}\n    现有条目:${samples.map((s) => `「${s}」`).join(' ')}`
        : head;
    })
    .join('\n');

  return [
    '## 收藏夹体系',
    folders,
    '',
    `## 待归类条目(${opts.items.length} 条)`,
    opts.items.map((i) => renderItem(i)).join('\n\n'),
    '',
    '请给每条一个归属。',
  ].join('\n');
}
```

- [ ] **Step 4: `runPass2` 透传 samples**

在 `runPass2` 的 `opts` 类型里(`classifier.ts:508-514`)加一行:

```ts
  /** 透传给 buildPass2Prompt —— 没规则的夹子靠已有标题表达"我是放什么的" */
  samples?: ReadonlyMap<number, readonly string[]>;
```

并把它内部调用 `buildPass2Prompt` 的那处(`classifier.ts:532` 附近,现在写的是
`content: buildPass2Prompt({ folders: opts.folders, items: batch })`)改成:

```ts
            content: buildPass2Prompt({
              folders: opts.folders,
              items: batch,
              ...(opts.samples ? { samples: opts.samples } : {}),
            }),
```

- [ ] **Step 5: 改 `run-pass-2` 路由**

在 `server/src/curator/routes.ts` 的 `/api/curator/sessions/:id/run-pass-2` 里,把这段:

```ts
      const folders: FolderSpec[] = work.map((w) => ({
        tempId: String(w.id),
        name: w.name,
        description: '',
        rule: '', // 工作副本里没有"判定规则"这个概念(那是 AI 提案的产物)
        estCount: workItemIds(db, w.id).length,
        // 不带 reuseFolderId:buildPass2Prompt 只读 tempId/name/rule,这个字段到不了模型
      }));

      const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];

      try {
        const result = await runPass2({
          config: llm.config,
          ctx: llm.ctx,
          folders,
          items,
        });
        saveClassification(db, id, result.assignments, result.failedBatches);

        log.event({
          level: 'info',
          category: 'llm',
          message: `Pass 2 完成:归类 ${result.assignments.length}/${items.length} 条,${
            result.failedBatches.length
          } 批失败`,
        });

        return {
          assignments: result.assignments,
          failedBatches: result.failedBatches,
          total: items.length,
          batchSize: batchSize(llm.ctx),
        };
```

换成:

```ts
      const rules = listRules(db);
      const ruleOf = new Map(rules.map((r) => [r.folderId, r]));

      const folders: FolderSpec[] = work.map((w) => ({
        tempId: String(w.id),
        name: w.name,
        description: '',
        // **规则终于用在了它该用的地方** —— 这个字段从 spec §9.1 起就写着
        // "判定规则,必须可执行",而 m4b 之后一直是空串,于是模型只能看名字瞎猜。
        rule: renderConditions(ruleOf.get(w.id)?.conditions ?? []),
        estCount: workItemIds(db, w.id).length,
        // 不带 reuseFolderId:buildPass2Prompt 只读 tempId/name/rule,这个字段到不了模型
      }));

      // 没规则的夹子给模型几条已有标题 —— 只看名字它会自信地猜错(真机验证过,§9C.0)
      const samples = new Map<number, string[]>();
      for (const w of work) {
        if (ruleOf.has(w.id)) continue;
        const titles = workItemIds(db, w.id)
          .slice(0, 3)
          .map((iid) => getItem(db, iid)?.title)
          .filter((t): t is string => !!t);
        if (titles.length) samples.set(w.id, titles);
      }

      const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];

      // ── ① 规则先跑:0 token、确定性 ───────────────────────
      // 匹配置信度给 1 —— 规则命中是"确定"不是"猜",和 AI 的 0.9 不是同一种东西
      const matched = matchAll(
        items.map((i) => ({ id: i.id, title: i.title, intro: i.intro, upperName: i.upper_name })),
        rules,
      );
      const ruleAssignments: Assignment[] = [];
      for (const [itemId, hits] of matched) {
        for (const hit of hits) {
          ruleAssignments.push({
            itemId,
            folderTempId: String(hit.folderId),
            confidence: 1,
            reason: `规则命中:${hit.tokens.map((t) => t.token).join('、')}`,
          });
        }
      }
      // **规则命中的条目根本不进 AI 的输入** —— R4b"两组条目不相交"就落在这里
      const rest = items.filter((i) => !matched.has(i.id));

      log.event({
        level: 'info',
        category: 'llm',
        message: `规则先跑:${items.length - rest.length} 条命中规则,剩 ${rest.length} 条交给 AI`,
      });

      try {
        // ── ② 剩下的才给 AI ─────────────────────────────────
        const result = rest.length
          ? await runPass2({ config: llm.config, ctx: llm.ctx, folders, items: rest, samples })
          : { assignments: [], failedBatches: [] };
        const assignments = [...ruleAssignments, ...result.assignments];
        saveClassification(db, id, assignments, result.failedBatches);

        log.event({
          level: 'info',
          category: 'llm',
          message: `Pass 2 完成:规则 ${ruleAssignments.length} 条 + AI ${result.assignments.length} 条,${
            result.failedBatches.length
          } 批失败`,
        });

        return {
          assignments,
          failedBatches: result.failedBatches,
          total: items.length,
          /** 分栏要如实 —— 哪些是规则归的、哪些是 AI 归的(spec §9C.3 ③) */
          ruleCount: items.length - rest.length,
          aiCount: result.assignments.filter((a) => a.folderTempId !== null).length,
          batchSize: batchSize(llm.ctx),
        };
```

顶部 import 补两行:

```ts
import { listRules } from '../db/repo/rules.js';
import { matchAll, renderConditions } from './rules.js';
import type { Assignment } from '../db/repo/classifications.js';
```

> `Assignment` 也可以并进上面已有的 `from '../db/repo/classifications.js'` 那条 —— 保持一处 import 更干净:
> ```ts
> import {
>   saveClassification,
>   getClassification,
>   deleteClassification,
>   type Assignment,
> } from '../db/repo/classifications.js';
> ```

- [ ] **Step 6: 加 route 级测试**

追加到 `server/src/curator/routes.test.ts` 的 `describe('Pass 2')` 里:

```ts
  // R5 的全部价值就在这条:规则覆盖的条目 0 token 归位,一次 LLM 都不调
  it('规则命中的条目不进 AI 调用', async () => {
    const { app, db } = makeApp();
    seed(db); // BV1 / BV2 在快照夹子 7 里,标题分别是 'a' / 'b'
    const work = await seedWorkcopy(app);

    await app.inject({
      method: 'PUT',
      url: `/api/rules/${work}`,
      payload: { conditions: [{ field: 'title', any: ['a', 'b'] }] },
    });

    mocks.complete.mockClear();
    const sid = await newSession(app);
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.ruleCount).toBe(2);
    expect(body.aiCount).toBe(0);
    // 规则全覆盖 → 一次 LLM 都不该调
    expect(mocks.complete).not.toHaveBeenCalled();

    // 而且这两条真的被写进了归类提案(folderTempId 就是工作夹子 id)
    const stored = getClassification(db, sid)!;
    expect(stored.assignments.map((a) => a.folderTempId)).toEqual([String(work), String(work)]);
    expect(stored.assignments.every((a) => a.confidence === 1)).toBe(true);
    await app.close();
  });
```

> 这条测试依赖 Task 6 的 `PUT /api/rules/:folderId`。**按顺序做的话,T6 做完再回来补这条。** 别把它当成"必须现在过"。

- [ ] **Step 7: 跑测试确认通过**

Run: `npm test -w server -- src/curator/classifier.test.ts src/curator/routes.test.ts`
Expected: PASS

- [ ] **Step 8: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/classifier.ts server/src/curator/classifier.test.ts server/src/curator/routes.ts server/src/curator/routes.test.ts
git commit -m "feat(curator): 归类改成规则先跑,AI 只补边界

规则命中 0 token、确定性;没规则的夹子带 3 条已有标题当例子
(真机验证过:只看名字模型会自信地归错)。结果分栏如实报 ruleCount / aiCount。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 规则 CRUD 路由 + 命中数 + 试跑

**Files:**
- Create: `server/src/curator/ruleRoutes.ts`
- Modify: `server/src/http/index.ts`(注册一行)
- Test: `server/src/curator/ruleRoutes.test.ts`

**Interfaces:**
- Consumes: Task 1 `listRules` / `getRule` / `saveRule` / `deleteRule`;Task 2 `matchAll` / `renderConditions` / `RuleItem`;Task 3 `validateSuggestion` / `SuggestionCtx`;`listWorkFolders` / `workItemIds`;`listFolders` / `isLockedFolder`;`ItemRow`;`batchSize`;`readLlmSettings`
- Produces:
  ```
  GET    /api/rules                    → { rules: RuleView[] }
  PUT    /api/rules/:folderId          { conditions } → { ok: true }
  DELETE /api/rules/:folderId          → { ok: true }
  POST   /api/rules/:folderId/adopt    { field, any, because, evidenceItemIds } → { ok: true }
  POST   /api/rules/dry-run            → { covered, remaining, batches }
  ```
  ```ts
  export interface RuleView {
    folderId: number; folderName: string; locked: boolean;
    conditions: RuleCondition[]; origin: RuleOrigin | null; updatedAt: number | null;
    /** 命中数:这条规则会从**全库**捞走多少条(spec §9C.4 口径) */
    hit: number;
  }
  ```

**为什么新开一个文件**:`curator/routes.ts` 已经 786 行 / 30 条路由。规则路由是**独立的一件事**(整页的 CRUD + 命中数 + 试跑),塞进去会让那个文件过千行。新建 `ruleRoutes.ts` 沿用仓库既有的 `registerXxxRoutes(app, deps)` 模式,对 `routes.ts` 的改动是**零**。

- [ ] **Step 1: 写失败的测试**

`server/src/curator/ruleRoutes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { saveLlmSettings } from '../llm/config.js';
import { saveRule } from '../db/repo/rules.js';
import type { BiliClient } from '../bilibili/client.js';

const stubClient = {
  withCredentials: () => ({ get: async () => null }),
} as unknown as BiliClient;

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  saveLlmSettings(db, { provider: 'ollama', model: 'qwen2.5:14b', baseUrl: '', apiKey: '' });
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
  upsertItem(db, { id: 'BV2', type: 2, title: 'Rust 入门' });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
  const app = createServer({ db, log, client: stubClient });
  return { app, db };
}

/** 建工作副本,回**克隆出来的那个夹子**的 id(它是快照 7 的副本) */
async function workcopy(app: FastifyInstance): Promise<number> {
  await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '临时' } });
  const view = (await app.inject({ url: '/api/workbench' })).json();
  return view.folders.find((f: { originId: number | null }) => f.originId === 7).id as number;
}

describe('规则路由', () => {
  it('GET /api/rules 列出全部工作夹子,没规则的也在(hit=0)', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);

    const res = await app.inject({ url: '/api/rules' });
    expect(res.statusCode).toBe(200);

    const rules = res.json().rules as { folderId: number; conditions: unknown[]; hit: number }[];
    const mine = rules.find((r) => r.folderId === id)!;
    expect(mine.conditions).toEqual([]);
    expect(mine.hit).toBe(0);
    await app.close();
  });

  it('PUT 存规则,GET 能看到,hit 是真算出来的', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);

    const put = await app.inject({
      method: 'PUT', url: `/api/rules/${id}`,
      payload: { conditions: [{ field: 'title', any: ['Python'] }] },
    });
    expect(put.statusCode).toBe(200);

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === id);
    expect(mine.conditions).toEqual([{ field: 'title', any: ['Python'] }]);
    expect(mine.origin).toBe('user');
    // 全库两条条目标题是 'Python 教程' / 'Rust 入门' → 只捞走 1 条
    expect(mine.hit).toBe(1);
    await app.close();
  });

  it('PUT 校验:conditions 必须是数组、field 必须是三个之一', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);

    expect(
      (await app.inject({ method: 'PUT', url: `/api/rules/${id}`, payload: { conditions: '不是数组' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({
        method: 'PUT', url: `/api/rules/${id}`,
        payload: { conditions: [{ field: '简介', any: ['x'] }] },
      })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({
        method: 'PUT', url: `/api/rules/${id}`,
        payload: { conditions: [{ field: 'title', any: 'not-an-array' }] },
      })).statusCode,
    ).toBe(400);
    await app.close();
  });

  it('PUT 一个不存在的工作夹子 → 404', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'PUT', url: '/api/rules/99999', payload: { conditions: [] },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // §9C.6 约束 4:锁定的夹子不能加规则,和改名/删除/移动并删除同一条规则
  it('锁定的夹子加规则被拒', async () => {
    const { app, db } = makeApp();
    await workcopy(app);
    // 「默认收藏夹」快照夹子由 isDefaultFolder 判定锁定(raw.attr === 0)
    upsertFolder(db, { id: 9, title: '默认收藏夹', mediaCount: 0, raw: JSON.stringify({ attr: 0 }) });
    // 重新克隆一份,让 9 也进工作副本
    await app.inject({ method: 'POST', url: '/api/workbench/reset' });
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '临时' } });

    const view = (await app.inject({ url: '/api/workbench' })).json();
    const locked = view.folders.find((f: { originId: number | null }) => f.originId === 9).id;

    const res = await app.inject({
      method: 'PUT', url: `/api/rules/${locked}`,
      payload: { conditions: [{ field: 'title', any: ['x'] }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('默认收藏夹');
    await app.close();
  });

  it('DELETE 清掉规则', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);
    await app.inject({
      method: 'PUT', url: `/api/rules/${id}`,
      payload: { conditions: [{ field: 'title', any: ['Python'] }] },
    });

    expect((await app.inject({ method: 'DELETE', url: `/api/rules/${id}` })).statusCode).toBe(200);

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === id);
    expect(mine.conditions).toEqual([]);
    expect(mine.hit).toBe(0);
    await app.close();
  });

  // 采纳是**追加**,不是覆盖 —— 覆盖会把夹子原有的规则整条抹掉
  it('POST adopt 追加一条条件,origin 记 ai', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);
    await app.inject({
      method: 'PUT', url: `/api/rules/${id}`,
      payload: { conditions: [{ field: 'title', any: ['Python'] }] },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/rules/${id}/adopt`,
      payload: {
        field: 'title', any: ['Rust'], because: '同类',
        evidenceItemIds: ['BV2'],
      },
    });
    expect(res.statusCode).toBe(200);

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === id);
    expect(mine.conditions).toEqual([
      { field: 'title', any: ['Python'] },
      { field: 'title', any: ['Rust'] },
    ]);
    expect(mine.origin).toBe('ai');
    expect(mine.hit).toBe(2); // 两条都被捞走了
    await app.close();
  });

  // §9C.6 约束 2:没验过的建议不入库。采纳这条路径**也要**过验证
  it('POST adopt 一条自证不过的建议 → 400,库里没有它', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);

    const res = await app.inject({
      method: 'POST', url: `/api/rules/${id}/adopt`,
      payload: {
        field: 'title', any: ['根本打不中'],
        because: '编的', evidenceItemIds: ['BV1'],
      },
    });
    expect(res.statusCode).toBe(400);

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === id);
    expect(mine.conditions).toEqual([]);
    await app.close();
  });

  it('POST /api/rules/dry-run 报覆盖 / 剩余 / 批数', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);
    await app.inject({
      method: 'PUT', url: `/api/rules/${id}`,
      payload: { conditions: [{ field: 'title', any: ['Python'] }] },
    });

    const res = await app.inject({ method: 'POST', url: '/api/rules/dry-run' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.covered).toBe(1); // 只有 'Python 教程' 被打中
    expect(body.remaining).toBe(1);
    expect(body.batches).toBe(1);
    await app.close();
  });

  it('dry-run:没配模型时 batches 是 null(别编一个)', async () => {
    const { app, db } = makeApp();
    const id = await workcopy(app);
    await app.inject({
      method: 'PUT', url: `/api/rules/${id}`,
      payload: { conditions: [{ field: 'title', any: ['Python'] }] },
    });
    db.prepare(`DELETE FROM settings`).run();

    const body = (await app.inject({ method: 'POST', url: '/api/rules/dry-run' })).json();
    expect(body.covered).toBe(1);
    expect(body.batches).toBeNull();
    await app.close();
  });
});
```

> 最后一条依赖"LLM 设置存在 `settings` 表里"这一事实 —— 已核实:`saveLlmSettings` 走 `setSetting`,`setSetting` 写的就是 `settings` 表(`state.ts:45`),而 `readLlmSettings` 读的 `llm.provider` / `llm.model` 两个 key 也来自同一张表。所以 `DELETE FROM settings` 会让它返回 `null`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/ruleRoutes.test.ts`
Expected: FAIL —— 全部 404(路由还没注册)

- [ ] **Step 3: 实现**

`server/src/curator/ruleRoutes.ts`:

```ts
/**
 * /api/rules/* 的路由(spec §9C)。
 *
 * 规则是**你 / AI 共同维护的本地资产**:bilibili 有夹子但没有逻辑,
 * 谁进谁出全靠手。它只存在本地,不上传 B站。
 *
 * 单独一个文件:curator/routes.ts 已经 786 行,而规则这一页是独立的一件事
 * (整页 CRUD + 命中数 + 试跑),塞进去只会让那个文件过千行。
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import {
  listRules, getRule, saveRule, deleteRule, type RuleCondition, type RuleOrigin,
} from '../db/repo/rules.js';
import { listWorkFolders } from '../db/repo/workbench.js';
import { listFolders, isLockedFolder } from '../db/repo/folders.js';
import type { ItemRow } from '../db/repo/items.js';
import { readLlmSettings } from '../llm/config.js';
import { batchSize } from '../llm/context.js';
import { matchAll, renderConditions, validateSuggestion, type RuleItem } from './rules.js';

export interface RuleDeps {
  db: Database.Database;
  log: Logger;
}

export interface RuleView {
  folderId: number;
  folderName: string;
  /** 锁定的夹子不能加规则(spec §9C.6 约束 4) */
  locked: boolean;
  /** 空数组 = 还没有规则 */
  conditions: RuleCondition[];
  /** null = 还没人写过 */
  origin: RuleOrigin | null;
  updatedAt: number | null;
  /** 命中数:这条规则会从**全库**捞走多少条(spec §9C.4 口径) */
  hit: number;
}

/** 出口形状的 item 投影 + 出口形状的规则视图,路由里两处都要用 */
const toRuleItem = (i: ItemRow): RuleItem => ({
  id: i.id,
  title: i.title,
  intro: i.intro,
  upperName: i.upper_name,
});

export function registerRuleRoutes(app: FastifyInstance, deps: RuleDeps): void {
  const { db } = deps;

  /**
   * 命中数在服务端**一次算完**(打开面板时 + 每次改完规则后)。
   *
   * 口径是**全库 items**(不是某个夹子里的子集)—— 要回答的是
   * "这条规则会从整个库里捞走多少条"(spec §9C.4)。
   */
  const rulesWithHits = () => {
    const rules = listRules(db);
    const ruleOf = new Map(rules.map((r) => [r.folderId, r]));
    const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
    const matched = matchAll(items.map(toRuleItem), rules);

    const hits = new Map<number, number>();
    for (const itemHits of matched.values()) {
      for (const h of itemHits) hits.set(h.folderId, (hits.get(h.folderId) ?? 0) + 1);
    }

    const snapshots = new Map(listFolders(db).map((f) => [f.id, f]));
    const views: RuleView[] = listWorkFolders(db).map((w) => {
      const origin = w.originId === null ? undefined : snapshots.get(w.originId);
      return {
        folderId: w.id,
        folderName: w.name,
        locked: origin !== undefined && isLockedFolder(db, origin),
        conditions: ruleOf.get(w.id)?.conditions ?? [],
        origin: ruleOf.get(w.id)?.origin ?? null,
        updatedAt: ruleOf.get(w.id)?.updatedAt ?? null,
        hit: hits.get(w.id) ?? 0,
      };
    });

    return { views, matchedCount: matched.size, total: items.length };
  };

  /** 找出工作副本里的那个夹子 + 它在快照里的原点(锁定判定要用原点) */
  const folderOr = (folderId: number) => {
    const work = listWorkFolders(db).find((w) => w.id === folderId);
    if (!work) return null;
    const origin = work.originId === null
      ? undefined
      : listFolders(db).find((f) => f.id === work.originId);
    return { work, origin };
  };

  /** 一条条件的形状校验 —— 写进来的东西是要拿去执行的,不能是垃圾 */
  const badCondition = (c: unknown): string | null => {
    if (!c || typeof c !== 'object') return '条件必须是对象';
    const o = c as { field?: unknown; any?: unknown };
    if (o.field !== 'title' && o.field !== 'intro' && o.field !== 'upper') {
      return 'field 只能是 title / intro / upper';
    }
    if (!Array.isArray(o.any) || o.any.some((k) => typeof k !== 'string')) {
      return 'any 必须是字符串数组';
    }
    return null;
  };

  app.get('/api/rules', async () => {
    const { views } = rulesWithHits();
    return { rules: views };
  });

  app.put('/api/rules/:folderId', async (req, reply) => {
    const folderId = Number((req.params as { folderId: string }).folderId);
    const { conditions } = (req.body ?? {}) as { conditions?: unknown };

    const found = folderOr(folderId);
    if (!found) {
      return reply.code(404).send({ ok: false, reason: `工作副本里没有夹子 ${folderId}` });
    }
    if (!Array.isArray(conditions)) {
      return reply.code(400).send({ ok: false, reason: 'conditions 必须是数组' });
    }
    for (const c of conditions) {
      const bad = badCondition(c);
      if (bad) return reply.code(400).send({ ok: false, reason: bad });
    }
    if (found.origin && isLockedFolder(db, found.origin)) {
      return reply.code(400).send({
        ok: false,
        reason: `「${found.origin.title}」是 B站 自带的默认收藏夹,不能加规则`,
      });
    }

    saveRule(db, folderId, conditions as RuleCondition[], 'user');
    return { ok: true };
  });

  app.delete('/api/rules/:folderId', async (req, reply) => {
    const folderId = Number((req.params as { folderId: string }).folderId);
    if (!folderOr(folderId)) {
      return reply.code(404).send({ ok: false, reason: `工作副本里没有夹子 ${folderId}` });
    }
    // 只删规则 —— 夹子和里面的条目一行不动(界面上的文案也是这么说的)
    deleteRule(db, folderId);
    return { ok: true };
  });

  /**
   * 采纳一条 AI 建议 = **追加**一个条件,不是覆盖。
   *
   * 覆盖会把夹子原有的规则整条抹掉 —— 而"再给这个夹子加一条"正是建议的语义。
   *
   * 这里**再验一次**自证(spec §9C.6 约束 2):过不了验证的建议不入库,
   * 连"待采纳"都不给。客户端传回来的东西不可信,验一遍的成本可以忽略。
   */
  app.post('/api/rules/:folderId/adopt', async (req, reply) => {
    const folderId = Number((req.params as { folderId: string }).folderId);
    const found = folderOr(folderId);
    if (!found) {
      return reply.code(404).send({ ok: false, reason: `工作副本里没有夹子 ${folderId}` });
    }
    if (found.origin && isLockedFolder(db, found.origin)) {
      return reply.code(400).send({
        ok: false,
        reason: `「${found.origin.title}」是 B站 自带的默认收藏夹,不能加规则`,
      });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
    const valid = validateSuggestion(
      { ...body, folderTempId: folderId },
      {
        validFolderIds: new Set([folderId]),
        itemsById: new Map(items.map((i) => [i.id, toRuleItem(i)])),
      },
    );
    if (!valid) {
      return reply.code(400).send({ ok: false, reason: '这条建议过不了自证,不采纳' });
    }

    const existing = getRule(db, folderId)?.conditions ?? [];
    saveRule(db, folderId, [...existing, { field: valid.field, any: valid.any }], 'ai');
    return { ok: true };
  });

  /** 试跑:规则能覆盖多少条、剩下多少要给 AI、按当前模型算几批 */
  app.post('/api/rules/dry-run', async () => {
    const { matchedCount, total } = rulesWithHits();
    const llm = readLlmSettings(db);
    const remaining = total - matchedCount;

    return {
      covered: matchedCount,
      remaining,
      // 没配模型就不报批数(null)—— 别编一个(spec §9C.4:批数用 §3 的 batchSize 现算)
      batches: llm && remaining > 0 ? Math.ceil(remaining / batchSize(llm.ctx)) : null,
    };
  });
}
```

- [ ] **Step 4: 注册它**

在 `server/src/http/index.ts` 加 import:

```ts
import { registerRuleRoutes } from '../curator/ruleRoutes.js';
```

并在 `registerCuratorRoutes(...)` 之后加:

```ts
  registerRuleRoutes(app, { db, log });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -w server -- src/curator/ruleRoutes.test.ts`
Expected: PASS(10 tests)

- [ ] **Step 6: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/ruleRoutes.ts server/src/curator/ruleRoutes.test.ts server/src/http/index.ts
git commit -m "feat(curator): 规则 CRUD + 命中数 + 试跑

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 规则建议的那次 LLM 调用

**Files:**
- Create: `server/src/curator/suggestions.ts`
- Test: `server/src/curator/suggestions.test.ts`

**Interfaces:**
- Consumes: Task 1 `FolderRule`;Task 2 `RuleItem` / `renderConditions` / `SuggestionCtx`;Task 3 `validateSuggestions` / `mergeSuggestions` / `ValidSuggestion`;`parseJsonArray`(`./parse.js`);`complete`(`llm/provider.js`);`ModelConfig` / `ModelMeta`;`ItemRow`
- Produces:
  ```ts
  export interface SuggestionFolder {
    folderId: number; name: string;
    /** 它现在的规则(渲染好的);空串 = 还没有规则 */
    rule: string;
    /** 没有规则的夹子才有 —— 几条已有标题,让它知道自己是放什么的 */
    samples?: readonly string[];
  }
  export const SUGGESTION_SYSTEM: string;
  function buildSuggestionPrompt(opts: {
    folders: readonly SuggestionFolder[];
    items: readonly ItemRow[];
  }): string
  /** 攒一次调用的**全部输入** —— 两条路共用,所以只有一个地方在定"喂什么" */
  function suggestionInput(db): {
    folders: SuggestionFolder[]; pool: ItemRow[]; allItems: ItemRow[];
  }
  async function runSuggestions(opts: {
    config: ModelConfig;
    folders: readonly SuggestionFolder[];
    /** 规则没覆盖住的条目 —— 建议就是为了给它们(和放错地方的)找一条规则 */
    pool: readonly ItemRow[];
    /**
     * 归类时 AI 说"拿不准"的那些 id。传了它有两道作用:
     * ① 一条都没有 → **根本不调**(没有"没地方去"的条目就没有建议可提 —— §9C.5 b 的省钱闸)
     * ② 它们排最前,所以 cap 永远切不掉最有信息量的那几条
     * 界面上主动问那条路没有这个信息(没跑归类),不传就行。
     */
    homelessIds?: ReadonlySet<string>;
    /** 一次最多喂多少条 —— 传 `batchSize(ctx)`,复用 §3 的口径而不是另定一个数 */
    cap: number;
    /** 全库条目,自证时用(它可能引用一条已经归到别处的条目当证据) */
    allItems: readonly ItemRow[];
  }): Promise<ValidSuggestion[]>
  ```

> **`pool` / `homelessIds` / `cap` 这一组是这一轮必须定的口径**(spec 没写)。理由见 Task 7 Step 3 的注释和 Self-Review 第 5 条。

**为什么是**单独一次调用**(spec §9C.5 b)**:归类那次的输出**是一个裸 JSON 数组**,而且真机验证过小模型能吃住这个形状;把它改成 `{assignments,ruleSuggestions}` 会让输出变难,有把已经跑通的那条路弄坏的实际风险。而建议只在"有没归上的条目"时才需要,所以单开一次调用**只在需要时付费**,而且那次的提问更简单,对小模型更友好。

- [ ] **Step 1: 写失败的测试**

`server/src/curator/suggestions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import type { ModelMeta } from '../llm/registry.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem, type ItemRow } from '../db/repo/items.js';
import { ensureWorkcopy, listWorkFolders } from '../db/repo/workbench.js';
import { saveRule } from '../db/repo/rules.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

// 顶层 await import —— vi.mock 必须先生效(和 classifier.test.ts 同一个理由)
const { buildSuggestionPrompt, runSuggestions, suggestionInput, SUGGESTION_SYSTEM } =
  await import('./suggestions.js');

const ctx: ModelMeta = {
  provider: 'ollama', model: 'qwen2.5:14b', contextWindow: 32_000, maxOutput: 2_000, verified: true,
};
const config = { id: '本地', provider: 'ollama', baseUrl: '', apiKey: '', model: 'qwen2.5:14b' };

const item = (id: string, title: string, extra: Partial<ItemRow> = {}): ItemRow => ({
  id, type: 2, title, intro: null, cover: null, upper_mid: null, upper_name: null,
  duration: null, pubtime: null, invalid: 0, invalid_checked_at: null,
  ai_tags: null, ai_summary: null, ai_checked_at: null, raw: null, ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe('buildSuggestionPrompt', () => {
  it('带规则 / 带样本 / 带待处理条目', () => {
    const p = buildSuggestionPrompt({
      folders: [
        { folderId: 42, name: 'AI/编程', rule: '标题含 Python' },
        { folderId: 43, name: '黑神话', rule: '', samples: ['黑神话悟空 第一回'] },
      ],
      items: [item('BV9', 'Agent 入门', { intro: '讲大模型' })],
    });

    expect(p).toContain('[42] AI/编程 —— 标题含 Python');
    expect(p).toContain('黑神话悟空 第一回');
    expect(p).toContain('[BV9] Agent 入门');
    expect(p).toContain('讲大模型');
  });

  it('不带样本的夹子不留空行', () => {
    const p = buildSuggestionPrompt({
      folders: [{ folderId: 42, name: 'AI/编程', rule: '标题含 Python' }],
      items: [item('BV9', '题')],
    });
    expect(p).not.toContain('现有条目');
  });
});

describe('suggestionInput', () => {
  /** 快照:一个夹子 + 两条条目,克隆出工作副本 */
  function seeded() {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 7, title: 'AI/编程', mediaCount: 2 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'Agent 入门' });
    linkFolderItem(db, 7, 'BV1', 1);
    linkFolderItem(db, 7, 'BV2', 1);
    ensureWorkcopy(db);
    return db;
  }

  it('pool = 规则没覆盖住的条目 —— 规则命中过的被排除', () => {
    const db = seeded();
    const work = listWorkFolders(db)[0]!;
    saveRule(db, work.id, [{ field: 'title', any: ['Python'] }], 'user');

    const { pool } = suggestionInput(db);
    expect(pool.map((i) => i.id)).toEqual(['BV2']);
  });

  it('全覆盖时 pool 是空的(调用方据此不调 LLM)', () => {
    const db = seeded();
    const work = listWorkFolders(db)[0]!;
    saveRule(db, work.id, [{ field: 'title', any: ['Python', 'Agent'] }], 'user');

    expect(suggestionInput(db).pool).toEqual([]);
  });

  it('有规则的夹子带规则、**不带样本**', () => {
    const db = seeded();
    const work = listWorkFolders(db)[0]!;
    saveRule(db, work.id, [{ field: 'title', any: ['Python'] }], 'user');

    const { folders } = suggestionInput(db);
    expect(folders[0]!.rule).toBe('标题含 Python');
    expect(folders[0]!.samples).toBeUndefined();
  });

  // 只看名字模型会自信地猜错(§9C.0 那次真机事故)—— 没规则的夹子必须带例子
  it('没规则的夹子带已有标题当样本', () => {
    const db = seeded();
    const { folders } = suggestionInput(db);
    expect(folders[0]!.rule).toBe('');
    expect(folders[0]!.samples).toEqual(['Python 教程', 'Agent 入门']);
  });

  it('allItems 是全库 —— 自证要能查到已经归到别处的条目', () => {
    const db = seeded();
    const work = listWorkFolders(db)[0]!;
    saveRule(db, work.id, [{ field: 'title', any: ['Python'] }], 'user');

    expect(suggestionInput(db).allItems.map((i) => i.id).sort()).toEqual(['BV1', 'BV2']);
  });
});

describe('runSuggestions', () => {
  const folders = [{ folderId: 42, name: 'AI/编程', rule: '' }];
  const pool = [item('BV9', 'Agent 入门')];
  const allItems = [item('BV9', 'Agent 入门'), item('BV1', 'Python 教程')];
  const base = { config, folders, pool, allItems, cap: 50 };

  it('好的建议过了自证就返回', async () => {
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: 42, field: 'title', any: ['Agent'], because: '同类', evidenceItemIds: ['BV9'] },
    ]));

    const got = await runSuggestions(base);
    expect(got).toHaveLength(1);
    expect(got[0]!.folderId).toBe(42);
    expect(got[0]!.any).toEqual(['Agent']);
  });

  // ★ 防幻觉:它编的词打不中它给的证据条目
  it('自证不过的建议被丢掉', async () => {
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: 42, field: 'title', any: ['根本没有这个词'], because: '编的', evidenceItemIds: ['BV9'] },
    ]));
    expect(await runSuggestions(base)).toEqual([]);
  });

  it('同一组词出现两次 → 合并成一条,证据并起来', async () => {
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: 42, field: 'title', any: ['Agent'], because: 'a', evidenceItemIds: ['BV9'] },
      { folderTempId: 42, field: 'title', any: ['Agent'], because: 'b', evidenceItemIds: ['BV9'] },
    ]));
    expect(await runSuggestions(base)).toHaveLength(1);
  });

  it('规则覆盖光了 → 一次 LLM 都不调(没有可提的)', async () => {
    const got = await runSuggestions({ ...base, pool: [] });
    expect(got).toEqual([]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  // §9C.5 b "只在需要时付费":传了 homelessIds 就是"归类时一条都没归上"的信号,
  // 那就没什么可建议的 —— 不调
  it('homelessIds 是空集 → 不调(这是省钱闸)', async () => {
    const got = await runSuggestions({ ...base, homelessIds: new Set<string>() });
    expect(got).toEqual([]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('homelessIds 不传 → 照常调(界面上主动问那条路没有这个信息)', async () => {
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: 42, field: 'title', any: ['Agent'], because: 'x', evidenceItemIds: ['BV9'] },
    ]));
    expect(await runSuggestions(base)).toHaveLength(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  // cap 是必须的:全库几千条没规则时,不加限制的 prompt 会远超任何上下文窗口
  it('pool 超过 cap → 只喂 cap 条', async () => {
    const many = Array.from({ length: 10 }, (_, i) => item(`BV${i}`, `标题${i}`));
    mocks.complete.mockResolvedValue('[]');

    await runSuggestions({ ...base, pool: many, allItems: many, cap: 3 });

    const prompt = mocks.complete.mock.calls[0]![0].messages[1].content as string;
    expect(prompt).toContain('标题0');
    expect(prompt).not.toContain('标题9');
  });

  // cap 切的是尾巴,所以最该被看见的必须排最前
  it('homeless 的条目排在最前 —— cap 切不掉它们', async () => {
    const many = Array.from({ length: 10 }, (_, i) => item(`BV${i}`, `标题${i}`));
    mocks.complete.mockResolvedValue('[]');

    await runSuggestions({
      ...base, pool: many, allItems: many, cap: 2,
      homelessIds: new Set(['BV9']),
    });

    const prompt = mocks.complete.mock.calls[0]![0].messages[1].content as string;
    expect(prompt).toContain('标题9');
    expect(prompt).toContain('标题0');
    expect(prompt).not.toContain('标题1');
  });

  it('模型吐坏 JSON → 空数组,不抛(归类那条路不该被建议拖垮)', async () => {
    mocks.complete.mockResolvedValue('我不太明白你的意思');
    expect(await runSuggestions(base)).toEqual([]);
  });
});

describe('SUGGESTION_SYSTEM', () => {
  // 提示词是这条链上唯一的防线,用测试钉住那几句关键要求(classifier.ts 同款做法)
  it('钉住"必须给证据条目"和三个字段', () => {
    expect(SUGGESTION_SYSTEM).toContain('evidenceItemIds');
    expect(SUGGESTION_SYSTEM).toContain('title');
    expect(SUGGESTION_SYSTEM).toContain('JSON');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/suggestions.test.ts`
Expected: FAIL —— `Cannot find module './suggestions.js'`

- [ ] **Step 3: 实现**

`server/src/curator/suggestions.ts`:

```ts
/**
 * 规则建议 —— AI 的第二个通道(spec §9C.5 b)。
 *
 * **单独一次调用**,不塞进归类那次:归类那次的输出是一个裸 JSON 数组,真机验证过
 * 小模型能吃住那个形状;改成 `{assignments, ruleSuggestions}` 会让输出变难,
 * 有把已经跑通的那条路弄坏的实际风险。而建议只在"有没归上的条目"时才需要 ——
 * 单独一次调用只在需要时付费,而且那次的提问更简单,对小模型更友好。
 */
import type Database from 'better-sqlite3';
import { getItem, type ItemRow } from '../db/repo/items.js';
import { listRules } from '../db/repo/rules.js';
import { listWorkFolders, workItemIds } from '../db/repo/workbench.js';
import { complete, type ModelConfig } from '../llm/provider.js';
import { parseJsonArray } from './parse.js';
import {
  matchAll, renderConditions, validateSuggestions, mergeSuggestions,
  type RuleItem, type ValidSuggestion,
} from './rules.js';

export interface SuggestionFolder {
  folderId: number;
  name: string;
  /** 它现在的规则(渲染好的);空串 = 还没有规则 */
  rule: string;
  /** 没有规则的夹子才有 —— 几条已有标题,让它知道自己是放什么的 */
  samples?: readonly string[];
}

/**
 * 导出是为了让测试能钉住"必须给证据条目"这句 ——
 * 提示词是这条链上唯一的防线(和 classifier.ts 的 PASS2_SYSTEM 同一个理由)。
 */
export const SUGGESTION_SYSTEM = `你是 bilibili 收藏整理管家。用户在本地维护了一套"规则",
规则决定哪条收藏该进哪个夹子,规则命中的条目会 0 token 直接归位,不需要你归类。

现在有一批条目**没能归上**。请提出**规则建议**:哪些夹子应该加一条什么规则,才能接住它们。

硬要求:
1. field 只能是 "title" / "intro" / "upper" 三个之一,any 最多 20 个词。
2. **每条建议必须给出 evidenceItemIds** —— 你**真的看过的**、这条规则能命中的条目 id。
   服务端会拿这组词当场跑一遍匹配:打不中你给的那些条目,这条建议就会被丢掉。
   所以别猜,只写你真的在下面列表里看到的条目。
3. because 用一句话说清依据。
4. **只输出一个 JSON 数组**,不要别的东西,不要解释,不要 markdown 围栏。`;

export function buildSuggestionPrompt(opts: {
  folders: readonly SuggestionFolder[];
  items: readonly ItemRow[];
}): string {
  const folders = opts.folders
    .map((f) => {
      const head = `[${f.folderId}] ${f.name}${f.rule ? ` —— ${f.rule}` : '(还没有规则)'}`;
      const samples = f.samples ?? [];
      return samples.length
        ? `${head}\n    现有条目:${samples.map((s) => `「${s}」`).join(' ')}`
        : head;
    })
    .join('\n');

  return [
    '## 收藏夹体系',
    folders,
    '',
    `## 这些条目没归上(${opts.items.length} 条)`,
    opts.items.map((i) => renderItem(i)).join('\n\n'),
    '',
    '给规则建议。输出 JSON 数组,字段:folderTempId / field / any / because / evidenceItemIds',
  ].join('\n');
}

const toRuleItem = (i: ItemRow): RuleItem => ({
  id: i.id, title: i.title, intro: i.intro, upperName: i.upper_name,
});

/**
 * 攒一次建议调用的**全部输入**。
 *
 * **两条路共用这一个函数** —— 归类后自动给(`run-pass-2`)和面板上主动要
 * (`POST /api/rules/suggest`)必须看到同一套东西,否则同一个模型会给出两套
 * 互相矛盾的建议。放在这里而不是各自的调用点:那样就成了两份会分叉的近似拷贝。
 *
 * `pool` = **规则没覆盖住的条目**(不是"AI 说 null 的那些") —— 理由见下面
 * `runSuggestions` 的注释。
 */
export function suggestionInput(db: Database.Database): {
  folders: SuggestionFolder[];
  /** 规则没覆盖住的条目 —— 进 prompt 的就是这些(还要再被 cap 切一次) */
  pool: ItemRow[];
  /** 全库条目 —— 自证时查它,它可能引用一条已经归到别处的条目当证据 */
  allItems: ItemRow[];
} {
  const rules = listRules(db);
  const ruleOf = new Map(rules.map((r) => [r.folderId, r]));
  const all = db.prepare(`SELECT * FROM items`).all() as ItemRow[];

  const folders: SuggestionFolder[] = listWorkFolders(db).map((w) => {
    const rule = renderConditions(ruleOf.get(w.id)?.conditions ?? []);
    // 有规则的夹子不用带样本(规则已经说清它是放什么的);没规则的才要 ——
    // 只看名字模型会自信地猜错,这是 §9C.0 那次真机事故的教训
    const samples = rule
      ? []
      : workItemIds(db, w.id)
          .slice(0, 3)
          .map((iid) => getItem(db, iid)?.title)
          .filter((t): t is string => !!t);
    return { folderId: w.id, name: w.name, rule, ...(samples.length ? { samples } : {}) };
  });

  const covered = matchAll(all.map(toRuleItem), rules);
  return { folders, pool: all.filter((i) => !covered.has(i.id)), allItems: all };
}

/** 和 buildPass2Prompt 里的 renderItem 同一口径(不导出:这边只需要标题+简介+UP) */
function renderItem(i: ItemRow, maxIntro = 120): string {
  const lines = [`[${i.id}] ${i.title}`];
  if (i.intro) {
    const intro = i.intro.length > maxIntro ? `${i.intro.slice(0, maxIntro)}…` : i.intro;
    lines.push(`  简介:${intro}`);
  }
  if (i.upper_name) lines.push(`  UP:${i.upper_name}`);
  return lines.join('\n');
}

/**
 * 跑一次建议调用。**返回的一定是过了自证的**(spec §9C.5 R7)。
 *
 * 任何失败都退化成空数组 —— 建议是"锦上添花",不该把归类那条路拖垮。
 *
 * ── 关于 `pool` / `homelessIds` / `cap` 这三个口径 ──────────────
 *
 * spec §9C.5 只说"给没归上的条目提建议",**没定到底喂哪一批**。这里定成:
 *
 * ① **pool = 规则没覆盖住的条目**(不是"AI 说 null 的那些")。依据:
 *    §9C.5(c) 第一条的字面原文就是"规则没覆盖住的条目聚成建议";而且它自己举的
 *    `because` 例子是"8 条**被归进别的夹子的**条目,标题都含这几个词" ——
 *    被归进别处 = AI 归成功了,所以输入必须包含 AI 归成功的条目。
 *    §9C.8 那句"AI 看到'这些条目没地方去'时就会提规则"说的是 AI 在输入里**注意到**
 *    什么,不是输入集合本身。
 * ② **cap = `batchSize(ctx)`**。这一条是必须的:第一次跑时一个夹子都没有规则,
 *    pool 就是全库 3250 条,每条带标题+简介约 250 token → 80 万 token,
 *    任何上下文窗口都装不下。复用 §3 已经算好的批大小,而不是另定一个魔数。
 * ③ **homeless 排最前**。cap 切的是尾巴,所以最该被看见的(AI 亲口说"拿不准"的)
 *    必须排最前,否则它们会被前面的条目挤掉。
 */
export async function runSuggestions(opts: {
  config: ModelConfig;
  folders: readonly SuggestionFolder[];
  /** 规则没覆盖住的条目 */
  pool: readonly ItemRow[];
  /** 归类时 AI 说"拿不准"的 id;空集 = 没什么可建议的,不调。不传 = 没有这个信息 */
  homelessIds?: ReadonlySet<string>;
  cap: number;
  allItems: readonly ItemRow[];
}): Promise<ValidSuggestion[]> {
  if (opts.folders.length === 0) return [];
  // 没有可提的东西就不调 —— 只在需要时付费(spec §9C.5 b)
  if (opts.pool.length === 0) return [];
  // 传了 homelessIds 就是"归类跑过"的场景:一条都没归上说明规则没漏掉什么
  if (opts.homelessIds && opts.homelessIds.size === 0) return [];

  const ordered = opts.homelessIds
    ? [
        ...opts.pool.filter((i) => opts.homelessIds!.has(i.id)),
        ...opts.pool.filter((i) => !opts.homelessIds!.has(i.id)),
      ]
    : [...opts.pool];
  const chosen = ordered.slice(0, Math.max(1, opts.cap));

  const raw = await complete({
    config: opts.config,
    messages: [
      { role: 'system', content: SUGGESTION_SYSTEM },
      { role: 'user', content: buildSuggestionPrompt({ folders: opts.folders, items: chosen }) },
    ],
  });

  const list = parseJsonArray(raw);
  if (!list) return [];

  const valid = validateSuggestions(list, {
    validFolderIds: new Set(opts.folders.map((f) => f.folderId)),
    // 自证查**全库** —— 它可能引用一条已经归到别处的条目当证据(spec 的例子就是)
    itemsById: new Map(opts.allItems.map((i) => [i.id, toRuleItem(i)])),
  });

  return mergeSuggestions(valid);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/suggestions.test.ts`
Expected: PASS(18 tests)

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/suggestions.ts server/src/curator/suggestions.test.ts
git commit -m "feat(curator): 规则建议单独一次调用 —— 只在有没归上的条目时付费

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 建议接两条路 —— 归类后自动给 + 面板上主动要

**Files:**
- Modify: `server/src/curator/ruleRoutes.ts`(追加 `POST /api/rules/suggest`)
- Modify: `server/src/curator/routes.ts`(`run-pass-2` 带上 suggestions)
- Test: `server/src/curator/ruleRoutes.test.ts`、`server/src/curator/routes.test.ts`

**Interfaces:**
- Consumes: Task 7 `runSuggestions` / `SuggestionFolder`;Task 6 的 `rulesWithHits` 里那套 items 读法;Task 5 的 `run-pass-2`
- Produces:
  - `POST /api/rules/suggest` → `{ suggestions: ValidSuggestion[] }`(且**不落库**)
  - `run-pass-2` 响应多一个 `suggestions: ValidSuggestion[]`

**spec §9C.5(c) 的两个来源**:① 跑完归类顺手给,② 你在界面上主动要。两条都调到**同一个** `runSuggestions`。

**建议不落库**(spec §9C.5):采纳即落库(变成规则),忽略即消失。刷新页面会丢 —— 但它可以从"重跑一次"再得到,而**采纳过的规则不会丢**。这是刻意的取舍:不为一个可重生的中间态加一张表。

- [ ] **Step 1: 写失败的测试**

先追加到 `server/src/curator/ruleRoutes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// LLM 全 mock —— 路由测试绝不打真实 API
const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', async (orig) => ({
  ...(await orig<typeof import('../llm/provider.js')>()),
  complete: mocks.complete,
}));
```

> 上面那段要**合并进文件已有的顶部 import/mock 区**(`vi.mock` 必须提到所有 import 之前生效 —— 用 `vi.hoisted` 就是为了这个)。已有的 `describe('规则路由')` 里加 `beforeEach(() => vi.clearAllMocks());`。

```ts
  it('POST /api/rules/suggest:好的留下,过不了自证的丢掉', async () => {
    const { app } = makeApp();
    // 用**返回的**工作夹子 id,不要写死 1 —— 那个数只是 AUTOINCREMENT 的巧合
    const id = await workcopy(app);
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: id, field: 'title', any: ['Python'], because: '同类', evidenceItemIds: ['BV1'] },
      { folderTempId: id, field: 'title', any: ['编的词'], because: '假的', evidenceItemIds: ['BV1'] },
    ]));

    const res = await app.inject({ method: 'POST', url: '/api/rules/suggest' });
    expect(res.statusCode).toBe(200);

    const { suggestions } = res.json();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].any).toEqual(['Python']);
    expect(suggestions[0].evidenceItemIds).toEqual(['BV1']);
    await app.close();
  });

  it('suggest 不落库 —— 刷新就没了,采纳过的才留下', async () => {
    const { app } = makeApp();
    const id = await workcopy(app);
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: id, field: 'title', any: ['Python'], because: '同类', evidenceItemIds: ['BV1'] },
    ]));

    await app.inject({ method: 'POST', url: '/api/rules/suggest' });

    const mine = (await app.inject({ url: '/api/rules' }))
      .json()
      .rules.find((r: { folderId: number }) => r.folderId === id);
    expect(mine.conditions).toEqual([]); // 没有自动变成规则
    await app.close();
  });

  it('suggest:没配模型 → 400', async () => {
    const { app, db } = makeApp();
    await workcopy(app);
    db.prepare(`DELETE FROM settings`).run();
    expect((await app.inject({ method: 'POST', url: '/api/rules/suggest' })).statusCode).toBe(400);
    await app.close();
  });
```

再追加到 `server/src/curator/routes.test.ts` 的 `describe('Pass 2')` 里:

```ts
  it('run-pass-2 带上建议 —— 有没归上的条目时才调,且不落库', async () => {
    const { app, db } = makeApp();
    seed(db);
    const work = await seedWorkcopy(app);

    // 第一次调用是归类(给 BV1/BV2 都填 null = 没归上),第二次是建议
    mocks.complete
      .mockResolvedValueOnce(
        `[{"itemId":"BV1","folderTempId":null,"confidence":0.1,"reason":"拿不准"},` +
          `{"itemId":"BV2","folderTempId":null,"confidence":0.1,"reason":"拿不准"}]`,
      )
      .mockResolvedValueOnce(JSON.stringify([
        { folderTempId: work, field: 'title', any: ['a'], because: '同类', evidenceItemIds: ['BV1'] },
      ]));

    const sid = await newSession(app);
    const body = (
      await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` })
    ).json();

    expect(body.suggestions).toHaveLength(1);
    expect(mocks.complete).toHaveBeenCalledTimes(2);

    // 建议不落库:classifications 里只有归类结果,规则表还是空的
    expect((await app.inject({ url: '/api/rules' })).json().rules.every(
      (r: { conditions: unknown[] }) => r.conditions.length === 0,
    )).toBe(true);
    await app.close();
  });

  it('run-pass-2:没有没归上的条目 → 不调建议那一次', async () => {
    const { app, db } = makeApp();
    seed(db);
    const work = await seedWorkcopy(app);
    mocks.complete.mockResolvedValue(
      `[{"itemId":"BV1","folderTempId":"${work}","confidence":0.9,"reason":"是"},` +
        `{"itemId":"BV2","folderTempId":"${work}","confidence":0.9,"reason":"是"}]`,
    );

    const sid = await newSession(app);
    const body = (
      await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` })
    ).json();

    expect(body.suggestions).toEqual([]);
    expect(mocks.complete).toHaveBeenCalledTimes(1); // 只有归类那一次
    await app.close();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/ruleRoutes.test.ts src/curator/routes.test.ts`
Expected: FAIL —— `suggest` 路由 404;`body.suggestions` 是 `undefined`

- [ ] **Step 3: 实现 —— 建议的输入**

**不在这个文件里自己攒输入** —— 用 Task 7 的 `suggestionInput(db)`。那是"喂什么给模型"的唯一一处,**两条路共用**;在这里再写一份近似拷贝,就是两份迟早分叉的口径(同一个模型会给出两套互相矛盾的建议)。

`ruleRoutes.ts` 顶部 import 补:

```ts
import { listWorkFolders } from '../db/repo/workbench.js';
import { runSuggestions, suggestionInput } from './suggestions.js';
```

> `runSuggestions` 的 `cap` 传 `batchSize(llm.ctx)` —— `batchSize` 和 `readLlmSettings` 都已经在这个文件的 import 里了(Task 6 的 dry-run 用了它们)。

- [ ] **Step 4: 实现 —— 面板上主动要的那条路**

追加到 `registerRuleRoutes` 内(放在 `dry-run` 之前):

```ts
  /**
   * 面板上「让 AI 看看规则」——建议的**第二个来源**(spec §9C.5 c)。
   *
   * **不落库**:建议是个可重生的中间态,采纳即变成规则、忽略即消失。
   * 为它加一张表不值得。
   */
  app.post('/api/rules/suggest', async (req, reply) => {
    const llm = readLlmSettings(db);
    if (!llm) {
      // 和 curator/routes.ts 的 requireLlm 同一句话 —— 用户看到的是同一个原因
      return reply.code(400).send({
        ok: false, reason: '还没配模型 —— 先去「授权」页的模型管理里选一个',
      });
    }

    const { folders, pool, allItems } = suggestionInput(db);
    try {
      const suggestions = await runSuggestions({
        config: llm.config,
        folders,
        pool,
        // 这条路没有"哪些是 AI 说拿不准的"这个信息(没跑归类)—— 不传 homelessIds,
        // 也就没有那道省钱闸。用户是**主动**点的这个按钮,他想看就看。
        cap: batchSize(llm.ctx),
        allItems,
      });
      return { suggestions };
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      deps.log.event({ level: 'error', category: 'llm', code: 'SUGGEST_FAILED', message });
      return reply.code(502).send({ ok: false, reason: message });
    }
  });
```

- [ ] **Step 5: 实现 —— 归类后自动给的那条路**

在 `server/src/curator/routes.ts` 的 `run-pass-2` 里,把 `try` 块中 `saveClassification` 之后到 `return` 之间改成:

```ts
        const assignments = [...ruleAssignments, ...result.assignments];
        saveClassification(db, id, assignments, result.failedBatches);

        // ── ③ 建议:AI 的第二个通道(spec §9C.5 b/c)────────────
        // **单独一次调用**,而且只在"真的有条目没归上"时才付费(那道闸在
        // runSuggestions 里:homelessIds 为空集就直接返回)。失败不影响归类结果 ——
        // 建议是锦上添花,不该把已经跑通的那条路拖垮。
        const input = suggestionInput(db);
        const homelessIds = new Set(
          result.assignments.filter((a) => a.folderTempId === null).map((a) => a.itemId),
        );
        const suggestions: ValidSuggestion[] = await runSuggestions({
          config: llm.config,
          folders: input.folders,
          pool: input.pool,
          homelessIds,
          cap: batchSize(llm.ctx),
          allItems: input.allItems,
        }).catch((e: unknown) => {
          log.event({
            level: 'warn',
            category: 'llm',
            code: 'SUGGEST_FAILED',
            message: (e as Error)?.message ?? String(e),
          });
          return [] as ValidSuggestion[];
        });

        if (suggestions.length > 0) {
          log.event({
            level: 'info',
            category: 'llm',
            message: `规则建议:${homelessIds.size} 条没归上,提出 ${suggestions.length} 条建议`,
          });
        }

        log.event({
          level: 'info',
          category: 'llm',
          message: `Pass 2 完成:规则 ${ruleAssignments.length} 条 + AI ${result.assignments.length} 条,${
            result.failedBatches.length
          } 批失败`,
        });

        return {
          assignments,
          failedBatches: result.failedBatches,
          total: items.length,
          /** 分栏要如实 —— 哪些是规则归的、哪些是 AI 归的(spec §9C.3 ③) */
          ruleCount: items.length - rest.length,
          aiCount: result.assignments.filter((a) => a.folderTempId !== null).length,
          /** 建议**不落库** —— 随结果回,刷新就没了(spec §9C.5) */
          suggestions,
          batchSize: batchSize(llm.ctx),
        };
```

`routes.ts` 顶部 import 补:

```ts
import { runSuggestions, suggestionInput, type ValidSuggestion } from './suggestions.js';
```

> **"喂什么给模型"只有 `suggestionInput(db)` 一处**(Task 7)。所以两条路必然看到同一套体系、同一个 pool、同一个 cap 口径 —— 这一条不再靠"两边自觉照抄",而是结构上就只有一份。
>
> 仍然重复的只有**给夹子配样本标题**那 8 行(`run-pass-2` 为了 Pass 2 的 prompt 也要给 `FolderSpec.rule` / samples)。那是两套不同的出口类型(`FolderSpec` 有 `tempId` / `description` / `estCount`,`SuggestionFolder` 有 `folderId`),为了消掉 8 行去合并两个不同形状的类型不划算。**这是有意保留的重复**,不是漏看。

- [ ] **Step 6: 跑测试确认通过**

Run: `npm test -w server -- src/curator/ruleRoutes.test.ts src/curator/routes.test.ts`
Expected: PASS

- [ ] **Step 7: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/ruleRoutes.ts server/src/curator/ruleRoutes.test.ts server/src/curator/routes.ts server/src/curator/routes.test.ts
git commit -m "feat(curator): 建议接两条路 —— 归类后自动给 + 面板上主动要

两条路走同一个 runSuggestions;建议不落库(可重生的中间态不值得一张表)。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: 聊天里能看到规则(不等同于出结构化建议)

**Files:**
- Modify: `server/src/curator/chat.ts`(`renderStructure` 带上规则、`SYSTEM_PROMPT` 补一句)
- Test: `server/src/curator/chat.test.ts`

**Interfaces:**
- Consumes: Task 1 `listRules`;Task 2 `renderConditions`
- Produces: 无新导出 —— `buildContext` / `chatStream` 的签名不变,变的是结构块的**内容**

**为什么只做到这一步**:spec §9C.5(c) 第二条是「你在对话框里主动问 —— AI 分析现有规则,给出改进建议」。**结构化建议按本计划的口径一律走 `POST /api/rules/suggest`**(两条路同一个调用)—— 聊天是纯文本 SSE,里面没有"这是一条结构化建议"的带内标记,硬塞要自己设计一层传输。所以这里只把**规则本身**放进上下文,让 AI 看得见规则、能就规则对话。

`samples` 不放进来 —— 聊天是开放对话,不是"给你这批条目做归类",塞 3 条标题只会挤掉对话预算。

- [ ] **Step 1: 写失败的测试**

追加到 `server/src/curator/chat.test.ts` 的 `describe('buildContext')` 里:

```ts
  // spec §9C.5 c:对话框里要能聊规则。而在这之前 renderStructure 只渲染夹子名+条数,
  // 模型一个规则都看不见 —— 无从"分析现有规则"。
  it('结构块带上规则 —— 模型才可能就规则给建议', () => {
    const { db, sid } = fresh();
    seedLibrary(db, { workcopy: true });
    const work = listWorkFolders(db)[0]!;
    saveRule(db, work.id, [{ field: 'title', any: ['Python', 'Rust'] }], 'user');

    const { messages } = buildContext(db, sid, smallCtx);
    expect(structureOf(messages)?.content).toContain('标题含 Python/Rust');
  });

  it('没有规则的夹子明说"还没有规则" —— 别让模型以为规则是空的而不是没有', () => {
    const { db, sid } = fresh();
    seedLibrary(db, { workcopy: true });

    const { messages } = buildContext(db, sid, smallCtx);
    const content = structureOf(messages)?.content ?? '';
    // 条数那段原样保留(工作副本口径)
    expect(content).toContain('深度学习(1 条)');
    expect(content).toContain('还没有规则');
  });

  it('退回快照时不谈规则 —— 规则挂在工作副本的夹子上,快照里没有这回事', () => {
    const { db, sid } = fresh();
    seedLibrary(db);
    const { messages } = buildContext(db, sid, smallCtx);
    expect(structureOf(messages)?.content).not.toContain('规则');
  });
```

并在文件顶部 import 里加:

```ts
import { saveRule } from '../db/repo/rules.js';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/chat.test.ts`
Expected: FAIL —— 断言 `标题含 Python/Rust` 找不到

- [ ] **Step 3: 实现**

把 `server/src/curator/chat.ts:68-74` 的 `renderStructure` 换成:

```ts
function renderStructure(db: Database.Database): string {
  const work = listWorkFolders(db);
  if (work.length > 0) {
    // 规则一起带上 —— 用户问「规则该怎么改」时,模型必须先看得见现有规则
    // (spec §9C.5 c)。规则只挂在工作副本的夹子上,所以快照那条路不带它。
    const ruleOf = new Map(listRules(db).map((r) => [r.folderId, r]));
    return work
      .map((w) => {
        const rule = renderConditions(ruleOf.get(w.id)?.conditions ?? []);
        return `- ${w.name}(${workItemIds(db, w.id).length} 条) —— ${
          rule ? `规则:${rule}` : '还没有规则'
        }`;
      })
      .join('\n');
  }
  return listFolders(db).map((f) => `- ${f.title}(${f.media_count} 条)`).join('\n');
}
```

`chat.ts` 顶部 import 补:

```ts
import { listRules } from '../db/repo/rules.js';
import { renderConditions } from './rules.js';
```

并在 `SYSTEM_PROMPT`(`chat.ts:38`)里补一句 —— 加在它现有条目之后:

```
用户问「规则该怎么改 / 这个夹子该加什么规则」时,直接说你看到的问题和该加的词。
规则由用户在「规则」页维护,你不能直接改它。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/chat.test.ts`
Expected: PASS(原有 21 条 + 新增 3 条)

> 原有的 `'工作副本以 system 身份注入'` 断言的是 `toContain('深度学习(1 条)')` —— 新格式在 `(1 条)` 之后追加了 ` —— 还没有规则`,那个子串仍然存在,所以它照旧过。

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/chat.ts server/src/curator/chat.test.ts
git commit -m "feat(curator): 聊天的体系上下文带上规则 —— 模型才可能就规则发言

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: 前端类型与 API

**Files:**
- Modify: `web/src/types.ts`(追加)
- Modify: `web/src/api.ts`(导出 `json`、追加 `rulesApi`)
- Test: 无(前端没有测试框架,`npm run typecheck` 是唯一验证)

**Interfaces:**
- Consumes: Task 6 的路由形状、Task 3 的 `ValidSuggestion` 形状、Task 5 的 `run-pass-2` 新字段
- Produces: `rulesApi`,以及 `RuleField` / `RuleCondition` / `RuleOrigin` / `RuleView` / `DryRun` / `RuleSuggestion`

- [ ] **Step 1: 加类型**

追加到 `web/src/types.ts`:

```ts
// ── M4c:规则 ────────────────────────────────────────────

export type RuleField = 'title' | 'intro' | 'upper';

/** 一条条件 = "某字段里命中任一关键词"。条件之间 OR */
export interface RuleCondition {
  field: RuleField;
  any: string[];
}

/** 谁写的 —— 界面上一眼看出这是谁的主意(🤖 / ✎) */
export type RuleOrigin = 'ai' | 'user';

/** /api/rules 的一行:每个工作夹子一行,没规则的也在 */
export interface RuleView {
  folderId: number;
  folderName: string;
  /** 锁定的夹子不能加规则 */
  locked: boolean;
  /** 空数组 = 还没有规则 */
  conditions: RuleCondition[];
  /** null = 还没人写过 */
  origin: RuleOrigin | null;
  updatedAt: number | null;
  /** 命中数:这条规则会从**全库**捞走多少条 */
  hit: number;
}

/** 试跑:规则能覆盖多少条、剩下多少要给 AI */
export interface DryRun {
  covered: number;
  remaining: number;
  /** 没配模型时是 null */
  batches: number | null;
}

/**
 * 一条 AI 规则建议。**过了自证才有**(服务端会拿这组词去跑匹配验证)。
 * 建议不落库 —— 采纳才变成规则。
 */
export interface RuleSuggestion {
  folderId: number;
  field: RuleField;
  any: string[];
  because: string;
  /** 它声称会命中的条目 —— 建议可信度的来源 */
  evidenceItemIds: string[];
}
```

并给 `Pass2Response` 补上 Task 5 加的两个字段:

```ts
export interface Pass2Response {
  assignments: Assignment[];
  failedBatches: FailedBatch[];
  total: number;
  batchSize: number;
  /** 规则归了几条条目(spec §9C.3 ③ 要如实分栏) */
  ruleCount: number;
  /** AI 归了几条 */
  aiCount: number;
  /** 没归上的那些条目攒出来的建议 —— 不落库,刷新就没了 */
  suggestions: RuleSuggestion[];
}
```

- [ ] **Step 2: 导出 `json` 并加 `rulesApi`**

在 `web/src/api.ts` 里把 `function json<T>(` 改成 `export function json<T>(` —— 加一个词。

> 它现在是模块私有的;`rulesApi` 要在同文件里用它,本来不需要导出。但 Task 12 的「改一下」路径也在同文件,导出能省一次重构。**关键是别漏掉无 body 时不带 `content-type` 那条**(`api.ts:40-49` 那段注释记录了实测的 Fastify `FST_ERR_CTP_EMPTY_JSON_BODY` 坑)。

在 `web/src/types.ts` 的 import 里加上 `DryRun` / `RuleCondition` / `RuleSuggestion` / `RuleView`,然后追加:

```ts
// ── M4c:规则 ────────────────────────────────────────────

export const rulesApi = {
  list: () => api<{ rules: RuleView[] }>('/api/rules').then((r) => r.rules),

  /** 整组条件覆盖(你手写的路 —— origin 记 'user') */
  save: (folderId: number, conditions: RuleCondition[]) =>
    json<{ ok: true }>('PUT', `/api/rules/${folderId}`, { conditions }),

  remove: (folderId: number) => json<{ ok: true }>('DELETE', `/api/rules/${folderId}`),

  /** 采纳一条建议 = **追加**一个条件(origin 记 'ai'),不是覆盖 */
  adopt: (folderId: number, s: Omit<RuleSuggestion, 'folderId'>) =>
    json<{ ok: true }>('POST', `/api/rules/${folderId}/adopt`, s),

  /** 试跑:规则覆盖多少、剩多少给 AI、几批 */
  dryRun: () => json<DryRun>('POST', '/api/rules/dry-run'),

  /** 让 AI 看看规则 —— 建议**不落库**,刷新就没了 */
  suggest: () => json<{ suggestions: RuleSuggestion[] }>('POST', '/api/rules/suggest'),
};
```

- [ ] **Step 3: typecheck**

Run: `cd web && npm run typecheck`
Expected: 无输出(通过)

> 若因为 `Pass2Response` 新增三个**必填**字段而在别处报错,说明那里手工构造过这个类型 —— 改成从接口取,不要给字段加 `?`。

- [ ] **Step 4: 提交**

```bash
git add web/src/types.ts web/src/api.ts
git commit -m "feat(web): 规则的类型与 API 封装

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: `/rules` 接真数据 —— 规则表 + 就地编辑 + 命中数 + 试跑

**Files:**
- Modify: `web/src/components/RulesPanel.tsx`(整体替换)
- Modify: `web/src/pages/rules.tsx`(删掉"这是假数据"的说明、加试跑结果那一行)

**Interfaces:**
- Consumes: Task 10 的 `rulesApi` / `RuleView` / `RuleCondition` / `DryRun`
- Produces:`<RulesPanel focusFolderId? />` —— Task 12 会往它里面加 AI 建议栏

**这一任务要做的**:把假数据换成真接口。AI 建议那一栏**留给 Task 12**(它在后端要 `POST /api/rules/suggest`,也就是 Task 8)。所以本任务只做:**规则表 + 就地编辑 + 命中数 + 试跑**。

**spec §9C.4 界面上的四条规矩**(原型里已经跑通,替换时保留):

1. **就地展开编辑,不弹窗** —— 改规则时你**必须同时看着「命中几条」**,弹窗会把表盖住。
2. AI 建议置顶且单独一栏(Task 12)。
3. **「来源」列 🤖 / ✎**。
4. **「试跑:规则 vs AI」** —— 判断"规则写够了没有"的唯一依据,必须顺手就能点。

- [ ] **Step 1: 整体替换组件**

`web/src/components/RulesPanel.tsx` 整个文件换成:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Select, Tooltip } from 'antd';
import { ChevronDown, ChevronRight, Plus, Trash2, Zap } from 'lucide-react';
import { rulesApi } from '../api';
import type { DryRun, RuleCondition, RuleField, RuleView } from '../types';

/**
 * 规则管理器(spec §9C.4)。
 *
 * 规则是这产品**唯一比 B站 多的东西** —— bilibili 有夹子但没有逻辑,
 * 谁进谁出全靠手。规则就是那个判据,而且它只存在本地。
 */
const FIELD_LABEL: Record<RuleField, string> = { title: '标题', intro: '简介', upper: 'UP 名' };

/** 列表里那一行的一句话 —— 表头 + 行都要用它,分两处写迟早分叉 */
const renderRule = (conditions: RuleCondition[]): string =>
  conditions.map((c) => `${FIELD_LABEL[c.field]}含 ${c.any.join('·')}`).join('  ·  ');

export default function RulesPanel({ focusFolderId = null }: { focusFolderId?: number | null }) {
  const { modal } = AntApp.useApp();
  const [rules, setRules] = useState<RuleView[]>([]);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setRules(await rulesApi.list());
  }, []);

  useEffect(() => {
    reload()
      .then(() => {
        if (focusFolderId !== null) setOpen(focusFolderId);
      })
      .catch((e) => setError((e as Error).message));
  }, [reload, focusFolderId]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      // 命中数每次重算 —— 那是调规则时唯一的反馈(§9C.4 规矩 1)
      await reload();
      // 规则变了,上一次的试跑结果就过期了
      setDry(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setConditions = (folderId: number, conditions: RuleCondition[]) =>
    act(() => rulesApi.save(folderId, conditions));

  const current = rules.find((r) => r.folderId === open);
  const withRules = rules.filter((r) => r.conditions.length > 0).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && (
        <div
          className="hud-panel"
          style={{ padding: 10, borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 'var(--fs-12)' }}
        >
          {error}
        </div>
      )}

      <div className="hud-panel" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span className="hud-label">规则</span>
          <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            {rules.length} 个夹子 · {withRules} 条规则
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Button
              size="small"
              icon={<Plus size={13} />}
              disabled={!rules.length || busy}
              onClick={() => {
                // 找一个还没规则的夹子开一条空规则 —— 锁定的不给
                const target =
                  rules.find((r) => !r.locked && r.conditions.length === 0) ??
                  rules.find((r) => !r.locked);
                if (!target) return;
                setOpen(target.folderId);
                if (target.conditions.length === 0) {
                  void setConditions(target.folderId, [{ field: 'title', any: [] }]);
                }
              }}
            >
              新增规则
            </Button>
            <Button
              size="small"
              icon={<Zap size={13} />}
              loading={busy}
              onClick={() => act(async () => setDry(await rulesApi.dryRun()))}
            >
              试跑:规则 vs AI
            </Button>
          </span>
        </div>

        {dry && (
          <div
            className="hud-panel"
            style={{ padding: '6px 10px', marginBottom: 10, fontSize: 'var(--fs-12)', borderColor: 'var(--accent)' }}
          >
            规则覆盖 <span className="num" style={{ color: 'var(--accent)' }}>{dry.covered.toLocaleString()}</span> 条
            · 剩 <span className="num">{dry.remaining.toLocaleString()}</span> 条要交给 AI
            {dry.batches !== null && <> · 约 <span className="num">{dry.batches}</span> 批</>}
          </div>
        )}

        {/* 表头 —— 密集行 + 发丝线,数据工具该长得像表格(§11:不用卡片装列表) */}
        <div style={{ display: 'flex', gap: 10, padding: '0 4px 6px', borderBottom: '1px solid var(--rule)' }}>
          <span className="hud-label" style={{ width: 150, flex: 'none' }}>夹子</span>
          <span className="hud-label" style={{ flex: 1 }}>规则</span>
          <span className="hud-label" style={{ width: 64, flex: 'none', textAlign: 'right' }}>命中</span>
          <span className="hud-label" style={{ width: 44, flex: 'none', textAlign: 'center' }}>来源</span>
        </div>

        {rules.length === 0 && (
          <div style={{ padding: '14px 4px', color: 'var(--text-dim)', fontSize: 'var(--fs-12)' }}>
            还没有工作副本 —— 先去「整理」页改一处,规则才挂得上。
          </div>
        )}

        {rules.map((r) => {
          const isOpen = open === r.folderId;
          return (
            <div key={r.folderId} style={{ borderBottom: '1px solid var(--rule)' }}>
              <div
                onClick={() => !r.locked && setOpen(isOpen ? null : r.folderId)}
                style={{
                  display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 4px',
                  cursor: r.locked ? 'default' : 'pointer',
                  background: isOpen ? 'var(--surface-2)' : 'transparent',
                }}
              >
                <span
                  style={{
                    width: 150, flex: 'none', display: 'flex', alignItems: 'center', gap: 5,
                    fontSize: 'var(--fs-13)', color: r.locked ? 'var(--text-dim)' : 'var(--text)',
                  }}
                >
                  {!r.locked && (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                  {r.locked && <span style={{ width: 12 }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.folderName}
                  </span>
                </span>

                <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                  {r.locked
                    ? '—— 锁定的夹子不加规则'
                    : r.conditions.length === 0
                      ? '—— 还没写规则,归类时靠 AI'
                      : renderRule(r.conditions)}
                </span>

                <span
                  className="num"
                  style={{
                    width: 64, flex: 'none', textAlign: 'right', fontSize: 'var(--fs-12)',
                    color: r.hit > 0 ? 'var(--accent)' : 'var(--text-dim)',
                  }}
                >
                  {r.hit > 0 ? r.hit : '—'}
                </span>

                <span style={{ width: 44, flex: 'none', textAlign: 'center', fontSize: 12 }}>
                  {r.origin === null ? (
                    <span style={{ color: 'var(--text-dim)' }}>—</span>
                  ) : r.origin === 'ai' ? (
                    <Tooltip title="AI 提的"><span style={{ color: 'var(--ai)' }}>🤖</span></Tooltip>
                  ) : (
                    <Tooltip title="你写的"><span style={{ color: 'var(--text-dim)' }}>✎</span></Tooltip>
                  )}
                </span>
              </div>

              {isOpen && current?.folderId === r.folderId && (
                <ConditionsEditor
                  conditions={r.conditions}
                  busy={busy}
                  onChange={(next) => setConditions(r.folderId, next)}
                  onDelete={() =>
                    modal.confirm({
                      title: `删掉「${r.folderName}」的规则?`,
                      content: '只删规则,夹子和里面的条目都不动。',
                      okText: '删除', okButtonProps: { danger: true }, cancelText: '算了',
                      onOk: () => act(() => rulesApi.remove(r.folderId)),
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
        规则命中的条目会<span style={{ color: 'var(--accent)' }}> 0 token 直接归位</span>,
        剩下的才交给 AI。一条条目可以同时命中多个夹子 —— 那就都归(B站 本来也允许)。
      </div>
    </div>
  );
}

/**
 * 就地编辑,不弹窗 —— 改规则时你**必须同时看着"命中几条"**,弹窗会把表盖住。
 * 加个词 → 看命中数跳 → 删掉重来,这个来回就是调规则的全部体验(§9C.4 规矩 1)。
 */
function ConditionsEditor({
  conditions, busy, onChange, onDelete,
}: {
  conditions: RuleCondition[];
  busy: boolean;
  onChange: (next: RuleCondition[]) => void;
  onDelete: () => void;
}) {
  const patch = (i: number, next: Partial<RuleCondition>) =>
    onChange(conditions.map((c, idx) => (idx === i ? { ...c, ...next } : c)));

  return (
    <div style={{ padding: '4px 4px 12px 26px' }}>
      {conditions.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <Select
            size="small"
            value={c.field}
            onChange={(v: RuleField) => patch(i, { field: v })}
            style={{ width: 92 }}
            options={(Object.keys(FIELD_LABEL) as RuleField[]).map((f) => ({
              value: f,
              label: FIELD_LABEL[f],
            }))}
          />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>含</span>
          <Select
            size="small"
            mode="tags"
            value={c.any}
            onChange={(v: string[]) => patch(i, { any: v })}
            placeholder="打下关键词,回车确认"
            style={{ flex: 1, minWidth: 240 }}
            tokenSeparators={[',', '、', ' ']}
          />
          <Button
            size="small"
            type="text"
            danger
            icon={<Trash2 size={12} />}
            onClick={() => onChange(conditions.filter((_, idx) => idx !== i))}
          />
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <Button
          size="small"
          icon={<Plus size={12} />}
          disabled={busy}
          onClick={() => onChange([...conditions, { field: 'title', any: [] }])}
        >
          再加一个条件(或)
        </Button>
        <Button size="small" type="text" danger disabled={busy} onClick={onDelete}>
          删掉这条规则
        </Button>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>改完自动保存,命中数会跟着变</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 页面外壳**

`web/src/pages/rules.tsx` 换成:

```tsx
import { useSearchParams } from '@umijs/max';
import RulesPanel from '../components/RulesPanel';

/**
 * /rules 规则 —— **和「整理」同级的顶级 tab**。
 *
 * 为什么不挂在 /curator 底下当子 tab:规则是这产品唯一比 B站 多的东西
 * (bilibili 有夹子但没有逻辑,谁进谁出全靠手),子 tab 是把它当附属品。
 */
export default function RulesPage() {
  // ?folder=<workFolderId> —— 从「整理」的夹子行跳过来时直接展开那一行(Task 13)
  const [params] = useSearchParams();
  const folder = Number(params.get('folder'));
  const focus = Number.isInteger(folder) && folder > 0 ? folder : null;

  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="hud-label" style={{ color: 'var(--accent)' }}>规则</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          夹子只是个筐;规则决定谁该进去。它只存在本地,不上传 B站
        </span>
      </div>
      <RulesPanel focusFolderId={focus} />
      <div style={{ height: 56, flex: 'none' }} aria-hidden />
    </div>
  );
}
```

> 原型里那段「⚠️ 这一页是界面原型,数据全是假的」随之消失 —— 现在是真的了。

- [ ] **Step 3: typecheck + build**

Run: `cd web && npm run typecheck && npx max build`
Expected: 都通过

- [ ] **Step 4: 提交**

```bash
git add web/src/components/RulesPanel.tsx web/src/pages/rules.tsx
git commit -m "feat(web): /rules 接真数据 —— 规则表 + 就地编辑 + 命中数 + 试跑

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: `/rules` 的 AI 建议栏(采纳 / 改一下 / 忽略)

**Files:**
- Modify: `web/src/components/RulesPanel.tsx`(在 Task 11 的成品上加一栏)
- Test: 无(前端没有测试框架,`npm run typecheck` + `npx max build` 是验证)

**Interfaces:**
- Consumes: Task 10 的 `rulesApi.suggest` / `rulesApi.adopt` / `RuleSuggestion`;Task 6 的 adopt 路由(追加语义)
- Produces: 无新导出

**spec §9C.4 规矩 2**:**AI 建议置顶且单独一栏**。它是"待你处理"的东西,不混在规则表里。每条可 **采纳 / 改一下 / 忽略**。

**三条交互的语义**(别让它们互相越界):

| 动作 | 做什么 | `origin` 变成 |
|---|---|---|
| **采纳** | `POST /api/rules/:id/adopt` —— 给那个夹子**追加**一条条件 | `ai` |
| **改一下** | 先采纳(词先进库),再把那一行展开聚焦,你改完 `PUT` 覆盖 | 你改了就变 `user`(如实) |
| **忽略** | 只是从内存里去掉 —— 建议本来就没落库 | 不变 |

- [ ] **Step 1: 加状态与取建议的动作**

在 `RulesPanel.tsx` 顶部的 `import { rulesApi } from '../api';` 那一行下面,把类型 import 补上 `RuleSuggestion`:

```tsx
import type { DryRun, RuleCondition, RuleField, RuleSuggestion, RuleView } from '../types';
```

在 `RulesPanel` 的 state 区(`const [busy, setBusy] = useState(false);` 之后)加:

```tsx
  // AI 的建议 —— **只在内存里**(服务端也不落库)。采纳即变成规则,忽略即消失,
  // 刷新页面会丢 —— 但它可以从"重跑一次"再得到(spec §9C.5)。
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
```

在 `current` / `withRules` 那两行之前加取建议的动作:

```tsx
  /** 让 AI 看看规则。不走 act() —— 它不该清掉试跑结果,也不该重算命中数 */
  const askAi = async () => {
    setError('');
    setSuggesting(true);
    try {
      setSuggestions((await rulesApi.suggest()).suggestions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };

  const dropSuggestion = (s: RuleSuggestion) =>
    setSuggestions((list) =>
      list.filter((x) => !(x.folderId === s.folderId && x.field === s.field && x.any.join() === s.any.join())),
    );

  /** 采纳 = 追加一条条件(不是覆盖);改一下 = 先采纳再把那一行摊开给你改 */
  const takeSuggestion = async (s: RuleSuggestion, andEdit: boolean) => {
    const { folderId, ...rest } = s;
    await act(() => rulesApi.adopt(folderId, rest));
    dropSuggestion(s);
    if (andEdit) setOpen(folderId);
  };
```

> `act()` 里已经做了 `reload()` + 清掉试跑结果,所以采纳之后命中数会立刻跟着变 —— 那正是"该不该采纳"的反馈。

- [ ] **Step 2: 加那一栏**

在 `RulesPanel` 的 `return (` 里、错误条 `<div className="hud-panel" ...>{error}</div>` 那段**之后**、规则表面板**之前**插入:

```tsx
      {/* ── AI 的建议:置顶且单独一栏 —— 它是"待你处理"的东西(§9C.4 规矩 2)── */}
      {(suggestions.length > 0 || suggesting) && (
        <div className="hud-panel" style={{ padding: 12, borderColor: 'var(--ai)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Bot size={14} style={{ color: 'var(--ai)' }} />
            <span className="hud-label" style={{ color: 'var(--ai)' }}>AI 的建议</span>
            <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
              {suggestions.length}
            </span>
            {suggestions.length > 1 && (
              <Button
                size="small"
                style={{ marginLeft: 'auto' }}
                disabled={busy}
                onClick={() => {
                  // 一条一条来 —— adopt 是追加,并发写同一个夹子会互相覆盖
                  void (async () => {
                    for (const s of [...suggestions]) await takeSuggestion(s, false);
                  })();
                }}
              >
                全部采纳
              </Button>
            )}
          </div>

          {suggestions.length === 0 && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>AI 正在看……</div>
          )}

          {suggestions.map((s) => {
            const name = rules.find((r) => r.folderId === s.folderId)?.folderName ?? `夹子 ${s.folderId}`;
            return (
              <div
                key={`${s.folderId}-${s.field}-${s.any.join()}`}
                style={{
                  borderLeft: '2px solid var(--ai)', background: 'var(--surface-2)',
                  padding: '8px 10px', marginBottom: 6,
                }}
              >
                <div style={{ fontSize: 'var(--fs-13)' }}>
                  「{name}」加一条:
                  <span style={{ color: 'var(--ai)' }}>
                    {' '}{FIELD_LABEL[s.field]}含 {s.any.join(' · ')}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 6px', lineHeight: 1.6 }}>
                  依据:{s.because || '(没给依据)'}
                  {/* 自证过的证据 —— 这是"该不该信它"的全部依据(§9C.5 R7) */}
                  <span className="num"> · 命中 {s.evidenceItemIds.length} 条</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button
                    size="small" type="primary" icon={<Check size={12} />}
                    disabled={busy} onClick={() => void takeSuggestion(s, false)}
                  >
                    采纳
                  </Button>
                  <Button
                    size="small" icon={<Pencil size={12} />}
                    disabled={busy} onClick={() => void takeSuggestion(s, true)}
                  >
                    改一下
                  </Button>
                  <Button
                    size="small" type="text" icon={<X size={12} />}
                    disabled={busy} onClick={() => dropSuggestion(s)}
                  >
                    忽略
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
```

- [ ] **Step 3: 把「让 AI 看看规则」按钮加上**

在规则表头部那个 `<span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>` 里,**试跑按钮之前**插入:

```tsx
            <Button
              size="small"
              icon={<Bot size={13} />}
              loading={suggesting}
              disabled={!rules.length || busy}
              onClick={() => void askAi()}
            >
              让 AI 看看规则
            </Button>
```

并在 `lucide-react` 的 import 里补上 `Bot, Check, Pencil, X`:

```tsx
import { Bot, Check, ChevronDown, ChevronRight, Pencil, Plus, Trash2, X, Zap } from 'lucide-react';
```

- [ ] **Step 4: typecheck + build**

Run: `cd web && npm run typecheck && npx max build`
Expected: 都通过

- [ ] **Step 5: 提交**

```bash
git add web/src/components/RulesPanel.tsx
git commit -m "feat(web): /rules 的 AI 建议栏 —— 采纳 / 改一下 / 忽略

采纳是**追加**一条条件(origin 记 ai),不是覆盖;改一下 = 先采纳再摊开那一行;
忽略只是从内存里去掉(建议本来就没落库)。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 13: 从夹子行一键跳到它的规则

**Files:**
- Modify: `web/src/components/WorkFolderTree.tsx`(夹子行加一个跳转图标)
- Modify: `web/src/pages/curator.tsx`(传回调)
- Test: 无(前端没有测试框架)

**Interfaces:**
- Consumes: Task 11 的 `?folder=<id>` 约定
- Produces: `<WorkFolderTree>` / `FolderRow` 各多一个 prop `onShowRule: (folderId: number) => void`

**为什么**:规则和夹子分了家(规则属于某个夹子,但 `/rules` 上看不到树)。spec §9C.4 的原文:「`/curator` 的夹子行上给一个跳转,直接跳到 `/rules` 并**定位到那个夹子的规则行**」。这个跳转就是那条缝的补丁。

- [ ] **Step 1: 树加一个跳转图标**

在 `web/src/components/WorkFolderTree.tsx` 的 `import { ChevronRight, ChevronDown, Lock, Pencil, Check, X, Combine, Trash2 } from 'lucide-react';` 里加上 `SlidersHorizontal`:

```tsx
import { ChevronRight, ChevronDown, Lock, Pencil, Check, X, Combine, Trash2, SlidersHorizontal } from 'lucide-react';
```

给 `WorkFolderTree` 和 `FolderRow` 两处 props 声明各加一行(和 `onToggleLock: (originId: number, locked: boolean) => void;` 并排):

```tsx
    /** 跳到 /rules 并定位到这个夹子的规则行 */
    onShowRule: (folderId: number) => void;
```

并在两处的解构参数里各加 `onShowRule,`(和 `onToggleLock,` 并排),以及两处向下传 `onShowRule={onShowRule}`。

在 `FolderRow` 里那个"✎ 改名"按钮(`<Pencil size={11} />` 那个)`**之前**插入 —— 它在 `{!folder.locked && (<>` 块里,但**规则和锁无关时也要能看**,所以放在那个条件块**外面、它之前**:

```tsx
              {/* 跳到 /rules 并定位到这一行的规则 —— 规则和夹子分了家,这条缝要补(§9C.4) */}
              <button
                type="button"
                aria-label={`看「${folder.name}」的规则`}
                title="看它的规则"
                onClick={() => onShowRule(folder.id)}
                style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5 }}
              >
                <SlidersHorizontal size={11} />
              </button>
```

> 用 `<button>` 而不是 antd `<Button>` —— 这一排现有的图标按钮全是裸 `<button>` + 内联样式,照抄它们的形状(见同文件里改名/合并/删除那三个)。

- [ ] **Step 2: curator 传回调**

在 `web/src/pages/curator.tsx` 顶部 import 里加:

```tsx
import { useNavigate } from '@umijs/max';
```

> 它现在只从 `@umijs/max` 引入了 `useRequest` —— 并进那一行也行。

在组件顶部加:

```tsx
  const navigate = useNavigate();
```

给 `<WorkFolderTree ...>`(第 375 行那段 JSX)加一行,和 `onToggleLock={...}` 并排:

```tsx
                  onShowRule={(folderId) => navigate(`/rules?folder=${folderId}`)}
```

- [ ] **Step 3: typecheck + build**

Run: `cd web && npm run typecheck && npx max build`
Expected: 都通过

- [ ] **Step 4: 提交**

```bash
git add web/src/components/WorkFolderTree.tsx web/src/pages/curator.tsx
git commit -m "feat(web): 从夹子行一键跳到它的规则

规则和夹子分了家(规则属于某个夹子,但 /rules 上看不到树)——
这条缝用 ?folder=<id> 直接展开那一行来补。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review

### 1. Spec 覆盖

| Spec §9C | 落在哪 |
|---|---|
| §9C.0 为什么 | 贯穿 T5 Step 5 的注释、T12 的"命中 N 条" |
| R1 结构化可执行 | T1(`RuleCondition`)、T2(`matchItem`) |
| R2 字段只留三个 | T1 `RuleField`、T6 的 `badCondition` 校验 |
| R3 条件之间 OR | T2(一个夹子的多个条件命中只出**一条** hit,`tokens` 全带) |
| R4 命中多个都归 | T2「命中两个夹子」用例、T4(apply 的最后一公里) |
| R4b AI 只一个主归属 | T4 不改 `coerceAssignments`;T5 的 `rest` 把规则命中的条目挡在 AI 输入之外 |
| R5 规则先跑 | T5(`matchAll` → `ruleAssignments` / `rest`),T5 Step 6 的"一次 LLM 都不调" |
| R6 AI 的两通道 | T5(归类)、T7 + T8(建议) |
| R7 建议自证 | T3(验证器)、T7(调用时用)、T8(采纳时**再验一次**) |
| §9C.2 数据模型 | T1(表 + `origin` + `updated_at`) |
| §9C.3 ①②③ 运行方式 | T5(规则先跑、夹子带规则/样本、如实分栏) |
| §9C.3 「克隆时不带规则」 | T1 第 1 条用例(克隆后 `listRules` 为空) |
| §9C.4 界面四条规矩 | 规矩 1(T11 就地编辑)、规矩 2(T12 建议置顶单独一栏)、规矩 3(T11 🤖/✎)、规矩 4(T11 试跑) |
| §9C.4 导航 / 顶级 tab | **已就位**(`.umirc.ts:11`、`layouts/index.tsx:19`),本计划不动 |
| §9C.4 「夹子行跳转 + 定位」 | T13 |
| §9C.4 命中数口径 = 全库 items | T6 `rulesWithHits` |
| §9C.5(a) 归类 | T5(低置信度照旧 `null` 落未归类,`unclassified` 照旧单列) |
| §9C.5(b) 建议**单独一次调用** + 返回形状 | T7 |
| §9C.5(b) 服务端验证四条 | T3(四条都测了) |
| §9C.5(c) 来源①「跑完归类顺手给」 | T8 Step 5 |
| §9C.5(c) 来源②「对话框里主动问」 | T9(规则进上下文让 AI 能聊)+ **T8 的 `POST /api/rules/suggest`**(结构化建议的落点)—— 见下面的口径说明 |
| §9C.5(c) 合并规则(去重 + 并证据) | T3 `mergeSuggestions` |
| §9C.5「建议不落库」 | T7/T8 都不写表;T8 有专门用例断言规则表仍为空 |
| §9C.6 约束 1 只写 `work_folder_rules` | T1(表)、T6(路由只碰这张表) |
| §9C.6 约束 2 建议必过验证才入库 | T3 + T6 的 adopt 路由**再验一次** |
| §9C.6 约束 3 `origin` 如实 | T1 `saveRule` 的 `origin` 参数;T6 PUT 记 `user`、adopt 记 `ai` |
| §9C.6 约束 4 锁定夹子不能加规则 | T6(PUT 与 adopt 都拦) |
| §9C.6 约束 5 一键还原连规则一起清 | T1(CASCADE 用例) |
| §9C.7 测试 8 条 | 逐条:三字段命中/大小写/空词表 → T2;命中两夹子都归 → T2 + T4;多条件只算一条 → T2;建议验证 4 种 → T3;覆盖的条目不进 AI → T5 Step 6;CASCADE → T1;锁定夹子被拒 → T6 |
| §9C.7 「只手动验证:真机试跑命中数与实际归类条数一致」 | **不写代码** —— 见下面"手动验证清单" |
| §9C.8 不在这一轮 | 没有任何任务做正则/与或非/权重、优先级、自动归纳、建议历史 |
| §9C.8b 将来让 AI 复核规则已覆盖的条目 | **不实现**;T5 的 `rest` 正好是"两组不相交"的落实处,将来要动就在这里 |
| §9C.9 Pass 1 连规则一起提 | **不实现** —— spec 自己说"那是 Pass 1 那条路的事,而 Pass 1 目前不可达" |
| §9C.9 `keyword.ts` 的 `DEFAULT_RULES` 保留不动 | 没有任何任务碰它 |

### 2. 我按哪边做的:spec 的四处缺口(按内存里的约定,缺口要**指出**而不是默默补)

1. **§9C.5(c) 第二条「在对话框里主动问」的落点**。spec 说建议的来源有两个,又说建议**单独一次调用**(b),但没定义这两句怎么对接 —— 也没说结构化建议怎么从"纯文本 SSE 的聊天"里出来。**我按:结构化建议一律走 `POST /api/rules/suggest`(和"归类后自动给"同一个 `runSuggestions`);聊天只把规则放进上下文(T9),让 AI 能就规则对话。** 理由:那是唯一不需要自己发明一层传输协议的做法,而且两条路的输入口径由 T8 的测试钉住一致。**这一条是用户拍板的**("两条路走同一个专用调用")。
2. **规则的变更不进 `operation_log`**。§9B.3 的 `OpKind` 原文写着「以后加功能不该改这张表」,而 §9C 从没要求规则的增删改留痕(它要的是规则表自己的 `updated_at` + `origin`)。**我按:不动 `OpKind`,规则变更不记操作日志。** 顺带的收益是 `apply` 的 409 冲突检测(`.filter(e => e.actor === 'user')`)语义不变。
3. **`reservedForSystem = 1500` 可能不够了**。§9C.3 ② 让每个夹子带上规则 / 3 条样本标题,而 `batchSize`(`llm/context.ts:24`)的公式里那个 1500 是**定值**。63 个夹子 × (规则 + 3 条标题)会让 system 部分显著变大 —— 兜底是既有的 §9.4 缩批重试(解析失败二分重试到 `MIN_BATCH`),所以**不会静默出错**,最坏是多跑几批。**我按:不动 `batchSize`,只在验证清单里点名叫人在真机上量一次。** 改那个公式属于 §3 的范围,不是这一轮。
4. **§9C.4 的「命中数先量一下,慢了就退化成只算正在编辑的那条」**。这是一句**实现时的测量要求**,不是代码要求。**我按:先按全表扫描实现(T6),量出来慢再退化。** 见验证清单。
5. **建议调用到底喂哪一批条目,spec 没定**(§9C.5 只说"给没归上的条目提建议")。三处线索互相拉扯:§9C.5(b) 说"只在**有没归上的条目**时才需要",§9C.5(c) 第一条说"**规则没覆盖住的条目**聚成建议",§9C.8 说"AI 看到'这些条目**没地方去**'时就会提规则"。而它自己举的 `because` 例子是"8 条**被归进别的夹子的**条目" —— 那是 AI 归**成功**的条目。**我按(T7)**:
   - `pool` = **规则没覆盖住的条目**(§9C.5(c) 的字面原文,而且它的例子要求输入里必须有 AI 归成功的条目)
   - `cap` = `batchSize(ctx)` —— **必须有个上限**:第一次跑时全库都没有规则,pool 就是 3250 条 × ~250 token ≈ 80 万 token,任何窗口都装不下。复用 §3 已算好的批大小,不另定魔数
   - `homelessIds` 传了就是**省钱闸 + 排序键**:空集直接不调(§9C.5 b 的"只在需要时付费"),非空则排最前,cap 切不掉它们(`pool` 里的顺序可能让最该被看见的排在 3200 名开外)
   - 「面板上主动要」那条路**没有** homeless 信息(没跑归类),不传 —— 用户主动点的按钮,他想看就看
   
   **代价如果错了**:建议瞄准的条目集合不对 → 建议质量下降或该响的时候不响。就一个函数(`runSuggestions` 的前 10 行),改起来很便宜。
   **顺带**:这两条路的输入现在由**同一个** `suggestionInput(db)` 产出,不再是两份近似拷贝 —— 上一版 plan 里那两段会分叉的代码已经删掉。
6. **`SuggestionFolder` 与 `FolderSpec` 的样本那 8 行**:`run-pass-2` 为了 Pass 2 的 prompt 仍然自己拼 `FolderSpec.rule` + samples,和 `suggestionInput` 里那段形状相似但**出口类型不同**。**我按:保留这点重复** —— 为了消 8 行去合并两个不同形状的类型不划算。已在 T8 Step 5 的注里写明这是有意保留。

另外两处**已存在**的 spec 张力,本计划**照现状走、不改**:

- §9.3 写「一批 **50** 条」,同一节的下一段又说按 `contextWindow` 动态算。实现(`batchSize`)取的是**动态**那条,§9.4 缩批的目标值是 `MIN_BATCH = 15`。50 那个数字在代码里不存在。
- `FolderSpec.rule` 是 `string`(Pass 1 的自由文本),而 §9C 的规则是结构化的 `{field, any[]}`。**本轮不碰这个接缝** —— §9C.9 明确把"Pass 1 连规则一起提"留给 Pass 1 自己的轮次。

### 3. 手动验证清单(代码之外,交付时要跑一遍)

- [ ] **命中数性能**:在真实库(`data/` 那个 db,几千条 items)上打开 `/rules`,记一次 `/api/rules` 的耗时。几十毫秒量级就保持现状;慢了就退化成"只算你正在打开的那一条"(§9C.4 明确给了这条路)。
- [ ] **试跑 vs 实际**:点「试跑:规则 vs AI」记下 `covered`,然后真跑一次 `run-pass-2`,核对响应里的 `ruleCount` 与 `covered` 是否一致(§9C.7 的唯一一条手动验证)。
- [ ] **真机建议质量**:拿真 Ollama 跑一次 `分类 → 建议`,看建议的 `because` 是否讲得通、`evidenceItemIds` 是不是真被命中。**T3 的验证器只保证"不是编的",保证不了"是对的"。**
- [ ] **`batchSize` 是否被体系挤爆**:63 个夹子都配上规则之后,看 `run-pass-2` 有没有出现"整批解析失败 → 缩批"。有就说明缺口 3 落地了,该去改 `reservedForSystem` 的口径。
- [ ] **建议栏的三种动作**:采纳 / 改一下 / 忽略 各点一次,确认 (a) 采纳是**追加**不是覆盖,(b) 改一下之后那一行确实展开了,(c) 忽略之后刷新页面它本来就不该回来。

### 4. 类型一致性

- **`FolderRule`(db 层)与 `RuleView`(前端)字段名不同是故意的** —— `RuleView` 多了 `folderName` / `locked` / `hit`(后端 join 出来给界面用的),少了 `conditions_json`。两处都别改名去"对齐"。
- **`ValidSuggestion`(后端)与 `RuleSuggestion`(前端)是同一形状的两次声明** —— 前端 `RuleSuggestion.folderId` 对应后端 `ValidSuggestion.folderId`(不是 `folderTempId`;`folderTempId` 只活在**模型原始输出**那一层,也就是 `RawSuggestion`)。T10 的注释里写清了这一点。
- **`RuleView.origin` 是 `'ai' | 'user' | null`**(null = 还没人写过),而 `FolderRule.origin` 是 `'ai' | 'user'`(有行就一定有值)。两者不是同一个类型的宽松版,别在 T11 里用 `RuleOrigin | null` 去接后端 —— 后端返回的就是 `null`。
- **`RuleSuggestion` 的 key**:T12 用 `${folderId}-${field}-${any.join()}` 做 React key,和后端 `mergeSuggestions` 的 key 口径(`folderId|field|sorted any`)在**内容相同**这个意义上一致,但没排序 —— 因为同一批建议里不会出现"词一样顺序不一样"的两条(那正是 `mergeSuggestions` 已经合掉的)。别为此再加一次排序。
- **跨任务复用的同名函数**:`renderConditions`(T2 定义,T5/T8/T9 用)、`toRuleItem`(T6 的 `ruleRoutes.ts` 和 T7 的 `suggestions.ts` **各定义一份**,内容是同样的 4 行投影)。后者是有意的重复:`db/` 不许 import `curator/`,而它是"ItemRow → RuleItem"这种纯投影,放进 `db/` 会让 db 层知道 `RuleItem` 这个 curator 概念。两处都别改名。
