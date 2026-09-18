import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
import { ensureTag, linkItemTag, listTagTree } from '../db/repo/tags.js';
import { reconcile, coverageMap } from './tagtree.js';

/**
 * 建 n 条视频,每条挂 tagIds 里的全部标签。
 *
 * `from` 是编号起点 —— 用不同的起点把几批视频**分开**,这样"重叠多少"
 * 完全由测试说了算。
 */
function seed(db: ReturnType<typeof openDb>, n: number, tagIds: number[], from = 0) {
  for (let i = from; i < from + n; i++) {
    const id = `BV${i}`;
    upsertItem(db, { id, type: 2, title: id });
    for (const t of tagIds) linkItemTag(db, id, t, 'ai');
  }
}

describe('coverageMap', () => {
  it('一次算完两个方向', () => {
    const sets = new Map<number, ReadonlySet<string>>([
      [1, new Set(['a', 'b', 'c', 'd'])],
      [2, new Set(['a', 'b'])],
    ]);
    const m = coverageMap(sets);
    expect(m.get('1,2')).toBe(0.5); // |1∩2| / |1| = 2/4
    expect(m.get('2,1')).toBe(1);   // |2∩1| / |2| = 2/2
  });

  it('零交集的对不存 —— 缺席即 0', () => {
    const sets = new Map<number, ReadonlySet<string>>([
      [1, new Set(['a'])],
      [2, new Set(['b'])],
    ]);
    expect(coverageMap(sets).size).toBe(0);
  });
});

describe('reconcile', () => {
  it('A 挂的几乎全在 B 里 → A 挂到 B 下', () => {
    const db = openDb(':memory:');
    const food = ensureTag(db, '美食', null);
    const roast = ensureTag(db, '烤羊肉', null);
    // 美食 58 条(40 条只挂美食 + 18 条同时挂两个),烤羊肉 18 条
    // → cover(烤羊肉→美食)=18/18=1.0,cover(美食→烤羊肉)=18/58≈0.31
    //   单向高 → 挂父,不是合并(双向都高才是合并)
    seed(db, 40, [food]);
    seed(db, 18, [food, roast], 40);
    const changes = reconcile(db);
    expect(changes.some((c) => c.kind === 'reparent')).toBe(true);
    expect(changes.some((c) => c.kind === 'merge')).toBe(false);
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(roast)).toEqual({ parent_id: food });
  });

  it('双向都 ≥90% → 合并,保留挂得多的那个', () => {
    const db = openDb(':memory:');
    const a = ensureTag(db, '路飞', null);
    const b = ensureTag(db, '鲁夫', null);
    seed(db, 10, [a, b]);            // 10 条同时挂两个
    seed(db, 1, [a], 100);           // 只有 a 多一条 → |a|=11 |b|=10
    // cover(a→b)=10/11=0.909 ≥0.9,cover(b→a)=10/10=1.0 → 合并
    const changes = reconcile(db);
    expect(changes.some((c) => c.kind === 'merge')).toBe(true);
    expect(db.prepare(`SELECT name FROM tags`).all()).toEqual([{ name: '路飞' }]); // 挂得多的留下
  });

  it('各挂各的 → 平级,什么都不做(露营 vs 美食)', () => {
    const db = openDb(':memory:');
    const food = ensureTag(db, '美食', null);
    const camp = ensureTag(db, '露营', null);
    seed(db, 30, [food]);
    seed(db, 5, [camp], 100);
    seed(db, 2, [food, camp], 200);  // 只有 2 条同时挂两个
    // cover(露营→美食)=2/7=0.29,cover(美食→露营)=2/32=0.06 → 两边都低
    expect(reconcile(db)).toEqual([]);
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(camp)).toEqual({ parent_id: null });
  });

  it('样本 <5 条不判(统计下限)', () => {
    const db = openDb(':memory:');
    const a = ensureTag(db, '小词', null);
    const b = ensureTag(db, '大词', null);
    seed(db, 50, [b]);
    seed(db, 3, [a, b], 100);        // 覆盖率 100% 但只有 3 条
    expect(reconcile(db)).toEqual([]);
  });

  it('已经是父子的一对不合并 —— 否则会把树压塌', () => {
    const db = openDb(':memory:');
    const parent = ensureTag(db, '体育', null);
    const child = ensureTag(db, '篮球', parent);  // 树里**已经**是父子
    seed(db, 10, [parent, child]);                // 篮球的视频全都挂着体育
    // 双向都 100%,但树里已经表达过这个包含关系了 —— 合并就等于把篮球删掉
    expect(reconcile(db)).toEqual([]);
    expect(listTagTree(db)[0]!.children.map((n) => n.name)).toEqual(['篮球']);
  });
});
