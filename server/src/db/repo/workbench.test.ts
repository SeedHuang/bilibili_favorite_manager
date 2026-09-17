import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertFolder } from './folders.js';
import { upsertItem, linkFolderItem } from './items.js';
import { setState, stateKey } from './state.js';
import {
  hasWorkcopy,
  getWorkState,
  ensureWorkcopy,
  listWorkFolders,
  workItemIds,
  resetWorkcopy,
} from './workbench.js';

/** 快照:2 个夹子、3 条条目,其中 BV1 同时在两个夹子里(B站 支持) */
function seeded() {
  const db = openDb(':memory:');
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertFolder(db, { id: 8, title: '编程', mediaCount: 2 });
  for (const id of ['BV1', 'BV2', 'BV3']) upsertItem(db, { id, type: 2, title: id });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
  linkFolderItem(db, 8, 'BV1', 1);
  linkFolderItem(db, 8, 'BV3', 1);
  setState(db, stateKey.lastFull, '1700000000000');
  return db;
}

describe('工作副本', () => {
  it('没建过时 hasWorkcopy 为 false', () => {
    const db = seeded();
    expect(hasWorkcopy(db)).toBe(false);
    expect(getWorkState(db)).toBeNull();
  });

  it('克隆出来的每个夹子都指向快照里的原点', () => {
    const db = seeded();
    ensureWorkcopy(db);
    const rows = listWorkFolders(db);
    expect(rows.map((r) => [r.originId, r.name])).toEqual([
      [7, '深度学习'],
      [8, '编程'],
    ]);
  });

  it('克隆出来的归属与快照逐行相等', () => {
    const db = seeded();
    ensureWorkcopy(db);
    const [a, b] = listWorkFolders(db);
    expect(workItemIds(db, a!.id).sort()).toEqual(['BV1', 'BV2']);
    expect(workItemIds(db, b!.id).sort()).toEqual(['BV1', 'BV3']);
  });

  it('克隆是幂等的 —— 已有副本时再调用不会翻倍', () => {
    const db = seeded();
    ensureWorkcopy(db);
    ensureWorkcopy(db);
    expect(listWorkFolders(db)).toHaveLength(2);
  });

  it('based_on 记的是克隆那一刻的上次全量同步时间', () => {
    const db = seeded();
    ensureWorkcopy(db);
    expect(getWorkState(db)!.basedOn).toBe(1700000000000);
  });

  it('reset 清空 work_* 与 work_state,快照一行不动', () => {
    const db = seeded();
    ensureWorkcopy(db);
    resetWorkcopy(db);

    expect(hasWorkcopy(db)).toBe(false);
    expect(listWorkFolders(db)).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM work_folder_items`).get()).toEqual({ n: 0 });
    // 快照没被动过
    expect(db.prepare(`SELECT COUNT(*) AS n FROM folders`).get()).toEqual({ n: 2 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM folder_items`).get()).toEqual({ n: 4 });
  });

  it('快照是空的也能克隆(空副本,不是崩)', () => {
    const db = openDb(':memory:');
    ensureWorkcopy(db);
    expect(hasWorkcopy(db)).toBe(true);
    expect(listWorkFolders(db)).toEqual([]);
  });
});

/**
 * 契约测试 —— 守的是**数据库层**的约束本身,不是某段应用代码的行为。
 *
 * 这几条约束是 spec 刻意下沉到 DDL 的:"全局唯一一份工作副本"、
 * "删夹子不留孤儿归属"。如果只靠应用代码自觉,后人一次重构就能
 * 静默改掉而测试全绿。所以这里直接对着裸 SQL 验,绕开 repo 函数。
 */
describe('工作副本 · 数据库层契约', () => {
  it('work_state 只能有一行 —— 插第二行必须被 CHECK 挡住', () => {
    // 守 `CHECK (id = 1)`:唯一性钉在数据库层,多套竞争方案是旧的错误模型。
    // 光删掉这行 CHECK,7 个功能测试照样全绿 —— 所以必须单独验。
    // 注意此刻 id=1 已存在,插 id=2 不撞主键,能抛错只可能是 CHECK 咬人。
    const db = seeded();
    ensureWorkcopy(db);

    expect(() =>
      db
        .prepare(`INSERT INTO work_state (id, based_on, created_at) VALUES (2, 0, 0)`)
        .run(),
    ).toThrow();
    // 抛完之后原样一份还在,没被插成两行
    expect(db.prepare(`SELECT COUNT(*) AS n FROM work_state`).get()).toEqual({ n: 1 });
  });

  it('删 work_folders 一行,它的归属跟着级联没 —— 不留孤儿', () => {
    // 守 `work_folder_items.folder_id ... ON DELETE CASCADE`。
    // resetWorkcopy 是先删子表再删父表,永远走不到级联这条路径,
    // 所以功能测试覆盖不到它。而 deleteFolder / mergeFolders 依赖级联,
    // 它坏了就会留下指向不存在夹子的归属行。
    const db = seeded();
    ensureWorkcopy(db);
    const target = listWorkFolders(db)[0]!; // 装着 BV1 / BV2 的那个
    expect(workItemIds(db, target.id).sort()).toEqual(['BV1', 'BV2']);

    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(target.id);

    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM work_folder_items WHERE folder_id = ?`).get(target.id),
    ).toEqual({ n: 0 });
    // 级联只清这一家,别家的归属一根不动
    const other = listWorkFolders(db)[0]!;
    expect(workItemIds(db, other.id).sort()).toEqual(['BV1', 'BV3']);
  });
});
