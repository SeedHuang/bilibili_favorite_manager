import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
import { listUntaggedItemIds } from '../db/repo/tagging.js';
import {
  ensureTag, itemTagIds, linkItemTag, listTagTree, normalizeTagName, findTag,
} from '../db/repo/tags.js';
import type { ItemRow } from '../db/repo/items.js';
import type { ModelMeta } from '../llm/registry.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

const { runTagging, coerceTagOutput, applyTagOutput, TAG_KINDS } = await import('./tagger.js');

const ctx: ModelMeta = { provider: 'ollama', model: 'qwen3-4b', contextWindow: 262_144, maxOutput: 8_192, verified: true };
const config = { id: '本地', provider: 'ollama', baseUrl: '', apiKey: '', model: 'qwen3-4b' };

const item = (id: string, title: string): ItemRow => ({
  id, type: 2, title, intro: null, cover: null, upper_mid: null, upper_name: null,
  duration: null, pubtime: null, invalid: 0, invalid_checked_at: null,
  ai_tags: null, ai_summary: null, ai_checked_at: null, raw: null,
} as ItemRow);

beforeEach(() => vi.clearAllMocks());

describe('coerceTagOutput', () => {
  it('只收本批的 id;tags/domains 非数组或空串一律丢掉', () => {
    const got = coerceTagOutput(
      JSON.stringify([
        { id: 'BV1', kind: '娱乐', domains: ['美食'], tags: ['烤羊肉', ''] },
        { id: 'BV9', kind: '娱乐', domains: ['美食'], tags: ['不该收'] },
        { id: 'BV2', kind: '教学', domains: 'not-array', tags: ['x'] },
      ]),
      new Set(['BV1', 'BV2']),
    );
    expect(got.map((o) => o.id)).toEqual(['BV1', 'BV2']);
    expect(got[0]!.tags).toEqual(['烤羊肉']);
    expect(got[1]!.domains).toEqual([]);
  });

  it('领域和标签都空 → 整条丢弃,当没标(留给下一轮重试)', () => {
    // 收下它的话会写 ai_checked_at、于是这条**再也不会被重标**(增量只挑
    // ai_checked_at IS NULL),而它一个标签都没拿到 —— 等于永久漏掉
    expect(coerceTagOutput(JSON.stringify([{ id: 'BV1' }]), new Set(['BV1']))).toEqual([]);
  });

  it('只有 kind、没有标签 → 也算没标上(标签才是这条链路的目的)', () => {
    expect(coerceTagOutput(JSON.stringify([{ id: 'BV1', kind: '教学' }]), new Set(['BV1']))).toEqual([]);
  });

  // kind 受控枚举(C3)—— 越界的 kind 落库时按「其它」处理,不照单全收
  it('kind 越界 → 空串(落库按「其它」处理)', () => {
    const got = coerceTagOutput(
      JSON.stringify([{ id: 'BV1', kind: '宇宙无敌', domains: ['美食'], tags: ['烤羊肉'] }]),
      new Set(['BV1']),
    );
    expect(got[0]!.kind).toBe('');
  });

  it('TAG_KINDS 是六个受控值', () => {
    expect(TAG_KINDS).toEqual(['教学', '娱乐', '评测', '资讯', '工具', '其它']);
  });
});

describe('applyTagOutput', () => {
  it('**重标是替换不是叠加** —— 上一轮的标签不会留下当幽灵成员', () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    applyTagOutput(db, { id: 'BV1', kind: '娱乐', domains: ['户外'], tags: ['露营', '烤羊肉'] });
    // 第二次标同一条(「重新标注全部」就是这条路):露营 留着,烤羊肉 换成 天幕
    applyTagOutput(db, { id: 'BV1', kind: '娱乐', domains: ['户外'], tags: ['露营', '天幕'] });

    const roast = findTag(db, normalizeTagName('烤羊肉'))!;
    const ids = itemTagIds(db, ['BV1']).get('BV1')!;
    // 三个(户外 + 露营 + 天幕),**不是**并集的四个 —— §9F 的判据是集合关系,
    // 集里多一个上一轮的词,那个词之后的每一个覆盖率就都是错的
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(roast);
    // 词本身还在词库里 —— 换掉的是"这条视频挂着它",不是删词
    expect(db.prepare(`SELECT id FROM tags WHERE norm = ?`).get(normalizeTagName('烤羊肉')))
      .toBeDefined();
  });

  it('只清 `ai` 挂的 —— `user` 的标签不被一次模型重跑带走', () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    const camp = ensureTag(db, '露营', null);
    linkItemTag(db, 'BV1', camp, 'ai');
    const manual = ensureTag(db, '手动加的', null);
    linkItemTag(db, 'BV1', manual, 'user');

    applyTagOutput(db, { id: 'BV1', kind: '娱乐', domains: ['户外'], tags: ['天幕'] });

    const ids = itemTagIds(db, ['BV1']).get('BV1')!;
    expect(ids).toContain(manual); // 别的来源挂的不动
    expect(ids).not.toContain(camp); // 模型自己挂的那批整批换掉
  });
});

describe('runTagging', () => {
  it('领域成为根,词挂在领域下;别名表记下每个词', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: '我在新疆野外烤羊肉' });
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { id: 'BV1', kind: '娱乐', domains: ['美食', '户外'], tags: ['露营', '烤羊肉'] },
      ]),
    );

    const r = await runTagging({ config, ctx, items: [item('BV1', '我在新疆野外烤羊肉')], db });
    expect(r.tagged).toBe(1);

    const tree = listTagTree(db);
    expect(tree.map((n) => n.name).sort()).toEqual(['户外', '美食']);
    const ids = itemTagIds(db, ['BV1']).get('BV1')!;
    expect(ids).toHaveLength(4); // 2 个领域 + 2 个词
    expect(findTag(db, normalizeTagName('露营'))).not.toBeNull();
  });

  it('报出本轮新建的词;onBatch 同步带着同一份名单', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ id: 'BV1', kind: '娱乐', domains: ['美食'], tags: ['露营', '烤羊肉'] }]),
    );

    // **这份名单是质检那道闸门唯一的上游。** 空掉的话 `runTagCheck` 会在
    // `newNames.length === 0` 处直接早退 —— 剔泛词(§9F.6 说它是判据唯一的软肋)
    // 从此永久静默失效,而**所有测试照绿**。所以这里必须断言真名。
    // onBatch 那份也要断:progress 帧读的就是它,两条路不能只对一条。
    const seen: string[][] = [];
    const r = await runTagging({
      config, ctx, items: [item('BV1', 'a')], db,
      onBatch: (b) => seen.push(b.newWords),
    });
    expect([...r.newWords].sort()).toEqual(['烤羊肉', '美食', '露营'].sort());
    expect(seen.at(-1)).toEqual(r.newWords);
  });

  it('跑第二遍同样的输入不新建节点(别名表的用处)', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
    const out = JSON.stringify([{ id: 'BV1', kind: '娱乐', domains: ['美食'], tags: ['露营'] }]);
    mocks.complete.mockResolvedValue(out);
    await runTagging({ config, ctx, items: [item('BV1', 'a')], db });
    const before = db.prepare(`SELECT COUNT(*) n FROM tags`).get();
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ id: 'BV2', kind: '娱乐', domains: ['美食'], tags: ['露营'] }]),
    );
    await runTagging({ config, ctx, items: [item('BV2', 'b')], db });
    expect(db.prepare(`SELECT COUNT(*) n FROM tags`).get()).toEqual(before);
  });

  it('模型漏条 → 补轮(逐条覆盖断言)', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
    mocks.complete
      .mockResolvedValueOnce(JSON.stringify([{ id: 'BV1', kind: '娱乐', domains: ['x'], tags: ['y'] }]))
      .mockResolvedValueOnce(JSON.stringify([{ id: 'BV2', kind: '娱乐', domains: ['x'], tags: ['z'] }]));
    const r = await runTagging({ config, ctx, items: [item('BV1', 'a'), item('BV2', 'b')], db });
    expect(r.tagged).toBe(2);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it('中止时不记失败,已完成的保留', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    const ctrl = new AbortController();
    mocks.complete.mockImplementation(async () => {
      ctrl.abort();
      throw new DOMException('已中止', 'AbortError');
    });
    const r = await runTagging({ config, ctx, items: [item('BV1', 'a')], db, signal: ctrl.signal });
    expect(r.failedBatches).toHaveLength(0);
  });

  it('标注写 ai_checked_at —— 增量靠它(漏了就是每次全库重标)', async () => {
    const db = openDb(':memory:');
    upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
    mocks.complete.mockResolvedValue(
      JSON.stringify([{ id: 'BV1', kind: '娱乐', domains: ['美食'], tags: ['露营'] }]),
    );
    await runTagging({ config, ctx, items: [item('BV1', 'a')], db });
    const row = db.prepare(`SELECT ai_kind, ai_checked_at FROM items WHERE id='BV1'`).get() as
      { ai_kind: string | null; ai_checked_at: number | null };
    expect(row.ai_kind).toBe('娱乐');
    expect(row.ai_checked_at).not.toBeNull();
    // 反过来说:水位线一落，增量池里就没有它了
    expect(listUntaggedItemIds(db)).toEqual([]);
  });
});
