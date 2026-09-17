# M1 握手 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 bilibili API 的最小可信链路 —— wbi 签名、指纹 cookie、限速器、错误分类 —— 并用真实请求验证风控假设,确认这条路走得通。

**Architecture:** 纯后端,无 HTTP 服务、无数据库。`server/src/bilibili/` 是一个**可脱离一切外部依赖单测的客户端库** —— 所有网络调用通过注入的 `fetchImpl`,所有等待通过注入的 sleep。M1 的产出是一个可执行的探针脚本,它用真实 API 回答「风控这堵墙撞不撞得通」。

**Tech Stack:** Node 22.12 / TypeScript 5.9 / tsx / vitest 3 / npm workspaces

**Spec:** `docs/superpowers/specs/2026-09-14-bilibili-favorite-manager-design.md`

## Global Constraints

- Node 22.12.0,npm 10.9.0(本机已验证,不要引入需要更高版本的工具)
- `typescript@^5.9.3` —— **不要用 typescript 7**,那是原生重写版,与 vitest 3 / tsx 的兼容性未验证
- `@types/node@^22.20.2` —— 必须匹配 Node 22,**不要用 26.x**
- 所有源码 `"type": "module"`(ESM),类型导入一律用 `import type`
- `strict: true` + `noUncheckedIndexedAccess: true`
- **`bilibili/` 目录下的代码不许 import 任何 `db/`、`logger/`、`http/` 的东西** —— 它必须能独立单测(spec §4)
- **所有 API 请求必须经过限速器**,`BiliClient` 之外拿不到裸 `fetch`(spec C3)
- **网络调用一律通过注入的 `fetchImpl`** —— 测试里绝不打真实网络
- 代码注释用中文,与 spec 一致
- Commit message 用中文,结尾附 `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## 已实测确认的前提(2026-09-14)

这些值**已经用真实 API 请求验证过**,直接写进测试当黄金值,不要改动:

| 项 | 值 |
|---|---|
| img_key | `7cd084941338484aae1ad9425b84077c` |
| sub_key | `4932caff0ff746eab6f01bf08b70ac45` |
| **mixinKey** | `ea1db124af3c7062474693fa704f4ff8` |
| 签名输入 params | `{mid:2, ps:5, pn:1, order:'pubdate', wts:1757836800}` |
| 标准化后的 query | `mid=2&order=pubdate&pn=1&ps=5&wts=1757836800` |
| **w_rid** | `a9bf59715a7e12664ea8e8481de3d6d8` |

另外两条已验证的行为,决定了本计划的设计:

1. **`buvid3` 必需**:`space/wbi/arc/search` 只做 wbi 签名 → 被拦;再补 `buvid3` → `code 0`
2. **`fav/folder/created/list-all` 不需要 wbi** —— 可以直接请求

---

## File Structure

M1 只碰 `server/`,不建 `web/`(M3 才需要)。

| 文件 | 职责 |
|---|---|
| `package.json`(根) | npm workspaces + 便捷脚本 |
| `.gitignore` | node_modules / dist / *.db |
| `server/package.json` | 依赖与脚本 |
| `server/tsconfig.json` | TS 配置 |
| `server/vitest.config.ts` | 测试配置 |
| `server/src/bilibili/wbi.ts` | wbi 签名。**纯函数,无 IO** |
| `server/src/bilibili/wbi.test.ts` | 黄金值测试 |
| `server/src/bilibili/rateLimiter.ts` | 令牌桶 + 随机抖动。**纯逻辑,注入 sleep** |
| `server/src/bilibili/rateLimiter.test.ts` | 抖动区间 + 写档更慢 |
| `server/src/bilibili/errors.ts` | 错误分类。**纯函数** |
| `server/src/bilibili/errors.test.ts` | 错误码 → 类型映射 |
| `server/src/bilibili/fingerprint.ts` | 获取 buvid3/buvid4 |
| `server/src/bilibili/fingerprint.test.ts` | mock fetch |
| `server/src/bilibili/client.ts` | 组装:签名 + 指纹 + 限速 + 错误分类 |
| `server/src/bilibili/client.test.ts` | mock fetch 全链路 |
| `server/src/probes/verify-live.ts` | **手工跑的探针**,打真实 API |

依赖方向:`probes → client → {wbi, rateLimiter, errors, fingerprint}`。没有任何反向依赖。

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/vitest.config.ts`

**Interfaces:**
- Consumes: 无
- Produces: 可运行的 `npm test`(workspace 委托)、`tsx` 与 `vitest` 可用

- [ ] **Step 1: 创建根 `package.json`**

```json
{
  "name": "bilibili-favorite-manager",
  "private": true,
  "version": "0.0.0",
  "workspaces": ["server"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "probe:live": "npm run probe:live -w server"
  }
}
```

> 注意:`workspaces` 目前只有 `server`。M3 建 `web/` 时再加进去 —— 现在写 `"web"` 会因为目录不存在导致 install 失败。

- [ ] **Step 2: 创建 `.gitignore`**

```
node_modules/
dist/
*.db
*.db-journal
.env
.DS_Store
```

- [ ] **Step 3: 创建 `server/package.json`**

```json
{
  "name": "@bfm/server",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "probe:live": "tsx src/probes/verify-live.ts"
  },
  "devDependencies": {
    "@types/node": "^22.20.2",
    "tsx": "^4.23.13",
    "typescript": "^5.9.3",
    "vitest": "^3.2.7"
  }
}
```

> M1 **不装 fastify / better-sqlite3** —— 这两个 M2 才用得上。现在装是投机。

- [ ] **Step 4: 创建 `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 5: 创建 `server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 6: 安装依赖**

Run: `npm install`
Expected: 成功,生成 `node_modules/` 与 `package-lock.json`

- [ ] **Step 7: 验证工具链跑得起来**

Run: `npm run typecheck`
Expected: 无输出、退出码 0

Run: `npx vitest run --passWithNoTests`
Expected: 报告 "No test files found" 但退出码 0

- [ ] **Step 8: Commit**

```bash
git add package.json .gitignore server/package.json server/tsconfig.json server/vitest.config.ts package-lock.json
git commit -m "$(cat <<'EOF'
chore: 初始化 M1 脚手架(npm workspaces + TS + vitest)

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: wbi 签名

**Files:**
- Create: `server/src/bilibili/wbi.ts`
- Test: `server/src/bilibili/wbi.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `extractMixinKey(imgKey: string, subKey: string): string`
  - `signParams(params: Record<string, string | number>, mixinKey: string, wts?: number): string`
  - `interface WbiKeys { imgKey: string; subKey: string; mixinKey: string }`

- [ ] **Step 1: 写失败的测试**

`server/src/bilibili/wbi.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractMixinKey, signParams } from './wbi.js';

// 黄金值来自 2026-09-14 对真实 API 的实测,见计划文档「已实测确认的前提」
const IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';
const MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8';

describe('extractMixinKey', () => {
  it('用 64 位置换表从 img_key + sub_key 生成 32 位 mixinKey', () => {
    expect(extractMixinKey(IMG_KEY, SUB_KEY)).toBe(MIXIN_KEY);
  });

  it('两个 key 长度不是 32 时抛错', () => {
    expect(() => extractMixinKey('abc', SUB_KEY)).toThrow(/32/);
    expect(() => extractMixinKey(IMG_KEY, 'abc')).toThrow(/32/);
  });
});

describe('signParams', () => {
  it('按 key 排序、拼 wts、算出 w_rid', () => {
    const signed = signParams(
      { mid: 2, ps: 5, pn: 1, order: 'pubdate' },
      MIXIN_KEY,
      1757836800,
    );
    expect(signed).toBe(
      'mid=2&order=pubdate&pn=1&ps=5&wts=1757836800&w_rid=a9bf59715a7e12664ea8e8481de3d6d8',
    );
  });

  it('剥掉 !\'()* 这些字符', () => {
    const signed = signParams({ q: "a!b'c(d)e*f" }, MIXIN_KEY, 1757836800);
    expect(signed).toContain('q=abcdef');
  });

  it('调用方自己传的 wts 会被覆盖', () => {
    const signed = signParams({ wts: 1, mid: 2 }, MIXIN_KEY, 1757836800);
    expect(signed).toContain('wts=1757836800');
    expect(signed).not.toContain('wts=1&');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/bilibili/wbi.test.ts`
Expected: FAIL —— `Failed to resolve import "./wbi.js"`

- [ ] **Step 3: 写实现**

`server/src/bilibili/wbi.ts`:

```ts
import { createHash } from 'node:crypto';

/**
 * B 站的 mixinKey 置换表。从 img_key + sub_key 拼成的 64 位字符串里,
 * 按这个顺序取字符,再截前 32 位。
 */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

export interface WbiKeys {
  imgKey: string;
  subKey: string;
  mixinKey: string;
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** 从 nav 接口拿到的两个 32 位 hex key 生成 mixinKey */
export function extractMixinKey(imgKey: string, subKey: string): string {
  if (imgKey.length !== 32 || subKey.length !== 32) {
    throw new Error(
      `wbi key 长度必须是 32,实际 img=${imgKey.length} sub=${subKey.length}`,
    );
  }
  const raw = imgKey + subKey;
  return MIXIN_TAB.map((i) => raw[i]!).join('').slice(0, 32);
}

/**
 * 给参数签名。返回完整的 query string(含 w_rid),调用方直接拼到 URL 后面。
 *
 * 步骤:合并 wts → 按 key 排序 → urlencode 并剥掉 !'()* → md5(query + mixinKey)
 */
export function signParams(
  params: Record<string, string | number>,
  mixinKey: string,
  wts: number = Math.round(Date.now() / 1000),
): string {
  const merged: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(merged)
    .sort()
    .map((k) => {
      const v = String(merged[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/bilibili/wbi.test.ts`
Expected: PASS,5 个用例全绿

- [ ] **Step 5: Commit**

```bash
git add server/src/bilibili/wbi.ts server/src/bilibili/wbi.test.ts
git commit -m "$(cat <<'EOF'
feat(bilibili): wbi 签名实现,含真实 API 实测的黄金值测试

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 限速器

**Files:**
- Create: `server/src/bilibili/rateLimiter.ts`
- Test: `server/src/bilibili/rateLimiter.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface RateLimiterOpts { readMs: number; readJitterMs: number; writeMs: number; writeJitterMs: number }`
  - `class RateLimiter { constructor(opts?: Partial<RateLimiterOpts>); acquire(kind: 'read' | 'write'): Promise<void> }`

**设计要点:** sleep 通过构造参数注入,测试里不真等。间隔必须**带随机抖动** —— 固定间隔是机器人特征(spec §8)。全局串行(一个 promise 链),不发并发。

- [ ] **Step 1: 写失败的测试**

`server/src/bilibili/rateLimiter.test.ts`:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/bilibili/rateLimiter.test.ts`
Expected: FAIL —— `Failed to resolve import "./rateLimiter.js"`

- [ ] **Step 3: 写实现**

`server/src/bilibili/rateLimiter.ts`:

```ts
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
```

> **注意抖动断言与实现的关系**:测试用 `sleepImpl` 记录的是 `remaining`(目标间隔减去已耗时),而 `Date.now()` 在真实运行时几乎不流逝,所以 `remaining ≈ target`,落在 `[base-jitter, base+jitter]` 内。断言按这个区间写。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/bilibili/rateLimiter.test.ts`
Expected: PASS,6 个用例全绿

- [ ] **Step 5: Commit**

```bash
git add server/src/bilibili/rateLimiter.ts server/src/bilibili/rateLimiter.test.ts
git commit -m "$(cat <<'EOF'
feat(bilibili): 限速器 —— 随机抖动 + 写档更慢 + 全局串行

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 错误分类

**Files:**
- Create: `server/src/bilibili/errors.ts`
- Test: `server/src/bilibili/errors.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class BiliError extends Error { readonly code: number; readonly httpStatus: number }`
  - `class RiskControlError extends BiliError`(`-412` / `-352`)
  - `class AuthError extends BiliError`(`-101`)
  - `class RequestError extends BiliError`(其他业务码)
  - `class HttpError extends BiliError`(HTTP 非 200)
  - `classify(code: number, httpStatus: number, message: string): BiliError | null` —— 返回 `null` 表示成功
  - `isRetryable(err: BiliError, kind: 'read' | 'write'): boolean`

**关键约束**:写操作永不自动重试(spec C4)。

- [ ] **Step 1: 写失败的测试**

`server/src/bilibili/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  classify, isRetryable,
  RiskControlError, AuthError, RequestError, HttpError, BiliError,
} from './errors.js';

describe('classify', () => {
  it('code 0 且 HTTP 200 → null(成功)', () => {
    expect(classify(0, 200, 'OK')).toBeNull();
  });

  it('-412 是风控', () => {
    expect(classify(-412, 200, '请求被拦截')).toBeInstanceOf(RiskControlError);
  });

  it('-352 也是风控', () => {
    expect(classify(-352, 200, '风控校验失败')).toBeInstanceOf(RiskControlError);
  });

  it('-101 是未登录', () => {
    expect(classify(-101, 200, '账号未登录')).toBeInstanceOf(AuthError);
  });

  it('其他业务码是普通请求错误', () => {
    expect(classify(-400, 200, '请求错误')).toBeInstanceOf(RequestError);
  });

  it('HTTP 非 200 是 HttpError', () => {
    expect(classify(0, 500, 'Internal Server Error')).toBeInstanceOf(HttpError);
  });

  it('错误对象带上原始 code / httpStatus / message', () => {
    const e = classify(-412, 200, '请求被拦截')!;
    expect(e.code).toBe(-412);
    expect(e.httpStatus).toBe(200);
    expect(e.message).toContain('请求被拦截');
  });

  it('风控错误的 message 要提示去过验证码,而不是重试', () => {
    const e = classify(-412, 200, '请求被拦截') as BiliError;
    expect(e.message).toMatch(/停止|验证码/);
  });
});

describe('isRetryable', () => {
  it('读操作的 5xx 可重试', () => {
    expect(isRetryable(classify(0, 503, 'busy')!, 'read')).toBe(true);
  });

  it('写操作的 5xx 不可重试 —— 怕重复执行', () => {
    expect(isRetryable(classify(0, 503, 'busy')!, 'write')).toBe(false);
  });

  it('风控永远不可重试', () => {
    expect(isRetryable(classify(-412, 200, '拦截')!, 'read')).toBe(false);
    expect(isRetryable(classify(-412, 200, '拦截')!, 'write')).toBe(false);
  });

  it('业务错误码不可重试', () => {
    expect(isRetryable(classify(-400, 200, '请求错误')!, 'read')).toBe(false);
  });

  it('未登录不可重试', () => {
    expect(isRetryable(classify(-101, 200, '未登录')!, 'read')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/bilibili/errors.test.ts`
Expected: FAIL —— `Failed to resolve import "./errors.js"`

- [ ] **Step 3: 写实现**

`server/src/bilibili/errors.ts`:

```ts
export class BiliError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** -412 / -352:触发风控。唯一正确的反应是停下来,不是重试 */
export class RiskControlError extends BiliError {}

/** -101:未登录 / cookie 失效 */
export class AuthError extends BiliError {}

/** 其他业务错误码 */
export class RequestError extends BiliError {}

/** HTTP 层面的失败(5xx、网关错误等) */
export class HttpError extends BiliError {}

/** 成功返回 null,失败返回对应的错误对象 */
export function classify(
  code: number,
  httpStatus: number,
  message: string,
): BiliError | null {
  if (httpStatus !== 200) {
    return new HttpError(`HTTP ${httpStatus}:${message}`, code, httpStatus);
  }
  if (code === 0) return null;

  if (code === -412 || code === -352) {
    return new RiskControlError(
      `触发风控(${code} ${message})。已停止请求队列 —— 请去 bilibili 手动过一次验证码,不要重试。`,
      code,
      httpStatus,
    );
  }
  if (code === -101) {
    return new AuthError(`未登录(${code} ${message})。请重新设置 cookie。`, code, httpStatus);
  }
  return new RequestError(`请求失败(${code} ${message})`, code, httpStatus);
}

/**
 * 是否可以自动重试。
 *
 * 写操作永不自动重试(spec C4)—— 重试可能造成重复执行,
 * 宁可停下来让用户手动决定。
 */
export function isRetryable(err: BiliError, kind: 'read' | 'write'): boolean {
  if (kind === 'write') return false;
  return err instanceof HttpError;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/bilibili/errors.test.ts`
Expected: PASS,13 个用例全绿

- [ ] **Step 5: Commit**

```bash
git add server/src/bilibili/errors.ts server/src/bilibili/errors.test.ts
git commit -m "$(cat <<'EOF'
feat(bilibili): 错误分类 —— 风控不重试、写操作永不重试

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 指纹获取(buvid3 / buvid4)

**Files:**
- Create: `server/src/bilibili/fingerprint.ts`
- Test: `server/src/bilibili/fingerprint.test.ts`

**Interfaces:**
- Consumes: 注入的 `fetchImpl`
- Produces:
  - `interface Fingerprint { buvid3: string; buvid4: string }`
  - `async function fetchFingerprint(fetchImpl?: typeof fetch): Promise<Fingerprint>`

**为什么单独一个模块:** 实测确认 `buvid3` 是**必需且充分**的一环 —— 只做 wbi 签名不带 `buvid3` 会吃 `-352`,补上就通过(`space/wbi/arc/search`)。这是独立于签名的一条防线。

- [ ] **Step 1: 写失败的测试**

`server/src/bilibili/fingerprint.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { fetchFingerprint } from './fingerprint.js';

const okBody = {
  code: 0,
  message: '0',
  data: { b_3: 'BUV-3-VALUE', b_4: 'BUV-4-VALUE' },
};

function mockFetch(body: unknown, httpStatus = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: httpStatus,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('fetchFingerprint', () => {
  it('从 spi 接口取出 b_3 / b_4', async () => {
    const fp = await fetchFingerprint(mockFetch(okBody));
    expect(fp).toEqual({ buvid3: 'BUV-3-VALUE', buvid4: 'BUV-4-VALUE' });
  });

  it('请求打到正确的路径', async () => {
    const f = mockFetch(okBody);
    await fetchFingerprint(f);
    const url = String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url).toContain('/x/frontend/finger/spi');
  });

  it('带上浏览器 UA', async () => {
    const f = mockFetch(okBody);
    await fetchFingerprint(f);
    const init = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(String((init.headers as Record<string, string>)['User-Agent'])).toMatch(/Mozilla/);
  });

  it('code 非 0 时抛错', async () => {
    await expect(fetchFingerprint(mockFetch({ code: -412, message: '拦截' })))
      .rejects.toThrow(/指纹/);
  });

  it('data 缺字段时抛错', async () => {
    await expect(fetchFingerprint(mockFetch({ code: 0, data: { b_3: 'x' } })))
      .rejects.toThrow(/指纹/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/bilibili/fingerprint.test.ts`
Expected: FAIL —— `Failed to resolve import "./fingerprint.js"`

- [ ] **Step 3: 写实现**

`server/src/bilibili/fingerprint.ts`:

```ts
export interface Fingerprint {
  buvid3: string;
  buvid4: string;
}

const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 获取设备指纹。实测确认这是独立于 wbi 签名的一道必要防线:
 * 只签名不带 buvid3 会被判 -352,补上即通过。
 *
 * 拿到后应存入 settings 复用,不要每次请求都重新获取。
 */
export async function fetchFingerprint(
  fetchImpl: typeof fetch = fetch,
): Promise<Fingerprint> {
  const res = await fetchImpl(SPI_URL, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  const body = (await res.json()) as {
    code?: number;
    message?: string;
    data?: { b_3?: string; b_4?: string };
  };

  if (body.code !== 0 || !body.data?.b_3 || !body.data?.b_4) {
    throw new Error(
      `获取设备指纹失败:code=${body.code} message=${body.message ?? ''}`,
    );
  }
  return { buvid3: body.data.b_3, buvid4: body.data.b_4 };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/bilibili/fingerprint.test.ts`
Expected: PASS,5 个用例全绿

- [ ] **Step 5: Commit**

```bash
git add server/src/bilibili/fingerprint.ts server/src/bilibili/fingerprint.test.ts
git commit -m "$(cat <<'EOF'
feat(bilibili): 设备指纹获取 —— 实测确认 buvid3 是必需的一环

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: BiliClient(组装)

**Files:**
- Create: `server/src/bilibili/client.ts`
- Test: `server/src/bilibili/client.test.ts`

**Interfaces:**
- Consumes: `wbi.ts`、`rateLimiter.ts`、`errors.ts`、`fingerprint.ts`
- Produces:

```ts
interface BiliClientOpts {
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  fingerprint?: Fingerprint;
  sessdata?: string;
  bilijct?: string;
}

class BiliClient {
  constructor(opts?: BiliClientOpts);
  /** 按需拉取并缓存 mixinKey(每日轮换) */
  ensureWbiKeys(): Promise<WbiKeys>;
  /** signed 默认 true;signed:false 时不加 w_rid(收藏夹列表接口不需要) */
  get<T>(path: string, params?: Record<string, string | number>, opts?: { signed?: boolean }): Promise<T>;
}
```

- [ ] **Step 1: 写失败的测试**

`server/src/bilibili/client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { BiliClient } from './client.js';
import { RateLimiter } from './rateLimiter.js';
import { RiskControlError, AuthError } from './errors.js';

const NAV = {
  code: 0,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

/** 按 path 决定返回什么的 fetch 假实现 */
function routedFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    headers.push((init?.headers as Record<string, string>) ?? {});
    for (const [key, body] of Object.entries(routes)) {
      if (String(url).includes(key)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls, headers };
}

/** 不真等的限速器 */
const fastLimiter = () => new RateLimiter({ sleepImpl: async () => {} });
const FP = { buvid3: 'B3', buvid4: 'B4' };

describe('BiliClient', () => {
  it('拉收藏夹列表:signed:false 时不带 w_rid', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: { list: [] } } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    const url = f.calls[0]!;
    expect(url).not.toContain('w_rid');
    expect(url).toContain('up_mid=2');
  });

  it('signed 默认 true,自动取 nav 拿 mixinKey 并签名', async () => {
    const f = routedFetch({ nav: NAV, 'acc/info': { code: 0, data: { mid: 2 } } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await c.get('/x/space/wbi/acc/info', { mid: 2 });
    const target = f.calls.find((u) => u.includes('acc/info'))!;
    expect(target).toContain('w_rid=');
    expect(target).toContain('wts=');
  });

  it('mixinKey 只取一次,后续请求复用缓存', async () => {
    const f = routedFetch({ nav: NAV, 'acc/info': { code: 0, data: {} } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await c.get('/x/space/wbi/acc/info', { mid: 1 });
    await c.get('/x/space/wbi/acc/info', { mid: 2 });
    expect(f.calls.filter((u) => u.includes('/nav')).length).toBe(1);
  });

  it('带上 buvid3 cookie', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: {} } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    expect(f.headers[0]!['Cookie']).toContain('buvid3=B3');
  });

  it('带 SESSDATA 时一并进 cookie', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: {} } });
    const c = new BiliClient({
      fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP,
      sessdata: 'SD', bilijct: 'JC',
    });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    const cookie = f.headers[0]!['Cookie']!;
    expect(cookie).toContain('SESSDATA=SD');
    expect(cookie).toContain('bili_jct=JC');
  });

  it('带 Referer', async () => {
    const f = routedFetch({ 'list-all': { code: 0, data: {} } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    expect(f.headers[0]!['Referer']).toBe('https://www.bilibili.com/');
  });

  it('-412 抛 RiskControlError,且不重试', async () => {
    const f = routedFetch({ 'list-all': { code: -412, message: '请求被拦截' } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await expect(
      c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
    ).rejects.toBeInstanceOf(RiskControlError);
    expect(f.calls).toHaveLength(1);
  });

  it('HTTP 状态码 412 也抛 RiskControlError,不重试', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response(
        JSON.stringify({ code: -412, message: '请求被拦截' }),
        { status: 412, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const c = new BiliClient({ fetchImpl: impl, limiter: fastLimiter(), fingerprint: FP });
    await expect(
      c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
    ).rejects.toBeInstanceOf(RiskControlError);
    expect(n).toBe(1);
  });

  it('-101 抛 AuthError', async () => {
    const f = routedFetch({ 'list-all': { code: -101, message: '账号未登录' } });
    const c = new BiliClient({ fetchImpl: f.impl, limiter: fastLimiter(), fingerprint: FP });
    await expect(
      c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('读操作遇 5xx 会重试,最多 3 次', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response('{"code":0,"data":{}}', {
        status: n < 3 ? 503 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const c = new BiliClient({
      fetchImpl: impl, limiter: fastLimiter(), fingerprint: FP,
      retrySleepImpl: async () => {},
    });
    await c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false });
    expect(n).toBe(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/bilibili/client.test.ts`
Expected: FAIL —— `Failed to resolve import "./client.js"`

- [ ] **Step 3: 写实现**

`server/src/bilibili/client.ts`:

```ts
import { extractMixinKey, signParams, type WbiKeys } from './wbi.js';
import { RateLimiter } from './rateLimiter.js';
import { classify, isRetryable, RiskControlError, type BiliError } from './errors.js';
import { BROWSER_UA, type Fingerprint } from './fingerprint.js';

const BASE = 'https://api.bilibili.com';
const MAX_READ_RETRIES = 3;

export interface BiliClientOpts {
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  fingerprint?: Fingerprint;
  sessdata?: string;
  bilijct?: string;
  /** 注入点:重试之间的等待,测试里不真等 */
  retrySleepImpl?: (ms: number) => Promise<void>;
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
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly fingerprint?: Fingerprint;
  private readonly sessdata?: string;
  private readonly bilijct?: string;
  private readonly retrySleep: (ms: number) => Promise<void>;
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
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
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
    const res = await this.fetchImpl(`${BASE}/x/web-interface/nav`, {
      headers: this.buildHeaders(),
    });
    const body = (await res.json()) as ApiEnvelope<{
      wbi_img?: { img_url?: string; sub_url?: string };
    }>;

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
  ): Promise<T> {
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

      const res = await this.fetchImpl(url, { headers: this.buildHeaders() });
      const text = await res.text();

      let body: ApiEnvelope<T>;
      try {
        body = JSON.parse(text) as ApiEnvelope<T>;
      } catch {
        // 返回 HTML 说明被拦截了,当作 HTTP 层面的失败
        const err = classify(0, res.status === 200 ? 503 : res.status, text.slice(0, 200));
        if (!err) throw new Error('无法解析响应');
        lastErr = err;
        if (!isRetryable(err, 'read')) throw err;
        continue;
      }

      // HTTP 状态码 412 直接视为风控,即使 body.code 不是 -412/-352
      // (实测/资料显示 bilibili 多数返回 200 + code:-412,但也有 HTTP 412 形态)
      if (res.status === 412) {
        throw new RiskControlError(
          'HTTP 412:请求被风控拦截,已停止。请去 bilibili 过一次验证码,不要重试。',
          body.code,
          res.status,
        );
      }

      const err = classify(body.code, res.status, body.message ?? '');
      if (!err) return body.data as T;

      lastErr = err;
      if (!isRetryable(err, 'read')) throw err;
    }

    throw lastErr ?? new Error('请求失败');
  }
}
```

> **注意测试与实现的契约**:`retrySleepImpl` 是 `BiliClientOpts` 的一部分(测试要用)。`get` 的 `kind` 参数在 M1 固定为 `'read'` —— 写操作走 M5 新增的 `post` 方法,那时才会用到 `'write'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/bilibili/client.test.ts`
Expected: PASS,10 个用例全绿

- [ ] **Step 5: 跑全量测试 + 类型检查**

Run: `npm test -w server`
Expected: 全部 PASS(5 + 6 + 13 + 5 + 10 = 39 个用例)

Run: `npm run typecheck`
Expected: 无输出、退出码 0

- [ ] **Step 6: Commit**

```bash
git add server/src/bilibili/client.ts server/src/bilibili/client.test.ts
git commit -m "$(cat <<'EOF'
feat(bilibili): BiliClient —— 组装签名/指纹/限速/错误分类

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 真实 API 探针 —— 撞墙

**Files:**
- Create: `server/src/probes/verify-live.ts`

**Interfaces:**
- Consumes: `BiliClient`、`fetchFingerprint`
- Produces: 一个手工运行的脚本,打印风控验证结果;不产出可被 import 的符号

**这是 M1 的核心交付物。** 前 6 个任务建的是工具,这个任务用工具回答「这条路走不走得通」。

**手动前置**:需要在 `server/.env` 里放 `SESSDATA` 和 `bili_jct`(从浏览器 DevTools → Application → Cookies → `https://www.bilibili.com` 复制)。

- [ ] **Step 1: 建 `.env.example` 并把它加进 git**

`server/.env.example`:

```
# 从浏览器 DevTools → Application → Cookies → https://www.bilibili.com 复制
SESSDATA=
bili_jct=
```

Run: `git add server/.env.example`

> 根 `.gitignore` 里的模式是 `.env`(精确匹配),不含 `.env.example` —— 那个文件没有密钥,应该入库。

- [ ] **Step 2: 写探针脚本**

`server/src/probes/verify-live.ts`:

```ts
/**
 * M1 真实 API 探针 —— 手工运行。
 *
 *   npm run probe:live
 *
 * 它回答四个问题:
 *   1. 无 cookie 的公开接口能通吗?(预期:能)
 *   2. wbi 签名的接口,只有 buvid3 能通吗?(预期:能)
 *   3. 自己的收藏夹列表能拉到吗?(需要 SESSDATA)
 *   4. fav/resource/list 到底返回哪些字段?(spec §14 待验证 #2)
 *
 * 只读。这个脚本不发任何写请求。
 */
import { readFileSync } from 'node:fs';
import { BiliClient } from '../bilibili/client.js';
import { fetchFingerprint } from '../bilibili/fingerprint.js';
import { RateLimiter } from '../bilibili/rateLimiter.js';
import type { BiliError } from '../bilibili/errors.js';

function loadEnv(): Record<string, string> {
  try {
    const raw = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    return Object.fromEntries(
      raw.split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function report(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? '✅' : '❌'} ${label}\n   ${detail}\n`);
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: BiliError }> {
  try {
    return { ok: true, v: await fn() };
  } catch (e) {
    return { ok: false, e: e as BiliError };
  }
}

const env = loadEnv();
const hasLogin = Boolean(env['SESSDATA'] && env['bili_jct']);

console.log('=== M1 风控探针 ===');
console.log(`登录态:${hasLogin ? '有' : '无(第 3、4 项会跳过)'}\n`);

// 限速器调慢一点:这是真实账号,不赶时间
const limiter = new RateLimiter({ readMs: 2000, readJitterMs: 500, writeMs: 4000, writeJitterMs: 1000 });

console.log('① 获取设备指纹 ...');
const fp = await fetchFingerprint();
report('设备指纹', true, `buvid3=${fp.buvid3.slice(0, 18)}… (${fp.buvid3.length} 字符)`);

// ② 公开接口,不签名
{
  const c = new BiliClient({ fingerprint: fp, limiter });
  const r = await attempt(() => c.get('/x/v3/fav/folder/created/list-all', { up_mid: 2 }, { signed: false }));
  report(
    '② 公开接口(不签名)',
    r.ok,
    r.ok ? `返回 ${JSON.stringify(r.v).slice(0, 120)}` : `code=${r.e.code} ${r.e.message}`,
  );
  await sleep(2500);
}

// ③ wbi 签名接口,只带 buvid3
{
  const c = new BiliClient({ fingerprint: fp, limiter });
  const r = await attempt(() => c.get('/x/space/wbi/arc/search', { mid: 2, ps: 3, pn: 1, order: 'pubdate' }));
  report(
    '③ wbi 签名接口(仅 buvid3)',
    r.ok,
    r.ok ? '通过 —— buvid3 确实是必需且充分的一环' : `code=${r.e.code} ${r.e.message}`,
  );
  await sleep(2500);
}

if (!hasLogin) {
  console.log('⏭  跳过 ④⑤ —— 没有 SESSDATA,无法访问自己的收藏夹。\n');
  process.exit(0);
}

const c = new BiliClient({
  fingerprint: fp, limiter,
  sessdata: env['SESSDATA']!, bilijct: env['bili_jct']!,
});

// ④ 自己的收藏夹列表
const me = await attempt(() => c.get<{ mid: number }>('/x/web-interface/nav'));
if (!me.ok) {
  report('④ 读取自己的账号信息', false, `code=${me.e.code} ${me.e.message} —— cookie 可能已过期`);
  process.exit(1);
}
const myMid = me.v.mid;
console.log(`   我的 mid = ${myMid}\n`);
await sleep(2500);

for (const type of [11, 21] as const) {
  const label = type === 11 ? '视频收藏夹' : '文章收藏夹';
  const r = await attempt(() =>
    c.get<{ count: number; list: Array<{ id: number; title: string; media_count: number }> }>(
      '/x/v3/fav/folder/created/list-all',
      { up_mid: myMid, type },
      { signed: false },
    ),
  );
  report(
    `④ 收藏夹列表 / ${label}`,
    r.ok,
    r.ok ? `${r.v.list.length} 个,共 ${r.v.list.reduce((s, f) => s + f.media_count, 0)} 条` : `code=${r.e.code} ${r.e.message}`,
  );
  await sleep(2500);

  // ⑤ 拿第一个夹子看条目字段(spec §14 待验证 #2)
  if (r.ok && r.v.list.length > 0) {
    const folder = r.v.list[0]!;
    const items = await attempt(() =>
      c.get<{ medias: Record<string, unknown>[] }>('/x/v3/fav/resource/list', {
        media_id: folder.id, pn: 1, ps: 5, platform: 'web',
      }),
    );
    if (items.ok && items.v.medias?.length) {
      console.log(`⑤ fav/resource/list 返回字段(来自「${folder.title}」):`);
      console.log(`   ${Object.keys(items.v.medias[0]!).join(', ')}\n`);
      console.log('   第一条样例:');
      console.log(`   ${JSON.stringify(items.v.medias[0], null, 2).slice(0, 900)}\n`);
      console.log('   ⚠️ 请检查上面是否含分区名(tname)与失效标记(attr)。');
      console.log('      把结论回写到 spec §14。\n');
    } else {
      report('⑤ fav/resource/list', false, items.ok ? '返回空 medias' : `code=${items.e.code} ${items.e.message}`);
    }
    await sleep(2500);
  }
}

console.log('=== 探针结束。请把结果回写到 spec §14 ===');
```

- [ ] **Step 3: 跑类型检查**

Run: `npm run typecheck`
Expected: 无输出、退出码 0

- [ ] **Step 4: 先跑一次无登录态版本**

Run: `npm run probe:live`
Expected:
- ① ✅ 设备指纹
- ② ✅ 公开接口(不签名)
- ③ ✅ wbi 签名接口(仅 buvid3)
- ④⑤ 被跳过

**如果 ③ 失败**,说明 `buvid3` 的行为与实测不符 —— 停下来,把实际返回码记下来,回写 spec §8,再决定怎么调整。

- [ ] **Step 5: 填 cookie 跑完整版**

在 `server/.env` 填入真实的 `SESSDATA` 和 `bili_jct`,然后:

Run: `npm run probe:live`
Expected: ④⑤ 也通过,并打印出 `fav/resource/list` 的完整字段列表

- [ ] **Step 6: 把实测结论回写 spec §14**

根据 ⑤ 的输出,更新 `docs/superpowers/specs/2026-09-14-bilibili-favorite-manager-design.md` 的 §14:
- 待验证 #2(字段结构)→ 已验证,列出可用作分类信号的字段
- 待验证 #3(失效标记)→ 已验证,写明确切字段和取值
- 若 ③ 行为与预期不符,同时修正 §8

这一步**不能跳过** —— 结论不回写,M2 就是照着猜的东西写。

- [ ] **Step 7: Commit**

```bash
git add server/src/probes/verify-live.ts server/.env.example docs/superpowers/specs/
git commit -m "$(cat <<'EOF'
feat(probe): M1 真实 API 风控探针 + 回写实测结论到 spec

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec 覆盖**

| Spec 要求 | 对应任务 |
|---|---|
| §8 wbi 签名 | Task 2 |
| §8 buvid3 指纹 | Task 5 |
| §8 限速 + 抖动 + 全局串行 | Task 3 |
| §8 错误分级(-412 / -101 / 5xx) | Task 4 |
| C3 请求必经限速器 | Task 6(`BiliClient` 是唯一出口) |
| C4 写操作永不重试 | Task 4(`isRetryable` 按 kind 拒绝写) |
| §13 M1「能拉到收藏夹列表」 | Task 7 |
| §14 待验证 #2 #3 | Task 7 Step 5-6 |

**未覆盖且刻意如此**:spec §14 待验证 #4(`deal` 移动语义)需要真实写操作,不能在 M1 安全验证 —— 归到 M5 第一次执行时用一个 `deald` 单条探针确认。#6(风控阈值)需要持续观察,归到 M2 首次全量同步时测量。

**2. 占位符扫描**:无 TBD / TODO / "稍后补充"。所有代码块都是完整可运行的内容。

**3. 类型一致性**:`WbiKeys`(Task 2 定义)→ Task 6 `ensureWbiKeys` 返回;`Fingerprint`(Task 5 定义)→ Task 6 构造参数;`RateLimiter.acquire(kind)`(Task 3)→ Task 6 调用;`classify` / `isRetryable`(Task 4)→ Task 6 使用。名称与签名全部一致。

---

## 后续里程碑(各自独立成计划)

M1 完成后,以下里程碑各自写一份计划。**现在不展开到步骤级** —— 因为 M1 的实测结果会改变它们的字段映射细节,现在写就是猜。

| 里程碑 | 内容 | 主要文件 |
|---|---|---|
| **M2 同步** | SQLite schema、repository、全量/增量同步、断点续传、logger(events + api_calls + redact) | `server/src/db/*`、`server/src/sync/*`、`server/src/logger/*` |
| **M3 只读 UI** | Fastify 服务 + SSE、Umi Max 脚手架(此时才把 `web` 加进 workspaces)、总览页、FTS5 搜索 | `server/src/http/*`、`web/*` |
| **M4 AI 引擎** | LLM provider(OpenAI 兼容)+ 两遍分类 + JSON 四层兜底 + `/curator` 页 | `server/src/llm/*`、`server/src/curator/*` |
| **M5 执行** | Plan 数据结构 + diff + 执行引擎 + guards(删除三道防线)+ undo + `/review` 页。**首次写操作,含 `deal` 语义探针** | `server/src/plan/*`、`server/src/execute/*` |
| **M6 收尾** | 失效检测与清理、`/logs` 页、`/settings` 页、补齐 spec §12 的 7 项测试 | 各模块 |

**M2 的第一个任务是测量真实风控阈值**(spec §14 待验证 #6):用限速器跑一次全量同步,观察是否触发 `-412`,据此调整 `readMs` / `writeMs` 默认值。

---

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-09-14-M1-handshake.md`。两种执行方式:

**1. Subagent 驱动(推荐)** —— 每个任务派一个全新的 subagent,任务间我来 review,迭代快

**2. 本会话内联执行** —— 用 executing-plans 在当前会话里批量执行,带检查点

选哪种?
