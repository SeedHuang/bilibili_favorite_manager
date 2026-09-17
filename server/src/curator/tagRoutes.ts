/**
 * /api/tags/* —— 条目 AI 标注(spec §9E)。SSE/中止/进度模式照抄 §9D 的 run-pass-2。
 *
 * 和 ruleRoutes 一样单独一个文件:curator/routes.ts 已经近千行,标注是独立的一件事。
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import { readLlmSettings } from '../llm/config.js';
import { listUntaggedItemIds, tagStats } from '../db/repo/tagging.js';
import type { ItemRow } from '../db/repo/items.js';
import { runTagging } from './tagger.js';

export interface TagDeps {
  db: Database.Database;
  log: Logger;
}

export function registerTagRoutes(app: FastifyInstance, deps: TagDeps): void {
  const { db, log } = deps;
  const allItems = () => db.prepare(`SELECT * FROM items`).all() as ItemRow[];

  app.get('/api/tags/status', async () => {
    const tag = readLlmSettings(db, 'tag');
    // 用途平级后没有"回落"了:tag 没配就是没配,界面照实说
    return {
      ...tagStats(db),
      model: tag ? { provider: tag.config.provider, model: tag.config.model, source: 'tag' as const } : null,
    };
  });

  app.post('/api/tags/run', async (req, reply) => {
    const scope = (req.query as { scope?: string }).scope === 'all' ? 'all' : 'missing';
    const llm = readLlmSettings(db, 'tag');
    // **先校验后 hijack** —— 接管响应之后就只能写 SSE 帧,4xx 再也发不出去
    if (!llm) {
      return reply.code(400).send({ ok: false, reason: '还没配模型 —— 先去「授权」页配一个' });
    }

    // 增量口径用 **Set** 不是 `listUntaggedItemIds().includes()`:后者是全库 O(n²) 扫,
    // 3250 条真跑起来是秒级的卡顿
    const untagged = new Set(listUntaggedItemIds(db));
    const pool = allItems().filter((i) => scope === 'all' || untagged.has(i.id));

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
    // 把刚建好的 controller 直接 abort 掉 —— 每跑一条都当场自尽。断开要看**响应**:
    // 我们自己正常收尾(writableEnded)之外的 close 才是客户端真的走了
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    /** 中断收尾:记 warn(用户改主意不是故障,§9D B5)+ 尽力回一帧(连接在就回) */
    const finishAborted = () => {
      log.event({
        level: 'warn',
        category: 'llm',
        code: 'TAGGING_ABORTED',
        message: '用户中止了标注 —— 已完成的条目已保留',
      });
      if (!closed()) reply.raw.write(`event: aborted\ndata: {"reason":"已中止"}\n\n`);
    };

    try {
      const r = await runTagging({
        config: llm.config,
        ctx: llm.ctx,
        items: pool,
        signal: controller.signal,
        db,
        // progress 帧只有这三个数 —— 没有 ruleCount,那是归类的字段
        onBatch: (b) => {
          if (closed()) return; // 帧发不出去,但结果照落(批次落库在 runTagging 里)
          reply.raw.write(
            `event: progress\ndata: ${JSON.stringify({ done: b.done, total: b.total, tagged: b.tagged })}\n\n`,
          );
        },
      });

      // runTagging 中止时**不抛**而是带着已完成的批次原样返回 —— 这里也要认一次,
      // 否则会拿"跑到一半"的结果发 done 帧(把没跑的批次当成标完了)
      if (controller.signal.aborted) return finishAborted();
      if (closed()) return;

      log.event({
        level: 'info',
        category: 'llm',
        message: `标注完成:${r.tagged} 条,${r.failedBatches.length} 批失败`,
      });
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ tagged: r.tagged, failedBatches: r.failedBatches })}\n\n`);
    } catch (e) {
      if (controller.signal.aborted) {
        finishAborted();
      } else {
        const message = (e as Error)?.message ?? String(e);
        log.event({ level: 'error', category: 'llm', code: 'TAGGING_FAILED', message });
        if (!closed()) reply.raw.write(`event: error\ndata: ${JSON.stringify({ reason: message })}\n\n`);
      }
    } finally {
      reply.raw.end();
    }
  });
}
