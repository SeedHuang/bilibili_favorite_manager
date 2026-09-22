import { describe, it, expect } from 'vitest';
import { listRemoteModels } from './models.js';

/** 假的 /models 端点 —— 测试绝不真发请求 */
const fake = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

/** 把请求也记下来,好断言地址和头 */
const capturing = (status: number, body: unknown) => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const ok = (ids: string[]) => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'x' })) });

describe('listRemoteModels', () => {
  it('把 /models 的 id 拉出来,数字查注册表', async () => {
    const got = await listRemoteModels({
      provider: 'deepseek',
      apiKey: 'k',
      fetchImpl: fake(200, ok(['deepseek-flash'])),
    });

    expect(got).toHaveLength(1);
    expect(got[0]!.model).toBe('deepseek-flash');
    // 注册表里收录过 → 用真值,而且标成已确认
    expect(got[0]!.contextWindow).toBe(1_024_000);
    expect(got[0]!.verified).toBe(true);
  });

  // ★ 这是"名字实时拉"的全部价值:厂商新出的模型,表里没有也能选到。
  // 这里**故意用一个注册表永远不会收录的名字** —— 用真名字当"未知"的例子,
  // 早晚会因为它被收录而让这条测试莫名其妙地红(踩过一次:`deepseek-flash`)。
  it('表里没有的名字也收下 —— 数字用兜底并标未确认', async () => {
    const got = await listRemoteModels({
      provider: 'deepseek',
      apiKey: 'k',
      fetchImpl: fake(200, ok(['deepseek-v9-experimental'])),
    });

    expect(got[0]!.model).toBe('deepseek-v9-experimental');
    // 兜底值,而且 verified:false → 界面会标 ⚠️ 让用户核对(填错 = token 上限算错)
    expect(got[0]!.verified).toBe(false);
    expect(got[0]!.contextWindow).toBe(32_768);
  });

  it('用该厂商的默认接口地址', async () => {
    const { impl, calls } = capturing(200, ok(['a']));
    await listRemoteModels({ provider: 'deepseek', apiKey: 'k', fetchImpl: impl });
    expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/models');
  });

  it('填了接口地址就用它,并把尾斜杠去掉', async () => {
    const { impl, calls } = capturing(200, ok(['a']));
    await listRemoteModels({
      provider: 'custom', baseUrl: 'https://x.example/v1/', apiKey: 'k', fetchImpl: impl,
    });
    expect(calls[0]!.url).toBe('https://x.example/v1/models');
  });

  it('带上 Bearer 头', async () => {
    const { impl, calls } = capturing(200, ok(['a']));
    await listRemoteModels({ provider: 'deepseek', apiKey: 'sk-abc', fetchImpl: impl });
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-abc');
  });

  it('没填 key 也敢发(自建端点常常不校验)', async () => {
    const { impl, calls } = capturing(200, ok(['a']));
    await listRemoteModels({ provider: 'custom', baseUrl: 'https://x.example/v1', fetchImpl: impl });
    expect(calls[0]!.headers.authorization).toBe('Bearer not-needed');
  });

  // 401 要说人话:用户照着能改的是"key 填错了",不是 "HTTP 401"
  it('401 → 一句能照着改的话', async () => {
    await expect(
      listRemoteModels({ provider: 'deepseek', apiKey: 'bad', fetchImpl: fake(401, {}) }),
    ).rejects.toThrow(/API Key/);
  });

  it('别的错误码带上状态码', async () => {
    await expect(
      listRemoteModels({ provider: 'deepseek', apiKey: 'k', fetchImpl: fake(500, {}) }),
    ).rejects.toThrow(/500/);
  });

  it('返回里没有 data / id 不是字符串 → 跳过,不炸', async () => {
    const got = await listRemoteModels({
      provider: 'deepseek',
      apiKey: 'k',
      fetchImpl: fake(200, { data: [{ id: 123 }, { id: '' }, {}, 'nonsense'] }),
    });
    expect(got).toEqual([]);
  });

  it('没有默认地址又没填 → 明确说要填', async () => {
    await expect(
      listRemoteModels({ provider: 'custom', fetchImpl: fake(200, ok(['a'])) }),
    ).rejects.toThrow(/接口地址/);
  });

  it('去重并按名字排序(下拉顺序要稳定)', async () => {
    const got = await listRemoteModels({
      provider: 'deepseek',
      apiKey: 'k',
      fetchImpl: fake(200, ok(['b', 'a', 'b'])),
    });
    expect(got.map((m) => m.model)).toEqual(['a', 'b']);
  });
});
