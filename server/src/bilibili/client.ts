import { extractMixinKey, signParams, type WbiKeys } from './wbi.js';
import { RateLimiter } from './rateLimiter.js';
import { classify, isRetryable, RiskControlError, type BiliError } from './errors.js';
import { BROWSER_UA, type Fingerprint } from './fingerprint.js';

const BASE = 'https://api.bilibili.com';
const NAV_PATH = '/x/web-interface/nav';
const MAX_READ_RETRIES = 3;

export interface BiliClientOpts {
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  fingerprint?: Fingerprint;
  sessdata?: string;
  bilijct?: string;
  /** 注入点:重试之间的等待,测试里不真等 */
  retrySleepImpl?: (ms: number) => Promise<void>;
  /** 每次请求(含每次重试)结束后上报一条记录 —— 给 logger 写 api_calls 用 */
  onRequest?: (r: RequestRecord) => void;
}

/** 一次 HTTP 往返的记录。风控失败也要上报,否则日志会缺最关键的一条。 */
export interface RequestRecord {
  method: 'GET';
  path: string;
  params?: Record<string, unknown>;
  httpStatus: number;
  code: number;
  durationMs: number;
  /** 第几次尝试,从 1 开始 */
  attempt: number;
  /** 响应体前 200 字符(已由调用方决定是否记录) —— 这里不做脱敏,脱敏在 logger */
  responseExcerpt: string;
}

interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

/**
 * bilibili API 的唯一出口。
 *
 * 这个类是 spec C3 的落实点:业务层拿不到裸 fetch,所有请求都过限速器,
 * 所有错误都过分类,写操作永不自动重试(C4)。
 */
export class BiliClient {
  readonly fetchImpl: typeof fetch;
  readonly limiter: RateLimiter;
  readonly fingerprint?: Fingerprint;
  readonly sessdata?: string;
  readonly bilijct?: string;
  readonly retrySleep: (ms: number) => Promise<void>;
  private onRequest?: (r: RequestRecord) => void;
  /** 按天缓存 —— mixinKey 每日轮换 */
  private wbiCache?: { keys: WbiKeys; day: string };

  constructor(opts: BiliClientOpts = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = opts.limiter ?? new RateLimiter();
    this.fingerprint = opts.fingerprint;
    this.sessdata = opts.sessdata;
    this.bilijct = opts.bilijct;
    this.retrySleep =
      opts.retrySleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onRequest = opts.onRequest;
  }

  /** 设置请求上报钩子。同步引擎在每次 run 开始时用它把 api_calls 串到本次 trace 上。 */
  setRequestListener(fn: ((r: RequestRecord) => void) | undefined): void {
    this.onRequest = fn;
  }

  /** 返回一个共享 fingerprint/limiter 但换掉凭证的新实例(授权验证用) */
  withCredentials(sessdata: string, bilijct: string): BiliClient {
    return new BiliClient({
      fetchImpl: this.fetchImpl,
      limiter: this.limiter,
      fingerprint: this.fingerprint,
      sessdata,
      bilijct,
      retrySleepImpl: this.retrySleep,
      onRequest: this.onRequest,
    });
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** 上报请求记录。日志失败绝不能影响主流程 —— 尤其不能顶掉 RiskControlError。 */
  private report(r: RequestRecord): void {
    try {
      this.onRequest?.(r);
    } catch (err) {
      // 刻意吞掉:审计日志写失败不该改变请求结果。
      // 但留个痕 —— 完全静默的话钩子坏了根本查不出来。
      // 只能走 console:logger 正是这个钩子的下游,在这里调 logger.event 会递归。
      console.error('[logger] onRequest 回调失败', err);
    }
  }

  private buildHeaders(): Record<string, string> {
    const cookies: string[] = [];
    if (this.fingerprint) {
      cookies.push(`buvid3=${this.fingerprint.buvid3}`);
      cookies.push(`buvid4=${this.fingerprint.buvid4}`);
    }
    if (this.sessdata) cookies.push(`SESSDATA=${this.sessdata}`);
    if (this.bilijct) cookies.push(`bili_jct=${this.bilijct}`);

    const headers: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      Referer: 'https://www.bilibili.com/',
    };
    if (cookies.length) headers['Cookie'] = cookies.join('; ');
    return headers;
  }

  /** 从 nav 拿 wbi keys,按天缓存 */
  async ensureWbiKeys(): Promise<WbiKeys> {
    const day = this.today();
    if (this.wbiCache && this.wbiCache.day === day) return this.wbiCache.keys;

    await this.limiter.acquire('read');
    const startedAt = Date.now();
    const res = await this.fetchImpl(`${BASE}${NAV_PATH}`, {
      headers: this.buildHeaders(),
    });
    const durationMs = Date.now() - startedAt;
    const body = (await res.json()) as ApiEnvelope<{
      wbi_img?: { img_url?: string; sub_url?: string };
    }>;

    // nav 也是一次 B站请求,spec §6 要求 api_calls 记每一次。
    // 响应体已由 res.json() 吃掉,所以截断的是重新序列化的结果
    // (语义等价,只是丢了原始空白)。HTML 响应会在上面一行就 throw,报不上 —— 既有行为。
    this.report({
      method: 'GET', path: NAV_PATH, httpStatus: res.status,
      code: body.code, durationMs, attempt: 1,
      responseExcerpt: JSON.stringify(body).slice(0, 200),
    });

    const imgUrl = body.data?.wbi_img?.img_url;
    const subUrl = body.data?.wbi_img?.sub_url;
    if (!imgUrl || !subUrl) {
      throw new Error(`nav 接口未返回 wbi_img:code=${body.code} ${body.message ?? ''}`);
    }
    const pick = (u: string) => u.split('/').pop()!.split('.')[0]!;
    const keys: WbiKeys = {
      imgKey: pick(imgUrl),
      subKey: pick(subUrl),
      mixinKey: extractMixinKey(pick(imgUrl), pick(subUrl)),
    };
    this.wbiCache = { keys, day };
    return keys;
  }

  /**
   * GET 请求。
   *
   * @param signed 是否加 wbi 签名。实测确认 fav/folder/created/list-all 不需要,
   *               传 false 可少一次 nav 请求。
   */
  async get<T>(
    path: string,
    params: Record<string, string | number> = {},
    opts: { signed?: boolean } = {},
  ): Promise<T | null> {
    const signed = opts.signed ?? true;
    let query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    ).toString();

    if (signed) {
      const { mixinKey } = await this.ensureWbiKeys();
      query = signParams(params, mixinKey);
    }

    const url = `${BASE}${path}?${query}`;
    let lastErr: BiliError | null = null;

    for (let attempt = 1; attempt <= MAX_READ_RETRIES; attempt++) {
      if (attempt > 1) await this.retrySleep(300 * 2 ** (attempt - 2));

      await this.limiter.acquire('read');

      const startedAt = Date.now();
      const res = await this.fetchImpl(url, { headers: this.buildHeaders() });
      const durationMs = Date.now() - startedAt;

      // HTTP 状态码 412 直接视为风控,不看 body —— 412 从不值得解析,
      // 无论它是 HTML 还是 JSON,正确的反应都是"停下,不重试"。
      // (实测/资料显示 bilibili 多数返回 200 + code:-412,但也有 HTTP 412 形态)
      if (res.status === 412) {
        this.report({
          method: 'GET', path, params, httpStatus: 412, code: -412,
          durationMs, attempt, responseExcerpt: '',
        });
        throw new RiskControlError(
          'HTTP 412:请求被风控拦截,已停止。请去 bilibili 过一次验证码,不要重试。',
          -412,
          res.status,
        );
      }

      const text = await res.text();
      const excerpt = text.slice(0, 200);

      let body: ApiEnvelope<T>;
      try {
        body = JSON.parse(text) as ApiEnvelope<T>;
      } catch {
        this.report({
          method: 'GET', path, params, httpStatus: res.status, code: 0,
          durationMs, attempt, responseExcerpt: excerpt,
        });
        // 返回 HTML 说明被拦截了,当作 HTTP 层面的失败
        const err = classify(0, res.status === 200 ? 503 : res.status, excerpt);
        if (!err) throw new Error('无法解析响应');
        lastErr = err;
        if (!isRetryable(err, 'read')) throw err;
        continue;
      }

      this.report({
        method: 'GET', path, params, httpStatus: res.status, code: body.code,
        durationMs, attempt, responseExcerpt: excerpt,
      });

      const err = classify(body.code, res.status, body.message ?? '');
      if (!err) {
        // code:0 但 data 为 null/undefined 是合法响应,不是错误。
        // 实测:`fav/folder/created/list-all` 在用户没有某类收藏夹时就返回 data:null。
        // 所以契约是 `T | null` —— 类型系统强制调用方处理空值(如 `?? []`),
        // 比在这里抛错更安全:抛错会把"没有文章收藏夹"这种正常情况变成报错。
        return (body.data ?? null) as T | null;
      }

      lastErr = err;
      if (!isRetryable(err, 'read')) throw err;
    }

    throw lastErr ?? new Error('请求失败');
  }
}
