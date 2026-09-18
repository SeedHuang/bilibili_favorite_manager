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

  it('同一轮里已经合并掉的词,不能再参与后面的对', () => {
    const db = openDb(':memory:');
    const jia = ensureTag(db, '甲', null);
    const yi = ensureTag(db, '乙', null);
    const bing = ensureTag(db, '丙', yi);  // 丙 本来挂在 乙 下
    seed(db, 10, [jia, yi, bing]);         // 三个词挂的完全是同一批视频

    // 配对顺序 (甲,乙) → (甲,丙) → (乙,丙)。第一对把 乙 并进 甲(丙 的父
    // 在库里变成 甲)。第三对里 乙 **已经不存在了** —— 而 isDescendant 查库,
    // 查一个不在 tags 里的 id 恒为 false,闸门拦不住。不跳过已删的词,丙 就会
    // 被"并进"一个死 id:item_tags 的 FK 挡住 → 抛错 → 这一轮半途而废
    // (前面那对已经各自提交了)。查一遍 tree 也要崩。
    const changes = reconcile(db);
    expect(changes).toHaveLength(1);                       // 只该有 (甲,乙) 那一笔
    expect(changes[0]).toMatchObject({ kind: 'merge', to: '甲' });
    // 丙 还在,且父亲已经从 乙 变成 甲
    expect(listTagTree(db).map((n) => [n.name, n.children.map((c) => c.name)]))
      .toEqual([['甲', ['丙']]]);
  });

  it('同轮被跳过的同义词不被挂父嵌套 —— 下一轮自愈', () => {
    const db = openDb(':memory:');
    const jia = ensureTag(db, '甲', null);
    const yi = ensureTag(db, '乙', null);
    const bing = ensureTag(db, '丙', null);
    seed(db, 10, [jia, yi, bing]);   // 三个都在根上,挂完全同一批视频

    // ① 第一轮:乙 并进 甲。剩下的 (甲,丙) 因为 `gone` 被跳过(甲 刚并进过东西,
    //    `cov` 已过期)。它们**双向 100%** —— 判据的结论是"合并",所以挂父段
    //    不该把它们嵌套起来:一旦成了父子,`isDescendant` 会把这一对**永久**
    //    排除在合并之外,两个同义词就永远并不到一起了。
    const first = reconcile(db);
    expect(first.map((c) => c.kind)).toEqual(['merge']);
    for (const id of [jia, bing]) {
      expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(id)).toEqual({ parent_id: null });
    }
    expect(db.prepare(`SELECT COUNT(*) n FROM tags`).get()).toEqual({ n: 2 });

    // ② 第二轮:数据刷新,(甲,丙) 正常合并 → 收敛成一个。
    //    **这条才是重点** —— 它区分"自愈"和"永久嵌套成 丙>甲"。
    const second = reconcile(db);
    expect(second.map((c) => c.kind)).toEqual(['merge']);
    expect(db.prepare(`SELECT name FROM tags`).all()).toEqual([{ name: '甲' }]);
  });
});
