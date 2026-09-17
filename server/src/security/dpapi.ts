import { Dpapi, isPlatformSupported } from '@primno/dpapi';

const SCOPE = 'CurrentUser' as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** DPAPI 在当前平台可用吗?(仅 Windows x64/arm64) */
export function dpapiAvailable(): boolean {
  return isPlatformSupported;
}

/** 加密为 base64。非 Windows 平台降级为明文(标注前缀以便识别) */
export function encryptSecret(plain: string): string {
  if (!dpapiAvailable()) return `plain:${plain}`;
  const encBuf = Dpapi.protectData(enc.encode(plain), null, SCOPE);
  return Buffer.from(encBuf).toString('base64');
}

/** 解密。非 Windows / 解不出 → null */
export function decryptSecret(stored: string): string | null {
  if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
  if (!dpapiAvailable()) return null;
  try {
    const buf = Buffer.from(stored, 'base64');
    const out = Dpapi.unprotectData(new Uint8Array(buf), null, SCOPE);
    return dec.decode(out);
  } catch {
    return null; // 换机器/换账户/损坏 → 解不出,调用方重新授权
  }
}
