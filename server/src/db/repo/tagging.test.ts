import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertItem } from './items.js';
import { getItemTagging, setItemTagging, listUntaggedItemIds, tagStats } from './tagging.js';

const seed = () => {
  const db = openDb(':memory:');
  for (const id of ['BV1', 'BV2', 'BV3']) upsertItem(db, { id, type: 2, title: `题${id}` });
  return db;
};

describe('ai_tags 专用写库(C8:同步不碰这三列,这里是唯一写手)', () => {
  it('没标过 → null;写了能读回', () => {
    const db = seed();
    expect(getItemTagging(db, 'BV1')).toBeNull();

    setItemTagging(db, 'BV1', { tags: ['教学', 'Python'], kind: '教学' });
    expect(getItemTagging(db, 'BV1')).toEqual({ tags: ['教学', 'Python'], kind: '教学' });
  });

  // ★ C8 红线:upsertItem(同步路径)写条目时**不得**碰 ai_tags。
  //   光删掉 upsertItem 里那句不存在的写入测不出什么 —— 这条测的是:
  //   同步重写同一条目后,标注还在(C8 的全部意义)
  it('同步重写同一条目(upsertItem)→ 标注不被洗掉', () => {
    const db = seed();
    setItemTagging(db, 'BV1', { tags: ['教学'], kind: '教学' });

    upsertItem(db, { id: 'BV1', type: 2, title: '改名后的标题' }); // 模拟重同步
    expect(getItemTagging(db, 'BV1')).toEqual({ tags: ['教学'], kind: '教学' });
  });

  it('null = 清除标注(ai_checked_at 也清)', () => {
    const db = seed();
    setItemTagging(db, 'BV1', { tags: ['教学'], kind: '教学' });
    setItemTagging(db, 'BV1', null);
    expect(getItemTagging(db, 'BV1')).toBeNull();
  });

  it('listUntaggedItemIds 只回没标注的;listStats 数得对', () => {
    const db = seed();
    setItemTagging(db, 'BV2', { tags: ['娱乐'], kind: '娱乐' });

    expect(listUntaggedItemIds(db)).toEqual(['BV1', 'BV3']);
    expect(tagStats(db)).toEqual({ tagged: 1, total: 3 });
  });

  it('存的 JSON 坏了 → 当作没标注(返回 null),不炸', () => {
    const db = seed();
    db.prepare(`UPDATE items SET ai_tags = '不是JSON' WHERE id = 'BV1'`).run();
    expect(getItemTagging(db, 'BV1')).toBeNull();
  });
});
