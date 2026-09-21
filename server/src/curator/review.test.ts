import { describe, it, expect } from 'vitest';
import { buildReviewPrompt, validateReviewDrafts } from './review.js';
import type { FolderProfile } from './folderProfile.js';

const profiles: FolderProfile[] = [
  { folderId: 3, name: 'AI 编程', itemCount: 10, topTags: [{ name: 'Python', count: 8 }], outliers: [] },
  { folderId: 5, name: 'AI/编程', itemCount: 12, topTags: [{ name: 'Python', count: 9 }], outliers: [] },
  { folderId: 7, name: '人类夹子', itemCount: 5, topTags: [{ name: '健身', count: 4 }], outliers: [] },
];

const baseCtx = {
  validFolderIds: new Set([3, 5, 7]),
  aiIds: new Set([3, 5]),
  lockedIds: new Set<number>(),
  itemsById: new Map([
    ['BV1', { id: 'BV1', title: 'Python 教程', intro: null, upperName: null }],
  ]),
};

describe('buildReviewPrompt', () => {
  it('带画像、区分 AI/人类夹子的角色说明,要求纯 JSON 数组', () => {
    const p = buildReviewPrompt({ profiles, aiIds: new Set([3, 5]) });
    expect(p.system).toContain('纯 JSON');
    expect(p.system).toContain('AI 建的夹子');
    expect(p.user).toContain('AI 编程');
    expect(p.user).toContain('人类夹子');
  });
});

describe('validateReviewDrafts', () => {
  it('规则草稿过自证 → 留;打不中证据 → 丢', () => {
    const raw = [
      { kind: 'rule', folderTempId: '7', field: 'title', any: ['Python'], because: 'b', evidenceItemIds: ['BV1'] },
      { kind: 'rule', folderTempId: '7', field: 'title', any: ['瑜伽'], because: 'b', evidenceItemIds: ['BV1'] },
    ];
    const v = validateReviewDrafts(raw, baseCtx);
    expect(v.drafts).toHaveLength(1);
    expect(v.drafts[0]).toMatchObject({ kind: 'rule', folderId: 7, any: ['Python'] });
    expect(v.rejects).toHaveLength(1);
  });

  it('merge:两者都是 AI 夹子 → 留;source 是人类夹子 → 丢', () => {
    const raw = [
      { kind: 'merge', fromTempId: '3', intoTempId: '5', because: '共现高' },
      { kind: 'merge', fromTempId: '7', intoTempId: '5', because: 'x' },
    ];
    const v = validateReviewDrafts(raw, baseCtx);
    expect(v.drafts).toEqual([{ kind: 'merge', fromId: 3, intoId: 5, because: '共现高' }]);
  });

  it('delete:AI 夹子 → 留;人类夹子/锁定夹 → 丢', () => {
    const raw = [
      { kind: 'delete', folderTempId: '3', because: '命中 0' },
      { kind: 'delete', folderTempId: '7', because: 'x' },
    ];
    const ctx = { ...baseCtx, lockedIds: new Set([7]) };
    const v = validateReviewDrafts(raw, ctx);
    expect(v.drafts).toEqual([{ kind: 'delete', folderId: 3, because: '命中 0' }]);
  });

  it('kind 不认识 / 形状不对 → 丢', () => {
    const v = validateReviewDrafts([{ kind: 'explode' }, 'junk', null], baseCtx);
    expect(v.drafts).toHaveLength(0);
    expect(v.rejects.length).toBeGreaterThanOrEqual(3);
  });
});
