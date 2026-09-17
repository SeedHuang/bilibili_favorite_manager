import { describe, it, expect, vi } from 'vitest';
import { fetchFingerprint } from './fingerprint.js';

const okBody = {
  code: 0,
  message: '0',
  data: { b_3: 'BUV-3-VALUE', b_4: 'BUV-4-VALUE' },
};

function mockFetch(body: unknown, httpStatus = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: httpStatus,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('fetchFingerprint', () => {
  it('从 spi 接口取出 b_3 / b_4', async () => {
    const fp = await fetchFingerprint(mockFetch(okBody));
    expect(fp).toEqual({ buvid3: 'BUV-3-VALUE', buvid4: 'BUV-4-VALUE' });
  });

  it('请求打到正确的路径', async () => {
    const f = mockFetch(okBody);
    await fetchFingerprint(f);
    const url = String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url).toContain('/x/frontend/finger/spi');
  });

  it('带上浏览器 UA', async () => {
    const f = mockFetch(okBody);
    await fetchFingerprint(f);
    const init = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(String((init.headers as Record<string, string>)['User-Agent'])).toMatch(/Mozilla/);
  });

  it('code 非 0 时抛错', async () => {
    await expect(fetchFingerprint(mockFetch({ code: -412, message: '拦截' })))
      .rejects.toThrow(/指纹/);
  });

  it('data 缺字段时抛错', async () => {
    await expect(fetchFingerprint(mockFetch({ code: 0, data: { b_3: 'x' } })))
      .rejects.toThrow(/指纹/);
  });
});
