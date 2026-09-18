/**
 * 词与词的关系 —— **可算的判据,不是拍的阈值**(spec §9F C9)。
 *
 * 一个词在你收藏里的真实含义,写在"它挂了哪些视频"里。所以判据是集合关系:
 *
 *   A 挂的几乎全在 B 里(≥90%) → A 是 B 的子
 *   A 和 B 几乎重合(双向都 ≥90%) → 同一个东西 → 合并
 *   各挂各的 → 平级
 *
 * **为什么不是阈值晋升**(早期版本想用"子词数 ≥3 且覆盖 ≥20 条"):那两个数
 * 没有任何依据,是拍出来的;更糟的是它会和质检打架 —— 质检判"露营是根",计数判
 * "它只有 3 条视频、降级",一个建一个拆,结构来回晃。降级还是破坏性的。
 *
 * 唯一剩下的两个数都是**可解释判据的临界值**,不是魔法数:覆盖面 0.9
 * (调高 → 层级更浅、更多平级;调低 → 更多嵌套)和统计下限 5 条
 * (少于它,重合率没有统计意义 —— "两个词各挂 1 条、恰好是同一条"说明不了任何事)。
 */
import type Database from 'better-sqlite3';
import {
  isDescendant, listTagsWithParent, mergeTags, setTagParent, tagSets, type TagRow,
} from '../db/repo/tags.js';

export interface TreeChange {
  kind: 'merge' | 'reparent';
  from: string;
  to: string;
  detail: string;
}

/** `${a},${b}` → |A∩B| / |A|。缺席即 0 */
type RatioMap = Map<string, number>;
const k = (a: number, b: number) => `${a},${b}`;

/**
 * 一次算完全部有向覆盖率。
 *
 * **必须一次算完。** 在循环里为每一对现算,等于把 O(n²) 的活做成 O(n⁴)
 * —— 初稿就这么写的(还在循环里临时构造一个 2 项 Map 再调一次自己)。
 *
 * **只存非 0 的**:两个词的视频集毫无交集时覆盖率必然是 0,存它只是占内存。
 * 查的时候 `?? 0`。
 */
export function coverageMap(sets: ReadonlyMap<number, ReadonlySet<string>>): RatioMap {
  const ids = [...sets.keys()].sort((x, y) => x - y);
  const out: RatioMap = new Map();
  for (const a of ids) {
    const A = sets.get(a)!;
    if (A.size === 0) continue;
    for (const b of ids) {
      if (a === b) continue;
      const B = sets.get(b)!;
      if (B.size === 0) continue;
      let hit = 0;
      for (const x of A) if (B.has(x)) hit++;
      if (hit > 0) out.set(k(a, b), hit / A.size);
    }
  }
  return out;
}

/** 无序对,每对只出一次 —— 双向判断在循环里自己做(查 `k(a,b)` 和 `k(b,a)`) */
function pairs(sets: ReadonlyMap<number, ReadonlySet<string>>): [number, number][] {
  const ids = [...sets.keys()].sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) out.push([ids[i]!, ids[j]!]);
  return out;
}

/**
 * 按数据核对整棵树,返回**变化清单**并落到结构上。
 *
 * 顺序不能反:**先合并,再挂父**。反过来的话,判据看到"90% 的漫剧视频也挂了 AI"
 * 就会把漫剧挂到 AI 底下 —— 它自己把证据吃掉了,然后 AI 就永远洗不白了。
 *
 * 每轮跑完调一次(§9F C10 的"自动整理"),不设人工审批闸。
 */
export function reconcile(
  db: Database.Database,
  opts: { minSample?: number; cover?: number } = {},
): TreeChange[] {
  const minSample = opts.minSample ?? 5;
  const cover = opts.cover ?? 0.9;

  const changes: TreeChange[] = [];
  const take = () => {
    const rows: TagRow[] = listTagsWithParent(db);
    const sets = tagSets(db);
    return {
      sets,
      cov: coverageMap(sets),
      nameOf: new Map(rows.map((r) => [r.id, r.name])),
      parentOf: new Map(rows.map((r) => [r.id, r.parentId])),
    };
  };

  let { sets, cov, nameOf, parentOf } = take();

  // ── ① 合并:双向都 ≥cover 且都够样本 ──────────────────
  // `gone` 记这一轮**已经动过**的词。`pairs` / `cov` 是循环前算的一次性快照,
  // 里面还留着快照当时存在的 id;而闸门 `isDescendant` 是查库的 —— 查一个已经被
  // 删掉的 id 恒为 false(它沿已经不存在的父边走,走到 null 就停了)。所以只有这里
  // 能拦:不跳过的话,已删的词落在 `drop` 位时 `mergeTags` 空跑一遍**仍返回 true**
  // → 变化清单里多一条点名的两个词都已不在的假记录;落在 `keep` 位时 item_tags 的
  // UPDATE 撞 FK(openDb 开了 foreign_keys)→ 抛错,而本轮先前成功的合并已经各自
  // 提交 → 整轮半途而废。
  // 连 `keep` 一起记:它还在,但并进东西之后**视频集变了**,而 `cov` 还是旧的 ——
  // 拿过期覆盖率继续判就是又踩一次同一个坑。剩下的留到下一轮(reconcile 每轮都跑)。
  const gone = new Set<number>();
  for (const [a, b] of pairs(sets)) {
    if (gone.has(a) || gone.has(b)) continue;
    const sizeA = sets.get(a)!.size;
    const sizeB = sets.get(b)!.size;
    if (sizeA < minSample || sizeB < minSample) continue;

    // **已经是父子关系的一对不合并。** 树里已经表达过这个包含关系了 ——
    // 再合并一次就是把树压塌。(父子挂的视频高度重合是完全正常的:
    // 篮球的视频本来就都挂着体育。测试夹具也特别容易造出"父和子一模一样"。)
    //
    // **必须查库,不能用内存里的 `parentOf`** —— 这一轮已经发生的合并会改变库里的
    // 父子关系,而 `parentOf` 是循环开始时的快照。反例:X、Y 双向 100% 先被合并
    // (X 吸收 Y),而 Z 原本是 Y 的子节点 —— 库里 Z 的父已经变成 X,内存里还记着 Y。
    // 下一对 (X,Z) 沿 `parentOf` 走是 X→Y→null,Z 不在 X 的祖先链上 → 闸门放行 →
    // **Z 被并进 X,整棵子树没了**。查库就没这个问题。
    if (isDescendant(db, b, a) || isDescendant(db, a, b)) continue;

    const fwd = cov.get(k(a, b)) ?? 0;
    const back = cov.get(k(b, a)) ?? 0;
    if (fwd < cover || back < cover) continue;

    // 保留挂得多的那个(信息更全),把另一个并进来
    const [keep, drop] = sizeA >= sizeB ? [a, b] : [b, a];
    if (!mergeTags(db, drop, keep)) continue; // 防环 + 深度闸(mergeTags 内置)
    gone.add(drop);
    gone.add(keep);
    changes.push({
      kind: 'merge',
      from: nameOf.get(drop) ?? String(drop),
      to: nameOf.get(keep) ?? String(keep),
      detail: `挂的是同一批视频(${Math.round(Math.max(fwd, back) * 100)}% 重合)`,
    });
  }

  // **合并之后必须重取快照。** 覆盖数据、父边、名字全变了。
  // 不重取的话第二段拿着合并前的集合判"该挂哪",而上面刚合并掉的两个词
  // 还在集合里 —— 计划初稿宣称的"先合并再挂父"就成了一句做不到的话。
  if (changes.length > 0) ({ sets, cov, nameOf, parentOf } = take());

  // ── ② 挂父:单向外包 ≥cover,且样本够 ────────────────
  for (const [a, b] of pairs(sets)) {
    // 只动**根**:已经有父的那是质检给的判断,数据只纠正"没有父"的。
    // 两个都得是根 —— 一个已经有父的节点不该被数据再挪一次
    if (parentOf.get(a) !== null || parentOf.get(b) !== null) continue;
    if (sets.get(a)!.size < minSample || sets.get(b)!.size < minSample) continue;

    // **方向要两边都看**:`pairs` 是无序对,a 可能是子也可能是父。
    // 只看 `k(a,b)` 的话,谁先建谁就永远是"父",挂父整天不触发
    const fwd = cov.get(k(a, b)) ?? 0;
    const back = cov.get(k(b, a)) ?? 0;

    // **双向都 ≥cover 的一对不挂父** —— 它在判据里的结论是"合并",不是"谁是谁
    // 的子";挂父是**单向**规则的落点,一个双向合规的对不归它管。少了这一句,
    // 上一段因为 `gone` 跳过的那对同义词会在这里被**嵌套**起来 —— 而父子关系
    // 会把它们永久排除在合并之外(`isDescendant` 拦住),两个同义词就此永久并存,
    // 正是 §9F C4 要避开的失败。留着不动,下一轮(每轮都跑,数据已刷新)自会合并掉。
    if (fwd >= cover && back >= cover) continue;

    const child = fwd >= cover ? a : back >= cover ? b : null;
    if (child === null) continue;
    const parent = child === a ? b : a;
    const ratio = child === a ? fwd : back;

    // 闸在 setTagParent 里(防环 + 深度):false = 这次不合法 → 留原位
    if (!setTagParent(db, child, parent)) continue;
    parentOf.set(child, parent);
    changes.push({
      kind: 'reparent',
      from: nameOf.get(child) ?? String(child),
      to: nameOf.get(parent) ?? String(parent),
      detail: `${Math.round(ratio * 100)}% 的视频也挂着「${nameOf.get(parent) ?? parent}」`,
    });
  }

  return changes;
}
