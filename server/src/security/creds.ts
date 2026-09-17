/** 从任意文本里提取凭证。支持裸 cookie 串和整段 cURL(多行)。纯函数,可测。 */
export function extractCreds(raw: string): { sessdata?: string; bilijct?: string } {
  const pick = (name: string) =>
    new RegExp(`${name}=([^;'"\\s]+)`, 'i').exec(raw)?.[1];
  const sessdata = pick('SESSDATA');
  const bilijct = pick('bili_jct');
  return { sessdata, bilijct };
}
