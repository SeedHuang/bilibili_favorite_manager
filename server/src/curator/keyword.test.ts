import { describe, it, expect } from 'vitest';
import { keywordClassify, DEFAULT_RULES, type KeywordItem } from './keyword.js';

const rules = new Map<string, string[]>([
  ['AI/编程', ['Python', '编程', '算法']],
  ['音乐', ['音乐', '翻唱']],
]);

const item = (p: Partial<KeywordItem>): KeywordItem => ({
  title: '',
  intro: null,
  upperName: null,
  ...p,
});

describe('keywordClassify', () => {
  it('标题命中 → 候选夹子 + 命中字段 + 命中的词', () => {
    const hits = keywordClassify(item({ title: 'Python 入门到精通' }), rules);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      candidate: 'AI/编程',
      matchedField: 'title',
      matchedToken: 'Python',
    });
    expect(hits[0]!.confidence).toBeGreaterThan(0);
    expect(hits[0]!.confidence).toBeLessThanOrEqual(1);
  });

  it('大小写不敏感 —— 用户不会照着我们的大小写写标题', () => {
    expect(keywordClassify(item({ title: 'python 教程' }), rules)).toHaveLength(1);
    expect(keywordClassify(item({ title: 'PYTHON 教程' }), rules)[0]!.matchedToken).toBe('Python');
  });

  // intro 是实测的"主力信号"(spec §9.3),但比标题弱一档:
  // 标题是作者自己写的分类意图,简介可能是转发时带上的
  it('标题比简介权重高,简介比 UP 名权重高', () => {
    const byTitle = keywordClassify(item({ title: '算法' }), rules)[0]!.confidence;
    const byIntro = keywordClassify(item({ intro: '算法' }), rules)[0]!.confidence;
    const byUpper = keywordClassify(item({ upperName: '算法' }), rules)[0]!.confidence;
    expect(byTitle).toBeGreaterThan(byIntro);
    expect(byIntro).toBeGreaterThan(byUpper);
  });

  it('同一夹子只出一次 —— 标题和简介都命中时取高的那个字段', () => {
    const hits = keywordClassify(item({ title: 'Python', intro: 'Python 编程' }), rules);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matchedField).toBe('title');
  });

  it('命中词越多越有把握', () => {
    const one = keywordClassify(item({ title: 'Python' }), rules)[0]!.confidence;
    const two = keywordClassify(item({ title: 'Python 编程' }), rules)[0]!.confidence;
    expect(two).toBeGreaterThan(one);
  });

  it('多个夹子都命中时按置信度倒序', () => {
    const hits = keywordClassify(item({ title: '音乐', intro: 'Python' }), rules);
    expect(hits.map((h) => h.candidate)).toEqual(['音乐', 'AI/编程']);
  });

  it('没命中返回空数组(调用方据此归入"待 AI 校准"组)', () => {
    expect(keywordClassify(item({ title: '今天天气不错' }), rules)).toEqual([]);
  });

  it('intro / upperName 为 null 不炸', () => {
    expect(() => keywordClassify(item({ title: 'x' }), rules)).not.toThrow();
  });

  it('空规则表返回空 —— 没有规则就没有初分,这是正常的', () => {
    expect(keywordClassify(item({ title: 'Python' }), new Map())).toEqual([]);
  });

  it('置信度封顶在 1', () => {
    const many = new Map([['X', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']]]);
    expect(keywordClassify(item({ title: 'abcdefgh' }), many)[0]!.confidence).toBe(1);
  });
});

describe('DEFAULT_RULES', () => {
  it('是非空的种子规则表', () => {
    expect(DEFAULT_RULES.size).toBeGreaterThan(0);
    for (const [folder, tokens] of DEFAULT_RULES) {
      expect(folder).toBeTruthy();
      expect(tokens.length).toBeGreaterThan(0);
    }
  });

  it('按 spec §9.0 的例子:Python → AI/编程 这类', () => {
    const hits = keywordClassify(item({ title: 'Python 爬虫实战' }), DEFAULT_RULES);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('关键词不重复出现在同一个夹子里(重复只会虚抬置信度)', () => {
    for (const [folder, tokens] of DEFAULT_RULES) {
      expect(new Set(tokens).size, folder).toBe(tokens.length);
    }
  });
});
