import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertItem } from './items.js';
import { markItemTagged, listUntaggedItemIds, tagStats } from './tagging.js';

const seed = () => {
  const db = openDb(':memory:');
  for (const id of ['BV1', 'BV2', 'BV3']) upsertItem(db, { id, type: 2, title: `题${id}` });
  return db;
};

/** 两个 AI 派生列 —— C8 红线两侧都拿它比"一个字节都没动" */
const aiCols = (db: ReturnType<typeof seed>, id: string) =>
  db.prepare(`SELECT ai_kind, ai_checked_at FROM items WHERE id = ?`).get(id) as {
    ai_kind: string | null;
    ai_checked_at: number | null;
  };

describe('AI 派生列的落库口(C8:同步不碰这两列,这里是唯一写手)', () => {
  it('markItemTagged 同时写形态与水位线', () => {
    const db = seed();
    expect(tagStats(db)).toEqual({ tagged: 0, total: 3, invalid: 0 });

    markItemTagged(db, 'BV1', '教学');
    const row = aiCols(db, 'BV1');
    expect(row.ai_kind).toBe('教学');
    expect(row.ai_checked_at).not.toBeNull(); // 增量标注的唯一依据
  });

  // ★ C8 红线:upsertItem(同步路径)写条目时**不得**碰 ai_kind / ai_checked_at。
  //   光删掉 upsertItem 里那句不存在的写入测不出什么 —— 这条测的是:
  //   同步重写同一条目后,标注(含水位线)一个字节都没变(C8 的全部意义)
  it('同步重写同一条目(upsertItem)→ 标注不被洗掉', () => {
    const db = seed();
    markItemTagged(db, 'BV1', '教学');
    const before = aiCols(db, 'BV1');
    expect(before.ai_kind).toBe('教学');
    expect(before.ai_checked_at).not.toBeNull();

    upsertItem(db, { id: 'BV1', type: 2, title: '改名后的标题' }); // 模拟重同步
    expect(aiCols(db, 'BV1')).toEqual(before);
  });

  // 水位线是增量的唯一依据:没写它的那些条目还在池子里,写了的不再出现
  it('listUntaggedItemIds 只回没标注的;tagStats 数得对', () => {
    const db = seed();
    markItemTagged(db, 'BV2', '娱乐');

    expect(listUntaggedItemIds(db)).toEqual(['BV1', 'BV3']);
    expect(tagStats(db)).toEqual({ tagged: 1, total: 3, invalid: 0 });
  });

  // ★ 已失效(invalid = 1)不进池、不进分母 —— 它是"标不上的",不是"还没标上的"。
  //   它的标题是占位符「已失效视频」、没有简介,模型什么都吐不出来;放进池子会每轮
  //   失败、又因失败不写水位线而**永远留下**(用户报的「0 条,3 批失败」就是它)。
  it('invalid=1 的条目不进未标注池,也不被 tagStats 数进分母', () => {
    const db = seed();
    upsertItem(db, { id: 'BVX', type: 2, title: '已失效视频', invalid: true });

    expect(listUntaggedItemIds(db)).toEqual(['BV1', 'BV2', 'BV3']);
    expect(tagStats(db)).toEqual({ tagged: 0, total: 3, invalid: 1 });
  });
});
