import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { addAlias, ensureTag, listTagTree, normalizeTagName, findTag } from '../db/repo/tags.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

const { coerceVerdicts, runTagCheck } = await import('./tagcheck.js');
const config = { id: 'flash', provider: 'deepseek', baseUrl: '', apiKey: 'k', model: 'deepseek-flash' };

beforeEach(() => vi.clearAllMocks());

describe('coerceVerdicts', () => {
  it('drop 原样留着(它不需要 target);merge/move 的目标必须存在,否则退回 keep', () => {
    const got = coerceVerdicts(
      JSON.stringify([
        { name: 'AI', action: 'drop' },                              // 泛词:留着,别被降级
        { name: '鲁夫', action: 'merge', target: '路飞' },            // 目标合法 → 保留
        { name: '鲁夫', action: 'merge', target: '不存在的词' },       // 目标编的 → keep
        { name: 'x', action: '乱写' },                                // action 越界 → keep
      ]),
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
    const got = coerceVerdicts(
      JSON.stringify([{ name: '美职篮', action: 'merge', target: 'nba' }]),
      new Set(['NBA']),
    );
    expect(got).toEqual([{ name: '美职篮', action: 'merge', target: 'NBA' }]);
  });

  it('move 没有目标 → keep(别把"没听懂"当"该删")', () => {
    const got = coerceVerdicts(JSON.stringify([{ name: '露营', action: 'move' }]), new Set(['户外']));
    expect(got).toEqual([{ name: '露营', action: 'keep' }]);
  });
});

describe('runTagCheck', () => {
  it('drop 的词从词库里删掉 —— 子节点提一级,不铲整棵', async () => {
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

  it('move 真的换了父;三个计数器各归各位', async () => {
    const db = openDb(':memory:');
    const outdoors = ensureTag(db, '户外', null);
    ensureTag(db, '露营', null);
    const keep = ensureTag(db, '路飞', null);
    ensureTag(db, '鲁夫', null);
    ensureTag(db, 'AI', null);
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { name: 'AI', action: 'drop' },
        { name: '鲁夫', action: 'merge', target: '路飞' },
        { name: '露营', action: 'move', target: '户外' },
      ]),
    );
    const r = await runTagCheck({
      config, tree: listTagTree(db), newNames: ['AI', '鲁夫', '露营'], db,
    });
    expect(r).toEqual({ dropped: 1, merged: 1, moved: 1 });
    // 计数器动了 **而且库里真的换了父** —— 只动计数器、不落库的话这条会挂
    const camp = findTag(db, normalizeTagName('露营'));
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(camp)).toEqual({
      parent_id: outdoors,
    });
    expect(findTag(db, normalizeTagName('鲁夫'))).toBe(keep);
    expect(findTag(db, normalizeTagName('AI'))).toBeNull();
  });

  it('别名说 drop 不动底下的活词(顺着别名表删就成了误删)', async () => {
    const db = openDb(':memory:');
    const keep = ensureTag(db, '路飞', null);
    addAlias(db, '鲁夫', keep); // 鲁夫 = 路飞 的旧写法,只在别名表里
    mocks.complete.mockResolvedValue(JSON.stringify([{ name: '鲁夫', action: 'drop' }]));
    const r = await runTagCheck({ config, tree: listTagTree(db), newNames: ['鲁夫'], db });
    expect(r.dropped).toBe(0);
    expect(findTag(db, normalizeTagName('路飞'))).toBe(keep);
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
