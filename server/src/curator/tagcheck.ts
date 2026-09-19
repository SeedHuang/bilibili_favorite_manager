/**
 * 标签质检(spec §9F C8)—— flash 在这一整条链路里**唯一**的出场点。
 *
 * 分界线:本地模型做生产,flash 只当质检员,而且**只对没质检过的词开口**。
 * 每轮**一次调用** —— 本轮待检的词(checked_at IS NULL)进同一个 prompt。之后欠账清零,
 * 开销也趋近于零,所以挂在每轮末尾是划算的。
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
  findTag, listTagsWithParent, listUncheckedTags, markTagChecked, mergeTags, normalizeTagName,
  setTagParent, deleteTag, type TagNode,
} from '../db/repo/tags.js';

export const CHECK_SYSTEM = `你是标签词库的质检员。用户给你一棵标签树和一批词,判断每个词该怎么办,并给出一句理由。

- **drop**(太泛,删掉):这个词不能把一类内容和其它内容**分开**。
  该删的例:"AI""视频""教程""分享""合集""超清" —— 几乎每条都挂,没有区分力。
  不该删的例:"露营"(只挂户外内容)、"烤羊肉"(只挂美食内容) —— 能分开一类,留着。
- **merge**(同义,并入已有词):它是已有词的另一种写法(译名/简写/同义词)。
  该并的例:"鲁夫"→"路飞","漫威"→"Marvel"。
  不该并的例:"露营"和"烤羊肉" —— 意思不同,并了反而丢信息。
- **move**(归错层,挪位):它该挂在另一个已有词下面。
  该挪的例:"篮球"该挂到"体育"下。
  不该挪的例:"露营"挂在根上 —— 它是独立大类,不归任何词管。
- **keep**(留):没问题。
  该留的例:"露营""烤羊肉""NBA"。

**拿不准就 keep** —— 漏掉一个泛词只是让树脏一点,误删一个好词是丢掉信息。
每条都必须带 reason(一句话,说清为什么这么判,比如"挂了 3000 条,什么都有,分不开")。
只输出 JSON 数组:[{"name":"AI","action":"drop","reason":"几乎每条都挂,没有区分力"},{"name":"鲁夫","action":"merge","target":"路飞","reason":"同一个人的译名"}]`;

export interface TagVerdict {
  name: string;
  action: 'keep' | 'drop' | 'merge' | 'move';
  target?: string;
  /** 模型给的判定理由(一句话)—— 日志里让用户看懂"为什么" */
  reason?: string;
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
    const o = r as { name?: unknown; action?: unknown; target?: unknown; reason?: unknown };
    if (typeof o?.name !== 'string' || !o.name.trim()) continue;

    const name = o.name.trim();
    const action =
      o.action === 'drop' || o.action === 'merge' || o.action === 'move' ? o.action : 'keep';
    const targetNorm = typeof o.target === 'string' ? normalizeTagName(o.target) : '';
    const target = targetNorm ? knownNorm.get(targetNorm) : undefined;
    const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : undefined;

    // **只有 merge / move 需要目标。**
    //
    // 这里原来写成 `action !== 'keep' && !target` —— 而 `drop` 天然没有目标,
    // 于是条件恒真、**每个 drop 都被改写成 keep**,「剔泛词」那道闸门整轮失效。
    // §9F.6 明说"剔除裸泛词是这套判据**唯一**的软肋",那唯一的闸门却是关着的。
    if ((action === 'merge' || action === 'move') && !target) {
      out.push({ name, action: 'keep', ...(reason ? { reason } : {}) });
      continue;
    }
    out.push({ name, action, ...(target ? { target } : {}), ...(reason ? { reason } : {}) });
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
  db: Database.Database;
  /** 只为「一个词都没判回来」那条告警 —— 可选:测试和纯调用的地方不必造一个 */
  log?: Logger;
  /** 判完一个词报一次(§9D.7)—— 路由拿它发 `verdict` 帧。**未动手的不算判完**,那种走 onNote */
  onVerdict?: (v: TagVerdict) => void;
  /**
   * 判了却没动手的那些(§9D.7)—— 路由拿它发 `note` 帧。
   *
   * 这正是用户最想看见、而此前**一个字都看不到**的一类:模型判了「AI」该 drop,
   * 而规范名查不到(别名)、或者 merge/move 的目标不存在 —— 都是**静默跳过**。
   * 界面上"质检判了个词然后什么都没发生"和"质检根本没跑"长得一模一样。
   */
  onNote?: (level: 'info' | 'warn', text: string) => void;
  /** 用户中止信号 —— 透传给 complete,不然质检挂起时 run-abort 也停不下来 */
  signal?: AbortSignal;
  /** 批判完报一次进度(手动质检的进度条靠它)—— done/total 是**词数** */
  onBatch?: (p: { done: number; total: number }) => void;
  /**
   * 单次质检调用的超时(ms)。**和打标同一个理由**:本地模型挂起时不设超时,
   * complete 永不 resolve,`currentRun.running` 被永久钉在 true,后续 run 全 409。
   */
  timeoutMs?: number;
  /** 质检范围:'continue' = 只检未质检的(checked_at IS NULL,含历史欠账+新词);
   *  'all' = 强制全库重检。默认 'continue'。 */
  scope?: 'continue' | 'all';
}): Promise<{ dropped: number; merged: number; moved: number; checked: number }> {
  const { db } = opts;
  // 分批大小:200 词/批。词多时一次全送会淹没模型 → 0 判定(TAGCHECK_EMPTY 根因)
  const TAGCHECK_BATCH = 200;
  const allNames = opts.scope === 'all'
    ? listTagsWithParent(db).map((r) => r.name)   // 全库词名
    : listUncheckedTags(db);                       // 未质检的(含欠账+新词)
  // **送检名单就是 continue 的边界** —— prompt 里摆着整棵树,模型可能捎带对已盖章的
  // 老词回 verdict;applyVerdict 会照单执行,包括不可逆的 drop。continue 承诺的是
  // "只检未质检的",这个承诺要靠这道闸兑现( scope='all' 候选集=全库,不加限制)
  const allowed = opts.scope === 'all' ? null : new Set(allNames.map(normalizeTagName));

  const known = new Set<string>();
  const collect = (nodes: readonly TagNode[]) => {
    for (const n of nodes) { known.add(n.name); collect(n.children); }
  };
  collect(opts.tree);

  // 闸门:没词可判就一次 LLM 都不调。checked=0 让调用方分得清「没得检」和「检完没事」
  if (allNames.length === 0) {
    opts.onNote?.('info', opts.scope === 'all' ? '词库是空的 —— 没有词可判' : '没有待质检的词 —— 账已清');
    return { dropped: 0, merged: 0, moved: 0, checked: 0 };
  }

  // 树的 prompt 前缀整轮不变(改动要等批次跑完才落库),循环外算一次 —— 全库 60 批
  // 每批重渲染 12000 行的树字符串是白烧 CPU
  const treeText = renderTree(opts.tree) || '(空)';

  let dropped = 0, merged = 0, moved = 0;
  /** 一条判定落到库上(闸门/动作/计数/onVerdict 全在这)—— 每批 coerce 完**当场执行** */
  const applyVerdict = (v: TagVerdict) => {
    // **候选集闸门**(continue):verdict 的词不在送检名单里 → 按规矩没动它。
    // 树整体进了 prompt,模型捎带判到已盖章老词是不可逆 drop 的入口 —— 这道闸挡住它
    if (allowed && !allowed.has(normalizeTagName(v.name))) {
      opts.onNote?.('warn', `质检判了「${v.name}」,但它不在本次送检名单里 —— 按规矩没动它`);
      return;
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
        return;
      }
      // **泛词从词库里删掉,不是"留原地"** —— 它没有任何区分力,留着只会被
      // 集合判据推到树顶(§9F.6 说的那个软肋)。这是整套系统里唯一的防线
      deleteTag(db, row.id);
      dropped++;
      opts.onVerdict?.(v);
      return;
    }

    // merge / move 相反:它们**要的就是"任何写法都认"**(模型认名字不认 id),
    // 所以走 findTag —— 查规范名,再查别名表
    const id = findTag(db, normalizeTagName(v.name));
    if (id === null) {
      opts.onNote?.('warn', `质检判了「${v.name}」,但词库里找不到这个词 —— 没动它`);
      return;
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
      return;
    }
    if (v.action === 'move' && v.target) {
      const parentId = findTag(db, normalizeTagName(v.target));
      // 闸在 setTagParent 里(唯一收口):false = 这次挂父不合法 → 留原位
      if (parentId !== null && setTagParent(db, id, parentId)) {
        markTagChecked(db, id);
        moved++;
        opts.onVerdict?.(v);
      } else {
        opts.onNote?.('warn', `挪位「${v.name}」→「${v.target}」没成(目标不在词库里,或者挂过去会成环/超深)`);
      }
      return;
    }
    // 落到这里的是 **keep**(没有目标的 merge/move 在 coerceVerdicts 里已经退回 keep 了)。
    // keep 也是它做的决定 —— 用户问的正是"每个词判成了什么",只报动手的那些是半份日志
    // (走到了这里说明 id 非空 —— merge/move 的 id===null 分支已提前 return)
    markTagChecked(db, id);
    opts.onVerdict?.(v);
  };

  for (let i = 0; i < allNames.length; i += TAGCHECK_BATCH) {
    const batchNo = Math.floor(i / TAGCHECK_BATCH) + 1;
    const batchTotal = Math.ceil(allNames.length / TAGCHECK_BATCH);
    const batch = allNames.slice(i, i + TAGCHECK_BATCH);
    console.log(`[tags/check] 批 ${batchNo}/${batchTotal} 送 ${batch.length} 个词`);
    const messages: ChatMessage[] = [
      { role: 'system', content: CHECK_SYSTEM },
      {
        role: 'user',
        content:
          `## 现有标签树\n${treeText}\n\n` +
          `## 待判定的词(${batch.length} 个)\n${batch.join('、')}\n\n` +
          `请逐个判定。`,
      },
    ];
    const batchVerdicts = coerceVerdicts(
      await complete({
        config: opts.config,
        messages,
        thinking: false,
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      }),
      known,
    );
    // 每批判完都报数 —— 分批后单批输出被截断(0 判定)会被其他批的非零总数掩盖,
    // 不在这里出声的话用户看到的就是" apparently 干净"的一轮
    console.log(`[tags/check] 批 ${batchNo}/${batchTotal} 判定 ${batchVerdicts.length} 个`);
    opts.onBatch?.({ done: Math.min(i + TAGCHECK_BATCH, allNames.length), total: allNames.length });
    if (batchVerdicts.length === 0) {
      const why = `第 ${batchNo}/${batchTotal} 批一个词都没判回来:${batch.length} 个词送出去、0 条判定 —— 这批可能被截断了,按"都没问题"处理了`;
      opts.log?.event({ level: 'warn', category: 'llm', code: 'TAGCHECK_EMPTY', message: why });
      opts.onNote?.('warn', why);
    }
    // **当场执行本批判定** —— 日志实时滚动(用户不用等 37 批跑完才看到第一条),
    // 中止时已判的已落库,和"部分整理"语义一致
    for (const v of batchVerdicts) applyVerdict(v);
  }

  return { dropped, merged, moved, checked: allNames.length };
}
