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
