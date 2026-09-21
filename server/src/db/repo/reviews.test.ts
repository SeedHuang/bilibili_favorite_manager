// server/src/db/repo/reviews.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import {
  saveReviewDrafts, listReviewDrafts, setReviewDraftStatus, clearPendingReviewDrafts,
} from './reviews.js';

describe('review_drafts 存储层', () => {
  /** FK 约束:folder_id / into_id 必须指向存在的 work_folders —— fixture 先建对应工作夹子 */
  const seedWorkFolders = (db: ReturnType<typeof openDb>) => {
    db.prepare(
      `INSERT INTO work_folders (id, origin_id, name, created_at)
       VALUES (1, NULL, '甲', 1), (2, NULL, '乙', 1), (3, NULL, '丙', 1)`,
    ).run();
  };

  it('存→列:写入即 pending,pending 排前', () => {
    const db = openDb(':memory:');
    seedWorkFolders(db);
    saveReviewDrafts(db, [
      { kind: 'rule', folderId: 1, conditions: [{ field: 'title', any: ['NBA'] }], because: 'r1' },
      { kind: 'delete', folderId: 2, because: 'd1' },
    ]);
    const rule = listReviewDrafts(db).find((d) => d.kind === 'rule')!;
    setReviewDraftStatus(db, rule.id, 'adopted');
    saveReviewDrafts(db, [{ kind: 'merge', folderId: 3, intoId: 1, because: 'm1' }]);

    const drafts = listReviewDrafts(db);
    expect(drafts).toHaveLength(3);
    // pending 优先(pending 排前),同 pending 内按 id;已采纳的排最后
    expect(drafts[0]!.status).toBe('pending');
    expect(drafts[0]!.kind).toBe('delete'); // pending 里 id 最小
    expect(drafts[0]!.folderId).toBe(2);
    expect(drafts[1]!.status).toBe('pending');
    expect(drafts[1]!.kind).toBe('merge');
    expect(drafts[1]!.folderId).toBe(3);
    expect(drafts[1]!.intoId).toBe(1);
    expect(drafts[1]!.because).toBe('m1');
    expect(drafts[2]!.status).toBe('adopted');
    expect(drafts[2]!.id).toBe(rule.id);
  });

  it('清 pending 不碰已采纳;带 folderIds 只清指定夹子的 pending', () => {
    const db = openDb(':memory:');
    seedWorkFolders(db);
    saveReviewDrafts(db, [
      { kind: 'rule', folderId: 1, because: 'a' },
      { kind: 'rule', folderId: 2, because: 'b' },
    ]);
    const drafts = listReviewDrafts(db);
    setReviewDraftStatus(db, drafts.find((d) => d.folderId === 1)!.id, 'adopted');

    // 不带 folderIds:清掉全部 pending,adopted 的留着
    clearPendingReviewDrafts(db);
    const left = listReviewDrafts(db);
    expect(left).toHaveLength(1);
    expect(left[0]!.folderId).toBe(1);
    expect(left[0]!.status).toBe('adopted');

    // 带 folderIds:只清指定夹子的 pending
    saveReviewDrafts(db, [
      { kind: 'rule', folderId: 1, because: 'c' },
      { kind: 'rule', folderId: 2, because: 'd' },
    ]);
    clearPendingReviewDrafts(db, [2]);
    const after = listReviewDrafts(db);
    expect(after.filter((d) => d.status === 'pending').map((d) => d.folderId)).toEqual([1]);
  });
});
