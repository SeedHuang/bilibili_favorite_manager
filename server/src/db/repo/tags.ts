import type Database from 'better-sqlite3';
import { rewriteRuleTagIds } from './rules.js';

/**
 * 词库树 —— §9F 的存储层。
 *
 * 三张表(tags / tag_aliases / item_tags)的唯一写手。只有一条不变量:
 * **任何走过的名字都能查到归宿** —— 先查别名表,再查 (父, 归一化名)。
 * 这条不变量就是"不重复建立"的物理保证:合并一次,永久记住。
 */
export type TagSource = 'ai' | 'rule' | 'user';

export interface TagRow {
  id: number;
  name: string;
  parentId: number | null;
}

export interface TagNode extends TagRow {
  /** 直达这个节点的条目数 —— **不含子孙**(子孙的数在它自己那儿) */
  count: number;
  children: TagNode[];
}

/**
 * 归一化(C3):**只做确定性的那几样**。
 *
 * 简繁和译名差异(路飞/鲁夫)字符串规则做不到,硬做只会做错 —— 那交给别名表
 * 和集合判据(C9)。这里只管大小写、全角和首尾标点。
 */
export function normalizeTagName(raw: string): string {
  return raw
    .replace(/　/g, ' ')                                   // 全角空格
    .replace(/[！-～]/g, (c) =>                         // 全角 ASCII → 半角
      String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/^[\s·・、,，.。:：;；!！?？'"“”‘’\-—]+/, '')
    .replace(/[\s·・、,，.。:：;；!！?？'"“”‘’\-—]+$/, '')
    .toLowerCase();
}

/**
 * 按名字找节点 —— 先查规范名(`tags.norm`),再查别名表。
 *
 * 名字是**全局唯一**的(C4),所以这个函数永远只有一个答案,和父是谁无关。
 */
export function findTag(db: Database.Database, norm: string): number | null {
  const direct = db.prepare(`SELECT id FROM tags WHERE norm = ?`).get(norm) as
    | { id: number }
    | undefined;
  if (direct) return direct.id;
  const aliased = db.prepare(`SELECT tag_id FROM tag_aliases WHERE name = ?`).get(norm) as
    | { tag_id: number }
    | undefined;
  return aliased ? aliased.tag_id : null;
}

/** 记一笔"这个写法归到那个节点"。重复写入是幂等的(同一个写法只属于一个节点) */
export function addAlias(db: Database.Database, name: string, tagId: number): void {
  const norm = normalizeTagName(name);
  if (!norm) return;
  db.prepare(
    `INSERT INTO tag_aliases (name, tag_id) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET tag_id = excluded.tag_id`,
  ).run(norm, tagId);
}

/**
 * 找到或建出这个名字的节点,返回 id。
 *
 * **查到就复用,不管父是谁**(C4 全局唯一)。模型说"露营属于美食"而它已经挂在
 * 户外下时,不该再建第二个 —— 那正是"相同的 tag 不要重复建立"。真要挪位置,
 * 走质检的 move / 判据的 reparent,不靠"再建一个"。
 *
 * `parentId` 只在**新建**时用得上。
 */
export function ensureTag(
  db: Database.Database,
  name: string,
  parentId: number | null,
): number {
  const norm = normalizeTagName(name);
  // 空名字是调用方的 bug(`coerceTagOutput` 已经把空串滤掉了)。这里直接抛,
  // 别默默建一个 norm='' 的节点 —— 那个节点之后会被 findTag 永久命中
  if (!norm) throw new Error('标签名不能为空');

  const known = findTag(db, norm);
  if (known !== null) return known;

  const info = db
    .prepare(`INSERT INTO tags (name, norm, parent_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(name.trim() || norm, norm, parentId, Date.now());
  const id = Number(info.lastInsertRowid);
  // 每个节点都记一笔。查词时 `tags.norm` 其实已经能命中,这一笔是为了让
  // **"曾经用过的写法"**(合并掉的、改名前的)和规范名走同一条查询路径 ——
  // `findTag` 因此只有一份逻辑,不用分两处判
  addAlias(db, norm, id);
  return id;
}

export function linkItemTag(
  db: Database.Database,
  itemId: string,
  tagId: number,
  source: TagSource,
): void {
  db.prepare(
    `INSERT INTO item_tags (item_id, tag_id, source) VALUES (?, ?, ?)
     ON CONFLICT(item_id, tag_id) DO NOTHING`,
  ).run(itemId, tagId, source);
}

/** itemId → 它挂的 tag id。**不传 ids 就是全库** —— 调用方按需选,别默认全量 */
export function itemTagIds(
  db: Database.Database,
  itemIds?: readonly string[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (itemIds && itemIds.length === 0) return out;

  let rows: { item_id: string; tag_id: number }[];
  if (itemIds) {
    // 分批 IN —— SQLite 的变量上限是 32766,归类批最多几千条,一批就够
    rows = db
      .prepare(
        `SELECT item_id, tag_id FROM item_tags
          WHERE item_id IN (${itemIds.map(() => '?').join(',')})
          ORDER BY item_id, tag_id`,
      )
      .all(...itemIds) as { item_id: string; tag_id: number }[];
  } else {
    rows = db
      .prepare(`SELECT item_id, tag_id FROM item_tags ORDER BY item_id, tag_id`)
      .all() as { item_id: string; tag_id: number }[];
  }

  for (const r of rows) {
    const arr = out.get(r.item_id);
    if (arr) arr.push(r.tag_id);
    else out.set(r.item_id, [r.tag_id]);
  }
  return out;
}

/** tagId → 直达条目数。集合判据(C9)的原料 */
export function tagCounts(db: Database.Database): Map<number, number> {
  const rows = db
    .prepare(`SELECT tag_id, COUNT(*) n FROM item_tags GROUP BY tag_id`)
    .all() as { tag_id: number; n: number }[];
  return new Map(rows.map((r) => [r.tag_id, r.n]));
}

/** 整棵树。count 用 tagCounts,不递归求和 */
export function listTagTree(db: Database.Database): TagNode[] {
  const rows = db
    .prepare(`SELECT id, name, parent_id FROM tags ORDER BY name`)
    .all() as { id: number; name: string; parent_id: number | null }[];
  const counts = tagCounts(db);

  const byId = new Map<number, TagNode>();
  for (const r of rows) {
    byId.set(r.id, { id: r.id, name: r.name, parentId: r.parent_id, count: counts.get(r.id) ?? 0, children: [] });
  }
  const roots: TagNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    const parent = r.parent_id === null ? null : byId.get(r.parent_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** 只要 id / name / parent_id,不要 count 和 children —— 判据用它做轻量遍历 */
export function listTagsWithParent(db: Database.Database): TagRow[] {
  return (db.prepare(`SELECT id, name, parent_id FROM tags`).all() as
    { id: number; name: string; parent_id: number | null }[])
    .map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
}

/**
 * tagId → 挂它的**视频 id 集合**。集合判据的原料。
 *
 * 用 Set<string> 而不是 bitset:3250 条 × 几千个词的规模下,内存和速度都够,
 * 可读性值这个差价。真到几万条再说。
 * ponytail: 全量集合,几万条视频时再考虑 bitset 或 minhash。
 */
export function tagSets(db: Database.Database): Map<number, Set<string>> {
  const rows = db.prepare(`SELECT tag_id, item_id FROM item_tags`).all() as
    { tag_id: number; item_id: string }[];
  const out = new Map<number, Set<string>>();
  for (const r of rows) {
    const s = out.get(r.tag_id);
    if (s) s.add(r.item_id);
    else out.set(r.tag_id, new Set([r.item_id]));
  }
  return out;
}

/**
 * tagId → 它的子树(含自己)。规则匹配(C11 选父命中所有后代)和集合判据都靠它。
 *
 * 一次遍历算完再回填 —— 不用递归 SQL:词库是几千个量级,全内存比递归 CTE 好读。
 */
export function subtreeSets(db: Database.Database): Map<number, Set<number>> {
  const rows = db.prepare(`SELECT id, parent_id FROM tags`).all() as
    { id: number; parent_id: number | null }[];
  const childrenOf = new Map<number, number[]>();
  for (const r of rows) {
    if (r.parent_id === null) continue;
    const arr = childrenOf.get(r.parent_id);
    if (arr) arr.push(r.id);
    else childrenOf.set(r.parent_id, [r.id]);
  }

  const out = new Map<number, Set<number>>();
  const build = (id: number): Set<number> => {
    const cached = out.get(id);
    if (cached) return cached;
    const set = new Set<number>([id]);
    out.set(id, set); // 先放进去,防环(手改库造出环时不至于死循环)
    for (const c of childrenOf.get(id) ?? []) for (const x of build(c)) set.add(x);
    return set;
  };
  for (const r of rows) build(r.id);
  return out;
}

/**
 * 把 from 并进 to:条目改挂、子节点改挂、旧名进别名表、规则里的 id 重写、旧节点删掉。
 *
 * **这就是为什么要用关联表而不是一列 JSON** —— 字符串数组做不到"改一次词,
 * 所有视频跟着走"。
 *
 * **先过和挂父同一套闸。** 它换的是整棵子树(子节点跟着改父),所以两条都可能踩:
 * 并进**自己的后代**会造环,并进深层节点会超深。而它走的是裸 SQL,绕过了
 * `setTagParent` —— 闸必须在这儿再查一次。
 *
 * 返回 false = 这两个词不能并(**不是抛错**):用户在下拉里挑错目标很正常,
 * 质检判错也很正常,那都该是"这次不动",不该炸掉整轮。
 */
export function mergeTags(db: Database.Database, fromId: number, toId: number): boolean {
  if (fromId === toId) return false;
  if (isDescendant(db, toId, fromId)) return false; // to 是 from 的后代 → 会成环
  if (wouldExceedDepth(db, fromId, toId)) return false;
  db.transaction(() => {
    const from = db.prepare(`SELECT name FROM tags WHERE id = ?`).get(fromId) as
      | { name: string }
      | undefined;
    // 已经挂到目标的条目:直接丢,别撞 PK
    db.prepare(
      `UPDATE item_tags SET tag_id = ?
        WHERE tag_id = ? AND item_id NOT IN (SELECT item_id FROM item_tags WHERE tag_id = ?)`,
    ).run(toId, fromId, toId);
    db.prepare(`DELETE FROM item_tags WHERE tag_id = ?`).run(fromId);
    db.prepare(`UPDATE tags SET parent_id = ? WHERE parent_id = ?`).run(toId, fromId);
    if (from) addAlias(db, from.name, toId);
    db.prepare(`UPDATE tag_aliases SET tag_id = ? WHERE tag_id = ?`).run(toId, fromId);

    // §9F C16:**规则里引用 fromId 的地方改成 toId**,再删节点。
    // 顺序很重要:先重写再删 —— 反过来的话任何一步失败,规则里就留下一串死 id。
    // 不重写的话那条规则会**静默停止命中**,而界面上的条件渲染成空串 ——
    // 用户完全看不出自己的规则已经不生效了
    rewriteRuleTagIds(db, (t) => (t === fromId ? toId : t));

    db.prepare(`DELETE FROM tags WHERE id = ?`).run(fromId);
  })();
  return true;
}

/**
 * 挂父 —— **树结构的唯一收口**,两道闸都在这儿。
 *
 * 为什么不放在各调用点:挂父有四条路(质检的 move、判据的 reparent、手动 PATCH、
 * 手动合并的批量改父)。分散着写必然漏,而漏掉**挂到自己后代**那一处的后果是
 * **造出环** —— 环上的节点全都不是 root,`listTagTree` 把它们塞进自己的 children,
 * 于是整段子树从页面上消失(库里还在)。
 *
 * 返回 false = 这次挂父被拒(自己挂自己 / 挂到自己后代 / 会超深)。调用方**不该**
 * 因此报错 —— 这是"这条改动不合法",不是"出故障了"。
 *
 * ponytail: 每次全表读一遍父边。树是几千个词、挂父是低频操作(每轮几十次),
 * 值不上把父边缓存在调用方传进来。真变成热点再说。
 */
export function setTagParent(
  db: Database.Database,
  id: number,
  parentId: number | null,
): boolean {
  if (id === parentId) return false;
  if (parentId !== null && isDescendant(db, parentId, id)) return false; // 挂到自己后代 → 成环
  if (parentId !== null && wouldExceedDepth(db, id, parentId)) return false;
  db.prepare(`UPDATE tags SET parent_id = ? WHERE id = ?`).run(parentId, id);
  return true;
}

/**
 * node 是不是 anc 的后代(anc 在不在它的祖先链上)—— 防环。
 *
 * **导出**给 `tagtree.ts` 用:判据要拿它挡"把子节点并进父"。
 * 那边不能用自己内存里的父边快照 —— 同一轮里先发生的合并会改变库里的父子关系,
 * 而快照是循环开始时的,闸门会被穿透(见 `reconcile` 里那段注释)。
 */
export function isDescendant(db: Database.Database, node: number, anc: number): boolean {
  const parentOf = new Map(
    (db.prepare(`SELECT id, parent_id FROM tags`).all() as
      { id: number; parent_id: number | null }[]).map((r) => [r.id, r.parent_id]),
  );
  let cur: number | null | undefined = node;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    if (cur === anc) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/**
 * 改名。返回 false = 这个名字已经被别的节点占了(全局唯一,撞了就改不了)。
 *
 * **撞名不自动合并** —— 那是"合并"按钮的事。改名是人的操作,悄悄把两个词并掉
 * 比报个错糟得多。
 */
export function renameTag(db: Database.Database, id: number, name: string): boolean {
  const norm = normalizeTagName(name);
  if (!norm) return false;

  let ok = false;
  db.transaction(() => {
    const prev = db.prepare(`SELECT name FROM tags WHERE id = ?`).get(id) as
      | { name: string }
      | undefined;
    if (!prev) return;
    if (db.prepare(`SELECT id FROM tags WHERE norm = ? AND id <> ?`).get(norm, id)) return;

    db.prepare(`UPDATE tags SET name = ?, norm = ? WHERE id = ?`).run(name.trim(), norm, id);
    // 旧名不再是任何节点的规范名(刚被腾出来),所以它只可能出现在别名表里 ——
    // 记一笔,老引用还找得到它
    addAlias(db, prev.name, id);
    ok = true;
  })();
  return ok;
}

export function deleteTag(db: Database.Database, id: number): void {
  db.transaction(() => {
    // 子节点提一级,别连带删掉一整棵 —— 删一个词不该毁掉它底下所有东西。
    // (全局唯一下这不会撞名字:每个 kid 的 norm 本来就是唯一的)
    db.prepare(`UPDATE tags SET parent_id = NULL WHERE parent_id = ?`).run(id);

    // §9F C16:**规则里引用它的 id 要一起拿掉**,否则那条规则静默失效
    rewriteRuleTagIds(db, (t) => (t === id ? null : t));

    db.prepare(`DELETE FROM item_tags WHERE tag_id = ?`).run(id);
    db.prepare(`DELETE FROM tag_aliases WHERE tag_id = ?`).run(id);
    db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
  })();
}

/**
 * 词库树的封顶(C2/C6):最深 4 层(根算第 1 层)。
 *
 * 为什么封顶:模型和判据都可能越走越深(`体育/篮球/NBA/湖人/詹姆斯`),而一棵
 * 深成一条线的树是**目录**不是分类 —— 它再也帮不上"各个象限上的分类"。
 */
export const MAX_TAG_DEPTH = 4;

/** 节点自己的深度。找不到(脏数据)→ 1,宁可按浅的算 */
export function depthOf(db: Database.Database, id: number): number {
  const parentOf = new Map(
    (db.prepare(`SELECT id, parent_id FROM tags`).all() as
      { id: number; parent_id: number | null }[]).map((r) => [r.id, r.parent_id]),
  );
  let depth = 0;
  let cur: number | null | undefined = id;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    depth += 1;
    cur = parentOf.get(cur) ?? null;
  }
  return Math.max(1, depth);
}

/**
 * 把 id 挂到 parentId 下会不会超深。**挂父的每一处都要先问这一句** ——
 * 质检的 move 和判据的 reparent 各一处。超了就留原位,不是截断(截断会丢掉整棵子树)。
 */
export function wouldExceedDepth(
  db: Database.Database,
  id: number,
  parentId: number | null,
): boolean {
  if (parentId === null) return false;                 // 归到根永远不超
  if (parentId === id) return true;                    // 自己挂自己
  // 目标父的深度 + 这棵子树的**高度**(不是 id 自己的深度)
  const heightOf = (root: number): number => {
    const kids = new Map<number, number[]>();
    for (const r of db.prepare(`SELECT id, parent_id FROM tags`).all() as
      { id: number; parent_id: number | null }[]) {
      if (r.parent_id === null) continue;
      (kids.get(r.parent_id) ?? kids.set(r.parent_id, []).get(r.parent_id)!).push(r.id);
    }
    const walk = (n: number): number =>
      1 + Math.max(0, ...(kids.get(n) ?? []).map(walk));
    return walk(root);
  };
  // **+1 不能省**:id 挂上去之后自己在 depthOf(parentId) + 1 层,
  // 它子树里最深的那个还要再往下 heightOf(id) - 1 层。
  // 少了这一格,封顶就会漏成 5 层 —— spec C2/C6 写的是 ≤ 4
  return depthOf(db, parentId) + heightOf(id) > MAX_TAG_DEPTH;
}

/**
 * itemId → { 标签显示名, 形态 }。**一次查完** —— 归类一批几百条,别在渲染里逐条查。
 *
 * 两样一起回:它们同源(都是 `items` 上的 AI 派生列)、同一批消费者
 * (renderItem / 详情栏),分两个函数就是两次全表扫。
 */
export function tagInfoByItem(
  db: Database.Database,
): Map<string, { names: string[]; kind: string | null }> {
  const out = new Map<string, { names: string[]; kind: string | null }>();
  const get = (id: string) => {
    const cur = out.get(id);
    if (cur) return cur;
    const fresh = { names: [] as string[], kind: null as string | null };
    out.set(id, fresh);
    return fresh;
  };

  const rows = db
    .prepare(
      `SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
        ORDER BY it.item_id, t.name`,
    )
    .all() as { item_id: string; name: string }[];
  for (const r of rows) get(r.item_id).names.push(r.name);

  const kinds = db
    .prepare(`SELECT id, ai_kind FROM items WHERE ai_kind IS NOT NULL`)
    .all() as { id: string; ai_kind: string }[];
  for (const r of kinds) get(r.id).kind = r.ai_kind;

  return out;
}
