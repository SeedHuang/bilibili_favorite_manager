import { describe, it, expect } from 'vitest';
import { redact, redactDeep, registerSecret } from './redact.js';

describe('redact', () => {
  it('抹掉 SESSDATA 的值', () => {
    const out = redact('Cookie: buvid3=AAA; SESSDATA=97df5745%2C1804299628%2Cdbeca; bili_jct=x');
    expect(out).not.toContain('97df5745');
    expect(out).toContain('buvid3=AAA');
    expect(out).toContain('bili_jct=***');
  });

  it('抹掉 bili_jct', () => {
    expect(redact('bili_jct=e8e6b03cee259d73')).not.toContain('e8e6b03c');
  });

  it('抹掉 api_key / Authorization', () => {
    expect(redact('api_key=sk-abcdef123456')).not.toContain('sk-abcdef');
    expect(redact('Authorization: Bearer sk-abcdef123456')).not.toContain('sk-abcdef');
  });

  it('不误伤普通文本', () => {
    const s = '同步收藏夹「深度学习」失败,已拉取 320 条';
    expect(redact(s)).toBe(s);
  });

  it('大小写不敏感', () => {
    expect(redact('sessdata=SECRETVALUE')).not.toContain('SECRETVALUE');
  });
});

describe('redactDeep', () => {
  it('递归抹掉对象里的敏感键', () => {
    const out = redactDeep({
      cookie: 'SESSDATA=SECRET; bili_jct=SECRET2',
      nested: { api_key: 'sk-SECRET3', keep: 'me' },
      list: [{ Authorization: 'Bearer SECRET4' }],
    }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    expect(s).not.toContain('SECRET');
    expect(s).toContain('me');
  });

  it('原始类型原样返回', () => {
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(undefined)).toBeUndefined();
  });

  it('不会因为循环引用而炸', () => {
    const a: Record<string, unknown> = { SESSDATA: 'SECRET' };
    a['self'] = a;
    expect(() => redactDeep(a)).not.toThrow();
  });
});

// M4 新增:带命名空间的设置键(llm.apiKey / bili.sessdata)必须也被抹掉 ——
// 精确匹配会让它们整体漏网,而设置对象最可能被原样 dump 进日志。
describe('带命名空间的键名', () => {
  it('llm.apiKey 这类键要脱敏', () => {
    expect(redactDeep({ 'llm.apiKey': 'sk-live-123' })).toEqual({ 'llm.apiKey': '***' });
  });

  it('bili.sessdata / bili.bilijct 这类键要脱敏(C10 的凭证)', () => {
    const out = redactDeep({ 'bili.sessdata': 'abc', 'bili.bilijct': 'def' }) as Record<string, string>;
    expect(out['bili.sessdata']).toBe('***');
    expect(out['bili.bilijct']).toBe('***');
  });

  it('嵌套一层也要脱敏', () => {
    const out = redactDeep({ llm: { apiKey: 'sk-1' } }) as { llm: { apiKey: string } };
    expect(out.llm.apiKey).toBe('***');
  });

  it('不带命名空间的普通键不受影响', () => {
    const out = redactDeep({ title: '普通标题', count: 3 }) as Record<string, unknown>;
    expect(out.title).toBe('普通标题');
    expect(out.count).toBe(3);
  });

  it('只是名字里含敏感词的键不误伤(如 token_count)', () => {
    const out = redactDeep({ token_count: 42 }) as Record<string, unknown>;
    expect(out.token_count).toBe(42);
  });
});

// M4:上游报错会把 key 原样回显,那时它不带任何键名 —— 键名规则一条都命中不了
describe('按值脱敏已知凭证', () => {
  it('裸 key 出现在自由文本里也要抹掉', () => {
    registerSecret('sk-live-DEADBEEF1234');
    expect(redact('401 Unauthorized: key sk-live-DEADBEEF1234 无效')).toContain('***');
    expect(redact('401 Unauthorized: key sk-live-DEADBEEF1234 无效')).not.toContain('DEADBEEF');
  });

  it('没有 sk- 前缀的 key(方舟 / MiniMax)靠登记兜底', () => {
    registerSecret('ark-abc123def456ghi789');
    expect(redact('失败:ark-abc123def456ghi789 被拒绝')).not.toContain('abc123def456');
  });

  it('没登记过的 sk- 形态仍然被形态规则抹掉', () => {
    expect(redact('key=sk-unregistered-9999zzz')).not.toContain('unregistered-9999zzz');
  });

  it('太短的值不登记 —— 否则会误伤普通文本', () => {
    registerSecret('abc');
    expect(redact('abc 是一个普通词')).toContain('abc');
  });

  it('redactDeep 里同样生效', () => {
    registerSecret('sk-deep-1234567890');
    const out = redactDeep({ detail: '上游返回 sk-deep-1234567890' }) as { detail: string };
    expect(out.detail).not.toContain('1234567890');
  });
});
