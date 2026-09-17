# M4b 整理工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「整理」页从"左右对置的体系协商屏"改成**只显示一份结构、改动带标记**的手动工作台,AI 退回对话框,所有改动留痕、可一键还原。

**Architecture:** 同步快照(`folders` / `folder_items`,只读)与工作副本(`work_folders` / `work_folder_items`,全局唯一一份)分离。编辑只写工作副本,改动标记由 work 与快照比对算出来,不单独存。「还原」= 清空工作副本。每次编辑追加一条 `operation_log`(记决策,不记数据变更)。

**Tech Stack:** Fastify 5 + better-sqlite3 12.11.1(后端)、umijs/max + antd 5 + lucide-react(前端)、vitest 3(测试)

**Spec:** `docs/superpowers/specs/m4b-curator-workbench.md`(冲突时以它为准;它标注取代了 `shared-frontend.md` §11.4/§11.5、`m4-curator-classification.md` §9.2)

## Global Constraints

- Node 22.12、TypeScript ^5.9.3、better-sqlite3 ^12.11.1、ESM(**类型一律 `import type`**)
- `strict` + `noUncheckedIndexedAccess` —— 索引访问要 `!` 或判空
- 依赖方向:`http → curator → db / logger`。`db/` 不许 import `curator/`
- 中文注释;commit trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- **编辑路径只能写 `work_*` 表**(spec §9B.7 约束 1)
- **任何改变工作副本的动作必须同时追加一条 `operation_log`**(约束 2)
- **非失效条目一律不许删**(charter C5);`delete_invalid_items` 是唯一的删除落点
- 测试**不调真实 API**,LLM 一律 mock
- 每个任务收尾跑:`npm test -w server` 全绿;涉及前端时再加 `cd web && npm run typecheck && npx max build`

---

## File Structure

**新增**

| 文件 | 职责 |
|---|---|
| `server/src/db/repo/workbench.ts` | 工作副本的读写:存在性、克隆、查、清空 |
| `server/src/db/repo/workbench.test.ts` | 上面那些的测试 |
| `server/src/db/repo/operations.ts` | 操作日志:追加、查询 |
| `server/src/db/repo/operations.test.ts` | 上面那些的测试 |
| `server/src/db/repo/workbenchView.ts` | **只读**计算:改动标记、未归类数、被删夹子 |
| `server/src/db/repo/workbenchView.test.ts` | 上面那些的测试 |
| `server/src/curator/workbench.ts` | 编排:每个编辑动作 = 改工作副本 + 记一条日志 |
| `server/src/curator/workbench.test.ts` | 上面那些的测试 |
| `web/src/components/WorkFolderTree.tsx` | 一份结构的树(夹子头 + 条目行 + 标记 + 内联改名) |
| `web/src/components/OperationLog.tsx` | 操作日志面板(留痕的界面落点) |

**修改**

| 文件 | 改什么 |
|---|---|
| `server/src/db/schema.ts` | 追加 4 张表 |
| `server/src/curator/routes.ts` | 追加 `/api/workbench/*`;`run-pass-2` 后加应用入口 |
| `server/src/curator/routes.test.ts` | 新路由的测试 |
| `web/src/types.ts` | 前端类型 |
| `web/src/api.ts` | `workbenchApi` |
| `web/src/pages/curator.tsx` | **重写**:一份结构 + 标记 + 动作条 + 还原 |
| `web/src/components/ChatDrawer.tsx` | 加「应用到现在的结构」 |

**刻意不动**:`taxonomy_draft` 表(spec §9B.2:保留但不读写)、`sessions` / `session_messages` / `classifications`(角色收窄,结构不变)。

---

### Task 1: 四张新表 + 工作副本克隆

**Files:**
- Modify: `server/src/db/schema.ts`(在末尾反引号前追加)
- Create: `server/src/db/repo/workbench.ts`
- Test: `server/src/db/repo/workbench.test.ts`

**Interfaces:**
- Consumes: `getState(db, stateKey.lastFull)` from `db/repo/state.ts`;`folders` / `folder_items` 表
- Produces:
  ```ts
  export interface WorkFolder { id: number; originId: number | null; name: string }
  export interface WorkState { basedOn: number; createdAt: number }

  function hasWorkcopy(db): boolean
  function getWorkState(db): WorkState | null
  function ensureWorkcopy(db): void          // 幂等:已有副本不动
  function listWorkFolders(db): WorkFolder[]
  function workItemIds(db, workFolderId): string[]
  function resetWorkcopy(db): void
  ```

- [ ] **Step 1: 加表**

在 `server/src/db/schema.ts` 的**最后一个反引号之前**(即 `audit_logs` 那段之后)追加:

```sql
-- ── M4b 整理工作台(2026-09-16)──────────────────────────
-- 同步快照(folders / folder_items)与工作副本分离:快照只读、编辑只写下面这几张。
-- 破了这条「还原」就没有意义 —— 改动和 B站 真相混在一起就分不出谁是谁。

-- 工作副本的存在性 + 它基于哪一次同步。
-- CHECK(id = 1) 把"全局唯一一份"钉在数据库层,不靠应用代码自觉。
CREATE TABLE IF NOT EXISTS work_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  based_on   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 目标夹子。
CREATE TABLE IF NOT EXISTS work_folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 指向快照里的哪个夹子。非空 = 现有夹子(可能改了名);空 = 新建的。
  -- 改动标记 ✎ 靠它算:origin_id 非空且名字不同 → 改名
  origin_id  INTEGER REFERENCES folders(id),
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 目标归属(多对多 —— B站 允许一个视频同时在多个夹子里)
CREATE TABLE IF NOT EXISTS work_folder_items (
  folder_id INTEGER NOT NULL REFERENCES work_folders(id) ON DELETE CASCADE,
  item_id   TEXT NOT NULL REFERENCES items(id),
  PRIMARY KEY (folder_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_wfi_item ON work_folder_items(item_id);

-- 操作日志:一次**操作**一条,不是一行数据一条。
-- 拖 412 条视频记 412 行日志 = 垃圾,不是留痕。
CREATE TABLE IF NOT EXISTS operation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,   -- 'user' | 'ai'
  session_id  INTEGER,         -- actor='ai' 时是哪次对话
  summary     TEXT NOT NULL,   -- 人类可读一句话,界面直接显示
  detail_json TEXT
);
```

- [ ] **Step 2: 写失败的测试**

`server/src/db/repo/workbench.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertFolder } from './folders.js';
import { upsertItem, linkFolderItem } from './items.js';
import { setState, stateKey } from './state.js';
import {
  hasWorkcopy,
  getWorkState,
  ensureWorkcopy,
  listWorkFolders,
  workItemIds,
  resetWorkcopy,
} from './workbench.js';

/** 快照:2 个夹子、3 条条目,其中 BV1 同时在两个夹子里(B站 支持) */
function seeded() {
  const db = openDb(':memory:');
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertFolder(db, { id: 8, title: '编程', mediaCount: 2 });
  for (const id of ['BV1', 'BV2', 'BV3']) upsertItem(db, { id, type: 2, title: id });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
  linkFolderItem(db, 8, 'BV1', 1);
  linkFolderItem(db, 8, 'BV3', 1);
  setState(db, stateKey.lastFull, '1700000000000');
  return db;
}

describe('工作副本', () => {
  it('没建过时 hasWorkcopy 为 false', () => {
    const db = seeded();
    expect(hasWorkcopy(db)).toBe(false);
    expect(getWorkState(db)).toBeNull();
  });

  it('克隆出来的每个夹子都指向快照里的原点', () => {
    const db = seeded();
    ensureWorkcopy(db);
    const rows = listWorkFolders(db);
    expect(rows.map((r) => [r.originId, r.name])).toEqual([
      [7, '深度学习'],
      [8, '编程'],
    ]);
  });

  it('克隆出来的归属与快照逐行相等', () => {
    const db = seeded();
    ensureWorkcopy(db);
    const [a, b] = listWorkFolders(db);
    expect(workItemIds(db, a!.id).sort()).toEqual(['BV1', 'BV2']);
    expect(workItemIds(db, b!.id).sort()).toEqual(['BV1', 'BV3']);
  });

  it('克隆是幂等的 —— 已有副本时再调用不会翻倍', () => {
    const db = seeded();
    ensureWorkcopy(db);
    ensureWorkcopy(db);
    expect(listWorkFolders(db)).toHaveLength(2);
  });

  it('based_on 记的是克隆那一刻的上次全量同步时间', () => {
    const db = seeded();
    ensureWorkcopy(db);
    expect(getWorkState(db)!.basedOn).toBe(1700000000000);
  });

  it('reset 清空 work_* 与 work_state,快照一行不动', () => {
    const db = seeded();
    ensureWorkcopy(db);
    resetWorkcopy(db);

    expect(hasWorkcopy(db)).toBe(false);
    expect(listWorkFolders(db)).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM work_folder_items`).get()).toEqual({ n: 0 });
    // 快照没被动过
    expect(db.prepare(`SELECT COUNT(*) AS n FROM folders`).get()).toEqual({ n: 2 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM folder_items`).get()).toEqual({ n: 4 });
  });

  it('快照是空的也能克隆(空副本,不是崩)', () => {
    const db = openDb(':memory:');
    ensureWorkcopy(db);
    expect(hasWorkcopy(db)).toBe(true);
    expect(listWorkFolders(db)).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -w server -- src/db/repo/workbench.test.ts`
Expected: FAIL — `Cannot find module './workbench.js'`

- [ ] **Step 4: 实现**

`server/src/db/repo/workbench.ts`:

```ts
import type Database from 'better-sqlite3';
import { getState, stateKey } from './state.js';

/**
 * 工作副本 —— 你要把收藏夹改成什么样。
 *
 * 全局唯一一份(**不按会话分**):「现在的体系」是单数,多套竞争方案
 * 是旧的错误模型。唯一性由 `work_state` 的 CHECK(id = 1) 在数据库层保证。
 */
export interface WorkFolder {
  id: number;
  /** 指向快照里的哪个夹子;null = 新建的 */
  originId: number | null;
  name: string;
}

export interface WorkState {
  basedOn: number;
  createdAt: number;
}

export function hasWorkcopy(db: Database.Database): boolean {
  return getWorkState(db) !== null;
}

export function getWorkState(db: Database.Database): WorkState | null {
  const row = db.prepare(`SELECT based_on, created_at FROM work_state WHERE id = 1`).get() as
    | { based_on: number; created_at: number }
    | undefined;
  return row ? { basedOn: row.based_on, createdAt: row.created_at } : null;
}

/**
 * 从快照克隆一份工作副本。**幂等** —— 已经有副本时什么都不做。
 *
 * 调用时机是"第一次编辑",不是"点开始整理":不给用户多一个
 * "我还没开始整理所以改不了"的状态。
 */
export function ensureWorkcopy(db: Database.Database): void {
  if (hasWorkcopy(db)) return;
  const now = Date.now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO work_state (id, based_on, created_at) VALUES (1, ?, ?)`,
    ).run(Number(getState(db, stateKey.lastFull) ?? 0) || 0, now);

    db.prepare(
      `INSERT INTO work_folders (origin_id, name, created_at) SELECT id, title, ? FROM folders`,
    ).run(now);

    // 归属按 origin_id 搬过来 —— 只搬 cloned 出来的那些副本夹子
    db.prepare(
      `INSERT INTO work_folder_items (folder_id, item_id)
       SELECT wf.id, fi.item_id
         FROM work_folders wf
         JOIN folder_items fi ON fi.folder_id = wf.origin_id
        WHERE wf.origin_id IS NOT NULL`,
    ).run();
  })();
}

export function listWorkFolders(db: Database.Database): WorkFolder[] {
  const rows = db
    .prepare(`SELECT id, origin_id, name FROM work_folders ORDER BY id`)
    .all() as { id: number; origin_id: number | null; name: string }[];
  return rows.map((r) => ({ id: r.id, originId: r.origin_id, name: r.name }));
}

export function workItemIds(db: Database.Database, workFolderId: number): string[] {
  return (
    db
      .prepare(`SELECT item_id FROM work_folder_items WHERE folder_id = ? ORDER BY item_id`)
      .all(workFolderId) as { item_id: string }[]
  ).map((r) => r.item_id);
}

/** 「一键还原」的落点。快照一行不碰 —— 它本来就只读。 */
export function resetWorkcopy(db: Database.Database): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM work_folder_items`).run();
    db.prepare(`DELETE FROM work_folders`).run();
    db.prepare(`DELETE FROM work_state WHERE id = 1`).run();
  })();
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -w server -- src/db/repo/workbench.test.ts`
Expected: PASS(7 tests)

- [ ] **Step 6: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/db/schema.ts server/src/db/repo/workbench.ts server/src/db/repo/workbench.test.ts
git commit -m "feat(db): 工作副本三张表 + 从快照克隆(全局唯一,CHECK id=1)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 操作日志

**Files:**
- Create: `server/src/db/repo/operations.ts`
- Test: `server/src/db/repo/operations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OpKind =
    | 'rename_folder' | 'merge_folders' | 'create_folder' | 'delete_folder'
    | 'move_items' | 'add_items' | 'remove_items' | 'delete_invalid_items' | 'reset';
  export type OpActor = 'user' | 'ai';

  export interface OperationEntry {
    id: number; ts: number; kind: OpKind; actor: OpActor;
    sessionId: number | null; summary: string; detail: unknown;
  }

  function logOperation(db, e: {
    kind: OpKind; actor: OpActor; sessionId?: number | null;
    summary: string; detail?: unknown;
  }): number
  function listOperations(db, opts?: { limit?: number; sinceTs?: number }): OperationEntry[]
  ```

- [ ] **Step 1: 写失败的测试**

`server/src/db/repo/operations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { logOperation, listOperations } from './operations.js';

const fresh = () => openDb(':memory:');

describe('操作日志', () => {
  it('追加一条,能读回来', () => {
    const db = fresh();
    logOperation(db, {
      kind: 'merge_folders', actor: 'user',
      summary: '把「机器学习」并入「AI/编程」',
      detail: { from: 7, into: 8, items: 233 },
    });
    const rows = listOperations(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('merge_folders');
    expect(rows[0]!.actor).toBe('user');
    expect(rows[0]!.summary).toContain('机器学习');
    expect(rows[0]!.detail).toEqual({ from: 7, into: 8, items: 233 });
  });

  it('最新的在最前面(界面要按时间倒序显示)', () => {
    const db = fresh();
    logOperation(db, { kind: 'create_folder', actor: 'user', summary: '第一条' });
    logOperation(db, { kind: 'create_folder', actor: 'user', summary: '第二条' });
    expect(listOperations(db).map((r) => r.summary)).toEqual(['第二条', '第一条']);
  });

  // 一次操作一条 —— 拖 412 条不该产生 412 行
  it('一次操作只产生一行', () => {
    const db = fresh();
    logOperation(db, {
      kind: 'move_items', actor: 'user',
      summary: '移动 412 条到「AI/编程」',
      detail: { itemIds: Array.from({ length: 412 }, (_, i) => `BV${i}`) },
    });
    expect(listOperations(db)).toHaveLength(1);
  });

  it('actor=ai 时能带上会话号,便于把一次应用归成一组', () => {
    const db = fresh();
    logOperation(db, { kind: 'move_items', actor: 'ai', sessionId: 3, summary: 'x' });
    expect(listOperations(db)[0]!.sessionId).toBe(3);
  });

  it('limit 限制条数', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      logOperation(db, { kind: 'create_folder', actor: 'user', summary: `第${i}条` });
    }
    expect(listOperations(db, { limit: 2 })).toHaveLength(2);
  });

  it('sinceTs 只取那之后的 —— AI 应用前查冲突用', () => {
    const db = fresh();
    logOperation(db, { kind: 'create_folder', actor: 'user', summary: '旧的' });
    const cut = Date.now() + 1;
    logOperation(db, { kind: 'create_folder', actor: 'user', summary: '新的' });
    expect(listOperations(db, { sinceTs: cut }).map((r) => r.summary)).toEqual(['新的']);
  });

  it('没有 detail 也能记(不是所有操作都需要明细)', () => {
    const db = fresh();
    logOperation(db, { kind: 'reset', actor: 'user', summary: '还原' });
    expect(listOperations(db)[0]!.detail).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/db/repo/operations.test.ts`
Expected: FAIL — `Cannot find module './operations.js'`

- [ ] **Step 3: 实现**

`server/src/db/repo/operations.ts`:

```ts
import type Database from 'better-sqlite3';

/**
 * 操作日志 —— 记的是**决策**,不是数据变更。
 *
 * 一次操作一行,哪怕它碰了 412 条视频。数据库级的行变更日志是 debug 用的,
 * 不该出现在界面上;用户要的"留痕"是我做了什么决定。
 *
 * **没有 `apply_ai` 这个 kind**:AI 应用产生的就是下面这些普通类型,
 * 只是 actor='ai'。这是"AI 的改动不是另一类东西"在结构上的落实 ——
 * 否则就会出现"手动改的能还原、AI 改的不能"。
 */
export type OpKind =
  | 'rename_folder'
  | 'merge_folders'
  | 'create_folder'
  | 'delete_folder'
  | 'move_items'
  | 'add_items'
  | 'remove_items'
  | 'delete_invalid_items'
  | 'reset';

export type OpActor = 'user' | 'ai';

export interface OperationEntry {
  id: number;
  ts: number;
  kind: OpKind;
  actor: OpActor;
  sessionId: number | null;
  summary: string;
  detail: unknown;
}

export function logOperation(
  db: Database.Database,
  e: {
    kind: OpKind;
    actor: OpActor;
    sessionId?: number | null;
    summary: string;
    detail?: unknown;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO operation_log (ts, kind, actor, session_id, summary, detail_json)
       VALUES (@ts, @kind, @actor, @sessionId, @summary, @detail)`,
    )
    .run({
      ts: Date.now(),
      kind: e.kind,
      actor: e.actor,
      sessionId: e.sessionId ?? null,
      summary: e.summary,
      detail: e.detail === undefined ? null : JSON.stringify(e.detail),
    });
  return Number(r.lastInsertRowid);
}

export function listOperations(
  db: Database.Database,
  opts: { limit?: number; sinceTs?: number } = {},
): OperationEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM operation_log
        WHERE ts >= ?
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(opts.sinceTs ?? 0, opts.limit ?? 200) as {
    id: number; ts: number; kind: string; actor: string;
    session_id: number | null; summary: string; detail_json: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    kind: r.kind as OpKind,
    actor: r.actor as OpActor,
    sessionId: r.session_id,
    summary: r.summary,
    detail: r.detail_json ? (JSON.parse(r.detail_json) as unknown) : null,
  }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/db/repo/operations.test.ts`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
npm test -w server
git add server/src/db/repo/operations.ts server/src/db/repo/operations.test.ts
git commit -m "feat(db): 操作日志 —— 一次操作一条,记决策不记数据变更

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 改动标记与视图(只读计算)

**Files:**
- Create: `server/src/db/repo/workbenchView.ts`
- Test: `server/src/db/repo/workbenchView.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `listWorkFolders` / `workItemIds`;`folders.ts` 的 `listFolders` / `isLockedFolder`;`items.ts` 的 `countFolderItems`
- Produces:
  ```ts
  export type ChangeMark = 'unchanged' | 'renamed' | 'created' | 'merged' | 'removed';

  export interface WorkFolderView {
    id: number; name: string;
    originId: number | null;
    /** 改了名前叫什么(点开标记展开用);没改是 null */
    originName: string | null;
    mark: ChangeMark;
    itemCount: number;
    locked: boolean;
  }

  export interface RemovedFolder {
    id: number; name: string; itemCount: number;
    /** 条目并进了哪个工作夹子;null = 条目被移出或本来就空 */
    intoName: string | null;
    mark: 'merged' | 'removed';
  }

  function buildWorkbenchView(db): {
    folders: WorkFolderView[];
    removed: RemovedFolder[];
    unassignedCount: number;
  }
  ```

- [ ] **Step 1: 写失败的测试**

`server/src/db/repo/workbenchView.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertFolder } from './folders.js';
import { upsertItem, linkFolderItem } from './items.js';
import { setState, stateKey } from './state.js';
import { ensureWorkcopy, listWorkFolders } from './workbench.js';
import { buildWorkbenchView } from './workbenchView.js';

function seeded() {
  const db = openDb(':memory:');
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertFolder(db, { id: 8, title: '不常用', mediaCount: 1 });
  upsertFolder(db, { id: 9, title: '默认收藏夹', mediaCount: 1, raw: JSON.stringify({ attr: 0 }) });
  for (const id of ['BV1', 'BV2', 'BV3', 'BV4']) upsertItem(db, { id, type: 2, title: id });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
  linkFolderItem(db, 8, 'BV3', 1);
  linkFolderItem(db, 9, 'BV4', 1);
  setState(db, stateKey.lastFull, '1000');
  ensureWorkcopy(db);
  return db;
}

const byOrigin = (db: ReturnType<typeof seeded>) =>
  new Map(listWorkFolders(db).map((f) => [f.originId, f]));

describe('工作台视图', () => {
  it('没动过的夹子标记是 unchanged', () => {
    const db = seeded();
    const v = buildWorkbenchView(db);
    expect(v.folders.map((f) => f.mark)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(v.removed).toEqual([]);
  });

  it('改名 → renamed,并带出原名', () => {
    const db = seeded();
    const f = byOrigin(db).get(7)!;
    db.prepare(`UPDATE work_folders SET name = ? WHERE id = ?`).run('AI/编程', f.id);

    const v = buildWorkbenchView(db);
    const row = v.folders.find((x) => x.originId === 7)!;
    expect(row.mark).toBe('renamed');
    expect(row.name).toBe('AI/编程');
    expect(row.originName).toBe('深度学习'); // 点开标记能看原来叫什么
  });

  it('originId 为空 → created', () => {
    const db = seeded();
    db.prepare(`INSERT INTO work_folders (origin_id, name, created_at) VALUES (NULL, '新夹子', 1)`).run();
    const v = buildWorkbenchView(db);
    expect(v.folders.find((f) => f.originId === null)!.mark).toBe('created');
  });

  it('条目数按工作副本算,不是按快照', () => {
    const db = seeded();
    const f = byOrigin(db).get(7)!;
    db.prepare(`DELETE FROM work_folder_items WHERE folder_id = ? AND item_id = 'BV2'`).run(f.id);
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (?, 'BV3')`).run(f.id);

    const v = buildWorkbenchView(db);
    expect(v.folders.find((x) => x.originId === 7)!.itemCount).toBe(2); // BV1 + BV3
  });

  it('锁定的夹子带出 locked —— 界面上仍不能改名/删除', () => {
    const db = seeded();
    const v = buildWorkbenchView(db);
    expect(v.folders.find((f) => f.originId === 9)!.locked).toBe(true);
    expect(v.folders.find((f) => f.originId === 7)!.locked).toBe(false);
  });

  it('快照里有、工作副本里没了 → 进了 removed', () => {
    const db = seeded();
    const f = byOrigin(db).get(8)!;
    // 模拟"合并进 7":条目搬过去,原夹子删掉
    db.prepare(`UPDATE work_folder_items SET folder_id = ? WHERE folder_id = ?`).run(
      byOrigin(db).get(7)!.id, f.id,
    );
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(f.id);

    const v = buildWorkbenchView(db);
    const r = v.removed.find((x) => x.id === 8)!;
    expect(r.mark).toBe('merged');
    expect(r.intoName).toBe('深度学习'); // 条目都并进了这个
    expect(r.itemCount).toBe(1);
  });

  it('快照里有、工作副本里没了,但条目没进任何地方 → removed 而非 merged', () => {
    const db = seeded();
    const f = byOrigin(db).get(8)!;
    db.prepare(`DELETE FROM work_folder_items WHERE folder_id = ?`).run(f.id);
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(f.id);

    const v = buildWorkbenchView(db);
    const r = v.removed.find((x) => x.id === 8)!;
    expect(r.mark).toBe('removed');
    expect(r.intoName).toBeNull();
  });

  it('未归类数 = 本地条目里不属于任何工作夹子的', () => {
    const db = seeded();
    upsertItem(db, { id: 'BV9', type: 2, title: '没人要' });
    const v = buildWorkbenchView(db);
    expect(v.unassignedCount).toBe(1);
  });

  it('没建工作副本时不崩 —— 视图退化成"快照的样子"', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: 'x', mediaCount: 0 });
    const v = buildWorkbenchView(db);
    expect(v.folders).toEqual([]);
    expect(v.removed.map((r) => r.id)).toEqual([1]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/db/repo/workbenchView.test.ts`
Expected: FAIL — `Cannot find module './workbenchView.js'`

- [ ] **Step 3: 实现**

`server/src/db/repo/workbenchView.ts`:

```ts
import type Database from 'better-sqlite3';
import { listFolders, isLockedFolder } from './folders.js';
import { listWorkFolders, workItemIds } from './workbench.js';

/**
 * 工作台视图 —— **纯读**,改动标记是算出来的,不单独存。
 *
 * 存标记的话就有了两份真相:标记说"改名了"而 work_folders 里名字没变时,
 * 你没法知道该信哪个。算出来的永远不会自相矛盾。
 */
export type ChangeMark = 'unchanged' | 'renamed' | 'created' | 'merged' | 'removed';

export interface WorkFolderView {
  id: number;
  name: string;
  originId: number | null;
  /** 改了名前叫什么 —— 点开 ✎ 标记要能看到原值 */
  originName: string | null;
  mark: ChangeMark;
  itemCount: number;
  /** 锁定的夹子(B站 自带默认收藏夹)在界面上也不能改名/删除 */
  locked: boolean;
}

export interface RemovedFolder {
  id: number;
  name: string;
  itemCount: number;
  /** 条目并进了哪个工作夹子;null = 条目被移出别处,或者本来就是空夹 */
  intoName: string | null;
  mark: 'merged' | 'removed';
}

export function buildWorkbenchView(db: Database.Database): {
  folders: WorkFolderView[];
  removed: RemovedFolder[];
  unassignedCount: number;
} {
  const snapshot = listFolders(db);
  const work = listWorkFolders(db);
  const workById = new Map(work.map((w) => [w.id, w]));

  const folders: WorkFolderView[] = work.map((w) => {
    const origin = w.originId === null ? undefined : snapshot.find((s) => s.id === w.originId);
    const renamed = origin !== undefined && origin.title !== w.name;
    return {
      id: w.id,
      name: w.name,
      originId: w.originId,
      originName: renamed ? origin.title : null,
      mark: w.originId === null ? 'created' : renamed ? 'renamed' : 'unchanged',
      itemCount: workItemIds(db, w.id).length,
      // 锁跟着**原点夹子**走:新建的同名夹子不该继承锁
      locked: origin !== undefined && isLockedFolder(db, origin),
    };
  });

  // 快照里有、工作副本里没了 —— 要么是合并(条目搬去了别处),要么是删空夹
  const claimedOrigins = new Set(work.map((w) => w.originId).filter((x): x is number => x !== null));
  const removed: RemovedFolder[] = [];

  for (const s of snapshot) {
    if (claimedOrigins.has(s.id)) continue;

    const itemIds = (
      db.prepare(`SELECT item_id FROM folder_items WHERE folder_id = ?`).all(s.id) as {
        item_id: string;
      }[]
    ).map((r) => r.item_id);

    // 这些条目现在都落在哪个工作夹子里?只有一个去处才算"并入它"
    const targets = new Set<number>();
    for (const itemId of itemIds) {
      const rows = db
        .prepare(`SELECT folder_id FROM work_folder_items WHERE item_id = ?`)
        .all(itemId) as { folder_id: number }[];
      for (const r of rows) targets.add(r.folder_id);
    }

    const only = targets.size === 1 ? workById.get([...targets][0]!) : undefined;
    removed.push({
      id: s.id,
      name: s.title,
      itemCount: itemIds.length,
      intoName: only?.name ?? null,
      mark: itemIds.length > 0 && only !== undefined ? 'merged' : 'removed',
    });
  }

  const unassignedCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i
          WHERE NOT EXISTS (SELECT 1 FROM work_folder_items w WHERE w.item_id = i.id)`,
      )
      .get() as { n: number }
  ).n;

  return { folders, removed, unassignedCount };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/db/repo/workbenchView.test.ts`
Expected: PASS(9 tests)

- [ ] **Step 5: 提交**

```bash
npm test -w server
git add server/src/db/repo/workbenchView.ts server/src/db/repo/workbenchView.test.ts
git commit -m "feat(db): 工作台视图 —— 改动标记算出来,不单独存

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 编辑动作(改副本 + 必记一条日志)

**Files:**
- Create: `server/src/curator/workbench.ts`
- Test: `server/src/curator/workbench.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ensureWorkcopy` / `listWorkFolders` / `workItemIds` / `resetWorkcopy` / `hasWorkcopy`;Task 2 的 `logOperation` / `listOperations`
- Produces:
  ```ts
  interface Actor { actor: OpActor; sessionId?: number }

  function renameFolder(db, folderId: number, name: string, who?: Actor): void
  function createFolder(db, name: string, who?: Actor): number
  function deleteFolder(db, folderId: number, who?: Actor): void          // 只能删空的
  function mergeFolders(db, fromId: number, intoId: number, who?: Actor): void
  function moveItems(db, itemIds: string[], toFolderId: number, who?: Actor): void
  function addItems(db, itemIds: string[], toFolderId: number, who?: Actor): void
  function removeItems(db, itemIds: string[], fromFolderId: number, who?: Actor): void
  function resetWorkbench(db, who?: Actor): void
  ```

- [ ] **Step 1: 写失败的测试**

`server/src/curator/workbench.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { setState, stateKey } from '../db/repo/state.js';
import { listWorkFolders, workItemIds, hasWorkcopy } from '../db/repo/workbench.js';
import { listOperations } from '../db/repo/operations.js';
import {
  renameFolder, createFolder, deleteFolder, mergeFolders,
  moveItems, addItems, removeItems, resetWorkbench,
} from './workbench.js';

function seeded() {
  const db = openDb(':memory:');
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertFolder(db, { id: 8, title: '不常用', mediaCount: 1 });
  upsertFolder(db, { id: 9, title: '默认收藏夹', mediaCount: 1, raw: JSON.stringify({ attr: 0 }) });
  for (const id of ['BV1', 'BV2', 'BV3', 'BV4']) upsertItem(db, { id, type: 2, title: id });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
  linkFolderItem(db, 8, 'BV3', 1);
  linkFolderItem(db, 9, 'BV4', 1);
  setState(db, stateKey.lastFull, '1000');
  return db;
}

const originIdOf = (db: ReturnType<typeof seeded>, snapshotId: number): number =>
  listWorkFolders(db).find((f) => f.originId === snapshotId)!.id;

describe('编辑动作', () => {
  // 第一次编辑自动克隆 —— 不给用户"开始整理"这一步
  it('第一次编辑时自动建工作副本,而且克隆真的做了', () => {
    const db = seeded();
    expect(hasWorkcopy(db)).toBe(false);

    createFolder(db, '前端');   // 这就是"第一次编辑"

    expect(hasWorkcopy(db)).toBe(true);
    // 克隆的不只是状态行 —— 快照里的三个夹子都搬过来了,新的那个 originId 为空
    expect(listWorkFolders(db).map((f) => f.originId)).toEqual([7, 8, 9, null]);
  });

  it('改名改的是工作副本,快照不动', () => {
    const db = seeded();
    const id = originIdOf(db, 7);
    renameFolder(db, id, 'AI/编程');

    expect(listWorkFolders(db).find((f) => f.id === id)!.name).toBe('AI/编程');
    expect(db.prepare(`SELECT title FROM folders WHERE id = 7`).get()).toEqual({ title: '深度学习' });
  });

  it('改名留痕', () => {
    const db = seeded();
    renameFolder(db, originIdOf(db, 7), 'AI/编程');
    const log = listOperations(db);
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe('rename_folder');
    expect(log[0]!.summary).toContain('深度学习');
    expect(log[0]!.summary).toContain('AI/编程');
  });

  it('锁定的默认收藏夹不能改名', () => {
    const db = seeded();
    expect(() => renameFolder(db, originIdOf(db, 9), '新名字')).toThrow(/不能改名/);
  });

  it('新建夹子返回 id,并且是空夹', () => {
    const db = seeded();
    const id = createFolder(db, '前端');
    expect(workItemIds(db, id)).toEqual([]);
    expect(listOperations(db)[0]!.kind).toBe('create_folder');
  });

  it('只能删空夹', () => {
    const db = seeded();
    expect(() => deleteFolder(db, originIdOf(db, 7))).toThrow(/还有 \d+ 条/);
    const empty = createFolder(db, '空夹');
    expect(() => deleteFolder(db, empty)).not.toThrow();
  });

  it('锁定的夹子不能删除(哪怕它是空的)', () => {
    const db = seeded();
    const locked = originIdOf(db, 9);
    removeItems(db, workItemIds(db, locked), locked);
    expect(() => deleteFolder(db, locked)).toThrow(/不能删除/);
  });

  it('合并 = 条目搬过去 + 源夹子消失,只留一条日志', () => {
    const db = seeded();
    const from = originIdOf(db, 8);
    const into = originIdOf(db, 7);
    const before = workItemIds(db, into).length;

    mergeFolders(db, from, into);

    expect(workItemIds(db, into)).toHaveLength(before + 1);
    expect(workItemIds(db, into)).toContain('BV3');
    expect(listWorkFolders(db).find((f) => f.id === from)).toBeUndefined();

    const log = listOperations(db);
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe('merge_folders');
  });

  it('合并进锁定的夹子是允许的(往里移条目是允许的)', () => {
    const db = seeded();
    const locked = originIdOf(db, 9);
    const from = originIdOf(db, 8);
    expect(() => mergeFolders(db, from, locked)).not.toThrow();
    expect(workItemIds(db, locked).sort()).toEqual(['BV3', 'BV4']);
  });

  // 移动 vs 也放进:B站 允许一个视频同时在多个夹子里,猜错就是悄悄删掉一份归属
  it('移动 = 离开原处,放进目标', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    const b = originIdOf(db, 8);
    addItems(db, ['BV1'], b);           // BV1 现在同时在 7 和 8
    moveItems(db, ['BV1'], b);          // 移动 → 只剩 8

    expect(workItemIds(db, a)).not.toContain('BV1');
    expect(workItemIds(db, b)).toContain('BV1');
  });

  it('也放进 = 原处保留', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    const b = originIdOf(db, 8);
    addItems(db, ['BV1'], b);

    expect(workItemIds(db, a)).toContain('BV1');
    expect(workItemIds(db, b)).toContain('BV1');
  });

  it('移出 = 只从那个夹子拿走,不放别处', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    removeItems(db, ['BV1'], a);
    expect(workItemIds(db, a)).toEqual(['BV2']);
  });

  it('移动/也放进/移出各记一条日志,条数是条目数不是操作数', () => {
    const db = seeded();
    const b = originIdOf(db, 8);
    moveItems(db, ['BV1', 'BV2'], b);
    moveItems(db, ['BV3'], b);
    expect(listOperations(db)).toHaveLength(2);
  });

  it('把条目移进锁定的夹子允许 —— 锁只限制改名/删除', () => {
    const db = seeded();
    const locked = originIdOf(db, 9);
    const a = originIdOf(db, 7);
    expect(() => moveItems(db, ['BV1'], locked)).not.toThrow();
    expect(workItemIds(db, locked)).toContain('BV1');
    expect(workItemIds(db, a)).not.toContain('BV1');
  });

  it('还原:副本清空、快照不动、记一条 reset', () => {
    const db = seeded();
    renameFolder(db, originIdOf(db, 7), 'AI/编程');
    resetWorkbench(db);

    expect(hasWorkcopy(db)).toBe(false);
    expect(listWorkFolders(db)).toEqual([]);
    expect(db.prepare(`SELECT title FROM folders WHERE id = 7`).get()).toEqual({ title: '深度学习' });
    expect(listOperations(db)[0]!.kind).toBe('reset');
  });

  it('AI 做的动作 actor=ai,其余 user —— 除此之外没有区别', () => {
    const db = seeded();
    const b = originIdOf(db, 8);
    moveItems(db, ['BV1'], b, { actor: 'ai', sessionId: 5 });
    renameFolder(db, originIdOf(db, 7), 'x');

    const [recent, older] = listOperations(db);
    expect(older!.actor).toBe('ai');
    expect(older!.sessionId).toBe(5);
    expect(recent!.actor).toBe('user');
    expect(recent!.sessionId).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/workbench.test.ts`
Expected: FAIL — `Cannot find module './workbench.js'`

- [ ] **Step 3: 实现**

`server/src/curator/workbench.ts`:

```ts
import type Database from 'better-sqlite3';
import {
  ensureWorkcopy,
  hasWorkcopy,
  listWorkFolders,
  workItemIds,
  resetWorkcopy,
} from '../db/repo/workbench.js';
import { listFolders, isLockedFolder } from '../db/repo/folders.js';
import { logOperation, type OpActor, type OpKind } from '../db/repo/operations.js';

/**
 * 编辑动作 —— 每个动作 = 改工作副本 + **必记一条日志**。
 *
 * 日志写在这里而不是路由里,是为了让"漏记"变得不可能:只要动作走了这个模块,
 * 就一定留痕。路由直接改表就会绕过它,所以 §9B.7 约束 1 说编辑只许写 work_*
 * 表 —— 而写 work_* 表的唯一入口是这里。
 */
export interface Actor {
  actor: OpActor;
  sessionId?: number;
}

const USER: Actor = { actor: 'user' };

function workFolderOrThrow(db: Database.Database, id: number) {
  const f = listWorkFolders(db).find((w) => w.id === id);
  if (!f) throw new Error(`工作副本里没有夹子 ${id}`);
  return f;
}

/** 锁定的夹子不能改名、不能删除 —— 但可以往里移条目 */
function assertNotLocked(db: Database.Database, workFolderId: number, action: string): void {
  const w = workFolderOrThrow(db, workFolderId);
  if (w.originId === null) return; // 新建的夹子不继承锁
  const origin = listFolders(db).find((f) => f.id === w.originId);
  if (origin && isLockedFolder(db, origin)) {
    throw new Error(`「${origin.title}」是 B站 自带的默认收藏夹,不能${action}`);
  }
}

export function renameFolder(
  db: Database.Database,
  folderId: number,
  name: string,
  who: Actor = USER,
): void {
  ensureWorkcopy(db);
  const trimmed = name.trim();
  if (!trimmed) throw new Error('名字不能为空');
  assertNotLocked(db, folderId, '改名');

  const before = workFolderOrThrow(db, folderId);
  db.prepare(`UPDATE work_folders SET name = ? WHERE id = ?`).run(trimmed, folderId);

  const originName = before.originId === null
    ? null
    : (listFolders(db).find((f) => f.id === before.originId)?.title ?? null);

  logOperation(db, {
    kind: 'rename_folder',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: originName
      ? `把「${originName}」改名为「${trimmed}」`
      : `把「${before.name}」改名为「${trimmed}」`,
    detail: { folderId, from: before.name, to: trimmed },
  });
}

export function createFolder(db: Database.Database, name: string, who: Actor = USER): number {
  ensureWorkcopy(db);
  const trimmed = name.trim();
  if (!trimmed) throw new Error('名字不能为空');

  const r = db
    .prepare(`INSERT INTO work_folders (origin_id, name, created_at) VALUES (NULL, ?, ?)`)
    .run(trimmed, Date.now());

  logOperation(db, {
    kind: 'create_folder',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: `新建夹子「${trimmed}」`,
    detail: { folderId: Number(r.lastInsertRowid) },
  });
  return Number(r.lastInsertRowid);
}

export function deleteFolder(db: Database.Database, folderId: number, who: Actor = USER): void {
  ensureWorkcopy(db);
  const f = workFolderOrThrow(db, folderId);
  assertNotLocked(db, folderId, '删除');

  const count = workItemIds(db, folderId).length;
  // 只能删空夹 —— 里面还有条目就没法表达"它们去哪了"
  if (count > 0) {
    throw new Error(`「${f.name}」里还有 ${count} 条,先把它们移走或删掉这个夹子里的条目`);
  }
  db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(folderId);

  logOperation(db, {
    kind: 'delete_folder',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: `删除空夹子「${f.name}」`,
    detail: { folderId, name: f.name },
  });
}

/**
 * 合并 = 把 from 的条目搬进 into、再删掉空的 from。
 *
 * **这是两步实现、一个动作**:用户说的是"合并",不该让他自己做
 * "移走 + 删除空夹"。实现细节不外露。
 */
export function mergeFolders(
  db: Database.Database,
  fromId: number,
  intoId: number,
  who: Actor = USER,
): void {
  ensureWorkcopy(db);
  if (fromId === intoId) throw new Error('不能把夹子并进它自己');

  const from = workFolderOrThrow(db, fromId);
  const into = workFolderOrThrow(db, intoId);
  const itemIds = workItemIds(db, fromId);

  db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
    );
    for (const itemId of itemIds) insert.run(intoId, itemId);
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(fromId);
  })();

  logOperation(db, {
    kind: 'merge_folders',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: `把「${from.name}」(${itemIds.length} 条)并入「${into.name}」`,
    detail: { fromId, intoId, itemIds },
  });
}

/** 移动:**离开原处**,放进目标。用户说"移动"就是不想保留原来那份归属。 */
export function moveItems(
  db: Database.Database,
  itemIds: readonly string[],
  toFolderId: number,
  who: Actor = USER,
): void {
  ensureWorkcopy(db);
  if (itemIds.length === 0) return;
  const to = workFolderOrThrow(db, toFolderId);

  db.transaction(() => {
    for (const itemId of itemIds) {
      db.prepare(`DELETE FROM work_folder_items WHERE item_id = ?`).run(itemId);
      db.prepare(
        `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
      ).run(toFolderId, itemId);
    }
  })();

  logOperation(db, {
    kind: 'move_items',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: `移动 ${itemIds.length} 条到「${to.name}」`,
    detail: { toFolderId, itemIds: [...itemIds] },
  });
}

/** 也放进:**保留原处**,同时加进目标(B站 允许一个视频属于多个夹子) */
export function addItems(
  db: Database.Database,
  itemIds: readonly string[],
  toFolderId: number,
  who: Actor = USER,
): void {
  ensureWorkcopy(db);
  if (itemIds.length === 0) return;
  const to = workFolderOrThrow(db, toFolderId);

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
  );
  db.transaction(() => {
    for (const itemId of itemIds) stmt.run(toFolderId, itemId);
  })();

  logOperation(db, {
    kind: 'add_items',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: `把 ${itemIds.length} 条也放进「${to.name}」`,
    detail: { toFolderId, itemIds: [...itemIds] },
  });
}

/** 移出:只从这个夹子拿走,不放别处 —— 拿走后可能变成"未归类" */
export function removeItems(
  db: Database.Database,
  itemIds: readonly string[],
  fromFolderId: number,
  who: Actor = USER,
): void {
  ensureWorkcopy(db);
  if (itemIds.length === 0) return;
  const from = workFolderOrThrow(db, fromFolderId);

  const stmt = db.prepare(`DELETE FROM work_folder_items WHERE folder_id = ? AND item_id = ?`);
  db.transaction(() => {
    for (const itemId of itemIds) stmt.run(fromFolderId, itemId);
  })();

  logOperation(db, {
    kind: 'remove_items',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: `从「${from.name}」移出 ${itemIds.length} 条`,
    detail: { fromFolderId, itemIds: [...itemIds] },
  });
}

/** 一键还原 —— 丢掉工作副本,回到快照 */
export function resetWorkbench(db: Database.Database, who: Actor = USER): void {
  const existed = hasWorkcopy(db);
  resetWorkcopy(db);

  logOperation(db, {
    kind: 'reset',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: existed ? '一键还原:丢掉了全部改动' : '一键还原(本来就没有改动)',
    detail: null,
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/workbench.test.ts`
Expected: PASS(15 tests)

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/workbench.ts server/src/curator/workbench.test.ts
git commit -m "feat(curator): 编辑动作 —— 改副本必记一条日志

移动 / 也放进 / 移出 是三个不同语义:B站 允许一个视频同时在多个夹子里,
只有一个'拖过去'的动作时系统只能替你猜,猜错就是悄悄删掉一份归属。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: HTTP 路由

**Files:**
- Modify: `server/src/curator/routes.ts`(在 `registerCuratorRoutes` 内追加)
- Modify: `server/src/curator/routes.test.ts`(追加)

**Interfaces:**
- Consumes: Task 3 的 `buildWorkbenchView`;Task 4 的八个动作;Task 2 的 `listOperations`
- Produces(前端要用的):
  ```
  GET    /api/workbench                    → { exists, basedOn, stale, folders, removed, unassignedCount }
  POST   /api/workbench/reset
  POST   /api/workbench/folders            { name }
  PATCH  /api/workbench/folders/:id        { name }
  DELETE /api/workbench/folders/:id
  POST   /api/workbench/folders/:id/merge  { fromId }
  POST   /api/workbench/items/move         { itemIds, toFolderId }
  POST   /api/workbench/items/add          { itemIds, toFolderId }
  POST   /api/workbench/items/remove       { itemIds, fromFolderId }
  GET    /api/workbench/log?limit=
  ```

- [ ] **Step 1: 写失败的测试**

追加到 `server/src/curator/routes.test.ts` 末尾:

```ts
describe('工作台路由', () => {
  const seed = (db: ReturnType<typeof openDb>) => {
    upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
    linkFolderItem(db, 7, 'BV1', 1);
    linkFolderItem(db, 7, 'BV2', 1);
  };

  it('GET 返回视图,没建副本时 exists=false', async () => {
    const { app, db } = makeApp();
    seed(db);
    const res = await app.inject({ method: 'GET', url: '/api/workbench' });
    expect(res.statusCode).toBe(200);
    expect(res.json().exists).toBe(false);
    expect(res.json().removed.map((r: { id: number }) => r.id)).toEqual([7]);
    await app.close();
  });

  it('第一次编辑自动建副本,GET 就能看到', async () => {
    const { app, db } = makeApp();
    seed(db);
    const list = await app.inject({ method: 'GET', url: '/api/workbench' });
    const workId = (await app.inject({
      method: 'POST', url: '/api/workbench/folders', payload: { name: '前端' },
    })).json().id;
    expect(workId).toBeGreaterThan(0);

    const after = await app.inject({ method: 'GET', url: '/api/workbench' });
    expect(after.json().exists).toBe(true);
    expect(after.json().folders).toHaveLength(2); // 深度学习 + 前端
    expect(list.json().exists).toBe(false);
    await app.close();
  });

  it('改名 / 合并 / 移动 各打一次,每次都留一条日志', async () => {
    const { app, db } = makeApp();
    seed(db);
    const created = (await app.inject({
      method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI/编程' },
    })).json().id;

    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const deep = view.folders.find((f: { originId: number }) => f.originId === 7).id;

    await app.inject({ method: 'PATCH', url: `/api/workbench/folders/${deep}`, payload: { name: 'AI/编程' } });
    await app.inject({ method: 'POST', url: `/api/workbench/items/move`, payload: { itemIds: ['BV1'], toFolderId: created } });
    await app.inject({ method: 'POST', url: `/api/workbench/folders/${created}/merge`, payload: { fromId: deep } });

    const log = (await app.inject({ method: 'GET', url: '/api/workbench/log' })).json().operations;
    expect(log.map((e: { kind: string }) => e.kind)).toEqual([
      'merge_folders', 'move_items', 'rename_folder',
    ]);
    await app.close();
  });

  it('删非空夹 → 400 并说清还有多少条', async () => {
    const { app, db } = makeApp();
    seed(db);
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const deep = view.folders.find((f: { originId: number }) => f.originId === 7).id;

    const res = await app.inject({ method: 'DELETE', url: `/api/workbench/folders/${deep}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('还有 2 条');
    await app.close();
  });

  it('改锁定的夹子 → 400', async () => {
    const { app, db } = makeApp();
    upsertFolder(db, { id: 9, title: '默认收藏夹', mediaCount: 0, raw: JSON.stringify({ attr: 0 }) });
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const locked = view.folders.find((f: { originId: number }) => f.originId === 9).id;

    const res = await app.inject({ method: 'PATCH', url: `/api/workbench/folders/${locked}`, payload: { name: '新名字' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('不能改名');
    await app.close();
  });

  it('还原后 exists=false,快照还在', async () => {
    const { app, db } = makeApp();
    seed(db);
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    const res = await app.inject({ method: 'POST', url: '/api/workbench/reset' });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/workbench' })).json().exists).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM folders`).get()).toEqual({ n: 1 });
    await app.close();
  });

  it('itemIds 不是数组 → 400', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/workbench/items/move',
      payload: { itemIds: 'BV1', toFolderId: 1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('不存在的夹子 → 404', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'PATCH', url: '/api/workbench/folders/999', payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/routes.test.ts`
Expected: FAIL — 新用例 404(路由还没注册)

- [ ] **Step 3: 实现**

在 `server/src/curator/routes.ts` 顶部补 import:

```ts
import { buildWorkbenchView } from '../db/repo/workbenchView.js';
import { listOperations } from '../db/repo/operations.js';
import { listWorkFolders } from '../db/repo/workbench.js';
import {
  renameFolder, createFolder, deleteFolder, mergeFolders,
  moveItems, addItems, removeItems, resetWorkbench,
} from './workbench.js';
```

在 `registerCuratorRoutes` 内、`app.get('/api/curator/audit'...)` 之后追加:

```ts
  // ── 整理工作台(spec m4b)────────────────────────────
  //
  // 编辑只写 work_* 表;动作全部经 curator/workbench.ts,那里保证每次都记日志。
  // 路由里**不许**直接写 work_* 表 —— 绕过那层就漏记了(§9B.7 约束 1、2)。

  /**
   * 把动作抛出来的异常翻成 400/404。
   *
   * **注意它是 return 出去的** —— 调用方必须 `return actionError(reply, e)`。
   * 早先写成"helper 自己 send、调用方继续往下走"会双响应:
   * Fastify 会先被 helper 发一次 400,再被调用方发一次 200。
   */
  const actionError = (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    e: unknown,
  ) => {
    const reason = (e as Error)?.message ?? String(e);
    // 动作自己抛的"工作副本里没有夹子 X"就是 404,其余输入问题都是 400
    return reply.code(/没有夹子|不存在/.test(reason) ? 404 : 400).send({ ok: false, reason });
  };

  app.get('/api/workbench', async () => {
    const view = buildWorkbenchView(db);
    const state = getWorkState(db);
    const currentFull = Number(getState(db, stateKey.lastFull) ?? 0) || 0;
    return {
      exists: state !== null,
      basedOn: state?.basedOn ?? null,
      // 整理期间又同步过 → 界面顶部要提示(不阻断,但不能不吭声)
      stale: state !== null && state.basedOn !== currentFull,
      ...view,
    };
  });

  app.post('/api/workbench/reset', async () => {
    resetWorkbench(db);
    log.event({ level: 'info', category: 'sync', message: '整理方案已还原' });
    return { ok: true };
  });

  app.post('/api/workbench/folders', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ ok: false, reason: 'name 不能为空' });
    }
    try {
      return { ok: true, id: createFolder(db, name) };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  app.patch('/api/workbench/folders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string') {
      return reply.code(400).send({ ok: false, reason: 'name 必须是字符串' });
    }
    try {
      renameFolder(db, id, name);
      return { ok: true };
    } catch (e) {
      // 夹子不存在、名字为空、锁定的夹子改不了 —— 都由动作自己抛,这里只翻译
      return actionError(reply, e);
    }
  });

  app.delete('/api/workbench/folders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      deleteFolder(db, id);
      return { ok: true };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  app.post('/api/workbench/folders/:id/merge', async (req, reply) => {
    const intoId = Number((req.params as { id: string }).id);
    const { fromId } = (req.body ?? {}) as { fromId?: number };
    if (typeof fromId !== 'number') {
      return reply.code(400).send({ ok: false, reason: '缺少 fromId' });
    }
    try {
      mergeFolders(db, fromId, intoId);
      return { ok: true };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  /**
   * move 和 add 共用一段参数校验:两者都是"把 itemIds 放进 toFolderId"的形状。
   * remove 的目标是 fromFolderId —— 语义不同,单独写(见下)。
   */
  const toFolderAction = (
    handler: (itemIds: string[], toFolderId: number) => void,
  ) => async (
    req: { body?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const body = (req.body ?? {}) as { itemIds?: unknown; toFolderId?: number };
    if (!Array.isArray(body.itemIds) || body.itemIds.some((x) => typeof x !== 'string')) {
      return reply.code(400).send({ ok: false, reason: 'itemIds 必须是字符串数组' });
    }
    if (typeof body.toFolderId !== 'number') {
      return reply.code(400).send({ ok: false, reason: '缺少 toFolderId' });
    }
    try {
      handler(body.itemIds as string[], body.toFolderId as number);
      return { ok: true };
    } catch (e) {
      return actionError(reply, e);
    }
  };

  app.post('/api/workbench/items/move', toFolderAction((ids, to) => moveItems(db, ids, to)));
  app.post('/api/workbench/items/add', toFolderAction((ids, to) => addItems(db, ids, to)));

  /** 移出:目标是从哪个夹子拿走,不是放进哪里 */
  app.post('/api/workbench/items/remove', async (req, reply) => {
    const body = (req.body ?? {}) as { itemIds?: unknown; fromFolderId?: number };
    if (!Array.isArray(body.itemIds) || body.itemIds.some((x) => typeof x !== 'string')) {
      return reply.code(400).send({ ok: false, reason: 'itemIds 必须是字符串数组' });
    }
    if (typeof body.fromFolderId !== 'number') {
      return reply.code(400).send({ ok: false, reason: '缺少 fromFolderId' });
    }
    try {
      removeItems(db, body.itemIds as string[], body.fromFolderId as number);
      return { ok: true };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  app.get('/api/workbench/log', async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 200) || 200;
    return { operations: listOperations(db, { limit }) };
  });
```

顶部 import 补:

```ts
import { getState, stateKey } from '../db/repo/state.js';
import { getWorkState } from '../db/repo/workbench.js';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/routes.test.ts`
Expected: PASS

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/routes.ts server/src/curator/routes.test.ts
git commit -m "feat(curator): /api/workbench/* 路由

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 前端类型与 API

**Files:**
- Modify: `web/src/types.ts`(追加)
- Modify: `web/src/api.ts`(追加)

**Interfaces:**
- Consumes: Task 5 的路由形状
- Produces: `workbenchApi`(Task 7、8 用)

- [ ] **Step 1: 加类型**

追加到 `web/src/types.ts`:

```ts
// ── M4b:整理工作台 ──────────────────────────────────────

export type ChangeMark = 'unchanged' | 'renamed' | 'created' | 'merged' | 'removed';

export interface WorkFolderView {
  id: number;
  name: string;
  originId: number | null;
  /** 改了名前叫什么;没改是 null。点开 ✎ 标记显示它 */
  originName: string | null;
  mark: ChangeMark;
  itemCount: number;
  locked: boolean;
}

export interface RemovedFolder {
  id: number;
  name: string;
  itemCount: number;
  /** 条目并进了哪个夹子;null = 被移出或本来就是空夹 */
  intoName: string | null;
  mark: 'merged' | 'removed';
}

export interface WorkbenchView {
  exists: boolean;
  basedOn: number | null;
  /** 整理期间又同步过 —— 顶部提示用 */
  stale: boolean;
  folders: WorkFolderView[];
  removed: RemovedFolder[];
  unassignedCount: number;
}

export type OpKind =
  | 'rename_folder' | 'merge_folders' | 'create_folder' | 'delete_folder'
  | 'move_items' | 'add_items' | 'remove_items' | 'delete_invalid_items' | 'reset';

export interface OperationEntry {
  id: number;
  ts: number;
  kind: OpKind;
  actor: 'user' | 'ai';
  sessionId: number | null;
  summary: string;
  detail: unknown;
}
```

- [ ] **Step 2: 加 API**

在 `web/src/api.ts` 的 `llmApi` 之后追加:

```ts
// ── M4b:整理工作台 ──────────────────────────────────────

export const workbenchApi = {
  get: () => api<WorkbenchView>('/api/workbench'),

  reset: () => json<{ ok: true }>('POST', '/api/workbench/reset'),

  createFolder: (name: string) =>
    json<{ ok: true; id: number }>('POST', '/api/workbench/folders', { name }).then((r) => r.id),

  renameFolder: (id: number, name: string) =>
    json<{ ok: true }>('PATCH', `/api/workbench/folders/${id}`, { name }),

  deleteFolder: (id: number) => json<{ ok: true }>('DELETE', `/api/workbench/folders/${id}`),

  mergeInto: (intoId: number, fromId: number) =>
    json<{ ok: true }>('POST', `/api/workbench/folders/${intoId}/merge`, { fromId }),

  /** 移动:离开原处 */
  move: (itemIds: string[], toFolderId: number) =>
    json<{ ok: true }>('POST', '/api/workbench/items/move', { itemIds, toFolderId }),

  /** 也放进:保留原处 */
  add: (itemIds: string[], toFolderId: number) =>
    json<{ ok: true }>('POST', '/api/workbench/items/add', { itemIds, toFolderId }),

  remove: (itemIds: string[], fromFolderId: number) =>
    json<{ ok: true }>('POST', '/api/workbench/items/remove', { itemIds, fromFolderId }),

  log: (limit = 200) =>
    api<{ operations: OperationEntry[] }>(`/api/workbench/log?limit=${limit}`).then(
      (r) => r.operations,
    ),
};
```

`json` 目前只接受 `'POST' | 'PUT' | 'DELETE'` —— **给它加上 `'PATCH'`**:

```ts
function json<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
```

并在 import 里补 `WorkbenchView` / `OperationEntry`。

- [ ] **Step 3: typecheck**

Run: `cd web && npm run typecheck`
Expected: 无输出(通过)

- [ ] **Step 4: 提交**

```bash
git add web/src/types.ts web/src/api.ts
git commit -m "feat(web): 工作台的类型与 API 封装

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 一份结构的树组件

**Files:**
- Create: `web/src/components/WorkFolderTree.tsx`

**Interfaces:**
- Consumes: Task 6 的 `WorkFolderView` / `RemovedFolder` / `Item`
- Produces:`<WorkFolderTree>`(Task 8 用)

**Props:**
```ts
{
  folders: WorkFolderView[];
  removed: RemovedFolder[];
  /** 当前展开的那个夹子里的条目;null = 没展开 */
  expanded: { folderId: number; items: Item[] } | null;
  selected: Set<string>;
  onToggleExpand: (folderId: number) => void;
  onToggleSelect: (itemId: string) => void;
  onRename: (folderId: number, name: string) => void;
  /** 手动锁 / 解锁。参数是**快照里的** originId —— 锁是锁原夹子的 */
  onToggleLock: (originId: number, locked: boolean) => void;
}
```

**锁的开关为什么在这一层**:锁属于**快照里的那个夹子**(`folders` 表),而工作副本里只有 `originId`。
自动判定(`attr === 0` 或标题命中)只有一个账号的样本,猜错了要能自己改 ——
这个开关就是那个出口。**没有它,P1 那轮做的 `PUT /api/folders/:id/lock` 就没有界面入口了。**

- [ ] **Step 1: 实现**

`web/src/components/WorkFolderTree.tsx`:

```tsx
import { useState } from 'react';
import { ChevronRight, ChevronDown, Lock, Pencil, Check, X } from 'lucide-react';
import type { ChangeMark, Folder, Item, RemovedFolder, WorkFolderView } from '../types';

/**
 * 一份结构(spec §9B.5)。
 *
 * **夹子和条目在视觉上是两种东西**:夹子是分组的头(可改名/合并/删除),
 * 条目在组里(只能移动)。让它们长得一样,人会以为条目也能改名。
 *
 * 改动标记是**算出来的**,点开能看原值 —— 每个标记都能展开,不能有的能有的不能。
 */
const MARK: Record<ChangeMark, { glyph: string; color: string; label: string } | null> = {
  unchanged: null,
  renamed: { glyph: '✎', color: 'var(--accent)', label: '改名' },
  created: { glyph: '✚', color: 'var(--ok)', label: '新建' },
  merged: { glyph: '⇥', color: 'var(--special)', label: '已并入别处' },
  removed: { glyph: '✖', color: 'var(--danger)', label: '已删除' },
};

export default function WorkFolderTree({
  folders,
  removed,
  expanded,
  selected,
  onToggleExpand,
  onToggleSelect,
  onRename,
  onToggleLock,
}: {
  folders: WorkFolderView[];
  removed: RemovedFolder[];
  expanded: { folderId: number; items: Item[] } | null;
  selected: Set<string>;
  onToggleExpand: (folderId: number) => void;
  onToggleSelect: (itemId: string) => void;
  onRename: (folderId: number, name: string) => void;
  onToggleLock: (originId: number, locked: boolean) => void;
}) {
  return (
    <div>
      {folders.map((f) => (
        <FolderRow
          key={f.id}
          folder={f}
          open={expanded?.folderId === f.id}
          items={expanded?.folderId === f.id ? expanded.items : []}
          selected={selected}
          onToggleExpand={onToggleExpand}
          onToggleSelect={onToggleSelect}
          onRename={onRename}
          onToggleLock={onToggleLock}
        />
      ))}

      {removed.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--rule)' }}>
          <span className="hud-label">已不在新结构里的夹子</span>
          {removed.map((r) => {
            const m = MARK[r.mark]!;
            return (
              <div
                key={r.id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '5px 4px',
                  color: 'var(--text-dim)',
                  textDecoration: 'line-through',
                }}
              >
                <span style={{ color: m.color, textDecoration: 'none' }}>{m.glyph}</span>
                <span>{r.name}</span>
                <span style={{ fontSize: 11 }}>
                  {r.intoName ? `→ 并入「${r.intoName}」` : `${r.itemCount} 条已移出`}
                </span>
                <span className="num" style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)' }}>
                  {r.itemCount}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FolderRow({
  folder,
  open,
  items,
  selected,
  onToggleExpand,
  onToggleSelect,
  onRename,
  onToggleLock,
}: {
  folder: WorkFolderView;
  open: boolean;
  items: Item[];
  selected: Set<string>;
  onToggleExpand: (folderId: number) => void;
  onToggleSelect: (itemId: string) => void;
  onRename: (folderId: number, name: string) => void;
  onToggleLock: (originId: number, locked: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const mark = MARK[folder.mark];

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== folder.name) onRename(folder.id, next);
    else setDraft(folder.name);
  };

  return (
    <div style={{ borderBottom: '1px solid var(--rule)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 4px' }}>
        <button
          type="button"
          aria-label={open ? '收起' : '展开'}
          aria-expanded={open}
          onClick={() => onToggleExpand(folder.id)}
          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)' }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        {/* 锁图标既是标识也是开关。只对快照里来的夹子给(新建的不继承锁)。
            自动判定只有一个账号的样本,猜错了你自己改回来。 */}
        {folder.originId !== null && (
          <button
            type="button"
            aria-label={`${folder.locked ? '解锁' : '锁定'}「${folder.name}」`}
            title={
              folder.locked
                ? '不能改名 / 不能删除,只能移走里面的条目。点击解锁'
                : '点击锁定(默认收藏夹这类不可改名/删除的夹子)'
            }
            onClick={() => onToggleLock(folder.originId as number, !folder.locked)}
            style={{
              flex: 'none', display: 'grid', placeItems: 'center', padding: 0,
              border: 'none', background: 'none', cursor: 'pointer',
              color: folder.locked ? 'var(--warn)' : 'var(--text-dim)',
              opacity: folder.locked ? 1 : 0.3,
            }}
          >
            <Lock size={11} />
          </button>
        )}

        {editing ? (
          <>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') { setDraft(folder.name); setEditing(false); }
              }}
              style={{
                flex: 1, minWidth: 0, font: 'inherit', fontSize: 'var(--fs-13)',
                background: 'var(--surface-2)', color: 'var(--text)',
                border: '1px solid var(--accent)', padding: '1px 5px',
              }}
            />
            <button type="button" aria-label="确认" onClick={commit}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ok)' }}>
              <Check size={13} />
            </button>
            <button type="button" aria-label="取消" onClick={() => { setDraft(folder.name); setEditing(false); }}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-dim)' }}>
              <X size={13} />
            </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 'var(--fs-13)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {folder.name}
            </span>

            {mark && (
              <span
                title={
                  folder.mark === 'renamed' && folder.originName
                    ? `原来是「${folder.originName}」`
                    : mark.label
                }
                style={{ fontSize: 11, color: mark.color, flex: 'none', cursor: 'help' }}
              >
                {mark.glyph}
                {folder.mark === 'renamed' && folder.originName && (
                  <span style={{ color: 'var(--text-dim)' }}> ← 「{folder.originName}」</span>
                )}
              </span>
            )}

            {/* 锁定的夹子不给改名入口 —— 点了服务端也会拒,不如别给 */}
            {!folder.locked && (
              <button
                type="button"
                aria-label={`重命名「${folder.name}」`}
                onClick={() => setEditing(true)}
                style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5 }}
              >
                <Pencil size={11} />
              </button>
            )}

            <span className="num" style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)', color: 'var(--text-dim)', flex: 'none' }}>
              {folder.itemCount}
            </span>
          </>
        )}
      </div>

      {open && (
        <div style={{ paddingLeft: 24, paddingBottom: 6 }}>
          {items.map((it) => (
            <label
              key={it.id}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0', fontSize: 'var(--fs-12)', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={selected.has(it.id)}
                onChange={() => onToggleSelect(it.id)}
                aria-label={`选择「${it.title}」`}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.title}
              </span>
            </label>
          ))}
          {items.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-12)', padding: '4px 0' }}>
              这个夹子是空的
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `cd web && npm run typecheck`
Expected: 无输出

- [ ] **Step 3: 提交**

```bash
git add web/src/components/WorkFolderTree.tsx
git commit -m "feat(web): 一份结构的树 —— 夹子头 + 条目行,标记可展开看原值

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 重写 /curator + 操作日志面板

**Files:**
- Create: `web/src/components/OperationLog.tsx`
- Modify: `web/src/pages/curator.tsx`(**整体替换**)

**Interfaces:**
- Consumes: Task 6 的 `workbenchApi`;Task 7 的 `<WorkFolderTree>`;`/api/folders/:id/items`
- Produces:页面

- [ ] **Step 1: 操作日志面板**

`web/src/components/OperationLog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { workbenchApi } from '../api';
import type { OperationEntry } from '../types';

/** 留痕的界面落点(spec §9B.5)。一次操作一行 —— 拖 412 条也是这一行。 */
export default function OperationLog({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<OperationEntry[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    workbenchApi.log().then(setRows).catch((e) => setError((e as Error).message));
  }, [refreshKey]);

  if (error) return <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-12)' }}>{error}</div>;

  return (
    <div className="hud-panel" style={{ padding: 12, maxHeight: 260, overflowY: 'auto' }}>
      <span className="hud-label">操作记录</span>
      {rows.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-12)', paddingTop: 6 }}>
          还没有任何改动
        </div>
      )}
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--rule)' }}>
          <span className="num" style={{ fontSize: 11, color: 'var(--text-dim)', flex: 'none' }}>
            {new Date(r.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </span>
          {/* AI 做的改动明确标出来 —— 但它是**同一种**改动,只是来源不同 */}
          {r.actor === 'ai' && (
            <span className="hud-label" style={{ fontSize: 10, color: 'var(--ai)', flex: 'none' }}>AI</span>
          )}
          <span style={{ fontSize: 'var(--fs-12)' }}>{r.summary}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 重写页面**

`web/src/pages/curator.tsx` —— **整体替换**:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useRequest } from '@umijs/max';
import { Button, Input, Alert, Modal, Select } from 'antd';
import { Bot, Undo2, Plus, FolderInput, Lock } from 'lucide-react';
import { api, rawResult, workbenchApi, setFolderLock } from '../api';
import type { Folder } from '../types';
import WorkFolderTree from '../components/WorkFolderTree';
import OperationLog from '../components/OperationLog';
import { useAssistant } from '../components/assistant';
import type { Item, WorkbenchView } from '../types';

/** 整理 —— 一份结构,改动带标记。AI 不在这里(在右下角对话框里)。 */
export default function CuratorPage() {
  const { openWith } = useAssistant();

  const [view, setView] = useState<WorkbenchView | null>(null);
  const [expanded, setExpanded] = useState<{ folderId: number; items: Item[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [logKey, setLogKey] = useState(0);
  const [targetFolder, setTargetFolder] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setView(await workbenchApi.get());
    setLogKey((k) => k + 1);
  }, []);

  // 还没有工作副本时,页面要显示的是 **B站 现在的样子** —— 那份结构在快照里,
  // 而工作台视图此时刻意返回空(见 buildWorkbenchView 的开头)。
  // 所以这条只在 !exists 分支用到。
  const { data: foldersRes } = useRequest(() => api<{ folders: Folder[] }>('/api/folders'), {
    formatResult: rawResult,
  });
  const snapshotFolders = foldersRes?.folders ?? [];

  useEffect(() => {
    reload().catch((e) => setError((e as Error).message));
  }, [reload]);

  /** 所有编辑动作走这里:统一错误处理 + 重新拉视图(标记每次都重算) */
  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setError('');
    setNotice('');
    try {
      await fn();
      await reload();
      if (okMsg) setNotice(okMsg);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleExpand = async (folderId: number) => {
    if (expanded?.folderId === folderId) {
      setExpanded(null);
      return;
    }
    const originId = view?.folders.find((f) => f.id === folderId)?.originId;
    // 新建的夹子还没挂任何条目
    if (originId == null) {
      setExpanded({ folderId, items: [] });
      return;
    }
    // 条目从同步快照里取 —— 工作副本只存归属
    // ponytail: 这里显示的是**快照里那个夹子当时**的内容,不是你移动后的。
    // 正确做法要加一个"按工作副本取条目"的接口,见 spec §9B.6,本轮不做。
    const r = await api<{ items: Item[] }>(`/api/folders/${originId}/items?pageSize=500`);
    setExpanded({ folderId, items: r.items });
  };

  const toggleSelect = (itemId: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  const selectedIds = [...selected];

  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="hud-label" style={{ color: 'var(--accent)' }}>整理</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          {view?.exists ? `${view.folders.length} 个夹子 · 改动中` : '正在显示 B站 现在的样子 · 还没有自己的改动'}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Button icon={<Bot size={14} />} onClick={() => openWith()}>打开 AI 助手</Button>
          <Button
            danger
            icon={<Undo2 size={14} />}
            disabled={!view?.exists}
            onClick={() =>
              Modal.confirm({
                title: '还原到上次同步的样子?',
                content: '会丢掉你在这个页面上做的全部改动。B站 上的东西本来就没被动过。',
                okText: '还原',
                cancelText: '算了',
                onOk: () => act(() => workbenchApi.reset(), '已还原。'),
              })
            }
          >
            一键还原
          </Button>
        </span>
      </div>

      {view?.stale && (
        <Alert
          type="warning"
          showIcon
          message="你整理期间收藏夹又同步过 —— 显示的快照可能已经不是最新的,建议先看看差异再继续"
        />
      )}
      {error && <Alert type="error" showIcon closable message={error} onClose={() => setError('')} />}
      {notice && <Alert type="info" showIcon closable message={notice} onClose={() => setNotice('')} />}

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div className="hud-panel" style={{ flex: 2, minWidth: 0, padding: 12, maxHeight: 460, overflowY: 'auto' }}>
          {view?.exists ? (
            <WorkFolderTree
              folders={view.folders}
              removed={view.removed}
              expanded={expanded}
              selected={selected}
              onToggleExpand={toggleExpand}
              onToggleSelect={toggleSelect}
              onRename={(id, name) => void act(() => workbenchApi.renameFolder(id, name))}
              onToggleLock={(originId, locked) => void act(() => setFolderLock(originId, locked))}
            />
          ) : (
            /* 还没有自己的改动 —— 显示 B站 现在的样子(只读)。
               这条分支不能省:没有它首启就是一片空白。 */
            <div>
              <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginBottom: 8 }}>
                这是 B站 上现在的结构。改动任意一处就会开始记录你的方案。
              </div>
              {snapshotFolders.map((f) => (
                <div
                  key={f.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 4px', borderBottom: '1px solid var(--rule)',
                  }}
                >
                  {f.locked && (
                    <Lock size={11} style={{ flex: 'none', color: 'var(--warn)' }}>
                      <title>B站 自带的默认收藏夹 —— 不能改名、不能删除,只能移走里面的条目</title>
                    </Lock>
                  )}
                  <span style={{ fontSize: 'var(--fs-13)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.title}
                  </span>
                  <span className="num" style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                    {f.mediaCount}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <OperationLog refreshKey={logKey} />
          {view && view.unassignedCount > 0 && (
            <div className="hud-panel" style={{ padding: 12 }}>
              <span className="hud-label" style={{ color: 'var(--warn)' }}>未归类</span>
              <div className="num" style={{ fontSize: 'var(--fs-18)', color: 'var(--warn)' }}>
                {view.unassignedCount}
              </div>
              <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                这些条目不属于任何夹子
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 动作条 ─────────────────────────────── */}
      <div className="hud-panel" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
        <Button icon={<Plus size={14} />} onClick={() => {
          let name = '';
          Modal.confirm({
            title: '新建夹子',
            content: <Input autoFocus placeholder="夹子名字" onChange={(e) => { name = e.target.value; }} />,
            okText: '新建', cancelText: '取消',
            onOk: () => act(() => workbenchApi.createFolder(name), `已新建「${name}」`),
          });
        }}>
          新建夹子
        </Button>

        <Select
          placeholder={`要移动/放入的夹子(已选 ${selectedIds.length} 条)`}
          value={targetFolder ?? undefined}
          onChange={setTargetFolder}
          style={{ minWidth: 220 }}
          options={(view?.folders ?? []).map((f) => ({ value: f.id, label: f.name }))}
        />

        {/* 移动 vs 也放进 必须分开:B站 允许一个视频属于多个夹子,
            只有一个"放过去"的动作时系统只能替你猜,猜错就是悄悄删掉一份归属 */}
        <Button
          disabled={selectedIds.length === 0 || targetFolder === null}
          onClick={() => act(() => workbenchApi.move(selectedIds, targetFolder!), `已移动 ${selectedIds.length} 条`).then(() => setSelected(new Set()))}
        >
          移动
        </Button>
        <Button
          icon={<FolderInput size={14} />}
          disabled={selectedIds.length === 0 || targetFolder === null}
          onClick={() => act(() => workbenchApi.add(selectedIds, targetFolder!), `已放入 ${selectedIds.length} 条`).then(() => setSelected(new Set()))}
        >
          也放进
        </Button>

        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          勾选条目后可移动 / 也放进;夹子名前的 ✎ 可改名
        </span>
      </div>

      <div style={{ height: 56, flex: 'none' }} aria-hidden />
    </div>
  );
}
```

**已知取舍(代码里已留 `ponytail:` 注释)**:展开夹子时按 `originId` 取条目 = 显示的是**快照里那个夹子当时的内容**,不是你移动之后的内容。本轮不修 —— 正确做法是加一个"按工作副本取条目"的接口,见 spec §9B.6。

- [ ] **Step 3: typecheck + build**

Run: `cd web && npm run typecheck && npx max build`
Expected: 都通过

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/curator.tsx web/src/components/OperationLog.tsx
git commit -m "feat(web): 整理页重写 —— 一份结构 + 标记 + 操作记录 + 一键还原

AI 从这一页移除。手动整理没有 AI 也能做完,这是底线。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: 把 AI 的归类提案接回对话框

**为什么这一节在实施中改过(2026-09-16,控制者裁定)**:原计划里 T9 只是给抽屉加一个「应用」按钮。
实施到 T8 时发现 **`run-pass-2` 已经不可达** —— 它读的 `taxonomy_draft` 只由 `PUT draft` 和
`run-pass-1` 写,而 T8 重写整理页之后**前端再没有任何地方调它们**。于是 `run-pass-2` 永远回
400「还没有体系草稿」,它产出的 `classifications` 也就不存在 —— **T9 会没有东西可应用。**

根因是 m4b 设计让 `taxonomy_draft` 退场了(W3 取消了会话级草稿),但 Pass 2 还挂在它上面。
修法顺带让整条链更简单:**体系就是工作副本本身**,不需要中间那份草稿。

**Files:**
- Modify: `server/src/curator/routes.ts`(`run-pass-2` 改读工作副本;新增 `POST /api/curator/sessions/:id/apply`)
- Modify: `server/src/curator/routes.test.ts`(改 `run-pass-2` 的既有用例 + 新增 apply 用例)
- Modify: `web/src/api.ts`(`curatorApi.apply`)
- Modify: `web/src/components/ChatDrawer.tsx`(归类 / 应用两个按钮)

**Interfaces:**
- Consumes: Task 4 的 `moveItems(db, itemIds, toFolderId, who)`;Task 1 的 `listWorkFolders` /
  `workItemIds`;`db/repo/classifications.ts` 的 `getClassification`;Task 2 的 `listOperations`
- Produces:
  ```
  POST /api/curator/sessions/:id/run-pass-2   (语义变了:体系来自工作副本)
  POST /api/curator/sessions/:id/apply        → { ok, applied, skipped, conflicts }
  ```

- [ ] **Step 1: 改 `run-pass-2` —— 体系改从工作副本取**

现在它读 `getLatestDraft(db, id)`(死路)。改成读工作副本:

```ts
    // 体系就是**工作副本本身** —— m4b 取消了会话级的草稿(W3),
    // 所以这里不该再去读 taxonomy_draft(那已经是死路,没人写了)。
    //
    // tempId 直接用工作夹子 id 的字符串形式:这样 Pass 2 吐出来的 folderTempId
    // 就是**工作夹子 id 本身**,apply 不用再做任何映射 —— 少一层会出错的翻译。
    const work = listWorkFolders(db);
    if (work.length === 0) {
      return reply.code(400).send({
        ok: false,
        reason: '还没有结构可以归类 —— 先去「整理」页建几个夹子,或者手动改一版',
      });
    }
    const folders: FolderSpec[] = work.map((w) => ({
      tempId: String(w.id),
      name: w.name,
      description: '',
      rule: '', // 工作副本里没有"判定规则"这个概念(那是 AI 提案的产物)
      estCount: workItemIds(db, w.id).length,
      ...(w.originId === null ? {} : { reuseFolderId: w.originId }),
    }));
```

用它替换原来那段 `const draft = getLatestDraft(...)` 与 `folders: draft.folders`。

顶部 import 补:`import { listWorkFolders, workItemIds } from '../db/repo/workbench.js';`

**注意 `rule: ''` 的后果**:Pass 2 的 prompt 会少掉"判定规则"这个信号。这是真实的取舍 ——
工作副本里只有名字。**如果分类质量明显变差**,再加一个"给夹子写一句规则"的字段
(`work_folders` 加列即可,表结构不用重做)。先按最简的做。

- [ ] **Step 2: 加 `apply` 路由**

```ts
  /**
   * 把 AI 的归类提案应用到工作副本。
   *
   * 应用产生的就是普通的 move_items,只是 actor='ai' —— 这是 W7 的落实:
   * 同样的标记、同样的日志、同样被还原覆盖。
   *
   * **不需要 mapping**:Step 1 让 Pass 2 用工作夹子 id 当 tempId,
   * 所以 `folderTempId` 本身就是工作夹子 id。少一层翻译就少一处出错的地方。
   *
   * 生成提案之后你如果又手改过,这里会**报出冲突数**,不静默覆盖 ——
   * 静默覆盖是最糟的一种:你以为自己改的还在。
   */
  app.post('/api/curator/sessions/:id/apply', async (req, reply) => {
    const sessionId = Number((req.params as { id: string }).id);
    if (!getSession(db, sessionId)) return reply.code(404).send({ ok: false, reason: '会话不存在' });

    const stored = getClassification(db, sessionId);
    if (!stored || stored.assignments.length === 0) {
      return reply.code(400).send({ ok: false, reason: '这个会话还没有归类提案' });
    }

    // 提案生成之后有没有新的**用户**改动?有就说明你在生成期间手改过
    const conflicts = listOperations(db, { sinceTs: stored.updatedAt }).filter(
      (e) => e.actor === 'user',
    ).length;

    const byFolder = new Map<number, string[]>();
    for (const a of stored.assignments) {
      if (a.folderTempId === null) continue;
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

    log.event({
      level: 'info',
      category: 'llm',
      message: `应用 AI 结论:${applied} 条落到 ${byFolder.size} 个夹子,跳过 ${skipped} 条`,
    });
    return { ok: true, applied, skipped, conflicts };
  });
```

- [ ] **Step 3: 改既有测试**

`routes.test.ts` 里 `run-pass-2` 那两条用例现在会失败 —— 它们用 `PUT draft` 造体系,而那条路已经不通了。改成**造工作副本**:

```ts
  const seedStructure = async (app: FastifyInstance): Promise<number> => {
    // 体系现在就是工作副本,不再走草稿
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI/编程' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    return view.folders[0].id as number;
  };
```

「归类结果落库并返回」那条:用 `seedStructure`,并断言
`res.json().assignments[0].folderTempId` 等于那个**工作夹子 id 的字符串**。
「没有草稿 → 400」那条:改成「没有结构 → 400」,断言 reason 里含「还没有结构」。

- [ ] **Step 4: 新增 apply 测试**

```ts
  it('应用 AI 结论:条目按归类结果落到工作副本,日志 actor=ai', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const workId = await seedStructure(app);

    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(workId), confidence: 0.9, reason: 'r' },
      { itemId: 'BV2', folderTempId: String(workId), confidence: 0.8, reason: 'r' },
    ]);

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(2);

    const log = (await app.inject({ method: 'GET', url: '/api/workbench/log' })).json().operations;
    const ai = log.find((e: { actor: string }) => e.actor === 'ai');
    expect(ai.kind).toBe('move_items');
    expect(ai.sessionId).toBe(sid);
    await app.close();
  });

  it('提案里的夹子已经被删了 → 跳过它,其余照常', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const workId = await seedStructure(app);
    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(workId + 999), confidence: 0.9, reason: 'r' },
    ]);

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(0);
    expect(res.json().skipped).toBe(1);
    await app.close();
  });

  it('生成提案之后你又手改过 → 回报 conflicts,不静默覆盖', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const workId = await seedStructure(app);
    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(workId), confidence: 0.9, reason: 'r' },
    ]);

    // 把提案的 updated_at 推到过去,再写一条更新的用户操作
    db.prepare(`UPDATE classifications SET updated_at = ? WHERE session_id = ?`).run(1, sid);
    await app.inject({
      method: 'PATCH', url: `/api/workbench/folders/${workId}`, payload: { name: '改过了' },
    });

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.json().conflicts).toBeGreaterThan(0);
    await app.close();
  });

  it('没有提案 → 400', async () => {
    const { app } = makeApp();
    const sid = await newSession(app);
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
```

- [ ] **Step 5: 前端 —— 抽屉里两个按钮**

`web/src/api.ts` 的 `curatorApi` 里加:

```ts
  /** 把 AI 归类提案应用到工作副本。folderTempId 就是工作夹子 id,不需要映射 */
  apply: (sessionId: number) =>
    json<{ ok: true; applied: number; skipped: number; conflicts: number }>(
      'POST', `/api/curator/sessions/${sessionId}/apply`,
    ),
```

`ChatDrawer.tsx` 在输入框上方加一条操作区(只在有分类结果时出现):

```tsx
      {detail?.classification && (
        <div
          style={{
            flex: 'none', padding: '8px 14px', borderTop: '1px solid var(--rule)',
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginBottom: 6 }}>
            AI 提了一版归类({detail.classification.assignments.length} 条)。
            确认后才会落到「整理」页的结构上。
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="primary" size="small" loading={busy} onClick={() => void applyProposal()}>
              应用到现在的结构
            </Button>
            <Button size="small" loading={busy} onClick={() => void runClassify()}>
              重新归类
            </Button>
          </div>
        </div>
      )}
```

组件内加:

```tsx
  const applyProposal = async () => {
    if (sessionId === null) return;
    setBusy(true);
    setError('');
    try {
      const r = await curatorApi.apply(sessionId);
      setNotice(
        `已应用 ${r.applied} 条` +
          (r.skipped > 0 ? `;${r.skipped} 条因为夹子没了被跳过` : '') +
          (r.conflicts > 0 ? ` ⚠️ 期间有 ${r.conflicts} 处手改,去「整理」页确认一下` : ''),
      );
      setDetail(await curatorApi.getSession(sessionId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runClassify = async () => {
    if (sessionId === null) return;
    setBusy(true);
    setError('');
    try {
      const r = await curatorApi.runPass2(sessionId);
      setDetail(await curatorApi.getSession(sessionId));
      setNotice(`归类完成:${r.assignments.length} 条(共 ${r.total} 条)`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
```

空态那个「整理文件夹」按钮旁边再加一个入口:

```tsx
            <Button icon={<Sparkles size={14} />} onClick={() => send('按现在「整理」页里的结构,把收藏归类')}>
              按现在的结构归类
            </Button>
```

它只是让 AI 在对话里讨论;真正的批量归类由上面的「重新归类」做。

`setNotice` 需要一个新的 `useState`(`busy` / `error` 已有),并在 Alert 区渲染出来。

- [ ] **Step 6: 验证 + 提交**

```bash
npm test -w server          # 串行跑,别和 typecheck 并行
npm run typecheck -w server
cd web && npm run typecheck && npx max build
git add server/src/curator/routes.ts server/src/curator/routes.test.ts web/src/api.ts web/src/components/ChatDrawer.tsx
git commit -m "feat: AI 归类提案接回对话框 —— 体系改从工作副本取

m4b 取消了会话级草稿(W3),但 run-pass-2 还挂在 taxonomy_draft 上 ——
T8 重写整理页之后那条路就断了(没人再写它),于是 Pass 2 永远 400,
apply 也就没有东西可应用。修法是顺带的简化:体系就是工作副本本身,
tempId 直接用工作夹子 id,apply 因此不需要任何映射。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

**遗留(记进 ledger,本轮不处理)**:`run-pass-1` / `PUT /draft` / `GET /draft` 现在不可达了
(没有前端调用方,写的表也没人读)。改它们要连带动它们的测试,超出本轮范围。

---

## Self-Review

**1. Spec 覆盖**

| Spec 章节 | 落在哪 |
|---|---|
| §9B.1 W1 只显示一份 | Task 7/8 |
| §9B.1 W2 快照只读 | Task 1(test「快照一行不动」)、Task 4(改名后断言快照没变) |
| §9B.1 W3 全局唯一 | Task 1(`CHECK(id = 1)`) |
| §9B.1 W4 AI 只在对话框 | Task 8(移除 AI)、Task 9(抽屉里应用) |
| §9B.1 W5 还原只有一个含义 | Task 4 `resetWorkbench` + Task 8 按钮文案 |
| §9B.1 W6 留痕记决策 | Task 2(test「一次操作只产生一行」) |
| §9B.1 W7 AI 改动是同一种 | Task 4(test「actor 之外没区别」)、Task 9、Task 2(无 `apply_ai` kind) |
| §9B.2 四张表 | Task 1 |
| §9B.2 `taxonomy_draft` 保留不读写 | 刻意不动的文件清单里有 |
| §9B.3 类型枚举 | Task 2 `OpKind` |
| §9B.4 首次编辑自动克隆 | Task 4 `ensureWorkcopy` 在动作开头 |
| §9B.4 冲突不静默覆盖 | Task 9 `conflicts` |
| §9B.5 锁 | Task 3 `locked`、Task 4 `assertNotLocked`、Task 7 图标与禁用改名 |
| §9B.5 夹子/条目视觉区分 | Task 7(夹子头 vs 缩进的条目行) |
| §9B.5 标记可展开看原值 | Task 3 `originName`、Task 7 的 title |
| §9B.5 未归类一个说法 | Task 3 `unassignedCount`、Task 8 面板 |
| §9B.6 不在这一轮 | 没有任何任务实现搜索/聚合/失效栏/M5 |
| §9B.7 五条硬约束 | Task 4 的模块边界(1、2)、Task 2 的类型表(3)、Task 4 `assertNotLocked`(4)、Task 5 的 `stale`(5) |
| §9B.8 测试清单 | 分散在 Task 1、3、4、9 |

**§9B.6 里"失效栏的完整 UI"和"删除失效条目"这一轮不做** —— `delete_invalid_items` 只是枚举里预留了类型,没有对应动作。

**2. 占位符扫描**:初稿有三处"先写错再纠正"(`toggleExpand` 取条目、`mapping` 按名字匹配、`itemAction` 套用到 `remove`)。**已全部改成直接写正确版本** —— 只写错版本再旁边纠正,等于给按顺序读的人埋了个坑。现在每个代码块都是可以直接粘的。

**3. 类型一致性**:`WorkFolderView.mark` 在 Task 3 是 `ChangeMark`(5 值),Task 6 的类型和 Task 7 的 `MARK` 表都是同样 5 个键。`RemovedFolder.mark` 只有 `'merged' | 'removed'`,Task 7 的 `MARK[r.mark]!` 用非空断言 —— 一致。`Actor` 只在后端用,前端不带。

## Execution Handoff

Plan 完成,保存到 `docs/superpowers/plans/2026-09-16-M4b-curator-workbench.md`。
