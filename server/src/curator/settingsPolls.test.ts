// server/src/curator/settingsPolls.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { createServer } from '../http/index.js';
import type { BiliClient } from '../bilibili/client.js';

const stubClient = { withCredentials: () => ({ get: async () => null }) } as unknown as BiliClient;

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  return { app: createServer({ db, log, client: stubClient }) };
}

const put = (app: Awaited<ReturnType<typeof makeApp>>['app'], task: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/settings/polls/${task}`, payload });

describe('polls 路由', () => {
  it('GET 返回三个任务的配置(缺 key 全兜底)', async () => {
    const { app } = makeApp();
    const res = await app.inject({ url: '/api/settings/polls' });
    expect(res.statusCode).toBe(200);
    expect(res.json().polls).toEqual({
      tag: { intervalMs: 2000, batch: 16 },
      tagcheck: { intervalMs: 3000, batch: 200 },
      proposals: { intervalMs: 3000, batch: null },
    });
  });

  it('PUT 合法值(预设档)生效', async () => {
    const { app } = makeApp();
    const res = await put(app, 'tag', { intervalMs: 5000, batch: 40 });
    expect(res.statusCode).toBe(200);
    const get = await app.inject({ url: '/api/settings/polls' });
    expect(get.json().polls.tag).toEqual({ intervalMs: 5000, batch: 40 });
  });

  it('PUT 自定义 batch(120,在 1~500 内)生效', async () => {
    const { app } = makeApp();
    const res = await put(app, 'tagcheck', { intervalMs: 1000, batch: 120 });
    expect(res.statusCode).toBe(200);
    const get = await app.inject({ url: '/api/settings/polls' });
    expect(get.json().polls.tagcheck.batch).toBe(120);
  });

  it('PUT 非法 intervalMs → 400', async () => {
    const { app } = makeApp();
    const res = await put(app, 'tag', { intervalMs: 7777, batch: 16 });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toContain('轮询间隔');
  });

  it('PUT 非法 batch(0 / 999 / 小数)→ 400', async () => {
    const { app } = makeApp();
    for (const batch of [0, 999, 2.5]) {
      const res = await put(app, 'tag', { intervalMs: 2000, batch });
      expect(res.statusCode).toBe(400);
      expect(res.json().reason).toContain('批次');
    }
  });

  it('PUT proposals 忽略 batch 字段', async () => {
    const { app } = makeApp();
    const res = await put(app, 'proposals', { intervalMs: 10000, batch: 40 });
    expect(res.statusCode).toBe(200);
    const get = await app.inject({ url: '/api/settings/polls' });
    expect(get.json().polls.proposals).toEqual({ intervalMs: 10000, batch: null });
  });

  it('未知 taskType → 404', async () => {
    const { app } = makeApp();
    const res = await put(app, 'nope', { intervalMs: 2000, batch: 16 });
    expect(res.statusCode).toBe(404);
  });
});
