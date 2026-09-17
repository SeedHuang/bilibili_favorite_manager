import { describe, it, expect, vi } from 'vitest';
import { encryptSecret, decryptSecret } from './dpapi.js';

// 真实 DPAPI 在同进程内 roundtrip 是稳定的(已实测)
describe('dpapi', () => {
  it('加密再解密还原', () => {
    const s = 'SESSDATA=abc%2Cdef; bili_jct=xyz';
    const enc = encryptSecret(s);
    expect(enc).not.toContain('SESSDATA');
    expect(decryptSecret(enc)).toBe(s);
  });

  it('两次加密得到不同密文(随机 IV)', () => {
    const s = '同一个秘密';
    expect(encryptSecret(s)).not.toBe(encryptSecret(s));
  });

  it('解不出来返回 null(而不是抛错)', () => {
    expect(decryptSecret('不是有效密文')).toBeNull();
    expect(decryptSecret('')).toBeNull();
  });

  it('换机器/换账户的密文解不出 → null', () => {
    // 用一个来自"另一台机器"的假密文(任意垃圾 base64)
    expect(decryptSecret(Buffer.from('garbage-from-another-machine').toString('base64'))).toBeNull();
  });
});
