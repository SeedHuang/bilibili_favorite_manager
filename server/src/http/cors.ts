/**
 * CORS 放行 —— 前端 dev 直连后端(不走 umi 代理,原因见 index.ts 注释)。
 *
 * **只回显白名单内的 origin**:本机工具没有多租户,但也不能让任意网页都能读到
 * 本地 API 的响应 / 触发写操作 —— 那是 CORS 的唯一防线(没有认证)。dev 前端就
 * 这两个源;非浏览器(测试/curl/同源)不带 Origin,不需要 ACAO,返回 undefined。
 */
const DEV_ORIGINS = new Set(['http://localhost:8000', 'http://127.0.0.1:8000']);

export function corsOrigin(reqOrigin: string | undefined): string | undefined {
  return reqOrigin && DEV_ORIGINS.has(reqOrigin) ? reqOrigin : undefined;
}
