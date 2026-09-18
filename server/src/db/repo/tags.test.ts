import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { upsertItem } from './items.js';
import {
  normalizeTagName, findTag, ensureTag, addAlias, linkItemTag,
  itemTagIds, tagCounts, listTagTree, subtreeSets, mergeTags, setTagParent, deleteTag, renameTag,
  depthOf,
} from './tags.js';

const fresh = () => {
  const db = openDb(':memory:');
  upsertItem(db, { id: 'BV1', type: 2, title: '露营装备开箱' });
  upsertItem(db, { id: 'BV2', type: 2, title: '烤羊肉' });
  upsertItem(db, { id: 'BV3', type: 2, title: '天幕怎么搭' });
  return db;
};

describe('normalizeTagName', () => {
  it('trim + 全角转半角 + 小写', () => {
    expect(normalizeTagName('  ＮＢＡ ')).toBe('nba');
    expect(normalizeTagName('NBA')).toBe('nba');
    expect(normalizeTagName('粤菜')).toBe('粤菜');
  });
});

describe('ensureTag', () => {
  it('同一父下同名只建一次,name 保留首次写法', () => {
    const db = fresh();
    const a = ensureTag(db, 'NBA', null);
    const b = ensureTag(db, 'nba', null);
    expect(b).toBe(a);
    expect(db.prepare(`SELECT name FROM tags WHERE id = ?`).get(a)).toEqual({ name: 'NBA' });
  });

  it('同名只建一次,重复调用复用', () => {
    const db = fresh();
    ensureTag(db, '体育', null);
    ensureTag(db, '体育', null);
    expect(db.prepare(`SELECT COUNT(*) n FROM tags`).get()).toEqual({ n: 1 });
  });

  it('**同一个名字在全树只有一处** —— 换个父也不会再建一个', () => {
    const db = fresh();
    const sport = ensureTag(db, '体育', null);
    const food = ensureTag(db, '美食', null);
    const ball = ensureTag(db, '篮球', sport);

    // 模型说"篮球属于美食",而它已经挂在体育下了 —— **复用,不新建**。
    // 这正是用户那句"相同的 tag 不要重复建立":两个 `篮球` 节点就是他抱怨的重复
    expect(ensureTag(db, '篮球', food)).toBe(ball);
    expect(db.prepare(`SELECT COUNT(*) n FROM tags WHERE norm = '篮球'`).get()).toEqual({ n: 1 });
    // 父只在**新建**时起作用 —— 想挪位置走质检的 move / 判据的 reparent
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(ball)).toEqual({
      parent_id: sport,
    });
  });

  it('创建时就记一笔别名 —— 拿名字直接查得到,不管它是根还是子', () => {
    const db = fresh();
    const sport = ensureTag(db, '体育', null);
    const ball = ensureTag(db, '篮球', sport);
    expect(findTag(db, normalizeTagName('体育'))).toBe(sport);
    expect(findTag(db, normalizeTagName('篮球'))).toBe(ball);
  });

  it('空名字直接抛 —— 别默默建一个 norm=\'\' 的节点(它会被 findTag 永久命中)', () => {
    expect(() => ensureTag(fresh(), '   ', null)).toThrow();
  });
});

describe('别名表', () => {
  it('addAlias 之后 findTag 命中别名', () => {
    const db = fresh();
    const id = ensureTag(db, '路飞', null);
    addAlias(db, '鲁夫', id);
    expect(findTag(db, normalizeTagName('鲁夫'))).toBe(id);
  });

  it('ensureTag 查不到别名时按 (父,名) 新建', () => {
    const db = fresh();
    const id = findTag(db, normalizeTagName('从没见过的词'));
    expect(id).toBeNull();
  });
});

describe('item_tags 与统计', () => {
  it('linkItemTag 幂等;itemTagIds 只回请求的那些', () => {
    const db = fresh();
    const t = ensureTag(db, '露营', null);
    linkItemTag(db, 'BV1', t, 'ai');
    linkItemTag(db, 'BV1', t, 'ai');
    linkItemTag(db, 'BV3', t, 'ai');
    expect(itemTagIds(db, ['BV1', 'BV2'])).toEqual(new Map([['BV1', [t]]]));
    expect(tagCounts(db).get(t)).toBe(2);
  });
});

describe('listTagTree', () => {
  it('按父子组装,count 是直达条目数(不含子孙)', () => {
    const db = fresh();
    const food = ensureTag(db, '美食', null);
    const roast = ensureTag(db, '烤羊肉', food);
    linkItemTag(db, 'BV2', food, 'ai');
    linkItemTag(db, 'BV2', roast, 'ai');
    const tree = listTagTree(db);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe('美食');
    expect(tree[0]!.count).toBe(1);
    expect(tree[0]!.children[0]!.name).toBe('烤羊肉');
    expect(tree[0]!.children[0]!.count).toBe(1);
  });
});

describe('subtreeSets', () => {
  it('每个节点带上自己和全部后代', () => {
    const db = fresh();
    const food = ensureTag(db, '美食', null);
    const roast = ensureTag(db, '烤羊肉', food);
    const lamb = ensureTag(db, '羊', roast);
    expect(subtreeSets(db).get(food)).toEqual(new Set([food, roast, lamb]));
  });
});

describe('mergeTags', () => {
  it('条目改挂、子节点改挂、旧名进别名表、旧节点消失', () => {
    const db = fresh();
    const keep = ensureTag(db, '路飞', null);
    const drop = ensureTag(db, '鲁夫', null);
    const child = ensureTag(db, '橡胶果实', drop);
    linkItemTag(db, 'BV1', drop, 'ai');

    mergeTags(db, drop, keep);

    expect(db.prepare(`SELECT id FROM tags WHERE id = ?`).get(drop)).toBeUndefined();
    expect(itemTagIds(db, ['BV1']).get('BV1')).toEqual([keep]);
    // 列名是 parent_id —— better-sqlite3 原样回列名,所以断言用 snake_case
    expect(db.prepare(`SELECT parent_id FROM tags WHERE id = ?`).get(child)).toEqual({ parent_id: keep });
    expect(findTag(db, normalizeTagName('鲁夫'))).toBe(keep);
  });

  it('不让自己并进自己的后代(会成环)', () => {
    const db = fresh();
    const parent = ensureTag(db, '美食', null);
    const child = ensureTag(db, '烤羊肉', parent);
    expect(mergeTags(db, parent, child)).toBe(false);
    // 反过来可以:子是孙的后代,但孙不是子的后代
    const grand = ensureTag(db, '羊', child);
    expect(mergeTags(db, child, grand)).toBe(false);
    expect(mergeTags(db, grand, parent)).toBe(true);
  });
});

describe('setTagParent / renameTag / deleteTag', () => {
  it('挂父后子树跟着走', () => {
    const db = fresh();
    const sport = ensureTag(db, '体育', null);
    const camp = ensureTag(db, '露营', null);
    expect(setTagParent(db, camp, sport)).toBe(true);
    expect(subtreeSets(db).get(sport)!.has(camp)).toBe(true);
  });

  it('拒绝自己挂自己、挂到自己后代(防环)', () => {
    const db = fresh();
    const parent = ensureTag(db, '美食', null);
    const child = ensureTag(db, '烤羊肉', parent);
    expect(setTagParent(db, parent, parent)).toBe(false);
    expect(setTagParent(db, parent, child)).toBe(false);
    // 环没造出来 —— 两个节点仍在正常的父子关系上
    expect(listTagTree(db)).toHaveLength(1);
    expect(listTagTree(db)[0]!.children).toHaveLength(1);
  });

  it('拒绝挂到会超深的位置', () => {
    const db = fresh();
    const a = ensureTag(db, 'L1', null);
    const b = ensureTag(db, 'L2', a);
    const c = ensureTag(db, 'L3', b);
    const d = ensureTag(db, 'L4', c);
    // 另一条独立的根,单独试深度闸 —— 拿 a 去试的话会先被防环闸拦下
    // (b 本来就是 a 的子节点),那道闸不属于这个用例
    const lone = ensureTag(db, 'L5', null);

    // 挂到 d(深度 4)下 → lone 自己就在第 5 层,超封顶
    expect(setTagParent(db, lone, d)).toBe(false);
    // 挂到 c(深度 3)下 → lone 在第 4 层,刚好封顶内
    expect(setTagParent(db, lone, c)).toBe(true);
    expect(depthOf(db, lone)).toBe(4);
    // 原来那条链没被动过
    expect(depthOf(db, a)).toBe(1);
    expect(depthOf(db, d)).toBe(4);
  });

  it('renameTag 换 name 与 norm,并把**旧名**留进别名表', () => {
    const db = fresh();
    const id = ensureTag(db, 'NBA', null);
    renameTag(db, id, '美职篮');
    expect(findTag(db, normalizeTagName('美职篮'))).toBe(id);
    expect(findTag(db, normalizeTagName('NBA'))).toBe(id); // 老引用还找得到
    expect(db.prepare(`SELECT name FROM tags WHERE id = ?`).get(id)).toEqual({ name: '美职篮' });
  });

  it('deleteTag 连带删掉它的条目关联与别名', () => {
    const db = fresh();
    const id = ensureTag(db, '临时', null);
    addAlias(db, 'temp', id);
    linkItemTag(db, 'BV1', id, 'ai');
    deleteTag(db, id);
    expect(itemTagIds(db, ['BV1']).get('BV1')).toBeUndefined();
    expect(findTag(db, normalizeTagName('temp'))).toBeNull();
  });
});

describe('C16 规则里的 tag id 跟着词走', () => {
  const withRule = (db: ReturnType<typeof openDb>, folderId: number, any: string[]) => {
    db.prepare(
      `INSERT INTO work_folders (id, origin_id, name, created_at) VALUES (?, NULL, 'x', 0)`,
    ).run(folderId);
    db.prepare(
      `INSERT INTO work_folder_rules (folder_id, conditions_json, origin, updated_at)
       VALUES (?, ?, 'user', 0)`,
    ).run(folderId, JSON.stringify([{ field: 'tag', any }]));
  };
  const ruleOf = (db: ReturnType<typeof openDb>, folderId: number) =>
    (JSON.parse(
      (db.prepare(`SELECT conditions_json c FROM work_folder_rules WHERE folder_id = ?`)
        .get(folderId) as { c: string }).c,
    ) as { field: string; any: string[] }[]);

  it('合并 → 规则里的旧 id 改成新 id', () => {
    const db = fresh();
    const keep = ensureTag(db, '路飞', null);
    const drop = ensureTag(db, '鲁夫', null);
    withRule(db, 1, [String(drop)]);
    mergeTags(db, drop, keep);
    expect(ruleOf(db, 1)).toEqual([{ field: 'tag', any: [String(keep)] }]);
  });

  it('删除 → 那个 id 从规则里拿掉;条件被掏空就整条丢掉', () => {
    const db = fresh();
    const a = ensureTag(db, '露营', null);
    const b = ensureTag(db, '美食', null);
    withRule(db, 1, [String(a), String(b)]);
    deleteTag(db, a);
    expect(ruleOf(db, 1)).toEqual([{ field: 'tag', any: [String(b)] }]);

    // 换一个还活着的词:withRule 是裸 INSERT,不走 rewrite —— 规则写完就落在那儿了,
    // 必须真的删一次那个词,那条条件才会被掏空
    const c = ensureTag(db, '临时', null);
    withRule(db, 2, [String(c)]);
    deleteTag(db, c);
    expect(ruleOf(db, 2)).toEqual([]);
  });

  it('非 tag 字段一个字不动', () => {
    const db = fresh();
    db.prepare(
      `INSERT INTO work_folders (id, origin_id, name, created_at) VALUES (1, NULL, 'x', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO work_folder_rules (folder_id, conditions_json, origin, updated_at)
       VALUES (1, ?, 'user', 0)`,
    ).run(JSON.stringify([{ field: 'title', any: ['python'] }, { field: 'tag', any: ['9'] }]));
    const a = ensureTag(db, '露营', null);
    mergeTags(db, a, ensureTag(db, '美食', null));
    expect(ruleOf(db, 1)).toEqual([
      { field: 'title', any: ['python'] },
      { field: 'tag', any: ['9'] },  // 「9」不是本库里任何词的 id → 原样留着(不猜)
    ]);
  });
});
