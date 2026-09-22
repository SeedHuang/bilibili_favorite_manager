import { describe, it, expect } from 'vitest';
import { matchItem, matchAll, renderConditions, type RuleItem } from './rules.js';
import type { FolderRule } from '../db/repo/rules.js';

const item = (p: Partial<RuleItem>): RuleItem => ({
  id: 'BV1', title: '', intro: null, upperName: null, ...p,
});

const rule = (folderId: number, conditions: FolderRule['conditions']): FolderRule => ({
  folderId, conditions, origin: 'user', updatedAt: 0,
});

describe('matchItem', () => {
  it('标题命中', () => {
    const hits = matchItem(item({ title: 'Python 从入门到精通' }), [
      rule(42, [{ field: 'title', any: ['Python'] }]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.folderId).toBe(42);
    expect(hits[0]!.tokens).toEqual([{ field: 'title', token: 'Python' }]);
  });

  it('简介命中', () => {
    const hits = matchItem(item({ intro: '本视频讲算法' }), [
      rule(42, [{ field: 'intro', any: ['算法'] }]),
    ]);
    expect(hits[0]!.tokens[0]).toEqual({ field: 'intro', token: '算法' });
  });

  it('UP 名命中', () => {
    const hits = matchItem(item({ upperName: '某UP' }), [
      rule(42, [{ field: 'upper', any: ['某UP'] }]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.tokens[0]).toEqual({ field: 'upper', token: '某UP' });
  });

  it('大小写不敏感', () => {
    const r = [rule(42, [{ field: 'title', any: ['Python'] }])];
    expect(matchItem(item({ title: 'python 教程' }), r)).toHaveLength(1);
    expect(matchItem(item({ title: 'PYTHON 教程' }), r)).toHaveLength(1);
  });

  it('字段看错了就不命中 —— 标题里的词不该被简介的规则捞走', () => {
    const hits = matchItem(item({ title: '算法' }), [rule(42, [{ field: 'intro', any: ['算法'] }])]);
    expect(hits).toEqual([]);
  });

  // R4:一条条目同时命中多个夹子 → 都归。猜错就是悄悄少一份归属
  it('命中两个夹子 → 两条都返回', () => {
    const hits = matchItem(item({ title: 'Python 算法' }), [
      rule(42, [{ field: 'title', any: ['Python'] }]),
      rule(43, [{ field: 'title', any: ['算法'] }]),
    ]);
    expect(hits.map((h) => h.folderId).sort()).toEqual([42, 43]);
  });

  // 同一个夹子里多个条件都命中 → 只出一条(不然界面上会重复计数)
  it('同一个夹子里多个条件命中 → 只出一条,但 tokens 都带上', () => {
    const hits = matchItem(item({ title: 'Python', intro: '讲算法' }), [
      rule(42, [
        { field: 'title', any: ['Python'] },
        { field: 'intro', any: ['算法'] },
      ]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.tokens).toHaveLength(2);
  });

  it('空关键词列表不命中(半写的规则不该捞走任何东西)', () => {
    expect(
      matchItem(item({ title: 'Python' }), [rule(42, [{ field: 'title', any: [] }])]),
    ).toEqual([]);
  });

  it('条件列表为空不命中', () => {
    expect(matchItem(item({ title: 'Python' }), [rule(42, [])])).toEqual([]);
  });

  it('intro / upperName 为 null 不炸', () => {
    expect(() =>
      matchItem(item({ title: 'x' }), [rule(42, [{ field: 'intro', any: ['y'] }])]),
    ).not.toThrow();
  });

  // ★ 条件之间是 **OR**(spec §9C.1 R3)—— 少了这条测试,把 OR 写成 AND 也全绿
  it('一个夹子的多条条件之间是 OR —— 只命中一条就算命中', () => {
    const hits = matchItem(item({ title: 'Python 教程' }), [
      rule(42, [
        { field: 'title', any: ['Python'] },
        { field: 'intro', any: ['这个词根本不在简介里'] },
      ]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.folderId).toBe(42);
  });

  // 空关键词会匹配一切 —— 半写的规则不该靠它把整个库捞走
  it('空串关键词不匹配任何东西(否则它会匹配一切)', () => {
    expect(matchItem(item({ title: '随便什么标题' }), [rule(42, [{ field: 'title', any: [''] }])])).toEqual([]);
  });
});

// §9F C11:第四个字段,选中一个标签 = 匹配它整棵子树
describe('tag 字段(子树匹配)', () => {
  const ctx = { subtree: new Map([[1, new Set([1, 2, 3])], [2, new Set([2])]]) };
  const rule = (any: string[]): FolderRule => ({
    folderId: 7, conditions: [{ field: 'tag', any }], origin: 'user', updatedAt: 0,
  });

  it('条件选父 → 命中它的所有后代', () => {
    const item = { id: 'BV1', title: 'x', tagIds: [3] };   // 3 是 1 的后代
    expect(matchItem(item, [rule(['1'])], ctx)).toHaveLength(1);
  });

  it('条件选子 → 不命中它的父', () => {
    const item = { id: 'BV1', title: 'x', tagIds: [1] };
    expect(matchItem(item, [rule(['2'])], ctx)).toEqual([]);
  });

  it('没有标签的条目不会误命中空条件', () => {
    expect(matchItem({ id: 'BV1', title: 'x' }, [rule(['1'])], ctx)).toEqual([]);
  });

  it('缺 subtree ctx 时 tag 条件一律不命中(不是"命中一切")', () => {
    expect(matchItem({ id: 'BV1', title: 'x', tagIds: [1] }, [rule(['1'])])).toEqual([]);
  });

  it('命中的 token 报的是条件里那个词,不是条目挂的那个', () => {
    const item = { id: 'BV1', title: 'x', tagIds: [3] };
    expect(matchItem(item, [rule(['1'])], ctx)[0]!.tokens[0]!.token).toBe('1');
  });
});

describe('matchAll', () => {
  it('按 itemId 归组,没命中的条目根本不进 Map', () => {
    const items = [item({ id: 'BV1', title: 'Python' }), item({ id: 'BV2', title: '别的东西' })];
    const got = matchAll(items, [rule(42, [{ field: 'title', any: ['Python'] }])]);

    expect(got.get('BV1')).toHaveLength(1);
    expect(got.has('BV2')).toBe(false);
  });
});

describe('renderConditions', () => {
  // 这几条全是文本条件,压根不查名字表 —— 给个空的就行(tag 那条自己在下面建)
  const noTags = new Map<number, string>();

  // 渲染成一句给模型看的话(规则条件的一句话描述)
  it('渲染成一句给模型看的话', () => {
    expect(
      renderConditions([
        { field: 'title', any: ['Python', 'JS'] },
        { field: 'intro', any: ['算法'] },
      ], noTags),
    ).toBe('标题含 Python/JS;或 简介含 算法');
  });

  it('空条件渲染成空串(调用方据此不写那一行)', () => {
    expect(renderConditions([], noTags)).toBe('');
  });

  // 界面上「新增规则」建出来的就是这个形状 —— 半写的规则必须渲染成"没有",不是半句话
  it('关键词还是空的条件不渲染', () => {
    expect(renderConditions([{ field: 'title', any: [] }], noTags)).toBe('');
  });

  it('混着写全的和没写完的 → 只渲染写全的那条', () => {
    expect(
      renderConditions([
        { field: 'title', any: ['Python'] },
        { field: 'intro', any: [] },
      ], noTags),
    ).toBe('标题含 Python');
  });

  it('词表里的空串不算写了', () => {
    expect(renderConditions([{ field: 'title', any: ['', 'Python'] }], noTags)).toBe('标题含 Python');
  });

  // §9F C11:tag 条件里存的是 **id** —— 原样印出去,模型读到的是「标签含 42、57」,
  // 而 C15 说的"依据就是标签和规则"里的那一半就全废了
  it('tag 条件渲染成**词名**,不是 id', () => {
    const names = new Map([[1, '体育'], [2, 'NBA']]);
    expect(renderConditions([{ field: 'tag', any: ['1', '2'] }], names)).toContain('体育');
    expect(renderConditions([{ field: 'tag', any: ['1', '2'] }], names)).toContain('NBA');
    // 翻不到名字的 id 不该原样印成数字
    expect(renderConditions([{ field: 'tag', any: ['999'] }], names)).toBe('');
  });
});
