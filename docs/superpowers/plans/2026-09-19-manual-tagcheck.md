# 质检分批 + 提示词增强 + 手动质检按钮 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉「5524 个新词全送质检 → 0 判定」的 bug（质检分批），增强质检判词参照（CHECK_SYSTEM 成对正反例），加手动质检按钮 + 弹窗范围选择（全部审查 / 只查这次新的）。

**Architecture:** `runTagCheck` 内部把待检词按批切（每批 200），逐批调模型合并 verdicts，无条件应用。`CHECK_SYSTEM` 重写为每个动作的成对正反例。新增 `POST /api/tags/tagcheck` 端点（body `{scope}`，`currentRun.running` 守卫），前端「词库质检」按钮弹窗单选范围。

**Tech Stack:** TypeScript, Fastify, better-sqlite3, vitest, React + antd + umijs/max。

**Spec:** `docs/superpowers/specs/2026-09-19-manual-full-tagcheck.md`

## Global Constraints

- 判据语义不变（reconcile 的 0.9 / 5 阈值不动）。
- 标注后自动质检行为不变：仍只检新词 + fresh 闸门（老词不碰），只是内部改分批。
- `scope='all'` 绕过 fresh 闸门 = 老词可能被删（drop 不可逆），弹窗必须明示风险。
- 批次逻辑无条件应用（不管 scope）。
- 每批 200 词（`TAGCHECK_BATCH`）。
- 现有测试全绿（标注后质检的既有用例必须保持通过 —— 特别是「只动本轮新词」那条）。
- 不引入外部数据 / 三方库（提示词增强只改 CHECK_SYSTEM 文案）。

---

### Task 1: 质检分批 + 提示词增强（tagcheck.ts 核心改造）

**Files:**
- Modify: `server/src/curator/tagcheck.ts`（分批循环 + CHECK_SYSTEM 重写 + `allTags` 参数）
- Test: `server/src/curator/tagcheck.test.ts`

**Interfaces:**
- Produces: `runTagCheck` 加 `opts.allTags?: boolean`（默认 false = 只检新词 + fresh 闸门；true = 检全库、绕过 fresh）
- Produces: `CHECK_SYSTEM` 重写为成对正反例
- Produces: 内部 `TAGCHECK_BATCH = 200` 分批

- [ ] **Step 1: 写失败测试**（分批 + allTags 行为）。追加到 `tagcheck.test.ts`：

```ts
// 分批:>200 个词不一次全送 —— 每次调用只送 ≤200 个
it('超过 200 个词分批调模型,verdicts 累积', async () => {
  const db = openDb(':memory:');
  // 造 450 个词(3 批:200 + 200 + 50)
  const names: string[] = [];
  for (let i = 0; i < 450; i++) {
    const n = `词${i}`;
    names.push(n);
    ensureTag(db, n, null);
  }
  // 每次调用回一批:第一批全 keep,第二批一个 drop,第三批 keep
  mocks.complete
    .mockResolvedValueOnce(JSON.stringify(names.slice(0, 200).map((n) => ({ name: n, action: 'keep' }))))
    .mockResolvedValueOnce(JSON.stringify([
      ...names.slice(200, 400).map((n) => ({ name: n, action: 'keep' })),
      { name: '词300', action: 'drop' },
    ]))
    .mockResolvedValueOnce(JSON.stringify(names.slice(400).map((n) => ({ name: n, action: 'keep' }))));

  const r = await runTagCheck({ config, tree: listTagTree(db), newNames: names, db });
  expect(mocks.complete).toHaveBeenCalledTimes(3); // 3 批,不是 1 次塞 450
  expect(r.dropped).toBe(1);
  // 词300 被删
  expect(findTag(db, normalizeTagName('词300'))).toBeNull();
});

// allTags=true:检全库,绕过 fresh 闸门 —— 老词也能被 drop
it('allTags=true 时老词也能被处理(绕过 fresh 闸门)', async () => {
  const db = openDb(':memory:');
  ensureTag(db, '美食', null); // 老词
  mocks.complete.mockResolvedValue(JSON.stringify([{ name: '美食', action: 'drop' }]));
  // 传 allTags: true,newNames 空(全库检,不是本轮新词)
  const r = await runTagCheck({ config, tree: listTagTree(db), newNames: [], db, allTags: true });
  expect(r.dropped).toBe(1);
  expect(listTagTree(db)).toHaveLength(0);
});

// allTags=false(默认):老词 drop 被 fresh 闸门挡住(既有行为)
it('allTags 默认 false:老词 drop 仍被 fresh 闸门挡住', async () => {
  const db = openDb(':memory:');
  ensureTag(db, '美食', null);
  mocks.complete.mockResolvedValue(JSON.stringify([{ name: '美食', action: 'drop' }]));
  const r = await runTagCheck({ config, tree: listTagTree(db), newNames: ['新词'], db }); // 美食不是本轮新词
  expect(r.dropped).toBe(0);
  expect(listTagTree(db)).toHaveLength(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/tagcheck.test.ts`
Expected: 新 3 条 FAIL（分批没实现 / allTags 参数不存在）。

- [ ] **Step 3: 实现分批** —— 在 `runTagCheck` 里，把「一次构造 messages + 一次 complete」改成循环分批：

```ts
  // 分批大小:200 词/批。词多时一次全送会淹没模型 → 0 判定(TAGCHECK_EMPTY 根因)
  const TAGCHECK_BATCH = 200;
  const allNames = opts.allTags
    ? listTagsWithParent(db).map((r) => r.name)   // 全库词名
    : [...opts.newNames];

  const verdicts: TagVerdict[] = [];
  const known = new Set<string>();
  const collect = (nodes: readonly TagNode[]) => {
    for (const n of nodes) { known.add(n.name); collect(n.children); }
  };
  collect(opts.tree);
  const fresh = opts.allTags ? null : new Set(allNames.map(normalizeTagName));

  // 闸门:没词可判就一次 LLM 都不调
  if (allNames.length === 0) {
    opts.onNote?.('info', '本轮没有新词可判 —— 质检无事发生');
    return { dropped: 0, merged: 0, moved: 0 };
  }

  for (let i = 0; i < allNames.length; i += TAGCHECK_BATCH) {
    const batch = allNames.slice(i, i + TAGCHECK_BATCH);
    console.log(`[tags/check] 批 ${Math.floor(i / TAGCHECK_BATCH) + 1}/${Math.ceil(allNames.length / TAGCHECK_BATCH)} 送 ${batch.length} 个词`);
    const messages: ChatMessage[] = [
      { role: 'system', content: CHECK_SYSTEM },
      {
        role: 'user',
        content:
          `## 现有标签树\n${renderTree(opts.tree) || '(空)'}\n\n` +
          `## 待判定的词(${batch.length} 个)\n${batch.join('、')}\n\n` +
          `请逐个判定。`,
      },
    ];
    verdicts.push(...coerceVerdicts(
      await complete({
        config: opts.config,
        messages,
        thinking: false,
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      }),
      known,
    ));
  }
```

- [ ] **Step 4: 实现 allTags 分支 + fresh 闸门** —— 在 `runTagCheck` 的 verdict 处理循环里，把 `if (!fresh.has(...))` 改为 `if (fresh && !fresh.has(...))`：

```ts
  let dropped = 0, merged = 0, moved = 0;
  for (const v of verdicts) {
    // **老词一律不碰** —— 但 allTags=true(手动全库质检)时放开(fresh 为 null)
    if (fresh && !fresh.has(normalizeTagName(v.name))) {
      opts.onNote?.('warn', `质检判了「${v.name}」,但它不是本轮的新词 —— 按规矩没动它`);
      continue;
    }
    // ... 其余执行逻辑不变
```

- [ ] **Step 5: 重写 CHECK_SYSTEM** —— 替换开头的 `CHECK_SYSTEM` 常量：

```ts
export const CHECK_SYSTEM = `你是标签词库的质检员。用户给你一棵标签树和一批词,判断每个词该怎么办。

- **drop**(太泛,删掉):这个词不能把一类内容和其它内容**分开**。
  该删的例:"AI""视频""教程""分享""合集""超清" —— 几乎每条都挂,没有区分力。
  不该删的例:"露营"(只挂户外内容)、"烤羊肉"(只挂美食内容) —— 能分开一类,留着。
- **merge**(同义,并入已有词):它是已有词的另一种写法(译名/简写/同义词)。
  该并的例:"鲁夫"→"路飞","漫威"→"Marvel"。
  不该并的例:"露营"和"烤羊肉" —— 意思不同,并了反而丢信息。
- **move**(归错层,挪位):它该挂在另一个已有词下面。
  该挪的例:"篮球"该挂到"体育"下。
  不该挪的例:"露营"挂在根上 —— 它是独立大类,不归任何词管。
- **keep**(留):没问题。
  该留的例:"露营""烤羊肉""NBA"。

**拿不准就 keep** —— 漏掉一个泛词只是让树脏一点,误删一个好词是丢掉信息。
只输出 JSON 数组:[{"name":"AI","action":"drop"},{"name":"鲁夫","action":"merge","target":"路飞"}]`;
```

（注意：`listTagsWithParent` 需要 import。）

- [ ] **Step 6: 跑测试确认通过**

Run: `cd server && npx vitest run src/curator/tagcheck.test.ts`
Expected: 全部 PASS（含既有 11 条 + 新 3 条）。特别注意「只动本轮新词」那条仍绿（fresh 闸门在 allTags=false 时保留）。

- [ ] **Step 7: Commit**

```bash
git add server/src/curator/tagcheck.ts server/src/curator/tagcheck.test.ts
git commit -m "feat(tags): 质检分批 + 判词参照增强 + allTags 参数

5524 词一次全送导致 0 判定(TAGCHECK_EMPTY),按 200/批切。
CHECK_SYSTEM 从 5 个泛词例子升级为每个动作的成对正反例。
allTags=true 时绕过 fresh 闸门(手动全库质检用)。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 手动质检端点

**Files:**
- Modify: `server/src/curator/tagRoutes.ts`（注册 `POST /api/tags/tagcheck`）
- Test: `server/src/curator/tagRoutes.test.ts`

**Interfaces:**
- Consumes: `runTagCheck({ ..., allTags })` from Task 1
- Produces: `POST /api/tags/tagcheck` body `{ scope: 'all' | 'new' }` → `{ ok, scope, dropped, merged, moved }`
- Consumes: `listTagsWithParent`(已有)

- [ ] **Step 1: 写失败测试** —— 追加到 `tagRoutes.test.ts` 的「标注路由」describe：

```ts
// 手动质检端点:scope='new' 只检新词;scope='all' 检全库
it('tagcheck:scope=new 走 fresh 闸门,scope=all 绕开', async () => {
  const { app, db } = makeApp();
  ensureTag(db, '美食', null);
  ensureTag(db, '露营', null);
  // 两种 scope 模型都判 drop 美食
  mocks.complete.mockResolvedValue(JSON.stringify([{ name: '美食', action: 'drop' }]));

  // scope=new:美食不是本轮新词(没传 newWords),被 fresh 闸门挡住 → 不删
  const r1 = await app.inject({ method: 'POST', url: '/api/tags/tagcheck', payload: { scope: 'new' } });
  expect(r1.statusCode).toBe(200);
  expect(r1.json()).toMatchObject({ ok: true, scope: 'new', dropped: 0 });
  expect(db.prepare(`SELECT id FROM tags WHERE name='美食'`).get()).toBeTruthy();

  // scope=all:检全库 → 美食被删
  mocks.complete.mockClear();
  const r2 = await app.inject({ method: 'POST', url: '/api/tags/tagcheck', payload: { scope: 'all' } });
  expect(r2.statusCode).toBe(200);
  expect(r2.json()).toMatchObject({ ok: true, scope: 'all', dropped: 1 });
  expect(db.prepare(`SELECT id FROM tags WHERE name='美食'`).get()).toBeUndefined();
  // 记了 TAGCHECK_MANUAL
  expect(db.prepare(`SELECT code FROM events WHERE code='TAGCHECK_MANUAL'`).get()).toBeTruthy();
  await app.close();
});

it('tagcheck:标注跑着时拒绝(409)', async () => {
  const { app, db } = makeApp();
  upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
  let release!: () => void;
  mocks.complete.mockImplementation(
    () => new Promise((res) => { release = () => res(JSON.stringify([{ id: 'BV1', tags: ['x'], kind: 'x' }])); }),
  );
  const runRes = await app.inject({ method: 'POST', url: '/api/tags/run' });
  expect(runRes.statusCode).toBe(200);
  const tagRes = await app.inject({ method: 'POST', url: '/api/tags/tagcheck', payload: { scope: 'all' } });
  expect(tagRes.statusCode).toBe(409);
  release();
  await vi.waitFor(async () => {
    const p = (await app.inject({ method: 'GET', url: '/api/tags/run-progress' })).json() as { running: boolean };
    if (p.running) throw new Error('still running');
  });
  await app.close();
});
```

（测试里需要 `ensureTag` 已 import —— 检查现有 import；没有就加。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/tagRoutes.test.ts -t tagcheck`
Expected: 2 条 FAIL（端点不存在）。

- [ ] **Step 3: 实现端点** —— 在 `clear-tags` 路由后加：

```ts
  /**
   * 手动质检(spec M4h 扩展)。scope 选范围:
   * - 'new':只检本轮新词(fresh 闸门,老词不碰)
   * - 'all':检全库词,绕过 fresh(老词可能被删,不可逆 —— 弹窗已明示风险)
   * 同步执行;标注跑着时 409。
   */
  app.post('/api/tags/tagcheck', async (req, reply) => {
    if (currentRun.running) {
      return reply.code(409).send({ ok: false, reason: '标注跑着不能质检 —— 先等它跑完或停止' });
    }
    const scope = (req.body as { scope?: string })?.scope === 'all' ? 'all' : 'new';
    const checker = readLlmSettings(db, 'tagcheck');
    if (!checker) {
      return reply.code(400).send({ ok: false, reason: '还没配「标签质检」模型 —— 先去「授权」页配一个' });
    }
    const t0 = Date.now();
    const r = await runTagCheck({
      config: checker.config,
      tree: listTagTree(db),
      newNames: [],                        // 手动质检:待检词由 allTags 决定
      db,
      log,
      allTags: scope === 'all',
      // 无 signal:手动质检是独立请求,没有 run 的 controller
      timeoutMs: 180_000,
    });
    console.log(`[tags/check] 手动质检完成 scope=${scope} 耗时 ${Date.now() - t0}ms`);
    log.event({ level: 'info', category: 'llm', code: 'TAGCHECK_MANUAL', message: `手动质检:${scope}` });
    return { ok: true, scope, ...r };
  });
```

（注意：`signal` 不需要 —— 手动质检是独立请求,没有 controller。去掉那行。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run src/curator/tagRoutes.test.ts -t tagcheck`
Expected: 2 条 PASS。再跑全量 `npx vitest run` 确认没破。

- [ ] **Step 5: Commit**

```bash
git add server/src/curator/tagRoutes.ts server/src/curator/tagRoutes.test.ts
git commit -m "feat(tags): 手动质检端点 POST /api/tags/tagcheck(scope all|new)

scope='all' 检全库绕过 fresh 闸门,scope='new' 只检新词。
标注跑着时 409,记 TAGCHECK_MANUAL event。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 前端 —— 词库质检按钮 + 弹窗范围选择

**Files:**
- Modify: `web/src/api.ts`（加 `tagcheck`）
- Modify: `web/src/components/TagPanel.tsx`（按钮 + 弹窗）

**Interfaces:**
- Consumes: `POST /api/tags/tagcheck` from Task 2
- Produces: `tagApi.tagcheck(scope: 'all' | 'new'): Promise<{ ok: true; scope: 'all'|'new'; dropped: number; merged: number; moved: number }>`

- [ ] **Step 1: api.ts 加 `tagcheck`** —— 在 `tagApi` 对象里（clearTags 后）：

```ts
  /** 手动质检(M4h 扩展)—— scope: all 全库 / new 只查本轮新词 */
  tagcheck: (scope: 'all' | 'new') =>
    json<{ ok: true; scope: 'all' | 'new'; dropped: number; merged: number; moved: number }>(
      'POST', '/api/tags/tagcheck', { scope },
    ),
```

- [ ] **Step 2: TagPanel 加「词库质检」按钮** —— 在清空标注按钮前加（约 525 行）：

```tsx
                {/* 词库质检:手动触发,弹窗选范围(全部 / 只查新的) */}
                <Button size="small" icon={<ScanSearch size={13} />} onClick={confirmTagCheck}>
                  词库质检
                </Button>
```

（`ScanSearch` 从 lucide-react 导入。若图标名不存在用 `SearchCheck` 或 `ShieldCheck`。）

- [ ] **Step 3: 定义 `confirmTagCheck`** —— 在 `confirmClearTags` 后：

```tsx
  /** 手动质检:弹窗单选范围。「全部审查」会删模型判定为泛词的词,不可逆,默认不选 */
  const confirmTagCheck = () => {
    let scope: 'all' | 'new' = 'new';
    const inst = modal.confirm({
      title: '词库质检',
      content: (
        <div style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 10 }}>
            跑一遍质检,模型会逐个判定词的去向 —— 泛词该删、重复词该并、归错层的该挪。
          </div>
          <Radio.Group
            value={scope}
            onChange={(e) => {
              scope = e.target.value;
              inst.update({});
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Radio value="new">只查这次新的 —— 只对这一轮 AI 标注新长出来的词判定,不碰已有词</Radio>
              <Radio value="all">
                全部审查 —— 对词库里所有词判定,包括已有词。模型可能把挂得多的大类词
                判为"泛词"而删掉。<b style={{ color: 'var(--warn)' }}>删词不可逆</b>,慎选
              </Radio>
            </div>
          </Radio.Group>
        </div>
      ),
      okText: '开始质检',
      cancelText: '算了',
      onOk: async () => {
        await act(async () => {
          const r = await tagApi.tagcheck(scope);
          setTagNote(`质检完成:删 ${r.dropped} · 合 ${r.merged} · 挪 ${r.moved}`);
        });
      },
    });
  };
```

（`Radio` 从 antd 导入。）

- [ ] **Step 4: typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/components/TagPanel.tsx
git commit -m "feat(web): 词库质检按钮 + 弹窗范围选择(全部审查/只查新的)

全部审查明示"删词不可逆",默认只查新的。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 全量验证 + spec 状态

- [ ] **Step 1: 后端全量**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: typecheck 干净;全部测试 PASS(含新增 tagcheck 用例)。

- [ ] **Step 2: 前端全量**

Run: `cd web && npx tsc --noEmit`
Expected: 干净。

- [ ] **Step 3: 手动验证**(dev 起服务):
- 「标签」页有「词库质检」按钮。
- 点开弹窗,两个范围选项,默认勾「只查这次新的」。
- 「全部审查」话术含「删词不可逆」。
- 选「只查这次新的」→ 跑完提示「删 X · 合 Y · 挪 Z」。
- 选「全部审查」→ 老词可能被删。

- [ ] **Step 4: 更新 spec 状态**

把 `docs/superpowers/specs/2026-09-19-manual-full-tagcheck.md` 顶部状态从「待实施」改成「已实施 + 日期」。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-19-manual-full-tagcheck.md
git commit -m "docs: 质检分批 + 手动质检 spec 标记已实施

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
