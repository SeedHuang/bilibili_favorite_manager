import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertFolder } from './folders.js';
import { upsertItem, linkFolderItem } from './items.js';
import { ensureWorkcopy, listWorkFolders, resetWorkcopy } from './workbench.js';
import { listRules, getRule, saveRule, deleteRule } from './rules.js';

/** 种一个快照 + 克隆出工作副本,返回工作夹子的 id */
function seeded() {
  const db = openDb(':memory:');
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 1 });
  upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
  linkFolderItem(db, 7, 'BV1', 1);
  ensureWorkcopy(db);
  const work = listWorkFolders(db)[0]!;
  return { db, folderId: work.id };
}

describe('规则仓储', () => {
  it('没存过时 listRules 是空的(克隆不继承规则)', () => {
    const { db } = seeded();
    expect(listRules(db)).toEqual([]);
  });

  it('存了能读回完整结构', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['Python', 'JS'] }], 'user');

    const r = getRule(db, folderId)!;
    expect(r.folderId).toBe(folderId);
    expect(r.conditions).toEqual([{ field: 'title', any: ['Python', 'JS'] }]);
    expect(r.origin).toBe('user');
    expect(r.updatedAt).toBeGreaterThan(0);
  });

  it('一个夹子只有一组规则 —— 再存是覆盖不是追加', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['A'] }], 'user');
    saveRule(db, folderId, [{ field: 'intro', any: ['B'] }], 'ai');

    expect(listRules(db)).toHaveLength(1);
    expect(getRule(db, folderId)!.conditions[0]!.field).toBe('intro');
    // origin 跟着最后一次写的人走 —— 否则界面上的 🤖/✎ 会撒谎
    expect(getRule(db, folderId)!.origin).toBe('ai');
  });

  it('删掉规则后读回来是 null,列表里也不留空行', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['A'] }], 'user');
    deleteRule(db, folderId);

    expect(getRule(db, folderId)).toBeNull();
    expect(listRules(db)).toEqual([]);
  });

  it('删掉规则不碰夹子本身', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['A'] }], 'user');
    deleteRule(db, folderId);
    expect(listWorkFolders(db).some((f) => f.id === folderId)).toBe(true);
  });

  // 一键还原是"清空 work_folders" → CASCADE 应该把规则一起带走。
  // 不带走的话会留下孤儿规则,"命中几条"就开始骗人(spec §9C.6 约束 5)。
  it('一键还原 → 规则跟着走(CASCADE)', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['A'] }], 'user');
    resetWorkcopy(db);
    expect(listRules(db)).toEqual([]);
  });

  it('删夹子 → 它的规则跟着走(CASCADE)', () => {
    const { db, folderId } = seeded();
    saveRule(db, folderId, [{ field: 'title', any: ['A'] }], 'user');
    db.prepare(`DELETE FROM work_folders WHERE id = ?`).run(folderId);
    expect(listRules(db)).toEqual([]);
  });
});
