import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertFolder } from './folders.js';
import { upsertItem, linkFolderItem } from './items.js';
import { setState, stateKey } from './state.js';
import { ensureWorkcopy, listWorkFolders } from './workbench.js';
import { buildWorkbenchView } from './workbenchView.js';
import { markFolderAsAi } from './aiFolders.js';

function seeded() {
  const db = openDb(':memory:');
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertFolder(db, { id: 8, title: '不常用', mediaCount: 1 });
  upsertFolder(db, { id: 9, title: '默认收藏夹', mediaCount: 1, raw: JSON.stringify({ attr: 0 }) });
  for (const id of ['BV1', 'BV2', 'BV3', 'BV4']) upsertItem(db, { id, type: 2, title: id });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
  linkFolderItem(db, 8, 'BV3', 1);
  linkFolderItem(db, 9, 'BV4', 1);
  setState(db, stateKey.lastFull, '1000');
  ensureWorkcopy(db);
  return db;
}

const byOrigin = (db: ReturnType<typeof seeded>) =>
  new Map(listWorkFolders(db).map((f) => [f.originId, f]));

describe('工作台视图', () => {
  it('没动过的夹子标记是 unchanged', () => {
    const db = seeded();
    const v = buildWorkbenchView(db);
    expect(v.folders.map((f) => f.mark)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(v.removed).toEqual([]);
  });

  it('改名 → renamed,并带出原名', () => {
    const db = seeded();
    const f = byOrigin(db).get(7)!;
    db.prepare(`UPDATE work_folders SET name = ? WHERE id = ?`).run('AI/编程', f.id);

    const v = buildWorkbenchView(db);
    const row = v.folders.find((x) => x.originId === 7)!;
    expect(row.mark).toBe('renamed');
    expect(row.name).toBe('AI/编程');
    expect(row.originName).toBe('深度学习'); // 点开标记能看原来叫什么
  });

  it('originId 为空 → created', () => {
    const db = seeded();
    db.prepare(`INSERT INTO work_folders (origin_id, name, created_at) VALUES (NULL, '新夹子', 1)`).run();
    const v = buildWorkbenchView(db);
    expect(v.folders.find((f) => f.originId === null)!.mark).toBe('created');
  });

  it('条目数按工作副本算,不是按快照', () => {
    const db = seeded();
    const f = byOrigin(db).get(7)!;
    db.prepare(`DELETE FROM work_folder_items WHERE folder_id = ? AND item_id = 'BV2'`).run(f.id);
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (?, 'BV3')`).run(f.id);

    const v = buildWorkbenchView(db);
    expect(v.folders.find((x) => x.originId === 7)!.itemCount).toBe(2); // BV1 + BV3
  });

  it('锁定的夹子带出 locked —— 界面上仍不能改名/删除', () => {
    const db = seeded();
    const v = buildWorkbenchView(db);
    expect(v.folders.find((f) => f.originId === 9)!.locked).toBe(true);
    expect(v.folders.find((f) => f.originId === 7)!.locked).toBe(false);
  });

  it('快照里有、工作副本里没了 → 进了 removed', () => {
    const db = seeded();
    const f = byOrigin(db).get(8)!;
    // 模拟"合并进 7":条目搬过去,原夹子删掉
    db.prepare(`UPDATE work_folder_items SET folder_id = ? WHERE folder_id = ?`).run(
      byOrigin(db).get(7)!.id, f.id,
    );
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(f.id);

    const v = buildWorkbenchView(db);
    const r = v.removed.find((x) => x.id === 8)!;
    expect(r.mark).toBe('merged');
    expect(r.intoName).toBe('深度学习'); // 条目都并进了这个
    expect(r.itemCount).toBe(1);
  });

  it('快照里有、工作副本里没了,但条目没进任何地方 → removed 而非 merged', () => {
    const db = seeded();
    const f = byOrigin(db).get(8)!;
    db.prepare(`DELETE FROM work_folder_items WHERE folder_id = ?`).run(f.id);
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(f.id);

    const v = buildWorkbenchView(db);
    const r = v.removed.find((x) => x.id === 8)!;
    expect(r.mark).toBe('removed');
    expect(r.intoName).toBeNull();
  });

  it('未归类数 = 本地条目里不属于任何工作夹子的', () => {
    const db = seeded();
    upsertItem(db, { id: 'BV9', type: 2, title: '没人要' });
    const v = buildWorkbenchView(db);
    expect(v.unassignedCount).toBe(1);
  });

  it('条目本来就在目标夹子里 → 不算并入(没有东西被搬过)', () => {
    const db = seeded();
    // 快照:7={BV1,BV2,BV3}、8={BV3};工作副本要**一模一样** ——
    // 光写快照表没用:工作副本是 seeded() 里克隆出来的,两张表之间没有触发器/回填。
    db.prepare(`INSERT INTO folder_items (folder_id, item_id, fav_time) VALUES (7, 'BV3', 1)`).run();
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (?, 'BV3')`).run(
      byOrigin(db).get(7)!.id,
    );

    const w8 = byOrigin(db).get(8)!;
    // 把 BV3 从 8 移走(7 那份不动),再删掉空的 8。
    // 不需要 import T4 的 removeItems —— 直接操作工作副本表即可。
    db.prepare(`DELETE FROM work_folder_items WHERE folder_id = ? AND item_id = 'BV3'`).run(w8.id);
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(w8.id);

    const r = buildWorkbenchView(db).removed.find((x) => x.id === 8)!;
    // BV3 现在只落在 7,但它在快照里本来就在 7 —— 不能报"并入"
    expect(r.mark).toBe('removed');
    expect(r.intoName).toBeNull();
  });

  it('没建工作副本时返回空 —— 不编造"已删除"', () => {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 1, title: 'x', mediaCount: 0 });
    // 首启/还原后是这个状态。界面此时该显示"B站 现在的样子"(由页面读快照列表),
    // 而不是把用户的夹子全标成已删除。
    expect(buildWorkbenchView(db)).toEqual({ folders: [], removed: [], unassignedCount: 0 });
  });

  it('AI 标记进视图:有标记 ai=true,存量夹子 ai=false(保守默认)', () => {
    const db = seeded();
    const f = byOrigin(db).get(8)!;
    markFolderAsAi(db, f.id);
    const v = buildWorkbenchView(db);
    expect(v.folders.find((x) => x.id === f.id)!.ai).toBe(true);
    expect(v.folders.find((x) => x.originId === 7)!.ai).toBe(false);
  });
});
