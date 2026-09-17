import { describe, it, expect } from 'vitest';
import { extractCreds } from '../security/creds.js';

// 摘自用户真实粘贴的 cURL 片段(凭证值本身不敏感 —— 用户已更换)
const REAL_CURL = `curl --url 'https://api.bilibili.com/x/v3/fav/folder/collected/list?pn=1&ps=50&up_mid=27725036&platform=web' \\
  -H 'accept: */*' \\
  -b 'buvid3=F7B83BBE-C591-C346-D2F4-2A37928E5D2206389infoc; b_nut=1788747406; SESSDATA=97df5745%2C1804299628%2Cdbeca%2A92CjDwsHlg45iS2dIRliTnqTh5TMc9eZIJ51g2X5Me5_x1oKBA_vkDnxF6WSiy4lbvNM8SVmFlbDl4V1F6WWNwTllacC1fTE9uem0ycVRiVGJXQkNiSlhtZFRnd1hxakdRbE5WNzdSUWJab1gyam9rR041aDlWeXlGZjR0MlpnRDJ5MXBXN3Q5UDJnIIEC; bili_jct=e8e6b03cee259d737715609cb8473485; DedeUserID=27725036' \\
  -H 'user-agent: Mozilla/5.0'`;

describe('extractCreds', () => {
  it('从整段多行 cURL 里提取 SESSDATA 和 bili_jct(含 URL 编码)', () => {
    const { sessdata, bilijct } = extractCreds(REAL_CURL);
    expect(sessdata).toMatch(/^97df5745/);
    expect(sessdata).toContain('%2C'); // URL 编码被完整保留
    expect(sessdata).toContain('%2A');
    expect(bilijct).toBe('e8e6b03cee259d737715609cb8473485');
  });

  it('从裸 cookie 串里提取', () => {
    const { sessdata, bilijct } = extractCreds('SESSDATA=abc%2Cdef; bili_jct=xyz123');
    expect(sessdata).toBe('abc%2Cdef');
    expect(bilijct).toBe('xyz123');
  });

  it('大小写不敏感', () => {
    expect(extractCreds('sessdata=LOWERCASE; BILI_JCT=UC').sessdata).toBe('LOWERCASE');
  });

  it('值取到分隔符为止,不吞后面的字段', () => {
    const { bilijct } = extractCreds('bili_jct=abc123; DedeUserID=27725036');
    expect(bilijct).toBe('abc123');
  });

  it('缺失时返回 undefined,不误报', () => {
    expect(extractCreds('完全无关的文本')).toEqual({});
    expect(extractCreds('')).toEqual({});
  });
});
