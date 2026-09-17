import type { FolderUpsert } from '../db/repo/folders.js';
import type { ItemUpsert } from '../db/repo/items.js';

/** 安全取数字 */
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** 安全取字符串 */
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** 安全取字符串形式的 id(数字 id 也接受 —— 字段类型不对时容错) */
const idStr = (v: unknown): string | undefined => {
  const n = num(v);
  return str(v) ?? (n === undefined ? undefined : String(n));
};

/**
 * 封面 URL 规范化:bilibili 返回 http://,但浏览器在 https/localhost 页面里
 * 会拦混合内容(Mixed Content),http 图片不显示。CDN 支持 https,直接换成 https。
 */
const normalizeCover = (v: unknown): string | null => {
  const s = str(v);
  if (s === undefined) return null;
  return s.replace(/^http:\/\//, 'https://');
};

/** 安全取嵌套对象 */
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

/**
 * B站夹子对象 → folders 行。
 *
 * 实测确认存在的只有 id / title / media_count / attr / fav_state。
 * mtime / intro / privacy 是否存在尚未确认 —— 有就取,没有就 undefined
 * (由 repo 写成 NULL),**绝不编造默认值**。
 */
export function parseFolder(raw: unknown): FolderUpsert | null {
  const o = obj(raw);
  if (!o) return null;
  const id = num(o['id']);
  const title = str(o['title']);
  if (id === undefined || title === undefined) return null;

  const mtime = num(o['mtime']) ?? num(o['ctime']);
  const intro = str(o['intro']);
  const privacy = num(o['privacy']);

  return {
    id,
    title,
    mediaCount: num(o['media_count']) ?? 0,
    // 实测 list-all 的 type 参数被忽略,拿不到可靠的夹子类型 → 留 undefined 由条目反推
    type: num(o['type']),
    ...(mtime !== undefined ? { mtime } : {}),
    ...(intro !== undefined ? { intro } : {}),
    ...(privacy !== undefined ? { privacy } : {}),
    raw: JSON.stringify(o),
  };
}

/**
 * B站条目对象 → items 行。
 *
 * 实测 fav/resource/list 返回:
 *   id, type, title, cover, intro, duration, upper{mid,name}, attr,
 *   cnt_info, ctime, pubtime, fav_time, bvid
 * **注意:没有 tname(分区名)** —— 不要试图映射它。
 */
export function parseItem(raw: unknown): ItemUpsert | null {
  const o = obj(raw);
  if (!o) return null;
  const title = str(o['title']);
  if (title === undefined) return null;

  // bvid 是主键首选;文章用 cvid;再不行用数字 id
  const id = idStr(o['bvid']) ?? idStr(o['cvid']) ?? idStr(o['bv_id']) ?? idStr(o['id']);
  if (id === undefined) return null;

  const upper = obj(o['upper']);
  // attr 非 0 视为失效。具体是哪一位待实测校正 —— 现在是保守的「非 0 即异常」。
  const attr = num(o['attr']) ?? 0;

  return {
    id,
    type: num(o['type']) ?? 0,
    title,
    intro: str(o['intro']) ?? null,
    cover: normalizeCover(o['cover']),
    upperMid: num(upper?.['mid']) ?? null,
    upperName: str(upper?.['name']) ?? null,
    // duration 缺失就留 null。**不要**回退到 `page` —— 那是分P数量不是秒数,
    // 会写出「5 分钟视频 = 5 秒」这种比 null 更糟的假数据。
    duration: num(o['duration']) ?? null,
    pubtime: num(o['pubtime']) ?? num(o['ctime']) ?? null,
    invalid: attr !== 0,
    raw: JSON.stringify(o),
  };
}
