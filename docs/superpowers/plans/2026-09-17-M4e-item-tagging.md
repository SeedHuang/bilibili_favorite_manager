# §9E 条目 AI 标注(ai_tags)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 先对每条收藏得出"这是什么类型"(2-4 个标签 + 受控 kind),写进预留的 `ai_tags` 列;归类时把这些标签作为补充信号喂给模型 —— 两段式:**本地小模型标注(全库 5 分钟、零成本)→ 主模型归类看得更清**。

**Architecture:** 新增一个标注引擎(`tagger.ts`,纯编排)+ 一个 SSE 路由(`POST /api/rules/tag`)—— 完全复用 §9D 已验证的模式(批量 + onBatch + 逐批落库 + 可中止 + progress 帧);标注走 `readLlmSettings(db, 'tag')`(没配回落主模型);标签在归类渲染(`renderItem`)里作为**补充信号**出现,提示词声明"标签是参考,原始数据为准"。标注的落库走一个**专用写库函数**(C8:`upsertItem` 的 UPDATE 分支永不碰 `ai_*` 列,这个约束不破)。

**Tech Stack:** TypeScript ^5.9.3(ESM)、better-sqlite3、Fastify 5(SSE)、Vercel AI SDK v7、React + antd 5

**Spec:** `docs/superpowers/specs/m4e-item-tagging.md`(§9E,冲突时以它为准)。它不改任何 §9C 决定(规则引擎的字段不动);§9D 的传输模式原样复用。

## Global Constraints

- Node 22.12、TypeScript ^5.9.3、ESM(**类型一律 `import type`**);`strict` + `noUncheckedIndexedAccess`
- 依赖方向:`http → curator → db / logger`;`db/` 不许 import `curator/`
- 注释写中文,解释"为什么";commit trailer **严格** `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- **C8 红线:同步路径(`upsertItem`)永不写 `ai_tags` / `ai_checked_at`** —— 标注用本计划新建的专用写库函数
- **kind 受控枚举**:`教学 / 娱乐 / 评测 / 资讯 / 工具 / 其它`(spec C3);越界一律记 `其它`
- **标签永远是补充信号**:归类提示词必须声明"标签是参考,原始数据为准"(spec C6)
- 测试**不调真实 API**,LLM 一律 mock;**真模型验收**(4b 全库跑一遍)在交付清单里,不进测试
- 每个任务收尾跑:`npm test -w server` 全绿;涉及前端时再加 `cd web && npm run typecheck && npx max build`
- **全局测试与 typecheck 必须串行跑**(rateLimiter.test.ts 时序敏感)
- 前端没有测试框架;typecheck + build 是它的验证

---

## 先读这段:现状的四个事实

1. **列是现成的**:`items.ai_tags TEXT` / `ai_checked_at INTEGER`(schema.ts:49-51),0 条有值,零迁移。C8 的注释(explicitly)写的就是"等 M4 来写"。
2. **标注模型的配置面已经就位**:`readLlmSettings(db, 'tag')`(config.ts),没配回落主模型;授权页第二张卡片可配。本计划的标注引擎只管调它。
3. **§9D 的 SSE 模式原样复用**:progress 帧 + `reply.raw.on('close')` 带 `writableEnded` 守卫 + `controller.abort()` 进 provider(48aed22 修好的那套)。**不要**再碰 `req.raw.on('close')` —— 那个坑已经踩过并用真 socket 测试钉住了。
4. **4b 实测口径**(2026-09-17):8 条 0.79s,全库 ≈5 分钟;**一次喂 8 条只吐 4 条**是真实行为 —— 所以 spec C4 的逐条覆盖断言不是防御性编程,是已观察到的必须项。

```
server/src/
├─ db/repo/tagging.ts        ← T1 新建:ai_tags 的专用写库函数(C8 红线所在)
├─ curator/tagger.ts         ← T2 新建:标注引擎(批量 + 覆盖断言 + kind 校验 + onBatch/signal)
├─ curator/rules.ts          (不动)
├─ curator/tagRoutes.ts      ← T3 新建:POST /api/tags/run(SSE)+ GET /api/tags/status
├─ curator/classifier.ts     ← T4:renderItem 加标签行;PASS2_SYSTEM 加"标签是参考"声明
├─ http/index.ts             ← T3 注册一行
web/src/
├─ api.ts                    ← T5 tagApi
├─ types.ts                  ← T5 TagRunStatus / TagProgressPayload
└─ components/RulesPanel.tsx ← T6 标注入口 + 进度 + 状态行
```

---

### Task 1: ai_tags 的专用写库函数(C8 红线的落点)

**Files:**
- Create: `server/src/db/repo/tagging.ts`
- Test: `server/src/db/repo/tagging.test.ts`

**Interfaces:**
- Consumes: 无(`better-sqlite3` 的 Database)
- Produces:
  ```ts
  export interface ItemTagging { tags: string[]; kind: string }
  /** 读一条条目的标注(没标过返回 null) */
  export function getItemTagging(db, id: string): ItemTagging | null
  /** 写一条条目的标注;tags=[] 或 kind 缺失 = 清除标注 */
  export function setItemTagging(db, id: string, t: ItemTagging | null): void
  /** 批量读:哪些条目还没标注(增量标注的取数) */
  export function listUntaggedItemIds(db, limit?: number): string[]
  /** 统计:已标注 / 总数(UI 状态行用) */
  export function tagStats(db): { tagged: number; total: number }
  ```

- [ ] **Step 1: 写失败的测试**

`server/src/db/repo/tagging.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertItem } from './items.js';
import { getItemTagging, setItemTagging, listUntaggedItemIds, tagStats } from './tagging.js';

const seed = () => {
  const db = openDb(':memory:');
  for (const id of ['BV1', 'BV2', 'BV3']) upsertItem(db, { id, type: 2, title: `题${id}` });
  return db;
};

describe('ai_tags 专用写库(C8:同步不碰这三列,这里是唯一写手)', () => {
  it('没标过 → null;写了能读回', () => {
    const db = seed();
    expect(getItemTagging(db, 'BV1')).toBeNull();

    setItemTagging(db, 'BV1', { tags: ['教学', 'Python'], kind: '教学' });
    expect(getItemTagging(db, 'BV1')).toEqual({ tags: ['教学', 'Python'], kind: '教学' });
  });

  // ★ C8 红线:upsertItem(同步路径)写条目时**不得**碰 ai_tags。
  //   光删掉 upsertItem 里那句不存在的写入测不出什么 —— 这条测的是:
  //   同步重写同一条目后,标注还在(C8 的全部意义)
  it('同步重写同一条目(upsertItem)→ 标注不被洗掉', () => {
    const db = seed();
    setItemTagging(db, 'BV1', { tags: ['教学'], kind: '教学' });

    upsertItem(db, { id: 'BV1', type: 2, title: '改名后的标题' }); // 模拟重同步
    expect(getItemTagging(db, 'BV1')).toEqual({ tags: ['教学'], kind: '教学' });
  });

  it('null = 清除标注(ai_checked_at 也清)', () => {
    const db = seed();
    setItemTagging(db, 'BV1', { tags: ['教学'], kind: '教学' });
    setItemTagging(db, 'BV1', null);
    expect(getItemTagging(db, 'BV1')).toBeNull();
  });

  it('listUntaggedItemIds 只回没标注的;listStats 数得对', () => {
    const db = seed();
    setItemTagging(db, 'BV2', { tags: ['娱乐'], kind: '娱乐' });

    expect(listUntaggedItemIds(db)).toEqual(['BV1', 'BV3']);
    expect(tagStats(db)).toEqual({ tagged: 1, total: 3 });
  });

  it('存的 JSON 坏了 → 当作没标注(返回 null),不炸', () => {
    const db = seed();
    db.prepare(`UPDATE items SET ai_tags = '不是JSON' WHERE id = 'BV1'`).run();
    expect(getItemTagging(db, 'BV1')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/db/repo/tagging.test.ts`
Expected: FAIL —— `Cannot find module './tagging.js'`

- [ ] **Step 3: 实现**

`server/src/db/repo/tagging.ts`:

```ts
import type Database from 'better-sqlite3';

/**
 * ai_tags 的**唯一写手**(spec §9E C1/C8)。
 *
 * `items.ai_tags` / `ai_checked_at` 是建表时预留的 AI 派生列,和同步列物理隔离(C8):
 * 同步的 upsertItem 的 UPDATE 分支**刻意**不写它们 —— 这里是 AI 侧的写入口。
 * 两边谁也不碰谁的列,重同步洗不掉标注,重标注也碰不到同步数据。
 */
export interface ItemTagging {
  tags: string[];
  kind: string;
}

interface TagRow { ai_tags: string | null }

function parse(raw: string | null): ItemTagging | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { tags?: unknown; kind?: unknown };
    if (!Array.isArray(o.tags) || typeof o.kind !== 'string') return null;
    return { tags: o.tags.filter((t): t is string => typeof t === 'string'), kind: o.kind };
  } catch {
    return null; // 坏 JSON 当作没标注 —— 手改库不该让整个功能炸掉
  }
}

export function getItemTagging(db: Database.Database, id: string): ItemTagging | null {
  const row = db.prepare(`SELECT ai_tags FROM items WHERE id = ?`).get(id) as TagRow | undefined;
  return row ? parse(row.ai_tags) : null;
}

export function setItemTagging(db: Database.Database, id: string, t: ItemTagging | null): void {
  if (t === null) {
    db.prepare(`UPDATE items SET ai_tags = NULL, ai_checked_at = NULL WHERE id = ?`).run(id);
    return;
  }
  db.prepare(
    `UPDATE items SET ai_tags = ?, ai_checked_at = ? WHERE id = ?`,
  ).run(JSON.stringify({ tags: t.tags, kind: t.kind }), Date.now(), id);
}

export function listUntaggedItemIds(db: Database.Database, limit = 100_000): string[] {
  return (
    db.prepare(
      `SELECT id FROM items WHERE ai_checked_at IS NULL ORDER BY id LIMIT ?`,
    ).all(limit) as { id: string }[]
  ).map((r) => r.id);
}

export function tagStats(db: Database.Database): { tagged: number; total: number } {
  const r = db.prepare(
    `SELECT SUM(CASE WHEN ai_checked_at IS NOT NULL THEN 1 ELSE 0 END) tagged, COUNT(*) total FROM items`,
  ).get() as { tagged: number | null; total: number };
  return { tagged: r.tagged ?? 0, total: r.total };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/db/repo/tagging.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/db/repo/tagging.ts server/src/db/repo/tagging.test.ts
git commit -m "feat(db): ai_tags 专用写库 —— C8 的另一侧,同步洗不掉标注

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 标注引擎(批量 + 覆盖断言 + kind 校验)

**Files:**
- Create: `server/src/curator/tagger.ts`
- Test: `server/src/curator/tagger.test.ts`

**Interfaces:**
- Consumes: T1 的 `setItemTagging` / `ItemTagging`;`complete`(provider.ts,带 abortSignal);`ModelConfig` / `ModelMeta`
- Produces:
  ```ts
  export const TAG_KINDS: readonly string[]; // ['教学','娱乐','评测','资讯','工具','其它']
  export interface TagBatchProgress {
    done: number; total: number; tagged: number; failedBatches: { firstItemId: string; size: number; reason: string }[];
  }
  export async function runTagging(opts: {
    config: ModelConfig;
    ctx: ModelMeta;
    /** 要标注的条目(调用方决定增量还是全量) */
    items: readonly ItemRow[];
    onBatch?: (b: TagBatchProgress) => void;
    signal?: AbortSignal;
  }): Promise<{ tagged: number; failedBatches: FailedBatch[] }>
  ```
  逐条覆盖断言(C4):一批喂 N 条,输出 < N → 缺的条目单独补一轮(把缺的 id 单独再问一次,最多重试 2 次,仍缺的记 failedBatch)。

- [ ] **Step 1: 写失败的测试**

`server/src/curator/tagger.test.ts`(mock 方式照 classifier.test.ts:`vi.hoisted` + 顶层 `await import`):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import type { ModelMeta } from '../llm/registry.js';
import { upsertItem } from '../db/repo/items.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

const { runTagging, TAG_KINDS } = await import('./tagger.js');

const ctx: ModelMeta = {
  provider: 'ollama', model: 'qwen3-4b-instruct-2507:latest',
  contextWindow: 262_144, maxOutput: 8_192, verified: true,
};
const config = { id: '本地', provider: 'ollama', baseUrl: '', apiKey: '', model: 'qwen3-4b' };

const item = (id: string, title: string) => {
  const db = openDb(':memory:'); // 不优雅但 item() helper 需要 ItemRow;照 classifier.test.ts 的 item() 抄形状
  void db;
  return {
    id, type: 2, title, intro: null, cover: null, upper_mid: null, upper_name: null,
    duration: null, pubtime: null, invalid: 0, invalid_checked_at: null,
    ai_tags: null, ai_summary: null, ai_checked_at: null, raw: null,
  };
};

/** 模型返回:给 ids 里的每条产一个标注 JSON 数组元素 */
const tagOf = (ids: string[]) =>
  JSON.stringify(ids.map((id) => ({ id, tags: ['教学', id], kind: '教学' })));

beforeEach(() => vi.clearAllMocks());

describe('runTagging', () => {
  it('批量标注并落库(ai_tags / ai_checked_at 都写)', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
    const items = [item('BV1', 'a'), item('BV2', 'b')];
    mocks.complete.mockResolvedValue(tagOf(['BV1', 'BV2']));

    const r = await runTagging({ config, ctx, items, onBatch: undefined, db });
    expect(r.tagged).toBe(2);
    // 落库验证(写库走 T1 的函数)
    const row = db.prepare(`SELECT ai_tags FROM items WHERE id='BV1'`).get() as { ai_tags: string };
    expect(JSON.parse(row.ai_tags)).toMatchObject({ kind: '教学' });
  });

  // ★ C4:实测 8 条只吐 4 条 —— 缺的必须补一轮
  it('输出少于输入 → 缺的条目单独补一轮(覆盖断言)', async () => {
    const db = openDb(':memory:');
    for (const id of ['BV1', 'BV2']) upsertItem(db, { id, type: 2, title: id });
    const items = [item('BV1', 'a'), item('BV2', 'b')];
    mocks.complete
      .mockResolvedValueOnce(tagOf(['BV1']))      // 第一轮漏了 BV2
      .mockResolvedValueOnce(tagOf(['BV2']));     // 补轮拿到 BV2

    const r = await runTagging({ config, ctx, items, db });
    expect(r.tagged).toBe(2);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it('补了 2 轮还缺 → 记 failedBatch,不静默漏', async () => {
    const db = openDb(':memory:');
    for (const id of ['BV1', 'BV2']) upsertItem(db, { id, type: 2, title: id });
    mocks.complete.mockResolvedValue(tagOf(['BV1'])); // 永远不给 BV2

    const r = await runTagging({ config, ctx, items: [item('BV1', 'a'), item('BV2', 'b')], db });
    expect(r.tagged).toBe(1);
    expect(r.failedBatches[0]!.firstItemId).toBe('BV2');
  });

  it('kind 越界 → 记「其它」,不照单全收(C3 受控枚举)', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    mocks.complete.mockResolvedValue(JSON.stringify([{ id: 'BV1', tags: ['x'], kind: '宇宙无敌' }]));

    await runTagging({ config, ctx, items: [item('BV1', 'a')], db });
    const row = db.prepare(`SELECT ai_tags FROM items WHERE id='BV1'`).get() as { ai_tags: string };
    expect(JSON.parse(row.ai_tags).kind).toBe('其它');
  });

  it('onBatch 回调带 done/total/tagged;signal 中止 → 不抛,已完成的保留', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    const controller = new AbortController();
    const seen: { done: number; total: number }[] = [];
    mocks.complete.mockImplementation(async () => {
      controller.abort();
      return tagOf(['BV1']);
    });
    const r = await runTagging({
      config, ctx, items: [item('BV1', 'a')],
      onBatch: (b) => seen.push({ done: b.done, total: b.total }),
      signal: controller.signal, db,
    });
    expect(r.tagged).toBe(1);
    expect(seen).toEqual([{ done: 1, total: 1 }]);
  });

  it('TAG_KINDS 是六个受控值', () => {
    expect(TAG_KINDS).toEqual(['教学', '娱乐', '评测', '资讯', '工具', '其它']);
  });
});
```

> **实现者注意**:上面的测试给 `runTagging` 传了 `db` —— 引擎要落库就得拿 db(和 classifier 不同,标注天然要写)。签名以本计划的 Produces 为准的话需要把 db 加进 opts:`runTagging(opts: { ...; db: Database.Database })`。**加它**。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/tagger.test.ts`
Expected: FAIL —— `Cannot find module './tagger.js'`

- [ ] **Step 3: 实现**

`server/src/curator/tagger.ts`:

```ts
/**
 * 条目 AI 标注引擎(spec §9E)。两段式的第一段:
 * 本地小模型逐条得出"这是什么类型",写进 ai_tags —— 归类(第二段)把它当补充信号。
 *
 * **用本地小模型是特性不是妥协**:标注是逐条判断,4b 免费 + 全库 5 分钟;
 * 语义理解的重活留给第二段的强模型(§9E.0)。
 */
import type Database from 'better-sqlite3';
import type { ItemRow } from '../db/repo/items.js';
import { setItemTagging } from '../db/repo/tagging.js';
import { complete } from '../llm/provider.js';
import { parseJsonArray } from './parse.js';
import type { Assignment } from '../db/repo/classifications.js';
import type { ModelConfig, ChatMessage } from '../llm/provider.js';
import type { ModelMeta } from '../llm/registry.js';

/** kind 受控枚举(spec C3)—— 实测不受控会同义词泛滥("教程/教学/学习") */
export const TAG_KINDS = ['教学', '娱乐', '评测', '资讯', '工具', '其它'] as const;

export const TAG_SYSTEM = `你是 bilibili 收藏的标注助手。对每条视频,从简介和标题判断:
1. kind:内容类型,**只能**是「${TAG_KINDS.join(' / ')}」之一 —— 这是硬约束,不属于任何类就写「其它」。
2. tags:2-4 个主题标签(如 Python、Stable Diffusion、黑神话),用视频里实际出现的词。

只输出 JSON 数组:[{"id":"...","tags":["..."],"kind":"..."}],不要解释,不要围栏。每条输入都必须出现在输出里。`;

/** kind 越界 → 「其它」;tags 非字符串 → 丢;这不是宽容,是受控词表的定义(C3) */
function coerceTag(raw: { id?: unknown; tags?: unknown; kind?: unknown }): { id: string; tags: string[]; kind: string } | null {
  if (typeof raw?.id !== 'string' || !raw.id) return null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, 6)
    : [];
  const kind = TAG_KINDS.includes(raw.kind as never) ? (raw.kind as string) : '其它';
  return { id: raw.id, tags, kind };
}

export interface TagBatchProgress {
  done: number;
  total: number;
  tagged: number;
  failedBatches: { firstItemId: string; size: number; reason: string }[];
}

export async function runTagging(opts: {
  config: ModelConfig;
  ctx: ModelMeta;
  items: readonly ItemRow[];
  onBatch?: (b: TagBatchProgress) => void;
  signal?: AbortSignal;
  db: Database.Database;
}): Promise<{ tagged: number; failedBatches: { firstItemId: string; size: number; reason: string }[] }> {
  const failedBatches: { firstItemId: string; size: number; reason: string }[] = [];
  let tagged = 0;
  const total = opts.items.length;
  let done = 0;

  /** 一次调用标一批;返回标到的 id 集合。调用的原料由 pending 提供(补轮时是"缺的那些") */
  const askOnce = async (batch: readonly ItemRow[]): Promise<Set<string>> => {
    const messages: ChatMessage[] = [
      { role: 'system', content: TAG_SYSTEM },
      {
        role: 'user',
        content: batch
          .map((i) => `- [${i.id}] ${i.title}\n  简介:${(i.intro ?? '').slice(0, 150)}`)
          .join('\n'),
      },
    ];
    const raw = await complete({
      config: opts.config,
      messages,
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    });
    const list = parseJsonArray(raw) ?? [];
    const out = new Set<string>();
    for (const r of list) {
      const c = coerceTag(r as never);
      if (!c) continue;
      // **只收本批的 id** —— 模型编别的条目无效(和归类同款纪律)
      if (!batch.some((i) => i.id === c.id)) continue;
      setItemTagging(opts.db, c.id, { tags: c.tags, kind: c.kind });
      out.add(c.id);
    }
    return out;
  };

  // 批大小:标注的输出很小(每条 ~30 token),输入才是瓶颈 —— 复用 ctx 的窗口,
  // 但按**条数**上限 32 切(实测 4b 超过 ~8 条会漏,补轮兜底;32 是补轮成本的平衡点)
  const size = Math.max(1, Math.min(32, Math.floor((opts.ctx.contextWindow - 1500) / 250)));
  for (let i = 0; i < opts.items.length; i += size) {
    if (opts.signal?.aborted) break; // §9D B2:发起新调用前先看信号
    const batch = opts.items.slice(i, i + size);
    const pending = new Map(batch.map((it) => [it.id, it]));

    // **逐条覆盖断言(C4)**:实测模型会漏条 —— 缺的单独补,最多 2 轮
    for (let round = 0; round < 3 && pending.size > 0; round++) {
      try {
        const got = await askOnce([...pending.values()]);
        for (const id of got) pending.delete(id);
        if (got.size > 0) {
          tagged += got.size;
          done += got.size;
          opts.onBatch?.({ done, total, tagged, failedBatches });
        }
      } catch (e) {
        if (opts.signal?.aborted) break; // 中止不记失败(§9D B5)
        failedBatches.push({ firstItemId: [...pending.keys()][0]!, size: pending.size, reason: `请求失败:${(e as Error)?.message ?? e}` });
        pending.clear();
        break;
      }
    }
    if (pending.size > 0) {
      failedBatches.push({ firstItemId: [...pending.keys()][0]!, size: pending.size, reason: '模型两轮补标后仍未覆盖这些条目' });
    }
  }

  return { tagged, failedBatches };
}
```

> 上面 import 了 `Assignment` 但没用 —— **不要**把它抄进去(那是本计划审查会抓的)。实际需要的 import 以实现为准:`Database` 类型、`ItemRow`、`setItemTagging`、`complete` + 两个类型、`parseJsonArray`、`ModelMeta`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/tagger.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/tagger.ts server/src/curator/tagger.test.ts
git commit -m "feat(curator): 标注引擎 —— 批量 + 逐条覆盖断言 + kind 受控枚举

实测模型会漏条(8 条吐 4 条),覆盖断言不是防御是必须;kind 越界记「其它」
(受控词表,实测不受控会同义词泛滥);中止不记失败(§9D B5)。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: SSE 路由 + 状态查询

**Files:**
- Create: `server/src/curator/tagRoutes.ts`
- Modify: `server/src/http/index.ts`(注册一行)
- Test: `server/src/curator/tagRoutes.test.ts`

**Interfaces:**
- Consumes: T2 的 `runTagging`;T1 的 `listUntaggedItemIds` / `tagStats`;`readLlmSettings(db, 'tag')`;§9D 的 SSE 模式(`reply.raw.on('close')` + `writableEnded` 守卫 —— **不许**用 `req.raw.on('close')`,那个 Critical 的修复就是这条)
- Produces:
  ```
  GET  /api/tags/status → { tagged, total, model: { provider, model, source: 'tag'|'main' } | null }
  POST /api/tags/run?scope=missing|all → SSE
       progress 帧 {done, total, tagged}   (无 ruleCount —— 那是归类的字段)
       done 帧  { tagged, failedBatches }
       aborted 帧 / error 帧(§9D 原样)
  ```
  scope 默认 `missing`(增量);`all` 全量重标。

- [ ] **Step 1: 写失败的测试**

`server/src/curator/tagRoutes.test.ts`(照 routes.test.ts 的 makeApp 模式,LLM mock 用 `vi.hoisted` + importOriginal):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertItem } from '../db/repo/items.js';
import { saveLlmSettings } from '../llm/config.js';
import type { BiliClient } from '../bilibili/client.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', async (orig) => ({
  ...(await orig<typeof import('../llm/provider.js')>()),
  complete: mocks.complete,
}));

const stubClient = { withCredentials: () => ({ get: async () => null }) } as unknown as BiliClient;

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  saveLlmSettings(db, { provider: 'ollama', model: 'qwen3-4b', baseUrl: '', apiKey: '' });
  const app = createServer({ db, log, client: stubClient });
  return { app, db };
}

/** SSE 文本 → [{event, data}] */
const sse = (body: string) =>
  body.split('\n\n').filter((b) => b.trim()).map((b) => ({
    event: /^event: (.+)$/m.exec(b)?.[1] ?? 'message',
    data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? '{}') as Record<string, unknown>,
  }));

beforeEach(() => vi.clearAllMocks());

describe('标注路由', () => {
  it('status:报已标/总数 + 当前用的是哪个模型(回落时 source=main)', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });

    const res = await app.inject({ url: '/api/tags/status' });
    const body = res.json();
    expect(body.tagged).toBe(0);
    expect(body.total).toBe(1);
    // 打标模型没配 → 回落主模型,并且要告诉用户"你在用主模型"
    expect(body.model).toEqual({ provider: 'ollama', model: 'qwen3-4b', source: 'main' });
    await app.close();
  });

  it('run(scope=missing):只标没标注的;progress + done 帧', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ id: 'BV1', tags: ['教学'], kind: '教学' }, { id: 'BV2', tags: ['娱乐'], kind: '娱乐' }]),
    );

    const res = await app.inject({ method: 'POST', url: '/api/tags/run' });
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = sse(res.body);
    expect(events.find((e) => e.event === 'done')!.data.tagged).toBe(2);

    // 增量:再跑一次,没有未标注的 → done.tagged=0 且一次 LLM 都不调
    mocks.complete.mockClear();
    const res2 = await app.inject({ method: 'POST', url: '/api/tags/run' });
    expect(sse(res2.body).find((e) => e.event === 'done')!.data.tagged).toBe(0);
    expect(mocks.complete).not.toHaveBeenCalled();
    await app.close();
  });

  it('run(scope=all):已标注的也重标', async () => {
    const { app, db } = makeApp();
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    mocks.complete.mockResolvedValue(JSON.stringify([{ id: 'BV1', tags: ['教学'], kind: '教学' }]));
    await app.inject({ method: 'POST', url: '/api/tags/run' });

    mocks.complete.mockClear();
    mocks.complete.mockResolvedValue(JSON.stringify([{ id: 'BV1', tags: ['娱乐'], kind: '娱乐' }]));
    const res = await app.inject({ method: 'POST', url: '/api/tags/run?scope=all' });
    expect(sse(res.body).find((e) => e.event === 'done')!.data.tagged).toBe(1);
    const row = db.prepare(`SELECT ai_tags FROM items WHERE id='BV1'`).get() as { ai_tags: string };
    expect(JSON.parse(row.ai_tags).kind).toBe('娱乐');
    await app.close();
  });

  it('中止:inject signal → aborted 帧,已完成的落库不回滚', async () => {
    const { app, db } = makeApp();
    for (let i = 0; i < 40; i++) upsertItem(db, { id: `BV${i}`, type: 2, title: `题${i}` });
    const controller = new AbortController();
    mocks.complete.mockImplementation(async () => {
      controller.abort();
      return JSON.stringify([{ id: 'BV0', tags: ['教学'], kind: '教学' }]);
    });

    const res = await app.inject({ method: 'POST', url: '/api/tags/run', signal: controller.signal });
    expect(sse(res.body).some((e) => e.event === 'aborted')).toBe(true);
    const row = db.prepare(`SELECT ai_tags FROM items WHERE id='BV0'`).get() as { ai_tags: string } | undefined;
    expect(row?.ai_tags).toBeDefined(); // 已完成的批次保留
    await app.close();
  });

  it('没配任何模型 → 400(不是 SSE)', async () => {
    const { app, db } = makeApp();
    db.prepare(`DELETE FROM settings`).run();
    const res = await app.inject({ method: 'POST', url: '/api/tags/run' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/tagRoutes.test.ts`
Expected: FAIL —— 404(路由未注册)

- [ ] **Step 3: 实现**

`server/src/curator/tagRoutes.ts`(SSE 骨架照 tagRoutes 的兄弟 routes.ts 的 run-pass-2 —— **先校验后 hijack、`reply.raw.on('close')` + `writableEnded` 守卫、AbortError=warn**):

```ts
/** /api/tags/* —— 条目 AI 标注(spec §9E)。SSE/中止/进度模式照抄 §9D 的 run-pass-2。 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import { readLlmSettings } from '../llm/config.js';
import { listUntaggedItemIds, tagStats } from '../db/repo/tagging.js';
import type { ItemRow } from '../db/repo/items.js';
import { runTagging } from './tagger.js';

export interface TagDeps { db: Database.Database; log: Logger }

export function registerTagRoutes(app: FastifyInstance, deps: TagDeps): void {
  const { db, log } = deps;
  const allItems = () => db.prepare(`SELECT * FROM items`).all() as ItemRow[];

  app.get('/api/tags/status', async () => {
    const stats = tagStats(db);
    const tag = readLlmSettings(db, 'tag');
    const main = readLlmSettings(db);
    // **告诉用户当前会用哪个模型**:打标模型配了用它(source=tag),否则回落主模型
    const eff = tag ?? main;
    return {
      ...stats,
      model: eff
        ? { provider: eff.config.provider, model: eff.config.model, source: tag ? ('tag' as const) : ('main' as const) }
        : null,
    };
  });

  app.post('/api/tags/run', async (req, reply) => {
    const scope = (req.query as { scope?: string }).scope === 'all' ? 'all' : 'missing';
    const llm = readLlmSettings(db, 'tag');
    if (!llm) {
      return reply.code(400).send({ ok: false, reason: '还没配模型 —— 先去「授权」页配一个' });
    }

    const pool = allItems().filter((i) => scope === 'all' || listUntaggedItemIds(db).includes(i.id));

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });
    const finishAborted = () => {
      log.event({ level: 'warn', category: 'llm', code: 'TAGGING_ABORTED', message: '用户中止了标注 —— 已完成的条目已保留' });
      if (!reply.raw.writableEnded) reply.raw.write(`event: aborted\ndata: {"reason":"已中止"}\n\n`);
    };

    try {
      const r = await runTagging({
        config: llm.config,
        ctx: llm.ctx,
        items: pool,
        signal: controller.signal,
        db,
        onBatch: (b) => {
          reply.raw.write(`event: progress\ndata: ${JSON.stringify({ done: b.done, total: b.total, tagged: b.tagged })}\n\n`);
        },
      });
      if (controller.signal.aborted) return finishAborted();
      log.event({ level: 'info', category: 'llm', message: `标注完成:${r.tagged} 条,${r.failedBatches.length} 批失败` });
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ tagged: r.tagged, failedBatches: r.failedBatches })}\n\n`);
    } catch (e) {
      if (controller.signal.aborted) return finishAborted();
      const message = (e as Error)?.message ?? String(e);
      log.event({ level: 'error', category: 'llm', code: 'TAGGING_FAILED', message });
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ reason: message })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });
}
```

> **实现者注意**:上面 `pool` 的"增量"实现用 `listUntaggedItemIds(db).includes(i.id)` 是 **O(n²) 的偷懒写法**(3250 条会卡)—— 实现时改成:取 `allItems()` 一次,`const untagged = new Set(listUntaggedItemIds(db))`,然后 `filter((i) => scope === 'all' || untagged.has(i.id))`。这是审查会抓的性能点,别照抄示例。

`http/index.ts` 注册:

```ts
import { registerTagRoutes } from '../curator/tagRoutes.js';
// ... createServer 里:
  registerTagRoutes(app, { db, log });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/tagRoutes.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/tagRoutes.ts server/src/curator/tagRoutes.test.ts server/src/http/index.ts
git commit -m "feat(curator): 标注 SSE 路由 —— 增量/全量 + 进度 + 可中止

SSE/中止模式照 §9D(run-pass-2),含 writableEnded 守卫(那个 Critical 的教训)。
status 告诉用户当前生效的模型和来源(打标模型 or 回落主模型)。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 归类吃标签(renderItem + 提示词声明)

**Files:**
- Modify: `server/src/curator/classifier.ts:262-272`(`renderItem` 加标签行)、`PASS2_SYSTEM`(加"标签是参考"声明)
- Modify: `server/src/curator/routes.ts`(`run-pass-2` 组装 folders/items 时把标注读出来传进 renderItem —— **注意 renderItem 是模块私有,加一个可选参数比导出它更合适**)
- Test: `server/src/curator/classifier.test.ts`、`server/src/curator/routes.test.ts`

**Interfaces:**
- Consumes: T1 的 `getItemTagging`
- Produces:
  ```ts
  function renderItem(i: ItemRow, maxIntro = 120, tagging?: ItemTagging | null): string
  // 标注存在时多一行:  AI标签:tag1·tag2 [kind]
  // PASS2_SYSTEM 增加一句:AI标签是参考,原始标题/简介是事实;冲突时以原始数据为准(spec C6)
  ```
  `run-pass-2` 组装 `items` 时对每条 `getItemTagging` —— 有就传给 renderItem。**这是 N+1 查询**(3250 次 `SELECT ai_tags`)—— SQLite 本地内存级,单条 <0.1ms,可接受;不优化,除非实测卡(§9E.4)。

- [ ] **Step 1: 写失败的测试**

`classifier.test.ts` 追加(在 Pass 2 prompt 的 describe 里):

```ts
  it('renderItem:有标注的条目带 AI标签行', () => {
    const { renderItemInternal } = {} as never; // 占位 —— renderItem 是私有的,见下
  });
```

> **实现者注意**:renderItem 是模块私有的,**不要为了测试导出它** —— 那是给测试开洞。测**通过 buildPass2Prompt 的可见行为**:构造一个带 `ai_tags` 的 ItemRow,断言 prompt 里有 `AI标签:` 行;构造一个没有的,断言没有。ItemRow 直接带 `ai_tags: '{"tags":["教学"],"kind":"教学"}'` 字段(classifier 的输入本来就吃 ItemRow)。更简单:**测试直接给 ItemRow.ai_tags 塞值,断言 buildPass2Prompt 输出**。

```ts
  // spec §9E C5:标注作为补充信号进入归类 prompt —— 有才写,没有不占行
  it('带 AI 标注的条目在 prompt 里多一行 AI标签', () => {
    const tagged = item('BV1', 'AI 动画教程', { ai_tags: '{"tags":["Stable Diffusion","AI动画"],"kind":"教学"}' });
    const p = buildPass2Prompt({ folders: [folder('42', 'AI/动画')], items: [tagged] });
    expect(p).toContain('AI标签:Stable Diffusion·AI动画 [教学]');
  });

  it('没有标注的条目不留空行(和今天完全一样)', () => {
    const untagged = item('BV2', '普通条目');
    const p = buildPass2Prompt({ folders: [folder('42', 'AI/动画')], items: [untagged] });
    expect(p).not.toContain('AI标签');
  });

  // spec §9E C6:标签是参考,原始数据是事实 —— 提示词是这条链的防线,钉住这句
  it('PASS2_SYSTEM 声明「标签是参考,原始数据为准」', () => {
    expect(PASS2_SYSTEM).toContain('标签是参考');
    expect(PASS2_SYSTEM).toContain('原始');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/classifier.test.ts`
Expected: FAIL —— prompt 里没有 `AI标签` 行;SYSTEM 没有"标签是参考"

- [ ] **Step 3: 实现**

`classifier.ts`:

1. `renderItem` 加第三参(内部签名,不导出):

```ts
function renderItem(i: ItemRow, maxIntro = 120): string {
  const lines = [`[${i.id}] ${i.title}`];
  if (i.intro) {
    const intro = i.intro.length > maxIntro ? `${i.intro.slice(0, maxIntro)}…` : i.intro;
    lines.push(`  简介:${intro}`);
  }
  if (i.upper_name) lines.push(`  UP:${i.upper_name}`);
  if (i.duration) lines.push(`  时长:${Math.round(i.duration / 60)} 分钟`);
  // §9E C5:标注作为**补充信号**进入 prompt —— 有才写;原始数据仍在场,标签错了有兜底
  const tagging = parseItemTagging(i.ai_tags);
  if (tagging && (tagging.tags.length > 0 || tagging.kind)) {
    const kind = tagging.kind && tagging.kind !== '其它' ? ` [${tagging.kind}]` : '';
    lines.push(`  AI标签:${tagging.tags.join('·')}${kind}`);
  }
  return lines.join('\n');
}
```

`parseItemTagging` 是 T1 `parse` 逻辑的复刻(它私有;**把 T1 的 parse 改成导出、这里 import** 更好 —— `export function parseItemTagging` from tagging.ts,删掉本地复刻。**选这个**)。

2. `PASS2_SYSTEM` 加一句(加在"输出规则"之前):

```
条目里的「AI标签」行是另一轮 AI 的判断,仅作参考:原始标题和简介才是事实,
冲突时以原始数据为准。标签可以帮你快速理解条目,但不要盲信。
```

3. **`run-pass-2` 不需要改**:`renderItem` 直接读 `i.ai_tags`(ItemRow 本来就带这列,`SELECT * FROM items` 天然带出)—— 无 N+1,天然增量。**这是比"传 tagging 参数"更省的落点**,计划之前的设想(加参数 + N+1)作废。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/classifier.test.ts src/curator/routes.test.ts`
Expected: PASS

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/classifier.ts server/src/curator/classifier.test.ts
git commit -m "feat(curator): 归类 prompt 带上 AI 标签 —— 补充信号,原始数据为准

renderItem 直接读 ItemRow.ai_tags(SELECT * 天然带出,无 N+1);
PASS2_SYSTEM 钉住「标签是参考,原始数据为准」(§9E C6)。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 前端 —— api + 状态类型

**Files:**
- Modify: `web/src/types.ts`、`web/src/api.ts`
- Test: 无(前端无测试框架;typecheck + build)

**Interfaces:**
- Consumes: T3 的路由形状
- Produces:
  ```ts
  // types.ts
  export interface TagRunStatus { tagged: number; total: number; model: { provider: string; model: string; source: 'tag' | 'main' } | null }
  export interface TagProgressPayload { done: number; total: number; tagged: number }
  // api.ts
  export const tagApi = {
    status: () => api<TagRunStatus>('/api/tags/status'),
    run: (scope: 'missing' | 'all', onProgress: (p: TagProgressPayload) => void, opts: { signal?: AbortSignal } = {}) =>
      /* SSE,progress 帧 → onProgress;done 帧返回 {tagged, failedBatches};aborted → DOMException('已中止','AbortError') */
  }
  ```
  `run` 的实现**照抄 `classifyStream`**(buffer split / failure 累积 / aborted → AbortError)。

- [ ] **Step 1: types.ts 追加两个接口;api.ts 追加 `tagApi`(实现照 classifyStream 的骨架,解析 progress/done/aborted/error 帧)**
- [ ] **Step 2: `cd web && npm run typecheck && npx max build` — 都过**
- [ ] **Step 3: 提交**

```bash
git add web/src/types.ts web/src/api.ts
git commit -m "feat(web): tagApi —— 标注状态查询 + SSE 进度消费(照 classifyStream 的骨架)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 规则页的标注入口 + 进度 + 状态

**Files:**
- Modify: `web/src/components/RulesPanel.tsx`

**Interfaces:**
- Consumes: T5 的 `tagApi`;`useAssistant` 不涉及(标注不打断聊天)
- Produces: 无新导出

**UI 形状(spec §9E C8):放在规则页顶部、试跑按钮旁边 —— 它服务于归类质量,和规则/试跑是同一件事的三面:**

```
[＋ 新增规则] [🤖 让 AI 看看规则] [⚡ 试跑:规则 vs AI] [🏷 AI 标注]
                                   ↓ 运行中
   标注中:已标 1,365 / 3,250 条(用 本地/qwen3-4b)   [■ 停止]
   完成后:已标注 3,250 / 3,250 条 · 本轮 2 批失败(未标注的会再试)
```

- 状态行常显:`已标注 X / Y 条`(打开页面时 `tagApi.status()` 取一次;标注结束后刷新)
- 「AI 标注」按钮两态(§9D B1 模式):空闲 = 开始(增量),进行中 = ■ 停止(abort)
- 进度行照 §9D.2:`已标 1,365 / 3,250 条`(num 等宽)
- **模型提示**:状态里 `model.source === 'main'` 时提示一句「当前用主模型打标 —— 想省成本可在授权页配本地小模型」;`source === 'tag'` 显示「用 本地/qwen3-4b」
- 「重新标注全部」:按钮旁一个小字链接(或下拉),点击弹 confirm(覆盖旧标注)后 `run('all', ...)`
- 中断/完成文案照 §9D B4 模式(warn 色,不用 error 条)

- [ ] **Step 1: 实现(状态 `tagging` / `tagProgress` / `tagStatus`,独立于已有的 sending/classifying —— §9D.5 的教训,不共用 busy)**
- [ ] **Step 2: `cd web && npm run typecheck && npx max build` — 都过**
- [ ] **Step 3: 手动验收清单(交付时跑)**
  1. 配好打标模型(本地 4b)后点「AI 标注」→ 进度行跳动 → 完成后状态行更新为全量
  2. 中途停止 → warn 提示,状态行显示已完成数;再点 → 从断点继续(ai_checked_at 增量)
  3. 「重新标注全部」→ confirm → 覆盖旧标签
  4. 然后跑一次归类:抽查归类理由,确认标签进了 prompt(理由里会引用标签词)
- [ ] **Step 4: 提交**

```bash
git add web/src/components/RulesPanel.tsx
git commit -m "feat(web): 规则页的标注入口 —— 增量/全量 + 进度 + 可中止(§9E C8)

标注服务于归类质量,和规则/试跑放一起;状态独立(§9D.5 的教训:不共用 busy)。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review

### 1. Spec 覆盖(§9E 逐条)

| §9E | 落在哪 |
|---|---|
| C1 写现成列、零迁移 | T1(专用写库;不碰 upsertItem) |
| C2 用途模型 + 回落 | T3(`readLlmSettings(db, 'tag')`)+ status 的 `source` 字段 |
| C3 kind 受控枚举 | T2(`TAG_KINDS` + coerce 越界→其它)+ 测试 |
| C4 逐条覆盖断言 | T2(缺的补 2 轮,仍缺记 failedBatch)+ 3 条测试 |
| C5 renderItem 加标签行(有不占行) | T4 + 2 条测试 |
| C6 标签是参考声明 | T4(`PASS2_SYSTEM`)+ 钉住测试 |
| C7 增量/全量重跑 | T1(`listUntaggedItemIds`)+ T3(scope)+ T6(重新标注全部) |
| C8 入口在规则页 + §9D 进度模式 | T6 + T3(SSE 照抄) |
| §9E.4 标签无自证 → 补充信号 | T4 的 C6 声明(结构性防盲信) |
| §9E.5 不做:规则第四字段 / B站标签 / 截断放开 / 评估 UI | 无任务做它们 ✓ |

### 2. Placeholder 扫描

T2 Step 1 的测试里有一段 `item()` helper 的注释说"不优雅但…照 classifier.test.ts 的 item() 抄形状" —— **这是给实现者的指令**,不是占位:要求抄 classifier.test.ts 的既有 helper(15 个字段的 ItemRow 构造),别发明新的。T4 Step 1 有一段显式标了"占位"的测试代码,**紧跟**着给了"实现者注意"要求删掉它、改为测 buildPass2Prompt 的可见行为 —— 实现者只抄后面的正确版本。其余无 TBD。

### 3. 类型一致性

- `TagBatchProgress`(T2 引擎)与 progress 帧(T3 发 `{done,total,tagged}`)—— 帧比引擎少 `failedBatches`(路由在 done 帧才发全部),T5 的 `TagProgressPayload` 与帧一致(3 字段)✓
- `ItemTagging`(T1)与 T4 `parseItemTagging` 的返回 —— **同一个函数**(T1 导出,T4 import),不是两个副本 ✓
- `runTagging` 的 opts 带 `db`(落库就在引擎里,不回传数据给路由再落)—— 与 §9D 的 runPass2(路由落库)不同,刻意的:标注的"逐批落库"就是 T1 的 setItemTagging 逐条写,没有"攒 collected"的概念 ✓
- `run(scope)` 的两个值在 T3(路由解析)、T5(`tagApi.run`)、T6(UI)三处一致 ✓

### 4. 与计划早期草稿的差异(已改)

- T4 早期设想"renderItem 加第三参 + 路由 N+1 传标注" → **作废**:renderItem 直接读 `i.ai_tags`(SELECT * 天然带出),零额外查询、零签名变更。计划正文已按此写。
- T1 早期设想"parse 保持私有 + T4 复刻" → **改为 T1 导出 parseItemTagging,T4 import** —— 两份解析逻辑迟早分叉。
