import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { getLatestDraft, getMessages, getSession } from '../db/repo/sessions.js';
import { seedLlm, saveProvider, listProviders, listEntries, addEntry, setAssignment, readLlmSettings } from '../llm/config.js';
import { saveClassification, getClassification } from '../db/repo/classifications.js';
import { setItemTagging } from '../db/repo/tagging.js';
import { saveRule } from '../db/repo/rules.js';
import { setState, stateKey } from '../db/repo/state.js';
import { logOperation } from '../db/repo/operations.js';
import type { BiliClient } from '../bilibili/client.js';

// LLM 全 mock —— 路由测试绝不打真实 API。
// 用 importOriginal 铺开真模块再覆盖,而不是只手写几个导出:后者会在
// provider.ts 新增导出时静默失效(踩过一次 —— 多出一堆看不懂的 "No export" 报错)
const mocks = vi.hoisted(() => ({ complete: vi.fn(), stream: vi.fn() }));
vi.mock('../llm/provider.js', async (orig) => ({
  ...(await orig<typeof import('../llm/provider.js')>()),
  complete: mocks.complete,
  stream: mocks.stream,
}));

const stubClient = {
  withCredentials: () => ({ get: async () => null }),
} as unknown as BiliClient;

const PROPOSAL = '{"folders":[{"tempId":"f1","name":"AI/编程","rule":"含 Python","reuseFolderId":7}],"notes":"n"}';
const ASSIGN = '[{"itemId":"BV1","folderTempId":"f1","confidence":0.9,"reason":"是教程"}]';

function makeApp(opts: { llm?: boolean; seed?: boolean; ollamaFetchImpl?: typeof fetch } = {}) {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  if (opts.llm !== false) {
    seedLlm(db); // 1 凭证 + 1 条目(ollama/qwen2.5:14b)+ 四用途全指它
  }
  if (opts.seed !== false) {
    upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 1 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
    linkFolderItem(db, 7, 'BV1', 1);
  }
  const app = createServer({ db, log, client: stubClient, ...(opts.ollamaFetchImpl ? { ollamaFetchImpl: opts.ollamaFetchImpl } : {}) });
  return { app, db };
}

const newSession = async (app: FastifyInstance): Promise<number> => {
  const res = await app.inject({ method: 'POST', url: '/api/curator/sessions', payload: { title: '测试' } });
  return res.json().id as number;
};

const seed = (db: ReturnType<typeof openDb>) => {
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 2 });
  upsertItem(db, { id: 'BV1', type: 2, title: 'a' });
  upsertItem(db, { id: 'BV2', type: 2, title: 'b' });
  linkFolderItem(db, 7, 'BV1', 1);
  linkFolderItem(db, 7, 'BV2', 1);
};

/**
 * 建一份工作副本(体系现在就是它,不再走草稿),回**第一个**工作夹子的 id。
 *
 * 注意:第一次编辑触发克隆,`folders[0]` 是**克隆出来的快照夹子**(makeApp 里种的
 * 「深度学习」,origin 7),**不是**后面新建的「AI/编程」—— 名字只是为了让
 * 那个新建动作把副本带出来。需要「AI/编程」的话得自己再查一次视图。
 */
const seedWorkcopy = async (app: FastifyInstance): Promise<number> => {
  await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI/编程' } });
  const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
  return view.folders[0].id as number;
};

/** 把 SSE 文本解析成 {event, data}[] —— 归类改流式后所有断言走这个 */
const sseEvents = (body: string) =>
  body
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => ({
      event: /^event: (.+)$/m.exec(b)?.[1] ?? 'message',
      data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? '{}') as Record<string, unknown>,
    }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.complete.mockResolvedValue(PROPOSAL);
  mocks.stream.mockImplementation(async ({ onChunk }: { onChunk: (s: string) => void }) => {
    onChunk('好');
    return '好';
  });
});

describe('会话路由', () => {
  it('开新会话返回 id', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/curator/sessions', payload: { title: '整理' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBeGreaterThan(0);
    await app.close();
  });

  it('没给标题时自动起一个', async () => {
    const { app, db } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/curator/sessions', payload: {} });
    expect(getSession(db, res.json().id)!.title).toContain('整理文件夹');
    await app.close();
  });

  it('会话列表只给摘要,不带消息体', async () => {
    const { app } = makeApp();
    await newSession(app);
    const res = await app.inject({ method: 'GET', url: '/api/curator/sessions' });
    expect(res.json().sessions).toHaveLength(1);
    expect(res.json().sessions[0]).not.toHaveProperty('messages');
    await app.close();
  });

  it('会话详情含消息 + 草稿 + 归类结果', async () => {
    const { app, db } = makeApp();
    const id = await newSession(app);
    saveClassification(db, id, [{ itemId: 'BV1', folderTempId: 'f1', confidence: 0.9, reason: 'r' }]);

    const res = await app.inject({ method: 'GET', url: `/api/curator/sessions/${id}` });
    const body = res.json();
    expect(body).toHaveProperty('session');
    expect(body.messages).toEqual([]);
    expect(body.draft).toBeNull();
    expect(body.classification.assignments).toHaveLength(1);
    await app.close();
  });

  it('不存在的会话 404', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/curator/sessions/999' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('归档是改状态,不是删掉', async () => {
    const { app, db } = makeApp();
    const id = await newSession(app);
    const res = await app.inject({ method: 'DELETE', url: `/api/curator/sessions/${id}` });
    expect(res.statusCode).toBe(200);
    expect(getSession(db, id)).toBeDefined();
    expect(getSession(db, id)!.status).toBe('archived');
    await app.close();
  });
});

describe('草稿路由', () => {
  it('PUT 存草稿,GET 拿回来', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    const folders = [{ tempId: 'f1', name: 'AI', description: '', rule: 'x', estCount: 1 }];

    const put = await app.inject({
      method: 'PUT',
      url: `/api/curator/sessions/${id}/draft`,
      payload: { folders, constraints: '控制在 12 个' },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: `/api/curator/sessions/${id}/draft` });
    expect(get.json().draft.folders[0].name).toBe('AI');
    expect(get.json().draft.constraints).toBe('控制在 12 个');
    await app.close();
  });

  it('缺 tempId / name 的草稿 400 —— 后面 Pass 2 靠它引用', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/curator/sessions/${id}/draft`,
      payload: { folders: [{ name: '没 tempId' }] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('folders 不是数组 400', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/curator/sessions/${id}/draft`,
      payload: { folders: '不是数组' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('发消息(SSE)', () => {
  it('流式回 delta,最后给完整回复', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/curator/sessions/${id}/messages`,
      payload: { content: '帮我整理' },
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"delta":"好"');
    expect(res.body).toContain('event: done');
    await app.close();
  });

  it('消息落库', async () => {
    const { app, db } = makeApp();
    const id = await newSession(app);
    await app.inject({
      method: 'POST',
      url: `/api/curator/sessions/${id}/messages`,
      payload: { content: '帮我整理' },
    });
    expect(getMessages(db, id).map((m) => m.role)).toEqual(['user', 'assistant']);
    await app.close();
  });

  it('空消息 400,而且**在 hijack 之前**就挡掉', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/curator/sessions/${id}/messages`,
      payload: { content: '   ' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('没配模型 → 400 提示去哪儿配', async () => {
    const { app } = makeApp({ llm: false });
    const id = await newSession(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/curator/sessions/${id}/messages`,
      payload: { content: '嗨' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('模型管理');
    await app.close();
  });

  it('模型报错时以 SSE error 事件收尾,不是半个响应挂在那', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    mocks.stream.mockRejectedValue(new Error('上游 500'));
    const res = await app.inject({
      method: 'POST',
      url: `/api/curator/sessions/${id}/messages`,
      payload: { content: '嗨' },
    });
    expect(res.body).toContain('event: error');
    expect(res.body).toContain('上游 500');
    await app.close();
  });

  // **app.inject 模拟不了"请求体读完触发 req.raw close"** —— 这正是最终评审抓到的那个
  // Critical:close 接在 req 上时,带 JSON body 的聊天每一条都当场自尽。用真 listener
  // + 真 fetch 钉住:正常的聊天请求必须拿到 delta + done,而不是 error。
  it('真 socket 下,带 JSON body 的聊天正常完成(不被自己的 close 掐死)', async () => {
    const { app, db } = makeApp();
    seed(db);
    // **默认的 mocks.stream 不认 abortSignal**(beforeEach 那个直接吐 '好'),
    // 所以光靠它这条测试永远绿 —— close 在 stream 开跑前就 abort 了,信号却是真被
    // 忽略的。这里复刻真 provider 的契约:信号已 abort 的流拿不到任何内容,表现为
    // "流正常结束但零 chunk" —— 正是线上那句「模型没有返回任何内容」的来源。
    mocks.stream.mockImplementation(async ({ abortSignal }: { abortSignal?: AbortSignal }) =>
      abortSignal?.aborted ? '' : '好',
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const sidRes = await fetch(`${base}/api/curator/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 't' }),
    });
    const sid = ((await sidRes.json()) as { id: number }).id;

    const res = await fetch(`${base}/api/curator/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '你好' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: done');          // 不是 error —— close 误触发的话这里是 error
    expect(body).not.toContain('event: error');

    // 落库完整:用户消息 + assistant 回复都在
    const detail = await (await fetch(`${base}/api/curator/sessions/${sid}`)).json();
    const roles = (detail as { messages: { role: string }[] }).messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant']);
    await app.close();
  });
});

describe('Pass 1', () => {
  it('跑通后体系落草稿,并回 batchSize 给 UI 显示', async () => {
    const { app, db } = makeApp();
    const id = await newSession(app);
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${id}/run-pass-1` });

    expect(res.statusCode).toBe(200);
    expect(res.json().taxonomy.folders[0].name).toBe('AI/编程');
    expect(res.json().batchSize).toBeGreaterThan(0);
    expect(getLatestDraft(db, id)!.folders[0]!.name).toBe('AI/编程');
    await app.close();
  });

  it('§9.1.1 校验不过 → 400 + 具体问题清单,Pass 2 没机会启动', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    mocks.complete.mockResolvedValue('{"folders":[{"tempId":"f1","name":"A","reuseFolderId":999}]}');

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${id}/run-pass-1` });
    expect(res.statusCode).toBe(400);
    expect(res.json().problems.join('\n')).toContain('999');
    await app.close();
  });

  it('未复用现有夹子只是警告,仍然 200', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    mocks.complete.mockResolvedValue('{"folders":[{"tempId":"f1","name":"全新体系"}]}');

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${id}/run-pass-1` });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.join('\n')).toContain('没用上');
    await app.close();
  });

  it('本地没有收藏数据 → 400 让人先去同步', async () => {
    const { app } = makeApp({ seed: false });
    const id = await newSession(app);
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${id}/run-pass-1` });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('同步');
    await app.close();
  });

  it('模型输出不可解析 → 502', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    mocks.complete.mockResolvedValue('我不太确定');
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${id}/run-pass-1` });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

describe('Pass 2', () => {
  it('归类结果落库并返回', async () => {
    const { app, db } = makeApp();
    const id = await newSession(app);
    const workId = await seedWorkcopy(app);
    // 体系来自工作副本,tempId 就是工作夹子 id —— mock 得照着它引用
    mocks.complete.mockResolvedValue(
      `[{"itemId":"BV1","folderTempId":"${workId}","confidence":0.9,"reason":"是教程"}]`,
    );

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${id}/run-pass-2` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const done = sseEvents(res.body).find((e) => e.event === 'done')!;
    expect((done.data.assignments as { folderTempId: string }[])[0]!.folderTempId).toBe(String(workId));
    expect(done.data.total).toBe(1);

    // 落库了 —— 刷新页面不用重跑
    const detail = await app.inject({ method: 'GET', url: `/api/curator/sessions/${id}` });
    expect(detail.json().classification.assignments).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM classifications`).get()).toEqual({ n: 1 });
    await app.close();
  });

  // I1:§9E C5 的**头号行为** —— 标注真的作为补充信号走进归类 prompt。
  // 这条钉的是 routes.ts:352 的 `SELECT * FROM items` → renderItem 那一路:
  // 改成窄投影(不选 ai_tags)会让整个功能静默消失,而其余测试全绿。
  // 所以断言必须落在**模型真的收到的那条 user 消息**上,不是 renderItem 的单元测试。
  it('run-pass-2:标注进了模型收到的 prompt(C5)', async () => {
    const { app, db } = makeApp();
    const sid = await newSession(app);
    const work = await seedWorkcopy(app);
    setItemTagging(db, 'BV1', { tags: ['Stable Diffusion', 'AI动画'], kind: '教学' });
    mocks.complete.mockResolvedValue(
      `[{"itemId":"BV1","folderTempId":"${work}","confidence":0.9,"reason":"是教程"}]`,
    );

    await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` });

    // 照现有测试的抠法:把喂给模型的整条 prompt 拼出来
    const prompt = mocks.complete.mock.calls
      .map((c) => (c[0] as { messages: { content: string }[] }).messages.map((m) => m.content).join('\n'))
      .find((p) => p.includes('## 收藏夹体系'));
    expect(prompt).toBeDefined();
    expect(prompt).toContain('AI标签:Stable Diffusion·AI动画 [教学]');
    await app.close();
  });

  // 撤回必须把归类结果一起清掉 —— 只清草稿的话,重开会话结果又冒出来
  it('DELETE classification 把归类结果清掉', async () => {
    const { app, db } = makeApp();
    const id = await newSession(app);
    await seedWorkcopy(app);
    mocks.complete.mockResolvedValue(ASSIGN);
    await app.inject({ method: 'POST', url: `/api/curator/sessions/${id}/run-pass-2` });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM classifications`).get()).toEqual({ n: 1 });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/curator/sessions/${id}/classification`,
    });
    expect(res.statusCode).toBe(200);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM classifications`).get()).toEqual({ n: 0 });

    // 重开会话不再冒出旧结果
    const detail = await app.inject({ method: 'GET', url: `/api/curator/sessions/${id}` });
    expect(detail.json().classification).toBeNull();
    await app.close();
  });

  it('清不存在的会话 → 404', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/curator/sessions/999/classification' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('没有结构 → 400,不白花 token', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${id}/run-pass-2` });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('还没有结构');
    expect(mocks.complete).not.toHaveBeenCalled();
    await app.close();
  });

  // R5 的全部价值就在这条:规则覆盖的条目 0 token 归位,一次 LLM 都不调
  it('规则命中的条目不进 AI 调用', async () => {
    const { app, db } = makeApp();
    seed(db); // BV1 / BV2 在快照夹子 7 里,标题分别是 'a' / 'b'
    const work = await seedWorkcopy(app);

    await app.inject({
      method: 'PUT',
      url: `/api/rules/${work}`,
      payload: { conditions: [{ field: 'title', any: ['a', 'b'] }] },
    });

    mocks.complete.mockClear();
    const sid = await newSession(app);
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` });
    expect(res.statusCode).toBe(200);

    const events = sseEvents(res.body);
    const done = events.find((e) => e.event === 'done')!;
    expect(done.data.ruleCount).toBe(2);
    expect(done.data.aiCount).toBe(0);
    // 规则不是"批" —— 没有 AI 批次就没有 progress 帧
    expect(events.filter((e) => e.event === 'progress')).toHaveLength(0);
    // 规则全覆盖 → 一次 LLM 都不该调
    expect(mocks.complete).not.toHaveBeenCalled();

    // 而且这两条真的被写进了归类提案(folderTempId 就是工作夹子 id)
    const stored = getClassification(db, sid)!;
    expect(stored.assignments.map((a) => a.folderTempId)).toEqual([String(work), String(work)]);
    expect(stored.assignments.every((a) => a.confidence === 1)).toBe(true);
    await app.close();
  });

  // 「新增规则」建出来就是 `[{field:'title',any:[]}]`,它渲染成空串 ——
  // 那种夹子必须和"没规则"一样待遇,不然模型只看到一个光秃秃的名字(§9C.0)
  it('规则行存在但渲染为空 → 照旧带样本标题', async () => {
    const { app, db } = makeApp();
    seed(db); // BV1 / BV2 标题是 'a' / 'b',在快照夹子 7 里
    const work = await seedWorkcopy(app);
    saveRule(db, work, [{ field: 'title', any: [] }], 'user'); // 半写的规则

    const sid = await newSession(app);
    await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` });

    // 把喂给模型的那条 prompt 抓出来,确认样本标题确实在里头
    const prompt = mocks.complete.mock.calls
      .map((c) => (c[0] as { messages: { content: string }[] }).messages.map((m) => m.content).join('\n'))
      .find((p) => p.includes('## 收藏夹体系'));
    expect(prompt).toBeDefined();
    expect(prompt).toContain('现有条目');
    await app.close();
  });

  it('run-pass-2 带上建议 —— 有没归上的条目时才调,且不落库', async () => {
    const { app, db } = makeApp();
    seed(db);
    const work = await seedWorkcopy(app);

    // 第一次调用是归类(给 BV1/BV2 都填 null = 没归上),第二次是建议
    mocks.complete
      .mockResolvedValueOnce(
        `[{"itemId":"BV1","folderTempId":null,"confidence":0.1,"reason":"拿不准"},` +
          `{"itemId":"BV2","folderTempId":null,"confidence":0.1,"reason":"拿不准"}]`,
      )
      .mockResolvedValueOnce(JSON.stringify([
        { folderTempId: work, field: 'title', any: ['a'], because: '同类', evidenceItemIds: ['BV1'] },
      ]));

    const sid = await newSession(app);
    const done = sseEvents(
      (await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` })).body,
    ).find((e) => e.event === 'done')!;

    expect(done.data.suggestions).toHaveLength(1);
    expect(mocks.complete).toHaveBeenCalledTimes(2);

    // 建议不落库:classifications 里只有归类结果,规则表还是空的
    expect((await app.inject({ url: '/api/rules' })).json().rules.every(
      (r: { conditions: unknown[] }) => r.conditions.length === 0,
    )).toBe(true);
    await app.close();
  });

  it('run-pass-2:没有没归上的条目 → 不调建议那一次', async () => {
    const { app, db } = makeApp();
    seed(db);
    const work = await seedWorkcopy(app);
    mocks.complete.mockResolvedValue(
      `[{"itemId":"BV1","folderTempId":"${work}","confidence":0.9,"reason":"是"},` +
        `{"itemId":"BV2","folderTempId":"${work}","confidence":0.9,"reason":"是"}]`,
    );

    const sid = await newSession(app);
    const done = sseEvents(
      (await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` })).body,
    ).find((e) => e.event === 'done')!;

    expect(done.data.suggestions).toEqual([]);
    expect(mocks.complete).toHaveBeenCalledTimes(1); // 只有归类那一次
    await app.close();
  });

  it('run-pass-2 是 SSE:每批 progress(带 ruleCount),结束时 done', async () => {
    const { app, db } = makeApp();
    seed(db);
    const work = await seedWorkcopy(app);
    // 规则本用例自己种 —— makeApp 每个用例重建内存库,别指望上一条用例留下的规则。
    // 种 'a':只有 seed 的 BV1(标题 'a')命中 —— 新种的都叫「标题N」不含 'a'
    saveRule(db, work, [{ field: 'title', any: ['a'] }], 'user');
    // 逼出多批:该 ctx 算出 batchSize=68,>68 条才会有第二批(68 + 4)。
    // id 从 BV100 起,避开 seed 的 BV1/BV2 —— 撞了会覆盖掉 BV1 的标题 'a',规则就匹配不上了
    for (let i = 0; i < 70; i++) upsertItem(db, { id: `BV${i + 100}`, type: 2, title: `标题${i}` });
    // 照 prompt 里抠出来的 itemId 原样回,喂几条回几条
    mocks.complete.mockImplementation(async ({ messages }: { messages: { content: string }[] }) => {
      const ids = [...messages[1]!.content.matchAll(/^\[(BV\w+)\]/gm)].map((m) => m[1]!);
      return JSON.stringify(
        ids.map((id) => ({ itemId: id, folderTempId: String(work), confidence: 0.9, reason: 'r' })),
      );
    });

    const sid = await newSession(app);
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = sseEvents(res.body);
    const progress = events.filter((e) => e.event === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(2); // 71 条 / 68 = 2 批
    // 恰好这五个字段 —— 前端的 ProgressPayload 依赖这个形状,多一个都算破坏契约
    expect(Object.keys(progress[0]!.data).sort()).toEqual(['batch', 'batches', 'done', 'ruleCount', 'total']);
    expect(progress[0]!.data.ruleCount).toBe(1); // 只有 seed 的 BV1 被规则接走

    const done = events.find((e) => e.event === 'done')!;
    expect(done).toBeDefined();
    expect(done.data.total).toBe(72);
    await app.close();
  });

  it('归类的结果分批落库 —— 每批完成就是一次 saveClassification(upsert)', async () => {
    const { app, db } = makeApp();
    seed(db);
    const work = await seedWorkcopy(app);
    for (let i = 0; i < 70; i++) upsertItem(db, { id: `BV${i + 100}`, type: 2, title: `标题${i}` });

    // 模拟「用户中断」:第一批跑完,第二批的 provider 调用收到中止 ——
    // 生产里客户端断开 → 路由 abort controller → complete 的 signal 也随之 abort。
    // 这里把同一个 signal 交给 inject,再让 mock 等**路由侧**的 signal 真的 abort
    // 之后抛 AbortError(provider 被中断时就是抛这个)—— 不依赖事件循环的先后。
    const controller = new AbortController();
    let calls = 0;
    mocks.complete.mockImplementation(
      async ({ messages, abortSignal }: { messages: { content: string }[]; abortSignal?: AbortSignal }) => {
        calls += 1;
        if (calls >= 2) {
          controller.abort();
          if (abortSignal && !abortSignal.aborted) {
            await new Promise<void>((resolve) => abortSignal.addEventListener('abort', () => resolve(), { once: true }));
          }
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        const ids = [...messages[1]!.content.matchAll(/^\[(BV\w+)\]/gm)].map((m) => m[1]!);
        return JSON.stringify(
          ids.map((id) => ({ itemId: id, folderTempId: String(work), confidence: 0.9, reason: 'r' })),
        );
      },
    );

    const sid = await newSession(app);
    // 断开连接:inject 的 promise 会跟着 reject(客户端没了就是这个样子),吞掉它 ——
    // 要验的是"结果落了多少",不是响应码
    await app
      .inject({
        method: 'POST',
        url: `/api/curator/sessions/${sid}/run-pass-2`,
        signal: controller.signal,
      })
      .catch(() => undefined);

    // **不是 0 也不是全部** —— 中断时已完成的批次留下了,没跑的批次没有被补成"结果"
    const stored = getClassification(db, sid)!;
    expect(stored.assignments.length).toBeGreaterThan(0);
    expect(stored.assignments.length).toBeLessThan(72);
    // 两次:批次1 成功 + 批次2 撞上中止。建议那一路是**第三次** complete ——
    // 中止后不跑建议(不然就是把没跑完的结果拿去攒建议)
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    // 中止记 warn 不是 error(用户改主意不是故障)。silent 只关 stdout,events 表照写。
    // **要 waitFor**:客户端断开那一刻 inject 的 promise 就落定了,而路由的收尾
    // (记日志 → end)是在那之后接着跑的 —— 直接断言会读到还没写的库
    await vi.waitFor(() =>
      expect(db.prepare(`SELECT level FROM events WHERE code='PASS2_ABORTED'`).get()).toEqual({
        level: 'warn',
      }),
    );
    await app.close();
  });
});

describe('应用 AI 结论', () => {
  /** 日志里最后一条的 ts。用来把「提案时间」钉在确定的位置 */
  const lastOpTs = (db: ReturnType<typeof openDb>): number =>
    (db.prepare(`SELECT COALESCE(MAX(ts), 0) AS t FROM operation_log`).get() as { t: number }).t;

  /**
   * 造出「提案之后没人动过」的**确定**状态:把 updated_at 钉在所有历史操作之后。
   *
   * 不钉的话,建夹子那步和 saveClassification 可能落在同一毫秒,而 listOperations 是
   * `ts >= sinceTs`,打平就会被算进冲突窗口 —— 测试会随机 409。
   */
  const proposeAfterAllOps = (db: ReturnType<typeof openDb>, sid: number): void => {
    db.prepare(`UPDATE classifications SET updated_at = ? WHERE session_id = ?`).run(
      lastOpTs(db) + 1,
      sid,
    );
  };

  it('应用 AI 结论:条目按归类结果落到工作副本,日志 actor=ai', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const workId = await seedWorkcopy(app);

    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(workId), confidence: 0.9, reason: 'r' },
      { itemId: 'BV2', folderTempId: String(workId), confidence: 0.8, reason: 'r' },
    ]);
    proposeAfterAllOps(db, sid);

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(2);

    const log = (await app.inject({ method: 'GET', url: '/api/workbench/log' })).json().operations;
    const ai = log.find((e: { actor: string }) => e.actor === 'ai');
    expect(ai.kind).toBe('move_items');
    expect(ai.sessionId).toBe(sid);
    await app.close();
  });

  it('提案里的夹子已经被删了 → 跳过它,其余照常', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const workId = await seedWorkcopy(app);
    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(workId + 999), confidence: 0.9, reason: 'r' },
    ]);
    proposeAfterAllOps(db, sid);

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(0);
    expect(res.json().skipped).toBe(1);
    await app.close();
  });

  it('生成提案之后你又手改过 → 409 列出会被覆盖的,带 force 才动', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const workId = await seedWorkcopy(app);
    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(workId), confidence: 0.9, reason: 'r' },
    ]);

    // 提案时间 = 建夹子那步之后 —— 于是窗口里**只有**紧接着那次改名,测试才咬得住
    db.prepare(`UPDATE classifications SET updated_at = ? WHERE session_id = ?`).run(
      lastOpTs(db) + 1,
      sid,
    );
    await app.inject({
      method: 'PATCH', url: `/api/workbench/folders/${workId}`, payload: { name: '改过了' },
    });

    // 默认**不覆盖**:409 + 说清是哪几处
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(409);
    expect(res.json().conflicts).toHaveLength(1);
    expect(res.json().conflicts[0].summary).toContain('改过了');
    expect(res.json().reason).toContain('会覆盖');
    // 没动过手就说"会覆盖"是假话 —— 那条 move_items 不该存在
    const before = (await app.inject({ method: 'GET', url: '/api/workbench/log' })).json().operations;
    expect(before.some((e: { actor: string }) => e.actor === 'ai')).toBe(false);

    // 带 force 才真的应用,并如实报出覆盖了几处
    const forced = await app.inject({
      method: 'POST', url: `/api/curator/sessions/${sid}/apply`, payload: { force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().applied).toBe(1);
    expect(forced.json().overwritten).toBe(1);
    await app.close();
  });

  it('没有手改过 → 照常应用,overwritten 为 0(不该被自己的冲突检查拦住)', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const workId = await seedWorkcopy(app);
    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(workId), confidence: 0.9, reason: 'r' },
    ]);
    proposeAfterAllOps(db, sid);

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(1);
    expect(res.json().overwritten).toBe(0);
    await app.close();
  });

  it('提案之后的 **AI** 日志不算冲突(只有用户手改才算)', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const workId = await seedWorkcopy(app);
    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(workId), confidence: 0.9, reason: 'r' },
    ]);

    // 提案之后写一条 AI 的操作,并把窗口起点**正好**设在它上面 —— 它必须被过滤掉
    const aiOpId = logOperation(db, {
      kind: 'move_items', actor: 'ai', sessionId: sid, summary: 'AI 自己动过',
    });
    const aiTs = (
      db.prepare(`SELECT ts FROM operation_log WHERE id = ?`).get(aiOpId) as { ts: number }
    ).ts;
    db.prepare(`UPDATE classifications SET updated_at = ? WHERE session_id = ?`).run(aiTs, sid);

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(200); // AI 的改动不是"你手改的",不拦
    await app.close();
  });

  // 生成侧明确会产 null(提示词写着"拿不准就填 null",整批失败也是 null),
  // 所以这不是异常路径。既不算 applied 也不算 skipped 的话接口会回"全部成功",
  // 而实际有一批条目**原地不动** —— 用户被告知归类完成,却完全不知道。
  it('AI 拿不准的条目单列 unclassified,而且归属一点没动', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'AI/编程' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const deep = view.folders.find((f: { originId: number }) => f.originId === 7).id;
    const target = view.folders.find((f: { name: string }) => f.name === 'AI/编程').id;

    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(target), confidence: 0.9, reason: 'r' },
      { itemId: 'BV2', folderTempId: null, confidence: 0.1, reason: '拿不准' },
    ]);
    proposeAfterAllOps(db, sid);

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(1);
    expect(res.json().unclassified).toBe(1);

    // BV1 去了新夹子,BV2 留在原处 —— "原地不动"是这半句的真实验证
    const moved = (await app.inject({ method: 'GET', url: `/api/workbench/folders/${target}/items` })).json();
    expect(moved.items.map((i: { id: string }) => i.id)).toEqual(['BV1']);
    const stayed = (await app.inject({ method: 'GET', url: `/api/workbench/folders/${deep}/items` })).json();
    expect(stayed.items.map((i: { id: string }) => i.id)).toEqual(['BV2']);
    await app.close();
  });

  it('没有手改、也没有 null 归属时 unclassified 为 0', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const workId = await seedWorkcopy(app);
    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(workId), confidence: 0.9, reason: 'r' },
    ]);
    proposeAfterAllOps(db, sid);

    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.json().unclassified).toBe(0);
    await app.close();
  });

  it('有行但 assignments 是空的 → 400', async () => {
    const { app, db } = makeApp();
    const sid = await newSession(app);
    saveClassification(db, sid, []); // 写了行,但提案一条都没有
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('没有提案 → 400', async () => {
    const { app } = makeApp();
    const sid = await newSession(app);
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/apply` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('apply:一条条目被指派到两个夹子 → 两个里都有(都归)', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);
    const a = await seedWorkcopy(app); // 克隆出来的「深度学习」

    // 再建一个新夹子当第二个目标
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: '待整理' } });
    const view = (await app.inject({ url: '/api/workbench' })).json();
    const b = view.folders.find((f: { name: string }) => f.name === '待整理').id as number;
    expect(b).not.toBe(a);

    saveClassification(db, sid, [
      { itemId: 'BV1', folderTempId: String(a), confidence: 0.9, reason: 'r1' },
      { itemId: 'BV1', folderTempId: String(b), confidence: 0.8, reason: 'r2' },
    ]);

    const res = await app.inject({
      method: 'POST', url: `/api/curator/sessions/${sid}/apply`, payload: { force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(1);

    for (const fid of [a, b]) {
      const items = (await app.inject({ url: `/api/workbench/folders/${fid}/items` })).json();
      expect(items.items.map((i: { id: string }) => i.id)).toContain('BV1');
    }
    await app.close();
  });
});

describe('审计报告', () => {
  it('生成 reorganize 报告:前后对比 + 存档', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    await app.inject({
      method: 'PUT',
      url: `/api/curator/sessions/${id}/draft`,
      payload: {
        folders: [
          { tempId: 'f1', name: 'AI/编程', description: '', rule: 'x', estCount: 1, reuseFolderId: 7 },
        ],
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/curator/audit/reorganize',
      payload: { sessionId: id },
    });

    expect(res.statusCode).toBe(200);
    const report = res.json().report;
    expect(report.kind).toBe('reorganize');
    expect(report.before[0].name).toBe('深度学习');
    expect(report.after[0].name).toBe('AI/编程');
    expect(report.detail.merged).toEqual([{ fromFolderId: 7, intoTempId: 'f1' }]);
    await app.close();
  });

  it('没草稿 → 400', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/curator/audit/reorganize',
      payload: { sessionId: id },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('报告可列表(不含大明细)', async () => {
    const { app } = makeApp();
    const id = await newSession(app);
    await app.inject({
      method: 'PUT',
      url: `/api/curator/sessions/${id}/draft`,
      payload: { folders: [{ tempId: 'f1', name: 'A', description: '', rule: 'x', estCount: 1 }] },
    });
    await app.inject({ method: 'POST', url: '/api/curator/audit/reorganize', payload: { sessionId: id } });

    const res = await app.inject({ method: 'GET', url: '/api/curator/audit?kind=reorganize' });
    expect(res.json().audits).toHaveLength(1);
    expect(res.json().audits[0]).not.toHaveProperty('detail');
    await app.close();
  });
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
      const e = await app.inject({ method: 'POST', url: '/api/settings/entries', payload: { providerId: pid, model: 'deepseek-chat' } });
      expect(e.statusCode).toBe(200);
      const list = (await app.inject({ method: 'GET', url: '/api/settings/entries' })).json();
      expect(list.entries[0]).toMatchObject({ model: 'deepseek-chat', contextWindow: 128_000, maxOutput: 8_192, verified: true });
      const a = (await app.inject({ method: 'GET', url: '/api/settings/assignments' })).json();
      expect(a.assignments).toEqual({
        chat: list.entries[0].id, classify: list.entries[0].id, rules: list.entries[0].id, tag: list.entries[0].id,
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
      expect(a.assignments.chat).not.toBe(e2.json().id);
      const bad = await app.inject({ method: 'PUT', url: '/api/settings/assignments', payload: { chat: 'm_nope' } });
      expect(bad.statusCode).toBe(400);
      await app.close();
    });

    it('用途没分配 → curator 接口 400 提示去配置', async () => {
      const { app } = makeApp();
      await app.inject({ method: 'PUT', url: '/api/settings/assignments', payload: { chat: null } });
      const sid = (await app.inject({ method: 'POST', url: '/api/curator/sessions', payload: {} })).json().id as number;
      const r = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/messages`, payload: { content: 'hi' } });
      expect(r.statusCode).toBe(400);
      expect(r.json().reason).toContain('模型');
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
      payload: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-live-DEADBEEF' },
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
    setAssignment(db, 'chat', e.id);
    const s = readLlmSettings(db, 'chat')!;
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

  it('删非空夹 → 400 并说清还有多少条', async () => {
    const { app, db } = makeApp();
    seed(db);
    await app.inject({ method: 'POST', url: '/api/workbench/folders', payload: { name: 'x' } });
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const deep = view.folders.find((f: { originId: number }) => f.originId === 7).id;

    const res = await app.inject({ method: 'DELETE', url: `/api/workbench/folders/${deep}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('还有 2 条');
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
