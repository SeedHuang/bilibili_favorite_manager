/**
 * M1 真实 API 探针 —— 手工运行。
 *
 *   npm run probe:live
 *
 * 它回答这些问题:
 *   1. 无 cookie 的公开接口能通吗?(预期:能)
 *   2. wbi 签名的接口,只有 buvid3 能通吗?(预期:能)
 *   3. 自己的收藏夹列表能拉到吗?(需要 cookie,运行时交互式粘贴)
 *   4. fav/resource/list 到底返回哪些字段?(spec §14 待验证 #2)
 *   5. fav/resource/list 要不要 wbi?(M2 同步引擎的前提)
 *
 * 只读。这个脚本不发任何写请求。
 * cookie 由运行时交互式粘贴,不落盘、不读文件。
 */
import { BiliClient } from '../bilibili/client.js';
import { fetchFingerprint } from '../bilibili/fingerprint.js';
import { RateLimiter } from '../bilibili/rateLimiter.js';
import { BiliError, RiskControlError } from '../bilibili/errors.js';
import { promptCookie } from './prompt.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function report(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? '✅' : '❌'} ${label}\n   ${detail}\n`);
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> {
  try {
    return { ok: true, v: await fn() };
  } catch (e) {
    return { ok: false, e };
  }
}

/** 失败信息 —— 非 BiliError(HTML 拦截页、网络层错误)也要读得出来,不能报 code=undefined */
function explain(e: unknown): string {
  if (e instanceof BiliError) return `code=${e.code} ${e.message}`;
  return `非业务错误:${(e as Error)?.message ?? String(e)}`;
}

const { sessdata, bilijct } = await promptCookie();
const hasLogin = Boolean(sessdata && bilijct);

console.log('=== M1 风控探针 ===');
console.log(`登录态:${hasLogin ? '有' : '无(第 3、4 项会跳过)'}\n`);

// 限速器调慢一点:这是真实账号,不赶时间
const limiter = new RateLimiter({ readMs: 2000, readJitterMs: 500, writeMs: 4000, writeJitterMs: 1000 });

console.log('① 获取设备指纹 ...');
const fpRes = await attempt(() => fetchFingerprint());
if (!fpRes.ok) {
  report('设备指纹', false, explain(fpRes.e));
  process.exit(1);
}
const fp = fpRes.v;
report('设备指纹', true, `buvid3=${fp.buvid3.slice(0, 18)}… (${fp.buvid3.length} 字符)`);

// ② 公开接口,不签名
{
  const c = new BiliClient({ fingerprint: fp, limiter });
  const r = await attempt(() =>
    c.get<{ list?: unknown[] }>('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
  );
  // code 0 但 data 为 null 是合法响应(up_mid=2 没有公开收藏夹),
  // 说明接口通了 —— 别把它报成失败。
  const detail = !r.ok
    ? explain(r.e)
    : r.v === null
      ? 'code 0,data 为 null —— 接口通,只是 up_mid=2 没有公开收藏夹'
      : `返回 ${JSON.stringify(r.v).slice(0, 120)}`;
  report('② 公开接口(不签名)', r.ok, detail);
  await sleep(2500);
}

// ③ wbi 签名接口,只带 buvid3
{
  const c = new BiliClient({ fingerprint: fp, limiter });
  const r = await attempt(() => c.get('/x/space/wbi/arc/search', { mid: 2, ps: 3, pn: 1, order: 'pubdate' }));
  report(
    '③ wbi 签名接口(仅 buvid3)',
    r.ok,
    r.ok ? '通过 —— buvid3 确实是必需且充分的一环' : explain(r.e),
  );
  // ③ 是提示性的,不再中断。
  // 理由:它打的是 arc/search —— 实测这是最容易触发风控的接口,而且 M2 不用它。
  // 而 ④⑤ 打的是 list-all / resource/list,属于宽容的一类,才是 M2 真正的依赖。
  // 让 ③ 的抖动挡住 ④⑤,等于用最不重要的检查卡住最重要的检查。
  // (继续到「另一个」接口的一次请求,不是对已拦截接口的重试。)
  if (!r.ok && r.e instanceof RiskControlError) {
    console.log('   ⚠️ arc/search 撞上风控 —— 这是已知的、会自行恢复的抖动,继续 ④⑤。');
    console.log('      ④⑤ 用的是另外的接口(list-all / resource/list)。\n');
  }
  await sleep(2500);
}

if (!hasLogin) {
  console.log('⏭  跳过 ④⑤ —— 没有 SESSDATA,无法访问自己的收藏夹。\n');
  process.exit(0);
}

const c = new BiliClient({
  fingerprint: fp, limiter,
  sessdata: sessdata!, bilijct: bilijct!,
});

// ④ 自己的收藏夹列表
const me = await attempt(() => c.get<{ mid?: number }>('/x/web-interface/nav'));
if (!me.ok) {
  // 风控和 cookie 失效是两回事,混淆了会让人白折腾一轮重新授权
  const why =
    me.e instanceof RiskControlError
      ? '触发风控 —— 等一段时间再试,不要重新授权'
      : 'cookie 可能已过期 —— 需要重新授权';
  report('④ 读取自己的账号信息', false, `${explain(me.e)} —— ${why}`);
  process.exit(1);
}
const myMid = me.v?.mid ?? 0;
if (!myMid) {
  report('④ 读取自己的账号信息', false, '返回里没有 mid —— 登录态可能不完整');
  process.exit(1);
}
console.log(`   我的 mid = ${myMid}\n`);
await sleep(2500);

for (const type of [11, 21] as const) {
  const label = type === 11 ? '视频收藏夹' : '文章收藏夹';
  const r = await attempt(() =>
    c.get<{ list?: Array<{ id: number; title: string; media_count?: number }> }>(
      '/x/v3/fav/folder/created/list-all',
      { up_mid: myMid, type },
      { signed: false },
    ),
  );
  // data 可能是 null / 缺 list 字段(实测见过),不能直接点进去
  const list = (r.ok ? r.v?.list : undefined) ?? [];
  report(
    `④ 收藏夹列表 / ${label}`,
    r.ok,
    r.ok ? `${list.length} 个,共 ${list.reduce((s, f) => s + (f.media_count ?? 0), 0)} 条` : explain(r.e),
  );

  // 夹子对象的字段结构 —— M2 的增量判据完全取决于有没有可用的变更信号。
  // 特别要看:有没有 mtime / ctime?有没有 intro / privacy?没有的话
  // 「只拉变化的夹子」这条就得换思路。
  if (r.ok && list.length > 0) {
    const folder = list[0] as Record<string, unknown>;
    console.log(`   夹子字段(${label}):`);
    console.log(`   ${Object.keys(folder).join(', ')}\n`);
    console.log('   第一个夹子样例:');
    console.log(`   ${JSON.stringify(folder, null, 2).slice(0, 700)}\n`);
    const hasMtime = 'mtime' in folder || 'ctime' in folder;
    console.log(
      hasMtime
        ? '   ✅ 有变更时间字段 —— 增量判据可用\n'
        : '   ❌ 没有 mtime/ctime —— 增量判据要换思路(M2 待解)\n',
    );
  }
  await sleep(2500);

  // ⑤ 拿第一个夹子看条目字段(spec §14 待验证 #2)
  //    顺带回答 M2 的关键问题:fav/resource/list 到底要不要 wbi?
  //    先试不签名,失败再试签名 —— 两边的结果都记录下来。
  if (list.length > 0) {
    const folder = list[0]!;
    const params = { media_id: folder.id, pn: 1, ps: 5, platform: 'web' };
    type Items = { medias?: Record<string, unknown>[] };

    let signed = false;
    let items = await attempt(() => c.get<Items>('/x/v3/fav/resource/list', params, { signed: false }));
    if (!items.ok) {
      await sleep(2500);
      signed = true;
      items = await attempt(() => c.get<Items>('/x/v3/fav/resource/list', params));
    }

    const medias = (items.ok ? items.v?.medias : undefined) ?? [];
    if (medias.length > 0) {
      console.log(`⑤ fav/resource/list —— 来自「${folder.title}」`);
      console.log(`   签名:${signed ? '⚠️ 需要 wbi(不签名被拒)' : '✅ 不需要 wbi'}\n`);
      console.log(`   返回字段:\n   ${Object.keys(medias[0]!).join(', ')}\n`);
      console.log('   第一条样例:');
      console.log(`   ${JSON.stringify(medias[0], null, 2).slice(0, 1200)}\n`);
      console.log('   ⚠️ 重点看:是否有分区名(tname)、失效标记(attr)、简介(intro)。');
      console.log('      这些直接决定 AI 分类的信号质量。结论回写 spec §14。\n');
    } else {
      report('⑤ fav/resource/list', false, items.ok ? '返回空 medias' : explain(items.e));
    }
    await sleep(2500);
  }
}

console.log('=== 探针结束。请把结果回写到 spec §14 ===');
