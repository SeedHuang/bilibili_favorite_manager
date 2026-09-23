// server/src/curator/proposalRoutes.ts
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import {
  listDrafts, setDraftStatus, sampleTitlesFor, getProposal,
} from '../db/repo/proposals.js';
import { saveRule } from '../db/repo/rules.js';
import { markFolderAsAi } from '../db/repo/aiFolders.js';
import { createFolder } from './workbench.js';
import { runGeneration, proposalRun } from './proposal.js';
import type { AiCore } from '../ai.js';

export interface ProposalDeps { db: Database.Database; log: Logger; ai: AiCore }

/** 中止控制器 —— abort 端点拿着它停正在跑的那轮。模块级,和 proposalRun 同一理由 */
let currentController: AbortController | null = null;

/** 只在 status **变化**时打一条 —— current 是每秒级的轮询,每拍都打会刷屏 */
let lastLoggedStatus: string | null = null;

export function registerProposalRoutes(app: FastifyInstance, deps: ProposalDeps): void {
  const { db, log, ai } = deps;

  // **启动即复位僵尸态**:进程重启后内存里的 run 一定没了,此时库里任何
  // generating 都是上一进程留下的死状态 —— 不治的话页面一进来就把它当"正在跑",
  // 显示生成中 + 中止按钮,而点中止只会得到一次"没有正在进行的生成"。
  // 复位成 idle 而不是 ready:上一轮的结果本来就随进程丢了。
  const healed = db.prepare(`UPDATE folder_proposals SET status = 'idle' WHERE status = 'generating'`).run();
  console.log(`[proposals] 启动复位僵尸态:${healed.changes} 条 generating → idle`
    + '(内存 run 随进程消失,库里残留的 generating 必然是死状态)');

  app.post('/api/proposals/generate', async (req, reply) => {
    const level = Number((req.body as { level?: unknown } | null)?.level);
    console.log(`[proposals/generate] 请求到达 level=${level}`);
    if (!Number.isInteger(level) || level < 1 || level > 10) {
      console.log(`[proposals/generate] 拒绝:档位非法 level=${level}`);
      return reply.code(400).send({ ok: false, reason: '档位必须是 1~10' });
    }
    if (!ai.readLlmSettings('proposals')) {
      console.log('[proposals/generate] 拒绝:没配模型');
      return reply.code(400).send({ ok: false, reason: '还没配模型 —— 先去「授权」页的模型管理里选一个' });
    }
    const cur = getProposal(db);
    if (cur?.status === 'generating') {
      console.log(`[proposals/generate] 拒绝:上一轮还在生成中(status=${cur.status},内存 running=${proposalRun.running})`);
      return reply.code(409).send({ ok: false, reason: '上一轮还在生成中' });
    }
    // 先落 generating(防重复点击),异步跑;**不 await**
    const controller = new AbortController();
    currentController = controller;
    console.log(`[proposals/generate] 已受理 level=${level} —— 启动即返回(202),后台跑`);
    void runGeneration(ai, db, log, level, { signal: controller.signal });
    return reply.code(202).send({ ok: true });
  });

  // 中止:未在跑 → 409(和 tags/run-abort 的幂等不同,这里前端按钮只该在跑时出现)
  app.post('/api/proposals/abort', async (_req, reply) => {
    const cur = getProposal(db);
    console.log(`[proposals/abort] 收到中止请求 running=${proposalRun.running}`
      + ` controller=${currentController ? '有' : '无'} status=${cur?.status ?? 'none'}`);
    if (!proposalRun.running || !currentController) {
      // 落库 generating 但内存没在跑 = 进程重启留下的僵尸态(status 没有任何
      // 启动时复位逻辑)—— 不解锁的话 generate 恒 409、abort 恒 409,用户只能手改库。
      // abort 端点顺手当解锁路径:回 idle,让前端下一次 load 回到正常态
      if (cur?.status === 'generating') {
        db.prepare(`UPDATE folder_proposals SET status = 'idle' WHERE id = 1`).run();
        console.log('[proposals/abort] 内存没在跑但落库是 generating —— 按僵尸态解锁回 idle');
        return { ok: true };
      }
      console.log('[proposals/abort] 拒绝:没有正在进行的生成(409)');
      return reply.code(409).send({ ok: false, reason: '没有正在进行的生成' });
    }
    currentController.abort();
    console.log('[proposals/abort] 已发中止信号,等 run 收尾回 idle');
    return { ok: true };
  });

  app.get('/api/proposals/current', async () => {
    const proposal = getProposal(db);
    const drafts = listDrafts(db);
    const logs = proposalRun.logs;
    // status 变化才打 —— 这是"页面为什么显示生成中"最直接的一条证据
    const st = proposal?.status ?? 'none';
    if (st !== lastLoggedStatus) {
      console.log(`[proposals/current] status ${lastLoggedStatus ?? '(首次)'} → ${st}`
        + ` 草稿=${drafts.length} 日志=${logs.length} 内存running=${proposalRun.running}`);
      lastLoggedStatus = st;
    }
    if (proposal?.status !== 'ready') return { proposal, drafts, logs };
    // 只在 ready 时算样本标题 —— generating 时白算
    return { proposal, drafts: drafts.map((d) => ({ ...d, sampleTitles: sampleTitlesFor(db, d.conditions) })), logs };
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
    // B 站收藏夹名上限 20 字 —— 本地建可以建,同步上传会被 B 站拒,入口就拦下
    if ([...folderName].length > 20) {
      return reply.code(400).send({ ok: false, reason: '夹子名最长 20 个字(B 站限制),改短再采纳' });
    }
    try {
      let folderId = 0;
      db.transaction(() => {
        folderId = createFolder(db, folderName); // workbench 的:建夹子 + 记操作日志
        markFolderAsAi(db, folderId); // 三分类:AI 方案采纳建的夹子,标记为 AI 夹子
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
          markFolderAsAi(db, folderId); // 三分类:AI 方案采纳建的夹子,标记为 AI 夹子
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

  /** 全部丢弃:所有 pending 草稿置 discarded(与「全部采纳」并列,spec §6) */
  app.post('/api/proposals/discard-all', async () => {
    db.prepare(`UPDATE folder_proposal_folders SET status = 'discarded' WHERE status = 'pending'`).run();
    return { ok: true };
  });
}
