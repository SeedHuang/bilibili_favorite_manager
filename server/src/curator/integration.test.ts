/**
 * M4 端到端:mock 掉 LLM,其余全真(SQLite + Fastify + 路由 + 仓储)。
 *
 * 单测已经各自覆盖了细节,这里要证明的是**它们串起来能跑**:
 * 同步进来的数据 → Pass 1 提体系 → 用户手改 → Pass 2 归类 → 审计报告,
 * 以及流式聊天的 chunk → SSE → 落库 → 历史读回。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import { upsertFolder, listFolders } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { seedLlm } from '../llm/config.js';
import { getMessages } from '../db/repo/sessions.js';
import { getLatestDraft } from '../db/repo/sessions.js';
import type { BiliClient } from '../bilibili/client.js';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

const mocks = vi.hoisted(() => ({ complete: vi.fn(), stream: vi.fn() }));
vi.mock('../llm/provider.js', async (orig) => ({
  ...(await orig<typeof import('../llm/provider.js')>()),
  complete: mocks.complete,
  stream: mocks.stream,
}));

const stubClient = { withCredentials: () => ({ get: async () => null }) } as unknown as BiliClient;

/** 模拟一次同步落下的数据:3 个夹子,内容横跨 编程 / 音乐 / 无关键词 */
function seedLibrary(db: ReturnType<typeof openDb>) {
  const folders = [
    { id: 7, title: '深度学习' },
    { id: 8, title: '前端' },
    { id: 9, title: '随便看看' },
  ];
  for (const f of folders) upsertFolder(db, { id: f.id, title: f.title, mediaCount: 0 });

  const rows: [string, string, number][] = [
    ['BV1', 'Python 从入门到精通', 7],
    ['BV2', 'Transformer 详解', 7],
    ['BV3', 'JavaScript 事件循环', 8],
    ['BV4', 'TypeScript 类型体操', 8],
    ['BV5', '今天的晚饭', 9],
    ['BV6', '随手拍的云', 9],
  ];
  for (const [id, title, folderId] of rows) {
    upsertItem(db, { id, type: 2, title, intro: `${title} 的完整简介` });
    linkFolderItem(db, folderId, id, 1);
  }
  // 让 media_count 跟真实关联数一致 —— 审计报告的"现在结构"读的就是它
  for (const f of listFolders(db)) {
    const n = (
      db.prepare(`SELECT COUNT(*) AS n FROM folder_items WHERE folder_id = ?`).get(f.id) as {
        n: number;
      }
    ).n;
    db.prepare(`UPDATE folders SET media_count = ? WHERE id = ?`).run(n, f.id);
  }
}

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  seedLibrary(db);
  seedLlm(db);
  const app = createServer({ db, log, client: stubClient });
  return { app, db };
}

const post = (
  app: FastifyInstance,
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url, ...(payload === undefined ? {} : { payload }) });
const put = (
  app: FastifyInstance,
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'PUT', url, ...(payload === undefined ? {} : { payload }) });

/** 把 SSE 文本解析成 {event, data}[] —— 归类改流式后要拿 done 帧里的结果 */
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
  mocks.stream.mockImplementation(async ({ onChunk }: { onChunk: (s: string) => void }) => {
    for (const d of ['你现有 ', '3 个夹子,', '建议合并成 2 个。']) onChunk(d);
    return '你现有 3 个夹子,建议合并成 2 个。';
  });
});

describe('M4 端到端', () => {
  it('对话 → 提体系 → 手改 → 归类 → 审计报告,全程走通', async () => {
    const { app, db } = makeApp();

    // ── 1. 开会话,聊几轮达成体系 ────────────────────
    const sid = (await post(app, '/api/curator/sessions', { title: '整理 2026-09-15' })).json().id;

    const chat = await post(app, `/api/curator/sessions/${sid}/messages`, {
      content: '帮我整理收藏夹',
    });
    expect(chat.headers['content-type']).toContain('text/event-stream');
    expect(chat.body).toContain('"delta":"你现有 "');

    // chunk 逐个落到 SSE,完整回复落到库里
    expect(getMessages(db, sid).map((m) => [m.role, m.content])).toEqual([
      ['user', '帮我整理收藏夹'],
      ['assistant', '你现有 3 个夹子,建议合并成 2 个。'],
    ]);

    // 历史读回(刷新页面能看到)
    const detail = await app.inject({ method: 'GET', url: `/api/curator/sessions/${sid}` });
    expect(detail.json().messages).toHaveLength(2);

    // ── 2. Pass 1 提体系 ────────────────────────────
    mocks.complete.mockResolvedValueOnce(
      JSON.stringify({
        folders: [
          { tempId: 'f1', name: 'AI/编程', description: '编程与模型', rule: '标题含 Python/JS/Transformer', estCount: 4, reuseFolderId: 7 },
          { tempId: 'f2', name: '生活', description: '日常', rule: '非技术内容', estCount: 2, reuseFolderId: 9 },
        ],
        notes: '把「前端」并进了「AI/编程」',
      }),
    );

    const pass1 = await post(app, `/api/curator/sessions/${sid}/run-pass-1`, {
      constraint: '控制在 3 个以内',
    });
    expect(pass1.statusCode).toBe(200);
    const p1 = pass1.json();
    expect(p1.taxonomy.folders).toHaveLength(2);
    expect(p1.keywordStats.matched).toBeGreaterThan(0); // keyword 初分真的起了作用
    // 「前端」没被复用 —— 必须作为警告浮出来,而且要带**名字**,
    // 光说「收藏夹 #8 没用上」用户根本不知道是哪一个
    expect(p1.warnings.join('\n')).toContain('前端');
    expect(p1.warnings.join('\n')).not.toContain('#8');
    expect(p1.batchSize).toBeGreaterThan(0);

    // 体系落草稿了
    expect(getLatestDraft(db, sid)!.folders).toHaveLength(2);

    // ── 3. 用户手改体系 ─────────────────────────────
    // 3a. 草稿那份:审计报告这一步还读草稿(没迁到工作副本,超出 T9 范围),
    //     所以先让它存在,并且也顺带验一下「改体系不污染消息流」。
    const edited = [
      { tempId: 'f1', name: 'AI/编程', description: '', rule: '标题含 Python/JS/Transformer', estCount: 4, reuseFolderId: 7 },
      { tempId: 'f2', name: '生活', description: '', rule: '非技术内容', estCount: 2, reuseFolderId: 9 },
      { tempId: 'f3', name: '前端', description: '', rule: '含 JavaScript/TypeScript', estCount: 2, reuseFolderId: 8 },
    ];
    expect((await put(app, `/api/curator/sessions/${sid}/draft`, { folders: edited, constraints: '控制在 3 个以内' })).statusCode).toBe(200);

    // 改体系**不该**污染消息流 —— 否则压缩一次就把已确认的体系压成一段话
    const afterEdit = getMessages(db, sid);
    expect(afterEdit).toHaveLength(2);
    expect(afterEdit.some((m) => m.content.includes('tempId'))).toBe(false);

    // 3b. 「整理」页那份 —— **Pass 2 的体系现在来自工作副本**,不再是草稿。
    //     tempId 直接用工作夹子 id,所以这里得知道那三个 id。
    //     先随手动一下触发建副本,再按上面那版方案改名(深度学习→AI/编程、随便看看→生活)。
    const trigger = (await post(app, '/api/workbench/folders', { name: '临时' })).json().id;
    const wfView = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    const workIdOf = (origin: number): number =>
      wfView.folders.find((f: { originId: number | null }) => f.originId === origin).id;
    for (const [origin, name] of [[7, 'AI/编程'], [9, '生活']] as const) {
      await app.inject({
        method: 'PATCH',
        url: `/api/workbench/folders/${workIdOf(origin)}`,
        payload: { name },
      });
    }
    await app.inject({ method: 'DELETE', url: `/api/workbench/folders/${trigger}` });

    // ── 4. Pass 2 归类 ─────────────────────────────
    mocks.complete.mockResolvedValue(
      JSON.stringify([
        { itemId: 'BV1', folderTempId: String(workIdOf(7)), confidence: 0.95, reason: 'Python 教程' },
        { itemId: 'BV2', folderTempId: String(workIdOf(7)), confidence: 0.9, reason: 'Transformer 讲解' },
        { itemId: 'BV3', folderTempId: String(workIdOf(8)), confidence: 0.92, reason: 'JavaScript' },
        { itemId: 'BV4', folderTempId: String(workIdOf(8)), confidence: 0.94, reason: 'TypeScript' },
        { itemId: 'BV5', folderTempId: String(workIdOf(9)), confidence: 0.85, reason: '做饭' },
      ]),
    );

    const pass2 = await post(app, `/api/curator/sessions/${sid}/run-pass-2`);
    expect(pass2.statusCode).toBe(200);
    // 归类应答现在是 SSE —— 结果在 done 帧里(形状和旧一次性 JSON 一样)
    const p2 = sseEvents(pass2.body).find((e) => e.event === 'done')!.data;
    expect(p2.total).toBe(6);

    // ── 5. 每条都有归属 —— 模型漏掉的 BV6 补成「待定」,不凭空消失 ──
    const byId = new Map(
      (
        p2.assignments as { itemId: string; folderTempId: string | null; reason: string }[]
      ).map((a) => [a.itemId, a]),
    );
    expect(byId.size).toBe(6);
    expect((byId.get('BV6') as { folderTempId: string | null }).folderTempId).toBeNull();
    // folderTempId 就是**工作夹子 id** —— 不是映射出来的名字
    expect((byId.get('BV1') as { folderTempId: string }).folderTempId).toBe(String(workIdOf(7)));
    expect((byId.get('BV4') as { reason: string }).reason).toBe('TypeScript');

    // ── 6. 审计报告(前后对比 + 存档)───────────────────
    const audit = await post(app, '/api/curator/audit/reorganize', { sessionId: sid });
    expect(audit.statusCode).toBe(200);
    const report = audit.json().report;
    expect(report.before.map((f: { name: string }) => f.name).sort()).toEqual([
      '前端',
      '深度学习',
      '随便看看',
    ]);
    expect(report.after).toHaveLength(3);
    expect(report.detail.merged).toHaveLength(3);
    expect(report.detail.unassigned).toEqual(['BV6']);

    const listed = await app.inject({ method: 'GET', url: '/api/curator/audit?kind=reorganize' });
    expect(listed.json().audits).toHaveLength(1);
    expect(listed.json().audits[0].kind).toBe('reorganize');

    await app.close();
  });

  it('Pass 1 幻觉 → Pass 2 根本不会启动(§9.1.1 的核心价值)', async () => {
    const { app, db } = makeApp();
    const sid = (await post(app, '/api/curator/sessions', {})).json().id;

    // AI 把现有夹子 id 写错了(幻觉)
    mocks.complete.mockResolvedValueOnce(
      JSON.stringify({ folders: [{ tempId: 'f1', name: 'AI', rule: 'x', reuseFolderId: 424242 }] }),
    );

    const res = await post(app, `/api/curator/sessions/${sid}/run-pass-1`);
    expect(res.statusCode).toBe(400);
    expect(res.json().problems.join(' ')).toContain('424242');

    // 关键:草稿没被写坏,Pass 2 也就无从跟着错
    expect(getLatestDraft(db, sid)).toBeNull();
    const p2 = await post(app, `/api/curator/sessions/${sid}/run-pass-2`);
    expect(p2.statusCode).toBe(400);
    expect(mocks.complete).toHaveBeenCalledTimes(1); // 只有那次 Pass 1

    await app.close();
  });

  it('长会话触发滚动压缩,但**体系一条不丢**', async () => {
    const { app, db } = makeApp();
    const sid = (await post(app, '/api/curator/sessions', {})).json().id;

    // 先把模型上下文压小,让压缩真的会发生(ollama 条目读的是运行时真实数字)
    db.prepare(`INSERT INTO settings (key,value) VALUES ('llm.ollama.meta',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(JSON.stringify({ 'qwen2.5:14b': { contextWindow: 6_000, maxOutput: 1_000 } }));

    // 体系 = 工作副本(m4b 之后聊天读的就是它)
    await post(app, '/api/workbench/folders', { name: 'AI/编程' });

    // 压缩要调一次 LLM 写摘要
    mocks.complete.mockResolvedValue('用户想把夹子合并到 3 个以内,保留「生活」。');

    // 攒够 20 轮长对话(recent 窗口是 16 条)
    for (let i = 0; i < 20; i++) {
      const msg = `第${i}轮` + '中'.repeat(999);
      await post(app, `/api/curator/sessions/${sid}/messages`, { content: msg });
    }
    expect(getMessages(db, sid)).toHaveLength(40);

    // 第 21 轮该触发压缩了
    await post(app, `/api/curator/sessions/${sid}/messages`, { content: '接着聊' });

    const summaryRow = db
      .prepare(`SELECT summary FROM sessions WHERE id = ?`)
      .get(sid) as { summary: string | null };
    expect(summaryRow.summary).toBeTruthy();

    // 工作副本没被动过 —— 压缩只动聊天
    const view = (await app.inject({ method: 'GET', url: '/api/workbench' })).json();
    expect(view.folders.map((f: { name: string }) => f.name)).toContain('AI/编程');
    // 而且压缩之后那一轮发给模型的上下文里**结构仍在**(它走 system,永远不被裁掉)
    const sent = mocks.stream.mock.calls.at(-1)![0].messages as { role: string; content: string }[];
    expect(sent.some((m) => m.role === 'system' && m.content.includes('AI/编程'))).toBe(true);
    // 消息也没被删,用户翻历史还能看到原文
    expect(getMessages(db, sid).length).toBeGreaterThan(40);

    await app.close();
  });

  it('归档会话后历史仍在(历史可续)', async () => {
    const { app, db } = makeApp();
    const sid = (await post(app, '/api/curator/sessions', {})).json().id;
    await post(app, `/api/curator/sessions/${sid}/messages`, { content: '记住这句话' });

    expect((await app.inject({ method: 'DELETE', url: `/api/curator/sessions/${sid}` })).statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/api/curator/sessions/${sid}` });
    expect(detail.json().session.status).toBe('archived');
    expect(detail.json().messages).toHaveLength(2);
    expect(getMessages(db, sid)[0]!.content).toBe('记住这句话');

    await app.close();
  });
});
