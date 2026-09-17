import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../../logger/index.js';
import type { BiliClient } from '../../bilibili/client.js';
import { RiskControlError, AuthError } from '../../bilibili/errors.js';
import { getSetting, setSetting } from '../../db/repo/state.js';
import { encryptSecret, decryptSecret, dpapiAvailable } from '../../security/dpapi.js';
import { extractCreds } from '../../security/creds.js';

const NAV_PATH = '/x/web-interface/nav';
/** 凭证在 settings 表里的键 —— dev.ts 读回凭证构造客户端时也用它 */
export const KEY_SESSDATA = 'bili.sessdata';
export const KEY_BILIJCT = 'bili.bilijct';

export interface AuthDeps {
  db: Database.Database;
  log: Logger;
  /** 用于验证 cookie 的客户端 */
  client: BiliClient;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, log, client } = deps;

  app.post('/api/auth/validate', async (req, reply) => {
    const { cookie } = (req.body ?? {}) as { cookie?: string };
    if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
      return reply.code(400).send({ ok: false, reason: '没有收到 cookie' });
    }

    // 从整段粘贴里提取凭证(纯函数在 security/creds.ts,http/ 不依赖 probes/)
    const { sessdata, bilijct } = extractCreds(cookie);
    if (!sessdata || !bilijct) {
      return reply.code(400).send({
        ok: false,
        reason: '没能从粘贴内容里同时找到 SESSDATA 和 bili_jct —— 检查是否复制完整',
      });
    }

    // 用用户刚粘贴的凭证构造一个临时客户端,真实调 nav 验证。
    // 复用 app 里已有客户端(它已带指纹和限速器),只是换掉凭证。
    const probe = client.withCredentials(sessdata, bilijct);

    try {
      const nav = await probe.get<{ mid?: number; uname?: string }>(NAV_PATH);
      if (!nav) {
        // code:0 却没 data —— 拿不到登录态,可能被风控或网络异常,让用户稍后再试
        return reply.code(429).send({
          ok: false,
          reason: '没能确认登录态(可能触发 bilibili 风控或网络异常)—— 稍后重试,不要反复提交',
        });
      }
      if (!nav.mid) {
        return reply.code(401).send({
          ok: false,
          reason: 'cookie 已过期或登录态不完整,请重新登录后复制',
        });
      }

      // 加密存储(C10)。DPAPI 不可用时降级明文 —— 必须留痕,否则用户以为凭证是加密的。
      if (!dpapiAvailable()) {
        log.event({
          level: 'warn', category: 'auth',
          message: 'DPAPI 不可用 —— 凭证以明文(plain: 前缀)落库,仅限受信任的本机环境',
        });
      }
      setSetting(db, KEY_SESSDATA, encryptSecret(sessdata));
      setSetting(db, KEY_BILIJCT, encryptSecret(bilijct));

      log.event({
        level: 'info', category: 'auth',
        message: `授权成功:${nav.uname} (UID ${nav.mid})`,
      });

      return { ok: true, mid: nav.mid, uname: nav.uname ?? '' };
    } catch (e) {
      if (e instanceof RiskControlError) {
        return reply.code(429).send({
          ok: false,
          reason: '触发 bilibili 风控 —— 等一段时间再试,不要反复提交',
        });
      }
      if (e instanceof AuthError) {
        return reply.code(401).send({ ok: false, reason: 'cookie 已过期,请重新登录' });
      }
      return reply.code(502).send({
        ok: false,
        reason: `验证失败:${(e as Error)?.message ?? e}`,
      });
    }
  });

  // 当前授权状态:供授权页"已授权时显示当前状态"用。
  // 永远 200 —— 这是状态探测,"没授权"是一种正常状态,不是错误。
  app.get('/api/auth/status', async () => {
    // 现读现用:重新授权后设置已更新,不能用启动时构造的客户端凭证
    const sessdata = decryptSetting(db, KEY_SESSDATA);
    const bilijct = decryptSetting(db, KEY_BILIJCT);
    if (!sessdata || !bilijct) return { ok: false };

    try {
      const nav = await client
        .withCredentials(sessdata, bilijct)
        .get<{ mid?: number; uname?: string }>(NAV_PATH);
      if (!nav?.mid) return { ok: false, reason: 'cookie 已过期,请重新授权' };
      return { ok: true, mid: nav.mid, uname: nav.uname ?? '' };
    } catch (e) {
      if (e instanceof RiskControlError) return { ok: false, reason: '触发风控 —— 稍后重试' };
      if (e instanceof AuthError) return { ok: false, reason: 'cookie 已过期,请重新授权' };
      return { ok: false, reason: '状态检查失败,请稍后重试' };
    }
  });
}

/** 读设置并解密。没存 / 解不出 → null(调用方当作"未授权") */
function decryptSetting(db: Database.Database, key: string): string | null {
  const stored = getSetting(db, key);
  return stored ? decryptSecret(stored) : null;
}
