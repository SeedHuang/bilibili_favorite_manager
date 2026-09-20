// server/src/curator/proposal.test.ts
import { describe, it, expect } from 'vitest';
import { LEVELS, levelText, buildPrompt, validateFolders } from './proposal.js';

describe('档位阶梯', () => {
  it('10 档,1 严 10 松,无具体例子', () => {
    expect(LEVELS).toHaveLength(10);
    expect(LEVELS[0]!.level).toBe(1);
    expect(LEVELS[9]!.level).toBe(10);
    for (const l of LEVELS) {
      expect(l.criterion).not.toMatch(/Claude|DeepSeek|NBA|Python/i); // 锚定偏差防线
    }
  });
  it('levelText 查表', () => {
    expect(levelText(1)?.name).toBe('专精');
    expect(levelText(11)).toBeNull();
  });
});

describe('buildPrompt', () => {
  it('含阶梯定义、护栏、词库、共现和"线索不是指令"提醒', () => {
    const p = buildPrompt({ treeText: '- NBA(挂 5 条)', coText: 'NBA ↔ 篮球: 0.9', expected: '4~9 个', level: 3 });
    expect(p.system).toContain('方案');       // L3 名称在 prompt 里
    expect(p.user).toContain('NBA');
    expect(p.user).toContain('0.9');
    expect(p.user).toContain('4~9');
    expect(p.system).toContain('线索');       // 共现提醒
  });
});

describe('validateFolders 裁判', () => {
  const ctx = { validTagIds: new Set([1, 2]), knownNames: new Set(['已有']) };
  it('合法输出通过', () => {
    const ok = validateFolders(
      [{ name: 'AI 编程', reason: 'r', tagIds: [1], keywords: ['教程'] }],
      ctx,
    );
    expect(ok).toEqual([{ name: 'AI 编程', reason: 'r', tagIds: [1], keywords: ['教程'] }]);
  });
  it('编造 tagId → 整条丢', () => {
    expect(validateFolders([{ name: 'x', reason: '', tagIds: [99], keywords: [] }], ctx)).toEqual([]);
  });
  it('重名(与已有夹子)丢', () => {
    expect(validateFolders([{ name: '已有', reason: '', tagIds: [], keywords: ['a'] }], ctx)).toEqual([]);
  });
  it('方案内部互相重名 → 只留第一个', () => {
    const out = validateFolders(
      [{ name: 'A', reason: '', tagIds: [], keywords: ['a'] }, { name: 'A', reason: '', tagIds: [], keywords: ['b'] }],
      ctx,
    );
    expect(out).toHaveLength(1);
  });
  it('tagIds/keywords 全空 → 丢;非对象/缺字段 → 丢', () => {
    expect(validateFolders([{ name: 'B', reason: '', tagIds: [], keywords: [] }], ctx)).toEqual([]);
    expect(validateFolders('junk', ctx)).toEqual([]);
    expect(validateFolders([{ name: 123 }], ctx)).toEqual([]);
  });
  it('keywords 去空白、去重、截 20', () => {
    const kw = ['a', ' a ', '', 42, 'a'] as unknown as string[];
    // brief 原文用 25 个相同的 'x',但任何去重都会把它们压成 1 个,期望 ['a','x'×19] 无解;
    // 改为 25 个可区分的 x,保住原意:去重(a 变体并 1)+ 截 20(25→19)
    const out = validateFolders(
      [{ name: 'C', reason: '', tagIds: [], keywords: [...kw, ...Array(25).fill('x').map((_, i) => `x${i}`)] }],
      ctx,
    );
    expect(out[0]!.keywords).toEqual(['a', ...Array(19).fill('x').map((_, i) => `x${i}`)]);
  });
});
