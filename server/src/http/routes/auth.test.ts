import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { openDb } from '../../db/index.js';
import { Logger } from '../../logger/index.js';
import { getSetting, setSetting } from '../../db/repo/state.js';
import { encryptSecret } from '../../security/dpapi.js';
import { AuthError, RiskControlError } from '../../bilibili/errors.js';
import { registerAuthRoutes } from './auth.js';

/**
 * mock 的行为契约与真实 `BiliClient.get` 对齐:
 * 成功 resolve 剥掉 envelope 的 data;失败 throw 对应错误类;拿不到登录态 resolve null。
 */
type NavBehavior = () => Promise<{ mid?: number; uname?: string } | null>;

function makeApp(navBehavior: NavBehavior) {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  // withCredentials 返回一个"用新凭证调 get"的客户端;get 走给定的行为
  const client = {
    withCredentials: vi.fn(() => ({ get: vi.fn(navBehavior) })),
  } as unknown as import('../../bilibili/client.js').BiliClient;
  const app = Fastify();
  registerAuthRoutes(app, { db, log, client });
  return { app, db, client };
}

describe('auth routes', () => {
  it('有效 cookie → 验证通过并加密存储', async () => {
    const { app, db } = makeApp(async () => ({ mid: 27725036, uname: '测试用户' }));
    const res = await app.inject({
      method: 'POST', url: '/api/auth/validate',
      payload: { cookie: 'SESSDATA=abc%2Cdef; bili_jct=xyz' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, mid: 27725036, uname: '测试用户' });

    // 凭证加密存储,不是明文
    const stored = getSetting(db, 'bili.sessdata')!;
    expect(stored).not.toContain('abc%2Cdef');
    expect(getSetting(db, 'bili.bilijct')).not.toContain('xyz');
  });

  it('cookie 过期(-101)→ 明确报错,不存储', async () => {
    const { app, db } = makeApp(async () => {
      throw new AuthError('未登录(-101 账号未登录)', -101, 200);
    });
    const res = await app.inject({
      method: 'POST', url: '/api/auth/validate',
      payload: { cookie: 'SESSDATA=bad; bili_jct=bad' },
    });
    expect(res.json().ok).toBe(false);
    expect(res.json().reason).toMatch(/过期|登录/);
    expect(getSetting(db, 'bili.sessdata')).toBeUndefined();
  });

  it('触发风控 → 提示重试而非让用户白折腾', async () => {
    const { app } = makeApp(async () => {
      throw new RiskControlError('触发风控(-412)', -412, 412);
    });
    const res = await app.inject({
      method: 'POST', url: '/api/auth/validate',
      payload: { cookie: 'SESSDATA=x; bili_jct=y' },
    });
    expect(res.json().ok).toBe(false);
    expect(res.json().reason).toMatch(/风控|稍后|验证/);
  });
});

describe('GET /api/auth/status', () => {
  it('没存凭证 → ok:false', async () => {
    const { app } = makeApp(async () => null);
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false });
  });

  it('存了可解密凭证 → 返回账号', async () => {
    const { app, db } = makeApp(async () => ({ mid: 42, uname: '老用户' }));
    setSetting(db, 'bili.sessdata', encryptSecret('sess'));
    setSetting(db, 'bili.bilijct', encryptSecret('jct'));
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.json()).toEqual({ ok: true, mid: 42, uname: '老用户' });
  });

  it('凭证过期 → ok:false 且给出原因(仍 200)', async () => {
    const { app, db } = makeApp(async () => {
      throw new AuthError('未登录', -101, 200);
    });
    setSetting(db, 'bili.sessdata', encryptSecret('sess'));
    setSetting(db, 'bili.bilijct', encryptSecret('jct'));
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().reason).toMatch(/过期|登录/);
  });
});
