import { createInterface } from 'node:readline/promises';
// 凭证解析在 security/creds.ts —— http/ 路由也要用它,不该让 http/ 反向依赖 probes/。
import { extractCreds } from '../security/creds.js';

/**
 * 交互式读取 cookie —— 不落盘、不读文件、不要求用户编辑任何东西。
 *
 * 支持两种粘贴方式:
 *   1. 只贴 cookie 值:`SESSDATA=xxx; bili_jct=yyy`
 *   2. 贴 `Copy as cURL` 的整段(DevTools 里右键任意请求即可复制)
 *
 * **多行粘贴**:终端里粘贴带 `\` 续行符的多行 cURL 时,`readline.question`
 * 只读第一行,后面全丢。所以这里改用逐行读,直到遇到空行才结束。
 */
export async function promptCookie(): Promise<{ sessdata?: string; bilijct?: string }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('--- bilibili 授权(可选)---');
    console.log('直接回车 = 跳过登录态检查(只跑 ①②③)。');
    console.log('要看自己的收藏夹,就把 cookie 整段粘进来:');
    console.log('  F12 → Network → 右键任意请求 → Copy as cURL → 整段粘贴即可。');
    console.log('  (多行内容直接整段粘贴,粘贴后按两次回车结束)\n');

    // 多行读入:逐行拼,遇到空行才停。
    // 第一行末尾是提示符本身,直接读到 'cookie: ' 后立刻是 '\n' → 跳过。
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      const line = await rl.question(i === 0 ? 'cookie: ' : '');
      if (line.trim() === '') break;
      lines.push(line);
    }
    const raw = lines.join('\n');

    const { sessdata, bilijct } = extractCreds(raw);

    if (raw.trim() && (!sessdata || !bilijct)) {
      console.log(
        '\n⚠️  没能从粘贴内容里同时找到 SESSDATA 和 bili_jct —— 检查一下是否复制完整。\n',
      );
    }
    return { sessdata, bilijct };
  } finally {
    rl.close();
  }
}
