import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../../logger/index.js';
import { corsOrigin } from '../cors.js';

export function registerSseRoutes(app: FastifyInstance, deps: { db: Database.Database; log: Logger }): void {
  const { db } = deps;

  app.get('/api/events', async (req, reply) => {
    // 这个响应由我们自己完全接管(长连接,永不 send),必须 hijack:
    // 否则 Fastify 会在 handler 返回后试图结束回复,真机上打 "reply already sent"。
    reply.hijack();
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    };
    // 前端 dev 直连 3001(不走 umi 代理)—— hijack 响应不走 Fastify 的 onSend
    // hook,这里手动补 CORS,策略和 index.ts 共用同一份白名单(cors.ts)
    const origin = corsOrigin(req.headers.origin);
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    reply.raw.writeHead(200, headers);

    // last-event-id 续传:从该 id 之后开始
    let lastId = Number(req.headers['last-event-id'] ?? 0) || 0;
    const pollEvents = (): void => {
      const rows = db.prepare(`SELECT id, level, category, code, message FROM events WHERE id > ? ORDER BY id LIMIT 20`).all(lastId) as
        Array<{ id: number; level: string; category: string; code: string | null; message: string }>;
      for (const row of rows) {
        reply.raw.write(`id: ${row.id}\nevent: log\ndata: ${JSON.stringify(row)}\n\n`);
        lastId = row.id;
      }
    };

    pollEvents();
    // 简单轮询(1s):每轮把新事件推出去
    const timer = setInterval(pollEvents, 1000);
    req.raw.on('close', () => clearInterval(timer));
    // 测试钩子:?test=1 时写完首批后主动结束,让 app.inject 能返回
    if ((req.query as { test?: string }).test === '1') {
      pollEvents();
      clearInterval(timer);
      reply.raw.end();
    }
  });
}
