import type Database from 'better-sqlite3';
import { listFolders, isLockedFolder } from './folders.js';
import { listItemIdsByFolder } from './items.js';
import { hasWorkcopy, listWorkFolders, workItemIds } from './workbench.js';

/**
 * 工作台视图 —— **纯读**,改动标记是算出来的,不单独存。
 *
 * 存标记的话就有了两份真相:标记说"改名了"而 work_folders 里名字没变时,
 * 你没法知道该信哪个。算出来的永远不会自相矛盾。
 */
export type ChangeMark = 'unchanged' | 'renamed' | 'created' | 'merged' | 'removed';

export interface WorkFolderView {
  id: number;
  name: string;
  originId: number | null;
  /** 改了名前叫什么 —— 点开 ✎ 标记要能看到原值 */
  originName: string | null;
  mark: ChangeMark;
  itemCount: number;
  /** 锁定的夹子(B站 自带默认收藏夹)在界面上也不能改名/删除 */
  locked: boolean;
}

export interface RemovedFolder {
  id: number;
  name: string;
  itemCount: number;
  /** 条目并进了哪个工作夹子;null = 条目被移出别处,或者本来就是空夹 */
  intoName: string | null;
  mark: 'merged' | 'removed';
}

export function buildWorkbenchView(db: Database.Database): {
  folders: WorkFolderView[];
  removed: RemovedFolder[];
  unassignedCount: number;
} {
  // 还没有工作副本 = 你还没改过任何东西。这时候"哪些夹子被删了""多少条未归类"
  // 都是没有意义的问题 —— 返回空,而不是把每个快照夹子都报成"已删除"。
  // (首启 / 还原之后,界面要显示"B站 现在的样子",那是页面自己去读快照列表。)
  if (!hasWorkcopy(db)) {
    return { folders: [], removed: [], unassignedCount: 0 };
  }

  const snapshot = listFolders(db);
  const work = listWorkFolders(db);
  const workById = new Map(work.map((w) => [w.id, w]));

  const folders: WorkFolderView[] = work.map((w) => {
    const origin = w.originId === null ? undefined : snapshot.find((s) => s.id === w.originId);
    const renamed = origin !== undefined && origin.title !== w.name;
    return {
      id: w.id,
      name: w.name,
      originId: w.originId,
      originName: renamed ? origin.title : null,
      mark: w.originId === null ? 'created' : renamed ? 'renamed' : 'unchanged',
      itemCount: workItemIds(db, w.id).length,
      // 锁跟着**原点夹子**走:新建的同名夹子不该继承锁
      locked: origin !== undefined && isLockedFolder(db, origin),
    };
  });

  // 快照里有、工作副本里没了 —— 要么是合并(条目搬去了别处),要么是删空夹
  const claimedOrigins = new Set(work.map((w) => w.originId).filter((x): x is number => x !== null));
  const removed: RemovedFolder[] = [];

  // 两个查询对每个夹子/条目都是同一条语句,prepare 提到循环外 —— 免得 64 个夹子
  // 每个都重新编译一遍 SQL
  const wasInSnapshot = db.prepare(
    `SELECT 1 AS hit FROM folder_items WHERE folder_id = ? AND item_id = ?`,
  );
  const targetsOfItem = db.prepare(`SELECT folder_id FROM work_folder_items WHERE item_id = ?`);

  for (const s of snapshot) {
    if (claimedOrigins.has(s.id)) continue;

    const itemIds = listItemIdsByFolder(db, s.id);

    // 这些条目现在都落在哪个工作夹子里?只有一个去处才算"并入它"
    const targets = new Set<number>();
    for (const itemId of itemIds) {
      const rows = targetsOfItem.all(itemId) as { folder_id: number }[];
      for (const r of rows) targets.add(r.folder_id);
    }

    const only = targets.size === 1 ? workById.get([...targets][0]!) : undefined;

    // merged 只在"条目**真的从别处来了**"时才说。
    // 反例(可达):8={BV3} 且 7={BV1,BV3},把 BV3 从 8 移走再删掉空夹 8 ——
    // BV3 现在只落在 7,但它在原快照里本来就在 7,没有发生过任何合并。
    // 判据:至少有一条 item 在原快照里不属于目标夹子(对目标而言它是新的)。
    const targetOriginId = only?.originId;
    const movedIn =
      targetOriginId != null && itemIds.some((id) => !wasInSnapshot.get(targetOriginId, id));

    removed.push({
      id: s.id,
      name: s.title,
      itemCount: itemIds.length,
      intoName: movedIn ? (only?.name ?? null) : null,
      mark: itemIds.length > 0 && only !== undefined && movedIn ? 'merged' : 'removed',
    });
  }

  const unassignedCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i
          WHERE NOT EXISTS (SELECT 1 FROM work_folder_items w WHERE w.item_id = i.id)`,
      )
      .get() as { n: number }
  ).n;

  return { folders, removed, unassignedCount };
}
