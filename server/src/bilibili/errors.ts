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
  // 风控/未登录的判断必须排在 HTTP 状态之前 —— 否则 code:-412 配非 200 状态时
  // 会被降级成可重试的 HttpError,把"必须停下来"的信号泄漏进重试循环。
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
  if (httpStatus !== 200) {
    return new HttpError(`HTTP ${httpStatus}:${message}`, code, httpStatus);
  }
  if (code === 0) return null;
  return new RequestError(`请求失败(${code} ${message})`, code, httpStatus);
}

/**
 * 是否可以自动重试。
 *
 * 写操作永不自动重试(spec C4)—— 重试可能造成重复执行,
 * 宁可停下来让用户手动决定。
 *
 * 读操作也只重试真正的服务端故障:4xx(403/429 限速/HTML 拦截页)重试只会
 * 火上浇油,所以只有 HttpError 且 status >= 500 才重试。
 */
export function isRetryable(err: BiliError, kind: 'read' | 'write'): boolean {
  if (kind === 'write') return false;
  if (err instanceof RiskControlError || err instanceof AuthError) return false;
  if (err instanceof HttpError) return err.httpStatus >= 500;
  return false;
}
