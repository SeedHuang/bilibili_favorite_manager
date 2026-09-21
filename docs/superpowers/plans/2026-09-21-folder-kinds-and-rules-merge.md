# 夹子三分类 + 规则并入整理页 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落实 spec 2026-09-21 —— 夹子三分类(默认/人类/AI)、成员资格写入器(人类夹子只加不清、AI 夹子精确对账)、删除安全网、审查草稿体系,并把规则编辑并入整理页(删 /rules 顶级 tab)。

**Architecture:** 所有程序化成员变更收口到 `writeMembership` 一个函数(三条纪律编码在一处);AI 夹子用侧表 `work_ai_folders` 标记(零 ALTER);审查草稿独立成表(与生成草稿互不误伤);「整理」是纯本地计算端点,不调 LLM。

**Tech Stack:** Fastify + better-sqlite3 + vitest(服务端);Umi Max + antd 5(前端)。

**Spec:** `docs/superpowers/specs/2026-09-21-folder-kinds-and-rules-merge-design.md`(执行者必须先读它 —— 本计划只在实现层面展开,拍板理由都在 spec 里)。

## Global Constraints

- **禁止 AI 执行 git add / git commit。** 每个任务收尾时把改动留在工作区,提交由用户完成。计划里的「收尾」步骤全部是跑门禁,不是提交。
- 零 `ALTER TABLE` —— 新表全部 `CREATE TABLE IF NOT EXISTS`,加进 `server/src/db/schema.ts` 的 `SCHEMA_SQL`。
- 编辑只写 `work_*` 表;任何改工作副本的动作必须经 `server/src/curator/workbench.ts`(它保证记日志),路由不许直接写表。
- 「整理」(tidy)**纯本地计算**:不 import `llm/`,不调 `complete()`。
- 人类夹子只加不清;AI 夹子成员恒等于规则命中集;安全网=字面版(不在默认夹就补进,哪怕有别家);人手动移出不触发安全网。
- 无标记夹子 = 人类夹子;AI 标记只写不改。
- 夹子名上限 20 字(B 站限制,现有 `createFolder`/`renameFolder` 已拦)。
- 门禁:`cd server && npx tsc --noEmit && npx vitest run`;前端 `cd web && npx tsc --noEmit && npx max build`(**max build 退出码恒为 1 是既有 esbuild 问题,门禁看 typecheck + 输出里出现 "Compiled successfully"**)。
- 测试纪律:路由测试全 mock LLM(`vi.mock('../llm/provider.js')`,照 `ruleRoutes.test.ts` 头部的写法);tag id 一律现查真实 id,不硬编码自增值。

## 逐字代码的实跑状态(执行者必读)

- Task 2 的实现与测试块**已实跑通过**(2026-09-21,scratch 环境跑红→绿,7 用例 + tsc 干净;scratch 已删)。
- Task 3 的「删除安全网」事务体在 scratch 里以等价形式验证过;merge 规则并集**未实跑**。
- 其余标注「未实跑」的块:执行者以**当前代码现状**为准,形 anything 对不上就以现有代码为准、保语义不变,不要硬抄。

---

### Task 1: Schema 两张新表 + AI 夹子标记 repo

**Files:**
- Modify: `server/src/db/schema.ts`(SCHEMA_SQL 末尾追加)
- Create: `server/src/db/repo/aiFolders.ts`
- Test: `server/src/db/repo/aiFolders.test.ts`

**Interfaces:**
- Produces: `markFolderAsAi(db, folderId: number): void`、`isAiFolder(db, folderId: number): boolean`、`listAiFolderIds(db): Set<number>`(后所有任务都靠这三个)

- [ ] **Step 1: 写失败测试**

```ts
// server/src/db/repo/aiFolders.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { markFolderAsAi, isAiFolder, listAiFolderIds } from './aiFolders.js';

describe('AI 夹子标记', () => {
  it('标记后可查;没标记的夹子是人类夹子(保守默认)', () => {
    const db = openDb(':memory:');
    const r = db
      .prepare(`INSERT INTO work_folders (origin_id, name, created_at) VALUES (NULL, 'AI 编程', ?)`)
      .run(Date.now());
    const id = Number(r.lastInsertRowid);

    expect(isAiFolder(db, id)).toBe(false); // 无标记 = 人类
    markFolderAsAi(db, id);
    expect(isAiFolder(db, id)).toBe(true);
    expect([...listAiFolderIds(db)]).toEqual([id]);
  });

  it('夹子删了标记跟着走(CASCADE)', () => {
    const db = openDb(':memory:');
    const r = db
      .prepare(`INSERT INTO work_folders (origin_id, name, created_at) VALUES (NULL, '临时', ?)`)
      .run(Date.now());
    const id = Number(r.lastInsertRowid);
    markFolderAsAi(db, id);
    db.prepare(`PRAGMA foreign_keys = ON`).run();
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(id);
    expect(isAiFolder(db, id)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/db/repo/aiFolders.test.ts`
Expected: FAIL(`Cannot find module './aiFolders.js'`)

- [ ] **Step 3: schema 追加两张表**(在 `SCHEMA_SQL` 模板串末尾、`folder_proposal_folders` 建表语句之后加)

```sql
-- ── 夹子三分类(2026-09-21)────────────────────────────────
-- AI 创建标记:有行 = AI 夹子,没行 = 人类夹子(保守默认)。
-- 照 work_folder_rules 的老套路开侧表,不动 work_folders;标记只写不改。
CREATE TABLE IF NOT EXISTS work_ai_folders (
  folder_id  INTEGER PRIMARY KEY REFERENCES work_folders(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- 审查草稿(「审查勾选的夹子」产出)。与生成草稿(folder_proposal_folders)
-- 分表:生成只清自己的表,两类草稿互不误伤(spec 洞 8)。
CREATE TABLE IF NOT EXISTS review_drafts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,      -- 'rule' | 'merge' | 'delete'
  folder_id       INTEGER NOT NULL,   -- 目标夹子(merge 时 = 被并掉的源)
  into_id         INTEGER,            -- 仅 merge:并入的目标
  conditions_json TEXT,               -- 仅 rule / merge(并集)
  because         TEXT,
  status          TEXT NOT NULL,      -- 'pending' | 'adopted' | 'discarded'
  created_at      INTEGER NOT NULL
);
```

- [ ] **Step 4: 写 repo(未实跑,形状照 rules.ts 的风格)**

```ts
// server/src/db/repo/aiFolders.ts
import type Database from 'better-sqlite3';

/**
 * AI 夹子标记 —— 三分类的存储层(spec §2)。
 *
 * 有行 = AI 建的夹子,没行 = 人类夹子。**保守默认**:存量夹子没有记录,
 * 一律当人类夹子(用户拍板:标记只写不改,无手动改标入口)。
 */
export function markFolderAsAi(db: Database.Database, folderId: number): void {
  db.prepare(
    `INSERT INTO work_ai_folders (folder_id, created_at) VALUES (?, ?)
     ON CONFLICT(folder_id) DO NOTHING`,
  ).run(folderId, Date.now());
}

export function isAiFolder(db: Database.Database, folderId: number): boolean {
  return (
    db.prepare(`SELECT 1 FROM work_ai_folders WHERE folder_id = ?`).get(folderId) !== undefined
  );
}

export function listAiFolderIds(db: Database.Database): Set<number> {
  return new Set(
    (db.prepare(`SELECT folder_id FROM work_ai_folders`).all() as { folder_id: number }[]).map(
      (r) => r.folder_id,
    ),
  );
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && npx vitest run src/db/repo/aiFolders.test.ts`
Expected: PASS(2 用例)

---

### Task 2: 成员资格写入器 + AI 夹子对账 + 人类夹子规则补缺 + 安全网

> 本任务的实现与测试块**已实跑通过**(scratch 环境 7 用例全绿 + tsc 干净),逐字照抄即可;import 路径按 `workbench.ts` 现状调整。

**Files:**
- Modify: `server/src/curator/workbench.ts`(文件末尾追加)
- Test: `server/src/curator/workbench.test.ts`(文件末尾追加,`seeded()` helper 复用现有的)

**Interfaces:**
- Consumes: Task 1 的 `listAiFolderIds`;现有 `matchAll/toRuleItem`(`./rules.js`)、`itemTagIds/subtreeSets`(`../db/repo/tags.js`)、`saveRule`(不需要,本任务不写规则)。
- Produces:
  - `writeMembership(db, itemIds: readonly string[], targetFolderIds: readonly number[], who?: Actor): { added: number }` —— 目标含 AI 夹子时**抛错**;人类夹子只加不清;默认夹在条目落进主题夹子时移出。
  - `reconcileAiFolder(db, folderId: number, who?: Actor): { added: number; removed: number }` —— 非 AI 夹子抛错;清出走安全网。
  - `applyRuleHitsToFolder(db, folderId: number, who?: Actor): { added: number }` —— AI 夹子抛错;只加不清;无规则返回 `{added:0}`。
  - `ensureDefaultMembership(db, itemIds: readonly string[]): number` —— 安全网本体(返回补进几条)。
  - `defaultWorkFolderId(db): number | null`

- [ ] **Step 1: 先把测试追加到 `workbench.test.ts` 末尾**(现有 `seeded()` 已建 7/8/9 三个快照夹子与 BV1–BV4,9 是默认收藏夹)

```ts
// ── 成员资格写入器(spec 2026-09-21 §3)──────────────────
import { writeMembership, reconcileAiFolder, applyRuleHitsToFolder } from './workbench.js';
import { listAiFolderIds, markFolderAsAi } from '../db/repo/aiFolders.js';
import { saveRule } from '../db/repo/rules.js';

/** 建一个 AI 夹子(标记 + 规则同事务 —— 不变量"AI 夹子恒有规则"的测试侧shortcut) */
function makeAiFolder(db: ReturnType<typeof seeded>, name: string, keywords: string[]): number {
  const r = db
    .prepare(`INSERT INTO work_folders (origin_id, name, created_at) VALUES (NULL, ?, ?)`)
    .run(name, Date.now());
  const id = Number(r.lastInsertRowid);
  markFolderAsAi(db, id);
  if (keywords.length) saveRule(db, id, [{ field: 'title', any: keywords }], 'ai');
  return id;
}

describe('writeMembership', () => {
  it('人类夹子只加不清 —— 目标集不含它时存量原样保留', () => {
    const db = seeded();
    const human = originIdOf(db, 7); // BV1、BV2
    writeMembership(db, ['BV3'], [originIdOf(db, 8)]); // 目标根本不是 7
    expect(workItemIds(db, human).sort()).toEqual(['BV1', 'BV2']);
    // BV2 不在目标集里 —— 也不许清
    writeMembership(db, ['BV2'], [originIdOf(db, 8)]);
    expect(workItemIds(db, human)).toContain('BV2');
    expect(workItemIds(db, originIdOf(db, 8))).toContain('BV2');
  });

  it('AI 夹子不是写入目标 —— 直接拒(洞 4:AI 夹子唯一入口是规则)', () => {
    const db = seeded();
    const ai = makeAiFolder(db, 'AI 编程', ['BV1']);
    expect(() => writeMembership(db, ['BV2'], [ai])).toThrow(/AI 建的夹子/);
  });

  it('默认夹:条目落进主题夹子时移出;只在默认夹之间倒手时留着', () => {
    const db = seeded();
    const def = originIdOf(db, 9);
    const human = originIdOf(db, 7);
    writeMembership(db, ['BV4'], [human]);
    expect(workItemIds(db, def)).not.toContain('BV4');
    writeMembership(db, ['BV4'], [def]);
    expect(workItemIds(db, def)).toContain('BV4');
  });

  it('留痕:一次调用一条日志', () => {
    const db = seeded();
    writeMembership(db, ['BV1'], [originIdOf(db, 8)]);
    expect(listOperations(db)).toHaveLength(1);
    expect(listOperations(db)[0]!.kind).toBe('move_items');
  });
});

describe('reconcileAiFolder', () => {
  it('多则清(走安全网)、缺则补 —— 成员恒等于规则命中集', () => {
    const db = seeded();
    const def = originIdOf(db, 9);
    const ai = makeAiFolder(db, '全部', ['BV1', 'BV2', 'BV3']);
    // 预置:BV4 是多余成员(不在规则命中集),且不在默认夹 —— 清出前必须兜底
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`).run(ai, 'BV4');

    const r = reconcileAiFolder(db, ai);
    expect(r).toEqual({ added: 3, removed: 1 });

    expect(workItemIds(db, ai).sort()).toEqual(['BV1', 'BV2', 'BV3']);
    expect(workItemIds(db, def)).toContain('BV4'); // 安全网兜底,没丢视频
  });

  it('规则改严 → 不命中的清出;清出时不复核"有没有别的家"(字面版)', () => {
    const db = seeded();
    const def = originIdOf(db, 9);
    const ai = makeAiFolder(db, '一切', ['BV1', 'BV2', 'BV3']);
    reconcileAiFolder(db, ai); // 先收满
    // BV3 同时在人类夹子 8 里活着 —— 字面版照样补进默认夹
    saveRule(db, ai, [{ field: 'title', any: ['BV1'] }], 'ai');
    reconcileAiFolder(db, ai);
    expect(workItemIds(db, ai)).toEqual(['BV1']);
    expect(workItemIds(db, def)).toContain('BV3');
  });

  it('人类夹子不走对账 —— 拒', () => {
    const db = seeded();
    expect(() => reconcileAiFolder(db, originIdOf(db, 7))).toThrow(/不是 AI 建的夹子/);
  });
});

describe('applyRuleHitsToFolder', () => {
  it('人类夹子整理 = 只按规则补缺,存量不清', () => {
    const db = seeded();
    const human = originIdOf(db, 7); // 存量 BV1、BV2
    saveRule(db, human, [{ field: 'title', any: ['BV3'] }], 'user');
    const r = applyRuleHitsToFolder(db, human);
    expect(r.added).toBe(1);
    expect(workItemIds(db, human).sort()).toEqual(['BV1', 'BV2', 'BV3']);
    expect(workItemIds(db, originIdOf(db, 8))).toContain('BV3'); // 原处保留(只加)
  });

  it('没规则的夹子是 no-op', () => {
    const db = seeded();
    expect(applyRuleHitsToFolder(db, originIdOf(db, 7))).toEqual({ added: 0 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/workbench.test.ts`
Expected: FAIL(函数不存在)

- [ ] **Step 3: 实现追加到 `workbench.ts` 末尾**(已实跑验证的逐字块;import 按文件头部现状合并 —— 文件现有 import:workbench repo 的 `ensureWorkcopy, hasWorkcopy, listWorkFolders, workItemIds, resetWorkcopy`、folders 的 `listFolders, isLockedFolder`、operations 的 `logOperation, type OpActor`)

```ts
import { listAiFolderIds } from '../db/repo/aiFolders.js';
import { matchAll, toRuleItem } from './rules.js';
import { itemTagIds, subtreeSets } from '../db/repo/tags.js';
import type { ItemRow } from '../db/repo/items.js';
import type { RuleCondition } from '../db/repo/rules.js';

/** 默认收藏夹(锁定夹子)的工作副本 id;没有就 null —— 安全网没有落点时如实不兜底 */
export function defaultWorkFolderId(db: Database.Database): number | null {
  for (const w of listWorkFolders(db)) {
    if (w.originId === null) continue;
    const origin = listFolders(db).find((f) => f.id === w.originId);
    if (origin && isLockedFolder(db, origin)) return w.id;
  }
  return null;
}

/**
 * 安全网(字面版,spec §4):这批条目里不在默认收藏夹的,补进默认收藏夹。
 * **不做"有没有别的家"的判断** —— 用户拍板:哪怕它在别的夹子里活着也照补。
 * 代价(默认夹会变大)已知且接受,见 spec §4。
 */
export function ensureDefaultMembership(db: Database.Database, itemIds: readonly string[]): number {
  const defaultId = defaultWorkFolderId(db);
  if (defaultId === null || itemIds.length === 0) return 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
  );
  let added = 0;
  for (const itemId of itemIds) {
    added += insert.run(defaultId, itemId).changes;
  }
  return added;
}

/**
 * 成员资格写入器 —— 所有程序化成员变更的唯一入口(spec §3)。
 *
 * 三条纪律编码在一处,整理对账、AI 归类应用、采纳填充全走这里:
 * - AI 夹子不是写入目标(它的成员只能由 reconcile 写)—— 直接拒;
 * - 人类夹子只加不清 —— 红线的落点就是一个 continue;
 * - 默认夹在条目落进**主题**夹子时移出(现状语义);只在默认夹之间倒手时留着。
 */
export function writeMembership(
  db: Database.Database,
  itemIds: readonly string[],
  targetFolderIds: readonly number[],
  who: Actor = USER,
): { added: number } {
  if (itemIds.length === 0 || targetFolderIds.length === 0) return { added: 0 };
  ensureWorkcopy(db);

  const targets = [...new Set(targetFolderIds)];
  const byId = new Map(listWorkFolders(db).map((f) => [f.id, f]));
  const folderInfos = targets.map((id) => {
    const f = byId.get(id);
    if (!f) throw new Error(`工作副本里没有夹子 ${id}`);
    return f;
  });

  const aiIds = listAiFolderIds(db);
  const aiTarget = folderInfos.find((f) => aiIds.has(f.id));
  if (aiTarget) {
    throw new Error(
      `「${aiTarget.name}」是 AI 建的夹子,成员由它的规则决定 —— 请采纳规则建议,不要直接移入`,
    );
  }

  const defaultId = defaultWorkFolderId(db);
  const ids = [...new Set(itemIds)];
  let added = 0;

  db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
    );
    const del = db.prepare(`DELETE FROM work_folder_items WHERE item_id = ? AND folder_id = ?`);
    const memberOf = db.prepare(`SELECT folder_id FROM work_folder_items WHERE item_id = ?`);

    for (const itemId of ids) {
      const targetSet = new Set(targets);
      const current = (memberOf.all(itemId) as { folder_id: number }[]).map((r) => r.folder_id);
      for (const folderId of current) {
        if (targetSet.has(folderId)) continue;
        if (aiIds.has(folderId)) continue; // AI 夹子的归属只能由 reconcile 拿走
        if (folderId === defaultId) {
          // 默认夹:有主题落点 → 移出;只在默认夹之间倒手 → 留着
          if (targets.some((t) => t !== defaultId)) del.run(itemId, folderId);
          continue;
        }
        // 人类夹子:只加不清 —— 红线落点,跳过即可
        continue;
      }
      for (const folderId of targets) added += insert.run(folderId, itemId).changes;
    }
  })();

  logOperation(db, {
    kind: 'move_items',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: `归置 ${ids.length} 条到 ${targets.length} 个夹子(补进 ${added} 份归属;人类夹子只加不清)`,
    detail: { itemIds: ids, toFolderIds: targets, added },
  });
  return { added };
}

/**
 * AI 夹子对账:成员 = 规则命中集。缺的补进;多的走安全网后清出。
 * 这是 AI 夹子成员的**唯一**写手 —— writeMembership 拒绝 AI 夹子,两边合起来
 * 才把"成员恒等于命中集"钉死。
 */
export function reconcileAiFolder(
  db: Database.Database,
  folderId: number,
  who: Actor = USER,
): { added: number; removed: number } {
  ensureWorkcopy(db);
  const f = workFolderOrThrow(db, folderId);
  if (!listAiFolderIds(db).has(folderId)) throw new Error(`「${f.name}」不是 AI 建的夹子`);

  const rule = db
    .prepare(
      `SELECT conditions_json, origin, updated_at FROM work_folder_rules WHERE folder_id = ?`,
    )
    .get(folderId) as
    | { conditions_json: string; origin: 'ai' | 'user'; updated_at: number }
    | undefined;
  const conditions: RuleCondition[] = rule
    ? (JSON.parse(rule.conditions_json) as RuleCondition[])
    : [];

  const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
  const tagsOf = itemTagIds(db);
  const matched = conditions.length
    ? matchAll(
        items.map((i) => ({ ...toRuleItem(i), tagIds: tagsOf.get(i.id) ?? [] })),
        [{ folderId, conditions, origin: rule!.origin, updatedAt: rule!.updated_at }],
        { subtree: subtreeSets(db) },
      )
    : new Map<string, { folderId: number }[]>();
  const want = new Set(matched.keys());
  const have = new Set(workItemIds(db, folderId));

  const toAdd = [...want].filter((id) => !have.has(id));
  const toRemove = [...have].filter((id) => !want.has(id));

  db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
    );
    const del = db.prepare(`DELETE FROM work_folder_items WHERE folder_id = ? AND item_id = ?`);
    for (const itemId of toAdd) insert.run(folderId, itemId);
    if (toRemove.length > 0) ensureDefaultMembership(db, toRemove); // 安全网,先兜底再清出
    for (const itemId of toRemove) del.run(folderId, itemId);
  })();

  if (toAdd.length + toRemove.length > 0) {
    logOperation(db, {
      kind: 'move_items',
      actor: who.actor,
      sessionId: who.sessionId,
      summary: `对账「${f.name}」:补进 ${toAdd.length} 条,清出 ${toRemove.length} 条(清出前已兜底默认收藏夹)`,
      detail: { folderId, added: toAdd, removed: toRemove },
    });
  }
  return { added: toAdd.length, removed: toRemove.length };
}

/**
 * 人类夹子的整理:把规则命中集里缺的成员补进来 —— **只加,不清**。
 * 存量成员哪怕不命中规则也原样保留(用户 2026-09-21 的红线)。
 */
export function applyRuleHitsToFolder(
  db: Database.Database,
  folderId: number,
  who: Actor = USER,
): { added: number } {
  ensureWorkcopy(db);
  const f = workFolderOrThrow(db, folderId);
  if (listAiFolderIds(db).has(folderId)) throw new Error(`「${f.name}」是 AI 夹子,请走对账`);

  const rule = db
    .prepare(
      `SELECT conditions_json, origin, updated_at FROM work_folder_rules WHERE folder_id = ?`,
    )
    .get(folderId) as
    | { conditions_json: string; origin: 'ai' | 'user'; updated_at: number }
    | undefined;
  const conditions: RuleCondition[] = rule
    ? (JSON.parse(rule.conditions_json) as RuleCondition[])
    : [];
  if (conditions.length === 0) return { added: 0 };

  const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
  const tagsOf = itemTagIds(db);
  const matched = matchAll(
    items.map((i) => ({ ...toRuleItem(i), tagIds: tagsOf.get(i.id) ?? [] })),
    [{ folderId, conditions, origin: rule!.origin, updatedAt: rule!.updated_at }],
    { subtree: subtreeSets(db) },
  );
  const have = new Set(workItemIds(db, folderId));
  const toAdd = [...matched.keys()].filter((id) => !have.has(id));
  if (toAdd.length === 0) return { added: 0 };

  let added = 0;
  db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
    );
    for (const itemId of toAdd) added += insert.run(folderId, itemId).changes;
  })();
  logOperation(db, {
    kind: 'add_items',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: `整理「${f.name}」:按规则补进 ${added} 条(只加不清)`,
    detail: { folderId, added: toAdd },
  });
  return { added };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run src/curator/workbench.test.ts`
Expected: PASS(既有 30 + 新 8 = 38 用例)

---

### Task 3: 删除/合并/移动/移出 对三分类的语义

**Files:**
- Modify: `server/src/curator/workbench.ts`(`deleteFolder` / `mergeFolders` / `moveItems` / `removeItems` 四个函数)
- Test: `server/src/curator/workbench.test.ts`

**Interfaces:**
- Consumes: Task 1 `isAiFolder`、Task 2 `ensureDefaultMembership`;现有 `getRule/saveRule`(`../db/repo/rules.js`)。
- Produces: 行为变更(签名不变)——
  - `deleteFolder`:**非空夹子可删**(移除空夹检查);删除前全体成员走安全网;`who.actor==='ai'` 且目标是人类夹子 → 抛错;锁定夹子照旧拒。
  - `mergeFolders`:AI actor 的源里有人类夹子 → 抛错;**AI 源的规则并集**机械合并进目标(origin='ai');锁定源照旧拒;合并不触发安全网(成员有新家)。
  - `moveItems`:清空原归属时**跳过 AI 夹子**(它们的归属只能由 reconcile 拿走)。
  - `removeItems`:from 是 AI 夹子 → 抛错(手动移出被禁,spec 洞 7)。

- [ ] **Step 1: 写失败测试**(追加)

```ts
import { getRule } from '../db/repo/rules.js';

describe('删除与合并对三分类的语义', () => {
  it('非空夹子可以删了:成员先兜底进默认夹,容器+规则一起走(取代 m4b 空夹红线)', () => {
    const db = seeded();
    const human = originIdOf(db, 7);
    const def = originIdOf(db, 9);
    saveRule(db, human, [{ field: 'title', any: ['BV1'] }], 'user');

    deleteFolder(db, human); // 不再抛"还有 N 条"

    expect(listWorkFolders(db).some((f) => f.id === human)).toBe(false);
    expect(workItemIds(db, def).sort()).toEqual(['BV1', 'BV2', 'BV4']); // BV1/BV2 兜底
    expect(getRule(db, human)).toBeNull(); // 规则跟着 CASCADE
  });

  it('锁定夹子仍然不能删', () => {
    const db = seeded();
    expect(() => deleteFolder(db, originIdOf(db, 9))).toThrow(/不能删除/);
  });

  it('AI actor 删人类夹子 → 拒;user actor 删 AI 夹子 → 允许', () => {
    const db = seeded();
    const human = originIdOf(db, 7);
    const ai = makeAiFolder(db, 'AI 临时', ['BV3']);
    expect(() => deleteFolder(db, human, { actor: 'ai' })).toThrow(/AI 不能/);
    expect(() => deleteFolder(db, ai, { actor: 'user' })).not.toThrow();
  });

  it('AI actor 的合并源里有人类夹子 → 整批拒', () => {
    const db = seeded();
    const human = originIdOf(db, 7);
    const ai = makeAiFolder(db, 'AI 目标', ['BV1']);
    expect(() => mergeFolders(db, [human], ai, { actor: 'ai' })).toThrow(/AI 不能/);
  });

  it('合并 AI 源 → 目标规则收到并集(洞 5:合并不驱逐)', () => {
    const db = seeded();
    const aiA = makeAiFolder(db, 'AI 甲', ['BV1']);
    const aiB = makeAiFolder(db, 'AI 乙', ['BV3']);

    mergeFolders(db, [aiA], aiB, { actor: 'ai' });

    expect(listWorkFolders(db).some((f) => f.id === aiA)).toBe(false);
    const merged = getRule(db, aiB)!.conditions;
    // 两个源的条件都活着(顺序不限,断言按字段聚合)
    const titleAny = merged.filter((c) => c.field === 'title').flatMap((c) => c.any).sort();
    expect(titleAny).toEqual(['BV1', 'BV3']);
  });

  it('moveItems 清原归属时跳过 AI 夹子(条目在 AI 夹 + 人类夹,移走后 AI 夹的归属还在)', () => {
    const db = seeded();
    const ai = makeAiFolder(db, 'AI 收纳', ['BV1']);
    const human = originIdOf(db, 7); // BV1、BV2
    moveItems(db, ['BV1'], originIdOf(db, 8));
    expect(workItemIds(db, ai)).toContain('BV1'); // AI 夹的归属没被顺手清掉
    expect(workItemIds(db, human)).not.toContain('BV1'); // 人类夹的清了(用户的明确意图)
  });

  it('从 AI 夹子手动移出 → 拒(spec 洞 7:移了下次对账也会回来,不如不让移)', () => {
    const db = seeded();
    const ai = makeAiFolder(db, 'AI 收纳', ['BV3']);
    reconcileAiFolder(db, ai);
    expect(() => removeItems(db, ['BV3'], ai)).toThrow(/AI 建的夹子/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/workbench.test.ts`
Expected: 新 7 用例 FAIL(现有实现还是"只能删空夹"、没有并集、moveItems 清 AI 夹)

- [ ] **Step 3: 改四个函数**(未实跑,按现有函数体逐处修改)

`deleteFolder` —— 空夹检查换成安全网 + AI actor 约束(保留 `assertNotLocked`):

```ts
export function deleteFolder(db: Database.Database, folderId: number, who: Actor = USER): void {
  ensureWorkcopy(db);
  const f = workFolderOrThrow(db, folderId);
  assertNotLocked(db, folderId, '删除');
  if (who.actor === 'ai' && !isAiFolder(db, folderId)) {
    throw new Error(`「${f.name}」是人类建立的夹子,AI 不能删除它`);
  }

  const members = workItemIds(db, folderId);
  db.transaction(() => {
    if (members.length > 0) ensureDefaultMembership(db, members); // 删夹不删视频:先兜底
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(folderId);
  });

  logOperation(db, {
    kind: 'delete_folder',
    actor: who.actor,
    sessionId: who.sessionId,
    summary:
      members.length > 0
        ? `删除夹子「${f.name}」(${members.length} 条已兜底进默认收藏夹)`
        : `删除空夹子「${f.name}」`,
    detail: { folderId, name: f.name, memberCount: members.length },
  });
}
```

`mergeFolders` —— 在现有 `assertNotLocked` 循环之后、事务之前插两段;事务之后写并集:

```ts
  // 在 for (const f of froms) assertNotLocked(...) 之后:
  if (who.actor === 'ai') {
    const human = froms.filter((f) => !isAiFolder(db, f.id));
    if (human.length > 0) {
      throw new Error(`「${human[0]!.name}」是人类建立的夹子,AI 不能合并或删除它`);
    }
  }
  // AI 源的规则要在删夹子**之前**取出来 —— CASCADE 会把它们带走(洞 5)
  const aiRules = froms
    .filter((f) => isAiFolder(db, f.id))
    .map((f) => getRule(db, f.id))
    .filter((r): r is NonNullable<typeof r> => r !== null && r.conditions.length > 0);

  // ……事务照旧……

  // 事务之后、logOperation 之前:
  if (aiRules.length > 0) {
    const seen = new Set<string>();
    const union = [...getRule(db, intoId)?.conditions ?? [], ...aiRules.flatMap((r) => r.conditions)].filter((c) => {
      const key = `${c.field}|${[...c.any].sort().join(',')}`;
      if (seen.has(key) || c.any.length === 0) return false;
      seen.add(key);
      return true;
    });
    if (union.length > 0) saveRule(db, intoId, union, 'ai');
  }
```

文件头补 import:`import { getRule, saveRule } from '../db/repo/rules.js';`、`import { isAiFolder } from '../db/repo/aiFolders.js';`

`moveItems` —— 把事务里那行全量删除改成跳过 AI 夹子:

```ts
  const aiIds = listAiFolderIds(db);
  db.transaction(() => {
    for (const itemId of itemIds) {
      const current = (
        db.prepare(`SELECT folder_id FROM work_folder_items WHERE item_id = ?`).all(itemId) as
          { folder_id: number }[]
      ).map((r) => r.folder_id);
      for (const folderId of current) {
        if (aiIds.has(folderId)) continue; // AI 夹的归属只能由 reconcile 拿走
        db.prepare(`DELETE FROM work_folder_items WHERE item_id = ? AND folder_id = ?`).run(itemId, folderId);
      }
      db.prepare(
        `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
      ).run(toFolderId, itemId);
    }
  })();
```

`removeItems` —— 在 `workFolderOrThrow` 之后加:

```ts
  if (isAiFolder(db, fromFolderId)) {
    throw new Error(`「${from.name}」是 AI 建的夹子,成员由规则决定 —— 改规则(采纳建议)才能移出条目`);
  }
```

- [ ] **Step 4: 跑本文件全部测试 —— 既有用例里"只能删空夹"那条要改**

Run: `cd server && npx vitest run src/curator/workbench.test.ts`
Expected: 有既有用例挂 —— `it('只能删空夹')` 与 `it('锁定的夹子不能删除(哪怕它是空的)')` 里的 `removeItems` 预清理已不需要。把前者改成:

```ts
  it('非空夹子可删(安全网兜底);锁定夹子仍然不能删', () => {
    const db = seeded();
    expect(() => deleteFolder(db, originIdOf(db, 9))).toThrow(/不能删除/);
    const human = originIdOf(db, 7);
    deleteFolder(db, human);
    expect(listWorkFolders(db).some((f) => f.id === human)).toBe(false);
  });
```

后者删掉 `removeItems(db, workItemIds(db, locked), locked);` 那一行(锁定夹子本来就直接拒删除,不需要先清空)。其余既有用例必须全绿 —— 有红的说明改坏了现语义,修实现而不是改断言。

---

### Task 4: AI 归类应用切写入器 + 「整理」端点(/api/workbench/tidy)

**Files:**
- Modify: `server/src/curator/routes.ts`(apply 端点 ≈612–653 行;新增 tidy 端点)
- Test: `server/src/curator/routes.test.ts`

**Interfaces:**
- Consumes: Task 2 `writeMembership` / `reconcileAiFolder` / `applyRuleHitsToFolder`。
- Produces: `POST /api/workbench/tidy` body `{ folderIds: number[] }` → `{ ok, reconciled: {added,removed}[], ruleAdded: number, skipped: string[] }`。**纯本地,不 import llm**。

- [ ] **Step 1: 写失败测试**(追加到 `describe('工作台路由')`)

```ts
  it('tidy:AI 夹子精确对账、人类夹子只加不清、无规则跳过', async () => {
    const { app, db } = makeApp();
    seed(db); // 快照夹 7(深度学习,BV1/BV2)、8(不常用,BV3)、9 默认收藏夹(BV4)
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '临时' } });
    const view = (await app.inject({ url: '/api/workbench' })).json();
    const human = view.folders.find((f: { originId: number | null }) => f.originId === 7).id as number;
    const ai = await app.inject({
      method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI 编程' },
    }).then((r) => r.json().id as number);
    // 直接落 AI 标记 + 规则(路由层还没有"标记"入口,测试侧直写,与 repo 测试同口径)
    db.prepare(`INSERT INTO work_ai_folders (folder_id, created_at) VALUES (?, ?)`).run(ai, Date.now());
    saveRule(db, ai, [{ field: 'title', any: ['BV1'] }], 'ai');

    const res = await app.inject({
      method: 'POST', url: '/api/workbench/tidy',
      payload: { folderIds: [ai, human] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // AI 夹:BV1 命中 → 补进
    expect(body.reconciled).toEqual([{ folderId: ai, added: 1, removed: 0 }]);
    // 人类夹:没规则 → 跳过
    expect(body.skipped).toHaveLength(1);

    const items = await app.inject({ url: `/api/workbench/folders/${ai}/items` });
    expect(items.json().items.map((i: { id: string }) => i.id)).toEqual(['BV1']);
    await app.close();
  });

  it('tidy:空 folderIds → 400', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/workbench/tidy', payload: { folderIds: [] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('apply:目标集里的 AI 夹子被过滤掉,人类夹子存量不被清', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    // 造工作副本 + 人类夹子存量
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '临时' } });
    const view = (await app.inject({ url: '/api/workbench' })).json();
    const human = view.folders.find((f: { originId: number | null }) => f.originId === 7).id as number;
    // BV1 已经在人类夹子里(快照继承),AI 结论把 BV1 归去新建夹子 —— 存量不许被清
    const ai = await app.inject({
      method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI 编程' },
    }).then((r) => r.json().id as number);
    db.prepare(`INSERT INTO work_ai_folders (folder_id, created_at) VALUES (?, ?)`).run(ai, Date.now());
    saveRule(db, ai, [{ field: 'title', any: ['BV1'] }], 'ai');

    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(ai), confidence: 0.9, reason: 'r' },
    ]);
    db.prepare(`UPDATE classifications SET updated_at = ? WHERE session_id = ?`).run(
      (db.prepare(`SELECT COALESCE(MAX(ts),0) AS t FROM operation_log`).get() as { t: number }).t + 1,
      sid,
    );

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(0); // AI 夹目标被过滤,没有可应用的
    // 人类夹子的存量原样保留
    const items = await app.inject({ url: `/api/workbench/folders/${human}/items` });
    expect(items.json().items.map((i: { id: string }) => i.id)).toContain('BV1');
    await app.close();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/routes.test.ts`
Expected: 新 3 用例 FAIL(404 / applied=1 等)

- [ ] **Step 3: 改 routes.ts**

(a) import 区:`workbench.js` 的导入里加 `writeMembership, reconcileAiFolder, applyRuleHitsToFolder`(从 `./workbench.js` —— 注意 `routes.ts` 现在从两处 import workbench 相关,合并进现有两条)。

(b) apply 端点:两处替换。
- 目标分组循环里(A≈624 行)`const folderId = Number(a.folderTempId);` 之后加过滤:

```ts
      // AI 夹子不是归类目标的合法落点(洞 4):成员=规则命中集,直接写必被对账清出
      if (aiFolderIds.has(folderId)) continue;
```

- 循环前取一次 `const aiFolderIds = listAiFolderIds(db);`(import 自 `../db/repo/aiFolders.js`)。
- 应用调用(≈647 行)`assignItems(db, itemIds, folderIds, ...)` 换成 `writeMembership(db, itemIds, folderIds, { actor: 'ai', sessionId });`,catch 分支保留(目标夹子可能被手改删掉)。

(c) 新端点(放在 `POST /api/workbench/reset` 之后):

```ts
  /**
   * 「整理」—— 对勾选的夹子兑现成员关系。**纯本地计算**:不调 LLM、不花钱,
   * 它执行的是已经存在的规则与成员(spec §5)。
   * - AI 夹子 → reconcileAiFolder(精确对账,清出走安全网)
   * - 人类夹子 → applyRuleHitsToFolder(只加不清;没规则 = 跳过)
   */
  app.post('/api/workbench/tidy', async (req, reply) => {
    const { folderIds } = (req.body ?? {}) as { folderIds?: unknown };
    if (
      !Array.isArray(folderIds) ||
      folderIds.length === 0 ||
      folderIds.some((x) => typeof x !== 'number')
    ) {
      return reply.code(400).send({ ok: false, reason: 'folderIds 必须是非空数字数组' });
    }
    const reconciled: { folderId: number; added: number; removed: number }[] = [];
    const ruleAdded: { folderId: number; added: number }[] = [];
    const skipped: string[] = [];
    for (const folderId of folderIds) {
      try {
        if (isAiFolderWork(db, folderId)) {
          reconciled.push({ folderId, ...reconcileAiFolder(db, folderId) });
        } else {
          const r = applyRuleHitsToFolder(db, folderId);
          if (r.added > 0) ruleAdded.push({ folderId, added: r.added });
          else skipped.push(String(folderId));
        }
      } catch (e) {
        skipped.push(`${folderId}: ${(e as Error).message}`);
      }
    }
    log.event({
      level: 'info',
      category: 'sync',
      message: `整理 ${folderIds.length} 个夹子:对账 ${reconciled.length} 个,规则补进 ${
        ruleAdded.reduce((s, r) => s + r.added, 0)
      } 条,跳过 ${skipped.length} 个`,
    });
    return { ok: true, reconciled, ruleAdded, skipped };
  });
```

> 注:文件头需要 `import { isAiFolder as isAiFolderWork } from '../db/repo/aiFolders.js';`(routes.ts 里 `isLockedFolder` 已占用 `folders.js` 的命名空间,别名避免混淆)。

- [ ] **Step 4: 跑全部 routes 测试**

Run: `cd server && npx vitest run src/curator/routes.test.ts`
Expected: PASS(既有 apply 用例不受影响 —— `assignItems`→`writeMembership` 对"目标全是普通夹子"的行为等价:全清再插 vs 目标外不动。**有一处行为差异要过一遍既有用例**:apply 后条目在目标之外的**人类**夹子里的旧归属,旧代码会清掉、新代码保留。既有用例 `先从原处拿走` 断言的是 `workItemIds` 不含 —— 若有挂,按新语义改断言并在断言上方注明"spec 2026-09-21:人类夹子只加不清"。)

---

### Task 5: 审查核心(纯函数:prompt 组装 + 裁判)

**Files:**
- Create: `server/src/curator/review.ts`
- Test: `server/src/curator/review.test.ts`

**Interfaces:**
- Consumes: `FolderProfile`/`renderProfiles`(`./folderProfile.js`)、`matchAll/toRuleItem/validateSuggestion` 的纪律、`itemTagIds/subtreeSets`。
- Produces:
  - `buildReviewPrompt(input: {profiles: FolderProfile[]; aiIds: ReadonlySet<number>;}): { system: string; user: string }`
  - `validateReviewDrafts(raw: unknown, ctx: ReviewCtx): { drafts: ValidReviewDraft[]; rejects: {label: string; why: string}[] }`
  - `ValidReviewDraft = { kind: 'rule'; folderId: number; field: 'title'|'intro'|'upper'; any: string[]; because: string; evidenceItemIds: string[] } | { kind: 'merge'; fromId: number; intoId: number; because: string } | { kind: 'delete'; folderId: number; because: string }`
  - `ReviewCtx = { validFolderIds: ReadonlySet<number>; aiIds: ReadonlySet<number>; lockedIds: ReadonlySet<number>; itemsById: ReadonlyMap<string, RuleItem> }`

**裁判规则(全部实现为拒绝,不给宽容):**
- `rule`:folderId 必须存在、**不得**是锁定夹;field 三选一(照抄 `VALID_FIELDS` 纪律,tag 不收);`any` 非空 ≤20;`evidenceItemIds` 非空且每条都被这组词当场命中(照抄 `validateSuggestion` 的自证)。
- `merge`:fromId/intoId 都存在且不同;**两者都必须是 AI 夹子**;任一是锁定夹 → 丢。
- `delete`:folderId 存在、必须是 AI 夹子、不得是锁定夹。
- 形状不对/缺字段 → 丢并记原因。

- [ ] **Step 1: 写失败测试**

```ts
// server/src/curator/review.test.ts
import { describe, it, expect } from 'vitest';
import { buildReviewPrompt, validateReviewDrafts } from './review.js';
import type { FolderProfile } from './folderProfile.js';

const profiles: FolderProfile[] = [
  { folderId: 3, name: 'AI 编程', itemCount: 10, topTags: [{ name: 'Python', count: 8 }], outliers: [] },
  { folderId: 5, name: 'AI/编程', itemCount: 12, topTags: [{ name: 'Python', count: 9 }], outliers: [] },
  { folderId: 7, name: '人类夹子', itemCount: 5, topTags: [{ name: '健身', count: 4 }], outliers: [] },
];

const baseCtx = {
  validFolderIds: new Set([3, 5, 7]),
  aiIds: new Set([3, 5]),
  lockedIds: new Set<number>(),
  itemsById: new Map([
    ['BV1', { id: 'BV1', title: 'Python 教程', intro: null, upperName: null }],
  ]),
};

describe('buildReviewPrompt', () => {
  it('带画像、区分 AI/人类夹子的角色说明,要求纯 JSON 数组', () => {
    const p = buildReviewPrompt({ profiles, aiIds: new Set([3, 5]) });
    expect(p.system).toContain('纯 JSON');
    expect(p.system).toContain('AI 建的夹子');
    expect(p.user).toContain('AI 编程');
    expect(p.user).toContain('人类夹子');
  });
});

describe('validateReviewDrafts', () => {
  it('规则草稿过自证 → 留;打不中证据 → 丢', () => {
    const raw = [
      { kind: 'rule', folderTempId: '7', field: 'title', any: ['Python'], because: 'b', evidenceItemIds: ['BV1'] },
      { kind: 'rule', folderTempId: '7', field: 'title', any: ['瑜伽'], because: 'b', evidenceItemIds: ['BV1'] },
    ];
    const v = validateReviewDrafts(raw, baseCtx);
    expect(v.drafts).toHaveLength(1);
    expect(v.drafts[0]).toMatchObject({ kind: 'rule', folderId: 7, any: ['Python'] });
    expect(v.rejects).toHaveLength(1);
  });

  it('merge:两者都是 AI 夹子 → 留;source 是人类夹子 → 丢', () => {
    const raw = [
      { kind: 'merge', fromTempId: '3', intoTempId: '5', because: '共现高' },
      { kind: 'merge', fromTempId: '7', intoTempId: '5', because: 'x' },
    ];
    const v = validateReviewDrafts(raw, baseCtx);
    expect(v.drafts).toEqual([{ kind: 'merge', fromId: 3, intoId: 5, because: '共现高' }]);
  });

  it('delete:AI 夹子 → 留;人类夹子/锁定夹 → 丢', () => {
    const raw = [
      { kind: 'delete', folderTempId: '3', because: '命中 0' },
      { kind: 'delete', folderTempId: '7', because: 'x' },
    ];
    const ctx = { ...baseCtx, lockedIds: new Set([7]) };
    const v = validateReviewDrafts(raw, ctx);
    expect(v.drafts).toEqual([{ kind: 'delete', folderId: 3, because: '命中 0' }]);
  });

  it('kind 不认识 / 形状不对 → 丢', () => {
    const v = validateReviewDrafts([{ kind: 'explode' }, 'junk', null], baseCtx);
    expect(v.drafts).toHaveLength(0);
    expect(v.rejects.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/review.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**(未实跑;裁判纪律逐条对照 `rules.ts` 的 `validateSuggestion` 抄)

```ts
// server/src/curator/review.ts
import type { FolderProfile } from './folderProfile.js';
import { matchItem, type RuleItem } from './rules.js';

/**
 * 「审查勾选的夹子」的 prompt + 裁判(纯函数,无 IO)。
 *
 * 一次调用服务 N 个勾选的夹子:人类夹子按共现画像推荐规则;AI 夹子可提
 * 规则 / 合并 / 删除。纪律沿 validateSuggestion:**编造就整条丢** ——
 * 规则草稿必须自证(它给的证据条目必须真的被这组词命中)。
 */

export interface ReviewPromptInput {
  profiles: readonly FolderProfile[];
  aiIds: ReadonlySet<number>;
}

export function buildReviewPrompt(input: ReviewPromptInput): { system: string; user: string } {
  const system = [
    '你是视频收藏夹整理助手。用户勾选了若干夹子,请你逐个审查并给出草稿建议。',
    '夹子分两种:',
    '- 用户自建的夹子:只能建议**加规则**(按它现有成员的标签构成,给出标题/简介/UP名关键词)',
    '- AI 建的夹子:可以建议加规则、把两个 AI 夹子**合并**、或**删除**已无意义的 AI 夹子',
    '约束:',
    '- 用户自建的和默认收藏夹,永远不能建议合并或删除',
    '- 每条规则建议必须给 evidenceItemIds:它声称这些词管用,就要列出会被命中的条目 id',
    '- 输出纯 JSON 数组,不要 markdown 围栏,形状:',
    '[{"kind":"rule","folderTempId":"7","field":"title","any":["词1","词2"],"because":"理由","evidenceItemIds":["BVxx"]},',
    ' {"kind":"merge","fromTempId":"3","intoTempId":"5","because":"理由"},',
    ' {"kind":"delete","folderTempId":"3","because":"理由"}]',
  ].join('\n');

  const lines = input.profiles.map((p) => {
    const kind = input.aiIds.has(p.folderId) ? 'AI 建' : '用户建';
    const mix = p.topTags.map((t) => `${t.name} ${Math.round((t.count / Math.max(1, p.itemCount)) * 100)}%`).join('、');
    return `- [${kind}] id=${p.folderId} 「${p.name}」(${p.itemCount} 条)—— 构成:${mix || '(没有标签数据)'}`;
  });
  const user = [
    '## 勾选的夹子(带标签构成)',
    ...lines,
    '',
    '请逐个审查并给草稿。没有把握的夹子就跳过,不要硬凑。',
  ].join('\n');
  return { system, user };
}

// ── 裁判 ──────────────────────────────────────────────────

export type ValidReviewDraft =
  | { kind: 'rule'; folderId: number; field: 'title' | 'intro' | 'upper'; any: string[]; because: string; evidenceItemIds: string[] }
  | { kind: 'merge'; fromId: number; intoId: number; because: string }
  | { kind: 'delete'; folderId: number; because: string };

export interface ReviewCtx {
  validFolderIds: ReadonlySet<number>;
  aiIds: ReadonlySet<number>;
  lockedIds: ReadonlySet<number>;
  itemsById: ReadonlyMap<string, RuleItem>;
}

const MAX_KEYWORDS = 20;
const FIELDS = ['title', 'intro', 'upper'] as const;

const asId = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) ? n : null;
};

export function validateReviewDrafts(
  raw: unknown,
  ctx: ReviewCtx,
): { drafts: ValidReviewDraft[]; rejects: { label: string; why: string }[] } {
  const rejects: { label: string; why: string }[] = [];
  if (!Array.isArray(raw)) {
    return { drafts: [], rejects: [{ label: '(整份)', why: '不是数组' }] };
  }
  const drafts: ValidReviewDraft[] = [];

  for (const r of raw) {
    if (!r || typeof r !== 'object') {
      rejects.push({ label: '(非对象)', why: '形状不对' });
      continue;
    }
    const o = r as Record<string, unknown>;
    const kind = o.kind;
    const because = typeof o.because === 'string' ? o.because : '';

    if (kind === 'rule') {
      const folderId = asId(o.folderTempId);
      if (folderId === null || !ctx.validFolderIds.has(folderId) || ctx.lockedIds.has(folderId)) {
        rejects.push({ label: String(o.folderTempId), why: 'rule 目标夹子不存在或锁定' });
        continue;
      }
      if (typeof o.field !== 'string' || !(FIELDS as readonly string[]).includes(o.field)) {
        rejects.push({ label: String(o.folderTempId), why: 'field 非法' });
        continue;
      }
      const rawAny = typeof o.any === 'string' ? [o.any] : o.any;
      const any = Array.isArray(rawAny)
        ? rawAny.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter(Boolean).slice(0, MAX_KEYWORDS)
        : [];
      if (any.length === 0) {
        rejects.push({ label: String(o.folderTempId), why: '关键词为空' });
        continue;
      }
      if (!Array.isArray(o.evidenceItemIds) || o.evidenceItemIds.length === 0) {
        rejects.push({ label: String(o.folderTempId), why: '没有证据条目(无法自证)' });
        continue;
      }
      const evidenceItemIds = o.evidenceItemIds.filter((x): x is string => typeof x === 'string');
      // ★ 自证:每个证据条目都必须被这组词命中 —— 打不中就是编的
      const probe = [{ folderId, conditions: [{ field: o.field as 'title' | 'intro' | 'upper', any }], origin: 'ai' as const, updatedAt: 0 }];
      const bad = evidenceItemIds.some((id) => {
        const item = ctx.itemsById.get(id);
        return !item || matchItem(item, probe).length === 0;
      });
      if (bad) {
        rejects.push({ label: String(o.folderTempId), why: '证据打不中(编造)' });
        continue;
      }
      drafts.push({ kind: 'rule', folderId, field: o.field as 'title' | 'intro' | 'upper', any, because, evidenceItemIds });
      continue;
    }

    if (kind === 'merge') {
      const fromId = asId(o.fromTempId);
      const intoId = asId(o.intoTempId);
      const ok =
        fromId !== null && intoId !== null && fromId !== intoId &&
        ctx.validFolderIds.has(fromId) && ctx.validFolderIds.has(intoId) &&
        ctx.aiIds.has(fromId) && ctx.aiIds.has(intoId) &&
        !ctx.lockedIds.has(fromId) && !ctx.lockedIds.has(intoId);
      if (!ok) {
        rejects.push({ label: `${o.fromTempId}→${o.intoTempId}`, why: 'merge 两端必须是存在且非锁定的 AI 夹子' });
        continue;
      }
      drafts.push({ kind: 'merge', fromId, intoId, because });
      continue;
    }

    if (kind === 'delete') {
      const folderId = asId(o.folderTempId);
      const ok =
        folderId !== null && ctx.validFolderIds.has(folderId) &&
        ctx.aiIds.has(folderId) && !ctx.lockedIds.has(folderId);
      if (!ok) {
        rejects.push({ label: String(o.folderTempId), why: 'delete 目标必须是存在且非锁定的 AI 夹子' });
        continue;
      }
      drafts.push({ kind: 'delete', folderId, because });
      continue;
    }

    rejects.push({ label: String(kind), why: 'kind 不认识' });
  }

  return { drafts, rejects };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run src/curator/review.test.ts`
Expected: PASS(6 用例)

---

### Task 6: 审查路由 + 生成采纳写 AI 标记 + 全部丢弃

**Files:**
- Create: `server/src/db/repo/reviews.ts`(草稿 CRUD + 运行态)
- Create: `server/src/curator/reviewRoutes.ts`
- Modify: `server/src/http/index.ts`(注册 `registerReviewRoutes`)、`server/src/curator/proposalRoutes.ts`(adopt/adopt-all 落 AI 标记)、`server/src/curator/proposal.ts`(不需要动 —— 运行态模式照抄)
- Test: `server/src/db/repo/reviews.test.ts`、`server/src/curator/reviewRoutes.test.ts`

**Interfaces:**
- Consumes: Task 1 schema、Task 5 裁判、`buildFolderProfiles`、`readLlmSettings(db, 'proposals')`(审查与方案共用同一用途档,**不新增 LlmPurpose**)。
- Produces(路由):
  - `POST /api/reviews/generate` `{folderIds:number[]}` → 202(校验:非空、数字、都存在;没配模型 400;在跑 409)—— 先把该批夹子的**旧 pending 草稿**清掉再异步跑
  - `POST /api/reviews/abort` → 未在跑 409
  - `GET /api/reviews/current` → `{ running, logs, drafts }`(drafts 为 pending 优先,带夹子名)
  - `POST /api/reviews/adopt` `{draftId, name?}` → rule:追加条件(origin 'ai')+重自证;merge:`mergeFolders(db,[from],into,{actor:'ai'})` + 若草稿带 `conditions_json` 则 `saveRule(into, conditions,'ai')`(AI 的精选并集覆盖机械并集);delete:`deleteFolder(db, folderId,{actor:'ai'})`(安全网在 Task 3 已进 deleteFolder)
  - `POST /api/reviews/discard` `{draftId}`
  - `POST /api/reviews/adopt-all` → **只作用于 kind='rule'**(merge/delete 破坏性,必须逐条,spec §5)
- Produces(repo):`listReviewDrafts(db)`、`saveReviewDrafts(db, drafts)`(全量替换 pending,带 status/created_at)、`setReviewDraftStatus(db, id, status)`、`clearPendingReviewDrafts(db, folderIds?)`、`reviewRun`(模块级 `{running, logs}`,照 `proposalRun`)

- [ ] **Step 1: repo + 测试**(未实跑;形状照 `db/repo/proposals.ts` 的 `listDrafts/setDraftStatus` 风格)

```ts
// server/src/db/repo/reviews.ts
import type Database from 'better-sqlite3';
import type { RuleCondition } from './rules.js';

/** 审查草稿的存储层(spec §6)。与生成草稿分表,互不误伤。 */
export type ReviewKind = 'rule' | 'merge' | 'delete';

export interface ReviewDraftInput {
  kind: ReviewKind;
  folderId: number;
  intoId?: number | null;
  conditions?: RuleCondition[] | null;
  because: string;
}

export interface ReviewDraft extends ReviewDraftInput {
  id: number;
  status: 'pending' | 'adopted' | 'discarded';
  createdAt: number;
}

interface Row {
  id: number; kind: string; folder_id: number; into_id: number | null;
  conditions_json: string | null; because: string | null; status: string; created_at: number;
}

const shape = (r: Row): ReviewDraft => ({
  id: r.id,
  kind: r.kind as ReviewKind,
  folderId: r.folder_id,
  intoId: r.into_id,
  conditions: r.conditions_json ? (JSON.parse(r.conditions_json) as RuleCondition[]) : null,
  because: r.because ?? '',
  status: r.status as ReviewDraft['status'],
  createdAt: r.created_at,
});

export function listReviewDrafts(db: Database.Database): ReviewDraft[] {
  return (
    db.prepare(
      `SELECT * FROM review_drafts
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id`,
    ).all() as Row[]
  ).map(shape);
}

export function saveReviewDrafts(db: Database.Database, drafts: ReviewDraftInput[]): void {
  const ins = db.prepare(
    `INSERT INTO review_drafts (kind, folder_id, into_id, conditions_json, because, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  );
  db.transaction(() => {
    for (const d of drafts) {
      ins.run(d.kind, d.folderId, d.intoId ?? null, d.conditions ? JSON.stringify(d.conditions) : null, d.because, Date.now());
    }
  })();
}

export function setReviewDraftStatus(
  db: Database.Database, id: number, status: 'adopted' | 'discarded',
): void {
  db.prepare(`UPDATE review_drafts SET status = ? WHERE id = ?`).run(status, id);
}

/** 清掉(默认全部、或指定夹子的)pending 草稿 —— 新一轮审查开始前调用 */
export function clearPendingReviewDrafts(db: Database.Database, folderIds?: readonly number[]): void {
  if (folderIds && folderIds.length > 0) {
    const ph = folderIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM review_drafts WHERE status = 'pending' AND folder_id IN (${ph})`).run(...folderIds);
  } else {
    db.prepare(`DELETE FROM review_drafts WHERE status = 'pending'`).run();
  }
}
```

测试两用例:存→列(pending 优先)、清 pending 不碰已采纳的。跑红→写→跑绿。

- [ ] **Step 2: 路由 + 测试**(未实跑;运行态/202/中止的接线照 `proposalRoutes.ts` 逐处对照 —— `currentController`、启动复位僵尸态、`proposalRun.running` 守卫,全部同款,把 `proposal` 换 `review`)

测试要点(每条一个 it,`makeApp` 照 `ruleRoutes.test.ts` 抄 + `markFolderAsAi`):
1. 没配模型 → 400(seedLlm 不调的分支;照 `proposalRoutes.test.ts` 的 makeApp 但省 seedLlm)
2. folderIds 空/非数字/含不存在的夹子 → 400
3. happy path:mock `complete` 返回含 rule/merge/delete 各一的数组 → 202 → 等 20ms → current 有 3 条 pending 草稿
4. adopt rule 草稿 → 目标夹子规则追加、origin='ai'、草稿状态 adopted
5. adopt merge 草稿 → 源夹子消失、目标规则 = 草稿 conditions
6. adopt delete 草稿 → 夹子没了、成员兜底进默认夹
7. adopt-all → 只 rule 被采纳,merge/delete 还是 pending
8. 在跑时再点 → 409;abort 未在跑 → 409

- [ ] **Step 3: 实现路由**(未实跑;骨架如下,LLM 调用段照 `proposal.ts` 的 `runGeneration` 结构:try 从 `readLlmSettings` 包住、finally 复位 running、catch 回写日志)

```ts
// server/src/curator/reviewRoutes.ts —— 骨架,接线见上方测试要点
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import { complete } from '../llm/provider.js';
import { readLlmSettings } from '../llm/config.js';
import { parseLooseJson } from './parse.js';
import { buildReviewPrompt, validateReviewDrafts } from './review.js';
import { buildFolderProfiles } from './folderProfile.js';
import { listAiFolderIds } from '../db/repo/aiFolders.js';
import { listWorkFolders } from '../db/repo/workbench.js';
import { isLockedFolder, listFolders } from '../db/repo/folders.js';
import type { ItemRow } from '../db/repo/items.js';
import { itemTagIds, subtreeSets } from '../db/repo/tags.js';
import { toRuleItem } from './rules.js';
import {
  listReviewDrafts, saveReviewDrafts, setReviewDraftStatus,
  clearPendingReviewDrafts, type ReviewDraftInput,
} from '../db/repo/reviews.js';
import { mergeFolders, deleteFolder } from './workbench.js';
import { getRule, saveRule } from '../db/repo/rules.js';

export const REVIEW_TIMEOUT_MS = 300_000;
export const reviewRun = { running: false, logs: [] as { ts: number; level: 'info' | 'warn' | 'error'; text: string }[] };
let currentController: AbortController | null = null;
const pushLog = (level: 'info' | 'warn' | 'error', text: string) => {
  reviewRun.logs.push({ ts: Date.now(), level, text });
};

export function registerReviewRoutes(app: FastifyInstance, deps: { db: Database.Database; log: Logger }): void {
  const { db, log } = deps;
  // ……generate / abort / current / adopt / discard / adopt-all,接线照 proposalRoutes 同名端点……
  //
  // runReview(db, log, folderIds, signal) 内部:
  //   const profiles = buildFolderProfiles(db).filter(p => folderIds.includes(p.folderId));
  //   const prompt = buildReviewPrompt({ profiles, aiIds: listAiFolderIds(db) });
  //   const raw = await complete({ config: llm.config, messages: [...], thinking: false, timeoutMs: REVIEW_TIMEOUT_MS, maxOutputTokens: llm.ctx.maxOutput, ...(signal ? { abortSignal: signal } : {}) });
  //   const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
  //   const ctx = {
  //     validFolderIds: new Set(listWorkFolders(db).map(w => w.id)),
  //     aiIds: listAiFolderIds(db),
  //     lockedIds: new Set(listFolders(db).filter(f => isLockedFolder(db, f)).map(f => f.id)),
  //     itemsById: new Map(items.map(i => [i.id, toRuleItem(i)])),
  //   };
  //   const v = validateReviewDrafts(parseLooseJson(raw), ctx);
  //   saveReviewDrafts(db, v.drafts.map(d => d.kind === 'rule'
  //     ? { kind: 'rule', folderId: d.folderId, conditions: [{ field: d.field, any: d.any }], because: d.because }
  //     : d));
  //   rejects 记 pushLog('warn', ...)
}
```

- [ ] **Step 4: proposal adopt 落 AI 标记 + 全部丢弃**

(a) `proposalRoutes.ts` 两处采纳事务里(`adopt` ≈109 行、`adopt-all` ≈126 行)各加一行,与 `createFolder`/`saveRule` 同事务:

```ts
        markFolderAsAi(db, folderId); // 三分类:AI 方案采纳建的夹子,标记为 AI 夹子
```

文件头 `import { markFolderAsAi } from '../db/repo/aiFolders.js';`

(b) `proposalRoutes.ts` 新端点(照 `discard` 的形状):

```ts
  /** 全部丢弃:所有 pending 草稿置 discarded(与「全部采纳」并列,spec §6) */
  app.post('/api/proposals/discard-all', async () => {
    db.prepare(`UPDATE folder_proposal_folders SET status = 'discarded' WHERE status = 'pending'`).run();
    return { ok: true };
  });
```

(c) `http/index.ts` 注册:`import { registerReviewRoutes } from '../curator/reviewRoutes.js';` + `registerReviewRoutes(app, { db, log });`(放在 `registerProposalRoutes` 之后)。

- [ ] **Step 5: 跑全部相关测试**

Run: `cd server && npx vitest run src/db/repo/reviews.test.ts src/curator/reviewRoutes.test.ts src/curator/proposalRoutes.test.ts`
Expected: PASS(proposalRoutes 既有用例 + 新标记断言:在 `采纳:建夹子+写规则` 用例里补一句 `expect(db.prepare('SELECT 1 FROM work_ai_folders WHERE folder_id = ?').get(folderId)).toBeDefined();`)

---

### Task 7: 视图带 ai 标记 + 前端 types/api(前后端契约)

**Files:**
- Modify: `server/src/db/repo/workbenchView.ts`(`WorkFolderView` 加 `ai: boolean`)、`server/src/curator/ruleRoutes.ts`(`RuleView` 加 `ai: boolean`)
- Modify: `web/src/types.ts`、`web/src/api.ts`
- Test: `server/src/db/repo/workbenchView.test.ts`、`server/src/curator/ruleRoutes.test.ts`(各补 1 用例)

**Interfaces:**
- Produces: `WorkFolderView.ai: boolean`、`RuleView.ai: boolean`;前端 `reviewsApi`、`workbenchApi.tidy`、`proposalsApi.discardAll`、`ReviewDraftView` 类型。

- [ ] **Step 1: 服务端两处 + 测试**

`workbenchView.ts` 的 `folders` map 里加一行(读 `isAiFolder(db, w.id)`);接口加 `ai: boolean;`。测试:

```ts
// 追加到 workbenchView.test.ts
it('AI 标记进视图:有标记 ai=true,存量夹子 ai=false(保守默认)', () => {
  const db = seeded(); // 用现有 helper
  // …建工作副本、markFolderAsAi 其中一个、buildWorkbenchView 断言两行 ai 值…
});
```

`ruleRoutes.ts` 的 `rulesWithHits()` 里 `views` map 加 `ai: isAiFolder(db, w.id)`,接口 `RuleView` 加 `ai: boolean;`,文件头 import `isAiFolder`。测试:`GET /api/rules` 既有用例补 `expect(mine.ai).toBe(false)`。

- [ ] **Step 2: 前端 types + api(未实跑,typecheck 把关)**

`web/src/types.ts` 追加/修改:

```ts
export interface WorkFolderView { /* 现有字段不动 */ ai: boolean; }
export interface RuleView { /* 现有字段不动 */ ai: boolean; }

export type ReviewKind = 'rule' | 'merge' | 'delete';
export interface ReviewDraftView {
  id: number;
  kind: ReviewKind;
  folderId: number;
  folderName?: string;   // current 端点带上,免前端再查
  intoId?: number | null;
  intoName?: string | null;
  conditions: RuleCondition[] | null;
  because: string;
  status: 'pending' | 'adopted' | 'discarded';
}
export interface ReviewCurrent {
  running: boolean;
  logs: ProposalLogLine[];
  drafts: ReviewDraftView[];
}
```

`web/src/api.ts` 追加:

```ts
// ── 审查草稿(spec 2026-09-21 §5/§6)─────────────────────

export const reviewsApi = {
  generate: (folderIds: number[]) =>
    json<{ ok: true }>('POST', '/api/reviews/generate', { folderIds }),
  abort: () => json<{ ok: true }>('POST', '/api/reviews/abort'),
  current: () => api<ReviewCurrent>('/api/reviews/current'),
  adopt: (draftId: number, name?: string) =>
    json<{ ok: true }>('POST', '/api/reviews/adopt', { draftId, name }),
  discard: (draftId: number) => json<{ ok: true }>('POST', '/api/reviews/discard', { draftId }),
  adoptAll: () => json<{ ok: true }>('POST', '/api/reviews/adopt-all'),
};
```

`workbenchApi` 里加 `tidy: (folderIds: number[]) => json<{ ok: true; reconciled: { folderId: number; added: number; removed: number }[]; ruleAdded: { folderId: number; added: number }[]; skipped: string[] }>('POST', '/api/workbench/tidy', { folderIds })`,`proposalsApi` 里加 `discardAll: () => json<{ ok: true }>('POST', '/api/proposals/discard-all')`。

- [ ] **Step 3: 两端 typecheck**

Run: `cd server && npx tsc --noEmit && cd ../web && npx tsc --noEmit`
Expected: 双 0(前端此刻会因 `WorkFolderView.ai` 必填而报 curator 页缺字段 —— **本任务先给 `WorkFolderView.ai` 用可选 `ai?: boolean`**,Task 8 页面接上后再收紧为必填并删掉可选)

---

### Task 8: 整理页三按钮 + 草稿区 + 自动整理

**Files:**
- Create: `web/src/components/ReviewDrafts.tsx`(审查草稿区 + 生成草稿区合并的「草稿区」组件)
- Modify: `web/src/pages/curator.tsx`(顶栏按钮、运行锁、自动整理)
- Modify: `web/src/components/RulesPanel.tsx`(「夹子方案」面板整体迁出到 curator 页 —— 本任务先迁**生成按钮 + 草稿行**,规则表本体 Task 9 处理)

**Interfaces:**
- Consumes: Task 7 全部 api;现有 `useTaskProgress`、`TaskLogDrawer`、`useAssistant`。
- Produces: 组件 `DraftsArea`(props: `drafts: ProposalDraftView[]; reviewDrafts: ReviewDraftView[]; busy: boolean; onChanged: () => void`),curator 页内部状态 `runState: 'idle' | 'generating' | 'reviewing' | 'tidying'`。

**按钮逻辑(逐字落实 spec §5 的状态表):**

- [ ] **Step 1: curator.tsx 顶栏加「审查勾选的夹子 (N)」和「整理 (N)」**

```tsx
// BUTTON_GROUPS 的批量组里追加(hasChecked 分支内):
  <Button
    key="review"
    icon={<Sparkles size={14} />}
    loading={runState === 'reviewing'}
    disabled={runState !== 'idle'}
    onClick={runReview}
  >
    审查勾选的夹子 {checkedFolders.size > 0 ? `(${checkedFolders.size})` : ''}
  </Button>,
  <Button
    key="tidy"
    icon={<Wand2 size={14} />}
    loading={runState === 'tidying'}
    disabled={runState !== 'idle'}
    onClick={runTidy}
  >
    整理 {checkedFolders.size > 0 ? `(${checkedFolders.size})` : ''}
  </Button>,
```

常驻组里原「生成方案」(从 RulesPanel 迁来)同样绑 `disabled={runState !== 'idle'}`、`loading={runState === 'generating'}`。互斥即:`runState !== 'idle'` 时三个互相禁用(共享一把锁,spec §5 状态表)。

- [ ] **Step 2: 三个动作(未实跑,照 RulesPanel 的 generate/actProposal 模式写)**

```tsx
  const [runState, setRunState] = useState<'idle' | 'generating' | 'reviewing' | 'tidying'>('idle');
  const [review, setReview] = useState<ReviewCurrent | null>(null);

  const loadReview = useCallback(async () => {
    setReview(await reviewsApi.current());
  }, []);
  useTaskProgress({ taskType: 'reviews', fetcher: loadReview, enabled: runState === 'reviewing' });

  const runReview = () => {
    modal.confirm({
      title: `审查这 ${checkedFolders.size} 个夹子?`,
      content: 'AI 按各夹子的标签构成给规则/合并/删除草稿;花一次模型调用。',
      okText: '审查', cancelText: '算了',
      onOk: async () => {
        setRunState('reviewing');
        try {
          await reviewsApi.generate([...checkedFolders]);
          await loadReview();
        } catch (e) { setError((e as Error).message); setRunState('idle'); }
      },
    });
  };

  const runTidy = async () => {
    setRunState('tidying');
    try {
      const r = await workbenchApi.tidy([...checkedFolders]);
      setNotice(`整理完成:对账 ${r.reconciled.length} 个,规则补进 ${r.ruleAdded.reduce((s, x) => s + x.added, 0)} 条`);
    } catch (e) { setError((e as Error).message); }
    finally { setRunState('idle'); await reload(); }
  };
```

轮询收尾:`useTaskProgress` 的 fetcher(`loadReview`)里检测 `running` 从 true 变 false 时 `setRunState('idle')`(照 RulesPanel 的 `generating` 派生写法)。

- [ ] **Step 3: 草稿区组件**(未实跑;生成草稿行照 RulesPanel 550–602 行原样搬,审查草稿行按 kind 渲染 —— rule 显条件与 because,merge 显「A → B」与 because,delete 显夹子名与 because;按钮:rule→采纳/改一下/丢弃,merge→采纳/丢弃,delete→采纳/丢弃;底部批量条:生成草稿「全部采纳/全部丢弃」,审查草稿「全部采纳(仅规则)」)

「改一下」(rule 草稿)= 先 adopt 再展开该夹子规则行(回调 `onEditRule(folderId)` 由 curator 页给)。

- [ ] **Step 4: 自动整理(流程闭环,spec §5)**

审查草稿「全部采纳(仅规则)」成功后:

```tsx
    // 全部采纳(rule)→ 自动对同一勾选范围跑一次整理(全自动,结果可见)
    await runTidy();
```

「全部采纳」(生成草稿)成功后:把新采纳的夹子 id 并进 `checkedFolders`(默认勾上,spec 拍板 8)、展开它们的规则行,然后 `await runTidy()`。

- [ ] **Step 5: 门禁**

Run: `cd web && npx tsc --noEmit && npx max build 2>&1 | grep -c "Compiled successfully"`
Expected: tsc 0;build 输出含 "Compiled successfully"(退出码 1 是既有问题,忽略)

---

### Task 9: 规则住进树 —— 夹子行规则区 + 关键词 tag 输入

**Files:**
- Create: `web/src/components/FolderRuleSection.tsx`(从 RulesPanel 抽 `ConditionsEditor` + 规则行展开区)
- Modify: `web/src/components/WorkFolderTree.tsx`(FolderRow 展开区加规则区)、`web/src/pages/curator.tsx`(管理 `ruleOpenId` 状态、传 `rules` 数据)、`web/src/components/RulesPanel.tsx`(删到只剩将被 Task 10 移除的壳)

**Interfaces:**
- Consumes: `rulesApi`、`RuleView`(带 `ai`)、`tagNameOf`(tagApi.tree 摊平,照 RulesPanel 187–198 行原样搬进 curator 页)。
- Produces: `FolderRuleSection`(props: `view: RuleView; tagNameOf: Map<number,string>; tagTree: {id:number;name:string}[]; busy: boolean; onChanged: () => void; editable: boolean`)。

- [ ] **Step 1: 关键词输入修复(用户报的 bug,先修)**

RulesPanel 的 `ConditionsEditor` 里文本字段那个 `<Select mode="tags" tokenSeparators={[',', '、', ' ']}>`(≈686 行)换成**无下拉**的形态,并同步到新抽出的组件:

```tsx
            <Select
              size="small"
              mode="tags"
              open={false}                    // 关键:不出下拉 —— 词是自由录入的,不是从选项里挑
              tokenSeparators={[',', '、']}   // 逗号成 chip;去掉空格分隔(会把带空格的词拆碎)
              value={c.any}
              onChange={(v: string[]) => patch(i, { any: [...new Set(v)] })}  // 去重
              placeholder="打字,逗号成一个词;点 x 删除"
              style={{ flex: 1, minWidth: 240 }}
            />
```

(tag 字段的 Select **保持下拉** —— 那是从词库里选,本来就该下拉。)

- [ ] **Step 2: FolderRuleSection 组件**(未实跑;内容 = RulesPanel 的规则行渲染 + `ConditionsEditor`,按 `view.ai` 分叉)

- `editable`(人类夹子):`ConditionsEditor` 全功能(改/删/加条件),`onChange` 走 `rulesApi.save`。
- AI 夹子:只读渲染条件(renderRule 同款)+ 一句「AI 夹子的规则由建议驱动 —— 采纳建议或改一下来调整」;**不挂** ConditionsEditor。
- 默认夹(locked):照 RulesPanel 519–535 行的锁定分支(只给删规则按钮)。

- [ ] **Step 3: 树接线**

`curator.tsx` 拉 `rulesApi.list()` 存 `rules: RuleView[]`;`WorkFolderTree` 的 `FolderRow` props 加 `ruleView: RuleView | null; ruleOpen: boolean; onToggleRule: (folderId: number) => void; onRuleChanged: () => void`,展开区(≈423 行 `{open && ...}` 块内、条目列表**上方**)渲染:

```tsx
          {ruleView && (
            <FolderRuleSection
              view={ruleView}
              tagNameOf={tagNameOf}
              tagTree={tagTree}
              busy={busy}
              editable={!folder.locked && !folder.ai}
              onChanged={onRuleChanged}
            />
          )}
```

原「跳 /rules 定位」按钮(`onShowRule`,≈359 行)改为 `onToggleRule(folder.id)` —— 就地展开,**不再 navigate**。锁定夹子的规则区只在 `hasRule` 时给(照 RulesPanel 的判据)。

- [ ] **Step 4: 门禁**

Run: `cd web && npx tsc --noEmit && npx max build 2>&1 | grep -c "Compiled successfully"`
Expected: tsc 0 + "Compiled successfully"

---

### Task 10: 删 /rules 页面 + 导航收敛 + 采纳后展开

**Files:**
- Delete: `web/src/pages/rules.tsx`、`web/src/components/RulesPanel.tsx`
- Modify: `web/.umirc.ts`(删 `{ path: '/rules', component: 'rules' }`)、`web/src/layouts/index.tsx`(nav 删「规则」行与 `Filter` import)、`web/src/types.ts`(`WorkFolderView.ai` 收紧为必填)、`web/src/api.ts`(若 RulesPanel 专用的导出无人用了就删)

**Steps:**

- [ ] **Step 1: 确认 RulesPanel 里没有还没搬走的东西**。逐块对照:`generate/actProposal/loadProposal`(Task 8 已搬)、草稿行(已搬)、建议栏(`suggestions` 区块 ≈328–398 行 → 搬进 curator 页,`useAssistant()` 的消费原样)、`ago/renderRule/FIELD_LABEL/hasRule`(→ FolderRuleSection)、`ConditionsEditor`(→ FolderRuleSection)。搬完 RulesPanel 应无剩余引用。

- [ ] **Step 2: 建议栏迁入 curator 页** —— RulesPanel 的 AI 建议栏整块(含 `takeSuggestion/dropSuggestion`)搬进 curator.tsx,放草稿区上方;「改一下」采纳后 `setRuleOpenId(folderId)`。

- [ ] **Step 3: 删文件与路由**(本任务删 `web/src/pages/rules.tsx`、`web/src/components/RulesPanel.tsx` 两个文件,umirc 路由行、layouts 导航行)

- [ ] **Step 4: 采纳后展开规则行(修用户报的 bug)**

生成草稿逐个「采纳」成功后:`setRuleOpenId(folderId)` + `setCheckedFolders(prev => new Set(prev).add(folderId))`。规则区的展开状态统一由 curator 页的 `ruleOpenId: number | null` 管理(Task 9 已接线),这里只是写它。

- [ ] **Step 5: 全套门禁**

Run: `cd web && npx tsc --noEmit && npx max build 2>&1 | grep -c "Compiled successfully"; cd ../server && npx tsc --noEmit && npx vitest run 2>&1 | tail -3`
Expected: 全绿

---

### Task 11: 手动验证清单(收尾,不做代码改动)

- [ ] 真机起服务(`server` + `web` dev),过一遍 spec §8 的「只手动验证」:
  1. 勾 2 个人类夹子 + 1 个 AI 夹子 → 「审查勾选的夹子」→ 草稿区出三类草稿;运行中被勾选夹子的规则区可见
  2. 全部采纳(仅规则)→ 自动整理跑完,人类夹子条目数只增不减
  3. 手动往人类夹子移一条不命中规则的 → 成功;点整理 → 它还在
  4. 采纳一个生成草稿 → 夹子进树、带 🤖、默认勾上、规则行展开
  5. 删一个非空 AI 夹子(走 delete 草稿)→ 成员出现在默认收藏夹
  6. 关键词输入:打字 + 逗号成 chip、x 删除、重复词不重复入库、无下拉
  7. 导航无「规则」;旧地址 `/rules` 404(本地工具,不做重定向,spec 同款决定)
  8. 「整理」运行中点「生成方案」→ 按钮禁用(互斥)
- [ ] 汇报:改动文件清单 + 全部测试结果原文,停在工作区等用户提交。

---

## Self-Review 记录(已执行)

1. **Spec 覆盖对照**:§1 概念模型 → Task 1/2/3;§2 数据模型 → Task 1;§3 写入器 → Task 2/4;§4 安全网 → Task 2/3;§5 三按钮/互斥/流程闭环 → Task 4(tidy)/Task 6(review 路由)/Task 8;§6 草稿体系(含全部丢弃、并集、批量仅 rule)→ Task 6/8;§7 界面重组(删 /rules、来源图标、默认勾选、tag 输入、采纳展开、建议栏迁移)→ Task 7/8/9/10。**来源图标(🤖/✎)在 Task 8/9 的树渲染里**:`folder.ai ? '🤖' : '✎'`,已含在 Task 9 Step 3 的 FolderRow 改动范围 —— 执行时若遗漏,以 spec §7 为准补上。
2. **占位符扫描**:Task 6 Step 2/3 是「测试要点 + 骨架」而非逐字代码 —— 这是有意的:该任务接线复杂但全部有同构参照(proposalRoutes),逐字抄反而会写错行号。已标注「未实跑」。
3. **类型一致性**:`writeMembership` 返回 `{added}`(Task 2 定义 = Task 4 使用);`ReviewDraftView.kind` 三值(Task 6 → Task 7 → Task 8 一致);`tidy` 响应形状(Task 4 = Task 7 api = Task 8 消费)一致。
