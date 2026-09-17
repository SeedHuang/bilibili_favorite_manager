import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import type { ModelMeta } from '../llm/registry.js';
import type { ItemRow } from '../db/repo/items.js';
import { upsertItem } from '../db/repo/items.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

const { runTagging, TAG_KINDS } = await import('./tagger.js');

const ctx: ModelMeta = {
  provider: 'ollama', model: 'qwen3-4b-instruct-2507:latest',
  contextWindow: 262_144, maxOutput: 8_192, verified: true,
};
const config = { id: '本地', provider: 'ollama', baseUrl: '', apiKey: '', model: 'qwen3-4b' };

const item = (id: string, title: string): ItemRow => ({
  id, type: 2, title, intro: null, cover: null, upper_mid: null, upper_name: null,
  duration: null, pubtime: null, invalid: 0, invalid_checked_at: null,
  ai_tags: null, ai_summary: null, ai_checked_at: null, raw: null,
});

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

  // 上面那条(mock 在**单次调用内**中止)走不到收尾那步 —— 中止会让补轮循环
  // break 时带着还没标上的条目(pending)落到收尾,那里的守卫是
  // `pending.size > 0 && !opts.signal?.aborted`(§9D B5:用户点停止不是"数据坏了")。
  // 20 条 / 批上限 16 → **两批**,第二批途中中止 → pending 非空 →
  // **删掉那个守卫这条会红**(会多记一笔"模型两轮没覆盖")
  it('批间中止 → failedBatches 保持空(用户停止不记成失败账)', async () => {
    const db = openDb(':memory:');
    const items = Array.from({ length: 20 }, (_, i) => item(`BV${i}`, `题${i}`));
    for (const it of items) upsertItem(db, { id: it.id, type: 2, title: it.title });
    const controller = new AbortController();
    let calls = 0;
    mocks.complete.mockImplementation(async ({ messages }: { messages: { content: string }[] }) => {
      calls += 1;
      if (calls >= 2) {
        controller.abort(); // 第二批生成中途被停(照 tagRoutes.test 的中止用例)
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      // 第一批照常全标上:照 prompt 里抠出来的 id 原样回
      const ids = [...messages[1]!.content.matchAll(/\[(BV\d+)\]/g)].map((m) => m[1]!);
      return JSON.stringify(ids.map((id) => ({ id, tags: ['教学'], kind: '教学' })));
    });

    const r = await runTagging({ config, ctx, items, signal: controller.signal, db });

    expect(calls).toBe(2); // 真的两批:第一批 16 条,第二批撞上中止
    expect(r.tagged).toBe(16);
    expect(r.failedBatches).toEqual([]); // ← 去掉守卫这里是 1 笔"没覆盖"的账
    // 中止前标上的那批**留在库里** —— 中止不回滚已完成的批次
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE ai_tags IS NOT NULL`).get() as { n: number }).n;
    expect(n).toBe(16);
  });
});
