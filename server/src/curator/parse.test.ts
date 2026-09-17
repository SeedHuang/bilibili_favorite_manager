import { describe, it, expect } from 'vitest';
import { parseLooseJson, parseJsonArray } from './parse.js';

describe('parseLooseJson —— §9.4 第 1-2 层', () => {
  it('干净的 JSON 直接过', () => {
    expect(parseLooseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('剥 ```json 围栏', () => {
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('剥无语言标记的围栏', () => {
    expect(parseLooseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('前后有寒暄时截第一个 { 到最后一个 }', () => {
    const raw = '好的,这是结果:\n{"folders":[]}\n希望对你有帮助!';
    expect(parseLooseJson(raw)).toEqual({ folders: [] });
  });

  it('围栏 + 寒暄一起来也能抠出来', () => {
    expect(parseLooseJson('结果如下:\n```json\n[{"itemId":"BV1"}]\n```\n完成')).toEqual([
      { itemId: 'BV1' },
    ]);
  });

  it('顶层是数组', () => {
    expect(parseLooseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('实在解析不出来返回 null(调用方据此缩批重试)', () => {
    expect(parseLooseJson('我觉得这个视频应该放在编程夹子里')).toBeNull();
  });

  it('空串 / 非字符串返回 null', () => {
    expect(parseLooseJson('')).toBeNull();
    expect(parseLooseJson('   ')).toBeNull();
    expect(parseLooseJson(undefined)).toBeNull();
    expect(parseLooseJson(null)).toBeNull();
    expect(parseLooseJson(42)).toBeNull();
  });

  // 解析出来就是 null 和"解析失败"是两回事,不能混
  it('解析出裸 null 也算成功', () => {
    expect(parseLooseJson('null')).toBeNull();
    expect(parseLooseJson('0')).toBe(0);
    expect(parseLooseJson('false')).toBe(false);
  });
});

describe('parseJsonArray', () => {
  it('顶层数组直接用', () => {
    expect(parseJsonArray('[{"itemId":"BV1"}]')).toEqual([{ itemId: 'BV1' }]);
  });

  it('被包在对象里的数组也认得 —— 小模型爱这么干', () => {
    expect(parseJsonArray('{"assignments":[{"itemId":"BV1"}]}')).toEqual([{ itemId: 'BV1' }]);
    expect(parseJsonArray('{"results":[1,2]}')).toEqual([1, 2]);
  });

  it('对象里没有数组 → null', () => {
    expect(parseJsonArray('{"notes":"没什么可说的"}')).toBeNull();
  });

  it('解析不了 → null', () => {
    expect(parseJsonArray('抱歉')).toBeNull();
  });
});
