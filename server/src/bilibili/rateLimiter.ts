export interface RateLimiterOpts {
  readMs: number;
  readJitterMs: number;
  writeMs: number;
  writeJitterMs: number;
  /** 注入点:测试里传假的,避免真等 */
  sleepImpl: (ms: number) => Promise<void>;
}

const DEFAULTS: Omit<RateLimiterOpts, 'sleepImpl'> = {
  readMs: 1200,
  readJitterMs: 400,
  writeMs: 2500,
  writeJitterMs: 1000,
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 全局串行的限速器。
 *
 * 三条刻意的设计(spec §8):
 * 1. 间隔带随机抖动 —— 固定间隔是最典型的机器人特征
 * 2. 写操作明显慢于读操作 —— 写是风控的主要触发点
 * 3. 全局串行,不发并发 —— 单账号并发请求本身就是异常信号
 */
export class RateLimiter {
  private readonly opts: RateLimiterOpts;
  /** 串行链:每次 acquire 挂到链尾 */
  private chain: Promise<void> = Promise.resolve();
  private lastAt = 0;

  constructor(opts: Partial<RateLimiterOpts> = {}) {
    this.opts = { ...DEFAULTS, sleepImpl: realSleep, ...opts };
  }

  acquire(kind: 'read' | 'write' = 'read'): Promise<void> {
    const next = this.chain.then(() => this.wait(kind));
    // 吞掉异常,避免一次失败炸掉整条链
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async wait(kind: 'read' | 'write'): Promise<void> {
    const base = kind === 'write' ? this.opts.writeMs : this.opts.readMs;
    const jitter = kind === 'write' ? this.opts.writeJitterMs : this.opts.readJitterMs;

    if (this.lastAt !== 0) {
      const target = base + (Math.random() * 2 - 1) * jitter;
      const elapsed = Date.now() - this.lastAt;
      const remaining = Math.round(target - elapsed);
      if (remaining > 0) await this.opts.sleepImpl(remaining);
    }
    this.lastAt = Date.now();
  }
}
