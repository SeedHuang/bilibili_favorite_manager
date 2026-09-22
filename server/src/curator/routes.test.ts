import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { seedLlm, saveProvider, listProviders, listEntries, addEntry, setAssignment, readLlmSettings } from '../llm/config.js';
import { saveRule } from '../db/repo/rules.js';
import { setState, stateKey } from '../db/repo/state.js';
import type { BiliClient } from '../bilibili/client.js';

// LLM 全 mock —— 路由测试绝不打真实 API。
// 用 importOriginal 铺开真模块再覆盖,而不是只手写几个导出:后者会在
// provider.ts 新增导出时静默失效(踩过一次 —— 多出一堆看不懂的 "No export" 报错)
const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../llm/provider.js', async (orig) => ({
  ...(await orig<typeof import('../llm/provider.js')>()),
  complete: mocks.complete,
}));

const stubClient = {
  withCredentials: () => ({ get: async () => null }),
} as unknown as BiliClient;

const PROPOSAL = '{"folders":[{"tempId":"f1","name":"AI/编程","rule":"含 Python","reuseFolderId":7}],"notes":"n"}';

function makeApp(opts: { llm?: boolean; seed?: boolean; ollamaFetchImpl?: typeof fetch } = {}) {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  if (opts.llm !== false) {
    seedLlm(db); // 1 凭证 + 1 条目(ollama/qwen2.5:14b)+ 用途全指它
  }
  if (opts.seed !== false) {
    upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 1 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
    linkFolderItem(db, 7, 'BV1', 1);
  }
  const app = createServer({ db, log, client: stubClient, ...(opts.ollamaFetchImpl ? { ollamaFetchImpl: opts.ollamaFetchImpl } : {}) });
  return { app, db };
}

const seed = (db: ReturnType<typeof openDb>) => {
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
  upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.complete.mockResolvedValue(PROPOSAL);
});

describe('模型管理', () => {
  // 名字实时从厂商拉,数字仍查注册表 —— 那个接口只回 id/object/owned_by,没有 token 上限
  it('remote-models:拉厂商的真实名字,数字查注册表', async () => {
    const { app } = makeApp();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v9-experimental' }] }),
          { status: 200 },
        ),
    );
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/remote-models',
        payload: { provider: 'deepseek', apiKey: 'k' },
      });
      expect(res.statusCode).toBe(200);

      const models = res.json().models as { model: string; verified: boolean }[];
      expect(models.map((m) => m.model)).toEqual(['deepseek-flash', 'deepseek-v9-experimental']);
      // 表里有真值 → 已确认(flash 2026-09-16 从官方价格页补进来的)
      expect(models.find((m) => m.model === 'deepseek-flash')!.verified).toBe(true);
      // 表里没有(厂商新出的)→ 兜底 + 未确认,界面会标 ⚠️
      expect(models.find((m) => m.model === 'deepseek-v9-experimental')!.verified).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    await app.close();
  });

  it('remote-models:没选服务商 400;拉不到 502 且是人话', async () => {
    const { app } = makeApp();
    expect(
      (await app.inject({ method: 'POST', url: '/api/settings/remote-models', payload: {} })).statusCode,
    ).toBe(400);

    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/remote-models',
        payload: { provider: 'deepseek', apiKey: 'bad' },
      });
      expect(res.statusCode).toBe(502);
      // 用户照着能改的是"key 填错了",不是 "HTTP 401"
      expect(res.json().reason).toContain('API Key');
    } finally {
      vi.unstubAllGlobals();
    }
    await app.close();
  });

  it('列出模型(可按 provider 过滤)', async () => {
    const { app } = makeApp();
    const all = await app.inject({ method: 'GET', url: '/api/settings/models' });
    expect(all.json().models.length).toBeGreaterThan(10);

    const ds = await app.inject({ method: 'GET', url: '/api/settings/models?provider=deepseek' });
    expect(ds.json().models.every((m: { provider: string }) => m.provider === 'deepseek')).toBe(true);
    await app.close();
  });

  describe('模型配置(三层)', () => {
    it('providers 列表不回传明文 key', async () => {
      const { app, db } = makeApp();
      saveProvider(db, { provider: 'deepseek', apiKey: 'sk-secret-xyz' });
      const body = (await app.inject({ method: 'GET', url: '/api/settings/providers' })).json();
      expect(body.providers).toHaveLength(2); // seedLlm 的 + 这个
      expect(JSON.stringify(body)).not.toContain('sk-secret-xyz');
      const ds = body.providers.find((p: { provider: string }) => p.provider === 'deepseek');
      expect(ds.hasApiKey).toBe(true);
      await app.close();
    });

    it('PUT providers 更新时 apiKey 不带 = 保留已存', async () => {
      const { app, db } = makeApp();
      const p = listProviders(db)[0]!;
      saveProvider(db, { id: p.id, provider: 'ollama', apiKey: 'sk-keep-123456' });
      const res = await app.inject({
        method: 'PUT', url: '/api/settings/providers',
        payload: { id: p.id, provider: 'ollama', baseUrl: 'http://x/v1' }, // 无 apiKey
      });
      expect(res.statusCode).toBe(200);
      const body = (await app.inject({ method: 'GET', url: '/api/settings/providers' })).json();
      expect(body.providers[0]!.hasApiKey).toBe(true);
      await app.close();
    });

    it('DELETE 被条目引用的凭证 → 400', async () => {
      const { app, db } = makeApp();
      const p = listProviders(db)[0]!;
      const res = await app.inject({ method: 'DELETE', url: `/api/settings/providers/${p.id}` });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('entries 带注册表解析的数字;新增自动全分配', async () => {
      const { app, db } = makeApp({ llm: false });
      const p = await app.inject({ method: 'PUT', url: '/api/settings/providers', payload: { provider: 'deepseek' } });
      const pid = p.json().id;
      const e = await app.inject({ method: 'POST', url: '/api/settings/entries', payload: { providerId: pid, model: 'deepseek-flash' } });
      expect(e.statusCode).toBe(200);
      const list = (await app.inject({ method: 'GET', url: '/api/settings/entries' })).json();
      expect(list.entries[0]).toMatchObject({ model: 'deepseek-flash', contextWindow: 1_024_000, maxOutput: 384_000, verified: true });
      const a = (await app.inject({ method: 'GET', url: '/api/settings/assignments' })).json();
      expect(a.assignments).toEqual({
        proposals: list.entries[0].id,
        rules: list.entries[0].id, tag: list.entries[0].id, tagcheck: list.entries[0].id,
      });
      await app.close();
    });

    it('DELETE 被用途引用的条目 → 400', async () => {
      const { app, db } = makeApp();
      const e = listEntries(db)[0]!;
      const res = await app.inject({ method: 'DELETE', url: `/api/settings/entries/${e.id}` });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('PUT assignments 改单个用途;指向不存在的条目 → 400', async () => {
      const { app, db } = makeApp();
      const e2 = await app.inject({
        method: 'POST', url: '/api/settings/entries',
        payload: { providerId: listProviders(db)[0]!.id, model: 'qwen2.5:14b' },
      }); // 第二条不触发自动分配(用途已被 seed 占住)
      const res = await app.inject({ method: 'PUT', url: '/api/settings/assignments', payload: { tag: e2.json().id } });
      expect(res.statusCode).toBe(200);
      const a = (await app.inject({ method: 'GET', url: '/api/settings/assignments' })).json();
      expect(a.assignments.tag).toBe(e2.json().id);
      const bad = await app.inject({ method: 'PUT', url: '/api/settings/assignments', payload: { proposals: 'm_nope' } });
      expect(bad.statusCode).toBe(400);
      await app.close();
    });
  });

  it('测试连接成功', async () => {
    const { app } = makeApp();
    mocks.complete.mockResolvedValue('可以');
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/test-llm',
      payload: { provider: 'ollama', model: 'qwen2.5:14b' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBe('可以');
    await app.close();
  });

  it('测试连接失败回 502 并带上原因', async () => {
    const { app } = makeApp();
    mocks.complete.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/test-llm',
      payload: { provider: 'ollama', model: 'qwen2.5:14b' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().reason).toContain('ECONNREFUSED');
    await app.close();
  });

  /** §6 红队加固:测试连接的日志里绝不能出现明文 apiKey */
  it('测试连接的日志不落明文 apiKey', async () => {
    const { app, db } = makeApp();
    mocks.complete.mockRejectedValue(new Error('401 Unauthorized: key sk-live-DEADBEEF 无效'));

    await app.inject({
      method: 'POST',
      url: '/api/settings/test-llm',
      payload: { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-live-DEADBEEF' },
    });

    const rows = db
      .prepare(`SELECT message, detail FROM events`)
      .all() as { message: string; detail: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain('sk-live-DEADBEEF');
    expect(dumped).toContain('***');
    await app.close();
  });

  it('ollama-models 成功时把真实数字写进 llm.ollama.meta(条目不存数字,读取侧靠它)', async () => {
    // 假 Ollama:/api/tags 回一个模型名,/api/show 回它的真实上下文长度
    const fake = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'qwen-fake:latest' }] }) };
      }
      return {
        ok: true,
        json: async () => ({ model_info: { 'qwen-fake.context_length': 40_960 } }),
      };
    }) as unknown as typeof fetch;
    const { app, db } = makeApp({ ollamaFetchImpl: fake });
    const res = await app.inject({ method: 'GET', url: '/api/settings/ollama-models' });
    expect(res.statusCode).toBe(200);

    // 数字落了库,且 readLlmSettings 读侧真的用它(verified:true,不再退 32K 兜底)
    const raw = db
      .prepare(`SELECT value FROM settings WHERE key = 'llm.ollama.meta'`)
      .get() as { value: string } | undefined;
    expect(JSON.parse(raw!.value)).toMatchObject({
      'qwen-fake:latest': { contextWindow: 40_960 },
    });

    const [p] = listProviders(db);
    const e = addEntry(db, { providerId: p!.id, model: 'qwen-fake:latest' });
    setAssignment(db, 'proposals', e.id);
    const s = readLlmSettings(db, 'proposals')!;
    expect(s.ctx.contextWindow).toBe(40_960);
    expect(s.ctx.verified).toBe(true);
    await app.close();
  });
});

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
