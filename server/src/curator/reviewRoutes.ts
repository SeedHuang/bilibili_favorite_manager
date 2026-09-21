// server/src/curator/reviewRoutes.ts
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import { complete } from '../llm/provider.js';
import { readLlmSettings } from '../llm/config.js';
import { parseLooseJson } from './parse.js';
import { buildReviewPrompt, validateReviewDrafts, type ReviewCtx } from './review.js';
import { buildFolderProfiles } from './folderProfile.js';
import { listAiFolderIds } from '../db/repo/aiFolders.js';
import { listWorkFolders } from '../db/repo/workbench.js';
import { isLockedFolder, listFolders } from '../db/repo/folders.js';
import type { ItemRow } from '../db/repo/items.js';
import { toRuleItem } from './rules.js';
import {
  listReviewDrafts, saveReviewDrafts, setReviewDraftStatus,
  clearPendingReviewDrafts, type ReviewDraftInput,
} from '../db/repo/reviews.js';
import { mergeFolders, deleteFolder } from './workbench.js';
import { getRule, saveRule } from '../db/repo/rules.js';

export const REVIEW_TIMEOUT_MS = 300_000;
export const reviewRun = { running: false, logs: [] as { ts: number; level: 'info' | 'warn' | 'error'; text: string }[] };
let currentController: AbortController | null = null;
const pushLog = (level: 'info' | 'warn' | 'error', text: string) => {
  reviewRun.logs.push({ ts: Date.now(), level, text });
};

/**
 * 一轮审查。try/finally 照 proposal.ts runGeneration 的结构:
 * running 置位后任何一步抛错都得走 finally 复位,不然卡"进行中"是死状态。
 * 审查没有"方案头"表,运行态全在 reviewRun 内存里(abort 端点只查 running)。
 */
async function runReview(
  db: Database.Database,
  log: Logger,
  folderIds: number[],
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const t0 = Date.now();
  reviewRun.running = true;
  reviewRun.logs = [];
  pushLog('info', `开始审查 ${folderIds.length} 个夹子`);
  console.log(`[reviews] run 开始 夹子=${folderIds.length}`);
  try {
    const llm = readLlmSettings(db, 'proposals');
    if (!llm) { // 路由已拦,这里兜底(异步路径里没人接 400)
      log.event({ level: 'error', category: 'llm', code: 'REVIEW_NO_LLM', message: '审查时模型配置消失' });
      pushLog('error', '审查时模型配置消失');
      console.log('[reviews] 模型配置消失,回 idle');
      return;
    }
    const profiles = buildFolderProfiles(db).filter((p) => folderIds.includes(p.folderId));
    const prompt = buildReviewPrompt({ profiles, aiIds: listAiFolderIds(db) });
    const raw = await complete({
      config: llm.config,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      thinking: false,
      timeoutMs: REVIEW_TIMEOUT_MS,
      maxOutputTokens: llm.ctx.maxOutput,
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    });
    console.log(`[reviews] 模型返回 耗时=${Date.now() - t0}ms 原始长度=${raw.length}`);

    const ctx: ReviewCtx = {
      validFolderIds: new Set(listWorkFolders(db).map((w) => w.id)),
      aiIds: listAiFolderIds(db),
      // lockedIds 必须和 validFolderIds 同一套 **工作副本** id:锁定跟着原点夹子走,
      // 但 id 空间不能拿快照的(id 只在巧合时对齐,reviewRoutes.test.ts 明确不许做自增序假设)
      lockedIds: new Set(
        listWorkFolders(db)
          .filter((w) => {
            const origin = w.originId === null
              ? undefined
              : listFolders(db).find((f) => f.id === w.originId);
            return origin !== undefined && isLockedFolder(db, origin);
          })
          .map((w) => w.id),
      ),
      itemsById: new Map((db.prepare(`SELECT * FROM items`).all() as ItemRow[]).map((i) => [i.id, toRuleItem(i)])),
    };
    const v = validateReviewDrafts(parseLooseJson(raw), ctx);
    for (const r of v.rejects) {
      pushLog('warn', `丢掉草稿:${r.label} — ${r.why}`);
    }
    saveReviewDrafts(db, v.drafts.map((d): ReviewDraftInput => (
      d.kind === 'rule'
        ? { kind: 'rule', folderId: d.folderId, conditions: [{ field: d.field, any: d.any }], because: d.because }
        : d.kind === 'merge'
          ? { kind: 'merge', folderId: d.fromId, intoId: d.intoId, because: d.because }
          : { kind: 'delete', folderId: d.folderId, because: d.because }
    )));

    const done = `审查完成:${v.drafts.length} 条草稿`
      + (v.rejects.length ? `,丢掉 ${v.rejects.length} 条` : '');
    log.event({ level: 'info', category: 'llm', code: 'REVIEW_READY', message: done });
    pushLog('info', done);
    console.log(`[reviews] run 结束 草稿=${v.drafts.length} 丢=${v.rejects.length} 耗时=${Date.now() - t0}ms`);
  } catch (e) {
    // 中止不是故障:记 warn(草稿在 clearPendingReviewDrafts 已清,新一轮重跑即可)
    if (opts.signal?.aborted) {
      const abortedMessage = '已中止';
      pushLog('warn', abortedMessage);
      log.event({ level: 'warn', category: 'llm', code: 'REVIEW_ABORTED', message: abortedMessage });
      console.log(`[reviews] run 被中止 耗时=${Date.now() - t0}ms`);
    } else {
      const message = (e as Error)?.message ?? String(e);
      log.event({ level: 'error', category: 'llm', code: 'REVIEW_FAILED', message });
      pushLog('error', message);
      console.log(`[reviews] run 失败 耗时=${Date.now() - t0}ms 错误=${message}`);
    }
  } finally {
    reviewRun.running = false;
  }
}

export function registerReviewRoutes(app: FastifyInstance, deps: { db: Database.Database; log: Logger }): void {
  const { db, log } = deps;

  app.post('/api/reviews/generate', async (req, reply) => {
    const body = (req.body ?? {}) as { folderIds?: unknown };
    const folderIds = body.folderIds;
    const workIds = new Set(listWorkFolders(db).map((w) => w.id));
    // 校验顺序:先 folderIds 再查模型 —— folderIds 非法时先报它
    if (
      !Array.isArray(folderIds) || folderIds.length === 0
      || !folderIds.every((x) => Number.isInteger(x))
      || !folderIds.every((x) => workIds.has(x as number))
    ) {
      return reply.code(400).send({ ok: false, reason: 'folderIds 必须是非空数字数组,且都在工作副本里' });
    }
    if (!readLlmSettings(db, 'proposals')) {
      return reply.code(400).send({ ok: false, reason: '还没配模型 —— 先去「授权」页的模型管理里选一个' });
    }
    if (reviewRun.running) {
      return reply.code(409).send({ ok: false, reason: '上一轮审查还在进行' });
    }
    // 先清掉这批夹子的旧 pending 草稿(新一轮审查开始),异步跑;**不 await**
    clearPendingReviewDrafts(db, folderIds as number[]);
    const controller = new AbortController();
    currentController = controller;
    void runReview(db, log, folderIds as number[], { signal: controller.signal });
    return reply.code(202).send({ ok: true });
  });

  // 中止:未在跑 → 409(review 没有落库 generating,不需要僵尸态解锁)
  app.post('/api/reviews/abort', async (_req, reply) => {
    if (!reviewRun.running || !currentController) {
      return reply.code(409).send({ ok: false, reason: '没有正在进行的审查' });
    }
    currentController.abort();
    return { ok: true };
  });

  app.get('/api/reviews/current', async () => {
    const nameOf = new Map(listWorkFolders(db).map((f) => [f.id, f.name]));
    const drafts = listReviewDrafts(db).map((d) => ({
      id: d.id,
      kind: d.kind,
      folderId: d.folderId,
      folderName: nameOf.get(d.folderId) ?? '',
      intoId: d.intoId ?? null,
      intoName: d.intoId != null ? (nameOf.get(d.intoId) ?? '') : null,
      conditions: d.conditions,
      because: d.because,
      status: d.status,
      createdAt: d.createdAt,
    }));
    return { running: reviewRun.running, logs: reviewRun.logs, drafts };
  });

  /** 采纳一条草稿:按 kind 分派(追加规则 / 合并 / 删除) */
  app.post('/api/reviews/adopt', async (req, reply) => {
    const { draftId } = (req.body ?? {}) as { draftId?: unknown };
    const id = Number(draftId);
    const draft = listReviewDrafts(db).find((d) => d.id === id);
    if (!draft || draft.status !== 'pending') {
      return reply.code(404).send({ ok: false, reason: '草稿不存在或已处理' });
    }
    try {
      if (draft.kind === 'rule') {
        // 追加条件:保留已有规则,A I 给的新条件接在后面
        saveRule(db, draft.folderId, [...(getRule(db, draft.folderId)?.conditions ?? []), ...(draft.conditions ?? [])], 'ai');
        setReviewDraftStatus(db, id, 'adopted');
        return { ok: true };
      }
      if (draft.kind === 'merge') {
        mergeFolders(db, [draft.folderId], draft.intoId!, { actor: 'ai' });
        // 草稿带 conditions = AI 的精选并集,覆盖 mergeFolders 的机械并集
        if (draft.conditions && draft.conditions.length > 0) {
          saveRule(db, draft.intoId!, draft.conditions, 'ai');
        }
        setReviewDraftStatus(db, id, 'adopted');
        return { ok: true };
      }
      // delete:安全网(删夹不删视频)已在 deleteFolder 里
      deleteFolder(db, draft.folderId, { actor: 'ai' });
      setReviewDraftStatus(db, id, 'adopted');
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  app.post('/api/reviews/discard', async (req, reply) => {
    const id = Number((req.body as { draftId?: unknown } | null)?.draftId);
    const draft = listReviewDrafts(db).find((d) => d.id === id);
    if (!draft) return reply.code(404).send({ ok: false, reason: '草稿不存在' });
    setReviewDraftStatus(db, id, 'discarded');
    return { ok: true };
  });

  /** 全部采纳:只作用 kind==='rule' 的 pending 草稿,逐个跑(一个失败不拖累其他) */
  app.post('/api/reviews/adopt-all', async () => {
    const results: { draftId: number; ok: boolean }[] = [];
    for (const d of listReviewDrafts(db).filter((x) => x.kind === 'rule' && x.status === 'pending')) {
      try {
        saveRule(db, d.folderId, [...(getRule(db, d.folderId)?.conditions ?? []), ...(d.conditions ?? [])], 'ai');
        setReviewDraftStatus(db, d.id, 'adopted');
        results.push({ draftId: d.id, ok: true });
      } catch (e) {
        log.event({ level: 'warn', category: 'llm', code: 'REVIEW_ADOPT_FAIL', message: `规则草稿 ${d.id} 采纳失败:${(e as Error).message}` });
        results.push({ draftId: d.id, ok: false });
      }
    }
    return { ok: true, results };
  });
}
