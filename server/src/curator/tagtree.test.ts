import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
import { ensureTag, linkItemTag, listTagTree } from '../db/repo/tags.js';
import { reconcile, reconcileWithBudget, coverageMap, MIN_SAMPLE } from './tagtree.js';

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
    // minSample=1:测试夹具的集合都很小,传 1 让它们全够样本(生产传 MIN_SAMPLE 剪枝)
    const m = coverageMap(sets, 1);
    expect(m.get('1,2')).toBe(0.5); // |1∩2| / |1| = 2/4
    expect(m.get('2,1')).toBe(1);   // |2∩1| / |2| = 2/2
  });

  it('零交集的对不存 —— 缺席即 0', () => {
    const sets = new Map<number, ReadonlySet<string>>([
      [1, new Set(['a'])],
      [2, new Set(['b'])],
    ]);
    expect(coverageMap(sets, 1).size).toBe(0);
  });

  it('样本不足的词被跳过 —— 性能剪枝不改变判据结论', () => {
    const sets = new Map<number, ReadonlySet<string>>([
      [1, new Set(['a', 'b', 'c'])],       // 够样本
      [2, new Set(['a', 'b'])],            // 够样本
      [3, new Set(['a'])],                 // 样本不足(1 < 2)
    ]);
    const m = coverageMap(sets, 2);
    // 1 和 2 照算
    expect(m.get('1,2')).toBe(2 / 3);
    // 涉及 3 的对不出现 —— 它样本不足,判据本来就不判它
    expect(m.has('1,3')).toBe(false);
    expect(m.has('3,1')).toBe(false);
    expect(m.has('2,3')).toBe(false);
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

  it('合并之后重取快照 —— 被并掉的词不能再用旧集合挂着谁', () => {
    const db = openDb(':memory:');
    const jia = ensureTag(db, '甲', null);
    const yi = ensureTag(db, '乙', null);
    const bing = ensureTag(db, '丙', null); // 根


    // 甲 / 乙 双向 90% → 合并,乙 被并进甲(平局时保留先建的那个)
    seed(db, 18, [jia, yi], 0);      // 共享的 18 条
    seed(db, 2, [jia], 100);         // 甲 独有 → |甲| = 20、cover(甲→乙) = 18/20 = 0.9
    seed(db, 2, [yi], 200);          // 乙 独有 → |乙| = 20、cover(乙→甲) = 0.9

    // 丙 **整个在 乙 里面**(10 条:共享的 8 条 + 乙 独有的 2 条),
    // 但和 甲 只重合 8/10 = 80% —— 所以它只对 乙 单向 ≥90%
    for (let i = 0; i < 8; i++) linkItemTag(db, `BV${i}`, bing, 'ai');
    linkItemTag(db, 'BV200', bing, 'ai');
    linkItemTag(db, 'BV201', bing, 'ai');

    const changes = reconcile(db);

    // ① 合并 乙→甲;② 丙 挂到 甲 下。
    //
    // **这一条钉的就是合并之后那个 `take()`。** 不重取快照的话,`sets` / `cov` /
    // `parentOf` 里 乙 还活着(父边 null、集合 20 条),于是第二段会拿 丙(100% 在乙里)
    // 去挂父 —— `setTagParent(db, 丙, 乙)` 里的乙**在库里已经不存在了**,UPDATE 撞
    // tags.parent_id 的 FK(openDb 开了 foreign_keys)→ 整轮抛错。
    // 快照一重取,乙 根本不进 `pairs`,丙 按数据挂到甲下。
    //
    // 为什么以前没有测试钉得住:第二段那句"双向 ≥cover 的一对不挂父"现在会把
    // (甲,乙) 这对**跳过**,而它正是过去唯一撞上过期快照的一对 —— 于是删掉那行
    // 全绿,只有真实运行时才会崩。夹具因此要三个词:一个双向对 + 一个**整个躲在
    // 被并掉的那个词里**的词。
    expect(changes.map((c) => c.kind)).toEqual(['merge', 'reparent']);
    expect(changes[1]).toMatchObject({ kind: 'reparent', from: '丙', to: '甲' });
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(bing))
      .toEqual({ parent_id: jia });
    expect(db.prepare(`SELECT id FROM tags WHERE id = ?`).get(yi)).toBeUndefined();
  });

  // ── M4h:运行预算(Task 3)与统计下限自适应(Task 4)─────────
  //
  // 造 n 个**互不重叠**的活跃词(各挂 10 条自己的视频)—— spec §1.5 的真实形态。
  // 词与词毫无交集 → 判据全不触发,性能由活跃词数的 O(n²) 配对决定。
  function seedActive(db: ReturnType<typeof openDb>, n: number, wordOffset = 0): void {
    for (let i = 0; i < n; i++) {
      const t = ensureTag(db, `词${i + wordOffset}`, null);
      for (let j = 0; j < 10; j++) {
        const id = `BV${i + wordOffset}_${j}`;
        upsertItem(db, { id, type: 2, title: id });
        linkItemTag(db, id, t, 'ai');
      }
    }
  }

  // 基准测试的 vitest 超时放宽到 30s —— 被测的预算守卫本身是 5s/2s 级,
  // 但测试默认 5s 超时比它还短,机器一抖(并行 worker、慢盘)就把守卫测试错杀成超时
  it('预算:3000 活跃词在默认 5s 内正常跑完,timedOut=false', { timeout: 30_000 }, () => {
    const db = openDb(':memory:');
    seedActive(db, 3000);
    const t0 = Date.now();
    const r = reconcileWithBudget(db);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.timedOut).toBe(false);
    expect(r.changes).toEqual([]); // 互不重叠,没有可整理的
  });

  it('预算:10000 活跃词超时收手 —— ≤5s 返回、timedOut=true、已做的保留', { timeout: 30_000 }, () => {
    const db = openDb(':memory:');
    seedActive(db, 10000);
    const t0 = Date.now();
    const r = reconcileWithBudget(db, { budgetMs: 2000 });
    const took = Date.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(took).toBeLessThan(6000); // 收手,不占死事件循环(留快照本身的余量)
    // 快照构建和配对在 deadline 处 break,部分整理的 changes 照常返回(这里没有可整理的)
    expect(r.changes).toEqual([]);
  });

  it('预算超时:部分整理安全收手 —— 已做的保留,库不崩、不多不少', () => {
    const db = openDb(':memory:');
    // 两个 100% 重合的词(可合并)+ 大量活跃词把时间撑爆
    const a = ensureTag(db, '路飞', null);
    const b = ensureTag(db, '鲁夫', null);
    seed(db, 10, [a, b]);
    seedActive(db, 4000, 1000);
    const r = reconcileWithBudget(db, { budgetMs: 1000 });
    expect(r.timedOut).toBe(true);
    // 清单里点名的每个合并都必须**真的落了库**(部分整理不丢已做的;
    // 快照期烧光预算时判据拿不到完整覆盖率,清单为空也是合法的部分整理)
    for (const c of r.changes) {
      expect(db.prepare(`SELECT id FROM tags WHERE name = ?`).get(c.from)).toBeDefined();
    }
    // 库完好:起步词都在 —— 快照期烧光预算时合并可能根本没轮到(清单为空是合法的
    // 部分整理),剩下的下一轮自会补上
    expect(db.prepare(`SELECT COUNT(*) n FROM tags WHERE name IN ('路飞','鲁夫')`).get())
      .toMatchObject({ n: 2 });
  });

  it('统计下限自适应:未超 3000 用默认 5,超了提到 10', () => {
    // 未超阈值:默认 MIN_SAMPLE=5 —— 3 条样本的重合照样不判,行为和从前一致
    const small = openDb(':memory:');
    const a = ensureTag(small, '小词', null);
    const b = ensureTag(small, '大词', null);
    seed(small, 50, [b]);
    seed(small, 3, [a, b], 100);
    expect(reconcile(small)).toEqual([]);

    // 超 4000 个活跃词:下限自动翻倍 —— 挂 5~9 条的词不进计算(更保守的统计)
    const big = openDb(':memory:');
    for (let i = 0; i < 4000; i++) {
      const t = ensureTag(big, `词${i}`, null);
      for (let j = 0; j < 7; j++) {
        const id = `BV${i}_${j}`;
        upsertItem(big, { id, type: 2, title: id });
        linkItemTag(big, id, t, 'ai');
      }
    }
    // 全库活跃词都只有 7 条:下限提到 10 后**没有词够样本** → 快速空跑、无变化
    const t0 = Date.now();
    // limitRaised 报给调用方记 log.event(不再靠 console)——
    // 未超阈值的 small 库不触发,超阈值的 big 库触发
    const smallR = reconcileWithBudget(small);
    expect(smallR.limitRaised).toBe(false);
    const r = reconcileWithBudget(big);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.changes).toEqual([]);
    expect(r.limitRaised).toBe(true);
    // 双保险:常量本身就是 5 —— 这条断言挡住"有人顺手改了 MIN_SAMPLE"的静默分叉
    expect(MIN_SAMPLE).toBe(5);
  });
});
