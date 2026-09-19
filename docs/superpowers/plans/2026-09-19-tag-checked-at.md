# 词级质检台账(checked_at)—— 「继续质检所有未完成」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 tags 表加 `checked_at` 台账列,质检范围从「新词/全库」二选一改为「继续质检(所有未质检的)/全部审查」,退役 `lastRunNewWords` 内存变量,健康度行显示「待检 N」。

**Architecture:** schema 迁移加列(ensureColumn 幂等);applyVerdict 判定即盖章;runTagCheck 的 `allTags: boolean` 改为 `scope: 'continue' | 'all'`(continue = `checked_at IS NULL` 的词),fresh 闸门退役;路由/前端弹窗同步改;reconcile-stats 加 `unchecked` 计数。

**Tech Stack:** TypeScript, Fastify, better-sqlite3, vitest, React + antd。

**Spec:** `docs/superpowers/specs/2026-09-19-tag-checked-at.md`

## Global Constraints

- 判过的都算已质检(keep/drop/merge/move 四路都盖章);被删/被并的词不存在,不盖章。
- merge/move 的**目标词不盖章**(它没被判定,下次继续质检轮到它)。
- 新词 ensureTag 建出即 NULL = 待检,不用改 ensureTag 本身。
- `lastRunNewWords` 内存变量删除(连同 run 路由的赋值)。
- fresh 闸门退役:continue 的范围本身有界(只检没检过的),不再限制老词。
- 标注后自动质检改用 `scope: 'continue'`(触发时机不变)。
- 现有测试全绿(「只动本轮新词」等 fresh 闸门用例改写为 continue 语义)。
- 迁移用 ensureColumn 幂等,幂等可重跑。

---

### Task 1: schema 迁移 + 盖章 + 查待检(tags.ts / db/index.ts)

**Files:**
- Modify: `server/src/db/index.ts:30-34`(applySchema 加 ensureColumn)
- Modify: `server/src/db/schema.ts`(tags 建表语句加列,新装用户直接有)
- Modify: `server/src/db/repo/tags.ts`(盖章 helper + 待检查询)
- Test: `server/src/curator/tagcheck.test.ts`(部分断言用)

**Interfaces:**
- Produces: `tags.checked_at INTEGER` 列(NULL = 待检)
- Produces: `markTagChecked(db, id: number): void` —— 盖章
- Produces: `listUncheckedTags(db): string[]` —— 待检词名列表(checked_at IS NULL)

- [ ] **Step 1: 写失败测试** —— 追加到 `server/src/curator/tagcheck.test.ts` 的 describe('runTagCheck') 外(它测的是 repo 层),建一个新 describe:

```ts
// ── 质检台账(checked_at)─────────────────────────────
describe('质检台账', () => {
  it('新词建出即待检(checked_at NULL);盖章后不再待检', async () => {
    const { markTagChecked, listUncheckedTags } = await import('../db/repo/tags.js');
    const db = openDb(':memory:');
    const a = ensureTag(db, '甲', null);
    ensureTag(db, '乙', null);
    expect(listUncheckedTags(db)).toEqual(expect.arrayContaining(['甲', '乙']));
    markTagChecked(db, a);
    expect(listUncheckedTags(db)).toEqual(['乙']);
  });

  it('drop 删掉的词不盖(它不存在);merge 目标词不盖章(下次轮到它)', async () => {
    const { markTagChecked, listUncheckedTags } = await import('../db/repo/tags.js');
    const db = openDb(':memory:');
    const keep = ensureTag(db, '路飞', null);
    ensureTag(db, '鲁夫', null);
    // 鲁夫 并进 路飞:鲁夫没了(不盖),路飞是目标(不盖)—— 两个都不该出现在"盖章后仍待检"之外的假象里
    const { runTagCheck } = await import('./tagcheck.js');
    mocks.complete.mockResolvedValue(JSON.stringify([{ name: '鲁夫', action: 'merge', target: '路飞' }]));
    await runTagCheck({ config, tree: listTagTree(db), newNames: ['鲁夫'], db, scope: 'all' });
    // 路飞(目标)没被判定 → 仍待检,下次「继续质检」轮到它
    expect(listUncheckedTags(db)).toEqual(['路飞']);
    expect(markTagChecked).toBeDefined(); // helper 存在性
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/tagcheck.test.ts -t 质检台账`
Expected: FAIL(`markTagChecked` / `listUncheckedTags` 不存在)。

- [ ] **Step 3: 迁移 + schema** —— `db/index.ts` 的 applySchema 加一行:

```ts
export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  // §9F C7:kind 是独立的正交轴(形态),迁到自己的列;ai_tags 自此不读不写
  ensureColumn(db, 'items', 'ai_kind', 'ai_kind TEXT');
  // 质检台账:NULL = 该词从没被质检判定过(「继续质检」的账本)
  ensureColumn(db, 'tags', 'checked_at', 'checked_at INTEGER');
}
```

`db/schema.ts` 的 `CREATE TABLE IF NOT EXISTS tags (...)` 里 `created_at INTEGER NOT NULL` 后加一行 `checked_at INTEGER`。

- [ ] **Step 4: repo helper** —— `tags.ts` 在 `tagScale` 附近加:

```ts
/**
 * 质检台账:判过即盖章(NULL = 从没被质检判定过)。
 *
 * 「继续质检」的账本 —— 新词建出即待检,判定过(含 keep)不再重复检;自动质检
 * 失败漏掉的词仍是 NULL,下次继续质检接得住(内存变量 lastRunNewWords 会丢会覆盖,
 * 这个账本在库里,重启不丢、漏检不吞)。
 */
export function markTagChecked(db: Database.Database, id: number): void {
  db.prepare(`UPDATE tags SET checked_at = ? WHERE id = ?`).run(Date.now(), id);
}

/** 待检词名(checked_at IS NULL)—— 「继续质检」的待检来源 */
export function listUncheckedTags(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM tags WHERE checked_at IS NULL`).all() as
    { name: string }[]).map((r) => r.name);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && npx vitest run src/curator/tagcheck.test.ts -t 质检台账`
Expected: PASS(第一条;第二条依赖 Task 2 的 scope 参数,本任务先只跑第一条 `-t "新词建出即待检"`)。

- [ ] **Step 6: Commit**(留工作区,提交由用户做 —— 全局规则;此步为占位提醒执行者**不要 commit**)

不执行 git 操作。改动留在工作区,由用户提交。

---

### Task 2: runTagCheck 改 scope 语义 + applyVerdict 盖章(tagcheck.ts)

**Files:**
- Modify: `server/src/curator/tagcheck.ts`
- Test: `server/src/curator/tagcheck.test.ts`

**Interfaces:**
- Consumes: `markTagChecked` / `listUncheckedTags`(Task 1)
- Produces: `runTagCheck(opts)` 的 `allTags?: boolean` 改为 `scope?: 'continue' | 'all'`(默认 `'continue'`);返回形状不变

- [ ] **Step 1: 改 runTagCheck 签名与取词逻辑** —— `tagcheck.ts`:

```ts
  /** 质检范围:'continue' = 只检未质检的(checked_at IS NULL,含历史欠账+新词);
   *  'all' = 强制全库重检。默认 'continue'。 */
  scope?: 'continue' | 'all';
```

(替换原来的 `allTags?: boolean` 注释行;函数体里:)

```ts
  const allNames = opts.scope === 'all'
    ? listTagsWithParent(db).map((r) => r.name)   // 全库词名
    : listUncheckedTags(db);                       // 未质检的(含欠账+新词)
```

fresh 闸门与 `newNames` 参数**保留但退役**:签名里删掉 `newNames` 和 `fresh` 相关逻辑
(continue 的范围本身有界)。空词早退文案:

```ts
  if (allNames.length === 0) {
    opts.onNote?.('info', opts.scope === 'all'
      ? '词库是空的 —— 没有词可判'
      : '没有待质检的词 —— 账已清');
    return { dropped: 0, merged: 0, moved: 0, checked: 0 };
  }
```

- [ ] **Step 2: applyVerdict 盖章** —— 在 applyVerdict 函数里,四路动作的落点:
  - keep(函数末尾 `opts.onVerdict?.(v)` 前):按 name 查 id,`markTagChecked(db, id)`。
  - drop 成功:词已删,不盖(本来就不存在了)。
  - merge 成功:被并词已删不盖;**目标不盖**(spec 决策)。
  - move 成功:`setTagParent` 成功后,`markTagChecked(db, id)`(id 是 findTag 解出来的被判定词)。

keep 分支盖章需要 id —— keep 落点在 findTag 解析之后,加:

```ts
    // 落到这里的是 **keep**……(原注释保留)
    markTagChecked(db, id);
    opts.onVerdict?.(v);
```

(keep 走到了 findTag 之后说明 id 存在 —— merge/move 的 id===null 分支已 return。)

- [ ] **Step 3: 更新既有测试** —— `tagcheck.test.ts`:
  - 「只动本轮新词」用例**改写**:fresh 闸门退役,该场景改为「scope='continue' 下已质检的词不重复检」—— 建 2 词,先 `markTagChecked` 一个,scope='continue' 送检,断言只有未盖的那个被送(用 mock 捕获 prompt 断言只含未盖词名)。
  - 所有调 `runTagCheck({... newNames: [...] ...})` 的用例删掉 `newNames` 参数(签名没了)。
  - 「newNames 为空 → 不调模型」改为「没有待检词 → 不调模型」:`ensureTag` 后直接 `markTagChecked`,断言 complete 未被调。

- [ ] **Step 4: 跑测试**

Run: `cd server && npx vitest run src/curator/tagcheck.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: 不 commit**(用户提)

---

### Task 3: 路由与前端(scope continue|all + 待检数 + lastRunNewWords 退役)

**Files:**
- Modify: `server/src/curator/tagRoutes.ts`
- Modify: `web/src/api.ts`、`web/src/components/TagPanel.tsx`
- Test: `server/src/curator/tagRoutes.test.ts`

**Interfaces:**
- Consumes: `runTagCheck({ scope })`(Task 2)、`tagScale`(已有)
- Produces: `POST /api/tags/tagcheck` body `{ scope: 'continue' | 'all' }`;响应 `{ ok, scope, dropped, merged, moved, checked, remaining }`
- Produces: `GET /api/tags/reconcile-stats` 响应加 `unchecked` 字段

- [ ] **Step 1: 路由改 scope** —— tagRoutes.ts 的 tagcheck 端点:

```ts
    const scope = (req.body as { scope?: string })?.scope;
    if (scope !== 'all' && scope !== 'continue') {
      return reply.code(400).send({ ok: false, reason: 'scope 只能是 continue 或 all' });
    }
```

runTagCheck 调用处:`newNames: []` 删除,`allTags: scope === 'all'` 改为 `scope`,响应加
`remaining: listUncheckedTags(db).length`(盖章后再查一次)。

- [ ] **Step 2: lastRunNewWords 退役** —— 删掉模块级 `let lastRunNewWords: string[] = []`
  和 run 路由里的赋值;自动质检调用处改:

```ts
          check = await runTagCheck({
            config: checker.config,
            tree: listTagTree(db),
            db,
            log,
            scope: 'continue',
            signal: controller.signal,
            timeoutMs: TAGCHECK_TIMEOUT_MS,
            onBatch/onVerdict/onNote 照旧,
          });
```

- [ ] **Step 3: reconcile-stats 加 unchecked** —— 端点里加:

```ts
    return { totalTags, activeTags, unchecked: listUncheckedTags(db).length, reconcileMs: lastReconcile.ms, lastRunAt: lastReconcile.at };
```

- [ ] **Step 4: 前端** —— `api.ts` 的 `tagcheck(scope: 'continue' | 'all')`、响应类型加 `remaining`;
  `ReconcileStats` 类型加 `unchecked: number`;TagPanel:
  - confirmTagCheck 弹窗两个选项改为 `continue`(默认,文案:「继续质检 —— 检所有还没质检过的词(之前漏的 + 这次新长的)」)/ `all`(「全部审查 —— 强制全库重检,删词不可逆,慎选」)。
  - 词库健康度行加 `待检 N`(stats.unchecked > 0 时显示)。

- [ ] **Step 5: 更新路由测试** —— scope 400 用例的非法值断言不变;
  scope 用例:`payload: { scope: 'new' }` 改 `'continue'`;「scope=new 检上一轮新词」用例改为
  「continue 检未质检的词」(建词不盖章 → continue → 判 drop → 词删;再跑一次 → checked:0 无账可查)。

- [ ] **Step 6: 全量验证**

Run: `cd server && npx tsc --noEmit && npx vitest run` + `cd web && npx tsc --noEmit`
Expected: 全绿。

- [ ] **Step 7: 不 commit**(用户提)

---

### Task 4: 收尾

- [ ] **Step 1: spec 状态** —— `2026-09-19-tag-checked-at.md` 顶部改「已实施(日期)」。
- [ ] **Step 2: 全量** —— server vitest 全绿 + 双端 typecheck 干净。
- [ ] **Step 3: 手动验收清单**(给用户):新词→待检 N>0;继续质检→清账;keep 不重检;
  TAGCHECK_EMPTY 欠账下次接住;清空标注→待检回到全库数。
