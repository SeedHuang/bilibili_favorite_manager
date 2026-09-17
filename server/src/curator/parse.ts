/**
 * §9.4 小模型 JSON 兜底的**前两层**(纯解析,无 IO):
 *
 *   1. 要求纯 JSON,不要 markdown 围栏
 *   2. 解析失败 → 剥围栏 / 截取第一个 { 到最后一个 } 重试
 *
 * 后两层(缩批重试 / 整批标记失败)是控制流,在 classifier.ts 里。
 * 本地小模型必然会把 JSON 弄坏,所以这层不是"防御性编程",是主路径。
 */

/** 解析成功返回 value;失败返回 undefined —— 好和"解析出来就是 null"区分开 */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 剥掉 ```json ... ``` 围栏。没有围栏就原样返回 */
function stripFence(text: string): string {
  return text
    .replace(/^```[a-zA-Z0-9_-]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
}

/**
 * 截取最外层的那一对括号。
 *
 * **按谁先开谁是被包含的判定**,不是"先试对象再试数组" —— 后者遇到
 * `[{"itemId":"BV1"}]` 会把数组整个吃掉,只剩里面第一个对象。
 */
function sliceBalanced(text: string): string {
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart);

  const start = useArray ? arrStart : objStart;
  const end = useArray ? text.lastIndexOf(']') : text.lastIndexOf('}');

  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * 尽最大努力把模型吐出来的东西变成 JSON。
 * 全都失败返回 null —— 调用方据此走第 3 层(缩批重试)。
 */
export function parseLooseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const direct = tryParse(text);
  if (direct !== undefined) return direct;

  const unfenced = stripFence(text);
  if (unfenced !== text) {
    const parsed = tryParse(unfenced);
    if (parsed !== undefined) return parsed;
  }

  const sliced = tryParse(sliceBalanced(unfenced));
  if (sliced !== undefined) return sliced;

  return null;
}

/** 从模型输出里抠出一个对象数组;拿不到数组就返回 null */
export function parseJsonArray(raw: unknown): unknown[] | null {
  const parsed = parseLooseJson(raw);
  if (Array.isArray(parsed)) return parsed;

  // 有些小模型会把数组包在 {"results": [...]} / {"folders": [...]} 里
  if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}
