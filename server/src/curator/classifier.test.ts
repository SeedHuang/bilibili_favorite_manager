import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelMeta } from '../llm/registry.js';
import type { ItemRow } from '../db/repo/items.js';
import type { FolderSpec } from '../db/repo/sessions.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', () => ({ complete: mocks.complete }));

const {
  validateProposal,
  isBlocking,
  describeReport,
  sampleBalanced,
  coerceProposal,
  coerceAssignments,
  buildPass1Prompt,
  buildPass2Prompt,
  runPass1,
  runPass2,
  classifyAll,
  TaxonomyValidationError,
  MIN_BATCH,
  PASS1_SYSTEM,
  PASS2_SYSTEM,
} = await import('./classifier.js');
const { batchSize } = await import('../llm/context.js');

/** 小模型:batchSize = min((6000-1500)/250, 1000/60) = 16 */
const tinyCtx: ModelMeta = {
  provider: 'ollama',
  model: 'qwen2.5:14b',
  contextWindow: 6_000,
  maxOutput: 1_000,
  verified: true,
};
const config = { id: '本地', provider: 'ollama', baseUrl: '', apiKey: '', model: 'qwen2.5:14b' };

const item = (id: string, title: string, extra: Partial<ItemRow> = {}): ItemRow => ({
  id,
  type: 2,
  title,
  intro: null,
  cover: null,
  upper_mid: null,
  upper_name: null,
  duration: null,
  pubtime: null,
  invalid: 0,
  invalid_checked_at: null,
  ai_tags: null,
  ai_summary: null,
  ai_checked_at: null,
  raw: null,
  ...extra,
});

const folder = (tempId: string, name: string, reuseFolderId?: number): FolderSpec => ({
  tempId,
  name,
  description: '',
  rule: '看标题',
  estCount: 10,
  ...(reuseFolderId === undefined ? {} : { reuseFolderId }),
});

const existing = [
  { id: 42, name: '深度学习' },
  { id: 43, name: '前端' },
];

beforeEach(() => vi.clearAllMocks());

// ── §9.1.1 输出校验 ─────────────────────────────────────
describe('validateProposal(§9.1.1)', () => {
  it('reuseFolderId 引用不存在的 id → 记进 invalidReuseIds', () => {
    const r = validateProposal({ folders: [folder('f1', 'AI', 999)], notes: '' }, existing);
    expect(r.invalidReuseIds).toEqual([999]);
  });

  it('同一个现有夹子被复用两次 → 记进 duplicateReuseIds', () => {
    const r = validateProposal(
      { folders: [folder('f1', 'A', 42), folder('f2', 'B', 42)], notes: '' },
      existing,
    );
    expect(r.duplicateReuseIds).toEqual([{ folderId: 42, tempIds: ['f1', 'f2'] }]);
  });

  it('没被任何草稿夹子复用的现有夹子 → 记进 unmatched(警告,不阻断)', () => {
    const r = validateProposal({ folders: [folder('f1', 'A', 42)], notes: '' }, existing);
    expect(r.unmatchedExistingFolders).toEqual([43]);
  });

  it('新建夹子与现有夹子重名 → nameConflicts', () => {
    const r = validateProposal({ folders: [folder('f1', '深度学习')], notes: '' }, existing);
    expect(r.nameConflicts).toEqual(['深度学习']);
  });

  it('复用了的现有夹子不算重名 —— 那是正常复用,不是冲突', () => {
    const r = validateProposal({ folders: [folder('f1', '深度学习', 42)], notes: '' }, existing);
    expect(r.nameConflicts).toEqual([]);
  });

  it('同一个不存在的 id 被引用两次只报一次', () => {
    const r = validateProposal(
      { folders: [folder('f1', 'A', 999), folder('f2', 'B', 999)], notes: '' },
      existing,
    );
    expect(r.invalidReuseIds).toEqual([999]);
  });

  it('完全干净的体系没有任何问题', () => {
    const r = validateProposal(
      { folders: [folder('f1', 'A', 42), folder('f2', 'B', 43)], notes: '' },
      existing,
    );
    expect(r).toEqual({
      invalidReuseIds: [],
      duplicateReuseIds: [],
      unmatchedExistingFolders: [],
      nameConflicts: [],
      renamedLockedFolders: [],
    });
  });

  it('前两条是阻断性的,后两条只是警告', () => {
    expect(isBlocking(validateProposal({ folders: [folder('f1', 'A', 999)], notes: '' }, existing))).toBe(true);
    expect(isBlocking(validateProposal({ folders: [folder('f1', 'A', 42)], notes: '' }, existing))).toBe(false);
    expect(isBlocking(validateProposal({ folders: [folder('f1', '深度学习')], notes: '' }, existing))).toBe(false);
  });

  // B站 自带的默认收藏夹不能改名。放过去的话方案看着没问题,
  // 到 M5 写回时才失败 —— 那时代价大得多。
  it('复用锁定的夹子却改名 → renamedLockedFolders', () => {
    const locked = [{ id: 9, name: '默认收藏夹', locked: true }];
    const r = validateProposal({ folders: [folder('f1', '新名字', 9)], notes: '' }, locked);
    expect(r.renamedLockedFolders).toEqual([
      { folderId: 9, from: '默认收藏夹', to: '新名字' },
    ]);
  });

  it('复用锁定的夹子但保留原名 → 没问题(往里移条目是允许的)', () => {
    const locked = [{ id: 9, name: '默认收藏夹', locked: true }];
    const r = validateProposal({ folders: [folder('f1', '默认收藏夹', 9)], notes: '' }, locked);
    expect(r.renamedLockedFolders).toEqual([]);
    expect(r.invalidReuseIds).toEqual([]);
  });

  it('未锁定的夹子改名不受影响', () => {
    const r = validateProposal({ folders: [folder('f1', '新名字', 42)], notes: '' }, existing);
    expect(r.renamedLockedFolders).toEqual([]);
  });

  it('describeReport 会说清哪个夹子不能改名', () => {
    const locked = [{ id: 9, name: '默认收藏夹', locked: true }];
    const lines = describeReport(
      validateProposal({ folders: [folder('f1', '新名字', 9)], notes: '' }, locked),
      locked,
    );
    expect(lines.join('\n')).toContain('不能改名');
    expect(lines.join('\n')).toContain('默认收藏夹');
  });

  it('describeReport 把问题说成人话 —— UI 直接展示', () => {
    const lines = describeReport(
      validateProposal({ folders: [folder('f1', 'A', 999), folder('f2', '深度学习')], notes: '' }, existing),
    );
    expect(lines.join('\n')).toContain('999');
    expect(lines.join('\n')).toContain('重名');
  });
});

// ── 抽样 ────────────────────────────────────────────────
describe('sampleBalanced', () => {
  const items = [
    ...Array.from({ length: 200 }, (_, i) => ({ g: '大', i })),
    ...Array.from({ length: 3 }, (_, i) => ({ g: '小', i })),
  ];

  it('小组不会被大组挤掉 —— 轮转取,不是按组取前 N', () => {
    const got = sampleBalanced(items, (x) => x.g, { max: 10, perGroupMax: 15 });
    expect(got.filter((x) => x.g === '小')).toHaveLength(3);
  });

  it('单组封顶', () => {
    const got = sampleBalanced(items, (x) => x.g, { max: 100, perGroupMax: 15 });
    expect(got.filter((x) => x.g === '大')).toHaveLength(15);
  });

  it('不超过总上限', () => {
    expect(sampleBalanced(items, (x) => x.g, { max: 5, perGroupMax: 15 })).toHaveLength(5);
  });

  it('确定性 —— 同输入同输出(体系要能复现)', () => {
    const a = sampleBalanced(items, (x) => x.g, { max: 10, perGroupMax: 15 });
    const b = sampleBalanced(items, (x) => x.g, { max: 10, perGroupMax: 15 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('空输入返回空', () => {
    expect(sampleBalanced([], (x: { g: string }) => x.g, { max: 10, perGroupMax: 5 })).toEqual([]);
  });

  it('12000 条也只抽到上限 —— 不会因为库大就多喂 token', () => {
    const big = Array.from({ length: 12_000 }, (_, i) => ({ g: `g${i % 40}`, i }));
    const got = sampleBalanced(big, (x) => x.g, { max: 100, perGroupMax: 15 });
    expect(got.length).toBeLessThanOrEqual(100);
  });
});

// ── 输出收窄 ────────────────────────────────────────────
describe('coerceAssignments', () => {
  const valid = new Set(['f1', 'f2']);

  it('不存在的 tempId 直接丢掉 —— Pass 2 自己编也落不到空夹子上', () => {
    const got = coerceAssignments('[{"itemId":"BV1","folderTempId":"f9"}]', valid);
    expect(got![0]!.folderTempId).toBeNull();
  });

  it('保留合法的 tempId', () => {
    const got = coerceAssignments('[{"itemId":"BV1","folderTempId":"f1"}]', valid);
    expect(got![0]!.folderTempId).toBe('f1');
  });

  it('置信度被夹到 0..1', () => {
    const got = coerceAssignments('[{"itemId":"BV1","confidence":9}]', valid);
    expect(got![0]!.confidence).toBe(1);
  });

  it('没有 itemId 的条目跳过', () => {
    expect(coerceAssignments('[{"folderTempId":"f1"}]', valid)).toBeNull();
  });

  it('**删除保险**:模型输出里的 remove/删除字段没有任何通道可走', () => {
    const raw = '[{"itemId":"BV1","folderTempId":"f1","op":"remove_item","remove":true,"delete":true}]';
    const got = coerceAssignments(raw, valid)!;
    expect(got[0]).toEqual({
      itemId: 'BV1',
      folderTempId: 'f1',
      confidence: 0.5,
      reason: '',
    });
    expect(JSON.stringify(got)).not.toContain('remove');
  });

  it('完全解析不了返回 null(触发缩批)', () => {
    expect(coerceAssignments('我觉得都挺好', valid)).toBeNull();
  });
});

describe('coerceProposal', () => {
  it('拿得到 folders + notes', () => {
    const p = coerceProposal('{"folders":[{"name":"AI","rule":"x"}],"notes":"合并了 3 个"}')!;
    expect(p.folders[0]!.name).toBe('AI');
    expect(p.folders[0]!.tempId).toBe('f1'); // 缺 tempId 时自动补
    expect(p.notes).toBe('合并了 3 个');
  });

  it('没有名字的夹子丢掉', () => {
    expect(coerceProposal('{"folders":[{"rule":"x"}]}')).toBeNull();
  });

  it('围栏 JSON 也能收', () => {
    expect(coerceProposal('```json\n{"folders":[{"name":"A"}]}\n```')).not.toBeNull();
  });

  it('reuseFolderId 原样保留(校验层要看到它才能报错)', () => {
    const p = coerceProposal('{"folders":[{"name":"A","reuseFolderId":999}]}')!;
    expect(p.folders[0]!.reuseFolderId).toBe(999);
  });
});

// ── Prompt ──────────────────────────────────────────────
describe('prompt 组装', () => {
  it('Pass 1 必须带上现有夹子的 id 和名字 —— 不然 AI 说不了"你该怎么合并"', () => {
    const p = buildPass1Prompt({
      existingFolders: existing,
      sample: [item('BV1', 'Python 教程')],
    });
    expect(p).toContain('#42 深度学习');
    expect(p).toContain('#43 前端');
    expect(p).toContain('Python 教程');
  });

  it('Pass 1 带上用户约束', () => {
    const p = buildPass1Prompt({
      existingFolders: existing,
      sample: [],
      userConstraint: '控制在 15 个以内',
    });
    expect(p).toContain('控制在 15 个以内');
  });

  it('Pass 2 只带 name + rule —— description/estCount 对归类没用,纯占 token', () => {
    const p = buildPass2Prompt({
      folders: [{ ...folder('f1', 'AI/编程'), description: '很长的说明', estCount: 999 }],
      items: [item('BV1', '题')],
    });
    // tempId 用**方括号单独框出来** —— 它现在是裸数字(工作夹子 id),
    // 写成 `63:健身` 时实测小模型会填名字而不是数字,整批归类全落空
    expect(p).toContain('[f1] AI/编程');
    expect(p).not.toContain('很长的说明');
    expect(p).not.toContain('999');
  });

  it('Pass 2 的 system 提示把"填数字不填名字"说到不可能误解', () => {
    // 这不是文案洁癖:实测 qwen2.5:14b 会填夹子名字,于是 15 条全变"未归类",
    // 而界面上显示的是"归类完成"。提示词是这条链上唯一的防线。
    expect(PASS2_SYSTEM).toContain('方括号里的那个数字');
    expect(PASS2_SYSTEM).toContain('不要填夹子名字');
    expect(PASS2_SYSTEM).toContain('不要翻译成中文');
  });

  // 模型很自然把 tempId 吐成数字 63 而不是字符串 "63"
  it('folderTempId 是数字也认 —— 否则整批静默变成未归类', () => {
    const valid = new Set(['63', '64']);
    const got = coerceAssignments('[{"itemId":"BV1","folderTempId":63}]', valid);
    expect(got![0]!.folderTempId).toBe('63');
  });

  it('Pass 2 不带收藏时间(fav_time 与主题无关,spec §9.3)', () => {
    const p = buildPass2Prompt({ folders: [folder('f1', 'A')], items: [item('BV1', '题')] });
    expect(p).not.toContain('fav');
  });

  it('简介过长会截断,不撑爆上下文', () => {
    const p = buildPass1Prompt({
      existingFolders: [],
      sample: [item('BV1', '题', { intro: '长'.repeat(5000) })],
    });
    expect(p.length).toBeLessThan(2000);
  });
});

describe('buildPass2Prompt · 规则与样本', () => {
  it('Pass 2 渲染规则 —— 这个字段从 spec §9.1 起就写着"必须可执行"', () => {
    const p = buildPass2Prompt({
      folders: [folder('42', 'AI/编程')],
      items: [item('BV1', '题')],
    });
    // folder() helper 默认 rule 是 '看标题'
    expect(p).toContain('[42] AI/编程 —— 看标题');
  });

  it('Pass 2 带样本标题 —— 没有规则的夹子靠它们表达"我是放什么的"', () => {
    const p = buildPass2Prompt({
      folders: [folder('42', '黑神话')],
      items: [item('BV1', '题')],
      samples: new Map([[42, ['黑神话悟空 第一回', '黑神话 全成就攻略']]]),
    });
    expect(p).toContain('黑神话悟空 第一回');
    expect(p).toContain('黑神话 全成就攻略');
  });

  it('Pass 2 不带样本时不留空行', () => {
    const p = buildPass2Prompt({ folders: [folder('42', 'AI/编程')], items: [item('BV1', '题')] });
    expect(p).not.toContain('现有条目');
  });
});

// ── §9E C5/C6 归类吃标签 ────────────────────────────────
describe('buildPass2Prompt · AI 标注', () => {
  // spec §9E C5:标注作为补充信号进入归类 prompt —— 有才写,没有不占行
  it('带 AI 标注的条目在 prompt 里多一行 AI标签', () => {
    const tagged = item('BV1', 'AI 动画教程', {
      ai_tags: '{"tags":["Stable Diffusion","AI动画"],"kind":"教学"}',
    });
    const p = buildPass2Prompt({ folders: [folder('42', 'AI/动画')], items: [tagged] });
    expect(p).toContain('AI标签:Stable Diffusion·AI动画 [教学]');
  });

  it('没有标注的条目不留空行(和今天完全一样)', () => {
    const untagged = item('BV2', '普通条目');
    const p = buildPass2Prompt({ folders: [folder('42', 'AI/动画')], items: [untagged] });
    expect(p).not.toContain('AI标签');
  });

  // kind 被标注引擎兜底成 '其它' —— 只看 kind 非空的话,这条会渲染出一行
  // 光秃秃的「AI标签:」,违背 C5「有才写,没有不占行」
  it('只有兜底的 kind「其它」、没有标签 → 整行不写', () => {
    const bare = item('BV3', '无标注条目', { ai_tags: '{"tags":[],"kind":"其它"}' });
    const p = buildPass2Prompt({ folders: [folder('42', 'AI/动画')], items: [bare] });
    expect(p).not.toContain('AI标签');
  });

  it('有标签但 kind 是「其它」→ 写标签行,不写 kind 后缀', () => {
    const t = item('BV4', '条目', { ai_tags: '{"tags":["随手拍"],"kind":"其它"}' });
    const p = buildPass2Prompt({ folders: [folder('42', 'AI/动画')], items: [t] });
    expect(p).toContain('AI标签:随手拍');
    expect(p).not.toContain('AI标签:随手拍 [');
  });

  // spec §9E C6:标签是参考,原始数据是事实 —— 提示词是这条链的防线,钉住这句
  it('PASS2_SYSTEM 声明「标签是参考,原始数据为准」', () => {
    expect(PASS2_SYSTEM).toContain('标签是参考');
    expect(PASS2_SYSTEM).toContain('原始');
  });

  // renderItem 是**共用**的(Pass 1 的样本也走它),所以同一句话 Pass 1 也得有 ——
  // 只写在 PASS2_SYSTEM 里的话,Pass 1 会拿标签当事实用它提体系
  it('PASS1_SYSTEM 也带上同一句「标签是参考」', () => {
    expect(PASS1_SYSTEM).toContain('标签是参考');
    expect(PASS1_SYSTEM).toContain('原始');
  });

  // {tags:[], kind:'教学'} 渲染成「AI标签: [教学]」—— 那个空格前面什么都没有。
  // 正常格式(`AI标签:tag1·tag2 [kind]`)一个字都不动,只在缺标签时不留分隔符
  it('有 kind 没标签 → 不留那个空出来的空格', () => {
    const t = item('BV5', '条目', { ai_tags: '{"tags":[],"kind":"教学"}' });
    const p = buildPass2Prompt({ folders: [folder('42', 'AI/动画')], items: [t] });
    expect(p).toContain('AI标签:[教学]');
    expect(p).not.toContain('AI标签: [教学]');
  });
});

// ── Pass 1 ──────────────────────────────────────────────
describe('runPass1', () => {
  const items = Array.from({ length: 30 }, (_, i) => item(`BV${i}`, `Python 教程 ${i}`));

  it('校验不通过直接抛,并带上报告 —— Pass 2 绝不跟着错的体系跑', async () => {
    mocks.complete.mockResolvedValue('{"folders":[{"tempId":"f1","name":"A","reuseFolderId":999}]}');
    await expect(
      runPass1({ config, existingFolders: existing, items }),
    ).rejects.toBeInstanceOf(TaxonomyValidationError);
  });

  it('重复复用也抛', async () => {
    mocks.complete.mockResolvedValue(
      '{"folders":[{"tempId":"f1","name":"A","reuseFolderId":42},{"tempId":"f2","name":"B","reuseFolderId":42}]}',
    );
    await expect(runPass1({ config, existingFolders: existing, items })).rejects.toBeInstanceOf(
      TaxonomyValidationError,
    );
  });

  it('只是警告(有未复用的现有夹子)不阻断,体系照常返回', async () => {
    mocks.complete.mockResolvedValue('{"folders":[{"tempId":"f1","name":"新名","reuseFolderId":42}]}');
    const r = await runPass1({ config, existingFolders: existing, items });
    expect(r.validation.unmatchedExistingFolders).toEqual([43]);
    expect(r.taxonomy.folders).toHaveLength(1);
  });

  it('keyword 初分是本地算的,不花 token', async () => {
    mocks.complete.mockResolvedValue('{"folders":[{"tempId":"f1","name":"A","reuseFolderId":42}]}');
    const r = await runPass1({ config, existingFolders: existing, items });
    expect(r.keywordStats.matched).toBe(30); // "Python" 全命中
    expect(r.keywordStats.clusters.get('AI/编程')).toBe(30);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it('喂进去的样本不超过 §9.1 的上限', async () => {
    mocks.complete.mockResolvedValue('{"folders":[{"tempId":"f1","name":"A","reuseFolderId":42}]}');
    const many = Array.from({ length: 500 }, (_, i) => item(`BV${i}`, `随手拍 ${i}`));
    const r = await runPass1({ config, existingFolders: existing, items: many });
    expect(r.sample.length).toBeLessThanOrEqual(100);
  });

  it('吐不出可用 JSON 时报错,而不是返回一个空体系', async () => {
    mocks.complete.mockResolvedValue('抱歉,我需要更多信息');
    await expect(runPass1({ config, existingFolders: existing, items })).rejects.toThrow(/JSON/);
  });
});

// ── Pass 2 ──────────────────────────────────────────────
describe('runPass2', () => {
  const folders = [folder('f1', 'AI/编程')];
  const items = Array.from({ length: 40 }, (_, i) => item(`BV${i}`, `题 ${i}`));

  it('按 contextWindow 动态分批 —— 12000 条不会一把塞', () => {
    const size = batchSize(tinyCtx);
    expect(Math.ceil(12_000 / size)).toBeGreaterThan(100);
  });

  it('40 条 / 批 16 → 3 批,每批一次调用', async () => {
    mocks.complete.mockResolvedValue('[{"itemId":"x","folderTempId":"f1"}]');
    await runPass2({ config, ctx: tinyCtx, folders, items });
    expect(mocks.complete).toHaveBeenCalledTimes(3);
  });

  it('进度回调走完全程 —— 批号从 1 递增,done 是条目数', async () => {
    mocks.complete.mockResolvedValue('[{"itemId":"x","folderTempId":"f1"}]');
    const seen: { batch: number; batches: number; done: number; total: number }[] = [];
    await runPass2({
      config,
      ctx: tinyCtx,
      folders,
      items,
      onBatch: (b) => seen.push({ batch: b.batch, batches: b.batches, done: b.done, total: b.total }),
    });
    expect(seen).toEqual([
      { batch: 1, batches: 3, done: 16, total: 40 },
      { batch: 2, batches: 3, done: 32, total: 40 },
      { batch: 3, batches: 3, done: 40, total: 40 },
    ]);
  });

  // §9D A2:进度要带批次号和批总数,界面才显示得出"第 5/11 批"
  it('onBatch 回调带 batch / batches / done / total,以及本批归属与失败账', async () => {
    // tinyCtx 的 batchSize=16,种 3 条 → 1 批
    mocks.complete.mockResolvedValue(
      '[{"itemId":"BV1","folderTempId":"42","confidence":0.9,"reason":"r"},' +
        '{"itemId":"BV2","folderTempId":"42","confidence":0.8,"reason":"r"},' +
        '{"itemId":"BV3","folderTempId":"42","confidence":0.7,"reason":"r"}]',
    );
    const seen: {
      batch: number;
      batches: number;
      done: number;
      total: number;
      assignments: readonly { itemId: string }[];
      failedBatches: readonly { reason: string }[];
    }[] = [];
    await runPass2({
      config,
      ctx: tinyCtx,
      folders: [folder('42', 'AI/编程')],
      items: [item('BV1', 'a'), item('BV2', 'b'), item('BV3', 'c')],
      onBatch: (b) => seen.push(b),
    });
    expect(seen.map(({ batch, batches, done, total }) => ({ batch, batches, done, total }))).toEqual([
      { batch: 1, batches: 1, done: 3, total: 3 },
    ]);
    // 载荷还得带上"这批归了什么"和"截至这批的失败账",界面才画得出明细
    expect(seen[0]!.assignments.map((a) => a.itemId)).toEqual(['BV1', 'BV2', 'BV3']);
    expect(seen[0]!.failedBatches).toEqual([]);
  });

  // §9D B2:中止 = 不再发起下一批,已完成的部分照常返回
  it('signal 中止后立刻返回 —— 第二批不再发起,已完成的批次保留', async () => {
    const controller = new AbortController();
    // 20 条 / 批 16 → **两批**。一批的话 calls===1 是白给的,
    // 只有真有两批,这个断言才证明得了"第二批被 pre-dequeue 检查拦下"
    const items = Array.from({ length: 20 }, (_, i) => item(`BV${i}`, `题${i}`));
    let calls = 0;
    mocks.complete.mockImplementation(async () => {
      calls += 1;
      // 第一批(16 条)成功返回后中止 —— 第二批必须不被发起
      controller.abort();
      return JSON.stringify(
        items.slice(0, 16).map((it) => ({
          itemId: it.id,
          folderTempId: '42',
          confidence: 0.9,
          reason: 'r',
        })),
      );
    });
    const got = await runPass2({
      config,
      ctx: tinyCtx,
      folders: [folder('42', 'AI/编程')],
      items,
      signal: controller.signal,
    });
    expect(calls).toBe(1); // 真的两批:没有 abort 时这里会是 2
    // 主动中断不是"数据坏了" —— failedBatches 是那笔账,中止不进它(§9D B5)
    expect(got.failedBatches).toEqual([]);
    expect(got.assignments).toHaveLength(16); // 已完成的批次保留
  });

  // §9D B5 的主路径:批内 abort —— complete 抛 AbortError,catch 分支必须
  // **break** 而不是把这笔账记进 failedBatches(那是"数据坏了"的账)。
  // 注意 abort 发生在 mock **内部**,所以信号在出队时还没中止 ——
  // 这个用例才会真的走到 catch,而不是被 pre-dequeue 检查提前拦下。
  it('批内中止(complete 抛 AbortError)→ 不记 failedBatches,不抛', async () => {
    const controller = new AbortController();
    mocks.complete.mockImplementation(async () => {
      controller.abort(); // 生成中途被停
      throw new Error('This operation was aborted');
    });
    const got = await runPass2({
      config,
      ctx: tinyCtx,
      folders: [folder('42', 'AI/编程')],
      items: [item('BV1', 'a'), item('BV2', 'b'), item('BV3', 'c')],
      signal: controller.signal,
    });
    expect(got.failedBatches).toEqual([]); // ← 回归这里是全绿变红的关键断言
    expect(got.assignments).toEqual([]);
  });

  it('某批解析失败 → 缩批重试,条目仍能归类(§9.4 第 3 层)', async () => {
    mocks.complete
      .mockResolvedValueOnce('这个我看不懂') // 第 1 批 16 条,坏 JSON
      .mockResolvedValue('[{"itemId":"x","folderTempId":"f1"}]');

    const r = await runPass2({
      config,
      ctx: tinyCtx,
      folders,
      items: items.slice(0, 16), // 正好一批 16 > MIN_BATCH
    });

    expect(r.failedBatches).toEqual([]);
    expect(r.assignments.length).toBeGreaterThan(0);
  });

  it('缩到 MIN_BATCH 还失败 → 只标记该批,其余批次继续(第 4 层)', async () => {
    let calls = 0;
    mocks.complete.mockImplementation(async () => {
      calls++;
      // 前 3 次(第 1 批 + 它裂成的两半)全是坏 JSON,之后再正常
      return calls <= 3 ? '看不懂' : '[{"itemId":"x","folderTempId":"f1"}]';
    });

    const r = await runPass2({ config, ctx: tinyCtx, folders, items: items.slice(0, 32) });

    expect(r.failedBatches.length).toBeGreaterThan(0);
    expect(r.failedBatches.every((b) => b.size <= MIN_BATCH)).toBe(true);
    expect(r.assignments.length).toBeGreaterThan(0); // 第 2 批照常完成
  });

  it('请求本身失败时不缩批 —— 网络问题缩批没用,只会白打', async () => {
    mocks.complete.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await runPass2({ config, ctx: tinyCtx, folders, items });
    expect(mocks.complete).toHaveBeenCalledTimes(3); // 3 批各一次,没有裂开
    expect(r.failedBatches).toHaveLength(3);
    expect(r.failedBatches[0]!.reason).toContain('ECONNREFUSED');
  });

  it('空体系 / 空条目直接返回,不打模型', async () => {
    expect(await runPass2({ config, ctx: tinyCtx, folders: [], items })).toEqual({
      assignments: [],
      failedBatches: [],
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

// ── 端到端 ──────────────────────────────────────────────
describe('classifyAll', () => {
  const items = Array.from({ length: 40 }, (_, i) => item(`BV${i}`, `Python 教程 ${i}`));

  const okProposal = '{"folders":[{"tempId":"f1","name":"AI/编程","reuseFolderId":42}],"notes":"复用深度学习夹"}';

  it('keyword → Pass 1 → 校验 → Pass 2 全程跑通', async () => {
    mocks.complete
      .mockResolvedValueOnce(okProposal)
      .mockResolvedValue('[{"itemId":"BV0","folderTempId":"f1","confidence":0.9,"reason":"是教程"}]');

    const r = await classifyAll({ config, ctx: tinyCtx, existingFolders: existing, items });

    expect(r.taxonomy.folders[0]!.name).toBe('AI/编程');
    expect(r.assignments).toHaveLength(40);
  });

  it('**assignments 覆盖每一条** —— 模型漏掉的补成待定,不能凭空消失', async () => {
    mocks.complete
      .mockResolvedValueOnce(okProposal)
      .mockResolvedValue('[{"itemId":"BV0","folderTempId":"f1","confidence":0.9,"reason":"是教程"}]');

    const r = await classifyAll({ config, ctx: tinyCtx, existingFolders: existing, items });

    expect(new Set(r.assignments.map((a) => a.itemId)).size).toBe(40);
    const unassigned = r.assignments.filter((a) => a.folderTempId === null);
    expect(unassigned).toHaveLength(39);
    expect(unassigned[0]!.reason).toContain('手动处理');
  });

  it('同一条被模型重复给出时保留置信度高的那个', async () => {
    mocks.complete
      .mockResolvedValueOnce(okProposal)
      .mockResolvedValue(
        '[{"itemId":"BV0","folderTempId":"f1","confidence":0.3},{"itemId":"BV0","folderTempId":null,"confidence":0.9}]',
      );

    const r = await classifyAll({ config, ctx: tinyCtx, existingFolders: existing, items });
    expect(r.assignments.find((a) => a.itemId === 'BV0')!.confidence).toBe(0.9);
  });

  it('**删除保险**:模型硬塞 remove_item 也进不了结果(§10.1.1)', async () => {
    mocks.complete.mockResolvedValueOnce(okProposal).mockResolvedValue(
      '[{"itemId":"BV0","folderTempId":"f1","op":"remove_item","action":"delete"}]',
    );

    const r = await classifyAll({ config, ctx: tinyCtx, existingFolders: existing, items });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('remove_item');
    expect(serialized).not.toContain('delete');
    // 而且没有任何条目的归属被表达成"删除"
    expect(r.assignments.every((a) => a.folderTempId === null || typeof a.folderTempId === 'string')).toBe(true);
  });
});
