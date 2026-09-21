import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { setState, stateKey } from '../db/repo/state.js';
import { ensureWorkcopy, listWorkFolders, workItemIds, hasWorkcopy } from '../db/repo/workbench.js';
import { listOperations } from '../db/repo/operations.js';
import {
  renameFolder, createFolder, deleteFolder, mergeFolders,
  moveItems, addItems, removeItems, resetWorkbench, assignItems,
} from './workbench.js';

function seeded() {
  const db = openDb(':memory:');
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertFolder(db, { id: 8, title: '不常用', mediaCount: 1 });
  upsertFolder(db, { id: 9, title: '默认收藏夹', mediaCount: 1, raw: JSON.stringify({ attr: 0 }) });
  for (const id of ['BV1', 'BV2', 'BV3', 'BV4']) upsertItem(db, { id, type: 2, title: id });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
  linkFolderItem(db, 8, 'BV3', 1);
  linkFolderItem(db, 9, 'BV4', 1);
  setState(db, stateKey.lastFull, '1000');
  return db;
}

/**
 * 快照夹子 id → 工作副本里对应的那个夹子 id。
 *
 * 必须先有副本:副本是"第一次编辑"时克隆的,而这些用例要在编辑**之前**先拿到
 * 目标 id。brief 初稿这里直接查 listWorkFolders,于是 14 条用例在到达任何断言前
 * 就 TypeError(副本还不存在)。ensureWorkcopy 幂等且不记日志,不影响任何断言。
 * 第 1 条用例特意不走这个 helper —— 它要验的正是"首次编辑才克隆"。
 */
const originIdOf = (db: ReturnType<typeof seeded>, snapshotId: number): number => {
  ensureWorkcopy(db);
  return listWorkFolders(db).find((f) => f.originId === snapshotId)!.id;
};

describe('编辑动作', () => {
  // 第一次编辑自动克隆 —— 不给用户"开始整理"这一步
  it('第一次编辑时自动建工作副本,而且克隆真的做了', () => {
    const db = seeded();
    expect(hasWorkcopy(db)).toBe(false);

    createFolder(db, '前端');   // 这就是"第一次编辑"

    expect(hasWorkcopy(db)).toBe(true);
    // 克隆的不只是状态行 —— 快照里的三个夹子都搬过来了,新的那个 originId 为空
    expect(listWorkFolders(db).map((f) => f.originId)).toEqual([7, 8, 9, null]);
  });

  it('改名改的是工作副本,快照不动', () => {
    const db = seeded();
    const id = originIdOf(db, 7);
    renameFolder(db, id, 'AI/编程');

    expect(listWorkFolders(db).find((f) => f.id === id)!.name).toBe('AI/编程');
    expect(db.prepare(`SELECT title FROM folders WHERE id = 7`).get()).toEqual({ title: '深度学习' });
  });

  it('改名留痕', () => {
    const db = seeded();
    renameFolder(db, originIdOf(db, 7), 'AI/编程');
    const log = listOperations(db);
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe('rename_folder');
    expect(log[0]!.summary).toContain('深度学习');
    expect(log[0]!.summary).toContain('AI/编程');
  });

  it('锁定的默认收藏夹不能改名', () => {
    const db = seeded();
    expect(() => renameFolder(db, originIdOf(db, 9), '新名字')).toThrow(/不能改名/);
  });

  it('新建夹子返回 id,并且是空夹', () => {
    const db = seeded();
    const id = createFolder(db, '前端');
    expect(workItemIds(db, id)).toEqual([]);
    expect(listOperations(db)[0]!.kind).toBe('create_folder');
  });

  it('名字超 20 字(B 站限制)建/改都拒 —— 本地建了同步也会被 B 站拒', () => {
    const db = seeded();
    expect(() => createFolder(db, 'a'.repeat(21))).toThrow(/20/);
    expect(() => createFolder(db, '一'.repeat(20))).not.toThrow(); // 恰好 20 可以
    const id = createFolder(db, '短名');
    expect(() => renameFolder(db, id, 'b'.repeat(21))).toThrow(/20/);
  });

  it('非空夹子可删(安全网兜底);锁定夹子仍然不能删', () => {
    const db = seeded();
    expect(() => deleteFolder(db, originIdOf(db, 9))).toThrow(/不能删除/);
    const human = originIdOf(db, 7);
    deleteFolder(db, human);
    expect(listWorkFolders(db).some((f) => f.id === human)).toBe(false);
  });

  it('锁定的夹子不能删除(哪怕它是空的)', () => {
    const db = seeded();
    const locked = originIdOf(db, 9);
    expect(() => deleteFolder(db, locked)).toThrow(/不能删除/);
  });

  it('合并 = 条目搬过去 + 源夹子消失,只留一条日志', () => {
    const db = seeded();
    const from = originIdOf(db, 8);
    const into = originIdOf(db, 7);
    const before = workItemIds(db, into).length;

    mergeFolders(db, [from], into);

    expect(workItemIds(db, into)).toHaveLength(before + 1);
    expect(workItemIds(db, into)).toContain('BV3');
    expect(listWorkFolders(db).find((f) => f.id === from)).toBeUndefined();

    const log = listOperations(db);
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe('merge_folders');
  });

  it('合并进锁定的夹子是允许的(往里移条目是允许的)', () => {
    const db = seeded();
    const locked = originIdOf(db, 9);
    const from = originIdOf(db, 8);
    expect(() => mergeFolders(db, [from], locked)).not.toThrow();
    expect(workItemIds(db, locked).sort()).toEqual(['BV3', 'BV4']);
  });

  // 合并的第二步就是删掉源夹子,所以"锁定不能删除"必须在这一步之前拦住 ——
  // 放它过去会做出一个写回 B站 时必然失败的工作副本(folders.ts 里那条注释说的正是这个)
  /**
   * 锁定的夹子**三个动作都不能碰**:改名、删除、移动并删除。
   *
   * 曾经这里是"条目照搬走、夹子留下并如实报告",理由是"默认收藏夹有 88% 的
   * 条目,得能批量清空" —— 理由站不住:那 88% 要的是**分类**(Pass 2 / 手挑),
   * 不是整体倒进另一个夹子。规则收成一条,界面上的 checkbox 也直接禁用。
   */
  it('锁定的源夹子 → 直接拒,和改名/删除同一条规则', () => {
    const db = seeded();
    const locked = originIdOf(db, 9);
    const into = originIdOf(db, 7);

    expect(() => mergeFolders(db, [locked], into)).toThrow(/不能移动并删除/);

    // 拒绝要干净:条目没动、夹子还在、也没留下半条日志
    expect(workItemIds(db, locked)).toEqual(['BV4']);
    expect(workItemIds(db, into)).toEqual(['BV1', 'BV2']);
    expect(listWorkFolders(db).some((f) => f.id === locked)).toBe(true);
    expect(listOperations(db)).toHaveLength(0);
  });

  it('源里混了一个锁定的 → 整批拒(不做一半)', () => {
    const db = seeded();
    const locked = originIdOf(db, 9);
    const plain = originIdOf(db, 8);
    const into = originIdOf(db, 7);

    expect(() => mergeFolders(db, [plain, locked], into)).toThrow(/不能移动并删除/);
    // 那个没锁的也不能被删 —— 要么全做要么全不做
    expect(listWorkFolders(db).some((f) => f.id === plain)).toBe(true);
    expect(listOperations(db)).toHaveLength(0);
  });

  it('目标夹子在源里 → 明确报错,不是默默做一遍', () => {
    const db = seeded();
    const into = originIdOf(db, 7);
    expect(() => mergeFolders(db, [into, originIdOf(db, 8)], into)).toThrow(/也在要处理的夹子里/);
  });

  // 移动 vs 也放进:B站 允许一个视频同时在多个夹子里,猜错就是悄悄删掉一份归属
  it('移动 = 离开原处,放进目标', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    const b = originIdOf(db, 8);
    addItems(db, ['BV1'], b);           // BV1 现在同时在 7 和 8
    moveItems(db, ['BV1'], b);          // 移动 → 只剩 8

    expect(workItemIds(db, a)).not.toContain('BV1');
    expect(workItemIds(db, b)).toContain('BV1');
  });

  it('也放进 = 原处保留', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    const b = originIdOf(db, 8);
    addItems(db, ['BV1'], b);

    expect(workItemIds(db, a)).toContain('BV1');
    expect(workItemIds(db, b)).toContain('BV1');
  });

  it('移出 = 只从那个夹子拿走,不放别处', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    removeItems(db, ['BV1'], a);
    expect(workItemIds(db, a)).toEqual(['BV2']);
  });

  // 一次**操作**一条日志,不是一条数据一条 —— 拖 412 条视频只该留 1 行痕
  it('同一种动作做两次 → 记两条日志,不是一条', () => {
    const db = seeded();
    const b = originIdOf(db, 8);
    moveItems(db, ['BV1', 'BV2'], b);
    moveItems(db, ['BV3'], b);

    const log = listOperations(db);
    // 两次调用 → 恰好两条:既不合并成一条,也不是每条目一条(那样会是 3 条)
    expect(log).toHaveLength(2);
    expect(log[0]!.kind).toBe('move_items');
    expect(log[1]!.kind).toBe('move_items');

    // detail 要带够定位信息 —— 否则日志只有一句人话,程序拿它复原不了任何东西。
    // log 是 id 倒序,[1] 才是第一次调用(条目多那条)
    expect(log[1]!.detail).toMatchObject({ toFolderId: expect.any(Number) });
    expect((log[1]!.detail as { itemIds: string[] }).itemIds).toEqual(['BV1', 'BV2']);
  });

  // 同一动作做两次只记两条,而"记几条"与"记什么类型"是两件事 —— 下面三条各钉一个 kind
  it('删除空夹留痕', () => {
    const db = seeded();
    const empty = createFolder(db, '空夹');
    deleteFolder(db, empty);
    expect(listOperations(db)[0]!.kind).toBe('delete_folder');
  });

  it('也放进留痕', () => {
    const db = seeded();
    addItems(db, ['BV1'], originIdOf(db, 8));
    expect(listOperations(db)[0]!.kind).toBe('add_items');
  });

  it('移出留痕', () => {
    const db = seeded();
    removeItems(db, ['BV1'], originIdOf(db, 7));
    expect(listOperations(db)[0]!.kind).toBe('remove_items');
  });

  // 空数组的早返回必须在 ensureWorkcopy 之前:否则"移动 0 条"会克隆出工作副本
  // (一次真实的状态变更)却不记日志 —— 契约 2 的边角口子
  it('空数组的移动/也放进/移出不碰数据库', () => {
    const db = seeded();
    expect(hasWorkcopy(db)).toBe(false);

    // 故意传一个不存在的夹子 id:早返回要是排在任何查询之后,这里就会抛
    moveItems(db, [], 1);
    addItems(db, [], 1);
    removeItems(db, [], 1);

    expect(hasWorkcopy(db)).toBe(false);
    expect(listOperations(db)).toHaveLength(0);
  });

  it('把条目移进锁定的夹子允许 —— 锁只限制改名/删除', () => {
    const db = seeded();
    const locked = originIdOf(db, 9);
    const a = originIdOf(db, 7);
    expect(() => moveItems(db, ['BV1'], locked)).not.toThrow();
    expect(workItemIds(db, locked)).toContain('BV1');
    expect(workItemIds(db, a)).not.toContain('BV1');
  });

  it('还原:副本清空、快照不动、记一条 reset', () => {
    const db = seeded();
    renameFolder(db, originIdOf(db, 7), 'AI/编程');
    resetWorkbench(db);

    expect(hasWorkcopy(db)).toBe(false);
    expect(listWorkFolders(db)).toEqual([]);
    expect(db.prepare(`SELECT title FROM folders WHERE id = 7`).get()).toEqual({ title: '深度学习' });
    expect(listOperations(db)[0]!.kind).toBe('reset');
  });

  it('AI 做的动作 actor=ai,其余 user —— 除此之外没有区别', () => {
    const db = seeded();
    const b = originIdOf(db, 8);
    moveItems(db, ['BV1'], b, { actor: 'ai', sessionId: 5 });
    renameFolder(db, originIdOf(db, 7), 'x');

    const [recent, older] = listOperations(db);
    expect(older!.actor).toBe('ai');
    expect(older!.sessionId).toBe(5);
    expect(recent!.actor).toBe('user');
    expect(recent!.sessionId).toBeNull();
  });
});

// ── 一条条目归进多个夹子(R4 的最后一公里)──────────────
describe('assignItems', () => {
  it('加进多个夹子 —— 全都在,一个不少', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    const b = originIdOf(db, 8);

    const r = assignItems(db, ['BV2'], [a, b]);

    expect(r.moved).toBe(1);
    expect(workItemIds(db, a)).toContain('BV2');
    expect(workItemIds(db, b)).toContain('BV2');
  });

  it('先从原处拿走 —— 不是"再加一份"', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    const b = originIdOf(db, 8);
    // BV2 本来只在 7 里(seed 里 linkFolderItem(7,'BV2'))

    assignItems(db, ['BV2'], [b]);

    expect(workItemIds(db, a)).not.toContain('BV2'); // 从 7 拿走了
    expect(workItemIds(db, b)).toContain('BV2');     // 进了 8
  });

  it('**一次操作一条日志**,不是每个夹子一条', () => {
    const db = seeded();
    assignItems(db, ['BV2'], [originIdOf(db, 7), originIdOf(db, 8)]);
    expect(listOperations(db)).toHaveLength(1);
  });

  it('空目标 = 把这批条目从所有夹子里拿走(等于移出)', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    assignItems(db, ['BV2'], []);
    expect(workItemIds(db, a)).not.toContain('BV2');
  });

  it('空条目数组什么都不做(不克隆、不记日志)', () => {
    const db = seeded();
    assignItems(db, [], [originIdOf(db, 7)]);
    expect(listOperations(db)).toHaveLength(0);
  });

  it('目标夹子不存在 → 抛错,且什么都不改', () => {
    const db = seeded();
    const a = originIdOf(db, 7);
    expect(() => assignItems(db, ['BV2'], [a, 999])).toThrow(/没有夹子/);
    expect(workItemIds(db, a)).toContain('BV2'); // 没动
  });
});

// ── 成员资格写入器(spec 2026-09-21 §3)──────────────────
import { writeMembership, reconcileAiFolder, applyRuleHitsToFolder } from './workbench.js';
import { listAiFolderIds, markFolderAsAi } from '../db/repo/aiFolders.js';
import { saveRule } from '../db/repo/rules.js';

/** 建一个 AI 夹子(标记 + 规则同事务 —— 不变量"AI 夹子恒有规则"的测试侧shortcut) */
function makeAiFolder(db: ReturnType<typeof seeded>, name: string, keywords: string[]): number {
  const r = db
    .prepare(`INSERT INTO work_folders (origin_id, name, created_at) VALUES (NULL, ?, ?)`)
    .run(name, Date.now());
  const id = Number(r.lastInsertRowid);
  markFolderAsAi(db, id);
  if (keywords.length) saveRule(db, id, [{ field: 'title', any: keywords }], 'ai');
  return id;
}

describe('writeMembership', () => {
  it('人类夹子只加不清 —— 目标集不含它时存量原样保留', () => {
    const db = seeded();
    const human = originIdOf(db, 7); // BV1、BV2
    writeMembership(db, ['BV3'], [originIdOf(db, 8)]); // 目标根本不是 7
    expect(workItemIds(db, human).sort()).toEqual(['BV1', 'BV2']);
    // BV2 不在目标集里 —— 也不许清
    writeMembership(db, ['BV2'], [originIdOf(db, 8)]);
    expect(workItemIds(db, human)).toContain('BV2');
    expect(workItemIds(db, originIdOf(db, 8))).toContain('BV2');
  });

  it('AI 夹子不是写入目标 —— 直接拒(洞 4:AI 夹子唯一入口是规则)', () => {
    const db = seeded();
    const ai = makeAiFolder(db, 'AI 编程', ['BV1']);
    expect(() => writeMembership(db, ['BV2'], [ai])).toThrow(/AI 建的夹子/);
  });

  it('默认夹:条目落进主题夹子时移出;只在默认夹之间倒手时留着', () => {
    const db = seeded();
    const def = originIdOf(db, 9);
    const human = originIdOf(db, 7);
    writeMembership(db, ['BV4'], [human]);
    expect(workItemIds(db, def)).not.toContain('BV4');
    writeMembership(db, ['BV4'], [def]);
    expect(workItemIds(db, def)).toContain('BV4');
  });

  it('留痕:一次调用一条日志', () => {
    const db = seeded();
    writeMembership(db, ['BV1'], [originIdOf(db, 8)]);
    expect(listOperations(db)).toHaveLength(1);
    expect(listOperations(db)[0]!.kind).toBe('move_items');
  });
});

describe('reconcileAiFolder', () => {
  it('多则清(走安全网)、缺则补 —— 成员恒等于规则命中集', () => {
    const db = seeded();
    const def = originIdOf(db, 9);
    const ai = makeAiFolder(db, '全部', ['BV1', 'BV2', 'BV3']);
    // 预置:BV4 是多余成员(不在规则命中集),且不在默认夹 —— 清出前必须兜底
    db.prepare(`INSERT INTO work_folder_items (folder_id, item_id) VALUES (?, ?)`).run(ai, 'BV4');

    const r = reconcileAiFolder(db, ai);
    expect(r).toEqual({ added: 3, removed: 1 });

    expect(workItemIds(db, ai).sort()).toEqual(['BV1', 'BV2', 'BV3']);
    expect(workItemIds(db, def)).toContain('BV4'); // 安全网兜底,没丢视频
  });

  it('规则改严 → 不命中的清出;清出时不复核"有没有别的家"(字面版)', () => {
    const db = seeded();
    const def = originIdOf(db, 9);
    const ai = makeAiFolder(db, '一切', ['BV1', 'BV2', 'BV3']);
    reconcileAiFolder(db, ai); // 先收满
    // BV3 同时在人类夹子 8 里活着 —— 字面版照样补进默认夹
    saveRule(db, ai, [{ field: 'title', any: ['BV1'] }], 'ai');
    reconcileAiFolder(db, ai);
    expect(workItemIds(db, ai)).toEqual(['BV1']);
    expect(workItemIds(db, def)).toContain('BV3');
  });

  it('人类夹子不走对账 —— 拒', () => {
    const db = seeded();
    expect(() => reconcileAiFolder(db, originIdOf(db, 7))).toThrow(/不是 AI 建的夹子/);
  });
});

describe('applyRuleHitsToFolder', () => {
  it('人类夹子整理 = 只按规则补缺,存量不清', () => {
    const db = seeded();
    const human = originIdOf(db, 7); // 存量 BV1、BV2
    saveRule(db, human, [{ field: 'title', any: ['BV3'] }], 'user');
    const r = applyRuleHitsToFolder(db, human);
    expect(r.added).toBe(1);
    expect(workItemIds(db, human).sort()).toEqual(['BV1', 'BV2', 'BV3']);
    expect(workItemIds(db, originIdOf(db, 8))).toContain('BV3'); // 原处保留(只加)
  });

  it('没规则的夹子是 no-op', () => {
    const db = seeded();
    expect(applyRuleHitsToFolder(db, originIdOf(db, 7))).toEqual({ added: 0 });
  });
});

import { getRule } from '../db/repo/rules.js';

describe('删除与合并对三分类的语义', () => {
  it('非空夹子可以删了:成员先兜底进默认夹,容器+规则一起走(取代 m4b 空夹红线)', () => {
    const db = seeded();
    const human = originIdOf(db, 7);
    const def = originIdOf(db, 9);
    saveRule(db, human, [{ field: 'title', any: ['BV1'] }], 'user');

    deleteFolder(db, human); // 不再抛"还有 N 条"

    expect(listWorkFolders(db).some((f) => f.id === human)).toBe(false);
    expect(workItemIds(db, def).sort()).toEqual(['BV1', 'BV2', 'BV4']); // BV1/BV2 兜底
    expect(getRule(db, human)).toBeNull(); // 规则跟着 CASCADE
  });

  it('锁定夹子仍然不能删', () => {
    const db = seeded();
    expect(() => deleteFolder(db, originIdOf(db, 9))).toThrow(/不能删除/);
  });

  it('AI actor 删人类夹子 → 拒;user actor 删 AI 夹子 → 允许', () => {
    const db = seeded();
    const human = originIdOf(db, 7);
    const ai = makeAiFolder(db, 'AI 临时', ['BV3']);
    expect(() => deleteFolder(db, human, { actor: 'ai' })).toThrow(/AI 不能/);
    expect(() => deleteFolder(db, ai, { actor: 'user' })).not.toThrow();
  });

  it('AI actor 的合并源里有人类夹子 → 整批拒', () => {
    const db = seeded();
    const human = originIdOf(db, 7);
    const ai = makeAiFolder(db, 'AI 目标', ['BV1']);
    expect(() => mergeFolders(db, [human], ai, { actor: 'ai' })).toThrow(/AI 不能/);
  });

  it('合并 AI 源 → 目标规则收到并集(洞 5:合并不驱逐)', () => {
    const db = seeded();
    const aiA = makeAiFolder(db, 'AI 甲', ['BV1']);
    const aiB = makeAiFolder(db, 'AI 乙', ['BV3']);

    mergeFolders(db, [aiA], aiB, { actor: 'ai' });

    expect(listWorkFolders(db).some((f) => f.id === aiA)).toBe(false);
    const merged = getRule(db, aiB)!.conditions;
    // 两个源的条件都活着(顺序不限,断言按字段聚合)
    const titleAny = merged.filter((c) => c.field === 'title').flatMap((c) => c.any).sort();
    expect(titleAny).toEqual(['BV1', 'BV3']);
  });

  it('moveItems 清原归属时跳过 AI 夹子(条目在 AI 夹 + 人类夹,移走后 AI 夹的归属还在)', () => {
    const db = seeded();
    const ai = makeAiFolder(db, 'AI 收纳', ['BV1']);
    reconcileAiFolder(db, ai); // 规则命中 BV1 → 收进 AI 夹
    const human = originIdOf(db, 7); // BV1、BV2
    moveItems(db, ['BV1'], originIdOf(db, 8));
    expect(workItemIds(db, ai)).toContain('BV1'); // AI 夹的归属没被顺手清掉
    expect(workItemIds(db, human)).not.toContain('BV1'); // 人类夹的清了(用户的明确意图)
  });

  it('从 AI 夹子手动移出 → 拒(spec 洞 7:移了下次对账也会回来,不如不让移)', () => {
    const db = seeded();
    const ai = makeAiFolder(db, 'AI 收纳', ['BV3']);
    reconcileAiFolder(db, ai);
    expect(() => removeItems(db, ['BV3'], ai)).toThrow(/AI 建的夹子/);
  });
});
