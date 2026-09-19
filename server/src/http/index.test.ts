import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from './index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import type { BiliClient } from '../bilibili/client.js';

/** 只用得到 withCredentials;真正打 bilibili 的路径在 auth.test.ts 里单独测 */
const stubClient = {
  withCredentials: () => ({ get: async () => null }),
} as unknown as BiliClient;

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  return { app: createServer({ db, log, client: stubClient }), db };
}

describe('health', () => {
  it('返回 ok 和统计', async () => {
    const { app, db } = makeApp();
    upsertFolder(db, { id: 1, title: 'a', mediaCount: 1 });
    upsertItem(db, { id: 'BV1', type: 2, title: 'v' });
    linkFolderItem(db, 1, 'BV1', 1);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, folders: 1, items: 1 });
    await app.close();
  });

  it('健康检查不打 bilibili(纯本地)', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// 本任务的核心:createServer 必须把所有路由都挂上(而不是 404)
describe('路由组装', () => {
  it('/api/folders 与 /api/items 都可达', async () => {
    const { app, db } = makeApp();
    upsertFolder(db, { id: 1, title: '收藏夹', mediaCount: 1 });
    const folders = await app.inject({ method: 'GET', url: '/api/folders' });
    expect(folders.statusCode).toBe(200);
    expect(folders.json().folders).toHaveLength(1);

    const search = await app.inject({ method: 'GET', url: '/api/items/search?q=x' });
    expect(search.statusCode).toBe(200);
    await app.close();
  });

  it('/api/events 的 ?test=1 路径在 hijack 后仍能被 inject 拿到', async () => {
    const { app, db } = makeApp();
    const log = new Logger(db, { silent: true });
    log.event({ level: 'info', category: 'sync', message: '组装冒烟' });
    const res = await app.inject({ method: 'GET', url: '/api/events?test=1' });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('组装冒烟');
    await app.close();
  });
});

describe('CORS', () => {
  // 前端 dev 直连 3001 不走代理:带 body 的跨域请求要先过 OPTIONS 预检。
  // 预检只有**命中一条路由** onSend 钩子才跑 —— 之前没 OPTIONS 路由,预检落到
  // 404,浏览器直接中止真实请求(带 body 的 json() 全断)。
  it('OPTIONS 预检命中通配路由 → 204 + 白名单 origin 放行', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/tags/run',
      headers: { origin: 'http://localhost:8000' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8000');
    await app.close();
  });

  it('白名单外的 origin 不放行(任意网页不能驱动本机工具)', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    });
    // 不带 access-control-allow-origin → 浏览器读不到响应 / 发不起写请求
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('同源/无 Origin 的请求照常(不误伤非浏览器调用)', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});
