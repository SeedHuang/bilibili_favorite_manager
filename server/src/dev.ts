/**
 * 开发入口:`npm run dev -w server`(根 `npm run dev` 会带起它)。
 * 打开 SQLite → 组装 Fastify(全部路由)→ 监听 3001。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db/index.js';
import { Logger } from './logger/index.js';
import { startServer } from './http/index.js';
import { BiliClient } from './bilibili/client.js';
import { fetchFingerprint } from './bilibili/fingerprint.js';
import { getSetting } from './db/repo/state.js';
import { decryptSecret } from './security/dpapi.js';
import { KEY_SESSDATA, KEY_BILIJCT } from './http/routes/auth.js';

const dbPath = process.env.DB_PATH ?? 'data/app.db';
// SQLite 不能在不存在的目录里建文件 —— 首次运行时 data/ 还没有
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const log = new Logger(db);

/** 已授权时把凭证解出来挂到客户端上(未授权则没有);status 路由会按当前设置现读现用 */
function credential(key: string): string | undefined {
  const stored = getSetting(db, key);
  return stored ? decryptSecret(stored) ?? undefined : undefined;
}

// 设备指纹(buvid3/buvid4):只签名不带它会被判 -352。取不到也要能起服务(离线开发)。
const fingerprint = await fetchFingerprint().catch(() => {
  log.event({ level: 'warn', category: 'api', message: '获取设备指纹失败 —— 请求可能触发风控(-352)' });
  return undefined;
});

const client = new BiliClient({
  fingerprint,
  sessdata: credential(KEY_SESSDATA),
  bilijct: credential(KEY_BILIJCT),
});
// 记 api_calls(spec §6)。应用层没有 traceId,传 undefined。
client.setRequestListener((r) => log.apiCall(undefined, r));

await startServer({ db, log, client }, 3001);
console.log(`server on http://127.0.0.1:3001, db=${dbPath}`);
