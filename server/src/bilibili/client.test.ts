import { describe, it, expect, vi } from 'vitest';
import { BiliClient, type RequestRecord } from './client.js';
import { RateLimiter } from './rateLimiter.js';
import { RiskControlError, AuthError, HttpError } from './errors.js';

const NAV = {
  code: 0,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

/** 按 path 决定返回什么的 fetch 假实现 */
function routedFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    headers.push((init?.headers as Record<string, string>) ?? {});
    for (const [key, body] of Object.entries(routes)) {
      if (String(url).includes(key)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls, headers };
}

/** 不真等的限速器 */
const fastLimiter = () => new RateLimiter({ sleepImpl: async () => {} });
const FP = { buvid3: 'B3', buvid4: 'B4' };

describe('BiliClient', () => {
  it('拉收藏夹列表:signed:false 时不带 w_rid', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: { list: [] } } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    const url = f.calls[0]!;
    expect(url).not.toContain('w_rid');
    expect(url).toContain('up_mid=2');
  });

  it('signed 默认 true,自动取 nav 拿 mixinKey 并签名', async () => {
    const f = routedFetch({ nav: NAV, 'acc/info': { code: 0, data: { mid: 2 } } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await c.get('/x/space/wbi/acc/info', { mid: 2 });
    const target = f.calls.find((u) => u.includes('acc/info'))!;
    expect(target).toContain('w_rid=');
    expect(target).toContain('wts=');
  });

  it('mixinKey 只取一次,后续请求复用缓存', async () => {
    const f = routedFetch({ nav: NAV, 'acc/info': { code: 0, data: {} } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await c.get('/x/space/wbi/acc/info', { mid: 1 });
    await c.get('/x/space/wbi/acc/info', { mid: 2 });
    expect(f.calls.filter((u) => u.includes('/nav')).length).toBe(1);
  });

  it('带上 buvid3 cookie', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: {} } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    expect(f.headers[0]!['Cookie']).toContain('buvid3=B3');
  });

  it('带 SESSDATA 时一并进 cookie', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: {} } });
    const c = new BiliClient({
      fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP,
      sessdata: 'SD', bilijct: 'JC',
    });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    const cookie = f.headers[0]!['Cookie']!;
    expect(cookie).toContain('SESSDATA=SD');
    expect(cookie).toContain('bili_jct=JC');
  });

  it('带 Referer', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: {} } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    expect(f.headers[0]!['Referer']).toBe('https://www.bilibili.com/');
  });

  it('-412 抛 RiskControlError,且不重试', async () => {
    const f = routedFetch({ 'list-all': { code: -412, message: '请求被拦截' } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await expect(
      c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
    ).rejects.toBeInstanceOf(RiskControlError);
    expect(f.calls).toHaveLength(1);
  });

  it('HTTP 状态码 412 也抛 RiskControlError,不重试', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response(
        JSON.stringify({ code: -412, message: '请求被拦截' }),
        { status: 412, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const c = new BiliClient({ fetchImpl: impl, limiter: fastLimiter(), fingerprint: FP });
    await expect(
      c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
    ).rejects.toBeInstanceOf(RiskControlError);
    expect(n).toBe(1);
  });

  it('HTTP 412 且 body 是 HTML(非 JSON)也抛 RiskControlError,不重试', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response('<html><body>412 Forbidden</body></html>', {
        status: 412,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;
    const c = new BiliClient({ fetchImpl: impl, limiter: fastLimiter(), fingerprint: FP });
    await expect(
      c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
    ).rejects.toBeInstanceOf(RiskControlError);
    expect(n).toBe(1);
  });

  it('-101 抛 AuthError', async () => {
    const f = routedFetch({ 'list-all': { code: -101, message: '账号未登录' } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await expect(
      c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('-412 配 HTTP 500 仍是 RiskControlError,不重试', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response(JSON.stringify({ code: -412, message: '请求被拦截' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const c = new BiliClient({ fetchImpl: impl, limiter: fastLimiter(), fingerprint: FP });
    await expect(
      c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
    ).rejects.toBeInstanceOf(RiskControlError);
    expect(n).toBe(1);
  });

  it('HTTP 403 且 body 是 HTML(非 412 非 5xx)不重试', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response('<html><body>403 Forbidden</body></html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;
    const c = new BiliClient({ fetchImpl: impl, limiter: fastLimiter(), fingerprint: FP });
    await expect(
      c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(1);
  });

  it('code 0 但 data 为 null → 返回 null(合法响应,不是错误)', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: null } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    const v = await c.get<{ list?: unknown[] }>(
      '/x/v3/fav/folder/created/list-all',
      { up_mid: 2 },
      { signed: false },
    );
    expect(v).toBeNull();
  });

  it('读操作遇 5xx 会重试,最多 3 次', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response('{"code":0,"data":{}}', {
        status: n < 3 ? 503 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const c = new BiliClient({
      fetchImpl: impl, limiter: fastLimiter(), fingerprint: FP,
      retrySleepImpl: async () => {},
    });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    expect(n).toBe(3);
  });

  it('onRequest 钩子收到每次请求的记录', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: { list: [] } } });
    const seen: RequestRecord[] = [];
    const c = new BiliClient({
      fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP,
      onRequest: (r) => seen.push(r),
    });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/x/v3/fav/folder/created/list-all');
    expect(seen[0]!.httpStatus).toBe(200);
    expect(seen[0]!.code).toBe(0);
    expect(seen[0]!.attempt).toBe(1);
    expect(seen[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(seen[0]!.method).toBe('GET');
  });

  it('onRequest 在风控失败时也会被调用(否则日志缺最关键的一条)', async () => {
    const f = routedFetch({ 'list-all': { code: -412, message: '拦截' } });
    const seen: RequestRecord[] = [];
    const c = new BiliClient({
      fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP,
      onRequest: (r) => seen.push(r),
    });
    await expect(
      c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
    ).rejects.toBeInstanceOf(RiskControlError);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.code).toBe(-412);
  });

  it('重试时每次尝试都各上报一次', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response('{"code":0,"data":{}}', {
        status: n < 3 ? 503 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const seen: RequestRecord[] = [];
    const c = new BiliClient({
      fetchImpl: impl, limiter: fastLimiter(), fingerprint: FP,
      retrySleepImpl: async () => {}, onRequest: (r) => seen.push(r),
    });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    expect(seen.map((r) => r.attempt)).toEqual([1, 2, 3]);
  });

  it('signed 请求时 nav 也上报(spec §6 要记每一次请求)', async () => {
    const f = routedFetch({ nav: NAV, 'acc/info': { code: 0, data: { mid: 2 } } });
    const seen: RequestRecord[] = [];
    const c = new BiliClient({
      fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP,
      onRequest: (r) => seen.push(r),
    });
    await c.get('/x/space/wbi/acc/info', { mid: 2 });

    expect(seen).toHaveLength(2);
    expect(seen[0]!.path).toBe('/x/web-interface/nav');
    expect(seen[1]!.path).toBe('/x/space/wbi/acc/info');
    expect(seen[0]!.params).toBeUndefined();
    expect(seen[0]!.attempt).toBe(1);
  });

  it('onRequest 抛错绝不改变结果:正常请求照样 resolve,风控照样 RiskControlError', async () => {
    const boom = () => {
      throw new Error('logger 炸了');
    };
    // 这条路径现在会往 console 上留痕(T4)—— 测试里咽掉,别把输出弄脏
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ok = routedFetch({ 'list-all': { code: 0, data: { list: [1] } } });
      const c1 = new BiliClient({
        fetchImpl: ok.impl, limiter: fastLimiter(), fingerprint: FP, onRequest: boom,
      });
      await expect(
        c1.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
      ).resolves.toEqual({ list: [1] });

      const risk = routedFetch({ 'list-all': { code: -412, message: '拦截' } });
      const c2 = new BiliClient({
        fetchImpl: risk.impl, limiter: fastLimiter(), fingerprint: FP, onRequest: boom,
      });
      await expect(
        c2.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
      ).rejects.toBeInstanceOf(RiskControlError);
    } finally {
      spy.mockRestore();
    }
  });

  it('withCredentials 换凭证但复用指纹/限速器', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: { list: [] } } });
    const limiter = { acquire: vi.fn(async () => {}) } as unknown as RateLimiter;
    const c = new BiliClient({ fetchImpl: f.impl, limiter, fingerprint: FP });
    const c2 = c.withCredentials('NEW_SD', 'NEW_JC');

    // c2 带新凭证,且复用原实例的指纹和限速器
    await c2.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    const cookie = f.headers[0]!['Cookie']!;
    expect(cookie).toContain('SESSDATA=NEW_SD');
    expect(cookie).toContain('bili_jct=NEW_JC');
    expect(cookie).toContain('buvid3=B3');
    expect(limiter.acquire).toHaveBeenCalledTimes(1);

    // 原实例不受影响
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    expect(f.headers[1]!['Cookie'] ?? '').not.toContain('NEW_SD');
  });

  // T4:吞掉回调异常是对的(审计日志不该改变请求结果),但完全静默就查不出问题了。
  // 只能走 console —— logger 正是这个钩子的下游,在 catch 里调 logger.event 会递归。
  it('onRequest 回调抛错时走 console.error 留痕,不是静默吞掉', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const boom = () => {
        throw new Error('logger 炸了');
      };
      const ok = routedFetch({ 'list-all': { code: 0, data: { list: [] } } });
      const c = new BiliClient({
        fetchImpl: ok.impl, limiter: fastLimiter(), fingerprint: FP, onRequest: boom,
      });
      await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
      expect(spy).toHaveBeenCalledWith('[logger] onRequest 回调失败', expect.any(Error));
    } finally {
      spy.mockRestore();
    }
  });
});
