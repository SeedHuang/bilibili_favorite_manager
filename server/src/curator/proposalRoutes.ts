// server/src/curator/proposalRoutes.ts
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import {
  listDrafts, setDraftStatus, sampleTitlesFor, getProposal,
} from '../db/repo/proposals.js';
import { saveRule } from '../db/repo/rules.js';
import { createFolder } from './workbench.js';
import { runGeneration } from './proposal.js';
import { readLlmSettings } from '../llm/config.js';

export interface ProposalDeps { db: Database.Database; log: Logger }

export function registerProposalRoutes(app: FastifyInstance, deps: ProposalDeps): void {
  const { db, log } = deps;

  app.post('/api/proposals/generate', async (req, reply) => {
    const level = Number((req.body as { level?: unknown } | null)?.level);
    if (!Number.isInteger(level) || level < 1 || level > 10) {
      return reply.code(400).send({ ok: false, reason: '档位必须是 1~10' });
    }
    if (!readLlmSettings(db, 'rules')) {
      return reply.code(400).send({ ok: false, reason: '还没配模型 —— 先去「授权」页的模型管理里选一个' });
    }
    const cur = getProposal(db);
    if (cur?.status === 'generating') {
      return reply.code(409).send({ ok: false, reason: '上一轮还在生成中' });
    }
    // 先落 generating(防重复点击),异步跑;**不 await**
    void runGeneration(db, log, level);
    return reply.code(202).send({ ok: true });
  });

  app.get('/api/proposals/current', async () => {
    const proposal = getProposal(db);
    const drafts = listDrafts(db);
    if (proposal?.status !== 'ready') return { proposal, drafts };
    // 只在 ready 时算样本标题 —— generating 时白算
    return { proposal, drafts: drafts.map((d) => ({ ...d, sampleTitles: sampleTitlesFor(db, d.conditions) })) };
  });

  /** 采纳一个草稿:建夹子 + 写规则 + 改状态,事务一体 */
  app.post('/api/proposals/adopt', async (req, reply) => {
    const { draftId, name } = (req.body ?? {}) as { draftId?: unknown; name?: unknown };
    const id = Number(draftId);
    const draft = listDrafts(db).find((d) => d.id === id);
    if (!draft || draft.status !== 'pending') {
      return reply.code(404).send({ ok: false, reason: '草稿不存在或已处理' });
    }
    const folderName = typeof name === 'string' && name.trim() ? name.trim() : draft.name;
    try {
      let folderId = 0;
      db.transaction(() => {
        folderId = createFolder(db, folderName); // workbench 的:建夹子 + 记操作日志
        saveRule(db, folderId, draft.conditions, 'ai');
        setDraftStatus(db, id, 'adopted', folderId);
      })();
      return { ok: true, folderId };
    } catch (e) {
      return reply.code(400).send({ ok: false, reason: (e as Error).message });
    }
  });

  /** 全部采纳:逐个跑(一个失败不影响其他) */
  app.post('/api/proposals/adopt-all', async () => {
    const results: { draftId: number; folderId: number }[] = [];
    for (const d of listDrafts(db).filter((d) => d.status === 'pending')) {
      try {
        let folderId = 0;
        db.transaction(() => {
          folderId = createFolder(db, d.name);
          saveRule(db, folderId, d.conditions, 'ai');
          setDraftStatus(db, d.id, 'adopted', folderId);
        })();
        results.push({ draftId: d.id, folderId });
      } catch (e) {
        log.event({ level: 'warn', category: 'llm', code: 'PROPOSAL_ADOPT_FAIL', message: `「${d.name}」采纳失败:${(e as Error).message}` });
      }
    }
    return { ok: true, results };
  });

  app.post('/api/proposals/discard', async (req, reply) => {
    const id = Number((req.body as { draftId?: unknown } | null)?.draftId);
    const draft = listDrafts(db).find((d) => d.id === id);
    if (!draft) return reply.code(404).send({ ok: false, reason: '草稿不存在' });
    setDraftStatus(db, id, 'discarded');
    return { ok: true };
  });
}
