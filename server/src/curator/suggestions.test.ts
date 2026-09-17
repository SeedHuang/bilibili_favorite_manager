import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem, type ItemRow } from '../db/repo/items.js';
import { ensureWorkcopy, listWorkFolders } from '../db/repo/workbench.js';
import { saveRule } from '../db/repo/rules.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

// 顶层 await import —— vi.mock 必须先生效(和 classifier.test.ts 同一个理由)
const { buildSuggestionPrompt, runSuggestions, suggestionInput, SUGGESTION_SYSTEM } =
  await import('./suggestions.js');

const config = { id: '本地', provider: 'ollama', baseUrl: '', apiKey: '', model: 'qwen2.5:14b' };

const item = (id: string, title: string, extra: Partial<ItemRow> = {}): ItemRow => ({
  id, type: 2, title, intro: null, cover: null, upper_mid: null, upper_name: null,
  duration: null, pubtime: null, invalid: 0, invalid_checked_at: null,
  ai_tags: null, ai_summary: null, ai_checked_at: null, raw: null, ...extra,
});

beforeEach(() => vi.clearAllMocks());

/**
 * 和 `seeded()` 同款,外加一个**锁定夹子**(「默认收藏夹」)。
 *
 * 锁定夹子必须在 `ensureWorkcopy` **之前**就躺在 `folders` 里:`ensureWorkcopy`
 * 是幂等的,第一份副本建好之后再加夹子就进不了工作副本了 —— 那样测的是空集,
 * 钉不住任何东西。所以这边单独来一份,而不是在 `seeded()` 之后再补一个夹子。
 */
function seededWithLocked() {
  const db = openDb(':memory:');
  upsertFolder(db, { id: 7, title: 'AI/编程', mediaCount: 2 });
  // isDefaultFolder 按标题判定,不用 raw
  upsertFolder(db, { id: 9, title: '默认收藏夹', mediaCount: 2 });
  upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
  upsertItem(db, { id: 'BV2', type: 2, title: 'Agent 入门' });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
  ensureWorkcopy(db);
  return db;
}

describe('buildSuggestionPrompt', () => {
  it('带规则 / 带样本 / 带待处理条目', () => {
    const p = buildSuggestionPrompt({
      folders: [
        { folderId: 42, name: 'AI/编程', rule: '标题含 Python' },
        { folderId: 43, name: '黑神话', rule: '', samples: ['黑神话悟空 第一回'] },
      ],
      items: [item('BV9', 'Agent 入门', { intro: '讲大模型' })],
    });

    expect(p).toContain('[42] AI/编程 —— 标题含 Python');
    expect(p).toContain('黑神话悟空 第一回');
    expect(p).toContain('[BV9] Agent 入门');
    expect(p).toContain('讲大模型');
  });

  it('不带样本的夹子不留空行', () => {
    const p = buildSuggestionPrompt({
      folders: [{ folderId: 42, name: 'AI/编程', rule: '标题含 Python' }],
      items: [item('BV9', '题')],
    });
    expect(p).not.toContain('现有条目');
  });
});

describe('suggestionInput', () => {
  /** 快照:一个夹子 + 两条条目,克隆出工作副本 */
  function seeded() {
    const db = openDb(':memory:');
    upsertFolder(db, { id: 7, title: 'AI/编程', mediaCount: 2 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'Agent 入门' });
    linkFolderItem(db, 7, 'BV1', 1);
    linkFolderItem(db, 7, 'BV2', 1);
    ensureWorkcopy(db);
    return db;
  }

  it('pool = 规则没覆盖住的条目 —— 规则命中过的被排除', () => {
    const db = seeded();
    const work = listWorkFolders(db)[0]!;
    saveRule(db, work.id, [{ field: 'title', any: ['Python'] }], 'user');

    const { pool } = suggestionInput(db);
    expect(pool.map((i) => i.id)).toEqual(['BV2']);
  });

  it('全覆盖时 pool 是空的(调用方据此不调 LLM)', () => {
    const db = seeded();
    const work = listWorkFolders(db)[0]!;
    saveRule(db, work.id, [{ field: 'title', any: ['Python', 'Agent'] }], 'user');

    expect(suggestionInput(db).pool).toEqual([]);
  });

  it('有规则的夹子带规则、**不带样本**', () => {
    const db = seeded();
    const work = listWorkFolders(db)[0]!;
    saveRule(db, work.id, [{ field: 'title', any: ['Python'] }], 'user');

    const { folders } = suggestionInput(db);
    expect(folders[0]!.rule).toBe('标题含 Python');
    expect(folders[0]!.samples).toBeUndefined();
  });

  // 只看名字模型会自信地猜错(§9C.0 那次真机事故)—— 没规则的夹子必须带例子
  it('没规则的夹子带已有标题当样本', () => {
    const db = seeded();
    const { folders } = suggestionInput(db);
    expect(folders[0]!.rule).toBe('');
    expect(folders[0]!.samples).toEqual(['Python 教程', 'Agent 入门']);
  });

  it('allItems 是全库 —— 自证要能查到已经归到别处的条目', () => {
    const db = seeded();
    const work = listWorkFolders(db)[0]!;
    saveRule(db, work.id, [{ field: 'title', any: ['Python'] }], 'user');

    expect(suggestionInput(db).allItems.map((i) => i.id).sort()).toEqual(['BV1', 'BV2']);
  });

  // 锁定的夹子不能加规则(spec §9C.6 约束 4)—— 那就别让模型给它提建议
  it('锁定的夹子不进 folders —— 模型压根看不到它', () => {
    const db = seededWithLocked();

    const { folders } = suggestionInput(db);
    expect(folders.some((f) => f.name === '默认收藏夹')).toBe(false);
    expect(folders.length).toBeGreaterThan(0); // 别把非锁定的也一起滤掉了
  });
});

describe('runSuggestions', () => {
  const folders = [{ folderId: 42, name: 'AI/编程', rule: '' }];
  const pool = [item('BV9', 'Agent 入门')];
  const allItems = [item('BV9', 'Agent 入门'), item('BV1', 'Python 教程')];
  const base = { config, folders, pool, allItems, cap: 50 };

  it('好的建议过了自证就返回', async () => {
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: 42, field: 'title', any: ['Agent'], because: '同类', evidenceItemIds: ['BV9'] },
    ]));

    const got = await runSuggestions(base);
    expect(got).toHaveLength(1);
    expect(got[0]!.folderId).toBe(42);
    expect(got[0]!.any).toEqual(['Agent']);
  });

  // ★ 防幻觉:它编的词打不中它给的证据条目
  it('自证不过的建议留不下来 —— 一条都没剩就抛,不是静默空数组', async () => {
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: 42, field: 'title', any: ['根本没有这个词'], because: '编的', evidenceItemIds: ['BV9'] },
    ]));
    await expect(runSuggestions(base)).rejects.toThrow(/自证/);
  });

  it('好的留下、坏的丢掉 —— 只要还剩得下就不抛', async () => {
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: 42, field: 'title', any: ['Agent'], because: '真', evidenceItemIds: ['BV9'] },
      { folderTempId: 42, field: 'title', any: ['编的词'], because: '假', evidenceItemIds: ['BV9'] },
    ]));
    const got = await runSuggestions(base);
    expect(got).toHaveLength(1);
    expect(got[0]!.any).toEqual(['Agent']);
  });

  // 就算模型硬给锁定夹子提建议,也必须过不了验证 —— `validFolderIds` 里没有它。
  // 证据用的 BV1 真存在且真被 "Python" 命中:这一条只会因为**锁**被丢,不是因为证据。
  it('给锁定夹子的建议也过不了验证(validFolderIds 里没有它)', async () => {
    const db = seededWithLocked();
    const locked = listWorkFolders(db).find((f) => f.name === '默认收藏夹')!;

    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: locked.id, field: 'title', any: ['Python'], because: 'x', evidenceItemIds: ['BV1'] },
    ]));
    // 唯一的建议被刷掉 → 按新契约抛(用户得知道"提了但没事下来"),而不是静默空数组
    await expect(
      runSuggestions({ config, ...suggestionInput(db), cap: 50 }),
    ).rejects.toThrow(/自证/);
  });

  it('同一组词出现两次 → 合并成一条,证据并起来', async () => {
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: 42, field: 'title', any: ['Agent'], because: 'a', evidenceItemIds: ['BV9'] },
      { folderTempId: 42, field: 'title', any: ['Agent'], because: 'b', evidenceItemIds: ['BV9'] },
    ]));
    expect(await runSuggestions(base)).toHaveLength(1);
  });

  it('规则覆盖光了 → 一次 LLM 都不调(没有可提的)', async () => {
    const got = await runSuggestions({ ...base, pool: [] });
    expect(got).toEqual([]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  // §9C.5 b "只在需要时付费":传了 homelessIds 就是"归类时一条都没归上"的信号,
  // 那就没什么可建议的 —— 不调
  it('homelessIds 是空集 → 不调(这是省钱闸)', async () => {
    const got = await runSuggestions({ ...base, homelessIds: new Set<string>() });
    expect(got).toEqual([]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('homelessIds 不传 → 照常调(界面上主动问那条路没有这个信息)', async () => {
    mocks.complete.mockResolvedValue(JSON.stringify([
      { folderTempId: 42, field: 'title', any: ['Agent'], because: 'x', evidenceItemIds: ['BV9'] },
    ]));
    expect(await runSuggestions(base)).toHaveLength(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  // cap 是必须的:全库几千条没规则时,不加限制的 prompt 会远超任何上下文窗口
  it('pool 超过 cap → 只喂 cap 条', async () => {
    const many = Array.from({ length: 10 }, (_, i) => item(`BV${i}`, `标题${i}`));
    mocks.complete.mockResolvedValue('[]');

    await runSuggestions({ ...base, pool: many, allItems: many, cap: 3 });

    const prompt = mocks.complete.mock.calls[0]![0].messages[1].content as string;
    expect(prompt).toContain('标题0');
    expect(prompt).not.toContain('标题9');
  });

  // cap 切的是尾巴,所以最该被看见的必须排最前
  it('homeless 的条目排在最前 —— cap 切不掉它们', async () => {
    const many = Array.from({ length: 10 }, (_, i) => item(`BV${i}`, `标题${i}`));
    mocks.complete.mockResolvedValue('[]');

    await runSuggestions({
      ...base, pool: many, allItems: many, cap: 2,
      homelessIds: new Set(['BV9']),
    });

    const prompt = mocks.complete.mock.calls[0]![0].messages[1].content as string;
    expect(prompt).toContain('标题9');
    expect(prompt).toContain('标题0');
    expect(prompt).not.toContain('标题1');
  });

  // ★ 这两条是"什么都没发生"的修复:**模型给了东西但我们用不了 ≠ 没有建议可提**。
  // 前者必须出声,否则用户付了几十秒只看到面板什么都不变(真机踩过)。
  it('模型吐的东西解析不出来 → 抛错,不是静默返回空数组', async () => {
    mocks.complete.mockResolvedValue('我不太明白你的意思');
    await expect(runSuggestions(base)).rejects.toThrow(/JSON/);
  });

  it('提了但全没过自证 → 抛错,而且说清提了几条', async () => {
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { folderTempId: 42, field: 'title', any: ['根本打不中'], because: 'x', evidenceItemIds: ['BV9'] },
        { folderTempId: 42, field: 'title', any: ['也打不中'], because: 'y', evidenceItemIds: ['BV9'] },
      ]),
    );
    await expect(runSuggestions(base)).rejects.toThrow(/2 条/);
  });

  // ★ 真机上这才是主力原因:qwen2.5:14b 引用的 8 个 bvid 里 7 个库里根本不存在。
  // 说成"关键词打不中"会把用户指错方向 —— 去找关键词的问题,而其实是模型在编 id。
  it('引用的 bvid 是编的 → 说清有几个是编的,而不是含糊说"关键词打不中"', async () => {
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { folderTempId: 42, field: 'title', any: ['Agent'], because: 'x', evidenceItemIds: ['BV编的1', 'BV编的2'] },
      ]),
    );
    await expect(runSuggestions(base)).rejects.toThrow(/2 个 id 在库里根本不存在/);
  });

  it('条目是真的、只是词打不中 → 才说"关键词打不中"', async () => {
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { folderTempId: 42, field: 'title', any: ['库里没有这个词'], because: 'x', evidenceItemIds: ['BV9'] },
      ]),
    );
    await expect(runSuggestions(base)).rejects.toThrow(/关键词打不中/);
  });

  // 但"模型确实没什么可说的"是**正常结果**,不该当失败 —— 面板那边给一句人话就行
  it('模型返回空数组 → 就是空数组,不抛', async () => {
    mocks.complete.mockResolvedValue('[]');
    expect(await runSuggestions(base)).toEqual([]);
  });
});

describe('SUGGESTION_SYSTEM', () => {
  // 提示词是这条链上唯一的防线,用测试钉住那几句关键要求(classifier.ts 同款做法)
  it('钉住"必须给证据条目"和三个字段', () => {
    expect(SUGGESTION_SYSTEM).toContain('evidenceItemIds');
    expect(SUGGESTION_SYSTEM).toContain('title');
    expect(SUGGESTION_SYSTEM).toContain('JSON');
  });

  // 真机上 qwen2.5:14b 两次都把 any 写成了字符串(`"any":"4K修复"`),
  // 而校验器要求数组 —— 54 条建议全被丢掉,用户只看到"什么都没发生"。
  it('把 any 必须是数组这件事钉死,并给出对错例子', () => {
    expect(SUGGESTION_SYSTEM).toContain('数组');
    expect(SUGGESTION_SYSTEM).toContain('"any":["'); // 正确写法的例子
    expect(SUGGESTION_SYSTEM).toContain('"any":"'); // 错误写法的反例
  });

  // 提示词原本没说最多几条,于是模型给 68 条条目配了 ~54 条建议(一条条目一条)。
  // 规则的价值在于**成批**接住一类,一条只接得住自己的规则没有意义。
  it('限条数,并要求每条成批接住而不是一条条目一条', () => {
    expect(SUGGESTION_SYSTEM).toMatch(/最多\s*\d+\s*条/);
    expect(SUGGESTION_SYSTEM).toContain('成批');
  });
});
