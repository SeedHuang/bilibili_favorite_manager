/**
 * 日志脱敏 —— C9 的唯一落实点。
 *
 * 这个文件刻意不 import 任何东西,方便单测,也避免它被别处的依赖污染。
 */

/** 需要抹掉值的键名(小写比较) */
export const SENSITIVE_KEYS: readonly string[] = [
  'sessdata',
  'bili_jct',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'password',
  'token',
];

const MASK = '***';

/**
 * 已知凭证的**值**。按值抹,不按键名抹。
 *
 * 为什么非要这样:上游报错经常把 key 原样回显(`401 Unauthorized: key sk-xxx 无效`),
 * 那一刻它不带任何键名,键名规则一条都命中不了 —— 于是明文 key 直接落进 events 表。
 * 而我们本来就知道那个 key 是什么(llm/config.ts 读出来的),按值抹是唯一的兜底。
 */
const secrets: string[] = [];

/** 登记一个凭证值。由 provider.ts 在真正使用它之前调用 */
export function registerSecret(value: string | null | undefined): void {
  // 太短的不登记 —— 否则 replace 会误伤普通文本
  if (!value || value.length < 8) return;
  if (!secrets.includes(value)) secrets.push(value);
}

/**
 * API key 的常见形态。这是**没有登记过**的 key 的地板 ——
 * 比如用户刚粘进设置页、还没保存就被拿去测试的那个。
 *
 * ponytail: 只覆盖 sk- 系(OpenAI / DeepSeek / Anthropic)。方舟、MiniMax 的
 * key 没有可辨识前缀,靠 registerSecret 按值兜;要更宽就接各家前缀表。
 */
const KEY_SHAPED = /\bsk-[A-Za-z0-9_-]{8,}/g;

const stripSeps = (s: string): string => s.replace(/[_-]/g, '');

/**
 * 键名是不是敏感键。
 *
 * 除了精确匹配,还看命名空间(`llm.apiKey`)里的**最后一段**,并忽略 `_` / `-`
 * 的写法差异 —— 我们真实的键名都是带命名空间的(`llm.apiKey` / `bili.sessdata` /
 * `bili.bilijct`),精确匹配会让它们全部漏网,而设置对象恰恰最可能被整体 dump。
 */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.includes(lower)) return true;
  const tail = stripSeps(lower.split('.').pop() ?? '');
  return SENSITIVE_KEYS.some((k) => stripSeps(k) === tail);
}

/** 把 `key=value` 形式里的敏感值替换掉 */
export function redact(input: string): string {
  // 1) 先按值抹掉已知凭证 —— 必须最先做,否则下面的规则可能把它切成两半、对不上原值
  let out = input;
  for (const s of secrets) out = out.split(s).join(MASK);

  // 2) 没登记过的 key 靠形态兜底
  out = out.replace(KEY_SHAPED, MASK);

  // 3) Bearer 必须在键名规则之前:否则 `Authorization: Bearer sk-xxx` 会先被
  //    authorization 规则吃掉 `Bearer`(值取到空格为止),把 key 留在外面。
  out = out.replace(/(Bearer\s+)([^;,\s'"]+)/gi, `$1${MASK}`);

  for (const key of SENSITIVE_KEYS) {
    // `cookie` 只用于对象键(redactDeep):字符串里 `Cookie: buvid3=AAA; SESSDATA=x`
    // 整段抹掉会把 buvid3 这类非敏感字段一起吃掉,而其中的敏感字段各自会被下面的
    // 规则命中,不会漏。
    if (key === 'cookie') continue;
    // 匹配 `key=值` 或 `key: 值`,值取到分隔符为止(; , 空白 引号 都算结束)
    const re = new RegExp(`(${key}\\s*[=:]\\s*)([^;,\\s'"]+)`, 'gi');
    out = out.replace(re, `$1${MASK}`);
  }
  return out;
}

/**
 * 递归脱敏。处理循环引用,深度上限 8 —— 日志对象不该更深。
 */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? redact(value) : value;
  }
  if (seen.has(value)) return '[循环引用]';
  if (depth >= 8) return '[超深]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? MASK : redactDeep(v, depth + 1, seen);
  }
  return out;
}
