# 清空标注 + 标注按钮三态 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加一个「清空标注」按钮（连词库树一起清、二次确认），并把「AI 标注 / 重新标注全部」两个按钮改成跟随标注状态的三种形态 —— 为「继续标注」性能测试开路。

**Architecture:** 后端在 `tags.ts` 加 `clearTagLibrary(db)`（清 tags + 级联清 item_tags/tag_aliases + 清 items 水位线 + 规则 tag 条件），`tagRoutes.ts` 注册 `POST /api/tags/clear-tags`（currentRun 守卫 + TAGS_CLEARED 事件）。前端 `TagPanel.tsx` 按 `tagStatus` 的 tagged/total 渲染按钮三态，清空按钮走 modal.confirm + 输入「清空」文字确认。按钮态是纯函数，独立小测试钉住。

**Tech Stack:** TypeScript, Fastify, better-sqlite3, vitest, React + antd + umijs/max（web 无测试骨架，按钮态逻辑抽纯函数 + vitest 测）。

**Spec:** `docs/superpowers/specs/2026-09-19-clear-tags-and-run-button-modes.md`

## Global Constraints

- 判据语义不变（reconcile 的 0.9 / 5 阈值、MIN_SAMPLE、活跃层逻辑都不动）。
- 规则里的 tag 引用清理必须用 `rewriteRuleTagIds`，且**在删 tags 之前**（§9F C16）。
- `tagStats` 的 tagged/total 都排除 invalid —— 按钮态判断基于它，不再加新查询。
- 清空是测试辅助功能，**不可撤销**；二次确认（输入「清空」文字）是唯一防线。
- 不碰同步列（items 上除 `ai_kind`/`ai_checked_at` 之外的列）。
- 不区分 `item_tags.source` —— 连词库一起清，规则/手动挂的一并清。
- 现有测试全绿；commit 按 task 粒度分。

---

### Task 1: 后端清空 —— `clearTagLibrary` + `POST /api/tags/clear-tags`

**Files:**
- Modify: `server/src/db/repo/tags.ts`（deleteTag 后加 `clearTagLibrary`）
- Modify: `server/src/curator/tagRoutes.ts`（注册路由）
- Test: `server/src/curator/tagRoutes.test.ts`

**Interfaces:**
- Produces: `clearTagLibrary(db: Database.Database): void` —— 清空整棵词库树（tags/item_tags/tag_aliases 经 FK 级联）+ items 的 `ai_kind`/`ai_checked_at` + 规则 tag 条件。单个事务。
- Produces: 路由 `POST /api/tags/clear-tags` → `{ ok: true }`；`currentRun.running` 时 409。

- [ ] **Step 1: 写失败测试** —— 追加到 `tagRoutes.test.ts` 的「标注路由」describe 里：

```ts
import { rewriteRuleTagIds } from '../db/repo/rules.js';

// ★ M4h 之后的新测试辅助:一键回到「从没标过」,测「继续标注」性能用。
// 清空的是**整棵词库树**(tags + item_tags + tag_aliases)+ items 水位线 + 规则里的 tag 条件。
it('clear-tags:清掉词库树、水位线、规则 tag 条件;幂等', async () => {
  const { app, db } = makeApp();
  // 造一个词 + 挂载 + 标注过 + 一条规则引用它
  const tag = ensureTag(db, '美食', null);
  upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
  linkItemTag(db, 'BV1', tag, 'ai');
  markItemTagged(db, 'BV1', '美食');
  // 规则条件引用这个 tag id —— C16 说删 tag 必须清掉,否则规则静默失效
  db.prepare(`INSERT INTO work_folder_rules (folder_id, conditions_json, updated_at) VALUES (1, ?, 0)`)
    .run(JSON.stringify([{ field: 'tag', tagIds: [tag] }]));

  const res = await app.inject({ method: 'POST', url: '/api/tags/clear-tags' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });

  // 词库树空了(级联带走了 item_tags / tag_aliases)
  expect(db.prepare(`SELECT COUNT(*) n FROM tags`).get()).toEqual({ n: 0 });
  expect(db.prepare(`SELECT COUNT(*) n FROM item_tags`).get()).toEqual({ n: 0 });
  // 水位线清了 → 回「未标注」
  expect(db.prepare(`SELECT ai_checked_at FROM items WHERE id='BV1'`).get()).toEqual({ ai_checked_at: null });
  // 规则里的 tag 条件被移除
  const rule = db.prepare(`SELECT conditions_json FROM work_folder_rules WHERE folder_id=1`).get() as { conditions_json: string };
  expect(rule.conditions_json).not.toContain('tagIds');
  // 记了 TAGS_CLEARED
  expect(db.prepare(`SELECT code FROM events WHERE code='TAGS_CLEARED'`).get()).toBeTruthy();

  // 幂等:再清一遍也 ok
  const res2 = await app.inject({ method: 'POST', url: '/api/tags/clear-tags' });
  expect(res2.statusCode).toBe(200);
  await app.close();
});

it('clear-tags:标注跑着时拒绝(409)', async () => {
  const { app, db } = makeApp();
  // 没有公开端点能直接造"正在跑"的状态,只能靠真实标注跑起来:
  // 用一个不 resolve 的 mock 让 complete 挂起,currentRun.running 停在 true
  upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
  let release!: () => void;
  mocks.complete.mockImplementation(
    () => new Promise((res) => { release = () => res(JSON.stringify([{ id: 'BV1', tags: ['x'], kind: 'x' }])); }),
  );
  const runRes = await app.inject({ method: 'POST', url: '/api/tags/run' });
  expect(runRes.statusCode).toBe(200);
  // complete 没 resolve → currentRun.running 仍 true;这时 clear 该 409
  const clearRes = await app.inject({ method: 'POST', url: '/api/tags/clear-tags' });
  expect(clearRes.statusCode).toBe(409);
  release(); // 放行,免得 pending promise 卡住测试
  await vi.waitFor(async () => {
    const p = (await app.inject({ method: 'GET', url: '/api/tags/run-progress' })).json() as { running: boolean };
    if (p.running) throw new Error('still running');
  });
  await app.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/curator/tagRoutes.test.ts -t clear-tags`
Expected: 两个测试都 FAIL（`clearTagLibrary` 不存在 / 路由 404 / 断言不满足）。

- [ ] **Step 3: 实现 `clearTagLibrary`** —— 加到 `tags.ts` 的 `deleteTag` 之后：

```ts
/**
 * 清空整棵词库树 + 条目水位线 —— 「清空标注」按钮的后端(M4h 后测试辅助)。
 *
 * 单事务,幂等。连词库一起清:tags / item_tags / tag_aliases(item_tags、tag_aliases
 * 靠 FK 级联带走)+ items 的 ai_kind / ai_checked_at(回「未标注」)+ 规则里的 tag 条件。
 *
 * **顺序不能反**:规则条件必须在删 tags 之前移除(§9F C16)——
 * 反了的话规则里留一串死 id,静默失效,用户看不出自己的规则已经断了。
 */
export function clearTagLibrary(db: Database.Database): void {
  db.transaction(() => {
    rewriteRuleTagIds(db, () => null);
    db.prepare(`DELETE FROM tags`).run();
    db.prepare(`UPDATE items SET ai_kind = NULL, ai_checked_at = NULL`).run();
  })();
}
```

- [ ] **Step 4: 实现路由** —— 在 `tagRoutes.ts` 的 `run-abort` 后加：

```ts
  /**
   * 清空标注(M4h 后测试辅助)。**高危、不可撤销** —— 前端必须二次确认(输入「清空」文字)。
   * 连词库树一起清,所有条目回「未标注」,规则里的 tag 条件一并移除。
   */
  app.post('/api/tags/clear-tags', async (req, reply) => {
    if (currentRun.running) {
      return reply.code(409).send({ ok: false, reason: '标注跑着不能清空 —— 先等它跑完或停止' });
    }
    clearTagLibrary(db);
    log.event({ level: 'info', category: 'llm', code: 'TAGS_CLEARED', message: '词库树 + 条目标注已清空' });
    return { ok: true };
  });
```

（在 import 里加 `clearTagLibrary`。）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && npx vitest run src/curator/tagRoutes.test.ts -t clear-tags`
Expected: 两个测试 PASS。跑全量 `npx vitest run` 确认没破。

- [ ] **Step 6: Commit**

```bash
git add server/src/db/repo/tags.ts server/src/curator/tagRoutes.ts server/src/curator/tagRoutes.test.ts
git commit -m "feat(tags): 清空标注端点 —— 清词库树+水位线+规则条件,带运行中守卫

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 按钮三态纯函数

**Files:**
- Create: `web/src/utils/tagRunButtons.ts`
- Test: `web/src/utils/tagRunButtons.test.ts`

**Interfaces:**
- Produces: `type RunButton = 'primary' | 'continue' | 'retag'`
- Produces: `runButtons(tagged: number, total: number): RunButton[]`
  - `tagged === 0` → `['primary']`
  - `tagged === total` → `['retag']`
  - `0 < tagged < total` → `['continue', 'retag']`
  - 边界:`total === 0`(空库,无有效条目)→ `[]`(无按钮可点)

- [ ] **Step 1: 写失败测试**

```ts
// web/src/utils/tagRunButtons.test.ts
import { describe, it, expect } from 'vitest';
import { runButtons } from './tagRunButtons';

describe('runButtons', () => {
  it('从没标过 → 只有 AI 标注', () => {
    expect(runButtons(0, 100)).toEqual(['primary']);
  });
  it('全标完 → 只有重新标注全部', () => {
    expect(runButtons(100, 100)).toEqual(['retag']);
  });
  it('标了一半 → 继续标注 + 重新标注全部', () => {
    expect(runButtons(30, 100)).toEqual(['continue', 'retag']);
  });
  it('空库(无有效条目)→ 无按钮', () => {
    expect(runButtons(0, 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/utils/tagRunButtons.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现纯函数**

```ts
// web/src/utils/tagRunButtons.ts
/**
 * 标注按钮三态 —— 跟随「标了多少」走(清空后回 0、全标完只剩重标)。
 * 纯函数,独立测;TagPanel 消费它渲染按钮。
 */
export type RunButton = 'primary' | 'continue' | 'retag';

export function runButtons(tagged: number, total: number): RunButton[] {
  if (total === 0) return [];
  if (tagged === 0) return ['primary'];
  if (tagged >= total) return ['retag'];
  return ['continue', 'retag'];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/utils/tagRunButtons.test.ts`
Expected: 4 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add web/src/utils/tagRunButtons.ts web/src/utils/tagRunButtons.test.ts
git commit -m "feat(web): 标注按钮三态纯函数

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 前端接线 —— 按钮三态 + 清空按钮

**Files:**
- Modify: `web/src/api.ts`（加 `clearTags`）
- Modify: `web/src/components/TagPanel.tsx`（按钮区 + 清空确认 + 状态刷新）

**Interfaces:**
- Consumes: `runButtons(tagged, total)` from Task 2
- Consumes: `tagApi.clearTags(): Promise<{ ok: true }>`（本任务加）
- Produces: 无新导出

- [ ] **Step 1: api.ts 加 `clearTags`** —— 在 `tagApi` 对象里加：

```ts
  /** 清空标注(M4h 后测试辅助)—— 连词库树一起清,高危,前端要二次确认 */
  clearTags: () => json<{ ok: true }>('POST', '/api/tags/clear-tags'),
```

- [ ] **Step 2: TagPanel 导入 runButtons** —— 改 import：

```ts
import { runButtons } from '../utils/tagRunButtons';
```

- [ ] **Step 3: 按钮区改三态渲染** —— 替换 `tagging ? (...停止...) : (<> AI标注 + 重新标注全部 </>)` 里非 tagging 的分支。当前代码（约 463-472 行）是：

```tsx
            ) : (
              <>
                <Button size="small" icon={<Tag size={13} />} onClick={() => void runTag('missing')}>
                  AI 标注
                </Button>
                <Button size="small" icon={<RefreshCw size={13} />} onClick={retagAll}>
                  重新标注全部
                </Button>
              </>
            )}
```

改成（用 `tagStatus` 算按钮态；`tagStatus` 为 null 时兜底显示「AI 标注」，避免取数前空白）：

```tsx
            ) : (
              <>
                {runButtons(tagStatus?.tagged ?? 0, tagStatus?.total ?? 0).map((b) =>
                  b === 'retag' ? (
                    <Button key="retag" size="small" icon={<RefreshCw size={13} />} onClick={retagAll}>
                      重新标注全部
                    </Button>
                  ) : (
                    <Button
                      key="run"
                      size="small"
                      icon={<Tag size={13} />}
                      onClick={() => void runTag('missing')}
                    >
                      {b === 'continue' ? '继续标注' : 'AI 标注'}
                    </Button>
                  ),
                )}
                {/* 清空标注:高危、连词库树一起清,必须输入「清空」二字才可确定 */}
                <Button size="small" danger icon={<Eraser size={13} />} onClick={confirmClearTags}>
                  清空标注
                </Button>
              </>
            )}
```

（`Eraser` 从 lucide-react 导入；`confirmClearTags` 在下一步定义。）

- [ ] **Step 4: 定义 `confirmClearTags`** —— 用 modal.confirm + 输入「清空」文字，沿用 `confirmMerge` 的 `inst.update` 模式。放在 `retagAll` 后面：

```tsx
  /** 清空标注:高危、不可撤销,必须输入「清空」二字才可点确定(二次确认) */
  const confirmClearTags = () => {
    let typed = '';
    const inst = modal.confirm({
      title: '清空所有标注?',
      content: (
        <div style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>
            会把 <b>整棵词库树</b>(tags + 条目关联)和所有条目的 AI 标注一起删掉,
            规则里的标签条件也会移除。这个动作<b>不可撤销</b> —— 想测「继续标注」
            性能时,用它回到「从没标过」的状态。
          </div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>输入「清空」以确认:</div>
          <Input
            autoFocus
            value={typed}
            onChange={(e) => {
              typed = e.target.value;
              inst.update({ okButtonProps: { disabled: typed !== '清空' } });
            }}
            style={{ width: '100%' }}
          />
        </div>
      ),
      okText: '清空',
      okButtonProps: { danger: true, disabled: true },
      cancelText: '算了',
      onOk: async () => {
        await act(async () => {
          await tagApi.clearTags();
          setTagNote('已清空标注 —— 所有条目回到未标注状态');
        });
      },
    });
  };
```

（`Input` 从 antd 导入。）

- [ ] **Step 5: typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/components/TagPanel.tsx
git commit -m "feat(web): 标注按钮三态 + 清空标注按钮(输「清空」确认)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 全量验证

- [ ] **Step 1: 后端全量**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: typecheck 干净；全部测试 PASS（含新增 clear-tags 用例）。

- [ ] **Step 2: 前端全量**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: typecheck 干净；tagRunButtons.test 4 条 PASS。

- [ ] **Step 3: 手动验证**（dev 起服务）

Run: `npm run dev`，浏览器打开「标签」页：
- 从没标过（或刚清空）→ 只显示「AI 标注」+「清空标注」。
- 标一部分 → 「继续标注」+「重新标注全部」+「清空标注」。
- 全标完 → 「重新标注全部」+「清空标注」。
- 点「清空标注」→ 不输「清空」确定键禁用；输「清空」后能点；执行后回到「从没标过」态（只有「AI 标注」）。

- [ ] **Step 4: 更新 spec 状态**

把 `docs/superpowers/specs/2026-09-19-clear-tags-and-run-button-modes.md` 顶部状态从「待实施」改成「已实施 + 日期」。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-19-clear-tags-and-run-button-modes.md
git commit -m "docs: 清空标注 + 按钮三态 spec 标记已实施

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
