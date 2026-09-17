/**
 * M2 真实全量同步验证 —— 手工运行。
 *
 *   npm run probe:sync
 *
 * 它做一件 M1 探针做不了的事:**真的把 3480 条拉下来存进 SQLite**,
 * 然后报告耗时、attr 分布、以及是否有条目被判定为失效。
 *
 * 只读。不写任何远程数据。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from '../db/index.js';
import { Logger } from '../logger/index.js';
import { BiliClient } from '../bilibili/client.js';
import { fetchFingerprint } from '../bilibili/fingerprint.js';
import { RateLimiter } from '../bilibili/rateLimiter.js';
import { runSync } from '../sync/engine.js';
import { promptCookie } from './prompt.js';

// DB_PATH env 优先(与 dev.ts 一致),方便探针直接灌进 app.db 给前端看;其次命令行参数
const DB_PATH = process.env.DB_PATH ?? process.argv[2] ?? 'data/app.db';
// better-sqlite3 不会自动建目录 —— 少了这行首次运行会直接抛错
mkdirSync(dirname(DB_PATH), { recursive: true });

const { sessdata, bilijct } = await promptCookie();
if (!sessdata || !bilijct) {
  console.log('需要登录态才能同步自己的收藏夹。\n');
  process.exit(0);
}

console.log('① 获取设备指纹 ...');
const fp = await fetchFingerprint();

const limiter = new RateLimiter({
  readMs: 1200, readJitterMs: 400, writeMs: 2500, writeJitterMs: 1000,
});

const db = openDb(DB_PATH);
const log = new Logger(db);
const client = new BiliClient({ fingerprint: fp, limiter, sessdata, bilijct });

console.log(`② 开始全量同步(库=${DB_PATH})...\n`);

const me = await client.get<{ mid?: number }>('/x/web-interface/nav');
const upMid = me?.mid;
if (!upMid) {
  console.log('❌ 拿不到 mid —— cookie 可能已过期。\n');
  process.exit(1);
}

const report = await runSync({ client, db, log }, upMid, {
  full: true,
  onProgress: (p) => {
    if (p.phase === 'items') {
      process.stdout.write(`\r   同步中 ${p.current}/${p.total} ${p.folderTitle ?? ''}          `);
    }
  },
});
process.stdout.write('\n\n');

console.log('=== 同步报告 ===');
console.log(`收藏夹:     ${report.folders} 个`);
console.log(`本次同步:   ${report.foldersSynced} 个夹子,${report.items} 条`);
console.log(`耗时:       ${(report.durationMs / 1000).toFixed(1)}s`);
console.log(`traceId:    ${report.traceId}\n`);

// ③ attr 分布 —— 这是 M1 一直没抓到的答案
const attrDist = db
  .prepare(
    `SELECT invalid, COUNT(*) AS n FROM items GROUP BY invalid ORDER BY invalid`,
  )
  .all() as { invalid: number; n: number }[];
console.log('=== 失效标记(attr 判定)分布 ===');
for (const row of attrDist) {
  console.log(`  invalid=${row.invalid}: ${row.n} 条`);
}
console.log('  ⚠️ 如果 invalid=1 是 0 条,说明这批收藏里没有失效内容(正常);');
console.log('     若有,请抽查几条确认判定是否正确,并把结论回写 spec §14。\n');

// ④ 总量与 API 调用统计
const totals = db
  .prepare(`SELECT (SELECT COUNT(*) FROM folders) AS folders, (SELECT COUNT(*) FROM items) AS items,
            (SELECT COUNT(*) FROM folder_items) AS links, (SELECT COUNT(*) FROM api_calls) AS calls`)
  .get() as Record<string, number>;
console.log('=== 本地库统计 ===');
console.log(`folders=${totals['folders']} items=${totals['items']} links=${totals['links']}`);
console.log(`API 调用 ${totals['calls']} 次,平均 ${(report.durationMs / Math.max(1, totals['calls']!)).toFixed(0)}ms/次\n`);

const errs = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE level='error'`).get() as { n: number };
console.log(`错误事件: ${errs.n} 条${errs.n > 0 ? '(见 events 表)' : ''}`);
console.log('\n=== 验证结束。请把上面结果回写 spec §14 ===');
