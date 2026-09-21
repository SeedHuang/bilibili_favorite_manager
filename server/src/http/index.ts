import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import type { BiliClient } from '../bilibili/client.js';
import { corsOrigin } from './cors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerCoverRoutes } from './routes/cover.js';
import { registerItemRoutes } from './routes/items.js';
import { registerSseRoutes } from './routes/sse.js';
import { registerCuratorRoutes } from '../curator/routes.js';
import { registerRuleRoutes } from '../curator/ruleRoutes.js';
import { registerTagRoutes } from '../curator/tagRoutes.js';
import { registerProposalRoutes } from '../curator/proposalRoutes.js';
import { registerPollsRoutes } from '../curator/settingsPolls.js';

export interface HttpDeps {
  db: Database.Database;
  log: Logger;
  /** 带凭证/指纹的客户端 —— 授权验证与状态检查用 */
  client: BiliClient;
  /** 注入点:封面代理的 fetch(测试用假的) */
  coverFetchImpl?: typeof fetch;
  /** 注入点:Ollama 模型发现的 fetch(测试用假的,别真去连本机 Ollama) */
  ollamaFetchImpl?: typeof fetch;
}

export function createServer(deps: HttpDeps): FastifyInstance {
  const { db, log } = deps;
  const app = Fastify({ logger: false }); // 用我们自己的 Logger,不叠 pino

  /**
   * 空 body + `content-type: application/json` 当作"没有 body",不是错误。
   *
   * Fastify 默认会抛 `FST_ERR_CTP_EMPTY_JSON_BODY` → 400,而且**在进 handler 之前**,
   * 所以业务代码没机会记日志、响应里也没有 `reason`,前端只能显示一句
   * "请求失败 400"。而"无 body 的 DELETE / POST"是完全正常的用法
   * (删夹子、一键还原、归档会话、撤回方案四个都是)。
   *
   * 前端 `json()` 那头也已经改成"没 body 就不设 content-type" —— 两边都堵,
   * 因为这属于"客户端多发一个头"就会踩的坑,不该只靠一边自觉。
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body).trim();
    if (text === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      // **必须自己挂 statusCode: 400** —— Fastify 原生的 JSON parser 会挂,
      // 换掉它却不补这一手,坏 JSON 就从 400 变成 500(测试抓到的)。
      // 宽容只能宽容"空 body",不能宽容到把语法错误也接住。
      const err = e as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  /**
   * CORS —— **前端 dev 直连后端,不走 umi 代理**。
   *
   * 为什么:umi dev server 的 proxy 对 SSE 缓冲、对 POST 会整体挂(用户反复撞的
   * "接口 pending"根因就是它)。既然后端 3001 和前端 8000 都是本机,前端直接
   * `fetch('http://127.0.0.1:3001/api/...')` 绕开代理,后端放行跨域即可。
   *
   * **只回显白名单内的 origin**(cors.ts):本机工具,别让任意网页都能驱动它。
   * 只放行本项目用的方法。
   */
  app.addHook('onSend', async (req, reply) => {
    const origin = corsOrigin(req.headers.origin);
    // 只有回显具体 origin 时才需要 Vary —— 免得中介缓存把 A 源的内容喂给 B 源
    if (origin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type');
  });
  // 预检请求必须**命中一条路由**,onSend 钩子才会跑 —— 加通配 OPTIONS 路由收下它们
  app.options('*', async (_req, reply) => reply.code(204).send());

  app.get('/api/health', async () => {
    const folders = (db.prepare(`SELECT COUNT(*) AS n FROM folders`).get() as { n: number }).n;
    const items = (db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n;
    return { ok: true, folders, items };
  });

  // 全部路由在这里组装 —— 业务代码只依赖 HttpDeps 的 { db, log, client }
  registerAuthRoutes(app, deps);
  registerFolderRoutes(app, deps);
  registerItemRoutes(app, deps);
  registerSseRoutes(app, deps);
  registerCoverRoutes(app, { db, log, fetchImpl: deps.coverFetchImpl });
  registerCuratorRoutes(app, {
    db,
    log,
    ...(deps.ollamaFetchImpl ? { ollamaFetchImpl: deps.ollamaFetchImpl } : {}),
  });
  registerRuleRoutes(app, { db, log });
  registerTagRoutes(app, { db, log });
  registerProposalRoutes(app, { db, log });
  registerPollsRoutes(app, { db });

  return app;
}

/** 供开发/测试:启动到某端口 */
export async function startServer(
  deps: HttpDeps,
  port = 3001,
): Promise<FastifyInstance> {
  const app = createServer(deps);
  await app.listen({ port, host: '127.0.0.1' });
  return app;
}
