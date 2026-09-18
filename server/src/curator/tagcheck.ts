/**
 * 标签质检(spec §9F C8)—— flash 在这一整条链路里**唯一**的出场点。
 *
 * 分界线:本地模型做生产,flash 只当质检员,而且**只对新的东西开口**。
 * 首轮 500-1500 个新词 ≈ 十几次调用;之后每轮只剩几十个 ≈ 一次。几轮之后趋近于零。
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
import { parseJsonArray } from './parse.js';
import type { ChatMessage } from '../llm/context.js';
import {
  listTagTree, mergeTags, normalizeTagName, setTagParent, deleteTag, type TagNode,
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
}): Promise<{ dropped: number; merged: number; moved: number }> {
  const { db } = opts;
  // 闸门:**没有新词就一次 LLM 都不调** —— 所以放在每轮末尾是免费的
  if (opts.newNames.length === 0) return { dropped: 0, merged: 0, moved: 0 };

  const known = new Set<string>();
  const collect = (nodes: readonly TagNode[]) => {
    for (const n of nodes) { known.add(n.name); collect(n.children); }
  };
  collect(opts.tree);

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

  let dropped = 0, merged = 0, moved = 0;
  for (const v of verdicts) {
    const id = byName(db, v.name);
    if (id === null) continue;

    if (v.action === 'drop') {
      // **泛词从词库里删掉,不是"留原地"** —— 它没有任何区分力,留着只会被
      // 集合判据推到树顶(§9F.6 说的那个软肋)。这是整套系统里唯一的防线
      deleteTag(db, id);
      dropped++;
      continue;
    }
    if (v.action === 'merge' && v.target) {
      const targetId = byName(db, v.target);
      // 闸在 mergeTags 里(防环 + 深度):false = 这两个词不能并 —— 跳过,不是抛错
      if (targetId !== null && targetId !== id && mergeTags(db, id, targetId)) merged++;
      continue;
    }
    if (v.action === 'move' && v.target) {
      const parentId = byName(db, v.target);
      // 闸在 setTagParent 里(唯一收口):false = 这次挂父不合法 → 留原位
      if (parentId !== null && setTagParent(db, id, parentId)) moved++;
    }
  }
  return { dropped, merged, moved };
}

/** 按名字(含别名)找节点。质检的输出用名字而不是 id —— 模型认名字 */
function byName(db: Database.Database, name: string): number | null {
  const row = db
    .prepare(
      `SELECT id FROM tags WHERE norm = ?
        UNION ALL
       SELECT tag_id AS id FROM tag_aliases WHERE name = ?
        LIMIT 1`,
    )
    .get(normalizeTagName(name), normalizeTagName(name)) as { id: number } | undefined;
  return row ? row.id : null;
}
