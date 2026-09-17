import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rateLimiter.js';

/** 记录每次 sleep 了多久,不真等 */
function fakeSleep() {
  const slept: number[] = [];
  return {
    slept,
    impl: async (ms: number) => {
      slept.push(ms);
    },
  };
}

describe('RateLimiter', () => {
  it('第一次 acquire 不等待', async () => {
    const s = fakeSleep();
    const rl = new RateLimiter({ sleepImpl: s.impl });
    await rl.acquire('read');
    expect(s.slept).toEqual([]);
  });

  it('读操作间隔落在 1200±400ms 内', async () => {
    const s = fakeSleep();
    const rl = new RateLimiter({ sleepImpl: s.impl });
    await rl.acquire('read');
    await rl.acquire('read');
    expect(s.slept).toHaveLength(1);
    expect(s.slept[0]).toBeGreaterThanOrEqual(800);
    expect(s.slept[0]).toBeLessThanOrEqual(1600);
  });

  it('写操作间隔落在 2500±1000ms 内', async () => {
    const s = fakeSleep();
    const rl = new RateLimiter({ sleepImpl: s.impl });
    await rl.acquire('write');
    await rl.acquire('write');
    expect(s.slept[0]).toBeGreaterThanOrEqual(1500);
    expect(s.slept[0]).toBeLessThanOrEqual(3500);
  });

  it('写操作至少比读操作慢', async () => {
    const s = fakeSleep();
    const rl = new RateLimiter({ sleepImpl: s.impl });
    await rl.acquire('read');
    await rl.acquire('read');
    await rl.acquire('write');
    // 第二次 acquire 是写,取的是写档位的下界
    expect(s.slept[1]).toBeGreaterThanOrEqual(1500);
  });

  it('间隔带抖动:20 次里至少出现 5 个不同的值', async () => {
    const s = fakeSleep();
    const rl = new RateLimiter({ sleepImpl: s.impl });
    for (let i = 0; i < 21; i++) await rl.acquire('read');
    expect(new Set(s.slept).size).toBeGreaterThanOrEqual(5);
  });

  it('并发调用被串行化,不并发放行', async () => {
    const s = fakeSleep();
    const rl = new RateLimiter({ sleepImpl: s.impl });
    await Promise.all([rl.acquire('read'), rl.acquire('read'), rl.acquire('read')]);
    // 3 次调用 → 2 次等待(第 1 次不等待)
    expect(s.slept).toHaveLength(2);
  });
});
