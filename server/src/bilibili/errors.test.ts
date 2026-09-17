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

  it('风控码配非 200 状态时仍是风控,不被降级成 HttpError', () => {
    expect(classify(-412, 500, '请求被拦截')).toBeInstanceOf(RiskControlError);
    expect(classify(-352, 503, '风控校验失败')).toBeInstanceOf(RiskControlError);
  });

  it('未登录码配非 200 状态时仍是未登录', () => {
    expect(classify(-101, 503, '账号未登录')).toBeInstanceOf(AuthError);
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

  it('4xx 不重试 —— 403/429 重试只会火上浇油', () => {
    expect(isRetryable(classify(0, 429, 'too many requests')!, 'read')).toBe(false);
    expect(isRetryable(classify(0, 403, 'Forbidden')!, 'read')).toBe(false);
  });
});
