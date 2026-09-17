import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { openDb } from '../../db/index.js';
import { Logger } from '../../logger/index.js';
import { registerCoverRoutes } from './cover.js';

/** 用假 fetch 模拟 CDN,不发真实网络。cacheDir 注入临时目录,不污染 data/ */
function makeApp(cdnResponse: () => Promise<Response>, cacheDir?: string) {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    // 断言请求打到了允许的域名(不允许任意 URL 代理)
    expect(String(url)).toMatch(/^https:\/\/i\d\.hdslb\.com\//);
    return cdnResponse();
  }) as unknown as typeof fetch;
  const app = Fastify();
  registerCoverRoutes(app, { db, log, fetchImpl, cacheDir });
  return { app, calls };
}

/** 每次测试独立的临时缓存目录,跑完清理 */
function tempCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'cover-test-'));
}

describe('cover proxy', () => {
  it('转发 bilibili 封面,返回 image 二进制', async () => {
    const { app } = makeApp(async () => new Response(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), // JPEG 魔数
      { status: 200, headers: { 'content-type': 'image/jpeg' } },
    ));
    const res = await app.inject({
      method: 'GET',
      url: '/api/cover?url=https://i1.hdslb.com/bfs/archive/abc.jpg',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.rawPayload).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    await app.close();
  });

  it('i0 分片也要放行(实测封面会在 i0,漏了就破图)', async () => {
    const { app } = makeApp(async () => new Response(
      Buffer.from([0xff, 0xd8, 0xff]),
      { status: 200, headers: { 'content-type': 'image/jpeg' } },
    ));
    const res = await app.inject({
      method: 'GET',
      url: '/api/cover?url=https://i0.hdslb.com/bfs/archive/abc.jpg',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('只允许 hdslb.com 域名(拒绝任意 URL 代理,防 SSRF)', async () => {
    const { app } = makeApp(async () => new Response('x', { status: 200 }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/cover?url=https://evil.com/x.jpg',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('拒绝非 http(s) 协议', async () => {
    const { app } = makeApp(async () => new Response('x', { status: 200 }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/cover?url=file:///etc/passwd',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('CDN 失败时返回 502,不崩溃', async () => {
    const { app } = makeApp(async () => new Response('Not Found', { status: 404 }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/cover?url=https://i1.hdslb.com/bfs/archive/missing.jpg',
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('缺少 url 参数时返回 400', async () => {
    const { app } = makeApp(async () => new Response('x', { status: 200 }));
    const res = await app.inject({ method: 'GET', url: '/api/cover' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('磁盘缓存:第二次请求不再调 CDN,直接从本地读', async () => {
    const dir = tempCacheDir();
    const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const { app, calls } = makeApp(
      async () => new Response(img, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      dir,
    );
    const url = '/api/cover?url=https://i1.hdslb.com/bfs/archive/cached.jpg';

    // 第一次:拉 CDN 并写盘
    const r1 = await app.inject({ method: 'GET', url });
    expect(r1.statusCode).toBe(200);
    expect(r1.rawPayload).toEqual(img);
    expect(calls).toHaveLength(1);

    // 磁盘上应有缓存文件
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, files[0]!))).toEqual(img);

    // 第二次:不调 CDN(新 app 实例,无内存缓存,靠磁盘)
    const { app: app2, calls: calls2 } = makeApp(
      async () => new Response(img, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      dir,
    );
    const r2 = await app2.inject({ method: 'GET', url });
    expect(r2.statusCode).toBe(200);
    expect(r2.rawPayload).toEqual(img);
    expect(calls2).toHaveLength(0); // 关键:没调 CDN,直接读盘

    await app.close();
    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('磁盘缓存写失败时不崩溃,照常返回图片', async () => {
    // 用一个不可写目录(只读),模拟写盘失败
    const badDir = tmpdir(); // 让缓存文件写入失败(权限或路径)
    const img = Buffer.from([0xff, 0xd8]);
    const { app } = makeApp(
      async () => new Response(img, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      badDir,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/cover?url=https://i1.hdslb.com/bfs/archive/writefail.jpg',
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(img);
    await app.close();
  });
});
