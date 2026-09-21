// server/src/curator/settingsPolls.ts
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  listPolls, writePoll, POLL_TASKS, POLL_INTERVALS,
} from '../db/repo/state.js';

export interface PollsDeps { db: Database.Database }

/**
 * 任务三件套设置的两条路由(spec 2026-09-20 §3)。
 * 校验在这一层:repo 的 writePoll 不校验 —— 只有这里对着用户。
 */
export function registerPollsRoutes(app: FastifyInstance, deps: PollsDeps): void {
  const { db } = deps;

  app.get('/api/settings/polls', async () => ({ polls: listPolls(db) }));

  app.put('/api/settings/polls/:taskType', async (req, reply) => {
    const taskType = (req.params as { taskType: string }).taskType;
    if (!(POLL_TASKS as readonly string[]).includes(taskType)) {
      return reply.code(404).send({ ok: false, reason: `未知任务类型 ${taskType}` });
    }
    const body = (req.body ?? {}) as { intervalMs?: unknown; batch?: unknown };
    const iv = Number(body.intervalMs);
    if (!POLL_INTERVALS.includes(iv)) {
      return reply.code(400).send({ ok: false, reason: '轮询间隔必须是 1/2/3/5/10 秒之一' });
    }
    // proposals 无批次概念 —— batch 字段来了也忽略(spec §0 修正 1)
    if (taskType === 'proposals') {
      writePoll(db, taskType, { intervalMs: iv });
      return { ok: true };
    }
    const b = Number(body.batch);
    // 预设档 ⊂ 1~500 整数,一个范围判断就够(POLL_BATCHES 只是给 UI 的档位表)
    const custom = Number.isInteger(b) && b >= 1 && b <= 500;
    if (!custom) {
      return reply.code(400).send({ ok: false, reason: '批次大小必须是预设档位或 1~500 的整数' });
    }
    writePoll(db, taskType, { intervalMs: iv, batch: b });
    return { ok: true };
  });
}
