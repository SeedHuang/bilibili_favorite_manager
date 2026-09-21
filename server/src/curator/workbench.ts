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
  sessionId?: number;
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
    sessionId: who.sessionId,
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
    sessionId: who.sessionId,
    summary: `新建夹子「${trimmed}」`,
    detail: { folderId: Number(r.lastInsertRowid) },
  });
  return Number(r.lastInsertRowid);
}

export function deleteFolder(db: Database.Database, folderId: number, who: Actor = USER): void {
  ensureWorkcopy(db);
  const f = workFolderOrThrow(db, folderId);
  assertNotLocked(db, folderId, '删除');

  const count = workItemIds(db, folderId).length;
  // 只能删空夹 —— 里面还有条目就没法表达"它们去哪了"
  if (count > 0) {
    throw new Error(`「${f.name}」里还有 ${count} 条,先把它们移走或删掉这个夹子里的条目`);
  }
  db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(folderId);

  logOperation(db, {
    kind: 'delete_folder',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: `删除空夹子「${f.name}」`,
    detail: { folderId, name: f.name },
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

  const names = froms.map((f) => `「${f.name}」`).join('、');
  logOperation(db, {
    kind: 'merge_folders',
    actor: who.actor,
    sessionId: who.sessionId,
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

  db.transaction(() => {
    for (const itemId of itemIds) {
      db.prepare(`DELETE FROM work_folder_items WHERE item_id = ?`).run(itemId);
      db.prepare(
        `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
      ).run(toFolderId, itemId);
    }
  })();

  logOperation(db, {
    kind: 'move_items',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: `移动 ${itemIds.length} 条到「${to.name}」`,
    detail: { toFolderId, itemIds: [...itemIds] },
  });
}

/**
 * 把这批条目从**所有**当前夹子里拿走一次,然后加进 `toFolderIds` 里的每一个。
 *
 * 为什么不复用 `moveItems` 循环:**`moveItems` 会先删光这个条目的所有归属再插入**,
 * 所以对同一条条目调两次(归进 A、再归进 B)会**把 A 那次删掉** ——
 * "一条条目同时在多个夹子里"(R4)会在最后一公里静默失效。
 *
 * `toFolderIds` 传空数组 = 把这批条目从所有夹子里拿走(等于移出,落「未归类」)。
 */
export function assignItems(
  db: Database.Database,
  itemIds: readonly string[],
  toFolderIds: readonly number[],
  who: Actor = USER,
): { moved: number } {
  // 空数组必须在 ensureWorkcopy **之前**早返回:否则"归 0 条"会把工作副本克隆出来
  // —— 那是一次真实的状态变更 —— 却不记任何日志(和 moveItems 同一条契约)
  if (itemIds.length === 0) return { moved: 0 };
  ensureWorkcopy(db);

  const targets = [...new Set(toFolderIds)];
  // 目标先全部校验再动数据 —— 有一个不存在就整个不执行,不留半个改动的副本
  const names = targets.map((id) => workFolderOrThrow(db, id).name);

  const ids = [...new Set(itemIds)];
  db.transaction(() => {
    const clear = db.prepare(`DELETE FROM work_folder_items WHERE item_id = ?`);
    const add = db.prepare(
      `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
    );
    for (const itemId of ids) {
      clear.run(itemId);
      for (const folderId of targets) add.run(folderId, itemId);
    }
  })();

  logOperation(db, {
    kind: 'move_items',
    actor: who.actor,
    sessionId: who.sessionId,
    summary: targets.length
      ? `把 ${ids.length} 条归进「${names.join('」「')}」`
      : `把 ${ids.length} 条移出所有夹子(变成未归类)`,
    detail: { itemIds: ids, toFolderIds: targets },
  });

  return { moved: ids.length };
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

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`,
  );
  db.transaction(() => {
    for (const itemId of itemIds) stmt.run(toFolderId, itemId);
  })();

  logOperation(db, {
    kind: 'add_items',
    actor: who.actor,
    sessionId: who.sessionId,
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

  const stmt = db.prepare(`DELETE FROM work_folder_items WHERE folder_id = ? AND item_id = ?`);
  db.transaction(() => {
    for (const itemId of itemIds) stmt.run(fromFolderId, itemId);
  })();

  logOperation(db, {
    kind: 'remove_items',
    actor: who.actor,
    sessionId: who.sessionId,
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
    sessionId: who.sessionId,
    summary: existed ? '一键还原:丢掉了全部改动' : '一键还原(本来就没有改动)',
    detail: null,
  });
}
