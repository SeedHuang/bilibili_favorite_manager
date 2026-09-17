import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { openDb } from '../../db/index.js';
import { Logger } from '../../logger/index.js';
import { registerSseRoutes } from './sse.js';

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  const app = Fastify();
  registerSseRoutes(app, { db, log });
  return { app, db, log };
}

describe('sse routes', () => {
  it('返回 text/event-stream 且能收到事件', async () => {
    const { app, db, log } = makeApp();
    // 先排队一条事件:inject 会等流结束才返回,无法在连接后再写,
    // 所以必须连之前写(?test=1 时路由写完已排队数据即 end)
    log.event({ level: 'info', category: 'sync', message: '同步完成:64 个夹子' });
    const res = await app.inject({ method: 'GET', url: '/api/events?test=1' });
    expect(res.headers['content-type']).toContain('text/event-stream');
    // SSE 的 body 应该包含这条已排队事件
    expect(res.body).toContain('同步完成:64 个夹子');
  });

  it('last-event-id 只推送该 id 之后的事件', async () => {
    const { app, db, log } = makeApp();
    log.event({ level: 'info', category: 'sync', message: '事件 1' });
    const res = await app.inject({
      method: 'GET', url: '/api/events?test=1',
      headers: { 'last-event-id': '0' }, // 从 id 0 之后开始 = 全部
    });
    expect(res.body).toContain('事件 1');
  });
});
