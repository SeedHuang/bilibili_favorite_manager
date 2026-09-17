import { describe, it, expect } from 'vitest';
import { extractMixinKey, signParams } from './wbi.js';

// 黄金值来自 2026-09-14 对真实 API 的实测,见计划文档「已实测确认的前提」
const IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';
const MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8';

describe('extractMixinKey', () => {
  it('用 64 位置换表从 img_key + sub_key 生成 32 位 mixinKey', () => {
    expect(extractMixinKey(IMG_KEY, SUB_KEY)).toBe(MIXIN_KEY);
  });

  it('两个 key 长度不是 32 时抛错', () => {
    expect(() => extractMixinKey('abc', SUB_KEY)).toThrow(/32/);
    expect(() => extractMixinKey(IMG_KEY, 'abc')).toThrow(/32/);
  });
});

describe('signParams', () => {
  it('按 key 排序、拼 wts、算出 w_rid', () => {
    const signed = signParams(
      { mid: 2, ps: 5, pn: 1, order: 'pubdate' },
      MIXIN_KEY,
      1757836800,
    );
    expect(signed).toBe(
      'mid=2&order=pubdate&pn=1&ps=5&wts=1757836800&w_rid=a9bf59715a7e12664ea8e8481de3d6d8',
    );
  });

  it('剥掉 !\'()* 这些字符', () => {
    const signed = signParams({ q: "a!b'c(d)e*f" }, MIXIN_KEY, 1757836800);
    expect(signed).toContain('q=abcdef');
  });

  it('调用方自己传的 wts 会被覆盖', () => {
    const signed = signParams({ wts: 1, mid: 2 }, MIXIN_KEY, 1757836800);
    expect(signed).toContain('wts=1757836800');
    expect(signed).not.toContain('wts=1&');
  });
});
