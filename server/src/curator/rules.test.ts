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

describe('matchAll', () => {
  it('按 itemId 归组,没命中的条目根本不进 Map', () => {
    const items = [item({ id: 'BV1', title: 'Python' }), item({ id: 'BV2', title: '别的东西' })];
    const got = matchAll(items, [rule(42, [{ field: 'title', any: ['Python'] }])]);

    expect(got.get('BV1')).toHaveLength(1);
    expect(got.has('BV2')).toBe(false);
  });
});

describe('renderConditions', () => {
  // 这句话会原样进 Pass 2 的 prompt(§9C.3 ②),也会出现在聊天上下文里
  it('渲染成一句给模型看的话', () => {
    expect(
      renderConditions([
        { field: 'title', any: ['Python', 'JS'] },
        { field: 'intro', any: ['算法'] },
      ]),
    ).toBe('标题含 Python/JS;或 简介含 算法');
  });

  it('空条件渲染成空串(调用方据此不写那一行)', () => {
    expect(renderConditions([])).toBe('');
  });

  // 界面上「新增规则」建出来的就是这个形状 —— 半写的规则必须渲染成"没有",不是半句话
  it('关键词还是空的条件不渲染', () => {
    expect(renderConditions([{ field: 'title', any: [] }])).toBe('');
  });

  it('混着写全的和没写完的 → 只渲染写全的那条', () => {
    expect(
      renderConditions([
        { field: 'title', any: ['Python'] },
        { field: 'intro', any: [] },
      ]),
    ).toBe('标题含 Python');
  });

  it('词表里的空串不算写了', () => {
    expect(renderConditions([{ field: 'title', any: ['', 'Python'] }])).toBe('标题含 Python');
  });
});

// ── 建议的自证与合并(spec §9C.5 R7)─────────────────────
import {
  validateSuggestion,
  validateSuggestions,
  mergeSuggestions,
  type ValidSuggestion,
} from './rules.js';

describe('validateSuggestion', () => {
  const items = new Map<string, RuleItem>([
    ['BV1', item({ id: 'BV1', title: 'Agent 入门到精通' })],
    ['BV2', item({ id: 'BV2', title: '今天天气不错' })],
  ]);
  const ctx = { validFolderIds: new Set([42]), itemsById: items };

  const good = {
    folderTempId: 42,
    field: 'title',
    any: ['Agent'],
    because: '这几条都是讲 Agent 的',
    evidenceItemIds: ['BV1'],
  };

  it('干净的建议能过', () => {
    const v = validateSuggestion(good, ctx)!;
    expect(v.folderId).toBe(42);
    expect(v.field).toBe('title');
    expect(v.any).toEqual(['Agent']);
    expect(v.because).toBe('这几条都是讲 Agent 的');
    expect(v.evidenceItemIds).toEqual(['BV1']);
  });

  it('folderTempId 是字符串也认(模型常把 id 吐成字符串)', () => {
    expect(validateSuggestion({ ...good, folderTempId: '42' }, ctx)).not.toBeNull();
  });

  it('引用不存在的夹子 → 丢掉', () => {
    expect(validateSuggestion({ ...good, folderTempId: 999 }, ctx)).toBeNull();
  });

  it('字段不是三个之一 → 丢掉', () => {
    expect(validateSuggestion({ ...good, field: '简介' }, ctx)).toBeNull();
  });

  it('关键词为空 / 全是空串与空白 → 丢掉', () => {
    expect(validateSuggestion({ ...good, any: [] }, ctx)).toBeNull();
    expect(validateSuggestion({ ...good, any: ['', '  '] }, ctx)).toBeNull();
  });

  it('关键词超过 20 个 → 截断(截断比丢整条宽厚,但不放行一堆噪音)', () => {
    const many = Array.from({ length: 30 }, (_, i) => `kw${i}`);
    // 证据必须真的含这组词 —— 否则过不了自证那一关,这条测的就成了"打不中"而不是"截断"
    const wide = {
      ...ctx,
      itemsById: new Map<string, RuleItem>([['WIDE', item({ id: 'WIDE', title: many.join(' ') })]]),
    };
    const v = validateSuggestion({ ...good, any: many, evidenceItemIds: ['WIDE'] }, wide)!;
    expect(v.any).toHaveLength(20);
  });

  // 真机上小模型会把 any 写成字符串(`"any":"Agent"`)而不是数组。那是**序列化**没写对,
  // 不是它想表达的东西错了 —— 包成单元素数组是无损的:不切词、不猜,那串字面就是关键词,
  // 自证照样要过。切词反而是错的("前端 技术" 拆开之后 "技术" 会捞走一大片)。
  it('any 写成字符串也认 —— 包成单元素数组,不切词', () => {
    const v = validateSuggestion({ ...good, any: 'Agent' }, ctx)!;
    expect(v.any).toEqual(['Agent']);
  });

  it('any 写成整句也认,但**不切词**(切了会捞走一大片)', () => {
    const items = new Map<string, RuleItem>([
      ['BV1', item({ id: 'BV1', title: '前端 技术' })],
    ]);
    const v = validateSuggestion(
      { folderTempId: 42, field: 'title', any: '前端 技术', evidenceItemIds: ['BV1'] },
      { validFolderIds: new Set([42]), itemsById: items },
    )!;
    expect(v.any).toEqual(['前端 技术']);
  });

  // ★ 这条是关键:它编的词打不中它自己给的证据
  it('**词打不中它给的证据条目 → 丢掉**', () => {
    expect(validateSuggestion({ ...good, any: ['根本不存在'] }, ctx)).toBeNull();
  });

  it('证据条目有一半打不中 → 也丢掉(不给"部分正确"留宽容)', () => {
    expect(validateSuggestion({ ...good, evidenceItemIds: ['BV1', 'BV2'] }, ctx)).toBeNull();
  });

  it('没有证据条目 → 丢掉(无法自证的建议不收)', () => {
    expect(validateSuggestion({ ...good, evidenceItemIds: [] }, ctx)).toBeNull();
  });

  it('证据条目里有不存在的 id → 丢掉', () => {
    expect(validateSuggestion({ ...good, evidenceItemIds: ['BV1', 'BV999'] }, ctx)).toBeNull();
  });

  it('整条不是对象 → 丢掉', () => {
    expect(validateSuggestion(null as never, ctx)).toBeNull();
    expect(validateSuggestion('随便一句话' as never, ctx)).toBeNull();
  });

  it('because 缺了就空串,不因此丢建议', () => {
    const v = validateSuggestion({ ...good, because: undefined }, ctx)!;
    expect(v.because).toBe('');
  });
});

describe('validateSuggestions', () => {
  const ctx = {
    validFolderIds: new Set([42]),
    itemsById: new Map<string, RuleItem>([['BV1', item({ id: 'BV1', title: 'Agent 入门' })]]),
  };

  it('数组里好的留下、坏的丢掉', () => {
    const got = validateSuggestions(
      [
        { folderTempId: 42, field: 'title', any: ['Agent'], evidenceItemIds: ['BV1'] },
        { folderTempId: 999, field: 'title', any: ['x'], evidenceItemIds: ['BV1'] },
      ],
      ctx,
    );
    expect(got).toHaveLength(1);
  });

  it('不是数组 → 空数组(不是抛错)', () => {
    expect(validateSuggestions('坏东西', ctx)).toEqual([]);
    expect(validateSuggestions(null, ctx)).toEqual([]);
  });
});

describe('mergeSuggestions', () => {
  const s = (over: Partial<ValidSuggestion>): ValidSuggestion => ({
    folderId: 42, field: 'title', any: ['Agent'], because: 'b', evidenceItemIds: ['BV1'], ...over,
  });

  it('同一组词只留一条 —— 不同批看到同一类时不该列两遍', () => {
    const got = mergeSuggestions([s({ evidenceItemIds: ['BV1'] }), s({ evidenceItemIds: ['BV2'] })]);
    expect(got).toHaveLength(1);
  });

  // 证据更多 → 你更容易判断该不该采纳(spec §9C.5 c)
  it('证据并起来,依顺序不重不漏', () => {
    const got = mergeSuggestions([
      s({ evidenceItemIds: ['BV1'] }),
      s({ evidenceItemIds: ['BV2', 'BV1'] }),
    ]);
    expect(got[0]!.evidenceItemIds).toEqual(['BV1', 'BV2']);
  });

  it('词表顺序不同但内容相同 → 仍算同一条', () => {
    const got = mergeSuggestions([s({ any: ['B', 'A'] }), s({ any: ['A', 'B'] })]);
    expect(got).toHaveLength(1);
  });

  it('夹子或字段不同 → 是两条', () => {
    expect(mergeSuggestions([s({}), s({ folderId: 43 })])).toHaveLength(2);
    expect(mergeSuggestions([s({}), s({ field: 'intro' })])).toHaveLength(2);
  });
});
