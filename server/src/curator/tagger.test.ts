import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertItem } from '../db/repo/items.js';
import { listUntaggedItemIds } from '../db/repo/tagging.js';
import { itemTagIds, listTagTree, normalizeTagName, findTag } from '../db/repo/tags.js';
import type { ItemRow } from '../db/repo/items.js';
import type { ModelMeta } from '../llm/registry.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

const { runTagging, coerceTagOutput, TAG_KINDS } = await import('./tagger.js');

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
