import { describe, it, expect } from 'vitest';
import { parseFolder, parseItem } from './parse.js';

/** 实测的真实夹子对象(字段以探针输出为准;未确认的字段这里不假设存在) */
const realFolder = {
  id: 84975136,
  fid: 84975136,
  mid: 27725036,
  attr: 0,
  title: '默认收藏夹',
  fav_state: 0,
  media_count: 3480,
};

/** 实测的真实条目对象(2026-09-14 探针输出,已截断长文本) */
const realItem = {
  id: 117122533433183,
  type: 2,
  title: '60分钟录音一键转写',
  cover: 'http://i1.hdslb.com/bfs/archive/51d68f13.jpg',
  intro: '还在为几十分钟的会议录音和访谈音频整理头疼吗？',
  page: 1,
  duration: 30,
  upper: { mid: 3707036833417294, name: 'bili_32390937472', face: 'http://x.jpg' },
  attr: 0,
  cnt_info: { collect: 517, play: 2663 },
  ctime: 1787148128,
  pubtime: 1787148221,
  fav_time: 1789345556,
  bvid: 'BV1cT8J6NEoE',
};

describe('parseFolder', () => {
  it('映射实测字段', () => {
    const f = parseFolder(realFolder)!;
    expect(f.id).toBe(84975136);
    expect(f.title).toBe('默认收藏夹');
    expect(f.mediaCount).toBe(3480);
  });

  it('未确认的字段缺失时不报错,留 undefined(而不是编造值)', () => {
    const f = parseFolder(realFolder)!;
    expect(f.mtime).toBeUndefined();
    expect(f.intro).toBeUndefined();
    expect(f.privacy).toBeUndefined();
  });

  it('有 mtime / intro / privacy 时就取(实测后确认存在的话自动生效)', () => {
    const f = parseFolder({ ...realFolder, mtime: 1789345556, intro: '说明', privacy: 1 })!;
    expect(f.mtime).toBe(1789345556);
    expect(f.intro).toBe('说明');
    expect(f.privacy).toBe(1);
  });

  it('缺 id 或 title 返回 null(脏数据不入库)', () => {
    expect(parseFolder({ title: 'x' })).toBeNull();
    expect(parseFolder({ id: 1 })).toBeNull();
    expect(parseFolder(null)).toBeNull();
  });

  it('raw 存原始 JSON,便于回溯', () => {
    const f = parseFolder(realFolder)!;
    expect(JSON.parse(f.raw!)).toMatchObject({ id: 84975136 });
  });
});

describe('parseItem', () => {
  it('映射实测字段', () => {
    const i = parseItem(realItem)!;
    expect(i.id).toBe('BV1cT8J6NEoE');
    expect(i.type).toBe(2);
    expect(i.title).toBe('60分钟录音一键转写');
    expect(i.intro).toContain('会议录音');
    expect(i.upperMid).toBe(3707036833417294);
    expect(i.upperName).toBe('bili_32390937472');
    expect(i.duration).toBe(30);
    expect(i.pubtime).toBe(1787148221);
    expect(i.cover).toContain('hdslb.com');
  });

  it('封面 http:// 规范化为 https://(混合内容会被浏览器拦)', () => {
    // realItem.cover 是 http:// → parseItem 应把它变 https://
    const i = parseItem(realItem)!;
    expect(i.cover).toMatch(/^https:\/\//);
  });

  it('duration 缺失时留 null(不回退成 page 的分P数量)', () => {
    const i = parseItem({ ...realItem, duration: undefined })!;
    expect(i.duration).toBeNull();
  });

  it('bvid 缺失时回退用数字 id 的字符串形式', () => {
    const i = parseItem({ ...realItem, bvid: undefined })!;
    expect(i.id).toBe('117122533433183');
  });

  it('attr 为 0 时 invalid=false', () => {
    expect(parseItem(realItem)!.invalid).toBe(false);
  });

  it('attr 非 0 时标记为 invalid(失效位的具体取值待实测校正)', () => {
    expect(parseItem({ ...realItem, attr: 1 })!.invalid).toBe(true);
    expect(parseItem({ ...realItem, attr: 9 })!.invalid).toBe(true);
  });

  it('缺 title 返回 null', () => {
    expect(parseItem({ bvid: 'BV1' })).toBeNull();
    expect(parseItem(undefined)).toBeNull();
  });

  it('字段类型不对时容错(字符串 id 也接受)', () => {
    const i = parseItem({ ...realItem, bvid: 12345 })!;
    expect(i.id).toBe('12345');
  });
});
