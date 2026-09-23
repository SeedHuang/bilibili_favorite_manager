import type Database from 'better-sqlite3';
import {
  ensureWorkcopy,
  hasWorkcopy,
  listWorkFolders,
  workItemIds,
  resetWorkcopy,
} from '../db/repo/workbench.js';
import { listFolders, isLockedFolder } from '../db/repo/folders.js';
import { logOperation, type OpActor } from '../db/repo/operations.js';

/**
 * 编辑动作 —— 每个动作 = 改工作副本 + **必记一条日志**。
 *
 * 日志写在这里而不是路由里,是为了让"漏记"变得不可能:只要动作走了这个模块,
 * 就一定留痕。路由直接改表就会绕过它,所以 §9B.7 约束 1 说编辑只许写 work_*
 * 表 —— 而写 work_* 表的唯一入口是这里。
 */
export interface Actor {
  actor: OpActor;
}

const USER: Actor = { actor: 'user' };

function workFolderOrThrow(db: Database.Database, id: number) {
  const f = listWorkFolders(db).find((w) => w.id === id);
  if (!f) throw new Error(`工作副本里没有夹子 ${id}`);
  return f;
}

/** 锁定的夹子不能改名、不能删除 —— 但可以往里移条目 */
function assertNotLocked(db: Database.Database, workFolderId: number, action: string): void {
  const w = workFolderOrThrow(db, workFolderId);
  if (w.originId === null) return; // 新建的夹子不继承锁
  const origin = listFolders(db).find((f) => f.id === w.originId);
  if (origin && isLockedFolder(db, origin)) {
    throw new Error(`「${origin.title}」是 B站 自带的默认收藏夹,不能${action}`);
  }
}

export function renameFolder(
  db: Database.Database,
  folderId: number,
  name: string,
  who: Actor = USER,
): void {
  ensureWorkcopy(db);
  const trimmed = name.trim();
  if (!trimmed) throw new Error('名字不能为空');
  if ([...trimmed].length > 20) throw new Error('夹子名最长 20 个字(B 站限制)');
  assertNotLocked(db, folderId, '改名');

  const before = workFolderOrThrow(db, folderId);
  db.prepare(`UPDATE work_folders SET name = ? WHERE id = ?`).run(trimmed, folderId);

  const originName = before.originId === null
    ? null
    : (listFolders(db).find((f) => f.id === before.originId)?.title ?? null);

  logOperation(db, {
    kind: 'rename_folder',
    actor: who.actor,
    summary: originName
      ? `把「${originName}」改名为「${trimmed}」`
      : `把「${before.name}」改名为「${trimmed}」`,
    detail: { folderId, from: before.name, to: trimmed },
  });
}

export function createFolder(db: Database.Database, name: string, who: Actor = USER): number {
  ensureWorkcopy(db);
  const trimmed = name.trim();
  if (!trimmed) throw new Error('名字不能为空');
  // B 站收藏夹名上限 20 字 —— 本地建超长的能建,但同步到 B 站会被拒;
  // 在唯一的建夹子入口兜底(改名入口另查),让错误在最早一步暴露
  if ([...trimmed].length > 20) throw new Error('夹子名最长 20 个字(B 站限制)');

  const r = db
    .prepare(`INSERT INTO work_folders (origin_id, name, created_at) VALUES (NULL, ?, ?)`)
    .run(trimmed, Date.now());

  logOperation(db, {
    kind: 'create_folder',
    actor: who.actor,
    summary: `新建夹子「${trimmed}」`,
    detail: { folderId: Number(r.lastInsertRowid) },
  });
  return Number(r.lastInsertRowid);
}

export function deleteFolder(db: Database.Database, folderId: number, who: Actor = USER): void {
  ensureWorkcopy(db);
  const f = workFolderOrThrow(db, folderId);
  assertNotLocked(db, folderId, '删除');
  if (who.actor === 'ai' && !isAiFolder(db, folderId)) {
    throw new Error(`「${f.name}」是人类建立的夹子,AI 不能删除它`);
  }

  const members = workItemIds(db, folderId);
  let backedUp = 0;
  db.transaction(() => {
    if (members.length > 0) backedUp = ensureDefaultMembership(db, members); // 删夹不删视频:先兜底
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(folderId);
  })();

  logOperation(db, {
    kind: 'delete_folder',
    actor: who.actor,
    summary:
      members.length > 0
        ? `删除夹子「${f.name}」(${backedUp}/${members.length} 条已兜底进默认收藏夹)`
        : `删除空夹子「${f.name}」`,
    detail: { folderId, name: f.name, memberCount: members.length },
  });
}

/**
 * 合并 = 把 from 的条目搬进 into、再删掉空的 from。
 *
 * **这是两步实现、一个动作**:用户说的是"合并",不该让他自己做
 * "移走 + 删除空夹"。实现细节不外露。
 *
 * 源夹子锁定则拒绝:合并的第二步就是删掉 from,而锁定夹子不能删除 ——
 * 放它过去会做出一个写回 B站 时必然失败的工作副本。
 */
/**
 * 把 fromIds 里的条目全都搬进 intoId,再把搬空了的源夹子删掉。
 *
 * 支持 N 个源:界面上的两个入口(夹子行的「合并」/ 顶栏的「移动并删除这 N 个夹子」)
 * 都走这里 —— 一个动作两种入口,不发明新概念。
 *
 * **锁定的源夹子直接拒**(和改名、删除同一条规则)。
 * 曾经这里写的是"照搬条目但留下夹子",理由是"默认收藏夹有 88% 的条目,
 * 得能批量清空" —— 那个理由站不住:默认收藏夹里的东西要的是**分类**,
 * 不是整体倒进另一个夹子(那只是换个地方堆)。而"清空文件夹"从来不是
 * 我们提供的能力。所以规则收成一条:**锁定 = 这三个动作都不能碰它。**
 */
export function mergeFolders(
  db: Database.Database,
  fromIds: readonly number[],
  intoId: number,
  who: Actor = USER,
): { moved: number } {
  ensureWorkcopy(db);
  const sources = [...new Set(fromIds)];
  if (sources.length === 0) throw new Error('没有要处理的夹子');
  if (sources.includes(intoId)) throw new Error('目标夹子也在要处理的夹子里');

  const into = workFolderOrThrow(db, intoId);
  const froms = sources.map((id) => workFolderOrThrow(db, id));
  for (const f of froms) assertNotLocked(db, f.id, '移动并删除');

  if (who.actor === 'ai') {
    const human = froms.filter((f) => !isAiFolder(db, f.id));
    if (human.length > 0) {
      throw new Error(`「${human[0]!.name}」是人类建立的夹子,AI 不能合并或删除它`);
    }
  }
  // AI 源的规则要在删夹子**之前**取出来 —— CASCADE 会把它们带走(洞 5)
  const aiRules = froms
    .filter((f) => isAiFolder(db, f.id))
    .map((f) => getRule(db, f.id))
    .filter((r): r is NonNullable<typeof r> => r !== null && r.conditions.length > 0);

  const moved = new Set(froms.flatMap((f) => workItemIds(db, f.id)));

  db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
    );
    for (const itemId of moved) insert.run(intoId, itemId);
    for (const f of froms) {
      db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(f.id);
    }
  })();

  // 合并不驱逐(洞 5):AI 源的规则并进目标,源成员里不命中目标规则的下次对账才不会
  // 全被清出。"合并"悄悄变成"合并 + 驱逐"是绝不能发生的。
  if (aiRules.length > 0) {
    const seen = new Set<string>();
    const union = [
      ...(getRule(db, intoId)?.conditions ?? []),
      ...aiRules.flatMap((r) => r.conditions),
    ].filter((c) => {
      const key = `${c.field}|${[...c.any].sort().join(',')}`;
      if (seen.has(key) || c.any.length === 0) return false;
      seen.add(key);
      return true;
    });
    if (union.length > 0) saveRule(db, intoId, union, 'ai');
  }

  const names = froms.map((f) => `「${f.name}」`).join('、');
  logOperation(db, {
    kind: 'merge_folders',
    actor: who.actor,
    summary:
      froms.length === 1
        ? `把「${froms[0]!.name}」(${moved.size} 条)并入并删除,进了「${into.name}」`
        : `把 ${names} 的 ${moved.size} 条移动并删除,并入「${into.name}」`,
    detail: { fromIds: sources, intoId, itemIds: [...moved] },
  });

  return { moved: moved.size };
}

/** 移动:**离开原处**,放进目标。用户说"移动"就是不想保留原来那份归属。 */
export function moveItems(
  db: Database.Database,
  itemIds: readonly string[],
  toFolderId: number,
  who: Actor = USER,
): void {
  // 空数组必须在 ensureWorkcopy **之前**早返回:否则"移动 0 条"会把工作副本克隆出来
  // —— 那是一次真实的状态变更 —— 却不记任何日志,契约 2 就有个口子
  if (itemIds.length === 0) return;
  ensureWorkcopy(db);
  const to = workFolderOrThrow(db, toFolderId);
  // AI 夹子不是落点(洞 4):成员=规则命中集,直接移入下次对账必被清出 —— AI 夹的成员只能由规则决定
  if (isAiFolder(db, toFolderId)) {
    throw new Error(`「${to.name}」是 AI 建的夹子,成员由它的规则决定 —— 请采纳规则建议,不要直接移入`);
  }

  const aiIds = listAiFolderIds(db);
  db.transaction(() => {
    for (const itemId of itemIds) {
      const current = (
        db.prepare(`SELECT folder_id FROM work_folder_items WHERE item_id = ?`).all(itemId) as
          { folder_id: number }[]
      ).map((r) => r.folder_id);
      for (const folderId of current) {
        if (aiIds.has(folderId)) continue; // AI 夹的归属只能由 reconcile 拿走
        db.prepare(`DELETE FROM work_folder_items WHERE item_id = ? AND folder_id = ?`).run(itemId, folderId);
      }
      db.prepare(
        `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
      ).run(toFolderId, itemId);
    }
  })();

  logOperation(db, {
    kind: 'move_items',
    actor: who.actor,
    summary: `移动 ${itemIds.length} 条到「${to.name}」`,
    detail: { toFolderId, itemIds: [...itemIds] },
  });
}

/** 也放进:**保留原处**,同时加进目标(B站 允许一个视频属于多个夹子) */
export function addItems(
  db: Database.Database,
  itemIds: readonly string[],
  toFolderId: number,
  who: Actor = USER,
): void {
  // 同 moveItems:早返回先于 ensureWorkcopy,别让"放进 0 条"白克隆一份副本
  if (itemIds.length === 0) return;
  ensureWorkcopy(db);
  const to = workFolderOrThrow(db, toFolderId);
  // AI 夹子不是落点(洞 4)—— 和 moveItems 同一道闸
  if (isAiFolder(db, toFolderId)) {
    throw new Error(`「${to.name}」是 AI 建的夹子,成员由它的规则决定 —— 请采纳规则建议,不要直接移入`);
  }

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
  );
  db.transaction(() => {
    for (const itemId of itemIds) stmt.run(toFolderId, itemId);
  })();

  logOperation(db, {
    kind: 'add_items',
    actor: who.actor,
    summary: `把 ${itemIds.length} 条也放进「${to.name}」`,
    detail: { toFolderId, itemIds: [...itemIds] },
  });
}

/** 移出:只从这个夹子拿走,不放别处 —— 拿走后可能变成"未归类" */
export function removeItems(
  db: Database.Database,
  itemIds: readonly string[],
  fromFolderId: number,
  who: Actor = USER,
): void {
  // 同 moveItems:早返回先于 ensureWorkcopy,别让"移出 0 条"白克隆一份副本
  if (itemIds.length === 0) return;
  ensureWorkcopy(db);
  const from = workFolderOrThrow(db, fromFolderId);
  if (isAiFolder(db, fromFolderId)) {
    throw new Error(`「${from.name}」是 AI 建的夹子,成员由规则决定 —— 改规则(采纳建议)才能移出条目`);
  }

  const stmt = db.prepare(`DELETE FROM work_folder_items WHERE folder_id = ? AND item_id = ?`);
  db.transaction(() => {
    for (const itemId of itemIds) stmt.run(fromFolderId, itemId);
  })();

  logOperation(db, {
    kind: 'remove_items',
    actor: who.actor,
    summary: `从「${from.name}」移出 ${itemIds.length} 条`,
    detail: { fromFolderId, itemIds: [...itemIds] },
  });
}

/** 一键还原 —— 丢掉工作副本,回到快照 */
export function resetWorkbench(db: Database.Database, who: Actor = USER): void {
  const existed = hasWorkcopy(db);
  resetWorkcopy(db);

  logOperation(db, {
    kind: 'reset',
    actor: who.actor,
    summary: existed ? '一键还原:丢掉了全部改动' : '一键还原(本来就没有改动)',
    detail: null,
  });
}

import { listAiFolderIds, isAiFolder } from '../db/repo/aiFolders.js';
import { getRule, saveRule } from '../db/repo/rules.js';
import { matchAll, toRuleItem } from './rules.js';
import { itemTagIds, subtreeSets } from '../db/repo/tags.js';
import type { ItemRow } from '../db/repo/items.js';
import type { RuleCondition } from '../db/repo/rules.js';

/** 默认收藏夹(锁定夹子)的工作副本 id;没有就 null —— 安全网没有落点时如实不兜底 */
export function defaultWorkFolderId(db: Database.Database): number | null {
  for (const w of listWorkFolders(db)) {
    if (w.originId === null) continue;
    const origin = listFolders(db).find((f) => f.id === w.originId);
    if (origin && isLockedFolder(db, origin)) return w.id;
  }
  return null;
}

/**
 * 安全网(字面版,spec §4):这批条目里不在默认收藏夹的,补进默认收藏夹。
 * **不做"有没有别的家"的判断** —— 用户拍板:哪怕它在别的夹子里活着也照补。
 * 代价(默认夹会变大)已知且接受,见 spec §4。
 */
export function ensureDefaultMembership(db: Database.Database, itemIds: readonly string[]): number {
  const defaultId = defaultWorkFolderId(db);
  if (defaultId === null || itemIds.length === 0) return 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
  );
  let added = 0;
  for (const itemId of itemIds) {
    added += insert.run(defaultId, itemId).changes;
  }
  return added;
}

/**
 * AI 夹子对账:成员 = 规则命中集。缺的补进;多的走安全网后清出。
 * 这是 AI 夹子成员的**唯一**写手 —— 其余成员变更入口(moveItems / addItems /
 * removeItems)一律拒绝 AI 夹子,两边合起来
 * 才把"成员恒等于命中集"钉死。
 */
export function reconcileAiFolder(
  db: Database.Database,
  folderId: number,
  who: Actor = USER,
): { added: number; removed: number } {
  ensureWorkcopy(db);
  const f = workFolderOrThrow(db, folderId);
  if (!listAiFolderIds(db).has(folderId)) throw new Error(`「${f.name}」不是 AI 建的夹子`);

  const rule = db
    .prepare(
      `SELECT conditions_json, origin, updated_at FROM work_folder_rules WHERE folder_id = ?`,
    )
    .get(folderId) as
    | { conditions_json: string; origin: 'ai' | 'user'; updated_at: number }
    | undefined;
  const conditions: RuleCondition[] = rule
    ? (JSON.parse(rule.conditions_json) as RuleCondition[])
    : [];

  const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
  const tagsOf = itemTagIds(db);
  const matched = conditions.length
    ? matchAll(
        items.map((i) => ({ ...toRuleItem(i), tagIds: tagsOf.get(i.id) ?? [] })),
        [{ folderId, conditions, origin: rule!.origin, updatedAt: rule!.updated_at }],
        { subtree: subtreeSets(db) },
      )
    : new Map<string, { folderId: number }[]>();
  const want = new Set(matched.keys());
  const have = new Set(workItemIds(db, folderId));

  const toAdd = [...want].filter((id) => !have.has(id));
  const toRemove = [...have].filter((id) => !want.has(id));

  let backedUp = 0;
  db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
    );
    const del = db.prepare(`DELETE FROM work_folder_items WHERE folder_id = ? AND item_id = ?`);
    for (const itemId of toAdd) insert.run(folderId, itemId);
    if (toRemove.length > 0) backedUp = ensureDefaultMembership(db, toRemove); // 安全网,先兜底再清出
    for (const itemId of toRemove) del.run(folderId, itemId);
  })();

  if (toAdd.length + toRemove.length > 0) {
    logOperation(db, {
      kind: 'move_items',
      actor: who.actor,
      summary:
        toRemove.length > 0
          ? `对账「${f.name}」:补进 ${toAdd.length} 条,清出 ${toRemove.length} 条(已兜底默认收藏夹 ${backedUp}/${toRemove.length} 条)`
          : `对账「${f.name}」:补进 ${toAdd.length} 条`,
      detail: { folderId, added: toAdd, removed: toRemove },
    });
  }
  return { added: toAdd.length, removed: toRemove.length };
}

/**
 * 人类夹子的整理:把规则命中集里缺的成员补进来 —— **只加,不清**。
 * 存量成员哪怕不命中规则也原样保留(用户 2026-09-21 的红线)。
 */
export function applyRuleHitsToFolder(
  db: Database.Database,
  folderId: number,
  who: Actor = USER,
): { added: number } {
  ensureWorkcopy(db);
  const f = workFolderOrThrow(db, folderId);
  if (listAiFolderIds(db).has(folderId)) throw new Error(`「${f.name}」是 AI 夹子,请走对账`);

  const rule = db
    .prepare(
      `SELECT conditions_json, origin, updated_at FROM work_folder_rules WHERE folder_id = ?`,
    )
    .get(folderId) as
    | { conditions_json: string; origin: 'ai' | 'user'; updated_at: number }
    | undefined;
  const conditions: RuleCondition[] = rule
    ? (JSON.parse(rule.conditions_json) as RuleCondition[])
    : [];
  if (conditions.length === 0) return { added: 0 };

  const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
  const tagsOf = itemTagIds(db);
  const matched = matchAll(
    items.map((i) => ({ ...toRuleItem(i), tagIds: tagsOf.get(i.id) ?? [] })),
    [{ folderId, conditions, origin: rule!.origin, updatedAt: rule!.updated_at }],
    { subtree: subtreeSets(db) },
  );
  const have = new Set(workItemIds(db, folderId));
  const toAdd = [...matched.keys()].filter((id) => !have.has(id));
  if (toAdd.length === 0) return { added: 0 };

  let added = 0;
  db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
    );
    for (const itemId of toAdd) added += insert.run(folderId, itemId).changes;
  })();
  logOperation(db, {
    kind: 'add_items',
    actor: who.actor,
    summary: `整理「${f.name}」:按规则补进 ${added} 条(只加不清)`,
    detail: { folderId, added: toAdd },
  });
  return { added };
}
