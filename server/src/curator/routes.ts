/**
 * /api/curator/* 与 /api/settings/*(模型管理)的路由(spec §9.0 流程 + §3 模型管理)。
 *
 * 沿用 M3 的 registerXxxRoutes(app, deps) 模式:路由只做 HTTP 层,
 * 编排在 curator/ 里,存储走 db/repo/。
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import {
  newSession,
  listSessions,
  getSession,
  getMessages,
  archiveSession,
  upsertDraft,
  getLatestDraft,
  type FolderSpec,
} from '../db/repo/sessions.js';
import {
  saveClassification,
  getClassification,
  deleteClassification,
  type Assignment,
} from '../db/repo/classifications.js';
import { listFolders, isLockedFolder } from '../db/repo/folders.js';
import { listRules } from '../db/repo/rules.js';
import { getItem, type ItemRow } from '../db/repo/items.js';
// 条目出口形状与 /api/folders/:id/items 共用同一份 —— 前端用同一套渲染,
// 分两份写迟早会分叉
import { shapeItem } from '../http/routes/items.js';
import {
  readLlmSettings, type LlmPurpose, PURPOSES,
  listProviders, saveProvider, deleteProvider,
  listEntries, addEntry, deleteEntry,
  getAssignments, setAssignment, ollamaMeta,
} from '../llm/config.js';
import { logOperation, listOperations } from '../db/repo/operations.js';
import { listModels, getModelMeta, type ModelMeta } from '../llm/registry.js';
import { listOllamaModels, ollamaRoot } from '../llm/ollama.js';
import { listRemoteModels } from '../llm/models.js';
import { batchSize } from '../llm/context.js';
import { complete } from '../llm/provider.js';
import { chatStream, buildContext } from './chat.js';
import {
  runPass1,
  runPass2,
  TaxonomyValidationError,
  describeReport,
  type FolderLite,
} from './classifier.js';
import { matchAll, renderConditions, type ValidSuggestion } from './rules.js';
import { runSuggestions, suggestionInput } from './suggestions.js';
import { buildReorganizeAudit, saveAudit, listAudits } from './audit.js';
import { buildWorkbenchView } from '../db/repo/workbenchView.js';
import {
  getWorkState, listWorkFolders, workItemIds, workItemIdsPaged,
} from '../db/repo/workbench.js';
import { getState, setSetting, stateKey } from '../db/repo/state.js';
import {
  renameFolder, createFolder, deleteFolder, mergeFolders,
  moveItems, addItems, removeItems, resetWorkbench, assignItems,
} from './workbench.js';

export interface CuratorDeps {
  db: Database.Database;
  log: Logger;
  /** 注入点:Ollama 模型发现的 fetch(测试用假的,别真去连本机 Ollama) */
  ollamaFetchImpl?: typeof fetch;
}

/** 会话摘要 —— 列表只给一句话,不加载全部消息(spec §9.0) */
function shapeSession(s: {
  id: number;
  title: string | null;
  preview: string | null;
  status: string | null;
  updated_at: number | null;
}) {
  return {
    id: s.id,
    title: s.title,
    preview: s.preview,
    status: s.status,
    updatedAt: s.updated_at,
  };
}

function existingFolders(db: Database.Database): FolderLite[] {
  // 带上 locked —— Pass 1 的校验要靠它拦「把默认收藏夹改名」这种做不到的方案
  return listFolders(db).map((f) => ({
    id: f.id,
    name: f.title,
    locked: isLockedFolder(db, f),
  }));
}

export function registerCuratorRoutes(app: FastifyInstance, deps: CuratorDeps): void {
  const { db, log } = deps;

  /** 取当前模型配置;没配过就回 400 并给一句人话。purpose:这段路由属于哪个用途 */
  const requireLlm = (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    purpose: LlmPurpose = 'chat',
  ) => {
    const llm = readLlmSettings(db, purpose);
    if (!llm) {
      reply.code(400).send({ ok: false, reason: '还没配模型 —— 先去「授权」页的模型管理里选一个' });
      return null;
    }
    return llm;
  };

  // ── 会话 ──────────────────────────────────────────────
  app.post('/api/curator/sessions', async (req) => {
    const { title } = (req.body ?? {}) as { title?: string };
    const id = newSession(db, title?.trim() || `整理文件夹 ${new Date().toLocaleDateString('zh-CN')}`);
    return { id };
  });

  app.get('/api/curator/sessions', async () => {
    return { sessions: listSessions(db).map(shapeSession) };
  });

  app.get('/api/curator/sessions/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const session = getSession(db, id);
    if (!session) return reply.code(404).send({ ok: false, reason: '会话不存在' });

    const classification = getClassification(db, id);
    return {
      session: shapeSession(session),
      messages: getMessages(db, id).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        ts: m.ts,
      })),
      draft: getLatestDraft(db, id),
      classification: classification
        ? { assignments: classification.assignments, failed: classification.failed }
        : null,
    };
  });

  app.delete('/api/curator/sessions/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getSession(db, id)) return reply.code(404).send({ ok: false, reason: '会话不存在' });
    archiveSession(db, id);
    return { ok: true };
  });

  // 发消息 —— SSE 流式。**先校验再 hijack**,接管之后就没法再回 4xx 了
  app.post('/api/curator/sessions/:id/messages', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { content } = (req.body ?? {}) as { content?: string };

    if (!getSession(db, id)) return reply.code(404).send({ ok: false, reason: '会话不存在' });
    if (typeof content !== 'string' || !content.trim()) {
      return reply.code(400).send({ ok: false, reason: '消息不能为空' });
    }
    const llm = requireLlm(reply);
    if (!llm) return;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 客户端断开(点停止 / 关页面 / 换会话)→ abort —— provider 也真的停下来,
    // 不再是"钱花了、结果没人接"(§9D B2)。中止时 chatStream **不抛**而是把
    // 半截(带 `(已中断)` 标注)返回,所以这条路照常走到下面的 done 帧
    //
    // **不能听 req.raw 的 'close'** —— Node ≥16 里它表示"请求体读完了",不是"客户端走了":
    // JSON body 会被 Fastify 在进 handler 之前消费掉,那条 close 在第一个 tick 就触发,
    // 把刚建好的 controller 直接 abort 掉 —— 聊天每一条都当场自尽(真机 socket 复现过)。
    // 断开要看**响应**:我们自己正常收尾(writableEnded)之外的 close 才是客户端真的走了。
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    try {
      const full = await chatStream({
        db,
        sessionId: id,
        config: llm.config,
        ctx: llm.ctx,
        userMessage: content,
        onChunk: (delta) => reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`),
        // 思考过程单独一帧 —— 前端折叠显示,不混进正文(§9D.5)
        onReasoning: (delta) =>
          reply.raw.write(`event: reasoning\ndata: ${JSON.stringify({ delta })}\n\n`),
        signal: controller.signal,
      });
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ content: full })}\n\n`);
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      log.event({ level: 'error', category: 'llm', code: 'LLM_CHAT_FAILED', message });
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ reason: message })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  // ── 草稿 ──────────────────────────────────────────────
  app.get('/api/curator/sessions/:id/draft', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getSession(db, id)) return reply.code(404).send({ ok: false, reason: '会话不存在' });
    return { draft: getLatestDraft(db, id) };
  });

  app.put('/api/curator/sessions/:id/draft', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getSession(db, id)) return reply.code(404).send({ ok: false, reason: '会话不存在' });

    const { folders, constraints } = (req.body ?? {}) as {
      folders?: FolderSpec[];
      constraints?: string;
    };
    if (!Array.isArray(folders)) {
      return reply.code(400).send({ ok: false, reason: 'folders 必须是数组' });
    }
    // tempId 是 Pass 2 的引用键,缺了后面全对不上
    const bad = folders.find((f) => !f?.tempId || !f?.name);
    if (bad) return reply.code(400).send({ ok: false, reason: '每个夹子都要有 tempId 和 name' });

    upsertDraft(db, id, folders, constraints);
    return { ok: true, draft: getLatestDraft(db, id) };
  });

  /**
   * 丢掉归类结果。撤回方案时和草稿一起清 ——
   * 只清草稿的话,下次打开会话结果又冒出来,而草稿已经空了。
   */
  app.delete('/api/curator/sessions/:id/classification', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getSession(db, id)) return reply.code(404).send({ ok: false, reason: '会话不存在' });
    deleteClassification(db, id);
    return { ok: true };
  });

  // ── Pass 1 / Pass 2 ───────────────────────────────────
  app.post('/api/curator/sessions/:id/run-pass-1', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getSession(db, id)) return reply.code(404).send({ ok: false, reason: '会话不存在' });

    const llm = requireLlm(reply, 'classify');
    if (!llm) return;

    const { constraint } = (req.body ?? {}) as { constraint?: string };
    const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
    if (items.length === 0) {
      return reply.code(400).send({ ok: false, reason: '本地还没有收藏数据 —— 先去「总览」触发一次同步' });
    }

    try {
      const result = await runPass1({
        config: llm.config,
        existingFolders: existingFolders(db),
        items,
        ...(constraint?.trim() ? { userConstraint: constraint.trim() } : {}),
      });

      // 体系落草稿 —— 用户在聊天窗里的后续编辑也写这里(§9.0)
      upsertDraft(db, id, result.taxonomy.folders, constraint?.trim());

      log.event({
        level: 'info',
        category: 'llm',
        message: `Pass 1 完成:${result.taxonomy.folders.length} 个夹子(样本 ${result.sample.length} 条)`,
      });

      return {
        taxonomy: result.taxonomy,
        // 警告项 —— UI 要显式问「这些夹子 AI 没用,你确认放弃吗」
        warnings: describeReport(result.validation, existingFolders(db)),
        validation: result.validation,
        sampleSize: result.sample.length,
        keywordStats: {
          matched: result.keywordStats.matched,
          unmatched: result.keywordStats.unmatched,
        },
        batchSize: batchSize(llm.ctx),
      };
    } catch (e) {
      if (e instanceof TaxonomyValidationError) {
        log.event({
          level: 'warn',
          category: 'llm',
          code: 'PASS1_VALIDATION_FAILED',
          message: e.message,
        });
        // Pass 2 已阻止启动 —— 把具体问题回给 UI(§9.1.1)
        return reply.code(400).send({
          ok: false,
          reason: e.message,
          problems: describeReport(e.report, existingFolders(db)),
          validation: e.report,
        });
      }
      const message = (e as Error)?.message ?? String(e);
      log.event({ level: 'error', category: 'llm', code: 'PASS1_FAILED', message });
      return reply.code(502).send({ ok: false, reason: message });
    }
  });

  app.post('/api/curator/sessions/:id/run-pass-2', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getSession(db, id)) return reply.code(404).send({ ok: false, reason: '会话不存在' });

    const llm = requireLlm(reply, 'classify');
    if (!llm) return;

    // 体系就是**工作副本本身** —— m4b 取消了会话级的草稿(W3),
    // 所以这里不该再去读 taxonomy_draft(那已经是死路,没人写了)。
    //
    // tempId 直接用工作夹子 id 的字符串形式:这样 Pass 2 吐出来的 folderTempId
    // 就是**工作夹子 id 本身**,apply 不用再做任何映射 —— 少一层会出错的翻译。
    const work = listWorkFolders(db);
    if (work.length === 0) {
      return reply.code(400).send({
        ok: false,
        reason: '还没有结构可以归类 —— 先去「整理」页建几个夹子,或者手动改一版',
      });
    }
    const rules = listRules(db);
    const ruleOf = new Map(rules.map((r) => [r.folderId, r]));

    const folders: FolderSpec[] = work.map((w) => ({
      tempId: String(w.id),
      name: w.name,
      description: '',
      // **规则终于用在了它该用的地方** —— 这个字段从 spec §9.1 起就写着
      // "判定规则,必须可执行",而 m4b 之后一直是空串,于是模型只能看名字瞎猜。
      rule: renderConditions(ruleOf.get(w.id)?.conditions ?? []),
      estCount: workItemIds(db, w.id).length,
      // 不带 reuseFolderId:buildPass2Prompt 只读 tempId/name/rule,这个字段到不了模型
    }));

    // 没规则的夹子给模型几条已有标题 —— 只看名字它会自信地猜错(真机验证过,§9C.0)
    //
    // 判的是**渲染出来的规则是不是空的**,不是"有没有规则行":界面上「新增规则」
    // 建出来就是 `[{ field: 'title', any: [] }]` 这个形状,而它渲染成空串
    // (见 renderConditions)。那种夹子既匹配不到任何条目、也不该因此失去样本标题
    // —— 否则模型看到的是一个**光秃秃的名字**,比完全没规则还糟。
    const renderedRule = new Map(folders.map((f) => [Number(f.tempId), f.rule]));
    const samples = new Map<number, string[]>();
    for (const w of work) {
      if (renderedRule.get(w.id)) continue;
      const titles = workItemIds(db, w.id)
        .slice(0, 3)
        .map((iid) => getItem(db, iid)?.title)
        .filter((t): t is string => !!t);
      if (titles.length) samples.set(w.id, titles);
    }

    const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];

    // ── ① 规则先跑:0 token、确定性 ───────────────────────
    // 匹配置信度给 1 —— 规则命中是"确定"不是"猜",和 AI 的 0.9 不是同一种东西
    const matched = matchAll(
      items.map((i) => ({ id: i.id, title: i.title, intro: i.intro, upperName: i.upper_name })),
      rules,
    );
    const ruleAssignments: Assignment[] = [];
    for (const [itemId, hits] of matched) {
      for (const hit of hits) {
        ruleAssignments.push({
          itemId,
          folderTempId: String(hit.folderId),
          confidence: 1,
          reason: `规则命中:${hit.tokens.map((t) => t.token).join('、')}`,
        });
      }
    }
    // **规则命中的条目根本不进 AI 的输入** —— R4b"两组条目不相交"就落在这里
    const rest = items.filter((i) => !matched.has(i.id));

    log.event({
      level: 'info',
      category: 'llm',
      message: `规则先跑:${items.length - rest.length} 条命中规则,剩 ${rest.length} 条交给 AI`,
    });

    // ── 应答改成 SSE(§9D A1)──────────────────────────────
    // hijack 之后只能写 SSE 帧 —— 所以会话/llm/work 三个校验都在**上面**做完了
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    /** 客户端还在吗 —— 断了就别再写了(连接没了,写了也是丢) */
    const closed = () => reply.raw.writableEnded || reply.raw.destroyed;
    // **不能听 req.raw 的 'close'** —— Node ≥16 里它表示"请求体读完了",不是"客户端走了":
    // JSON body 会被 Fastify 在进 handler 之前消费掉,那条 close 在第一个 tick 就触发,
    // 把刚建好的 controller 直接 abort 掉 —— 归类这条路靠前端不带 content-type 逃过一劫,
    // 但同样的接线不该靠"恰好没 body"活着(§9D B5 的中止也会因此形同虚设)。
    // 断开要看**响应**:我们自己正常收尾(writableEnded)之外的 close 才是客户端真的走了。
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    /** 中断收尾:记 warn(不是故障) + 尽力回一帧(连接在就回)。§9D B5 */
    const finishAborted = () => {
      log.event({
        level: 'warn',
        category: 'llm',
        code: 'PASS2_ABORTED',
        message: '用户中止了归类 —— 已完成的批次已保留',
      });
      if (!closed()) reply.raw.write(`event: aborted\ndata: {"reason":"已中止"}\n\n`);
    };

    try {
      // 规则接走的先落一次 —— 中断时它们也得留下(§9D A3)
      if (ruleAssignments.length > 0) saveClassification(db, id, ruleAssignments, []);

      // ── ② 剩下的才给 AI ─────────────────────────────────
      const collected: Assignment[] = [];
      const result = rest.length
        ? await runPass2({
            config: llm.config,
            ctx: llm.ctx,
            folders,
            items: rest,
            samples,
            signal: controller.signal,
            onBatch: (b) => {
              collected.push(...b.assignments);
              // **每批落库一次**(§9D A3):upsert,最后一版就是完整结果。
              // failedBatches 用本批的累计值 —— 收尾还会再补一次带全部失败批次的最终版
              saveClassification(db, id, [...ruleAssignments, ...collected], [...b.failedBatches]);
              if (closed()) return; // 连接没了,帧发不出去,但结果照落
              reply.raw.write(
                `event: progress\ndata: ${JSON.stringify({
                  batch: b.batch,
                  batches: b.batches,
                  done: b.done,
                  total: b.total,
                  // 用**条目数**口径,和 done 帧的 ruleCount 一致 —— 用
                  // ruleAssignments.length(条目×命中对)会算成另一个数,
                  // 于是进度条跑到一半、结束时数字突然缩水
                  ruleCount: items.length - rest.length,
                })}\n\n`,
              );
            },
          })
        : { assignments: [], failedBatches: [] };

      // §9D B5:主动中断是用户行为,不是故障。runPass2 中止时**不抛**而是原样返回
      // 已完成的批次 —— 所以这里也要认一次;已完成的批次已在 onBatch 里落库,
      // 不再补最终版(补了就是把没跑的批次当成"结果"),也不跑建议
      if (controller.signal.aborted) {
        finishAborted();
        return;
      }
      if (closed()) return; // 客户端已断 —— 不用再写 done,连接没了

      const assignments = [...ruleAssignments, ...result.assignments];
      saveClassification(db, id, assignments, result.failedBatches); // 最终版(带 failedBatches)

      // ── ③ 建议:AI 的第二个通道(spec §9C.5 b/c)────────────
      // **单独一次调用**,而且只在"真的有条目没归上"时才付费(那道闸在
      // runSuggestions 里:homelessIds 为空集就直接返回)。失败不影响归类结果 ——
      // 建议是锦上添花,不该把已经跑通的那条路拖垮。
      const input = suggestionInput(db);
      const homelessIds = new Set(
        result.assignments.filter((a) => a.folderTempId === null).map((a) => a.itemId),
      );
      const suggestions: ValidSuggestion[] = await runSuggestions({
        config: llm.config,
        folders: input.folders,
        pool: input.pool,
        homelessIds,
        cap: batchSize(llm.ctx),
        allItems: input.allItems,
      }).catch((e: unknown) => {
        log.event({
          level: 'warn',
          category: 'llm',
          code: 'SUGGEST_FAILED',
          message: (e as Error)?.message ?? String(e),
        });
        return [] as ValidSuggestion[];
      });

      if (suggestions.length > 0) {
        log.event({
          level: 'info',
          category: 'llm',
          message: `规则建议:${homelessIds.size} 条没归上,提出 ${suggestions.length} 条建议`,
        });
      }

      log.event({
        level: 'info',
        category: 'llm',
        message: `Pass 2 完成:规则 ${ruleAssignments.length} 条 + AI ${result.assignments.length} 条,${
          result.failedBatches.length
        } 批失败`,
      });

      // 建议是异步的,期间客户端可能又断了 —— 发 done 前再确认一次
      if (closed()) return;
      // done 帧的 data 与旧一次性 JSON **逐字段相同** —— 前端在类型层看不出传输变了
      reply.raw.write(
        `event: done\ndata: ${JSON.stringify({
          assignments,
          failedBatches: result.failedBatches,
          total: items.length,
          /** 分栏要如实 —— 哪些是规则归的、哪些是 AI 归的(spec §9C.3 ③) */
          ruleCount: items.length - rest.length,
          aiCount: result.assignments.filter((a) => a.folderTempId !== null).length,
          /** 建议**不落库** —— 随结果回,刷新就没了(spec §9C.5) */
          suggestions,
          batchSize: batchSize(llm.ctx),
        })}\n\n`,
      );
    } catch (e) {
      if (controller.signal.aborted) {
        finishAborted();
      } else {
        const message = (e as Error)?.message ?? String(e);
        log.event({ level: 'error', category: 'llm', code: 'PASS2_FAILED', message });
        if (!closed()) reply.raw.write(`event: error\ndata: ${JSON.stringify({ reason: message })}\n\n`);
      }
    } finally {
      reply.raw.end();
    }
  });

  /**
   * 把 AI 的归类提案应用到工作副本。
   *
   * 应用产生的就是普通的 move_items,只是 actor='ai' —— 这是 W7 的落实:
   * 同样的标记、同样的日志、同样被还原覆盖。
   *
   * **不需要 mapping**:Step 1 让 Pass 2 用工作夹子 id 当 tempId,
   * 所以 `folderTempId` 本身就是工作夹子 id。少一层翻译就少一处出错的地方。
   *
   * **两阶段**:生成提案之后你又手改过时,默认**先不覆盖** —— 回 409 把
   * 「哪几处会被覆盖」列出来,你点「继续」再带 `force: true` 重来。
   * 静默覆盖是最糟的一种:你以为自己改的还在(spec §9B.4 是"应用**前**告诉我是哪几处")。
   */
  app.post('/api/curator/sessions/:id/apply', async (req, reply) => {
    const sessionId = Number((req.params as { id: string }).id);
    if (!getSession(db, sessionId)) return reply.code(404).send({ ok: false, reason: '会话不存在' });

    const { force } = (req.body ?? {}) as { force?: boolean };

    const stored = getClassification(db, sessionId);
    if (!stored || stored.assignments.length === 0) {
      return reply.code(400).send({ ok: false, reason: '这个会话还没有归类提案' });
    }

    // 提案生成之后有没有新的**用户**改动?有就说明你在生成期间手改过。
    //
    // 冲突检查要看到**全部**手改,不能被默认的 limit:200 截断 —— 截断后文案里的
    // "N 处"就少算了,而用户正是据此判断要不要覆盖。上限给到 10000 是兜底:
    // 真到那个量级,这条路径本身已经不是瓶颈了。
    const touched = listOperations(db, { sinceTs: stored.updatedAt, limit: 10_000 }).filter(
      (e) => e.actor === 'user',
    );
    if (touched.length > 0 && force !== true) {
      return reply.code(409).send({
        ok: false,
        reason:
          `你在 AI 归类期间手改过 ${touched.length} 处,继续应用会覆盖它们:\n` +
          touched.slice(0, 5).map((e) => `· ${e.summary}`).join('\n') +
          (touched.length > 5 ? `\n· …还有 ${touched.length - 5} 处` : ''),
        conflicts: touched.map((e) => ({ id: e.id, ts: e.ts, summary: e.summary })),
      });
    }

    // **按"目标夹子集合"分组,而不是按单个夹子** —— 一条条目可以同时归进多个夹子
    // (规则命中的都归,R4)。按单个夹子分组会把它拆成多次调用,而每次 assignItems
    // 都会先清空该条目的归属,后一次会把前一次删掉。
    const targetOf = new Map<string, number[]>();
    // AI 拿不准的条目(folderTempId === null)**原地不动** —— 这些必须单列出来。
    // 生成侧的提示词明确写着"拿不准就填 null",整批失败也是 null,所以这是常态
    // 而不是异常。既不算 applied 也不算 skipped 的话,接口会回一句"全部成功",
    // 而用户被告知归类完成、实际有一批还停在手工整理前的归属上,完全不知道。
    let unclassified = 0;
    for (const a of stored.assignments) {
      if (a.folderTempId === null) {
        unclassified += 1;
        continue;
      }
      const folderId = Number(a.folderTempId);
      if (!Number.isInteger(folderId)) continue; // 编出来的 id 丢掉
      const list = targetOf.get(a.itemId);
      if (list) {
        if (!list.includes(folderId)) list.push(folderId);
      } else {
        targetOf.set(a.itemId, [folderId]);
      }
    }

    // 目标集合相同的条目合成一次调用 —— 一次操作一条日志
    const byTargetSet = new Map<string, string[]>();
    for (const [itemId, folderIds] of targetOf) {
      const key = [...folderIds].sort((x, y) => x - y).join(',');
      const list = byTargetSet.get(key);
      if (list) list.push(itemId);
      else byTargetSet.set(key, [itemId]);
    }

    let applied = 0;
    let skipped = 0;
    for (const [key, itemIds] of byTargetSet) {
      const folderIds = key.split(',').map(Number);
      try {
        assignItems(db, itemIds, folderIds, { actor: 'ai', sessionId });
        applied += itemIds.length;
      } catch {
        // 目标夹子可能在你手改时被删了 —— 跳过这批,其余照常
        skipped += itemIds.length;
      }
    }

    // 说清"落到几个夹子"—— applied 和 targetOf.size 都是**条目**数,放一起读不通
    const landedFolders = new Set([...targetOf.values()].flat()).size;
    log.event({
      level: 'info',
      category: 'llm',
      message: `应用 AI 结论:${applied} 条落到 ${landedFolders} 个夹子,跳过 ${skipped} 条,` +
        `未归类 ${unclassified} 条`,
    });
    // overwritten 是**日志条数**,不是条目数:一次操作只留一行(W6 —— 留痕记的是
    // 决策),而一行可能对应一次拖了 412 条的操作。文案别让用户以为是"412 处"。
    return { ok: true, applied, skipped, unclassified, overwritten: touched.length };
  });

  // ── 审计报告 ──────────────────────────────────────────
  app.post('/api/curator/audit/reorganize', async (req, reply) => {
    const { sessionId } = (req.body ?? {}) as { sessionId?: number };
    if (typeof sessionId !== 'number') {
      return reply.code(400).send({ ok: false, reason: '缺少 sessionId' });
    }
    const audit = buildReorganizeAudit(db, sessionId);
    if (!audit) {
      return reply.code(400).send({ ok: false, reason: '还没有体系草稿,没有可对比的整理方案' });
    }
    const auditId = saveAudit(db, audit);
    log.event({ level: 'info', category: 'sync', message: `生成整理审计报告 #${auditId}` });
    return { id: auditId, report: audit };
  });

  app.get('/api/curator/audit', async (req) => {
    const kind = (req.query as { kind?: string }).kind;
    const audits = listAudits(db).filter((a) => !kind || a.kind === kind);
    return { audits };
  });

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
    };
  });

  app.post('/api/workbench/reset', async () => {
    resetWorkbench(db);
    log.event({ level: 'info', category: 'sync', message: '整理方案已还原' });
    return { ok: true };
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
   * 新建的夹子没有快照原点,但完全可能有条目(移动 / 也放进 / AI 应用都会往里写),
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

    const saved = readLlmSettings(db, 'chat');
    const apiKey = body.apiKey?.trim() || saved?.config.apiKey || '';
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
    const saved = readLlmSettings(db, 'chat');
    const apiKey = body.apiKey?.trim() || saved?.config.apiKey || '';

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

  // 只读:给 UI 预览"这一轮要发给模型什么"(不含 apiKey)
  app.get('/api/curator/sessions/:id/context', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getSession(db, id)) return reply.code(404).send({ ok: false, reason: '会话不存在' });
    const llm = readLlmSettings(db, 'chat');
    if (!llm) return reply.code(400).send({ ok: false, reason: '还没配模型' });

    const { messages, hasStructure } = buildContext(db, id, llm.ctx);
    return { messages, hasStructure, batchSize: batchSize(llm.ctx) };
  });
}
