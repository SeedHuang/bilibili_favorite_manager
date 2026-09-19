import { describe, it, expect } from 'vitest';
import { runButtons } from './tagRunButtons';

describe('runButtons', () => {
  it('从没标过 → 只有 AI 标注', () => {
    expect(runButtons(0, 100)).toEqual(['primary']);
  });
  it('全标完 → 只有重新标注全部', () => {
    expect(runButtons(100, 100)).toEqual(['retag']);
  });
  it('标了一半 → 继续标注 + 重新标注全部', () => {
    expect(runButtons(30, 100)).toEqual(['continue', 'retag']);
  });
  it('空库(无有效条目)→ 无按钮', () => {
    expect(runButtons(0, 0)).toEqual([]);
  });
});
