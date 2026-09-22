/**
 * /api/curator/* 与 /api/settings/*(模型管理)的路由(spec §9.0 流程 + §3 模型管理)。
 *
 * 沿用 M3 的 registerXxxRoutes(app, deps) 模式:路由只做 HTTP 层,
 * 编排在 curator/ 里,存储走 db/repo/。
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import { getItem, type ItemRow } from '../db/repo/items.js';
// 条目出口形状与 /api/folders/:id/items 共用同一份 —— 前端用同一套渲染,
// 分两份写迟早会分叉
import { shapeItem } from '../http/routes/items.js';
import {
  firstSavedApiKey, type LlmPurpose, PURPOSES,
  listProviders, saveProvider, deleteProvider,
  listEntries, addEntry, deleteEntry,
  getAssignments, setAssignment, ollamaMeta,
} from '../llm/config.js';
import { logOperation, listOperations } from '../db/repo/operations.js';
import { listModels, getModelMeta, type ModelMeta } from '../llm/registry.js';
import { listOllamaModels, ollamaRoot } from '../llm/ollama.js';
import { listRemoteModels } from '../llm/models.js';
import { complete } from '../llm/provider.js';
import { buildFolderProfiles } from './folderProfile.js';
import { buildWorkbenchView } from '../db/repo/workbenchView.js';
import {
  getWorkState, listWorkFolders, workItemIds, workItemIdsPaged,
} from '../db/repo/workbench.js';
import { getState, setSetting, stateKey } from '../db/repo/state.js';
import {
  renameFolder, createFolder, deleteFolder, mergeFolders,
  moveItems, addItems, removeItems, resetWorkbench,
  reconcileAiFolder, applyRuleHitsToFolder,
} from './workbench.js';
import { isAiFolder as isAiFolderWork } from '../db/repo/aiFolders.js';

export interface CuratorDeps {
  db: Database.Database;
  log: Logger;
  /** 注入点:Ollama 模型发现的 fetch(测试用假的,别真去连本机 Ollama) */
  ollamaFetchImpl?: typeof fetch;
}

export function registerCuratorRoutes(app: FastifyInstance, deps: CuratorDeps): void {
  const { db, log } = deps;

  // ── 整理工作台(spec m4b)────────────────────────────
  //
  // 编辑只写 work_* 表;动作全部经 curator/workbench.ts,那里保证每次都记日志。
  // 路由里**不许**直接写 work_* 表 —— 绕过那层就漏记了(§9B.7 约束 1、2)。

  /**
   * 把动作抛出来的异常翻成 400/404。
   *
   * **注意它是 return 出去的** —— 调用方必须 `return actionError(reply, e)`。
   * 早先写成"helper 自己 send、调用方继续往下走"会双响应:
   * Fastify 会先被 helper 发一次 400,再被调用方发一次 200。
   */
  const actionError = (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    e: unknown,
  ) => {
    const reason = (e as Error)?.message ?? String(e);
    // 只认这一条消息的**前缀** —— 别扫整条文案:锁定夹子那条会把用户可控的
    // 夹子名拼进去,名字里带「不存在」就会被误判成 404。
    //
    // **失败的尝试也留痕**。actionError 之前是「错就错,什么都不记」,
    // 用户在 UI 上除了短暂的红条什么都看不到 —— 现在留一条 kind='failed' 的
    // 操作记录,「操作记录」面板里就能看到具体哪里错了。logging 自身抛错要 catch,
    // 不能让留痕反过来把失败路径给炸了。
    // logging 自身抛错要 catch,不能让留痕反过来把失败路径给炸了
    try {
      logOperation(db, {
        kind: 'failed',
        actor: 'user',
        summary: '失败:' + reason,
        detail: { reason },
      });
    } catch {
      /* logging 自身不能左右返回路径 */
    }
    return reply.code(/^工作副本里没有夹子/.test(reason) ? 404 : 400).send({ ok: false, reason });
  };

  app.get('/api/workbench', async () => {
    const view = buildWorkbenchView(db);
    const state = getWorkState(db);
    const currentFull = Number(getState(db, stateKey.lastFull) ?? 0) || 0;
    return {
      exists: state !== null,
      basedOn: state?.basedOn ?? null,
      // 整理期间又同步过 → 界面顶部要提示(不阻断,但不能不吭声)
      stale: state !== null && state.basedOn !== currentFull,
      ...view,
      /**
       * §9F C14:每个夹子的标签画像 + 离群条目。
       *
       * **一次算完整个数组**(几十个夹子,内存统计),不要在字段里按需算 ——
       * 那会让这个本来一次查询的接口变成 N 次。
       */
      profiles: buildFolderProfiles(db),
    };
  });

  app.post('/api/workbench/reset', async () => {
    resetWorkbench(db);
    log.event({ level: 'info', category: 'sync', message: '整理方案已还原' });
    return { ok: true };
  });

  /**
   * 「整理」—— 对勾选的夹子兑现成员关系。**纯本地计算**:不调 LLM、不花钱,
   * 它执行的是已经存在的规则与成员(spec §5)。
   * - AI 夹子 → reconcileAiFolder(精确对账,清出走安全网)
   * - 人类夹子 → applyRuleHitsToFolder(只加不清;没规则 = 跳过)
   */
  app.post('/api/workbench/tidy', async (req, reply) => {
    const { folderIds } = (req.body ?? {}) as { folderIds?: unknown };
    if (
      !Array.isArray(folderIds) ||
      folderIds.length === 0 ||
      folderIds.some((x) => !Number.isInteger(x))
    ) {
      return reply.code(400).send({ ok: false, reason: 'folderIds 必须是非空数字数组' });
    }
    const reconciled: { folderId: number; added: number; removed: number }[] = [];
    const ruleAdded: { folderId: number; added: number }[] = [];
    const skipped: string[] = [];
    for (const folderId of folderIds) {
      try {
        if (isAiFolderWork(db, folderId)) {
          reconciled.push({ folderId, ...reconcileAiFolder(db, folderId) });
        } else {
          const r = applyRuleHitsToFolder(db, folderId);
          if (r.added > 0) ruleAdded.push({ folderId, added: r.added });
          else skipped.push(String(folderId));
        }
      } catch (e) {
        skipped.push(`${folderId}: ${(e as Error).message}`);
      }
    }
    log.event({
      level: 'info',
      category: 'sync',
      message: `整理 ${folderIds.length} 个夹子:对账 ${reconciled.length} 个,规则补进 ${
        ruleAdded.reduce((s, r) => s + r.added, 0)
      } 条,跳过 ${skipped.length} 个`,
    });
    return { ok: true, reconciled, ruleAdded, skipped };
  });

  app.post('/api/workbench/folders', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ ok: false, reason: 'name 不能为空' });
    }
    try {
      return { ok: true, id: createFolder(db, name) };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  app.patch('/api/workbench/folders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string') {
      return reply.code(400).send({ ok: false, reason: 'name 必须是字符串' });
    }
    try {
      renameFolder(db, id, name);
      return { ok: true };
    } catch (e) {
      // 夹子不存在、名字为空、锁定的夹子改不了 —— 都由动作自己抛,这里只翻译
      return actionError(reply, e);
    }
  });

  app.delete('/api/workbench/folders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      deleteFolder(db, id);
      return { ok: true };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  /**
   * 把 fromIds 里的条目全搬进 :id,再把搬空了的源夹子删掉。
   *
   * 支持 N 个源:界面上的两个入口(夹子行的「合并」/ 顶栏的「移动并删除 N 个夹子」)
   * 都走这里 —— 一个动作两种入口,不发明新概念。
   */
  app.post('/api/workbench/folders/:id/merge', async (req, reply) => {
    const intoId = Number((req.params as { id: string }).id);
    const { fromIds } = (req.body ?? {}) as { fromIds?: unknown };
    if (!Array.isArray(fromIds) || fromIds.some((x) => typeof x !== 'number')) {
      return reply.code(400).send({ ok: false, reason: 'fromIds 必须是数字数组' });
    }
    try {
      const result = mergeFolders(db, fromIds as number[], intoId);
      return { ok: true, ...result };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  /**
   * move 和 add 共用一段参数校验:两者都是"把 itemIds 放进 toFolderId"的形状。
   * remove 的目标是 fromFolderId —— 语义不同,单独写(见下)。
   */
  /**
   * move / add 的公共外壳。源有两种给法,二选一:
   *
   * - `itemIds`    —— 展开夹子后勾的具体条目(细粒度)
   * - `fromFolderIds` —— **整个夹子**:把那几个夹子里的条目全算上(粗粒度)
   *
   * 后者在服务端一次展开成 itemIds,所以是**一次请求、一条日志** ——
   * 让前端逐个夹子去拉条目再拼,既多几十个来回,日志也会被拆成几十条。
   */
  const toFolderAction = (
    handler: (itemIds: string[], toFolderId: number) => void,
  ) => async (
    req: { body?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const body = (req.body ?? {}) as {
      itemIds?: unknown;
      fromFolderIds?: unknown;
      toFolderId?: number;
    };
    if (typeof body.toFolderId !== 'number') {
      return reply.code(400).send({ ok: false, reason: '缺少 toFolderId' });
    }

    if (Array.isArray(body.fromFolderIds)) {
      if (body.fromFolderIds.some((x) => typeof x !== 'number')) {
        return reply.code(400).send({ ok: false, reason: 'fromFolderIds 必须是数字数组' });
      }
      // 目标本身也在源里 = 自己移到自己,没有意义,直接拒掉比默默做一遍好
      if ((body.fromFolderIds as number[]).includes(body.toFolderId)) {
        return reply.code(400).send({ ok: false, reason: '目标夹子也在选中的夹子里' });
      }
    } else if (
      !Array.isArray(body.itemIds) ||
      !body.itemIds.every((x) => typeof x === 'string')
    ) {
      return reply
        .code(400)
        .send({ ok: false, reason: '要给出 itemIds(字符串数组)或 fromFolderIds(数字数组)' });
    }

    // 展开夹子要在 try 里面 —— "夹子不存在" 也得走 actionError 翻成 404,
    // 漏出去就是 500(actionError 的正则认那条例外消息)
    try {
      const itemIds = Array.isArray(body.fromFolderIds)
        ? (body.fromFolderIds as number[]).flatMap((fid) => {
            if (!listWorkFolders(db).some((f) => f.id === fid)) {
              throw new Error(`工作副本里没有夹子 ${fid}`);
            }
            return workItemIds(db, fid);
          })
        : (body.itemIds as string[]);

      handler(itemIds, body.toFolderId);
      return { ok: true, moved: itemIds.length };
    } catch (e) {
      return actionError(reply, e);
    }
  };

  app.post('/api/workbench/items/move', toFolderAction((ids, to) => moveItems(db, ids, to)));
  app.post('/api/workbench/items/add', toFolderAction((ids, to) => addItems(db, ids, to)));

  /** 移出:目标是从哪个夹子拿走,不是放进哪里 */
  app.post('/api/workbench/items/remove', async (req, reply) => {
    const body = (req.body ?? {}) as { itemIds?: unknown; fromFolderId?: number };
    if (!Array.isArray(body.itemIds) || body.itemIds.some((x) => typeof x !== 'string')) {
      return reply.code(400).send({ ok: false, reason: 'itemIds 必须是字符串数组' });
    }
    if (typeof body.fromFolderId !== 'number') {
      return reply.code(400).send({ ok: false, reason: '缺少 fromFolderId' });
    }
    try {
      removeItems(db, body.itemIds as string[], body.fromFolderId as number);
      return { ok: true };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  app.get('/api/workbench/log', async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 200) || 200;
    return { operations: listOperations(db, { limit }) };
  });

  /**
   * 工作副本口径的条目列表 —— 展开夹子用。
   *
   * 出口形状与 `/api/folders/:id/items` **逐字段相同**,前端复用同一套渲染与
   * 截断提示。取数口径不同:那边是快照(B站 现在的样子),这边是工作副本
   * ("你桌上这份")—— 行头显示的 itemCount 也是这个口径,展开和它必须对得上。
   *
   * 新建的夹子没有快照原点,但完全可能有条目(移动 / 也放进都会往里写),
   * 所以**不能**按"没有 originId 就当它空"处理。
   */
  app.get('/api/workbench/folders/:id/items', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!listWorkFolders(db).some((f) => f.id === id)) {
      return reply.code(404).send({ ok: false, reason: `工作副本里没有夹子 ${id}` });
    }
    const q = req.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const pageSize = Math.max(1, Number(q.pageSize ?? 500) || 500);

    const ids = workItemIdsPaged(db, id, { limit: pageSize, offset: (page - 1) * pageSize });
    // favTime 恒为 null:work_folder_items 不存收藏时间(那是快照的属性,
    // 由同步维护),这里只回答"这条在不在这个夹子里"
    const items = ids
      .map((iid) => getItem(db, iid))
      .filter((x): x is ItemRow => x !== undefined)
      .map((x) => shapeItem(x, null));
    return { items, total: workItemIds(db, id).length };
  });

  // ── 模型管理(spec §3)────────────────────────────────
  app.get('/api/settings/models', async (req) => {
    const provider = (req.query as { provider?: string }).provider;
    return { models: listModels(provider) };
  });

  /**
   * 本地 Ollama 已装的模型(spec §3:不入注册表,运行时拿真实值)。
   * 前端只在选到 Ollama 时才调它。
   */
  app.get('/api/settings/ollama-models', async (req, reply) => {
    const baseUrl = (req.query as { baseUrl?: string }).baseUrl ?? '';
    try {
      const models = await listOllamaModels(baseUrl, deps.ollamaFetchImpl ?? fetch);
      // 真实数字落地:readLlmSettings 对 ollama 条目优先读这里(spec §2:ollama 现有逻辑不变)
      const prev = ollamaMeta(db);
      for (const m of models) prev[m.name] = { contextWindow: m.contextWindow, maxOutput: m.maxOutput };
      setSetting(db, 'llm.ollama.meta', JSON.stringify(prev));
      return { models };
    } catch (e) {
      // **把实际试的地址写进 reason**:上一版只说"确认 Ollama 正在运行",而真实原因
      // 常常是 baseUrl 还留着别家的地址(实测:deepseek 的地址 → 401)。那句话会把
      // 用户引到完全错误的方向 —— 明明 Ollama 在跑,却让他去查 Ollama。
      let tried = baseUrl;
      try {
        tried = ollamaRoot(baseUrl);
      } catch {
        // 地址本身非法(assertUsableBaseUrl 抛的),原样显示更好定位
      }
      return reply
        .code(502)
        .send({ ok: false, reason: `连不上本地 Ollama(${tried}):${(e as Error)?.message ?? e}` });
    }
  });

  /**
   * 从厂商的 OpenAI 兼容端点拉模型列表(spec §3 的模型发现)。
   *
   * **只回名字 + 注册表里的数字** —— 那个接口只给 `{id, object, owned_by}`,没有任何
   * token 上限,所以数字只能查表、查不到就用兜底的估算值(前端给未确认的标 ⚠️)。
   *
   * 收**未保存**的 apiKey(和 test-llm 同一条规矩):留空表示"用已存的" ——
   * 这条很重要,因为设置页从来拿不到明文 key,首次配的时候只能靠用户在表单里填。
   * **key 走 body 不走 query**:query 会落进 events / api_calls。
   */
  app.post('/api/settings/remote-models', async (req, reply) => {
    const body = (req.body ?? {}) as { provider?: string; baseUrl?: string; apiKey?: string };
    if (!body.provider) return reply.code(400).send({ ok: false, reason: '先选服务商' });

    const saved = firstSavedApiKey(db);
    const apiKey = body.apiKey?.trim() || saved || '';
    try {
      const models = await listRemoteModels({
        provider: body.provider,
        baseUrl: body.baseUrl?.trim() ?? '',
        apiKey,
      });
      return { models };
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      // message 走 logger 的脱敏入口,即使上游把 key 拼进错误里也不会落明文(C9)
      log.event({ level: 'warn', category: 'llm', code: 'LIST_MODELS_FAILED', message });
      return reply.code(502).send({ ok: false, reason: message });
    }
  });

  // ── 模型管理:三层(凭证 / 条目 / 用途分配)──────────────
  // spec 2026-09-17-model-config-redesign。GET /api/settings/models(内置注册表)
  // 原样保留 —— 前端"厂商列表拉不到时退回内置表"靠它。

  app.get('/api/settings/providers', async () => {
    // **绝不回传 apiKey** —— 只回"有没有配"(沿用旧 /api/settings/llm 的规矩)
    return {
      providers: listProviders(db).map(({ id, provider, baseUrl, apiKeyEnc }) => ({
        id, provider, baseUrl, hasApiKey: apiKeyEnc !== '',
      })),
    };
  });

  app.put('/api/settings/providers', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string; provider: string; baseUrl?: string; apiKey?: string };
    try {
      const p = saveProvider(db, body);
      log.event({ level: 'info', category: 'llm', message: `服务商凭证已保存:${p.provider}` });
      return { ok: true, id: p.id };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.delete('/api/settings/providers/:id', async (req, reply) => {
    try {
      deleteProvider(db, (req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.get('/api/settings/entries', async () => {
    const providers = listProviders(db);
    const meta = ollamaMeta(db);
    return {
      entries: listEntries(db).map((e) => {
        const provider = providers.find((p) => p.id === e.providerId);
        // 数字服务端拼好 —— 前端不算,也不存(spec §2:条目不存数字)
        const ctx = provider
          ? (provider.provider === 'ollama' && meta[e.model]
            ? { ...getModelMeta(provider.provider, e.model), ...meta[e.model], verified: true }
            : getModelMeta(provider.provider, e.model))
          : getModelMeta('custom', e.model); // 凭证已删的脏数据:兜底显示
        return {
          id: e.id, providerId: e.providerId,
          provider: provider?.provider ?? '?',
          model: e.model,
          contextWindow: ctx.contextWindow, maxOutput: ctx.maxOutput,
          verified: ctx.verified, ...(ctx.note ? { note: ctx.note } : {}),
        };
      }),
    };
  });

  app.post('/api/settings/entries', async (req, reply) => {
    const body = (req.body ?? {}) as { providerId?: string; model?: string };
    try {
      const e = addEntry(db, { providerId: body.providerId ?? '', model: body.model ?? '' });
      log.event({ level: 'info', category: 'llm', message: `模型条目已添加:${e.model}` });
      return { ok: true, id: e.id };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.delete('/api/settings/entries/:id', async (req, reply) => {
    try {
      deleteEntry(db, (req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.get('/api/settings/assignments', async () => ({ assignments: getAssignments(db) }));

  app.put('/api/settings/assignments', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<Record<LlmPurpose, string | null>>;
    try {
      for (const purpose of PURPOSES) {
        if (body[purpose] !== undefined) setAssignment(db, purpose, body[purpose]!);
      }
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  /**
   * 测试连接。发一次最小请求验证配置能通。
   *
   * 请求参数**全程不落明文**(§6 红队加固):日志走 logger 的脱敏,
   * 而且这里刻意只记 provider/model,连 baseUrl 都不记。
   */
  app.post('/api/settings/test-llm', async (req, reply) => {
    const body = (req.body ?? {}) as {
      provider?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    };
    if (!body.provider || !body.model) {
      return reply.code(400).send({ ok: false, reason: '先选服务商和模型' });
    }

    // apiKey 留空表示"用已存的"
    const saved = firstSavedApiKey(db);
    const apiKey = body.apiKey?.trim() || saved || '';

    const meta: ModelMeta = getModelMeta(body.provider, body.model);
    try {
      const started = Date.now();
      const text = await complete({
        config: {
          id: body.model,
          provider: body.provider,
          baseUrl: body.baseUrl?.trim() ?? '',
          apiKey,
          model: body.model,
        },
        messages: [{ role: 'user', content: '回复两个字:可以' }],
        // 这条只问"通不通",开着思考模式用户要白等十几秒,还以为连不上
        thinking: false,
      });

      log.event({
        level: 'info',
        category: 'llm',
        message: `测试连接成功:${body.provider}/${body.model}(${Date.now() - started}ms)`,
      });
      return { ok: true, reply: text.slice(0, 100), contextWindow: meta.contextWindow, maxOutput: meta.maxOutput };
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      // message 走 logger 的脱敏入口,即使 SDK 把 key 拼进错误里也不会落明文
      log.event({ level: 'warn', category: 'llm', code: 'LLM_TEST_FAILED', message });
      return reply.code(502).send({ ok: false, reason: message });
    }
  });

}
