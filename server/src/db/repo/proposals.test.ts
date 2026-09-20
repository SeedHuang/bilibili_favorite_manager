import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import {
  getProposal, startProposal, saveDrafts, listDrafts, setDraftStatus, sampleTitlesFor,
} from './proposals.js';

const seed = () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO items (id, type, title) VALUES ('BV1', 2, '标题A')`).run();
  db.prepare(`INSERT INTO tags (id, name, norm, created_at) VALUES (1, 'NBA', 'nba', 1), (2, '篮球', '篮球', 1)`)
    .run();
  db.prepare(`INSERT INTO item_tags (item_id, tag_id, source) VALUES ('BV1', 1, 'ai')`).run();
  // 采纳目标:adopted_folder_id 有 FK,42 号夹子得真实存在
  db.prepare(`INSERT INTO work_folders (id, name, created_at) VALUES (42, '采纳目标', 1)`).run();
  return db;
};

describe('方案 repo', () => {
  it('没有方案时 getProposal 返回 null', () => {
    const db = seed();
    expect(getProposal(db)).toBeNull();
  });

  it('startProposal 写 generating,saveDrafts 覆盖为 ready;旧草稿被清', () => {
    const db = seed();
    startProposal(db, 5);
    expect(getProposal(db)?.status).toBe('generating');
    saveDrafts(db, 5, 3, [
      { name: '第一版', reason: 'r', conditions: [], hitCount: 0, weak: false },
    ]);
    expect(getProposal(db)).toMatchObject({ level: 5, status: 'ready', uncoveredCount: 3 });

    startProposal(db, 7); // 重新生成 → 旧草稿清掉
    saveDrafts(db, 7, 0, [
      { name: '第二版', reason: 'r2', conditions: [{ field: 'tag', any: ['1'] }], hitCount: 1, weak: false },
    ]);
    const drafts = listDrafts(db);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ name: '第二版', status: 'pending' });
  });

  it('setDraftStatus 记采纳夹子;listDrafts pending 排前', () => {
    const db = seed();
    saveDrafts(db, 5, 0, [
      { name: '甲', reason: '', conditions: [], hitCount: 1, weak: false },
      { name: '乙', reason: '', conditions: [], hitCount: 1, weak: false },
    ]);
    const [d1, d2] = listDrafts(db); // 两条都 pending,按 id:甲、乙
    setDraftStatus(db, d1!.id, 'adopted', 42);
    // pending 排前:乙还是 pending,跳到甲(已 adopted)前面 —— 所以别在状态
    // 变更后重新按下标取"另一条",那会取到已经变了的甲
    expect(listDrafts(db).map((d) => d.name)).toEqual(['乙', '甲']);
    setDraftStatus(db, d2!.id, 'discarded');
    const after = listDrafts(db); // 都不 pending 了 → 按 id:甲(1) 在前,乙 排后
    expect(after[0]!.status).toBe('adopted');
    expect(after[0]!.adoptedFolderId).toBe(42);
    expect(after[1]!.status).toBe('discarded');
  });

  it('sampleTitlesFor 用 matchAll 实跑取标题', () => {
    const db = seed();
    expect(sampleTitlesFor(db, [{ field: 'tag', any: ['1'] }])).toEqual(['标题A']);
    expect(sampleTitlesFor(db, [{ field: 'title', any: ['不存在'] }])).toEqual([]);
  });
});
