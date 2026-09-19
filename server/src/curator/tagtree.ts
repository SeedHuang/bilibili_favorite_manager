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
  listTagsWithParent, mergeTags, setTagParent, tagScale, tagSets, type TagRow,
} from '../db/repo/tags.js';

/**
 * 统计下限:**少于这么多条的视频,重合率没有统计意义**,不判
 * ("两个词各挂 1 条、恰好是同一条"说明不了任何事)。
 *
 * **定义放在判据模块里**,夹子画像(C14)的离群判定也从这儿 import —— §9F 说那两处是
 * 「与 C9 同一个统计下限」,两个字面量各写一份的话那句话只在"碰巧都是 5"时成立,
 * 改了一处就静默分叉。
 */
export const MIN_SAMPLE = 5;

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
 * 运行预算的截止时刻 —— undefined 即不限时。
 *
 * **为什么要传进 coverageMap / pairs**:活跃词一多,55s 那种耗时的大头根本不在
 * reconcile 的循环体里,而在循环前把 O(活跃词²) 快照建出来这件事本身。预算只在
 * 循环迭代里检查的话,快照一开算就又是事件循环被占死 —— 守卫等于没装。所以
 * 截止时刻要一路传到计算最底层,粒度对(词/行),不会一档就是几十秒。
 */
type Deadline = number | undefined;

/**
 * 一次算完全部有向覆盖率。
 *
 * **必须一次算完。** 在循环里为每一对现算,等于把 O(n²) 的活做成 O(n⁴)
 * —— 初稿就这么写的(还在循环里临时构造一个 2 项 Map 再调一次自己)。
 *
 * **只存非 0 的**:两个词的视频集毫无交集时覆盖率必然是 0,存它只是占内存。
 * 查的时候 `?? 0`。
 *
 * **跳过样本不足的词 —— 这是性能的关键,不是小优化。** 词库从全库视频长出来,
 * 绝大多数词挂的条数远少于统计下限(实测 7559 个词里挂 ≥5 条的只有 212 个)。
 * 不剪枝的话 12005² 个词对全算一遍(每对还遍历视频集),事件循环卡死几十秒、
 * 内存飙到 3GB,所有请求 pending(用户报的"接口 pending"根因)。剪枝后只剩
 * 212² ≈ 4.5 万对,差 3000 倍。而 `reconcile` 里本来就对 `size < minSample` 的
 * 词不判 —— 提前在这里跳掉,结论完全一致。
 */
/**
 * 只留挂 ≥ minSample 的词(id 升序)。**两个函数共用的活跃列表** ——
 * 抽出来一次建好:不抽的话内层 `for (const b of ids)` 仍会遍历**每个**有挂载的词
 * (总词数),判断"够不够样本"—— 那只是 Map.get,但总词数涨到十万、活跃词几千时
 * 也是上亿次 get,烧光整个预算,「成本与总词数解耦」的承诺就破了。
 */
function activeIds(
  sets: ReadonlyMap<number, ReadonlySet<string>>,
  minSample: number,
): number[] {
  const out: number[] = [];
  for (const id of sets.keys()) {
    if (sets.get(id)!.size >= minSample) out.push(id);
  }
  return out.sort((x, y) => x - y);
}

export function coverageMap(
  sets: ReadonlyMap<number, ReadonlySet<string>>,
  minSample: number,
  deadline?: Deadline,
): RatioMap {
  const active = activeIds(sets, minSample);
  const out: RatioMap = new Map();
  for (const a of active) {
    if (deadline !== undefined && Date.now() > deadline) break;
    const A = sets.get(a)!;
    for (const b of active) {
      if (a === b) continue;
      const B = sets.get(b)!;
      let hit = 0;
      for (const x of A) if (B.has(x)) hit++;
      if (hit > 0) out.set(k(a, b), hit / A.size);
    }
  }
  return out;
}

/**
 * 无序对,每对只出一次 —— 双向判断在循环里自己做(查 `k(a,b)` 和 `k(b,a)`)。
 *
 * **只对活跃词配对** —— 跟 coverageMap 一个道理,不然 O(n²) 直接爆。
 */
function pairs(
  sets: ReadonlyMap<number, ReadonlySet<string>>,
  minSample: number,
  deadline?: Deadline,
): [number, number][] {
  const active = activeIds(sets, minSample);
  const out: [number, number][] = [];
  for (let i = 0; i < active.length; i++) {
    if (deadline !== undefined && Date.now() > deadline) break;
    for (let j = i + 1; j < active.length; j++) {
      out.push([active[i]!, active[j]!]);
    }
  }
  return out;
}

/**
 * 活跃词超过这个数,统计下限自动从 5 提到 10 —— 规模治理,不是 bug(M4h §2.3)。
 *
 * 依据 §1.5 的实测曲线:1000 活跃词 307ms 安全,3000 活跃词 2.5s 开始变慢。
 * 提下限把活跃词数压回去(挂 ≥10 条的词远少于 ≥5 的),整理成本重新落回预算内。
 */
const ACTIVE_TAG_LIMIT = 3000;

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
  return reconcileWithBudget(db, opts).changes;
}

/**
 * reconcile + **运行预算**(M4h Task 3)。
 *
 * 预算管的是"池子非空但活跃词暴涨"的场景:整理仍是同步的,活跃词 3000+ 就要秒级、
 * 一万就要分钟级(§1.5)。超时即**部分整理**收手 —— 已做的合并不丢,剩下的留给
 * 下一轮;`timedOut` 报给调用方记 warn,不抛错(整理是锦上添花,不该带崩这一轮)。
 */
export function reconcileWithBudget(
  db: Database.Database,
  opts: { minSample?: number; cover?: number; budgetMs?: number } = {},
): { changes: TreeChange[]; timedOut: boolean; limitRaised: boolean } {
  const cover = opts.cover ?? 0.9;
  const changes: TreeChange[] = [];
  const deadline = Date.now() + (opts.budgetMs ?? 5000);
  // 超时判定**只在返回前统一做一次**:预算可能烧在快照(coverageMap/pairs)里,
  // 循环体一次都不进 —— 只有循环里置位的话那种超时无人认领,调用方永远看不到 warn
  const outOfTime = () => Date.now() > deadline;

  // **统计下限自适应**(M4h Task 4):活跃词破限就把下限从 5 提到 10,用更保守的
  // 统计把计算量压回预算内。调用方显式传了 minSample 就听调用方的(测试要钉住两种形态)。
  // 是否触发提下限报给调用方记 log.event —— reconcile 是纯计算,不碰日志依赖
  const { activeTags } = tagScale(db, opts.minSample ?? MIN_SAMPLE);
  const minSample = opts.minSample ?? (activeTags > ACTIVE_TAG_LIMIT ? MIN_SAMPLE * 2 : MIN_SAMPLE);
  const limitRaised = activeTags > ACTIVE_TAG_LIMIT;

  const take = () => {
    const rows: TagRow[] = listTagsWithParent(db);
    const sets = tagSets(db);
    return {
      sets,
      cov: coverageMap(sets, minSample, deadline),
      nameOf: new Map(rows.map((r) => [r.id, r.name])),
      parentOf: new Map(rows.map((r) => [r.id, r.parentId])),
    };
  };

  let { sets, cov, nameOf, parentOf } = take();
  /**
   * **内存版祖先判断 —— 治 `isDescendant` 每次全表扫的命。**
   *
   * `isDescendant(db, b, a)` 每次都 `SELECT id, parent_id FROM tags`(12005 行)
   * 再建 Map 爬 —— reconcile 对每一对调两次,2056 对 = 4112 次全表扫 ≈ 几千万次,
   * 事件循环卡死、内存飙升(用户报的"接口 pending"根因)。这里用 take() 已建的
   * `parentOf` 快照走内存,不查库。
   *
   * **为什么不怕注释里"必须查库"的警告** —— 那个警告是"合并后内存 parentOf
   * 过时,拿旧父边判断会误放行导致整棵子树被并掉"。这里**主动同步**:合并成功后
   * 把 parentOf 里所有父是 drop 的改成 keep(mergeTags 在库里就是这么干的,line 264)。
   * 于是内存 parentOf 始终跟库一致,既快又准。
   */
  const ancestor = (node: number, anc: number): boolean => {
    let cur: number | null | undefined = node;
    const seen = new Set<number>();
    while (cur != null && !seen.has(cur)) {
      if (cur === anc) return true;
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return false;
  };

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
  for (const [a, b] of pairs(sets, minSample, deadline)) {
    // 预算:超时就**部分整理**收手 —— 已做的合并各自已提交,留着不丢,
    // 剩下的下一轮再说。不抛错:整理是锦上添花,不该带崩这一轮
    if (outOfTime()) break;
    if (gone.has(a) || gone.has(b)) continue;
    const sizeA = sets.get(a)!.size;
    const sizeB = sets.get(b)!.size;
    if (sizeA < minSample || sizeB < minSample) continue;

    // **已经是父子关系的一对不合并。** 树里已经表达过这个包含关系了 ——
    // 再合并一次就是把树压塌。(父子挂的视频高度重合是完全正常的:
    // 篮球的视频本来就都挂着体育。测试夹具也特别容易造出"父和子一模一样"。)
    //
    // **用内存 ancestor 而不是 isDescendant** —— 后者每次全表扫 12005 行,
    // 2056 对 × 2 次 = 几千次全表扫,事件循环卡死。内存版靠下面的合并同步保证准确。
    if (ancestor(b, a) || ancestor(a, b)) continue;

    const fwd = cov.get(k(a, b)) ?? 0;
    const back = cov.get(k(b, a)) ?? 0;
    if (fwd < cover || back < cover) continue;

    // 保留挂得多的那个(信息更全),把另一个并进来
    const [keep, drop] = sizeA >= sizeB ? [a, b] : [b, a];
    if (!mergeTags(db, drop, keep)) continue; // 防环 + 深度闸(mergeTags 内置)
    gone.add(drop);
    gone.add(keep);
    // **同步内存 parentOf**:mergeTags 把 drop 的子节点父改成 keep(库里 line 264
    // 那条 UPDATE)。不跟上的话 ancestor() 拿旧父边判断,就是注释里那个"子树被并掉"
    // 的坑。这里一步把 parentOf 里所有"父是 drop"的改成 keep。
    for (const [id, p] of parentOf) if (p === drop) parentOf.set(id, keep);
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
  // 预算已烧完就不再重取:第二段在下面统一被 deadline 拦住
  if (changes.length > 0 && !outOfTime()) ({ sets, cov, nameOf, parentOf } = take());

  // ── ② 挂父:单向外包 ≥cover,且样本够 ────────────────
  for (const [a, b] of pairs(sets, minSample, deadline)) {
    if (outOfTime()) break;
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

  return { changes, timedOut: outOfTime(), limitRaised };
}
