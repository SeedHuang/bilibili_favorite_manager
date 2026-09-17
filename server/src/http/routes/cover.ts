import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../../logger/index.js';

/**
 * 封面代理 —— 解决浏览器跨域加载 bilibili 封面时的 ORB(ERR_BLOCKED_BY_ORB)拦截。
 *
 * bilibili 封面 URL 是 https://i1/i2.hdslb.com/...。浏览器 <img> 直连跨域有时被
 * Chrome 的 ORB 拦(判定响应不透明)。方案:让浏览器请求**同源**的 /api/cover,
 * 由后端**按需转发** CDN(浏览器请求一张,后端转发一张,不是批量下载,零风控风险)。
 *
 * **磁盘缓存**:首次从 bilibili 拉取后存到本地 `data/covers/`,以后直接从磁盘读,
 * 零网络、零 bilibili 请求。彻底解决"每次都读 bilibili"和跨域问题。
 *
 * 安全:只允许 hdslb.com 封面 CDN 域名,拒绝任意 URL 代理(防 SSRF)。
 */

/** bilibili 封面 CDN 的分片域名是 i0 ~ i9(实测见过 i0/i1/i2)。
 *  用模式匹配而不是枚举 —— 枚举漏一个就破图(我们最初就漏了 i0)。 */
const ALLOWED_HOST_RE = /^i\d\.hdslb\.com$/;

export interface CoverDeps {
  db: Database.Database;
  log: Logger;
  /** 注入点:测试用假的,生产用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 注入点:磁盘缓存目录(测试用临时目录) */
  cacheDir?: string;
}

interface CoverQuery {
  url?: string;
}

/** 默认磁盘缓存目录:server/data/covers/ */
const DEFAULT_CACHE_DIR = 'data/covers';
/** 磁盘缓存文件名 = URL 的 sha256 */
const cacheFile = (dir: string, url: string) =>
  join(dir, `${createHash('sha256').update(url).digest('hex')}.jpg`);

export function registerCoverRoutes(app: FastifyInstance, deps: CoverDeps): void {
  const { log } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cacheDir = deps.cacheDir ?? DEFAULT_CACHE_DIR;
  // 确保磁盘缓存目录存在(better-sqlite3 不建目录,我们这里也要自己建)
  mkdirSync(cacheDir, { recursive: true });

  app.get('/api/cover', async (req: FastifyRequest, reply: FastifyReply) => {
    const { url } = req.query as CoverQuery;
    if (!url || typeof url !== 'string') {
      return reply.code(400).send({ error: '缺少 url 参数' });
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({ error: 'url 无效' });
    }

    // 只允许 http/https + 封面 CDN 域名(防 SSRF)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return reply.code(400).send({ error: '只允许 http(s) 协议' });
    }
    if (!ALLOWED_HOST_RE.test(parsed.hostname)) {
      return reply.code(400).send({ error: '只允许代理 bilibili 封面 CDN' });
    }

    // 磁盘缓存优先:已下载过的封面直接从本地读,零网络
    const file = cacheFile(cacheDir, url);
    if (existsSync(file)) {
      try {
        const body = readFileSync(file);
        return reply
          .header('content-type', 'image/jpeg')
          .header('cache-control', 'public, max-age=3600')
          .send(body);
      } catch {
        // 读取失败就当缓存损坏,重新拉一次
      }
    }

    try {
      const res = await fetchImpl(parsed.toString());
      if (!res.ok) {
        log.event({
          level: 'warn',
          category: 'api',
          code: `COVER_${res.status}`,
          message: `封面代理失败:${res.status}`,
          detail: { url: parsed.hostname },
        });
        return reply.code(502).send({ error: 'CDN 返回失败' });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') ?? 'image/jpeg';

      // 拉到了就存盘 —— 以后直接从本地读,不再碰 bilibili
      try {
        writeFileSync(file, buf);
      } catch (e) {
        log.event({
          level: 'warn', category: 'api', code: 'COVER_CACHE_WRITE_FAILED',
          message: `封面写盘失败:${(e as Error)?.message ?? e}`,
        });
      }

      return reply
        .header('content-type', type)
        .header('cache-control', 'public, max-age=3600')
        .send(buf);
    } catch (e) {
      log.event({
        level: 'error',
        category: 'api',
        code: 'COVER_FETCH_FAILED',
        message: `封面代理异常:${(e as Error)?.message ?? e}`,
      });
      return reply.code(502).send({ error: '代理失败' });
    }
  });
}
