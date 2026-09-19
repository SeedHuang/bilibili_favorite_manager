import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
import { Logger } from '../logger/index.js';
import {
  addAlias, ensureTag, itemTagIds, linkItemTag, listTagTree, normalizeTagName, findTag,
} from '../db/repo/tags.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

const { coerceVerdicts, runTagCheck } = await import('./tagcheck.js');
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
    const r = await runTagCheck({ config, tree: listTagTree(db), newNames: ['AI'], db });
    expect(r.dropped).toBe(1);
    expect(listTagTree(db).map((n) => n.name)).toEqual(['美食']);
  });

  it('merge 走的词把名字留给目标(别名表记住)', async () => {
    const db = openDb(':memory:');
    const keep = ensureTag(db, '路飞', null);
    const drop = ensureTag(db, '鲁夫', null);
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ name: '鲁夫', action: 'merge', target: '路飞' }]),
    );
    await runTagCheck({ config, tree: listTagTree(db), newNames: ['鲁夫'], db });
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
    const r = await runTagCheck({
      config, tree: listTagTree(db), newNames: ['AI', '鲁夫', '露营'], db,
    });
    expect(r).toEqual({ dropped: 1, merged: 1, moved: 1, checked: 3 });
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
    const r = await runTagCheck({ config, tree: listTagTree(db), newNames: ['鲁夫'], db });
    expect(r.dropped).toBe(0);
    expect(findTag(db, normalizeTagName('路飞'))).toBe(keep);
  });

  it('模型没回的词一律留着(不删 —— 漏了不等于该删)', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '露营', null);
    mocks.complete.mockResolvedValue(JSON.stringify([]));
    const r = await runTagCheck({ config, tree: listTagTree(db), newNames: ['露营'], db });
    expect(r.dropped).toBe(0);
    expect(listTagTree(db)).toHaveLength(1);
  });

  it('newNames 为空 → 一次 LLM 都不调(闸门在函数里)', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '美食', null);
    await runTagCheck({ config, tree: listTagTree(db), newNames: [], db });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  // §9D.7:check 的 phase 帧先于本函数发出,「质检」块头已经挂上了 —— 闸门早退若不出声,
  // 用户看到的就是一个"跑了吗?判了啥?"的裸块头。**info 不是 warn**:无新词本来就该无事发生
  it('newNames 为空 → 发一条 info 的 note(块头不能裸着)', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '美食', null);
    const notes: { level: 'info' | 'warn'; text: string }[] = [];
    await runTagCheck({ config, tree: listTagTree(db), newNames: [], db, onNote: (level, text) => notes.push({ level, text }) });
    expect(notes).toEqual([{ level: 'info', text: '本轮没有新词可判 —— 质检无事发生' }]);
  });

  it('**只动本轮新词** —— 判到树里的老词也一个字不动', async () => {
    const db = openDb(':memory:');
    // 美食 = 上一轮建的**老词**(有视频挂着);露营 = 本轮的新词
    const food = ensureTag(db, '美食', null);
    ensureTag(db, '露营', null);
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    linkItemTag(db, 'BV1', food, 'ai');

    // prompt 里摆着**整棵树**,而 CHECK_SYSTEM 自己的例子就是「AI」「视频」「教程」
    // —— 点着老词说 drop/merge 是这条链路里最容易发生的事。而 drop 删节点、merge
    // 并节点:两个都不可逆,两个都不经用户确认。所以闸门只能是"这个名字在不在
    // **本轮新词**里"(spec C8 ①②③ 说的都是"新词"),不是"在不在树里"。
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { name: '美食', action: 'drop' },
        { name: '美食', action: 'merge', target: '露营' },
        { name: '露营', action: 'keep' },
      ]),
    );
    const r = await runTagCheck({ config, tree: listTagTree(db), newNames: ['露营'], db });

    expect(r).toEqual({ dropped: 0, merged: 0, moved: 0, checked: 1 });
    // 节点还在 —— 而且它挂的视频还在(merge 会把 item_tags 一起搬走)
    expect(db.prepare(`SELECT id FROM tags WHERE id = ?`).get(food)).toEqual({ id: food });
    expect(itemTagIds(db, ['BV1']).get('BV1')).toEqual([food]);
  });

  it('一个词都没判回来 → 出声(不能长得像"什么都没变")', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '露营', null);
    // 被截断的数组 —— 真实成因是输出撞上服务商默认上限(`provider.ts` 没设 maxOutputTokens)
    mocks.complete.mockResolvedValue('[{"name":"露营","action":"ke');
    const log = new Logger(db, { silent: true });
    await runTagCheck({ config, tree: listTagTree(db), newNames: ['露营'], db, log });
    const rows = db.prepare(`SELECT message FROM events WHERE code = 'TAGCHECK_EMPTY'`).all() as
      { message: string }[];
    // 单批 0 判定告警(判定改当场执行后,批循环内的空批告警是唯一一处 —— 总闸门已并进去)
    expect(rows).toHaveLength(1);
    // 说清"几个词送出去了" —— 光说"什么都没判"没有可行动的信息。
    // 词数来自 allNames(它已含 newNames 或全库词),所以 scope='all' 空 newNames 时也报得对
    expect(rows[0]!.message).toContain('1 个词送出去');
  });

  it('没传 logger 也不炸(可选参数)', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '露营', null);
    mocks.complete.mockResolvedValue(JSON.stringify([]));
    await expect(
      runTagCheck({ config, tree: listTagTree(db), newNames: ['露营'], db }),
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

    const r = await runTagCheck({ config, tree: listTagTree(db), newNames: names, db });
    expect(mocks.complete).toHaveBeenCalledTimes(3); // 3 批,不是 1 次塞 450
    expect(r.dropped).toBe(1);
    // 词300 被删
    expect(findTag(db, normalizeTagName('词300'))).toBeNull();
  });

  // allTags=true:检全库,绕过 fresh 闸门 —— 老词也能被 drop
  it('allTags=true 时老词也能被处理(绕过 fresh 闸门)', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '美食', null); // 老词
    mocks.complete.mockResolvedValue(JSON.stringify([{ name: '美食', action: 'drop' }]));
    // 传 allTags: true,newNames 空(全库检,不是本轮新词)
    const r = await runTagCheck({ config, tree: listTagTree(db), newNames: [], db, allTags: true });
    expect(r.dropped).toBe(1);
    expect(listTagTree(db)).toHaveLength(0);
  });

  // allTags=false(默认):老词 drop 被 fresh 闸门挡住(既有行为)
  it('allTags 默认 false:老词 drop 仍被 fresh 闸门挡住', async () => {
    const db = openDb(':memory:');
    ensureTag(db, '美食', null);
    mocks.complete.mockResolvedValue(JSON.stringify([{ name: '美食', action: 'drop' }]));
    const r = await runTagCheck({ config, tree: listTagTree(db), newNames: ['新词'], db }); // 美食不是本轮新词
    expect(r.dropped).toBe(0);
    expect(listTagTree(db)).toHaveLength(1);
  });
});
