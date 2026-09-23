import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { saveRule } from '../db/repo/rules.js';
import { setState, stateKey } from '../db/repo/state.js';
import type { BiliClient } from '../bilibili/client.js';

const stubClient = {
  withCredentials: () => ({ get: async () => null }),
} as unknown as BiliClient;

function makeApp(opts: { seed?: boolean } = {}) {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  if (opts.seed !== false) {
    upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 1 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
    linkFolderItem(db, 7, 'BV1', 1);
  }
  const app = createServer({ db, log, client: stubClient });
  return { app, db };
}

const seed = (db: ReturnType<typeof openDb>) => {
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
  upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
};

describe('工作台路由', () => {
  it('GET 返回视图,没建副本时 exists=false', async () => {
    const { app, db } = makeApp();
    seed(db);
    const res = await app.inject({ method: 'GET', url: '/api/workbench' });
    expect(res.statusCode).toBe(200);
    expect(res.json().exists).toBe(false);
    // 没建副本时视图**故意**是空的,不把快照夹子都报成"已删除"(首启 / 一键还原后
    // 界面该显示"B站 现在的样子")。路由只是把视图原样递出去,所以 removed 也是空。
    expect(res.json().removed).toEqual([]);
    await app.close();
  });

  // §9B.7 约束 5:`based_on` 之后又同步过 → 顶部必须提示
  it('整理期间又同步过 → stale 为 true', async () => {
    const { app, db } = makeApp({ seed: false });
    // 先同步过一次,再建工作副本(基于那次)
    setState(db, stateKey.lastFull, '1000');
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    expect((await app.inject({ method: 'GET', url: '/api/workbench' })).json().stale).toBe(false);

    // 又同步了一次 —— 工作副本基于的快照已经不是最新的了
    setState(db, stateKey.lastFull, '2000');
    expect((await app.inject({ method: 'GET', url: '/api/workbench' })).json().stale).toBe(true);
    await app.close();
  });

  // 没副本时 basedOn 无从谈起 —— 不能因为 "0 !== currentFull" 报假 stale
  it('从没同步过、也没有工作副本时 stale 为 false(不误报)', async () => {
    const { app } = makeApp({ seed: false });
    const res = await app.inject({ method: 'GET', url: '/api/workbench' });
    expect(res.json().stale).toBe(false);
    await app.close();
  });

  it('第一次编辑自动建副本,GET 就能看到', async () => {
    const { app, db } = makeApp();
    seed(db);
    const list = await app.inject({ method: 'GET', url: '/api/workbench' });
    const workId = (await app.inject({
      method: 'POST', url: '/api/workbench/folders', payload: { name: '前端' },
    })).json().id;
    expect(workId).toBeGreaterThan(0);

    const after = await app.inject({ method: 'GET', url: '/api/workbench' });
    expect(after.json().exists).toBe(true);
    expect(after.json().folders).toHaveLength(2); // 深度学习 + 前端
    expect(list.json().exists).toBe(false);
    await app.close();
  });

  it('改名 / 合并 / 移动 各打一次,每次都留一条日志', async () => {
    const { app, db } = makeApp();
    seed(db);
    const created = (await app.inject({
      method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI/编程' },
    })).json().id;

    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const deep = view.folders.find((f: { originId: number }) => f.originId === 7).id;

    await app.inject({ method: 'PATCH', url: `/api/workbench/folders/${deep}`, payload: { name: 'AI/编程' } });
    await app.inject({ method: 'POST', url: `/api/workbench/items/move`, payload: { itemIds: ['BV1'], toFolderId: created } });
    await app.inject({ method: 'POST', url: `/api/workbench/folders/${created}/merge`, payload: { fromIds: [deep] } });

    const log = (await app.inject({ method: 'GET', url: '/api/workbench/log' })).json().operations;
    // 倒序(最新在前)。建夹子那一步也是一次编辑,同样留痕 —— 所以最末还有一条
    // create_folder;每个动作恰好一条,一条不多一条不少。
    expect(log.map((e: { kind: string }) => e.kind)).toEqual([
      'merge_folders', 'move_items', 'rename_folder', 'create_folder',
    ]);
    await app.close();
  });

  it('删非空夹 → 允许(安全网兜底;没有默认夹时如实不兜底)', async () => {
    const { app, db } = makeApp();
    seed(db);
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const deep = view.folders.find((f: { originId: number }) => f.originId === 7).id;

    // spec 2026-09-21:删夹子 = 删容器,不删视频 —— 空夹红线被安全网取代
    const res = await app.inject({ method: 'DELETE', url: `/api/workbench/folders/${deep}` });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/workbench' })).json().folders.some(
      (f: { id: number }) => f.id === deep,
    )).toBe(false);
    await app.close();
  });

  it('改锁定的夹子 → 400', async () => {
    const { app, db } = makeApp();
    upsertFolder(db, { id: 9, title: '默认收藏夹', mediaCount: 0, raw: JSON.stringify({ attr: 0 }) });
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const locked = view.folders.find((f: { originId: number }) => f.originId === 9).id;

    const res = await app.inject({ method: 'PATCH', url: `/api/workbench/folders/${locked}`, payload: { name: '新名字' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('不能改名');
    await app.close();
  });

  // 错误码只看消息**前缀**:锁定夹子那条文案会把夹子名拼进去,名字里带「不存在」
  // 不能把 400 掰成 404(手动锁可以锁任意夹子,名字是用户可控的)
  it('夹子名里带「不存在」的锁定夹子 → 仍是 400,不是 404', async () => {
    const { app, db } = makeApp();
    upsertFolder(db, { id: 9, title: '这夹子不存在吗', mediaCount: 0, raw: JSON.stringify({ attr: 0 }) });
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const locked = view.folders.find((f: { originId: number }) => f.originId === 9).id;

    const res = await app.inject({ method: 'PATCH', url: `/api/workbench/folders/${locked}`, payload: { name: '新名字' } });
    expect(res.json().reason).toContain('不存在'); // 文案里确实带这个名字
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('还原后 exists=false,快照还在', async () => {
    const { app, db } = makeApp();
    seed(db);
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    const res = await app.inject({ method: 'POST', url: '/api/workbench/reset' });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/workbench' })).json().exists).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM folders`).get()).toEqual({ n: 1 });
    await app.close();
  });

  // 展开夹子走**工作副本**口径:行头显示的 itemCount 就是这个口径,两者必须对得上。
  // 新建的夹子没有快照原点,但完全可能有条目 —— 按"没有 originId 就当它空"处理的话,
  // 行头说 2 条、展开说"这个夹子是空的",而里面的条目从此看不见也勾不到。
  it('新建的夹子还没有条目时,展开返回空(不是 404)', async () => {
    const { app, db } = makeApp();
    seed(db);
    const created = (await app.inject({
      method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI/编程' },
    })).json().id;

    const res = await app.inject({ method: 'GET', url: `/api/workbench/folders/${created}/items` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
    await app.close();
  });

  it('条目放进新建的夹子后,展开取得到(带标题等展示字段)', async () => {
    const { app, db } = makeApp();
    seed(db);
    const created = (await app.inject({
      method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI/编程' },
    })).json().id;

    await app.inject({
      method: 'POST', url: '/api/workbench/items/add',
      payload: { itemIds: ['BV1', 'BV2'], toFolderId: created },
    });

    const res = await app.inject({ method: 'GET', url: `/api/workbench/folders/${created}/items` });
    expect(res.json().total).toBe(2);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual(['BV1', 'BV2']);
    expect(res.json().items[0].title).toBe('a');
    await app.close();
  });

  it('工作副本里没有这个夹子 → 404', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/workbench/folders/999/items' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('itemIds 不是数组 → 400', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/workbench/items/move',
      payload: { itemIds: 'BV1', toFolderId: 1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  /**
   * **浏览器发的形状**必须有测试守着 —— 之前的用例写的是
   * `app.inject({ method: 'DELETE', url })`,**不带 content-type**;
   * 而 `json()` 会带。于是 512 条测试全绿、浏览器上四个无 body 的调用
   * (删夹子 / 一键还原 / 归档 / 撤回)全是 400 FST_ERR_CTP_EMPTY_JSON_BODY,
   * 而且那个 400 在进 handler 之前抛出,连日志都记不上。
   */
  it('带 content-type: application/json 但没有 body —— 不能 400(浏览器就是这个形状)', async () => {
    const { app, db } = makeApp();
    seed(db);
    const id = (await app.inject({
      method: 'POST', url: '/api/workbench/folders', payload: { name: '空夹' },
    })).json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/workbench/folders/${id}`,
      headers: { 'content-type': 'application/json' }, // ← json() 原本会带这个头
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('一键还原:带 content-type 但没 body 也要成功', async () => {
    const { app, db } = makeApp();
    seed(db);
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/reset',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/workbench' })).json().exists).toBe(false);
    await app.close();
  });

  it('body 坏了仍然要 400(宽容不能宽容到接住坏 JSON)', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/folders',
      headers: { 'content-type': 'application/json' },
      payload: '{坏 json',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  /**
   * 整夹子粒度:前端勾的是**夹子**,不是条目 —— 服务端一次展开成 itemIds,
   * 所以是一次请求、一条日志,而不是让前端逐个夹子拉条目再拼。
   */
  it('fromFolderIds:把整个夹子的条目移动过去,一次调用一条日志', async () => {
    const { app, db } = makeApp();
    seed(db);
    const view0 = (await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '目标' } })).json().id;
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const src = view.folders.find((f: { originId: number }) => f.originId === 7).id;

    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/items/move',
      payload: { fromFolderIds: [src], toFolderId: view0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toBe(2); // 夹子 7 里那两条

    const items = (await app.inject({ url: `/api/workbench/folders/${view0}/items` })).json();
    expect(items.items.map((i: { id: string }) => i.id).sort()).toEqual(['BV1', 'BV2']);

    // 一次操作 = 一条日志(不是 2 条)
    const log = (await app.inject({ url: '/api/workbench/log' })).json().operations;
    expect(log.filter((e: { kind: string }) => e.kind === 'move_items')).toHaveLength(1);
    await app.close();
  });

  it('fromFolderIds:也放进保留原处', async () => {
    const { app, db } = makeApp();
    seed(db);
    const target = (await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '目标' } })).json().id;
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const src = view.folders.find((f: { originId: number }) => f.originId === 7).id;

    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/items/add',
      payload: { fromFolderIds: [src], toFolderId: target },
    });
    expect(res.statusCode).toBe(200);

    // 目标拿到了两条,而源夹子里**原样还在**(也放进的语义)
    const got = (await app.inject({ url: `/api/workbench/folders/${target}/items` })).json();
    const kept = (await app.inject({ url: `/api/workbench/folders/${src}/items` })).json();
    expect(got.items.map((i: { id: string }) => i.id).sort()).toEqual(['BV1', 'BV2']);
    expect(kept.items.map((i: { id: string }) => i.id).sort()).toEqual(['BV1', 'BV2']);
    await app.close();
  });

  it('目标夹子也在 fromFolderIds 里 → 400', async () => {
    const { app, db } = makeApp();
    seed(db);
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const a = view.folders[0].id;

    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/items/move',
      payload: { fromFolderIds: [a], toFolderId: a },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('fromFolderIds 里有不存在的夹子 → 404 而不是 500', async () => {
    const { app, db } = makeApp();
    seed(db);
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();

    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/items/move',
      payload: { fromFolderIds: [999], toFolderId: view.folders[0].id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('不存在的夹子 → 404', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'PATCH', url: '/api/workbench/folders/999', payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('tidy:AI 夹子精确对账、人类夹子只加不清、无规则跳过', async () => {
    const { app, db } = makeApp();
    seed(db); // 快照夹 7(深度学习,BV1 标题 'a'、BV2 标题 'b')
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '临时' } });
    const view = (await app.inject({ url: '/api/workbench' })).json();
    const human = view.folders.find((f: { originId: number | null }) => f.originId === 7).id as number;
    const ai = await app.inject({
      method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI 编程' },
    }).then((r) => r.json().id as number);
    // 直接落 AI 标记 + 规则(路由层还没有"标记"入口,测试侧直写,与 repo 测试同口径)
    db.prepare(`INSERT INTO work_ai_folders (folder_id, created_at) VALUES (?, ?)`).run(ai, Date.now());
    saveRule(db, ai, [{ field: 'title', any: ['a'] }], 'ai'); // 命中 BV1

    const res = await app.inject({
      method: 'POST', url: '/api/workbench/tidy',
      payload: { folderIds: [ai, human] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // AI 夹:BV1 命中 → 补进
    expect(body.reconciled).toEqual([{ folderId: ai, added: 1, removed: 0 }]);
    // 人类夹:没规则 → 跳过
    expect(body.skipped).toHaveLength(1);

    const items = await app.inject({ url: `/api/workbench/folders/${ai}/items` });
    expect(items.json().items.map((i: { id: string }) => i.id)).toEqual(['BV1']);
    await app.close();
  });

  it('tidy:空 folderIds → 400', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/workbench/tidy', payload: { folderIds: [] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// 约束 4 的意义是"不让工作副本里出现写回必然失败的改动"。编辑那一侧由
// assertNotLocked 挡着,但**上锁走的不是编辑路径**(只写 settings)—— 先改名、
// 再上锁就能拿到「锁定 + 名字与快照不同」这个明令不许的状态。
// 而上锁恰恰是用户纠正自动判定的动作,最容易撞上这个顺序。
describe('上锁与工作副本的一致性', () => {
  /** 建副本、改名,回工作夹子 id */
  const renameInWorkcopy = async (app: FastifyInstance, name: string): Promise<number> => {
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '触发克隆' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const deep = view.folders.find((f: { originId: number }) => f.originId === 7).id as number;
    await app.inject({ method: 'PATCH', url: `/api/workbench/folders/${deep}`, payload: { name } });
    return deep;
  };

  const lockSetting = (db: ReturnType<typeof openDb>): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'folder.lock.7'`).get() as { n: number }).n;

  it('工作副本里改过名 → 上锁被拒,并说清改回哪个名字', async () => {
    const { app, db } = makeApp();
    seed(db);
    await renameInWorkcopy(app, 'AI/编程');

    const res = await app.inject({ method: 'PUT', url: '/api/folders/7/lock', payload: { locked: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('AI/编程'); // 现在叫什么
    expect(res.json().reason).toContain('深度学习'); // 要改回什么
    // 拒了就是拒了 —— 不能一半写了一半没写
    expect(lockSetting(db)).toBe(0);
    await app.close();
  });

  it('工作副本里没改过名 → 上锁照常', async () => {
    const { app, db } = makeApp();
    seed(db);
    await renameInWorkcopy(app, 'AI/编程');
    // 改回原名,于是没有"名字不一致"
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const deep = view.folders.find((f: { originId: number }) => f.originId === 7).id;
    await app.inject({ method: 'PATCH', url: `/api/workbench/folders/${deep}`, payload: { name: '深度学习' } });

    const res = await app.inject({ method: 'PUT', url: '/api/folders/7/lock', payload: { locked: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().locked).toBe(true);
    expect(lockSetting(db)).toBe(1);
    await app.close();
  });

  it('解锁不受影响(把锁摘掉永远是安全的)', async () => {
    const { app, db } = makeApp();
    seed(db);
    await renameInWorkcopy(app, 'AI/编程');
    const res = await app.inject({ method: 'PUT', url: '/api/folders/7/lock', payload: { locked: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().locked).toBe(false);
    await app.close();
  });
});
