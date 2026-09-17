export interface Fingerprint {
  buvid3: string;
  buvid4: string;
}

const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 获取设备指纹。实测确认这是独立于 wbi 签名的一道必要防线:
 * 只签名不带 buvid3 会被判 -352,补上即通过。
 *
 * 拿到后应存入 settings 复用,不要每次请求都重新获取。
 */
export async function fetchFingerprint(
  fetchImpl: typeof fetch = fetch,
): Promise<Fingerprint> {
  const res = await fetchImpl(SPI_URL, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  const body = (await res.json()) as {
    code?: number;
    message?: string;
    data?: { b_3?: string; b_4?: string };
  };

  if (body.code !== 0 || !body.data?.b_3 || !body.data?.b_4) {
    throw new Error(
      `获取设备指纹失败:code=${body.code} message=${body.message ?? ''}`,
    );
  }
  return { buvid3: body.data.b_3, buvid4: body.data.b_4 };
}
