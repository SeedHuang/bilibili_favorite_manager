/**
 * 标签质检(spec §9F C8)—— flash 在这一整条链路里**唯一**的出场点。
 *
 * 分界线:本地模型做生产,flash 只当质检员,而且**只对新的东西开口**。
 * 每轮**一次调用** —— 本轮所有新词进同一个 prompt。之后每轮新词趋近于零,开销也趋近于零,
 * 所以挂在每轮末尾是划算的。
 *
 * ⚠️ 首轮可能有 500-1500 个新词挤进**同一个** prompt(§9F.4 那张成本表估的
 * "10-30 次"是按分批算的,不是规范条款)。**这个规模问题挂着未决**:要不要切批是
 * 设计取舍,不是本函数的实现细节 —— 别拿估算当规范,也别在这儿偷偷开第二套调用结构。
 *
 * 它回答三件事(§9F C8):① 这个词是不是太泛、根本不该进词库 ② 它是不是
 * 已经存在的东西的另一种写法 ③ 它该不该换个位置。
 *
 * **为什么泛词必须在这里挡**:集合判据(C9)对付不了泛词 —— 一个挂遍全库的词,
 * 在覆盖关系上"所有词都在它里面",判据会把它推到树顶。这是那套判据唯一的软肋,
 * 而这道闸就在这儿。
 */
import type Database from 'better-sqlite3';
import type { ModelConfig } from '../llm/provider.js';
import { complete } from '../llm/provider.js';
import type { Logger } from '../logger/index.js';
import { parseJsonArray } from './parse.js';
import type { ChatMessage } from '../llm/context.js';
import {
  findTag, mergeTags, normalizeTagName, setTagParent, deleteTag, type TagNode,
} from '../db/repo/tags.js';

export const CHECK_SYSTEM = `你是标签词库的质检员。用户给你一棵标签树和一批**新出现的词**,判断每个词该怎么办。

- **drop**:这个词太泛,没有区分力,不该存在于词库里。典型:"AI""视频""教程""分享""合集"。
  判断标准是:它能不能把一类内容和其他内容**分开**?分不开就是 drop。
- **merge**:它其实是已有某个词的另一种写法(译名差异、简写、同义词)。填 target 为已有的那个词。
- **move**:它该挂在另一个已有词下面。填 target 为父节点。
- **keep**:没问题,它是个有区分力的具体词。

**拿不准就 keep** —— 漏掉一个泛词只是让树脏一点,误删一个好词是丢掉信息。
只输出 JSON 数组:[{"name":"AI","action":"drop"},{"name":"鲁夫","action":"merge","target":"路飞"}]`;

export interface TagVerdict {
  name: string;
  action: 'keep' | 'drop' | 'merge' | 'move';
  target?: string;
}

/** 收窄。**target 必须是已有词** —— 模型编的目标一律丢掉,退回 keep */
export function coerceVerdicts(raw: unknown, known: ReadonlySet<string>): TagVerdict[] {
  const list = parseJsonArray(raw) ?? [];
  const out: TagVerdict[] = [];

  // 名字比较走**归一化** —— 树里存的是显示名("NBA"),模型可能吐 "nba"。
  // 用精确串比会把合法目标当成"编的"丢掉,然后静默退回 keep —— 而 keep 是"什么都不做",
  // 用户看不出任何异常,只会觉得"质检好像不太灵"
  const knownNorm = new Map([...known].map((n) => [normalizeTagName(n), n]));

  for (const r of list) {
    const o = r as { name?: unknown; action?: unknown; target?: unknown };
    if (typeof o?.name !== 'string' || !o.name.trim()) continue;

    const name = o.name.trim();
    const action =
      o.action === 'drop' || o.action === 'merge' || o.action === 'move' ? o.action : 'keep';
    const targetNorm = typeof o.target === 'string' ? normalizeTagName(o.target) : '';
    const target = targetNorm ? knownNorm.get(targetNorm) : undefined;

    // **只有 merge / move 需要目标。**
    //
    // 这里原来写成 `action !== 'keep' && !target` —— 而 `drop` 天然没有目标,
    // 于是条件恒真、**每个 drop 都被改写成 keep**,「剔泛词」那道闸门整轮失效。
    // §9F.6 明说"剔除裸泛词是这套判据**唯一**的软肋",那唯一的闸门却是关着的。
    if ((action === 'merge' || action === 'move') && !target) {
      out.push({ name, action: 'keep' });
      continue;
    }
    out.push({ name, action, ...(target ? { target } : {}) });
  }
  return out;
}

function renderTree(nodes: readonly TagNode[], depth = 0): string {
  return nodes
    .map((n) => `${'  '.repeat(depth)}- ${n.name}(${n.count} 条)\n${renderTree(n.children, depth + 1)}`)
    .join('');
}

export async function runTagCheck(opts: {
  config: ModelConfig;
  tree: readonly TagNode[];
  newNames: readonly string[];
  db: Database.Database;
  /** 只为「一个词都没判回来」那条告警 —— 可选:测试和纯调用的地方不必造一个 */
  log?: Logger;
  /** 判完一个词报一次(§9D.7)—— 路由拿它发 `verdict` 帧。**未动手的不算判完**,那种走 onNote */
  onVerdict?: (v: TagVerdict) => void;
  /**
   * 判了却没动手的那些(§9D.7)—— 路由拿它发 `note` 帧。
   *
   * 这正是用户最想看见、而此前**一个字都看不到**的一类:模型判了「AI」该 drop,
   * 而它不在本轮新词里(闸门)、或者规范名查不到(别名)—— 两种都是**静默跳过**。
   * 界面上"质检判了个词然后什么都没发生"和"质检根本没跑"长得一模一样。
   */
  onNote?: (level: 'info' | 'warn', text: string) => void;
}): Promise<{ dropped: number; merged: number; moved: number }> {
  const { db } = opts;
  // 闸门:**没有新词就一次 LLM 都不调** —— 所以放在每轮末尾是免费的
  if (opts.newNames.length === 0) return { dropped: 0, merged: 0, moved: 0 };

  const known = new Set<string>();
  const collect = (nodes: readonly TagNode[]) => {
    for (const n of nodes) { known.add(n.name); collect(n.children); }
  };
  collect(opts.tree);

  // 闸门:**只有本轮的新词归它管**(spec C8 ①②③ 说的都是"定每个**新词**在树里的位置")。
  //
  // 少这一句的话它的权力是**整个词库**:`coerceVerdicts` 只校验 target 是不是已知名,
  // 对 `name` 毫无限制,于是一句"drop 美食"就能删掉一个用了三个月的词 —— 而 drop 和
  // merge 是本文件里**唯一两个不可逆**的动作,做完不通知也不确认。
  // 这不是假想的路径:`renderTree` 把整棵树摆在模型眼前,而 `CHECK_SYSTEM` 自己的
  // drop 例子就是「AI」「视频」「教程」「分享」「合集」—— 正是 §9F.0 说会从第一轮的
  // `domains` 里漏进来的那批词。模型照着例子点名老词,闸门是开着的。
  const fresh = new Set(opts.newNames.map(normalizeTagName));

  const messages: ChatMessage[] = [
    { role: 'system', content: CHECK_SYSTEM },
    {
      role: 'user',
      content:
        `## 现有标签树\n${renderTree(opts.tree) || '(空)'}\n\n` +
        `## 本轮新出现的词(${opts.newNames.length} 个)\n${opts.newNames.join('、')}\n\n` +
        `请逐个判定。`,
    },
  ];

  const verdicts = coerceVerdicts(
    // 批量判断:关思考模式(Task 0)。它要的是"照格式吐 JSON",不是"想清楚"
    await complete({ config: opts.config, messages, thinking: false }),
    known,
  );

  /**
   * **判回来 0 条,不等于"这批词都没问题"。**
   *
   * `parseJsonArray` 遇到**被截断**的数组返回 null(`sliceBalanced` 要一对闭括号),
   * 于是 `coerceVerdicts` 得到 `[]`、三个计数器全是 0 —— 而这一路**没有任何红点**:
   * 不抛错、不记 TAGCHECK_FAILED、变化清单写一份空的。用户看到的是"上一轮变化:还没有
   * 跑过标注,或者上一轮什么都没变",旁边写着本轮新增了几百个词 —— 而 §9F.6 说首轮
   * 那个形状会一直留在界面上。
   *
   * 这不是假想的路径:`provider.ts` 全程没设 `maxOutputTokens`,几百条 verdict
   * (每条 ~20 token)撞上服务商的默认输出上限就会被截断。**要不要切批、上限定多少
   * 是设计取舍,不在这儿偷偷定**(见文件头那段)—— 但"什么都没判"必须出声。
   *
   * 上面那道闸门保证走到这里 `newNames` 非空,所以"送出去 0 个词"不需要另判。
   */
  if (verdicts.length === 0) {
    const why = `标签质检一个词都没判回来:${opts.newNames.length} 个新词送出去、0 条判定 —— 本轮的变化清单是空的,别当成"都没问题"(输出可能被截断)`;
    opts.log?.event({ level: 'warn', category: 'llm', code: 'TAGCHECK_EMPTY', message: why });
    // 同一句话也发一帧(§9D.7)—— 日志要独立成立:events 表是给事后查的,日志是
    // 给**正在看着它跑**的人看的,而这一路此前恰恰是"跑完了、什么都没说"
    opts.onNote?.('warn', why);
  }

  let dropped = 0, merged = 0, moved = 0;
  for (const v of verdicts) {
    // **老词一律不碰** —— 比较走归一化,树里存的是显示名("NBA"),模型可能吐 "nba"
    if (!fresh.has(normalizeTagName(v.name))) {
      // 跳过也得出声(§9D.7)—— 一句"判了但没动它"比一个字都没有诚实
      opts.onNote?.('warn', `质检判了「${v.name}」,但它不是本轮的新词 —— 按规矩没动它`);
      continue;
    }

    if (v.action === 'drop') {
      // **drop 只认规范名**(`tags.norm`),不查别名表。
      //
      // 别名说明这个名字是某个**活词的另一种写法**(合并留下的旧名、改名前的旧名),
      // 所以"要删的词"跟"这个词"根本不是一个东西。走 `findTag` 会顺着别名把 id 解到
      // 那具活词上,一句 drop 就把无辜的词连同它的 `item_tags` 删了 —— 而这是本文件里
      // **唯一不可逆**的动作。判错的两个方向也不对称:漏一个泛词只是树脏一点,误删一个
      // 好词是丢掉信息(所以系统提示词写着"拿不准就 keep")。别名 → 直接跳过。
      const row = db.prepare(`SELECT id FROM tags WHERE norm = ?`).get(normalizeTagName(v.name)) as
        | { id: number }
        | undefined;
      if (!row) {
        // 上面那段"只认规范名"的规矩在这里**没删成**,而它和删成了长一样(都是静默)
        opts.onNote?.('warn', `质检要剔除「${v.name}」,但词库里没有这个规范名(只认规范名、不查别名)—— 没删`);
        continue;
      }
      // **泛词从词库里删掉,不是"留原地"** —— 它没有任何区分力,留着只会被
      // 集合判据推到树顶(§9F.6 说的那个软肋)。这是整套系统里唯一的防线
      deleteTag(db, row.id);
      dropped++;
      opts.onVerdict?.(v);
      continue;
    }

    // merge / move 相反:它们**要的就是"任何写法都认"**(模型认名字不认 id),
    // 所以走 findTag —— 查规范名,再查别名表
    const id = findTag(db, normalizeTagName(v.name));
    if (id === null) {
      opts.onNote?.('warn', `质检判了「${v.name}」,但词库里找不到这个词 —— 没动它`);
      continue;
    }

    if (v.action === 'merge' && v.target) {
      const targetId = findTag(db, normalizeTagName(v.target));
      // 闸在 mergeTags 里(防环 + 深度):false = 这两个词不能并 —— 跳过,不是抛错
      if (targetId !== null && targetId !== id && mergeTags(db, id, targetId)) {
        merged++;
        opts.onVerdict?.(v);
      } else {
        // 闸门挡下也是"判了却没动" —— 不报的话它就是又一次静默
        opts.onNote?.('warn', `合并「${v.name}」→「${v.target}」没成(目标不在词库里,或者并过去会成环/超深)`);
      }
      continue;
    }
    if (v.action === 'move' && v.target) {
      const parentId = findTag(db, normalizeTagName(v.target));
      // 闸在 setTagParent 里(唯一收口):false = 这次挂父不合法 → 留原位
      if (parentId !== null && setTagParent(db, id, parentId)) {
        moved++;
        opts.onVerdict?.(v);
      } else {
        opts.onNote?.('warn', `挪位「${v.name}」→「${v.target}」没成(目标不在词库里,或者挂过去会成环/超深)`);
      }
      continue;
    }
    // 落到这里的是 **keep**(没有目标的 merge/move 在 coerceVerdicts 里已经退回 keep 了)。
    // keep 也是它做的决定 —— 用户问的正是"每个词判成了什么",只报动手的那些是半份日志
    opts.onVerdict?.(v);
  }
  return { dropped, merged, moved };
}
