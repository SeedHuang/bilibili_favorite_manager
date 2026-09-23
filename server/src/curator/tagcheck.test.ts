import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import {
  addAlias, ensureTag, listTagTree, listUncheckedTags, markTagChecked, normalizeTagName, findTag,
} from '../db/repo/tags.js';

import type { AiCore } from '../ai.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));

/** 对模型的唯一出口是 ai 实例方法 —— 测试用只带 complete 的桩顶上 */
const ai = { complete: mocks.complete } as unknown as AiCore;

const tagcheck = await import('./tagcheck.js');
const { coerceVerdicts } = tagcheck;
/** 调用点不必逐个补 ai:统一在这里注入 */
const runTagCheck = (opts: Omit<Parameters<typeof tagcheck.runTagCheck>[0], 'ai'>) =>
  tagcheck.runTagCheck({ ...opts, ai });
const config = { id: 'flash', provider: 'deepseek', baseUrl: '', apiKey: 'k', model: 'deepseek-flash' };

beforeEach(() => vi.clearAllMocks());

describe('coerceVerdicts', () => {
  it('drop 原样留着(它不需要 target);merge/move 的目标必须存在,否则退回 keep', () => {
    const got = coerceVerdicts(
      JSON.stringify([
        { name: 'AI', action: 'drop' },                              // 泛词:留着,别被降级
        { name: '鲁夫', action: 'merge', target: '路飞' },            // 目标合法 → 保留
        { name: '鲁夫', action: 'merge', target: '不存在的词' },       // 目标编的 → keep
        { name: 'x', action: '乱写' },                                // action 越界 → keep
      ]),
      new Set(['路飞']),
    );
    expect(got).toEqual([
      { name: 'AI', action: 'drop' },
      { name: '鲁夫', action: 'merge', target: '路飞' },
      { name: '鲁夫', action: 'keep' },
      { name: 'x', action: 'keep' },
    ]);
  });

  it('目标按归一化比 —— 显示名是 NBA、模型吐 nba 也算命中', () => {
    const got = coerceVerdicts(
      JSON.stringify([{ name: '美职篮', action: 'merge', target: 'nba' }]),
      new Set(['NBA']),
    );
    expect(got).toEqual([{ name: '美职篮', action: 'merge', target: 'NBA' }]);
  });

  it('move 没有目标 → keep(别把"没听懂"当"该删")', () => {
    const got = coerceVerdicts(JSON.stringify([{ name: '露营', action: 'move' }]), new Set(['户外']));
    expect(got).toEqual([{ name: '露营', action: 'keep' }]);
  });
});

// ── 质检台账(checked_at)─────────────────────────────
describe('质检台账', () => {
  it('新词建出即待检(checked_at NULL);盖章后不再待检', async () => {
    const db = openDb(':memory:');
    const a = ensureTag(db, '甲', null);
    ensureTag(db, '乙', null);
    expect(listUncheckedTags(db)).toEqual(expect.arrayContaining(['甲', '乙']));
    markTagChecked(db, a);
    expect(listUncheckedTags(db)).toEqual(['乙']);
  });
});

describe('runTagCheck', () => {
  it('drop 的词从词库里删掉 —— 子节点提一级,不铲整棵', async () => {
    const db = openDb(':memory:');
    ensureTag(db, 'AI', null);
    ensureTag(db, '美食', null);
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { name: 'AI', action: 'drop' },
        { name: '美食', action: 'keep' },
      ]),
    );
    const r = await runTagCheck({ config, tree: listTagTree(db), db });
    expect(r.dropped).toBe(1);
    expect(listTagTree(db).map((n) => n.name)).toEqual(['美食']);
    // 判过即盖章:活下来的美食不再待检
    expect(listUncheckedTags(db)).toEqual([]);
  });

  it('merge 走的词把名字留给目标(别名表记住)', async () => {
    const db = openDb(':memory:');
    const keep = ensureTag(db, '路飞', null);
    const drop = ensureTag(db, '鲁夫', null);
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ name: '鲁夫', action: 'merge', target: '路飞' }]),
    );
    await runTagCheck({ config, tree: listTagTree(db), db });
    expect(findTag(db, normalizeTagName('鲁夫'))).toBe(keep);
    expect(db.prepare(`SELECT id FROM tags WHERE id = ?`).get(drop)).toBeUndefined();
  });

  it('move 真的换了父;三个计数器各归各位', async () => {
    const db = openDb(':memory:');
    const outdoors = ensureTag(db, '户外', null);
    ensureTag(db, '露营', null);
    const keep = ensureTag(db, '路飞', null);
    ensureTag(db, '鲁夫', null);
    ensureTag(db, 'AI', null);
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { name: 'AI', action: 'drop' },
        { name: '鲁夫', action: 'merge', target: '路飞' },
        { name: '露营', action: 'move', target: '户外' },
      ]),
    );
    const r = await runTagCheck({ config, tree: listTagTree(db), db });
    // checked = 送出去的总数:continue 送**全部未质检的**(5 个),判定只回了 3 个
    expect(r).toEqual({ dropped: 1, merged: 1, moved: 1, checked: 5 });
    // 计数器动了 **而且库里真的换了父** —— 只动计数器、不落库的话这条会挂
    const camp = findTag(db, normalizeTagName('露营'));
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(camp)).toEqual({
      parent_id: outdoors,
    });
    expect(findTag(db, normalizeTagName('鲁夫'))).toBe(keep);
    expect(findTag(db, normalizeTagName('AI'))).toBeNull();
  });

  it('别名说 drop 不动底下的活词(顺着别名表删就成了误删)', async () => {
    const db = openDb(':memory:');
    const keep = ensureTag(db, '路飞', null);
    addAlias(db, '鲁夫', keep); // 鲁夫 = 路飞 的旧写法,只在别名表里
    mocks.complete.mockResolvedValue(JSON.stringify([{ name: '鲁夫', action: 'drop' }]));
    const r = await runTagCheck({ config, tree: listTagTree(db), db });
    expect(r.dropped).toBe(0);
    expect(findTag(db, normalizeTagName('路飞'))).toBe(keep);
  });

  it('模型没回的词一律留着(不删 —— 漏了不等于该删)', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '露营', null);
    mocks.complete.mockResolvedValue(JSON.stringify([]));
    const r = await runTagCheck({ config, tree: listTagTree(db), db });
    expect(r.dropped).toBe(0);
    expect(listTagTree(db)).toHaveLength(1);
  });

  it('所有词都盖了章(没有待检)→ 一次 LLM 都不调(闸门在函数里)', async () => {
    const db = openDb(':memory:');
    const food = ensureTag(db, '美食', null);
    markTagChecked(db, food);
    await runTagCheck({ config, tree: listTagTree(db), db });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  // §9D.7:check 的 phase 帧先于本函数发出,「质检」块头已经挂上了 —— 闸门早退若不出声,
  // 用户看到的就是一个"跑了吗?判了啥?"的裸块头。**info 不是 warn**:无待检词本来就该无事发生
  it('没有待检词 → 发一条 info 的 note(块头不能裸着)', async () => {
    const db = openDb(':memory:');
    const food = ensureTag(db, '美食', null);
    markTagChecked(db, food);
    const notes: { level: 'info' | 'warn'; text: string }[] = [];
    await runTagCheck({ config, tree: listTagTree(db), db, onNote: (level, text) => notes.push({ level, text }) });
    expect(notes).toEqual([{ level: 'info', text: '没有待质检的词 —— 账已清' }]);
  });

  // fresh 闸门退役后的接替者:**已质检的词不重复检** —— 「continue 范围本身有界」靠
  // checked_at 账本实现,不再靠事后拦截
  it('已质检的词不重复检(scope=continue 只送未盖章的)', async () => {
    const db = openDb(':memory:');
    // 美食 = 上一轮检过的(已盖章);露营 = 待检
    const food = ensureTag(db, '美食', null);
    ensureTag(db, '露营', null);
    markTagChecked(db, food);

    // prompt 里摆着**整棵树**,而 CHECK_SYSTEM 自己的例子就是「AI」「视频」「教程」
    // —— 点着盖章老词说 drop/merge 的话,模型连被问都没被问过它。但 mock 只回露营
    // 的判定:美食根本不在送检名单里(下面断言 prompt),判定落库也无从谈起
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ name: '露营', action: 'keep' }]),
    );
    const r = await runTagCheck({ config, tree: listTagTree(db), db });

    expect(r).toEqual({ dropped: 0, merged: 0, moved: 0, checked: 1 });
    // 美食没被送检:**待判定的词**那一段只有露营 —— 盖章的词不在送检名单里
    // (prompt 的树形部分当然还有美食 —— 那是给模型的参照,不是送检名单)
    const prompt = mocks.complete.mock.calls[0]![0].messages[1]!.content as string;
    const batchSection = prompt.split('## 待判定的词')[1] ?? '';
    expect(batchSection).toContain('露营');
    expect(batchSection).not.toContain('美食');
  });

  it('一个词都没判回来 → 出声(不能长得像"什么都没变")', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '露营', null);
    // 被截断的数组 —— 真实成因是输出撞上服务商默认上限(包内 provider 没设 maxOutputTokens)
    mocks.complete.mockResolvedValue('[{"name":"露营","action":"ke');
    const log = new Logger(db, { silent: true });
    await runTagCheck({ config, tree: listTagTree(db), db, log });
    const rows = db.prepare(`SELECT message FROM events WHERE code = 'TAGCHECK_EMPTY'`).all() as
      { message: string }[];
    // 单批 0 判定告警(判定改当场执行后,批循环内的空批告警是唯一一处 —— 总闸门已并进去)
    expect(rows).toHaveLength(1);
    // 说清"几个词送出去了" —— 光说"什么都没判"没有可行动的信息
    expect(rows[0]!.message).toContain('1 个词送出去');
  });

  it('没传 logger 也不炸(可选参数)', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '露营', null);
    mocks.complete.mockResolvedValue(JSON.stringify([]));
    await expect(
      runTagCheck({ config, tree: listTagTree(db), db }),
    ).resolves.toEqual({ dropped: 0, merged: 0, moved: 0, checked: 1 });
  });

  // 分批:>200 个词不一次全送 —— 每次调用只送 ≤200 个
  it('超过 200 个词分批调模型,verdicts 累积', async () => {
    const db = openDb(':memory:');
    // 造 450 个词(3 批:200 + 200 + 50)
    const names: string[] = [];
    for (let i = 0; i < 450; i++) {
      const n = `词${i}`;
      names.push(n);
      ensureTag(db, n, null);
    }
    // 每次调用回一批:第一批全 keep,第二批一个 drop,第三批 keep
    mocks.complete
      .mockResolvedValueOnce(JSON.stringify(names.slice(0, 200).map((n) => ({ name: n, action: 'keep' }))))
      .mockResolvedValueOnce(JSON.stringify([
        ...names.slice(200, 400).map((n) => ({ name: n, action: 'keep' })),
        { name: '词300', action: 'drop' },
      ]))
      .mockResolvedValueOnce(JSON.stringify(names.slice(400).map((n) => ({ name: n, action: 'keep' }))));

    const r = await runTagCheck({ config, tree: listTagTree(db), db });
    expect(mocks.complete).toHaveBeenCalledTimes(3); // 3 批,不是 1 次塞 450
    expect(r.dropped).toBe(1);
    // 词300 被删
    expect(findTag(db, normalizeTagName('词300'))).toBeNull();
  });

  // scope=all:强制全库重检 —— 老词(已盖章的)也能被 drop
  it('scope=all 时老词也能被处理(全库重检)', async () => {
    const db = openDb(':memory:');
    const food = ensureTag(db, '美食', null);
    markTagChecked(db, food); // 老词已盖章 —— all 也不看账本,照送
    mocks.complete.mockResolvedValue(JSON.stringify([{ name: '美食', action: 'drop' }]));
    const r = await runTagCheck({ config, tree: listTagTree(db), db, scope: 'all' });
    expect(r.dropped).toBe(1);
    expect(listTagTree(db)).toHaveLength(0);
  });
});
