#!/usr/bin/env node
/**
 * 同步本地 `file:` 依赖包 —— 复制语义下的"链接"。
 *
 * 背景:server / web 用 `"@seedhuang/ai_suit_tool": "file:../../ai_suit_tool"` 引用
 * **同级仓库**,根 `.npmrc` 的 `install-links=true` 让它按**复制**安装(而不是建软链 ——
 * 原因见 .npmrc 里那段说明:软链会让包内自带的 antd 命中第二份实例,主题断链)。
 *
 * 复制语义没有"改了源码就生效"的即时性,所以改完源包必须三步:
 *   ① 在源包 `npm run build`(exports 指向 dist,不构建就没有可解析的产物)
 *   ② 删掉消费方 node_modules 里的旧副本(单独跑 npm install 会输出 "up to date"
 *      什么都不做 —— 那条目录依赖没有 integrity、版本号也没变,npm 认为已满足)
 *   ③ 在仓库根 `npm install`,把新 dist 重新复制进来
 *
 * 这个脚本把三步串起来,并在最后**按内容哈希校验**副本真的更新了。校验是刻意的:
 * 前两步漏做任何一步都是**零报错**的,你会静默地用旧代码(踩过)。
 * 校验覆盖面:`files` 字段里的文件 + npm 无条件打包的 package.json / README / LICENSE
 * (改 exports / version 时 dist 内容不变,只比对 dist 会漏),并且对每个 spec 根做
 * **双向**比对(副本里多出来的旧产物也算不一致)。
 *
 * 包清单:**自动发现** —— 扫根与各 workspace 的 package.json,凡是 `file:` 开头的依赖
 * 都视为本地包。以后加新包照常声明 `file:` 依赖即可,不用动这个脚本。
 * 可在根 package.json 用 `localPackages` 覆盖:
 *   "localPackages": {
 *     "ignore": ["@scope/pkg"],                          // 排除误判
 *     "add": [{ "name": "@scope/pkg", "dir": "../pkg" }]  // 补录非常规包
 *   }
 *
 * 用法(对应的 npm script):
 *   npm run sync:local               同步:build → 删副本 → install → 校验
 *   npm run sync:local:check         只校验副本是否最新,不写任何东西;过期只提示,退出码仍为 0
 *   npm run sync:local:check:strict  同上,但过期时以非零退出 —— **CI 门禁用这个**
 *   (三条等价于 node scripts/sync-local-packages.mjs [--check [--strict]])
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** npm 在 Windows 上是 `npm.cmd`;调用统一经 shell(原因见 run 里的说明) */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const STRICT = args.includes('--strict');

const log = (s) => console.log(s);
const warn = (s) => console.warn(s);
const fail = (s) => {
  console.error(s);
  process.exitCode = 1;
};

const readJson = (p) => {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${p} 不是合法 JSON:${e.message}`);
  }
};

/** 把 `file:../x` 解析成绝对目录(相对**声明它的那个** package.json) */
function fileTargetDir(fromPkgDir, spec) {
  const raw = spec.slice('file:'.length).trim();
  return resolve(fromPkgDir, raw);
}

/**
 * 发现本地包。消费方目录 = 根 + 各 workspace(它们各自的 node_modules 里可能也有一份副本)。
 */
function discover() {
  const rootPkg = readJson(join(ROOT, 'package.json'));
  if (!rootPkg) throw new Error(`找不到 ${join(ROOT, 'package.json')}`);

  const wsNames = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
  const pkgDirs = [ROOT, ...wsNames.map((w) => resolve(ROOT, w))];

  const found = new Map(); // name -> { name, dir, declaredIn }
  for (const pkgDir of pkgDirs) {
    const pkg = readJson(join(pkgDir, 'package.json'));
    if (!pkg) continue;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
        if (!found.has(name)) {
          found.set(name, { name, dir: fileTargetDir(pkgDir, spec), declaredIn: pkgDir });
        }
      }
    }
  }

  // 根 package.json 的 localPackages 覆盖(可选)
  const cfg = rootPkg.localPackages ?? {};
  for (const name of cfg.ignore ?? []) found.delete(name);
  for (const entry of cfg.add ?? []) {
    if (!entry?.name || !entry?.dir) throw new Error('localPackages.add 的条目需要 name 与 dir');
    found.set(entry.name, {
      name: entry.name,
      dir: resolve(ROOT, entry.dir),
      declaredIn: ROOT,
    });
  }

  return { pkgs: [...found.values()], pkgDirs };
}

/** 消费方所有可能的副本位置:根与每个 workspace 的 node_modules/<name> */
function copyPaths(name, pkgDirs) {
  return pkgDirs.map((d) => join(d, 'node_modules', ...name.split('/')));
}

/**
 * 删副本。**必须区分软链与真目录** —— 若有人跑过 `npm link`,这里会是软链,
 * 而 `rmSync(recursive)` 会顺着软链把**源仓库**删掉。软链只 unlink 链接本身。
 */
function removeCopy(p) {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return 'absent';
  if (st.isSymbolicLink()) {
    unlinkSync(p);
    return 'unlinked';
  }
  // 父级也可能是软链(node_modules 整体、或 node_modules/@scope 被 link):此时
  // lstat(p) 会沿父级软链解析,把最终的真实目录判成普通目录,`rmSync(recursive)`
  // 就顺链删到链接目标(可能就是源仓库)。逐级检查父路径,fail-closed:宁可不删。
  for (let d = dirname(p); d !== dirname(d); d = dirname(d)) {
    if (lstatSync(d, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(
        `检测到 ${d} 是软链(可能是 npm link 的产物)—— 拒绝删除 ${p} 以免穿透到链接目标;` +
          '请先手动处理该链接(npm unlink)再重试',
      );
    }
  }
  // 双保险:递归删除前确认它确实在某个 node_modules 下(不误删源仓库)
  if (!p.split(sep).includes('node_modules')) {
    throw new Error(`拒绝递归删除不在 node_modules 下的路径:${p}`);
  }
  rmSync(p, { recursive: true, force: true });
  return 'removed';
}

function run(cmd, cmdArgs, cwd) {
  // **必须经 shell**:Windows 上 Node ≥ 20 禁止直接 spawn `.cmd`/`.bat`(报 EINVAL);
  // 命令与参数都是本文件内的固定短串、工作目录走 option 传递,不存在引号/注入问题
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: true });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

/** npm 无条件打包的根文件 —— `files` 字段管不住它们,但必须一起比对 */
const ALWAYS_PACKED = ['package.json', 'README.md', 'LICENSE'];

/**
 * 收集源包里"会被 npm 复制过去"的文件(按 package.json 的 files 字段)。
 * files 缺省时退化为 dist(有的话),再退化为整个目录(排除 node_modules / .git)。
 *
 * 返回 { files, roots, notices }:
 *   files   —— 包内相对路径清单(posix),要逐个比对哈希的文件
 *   roots   —— spec 根(包内相对路径,'.' 表示包根),用于"副本多余文件"的反向比对
 *   notices —— spec 解析不到实体等问题说明(必须当成不一致,不许静默跳过)
 */
function sourceFiles(pkgDir) {
  const pkg = readJson(join(pkgDir, 'package.json')) ?? {};
  let specs = Array.isArray(pkg.files) && pkg.files.length ? pkg.files : null;
  if (!specs) specs = existsSync(join(pkgDir, 'dist')) ? ['dist'] : [''];

  const files = [];
  const roots = [];
  const notices = [];

  const walk = (abs, rel) => {
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) {
        // 顶层目录跳过 node_modules/.git(它们不会被 npm 复制)
        if (abs === pkgDir && ['node_modules', '.git'].includes(name)) continue;
        walk(join(abs, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    files.push(rel || abs.slice(pkgDir.length + 1).replaceAll('\\', '/'));
  };

  for (const rawSpec of specs) {
    // 只支持最常见的 glob 形态:`X/**`、`X/*` 归一化成目录 `X`(整体看待)。
    // 更复杂的 glob 解析不到实体 → 进 notices(报警),绝不允许静默留下空清单。
    const spec = String(rawSpec).replaceAll('\\', '/').replace(/\/\*+$/, '').replace(/\/+$/, '');
    const abs = spec ? resolve(pkgDir, spec) : pkgDir;
    if (!existsSync(abs)) {
      notices.push(`${rawSpec}(源包里不存在这个路径,无法比对)`);
      continue;
    }
    roots.push(spec || '.');
    walk(abs, spec);
  }
  return { files, roots, notices };
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** 比一对文件:null 表示一致,'missing' 表示副本侧缺失,'different' 表示内容不同 */
function compareOne(srcAbs, dstAbs) {
  const st = lstatSync(dstAbs, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return 'missing';
  return sha256(srcAbs) === sha256(dstAbs) ? null : 'different';
}

/** 列出目录下所有文件的相对路径(posix,跳过 node_modules/.git);不是目录则为空集 */
function listFilesUnder(abs) {
  const out = new Set();
  const walk = (p, rel) => {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) {
        if (['node_modules', '.git'].includes(name)) continue;
        walk(join(p, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (rel) out.add(rel);
  };
  walk(abs, '');
  return out;
}

/**
 * 校验副本是否与源产物一致(按内容哈希)。
 * 返回 { ok, copy, diffs[], fileCount, missing } —— missing 表示副本根本不存在。
 */
function verify(pkg, copyPath) {
  if (!existsSync(copyPath)) {
    return { ok: false, missing: true, copy: copyPath, diffs: [], fileCount: 0 };
  }

  const src = sourceFiles(pkg.dir);
  // 清单为空**一律**判为不一致:diffs 为空会让 ok:true → 打印"副本最新",
  // 校验恒真通过(files 写了未支持的 glob、或源包没构建时都会走到这)。
  if (src.files.length === 0) {
    return {
      ok: false,
      missing: false,
      copy: copyPath,
      fileCount: 0,
      diffs: [
        ...src.notices,
        '未能从源包解析出任何源文件(files 是否用了未支持的 glob / 源包是否未构建?)',
      ],
    };
  }

  const diffs = [...src.notices];
  const inSource = (rel) => join(pkg.dir, ...rel.split('/'));
  const inCopy = (rel) => join(copyPath, ...rel.split('/'));

  // files 之外,npm 一定会打包的根文件也要比:package.json 的 exports / version
  // 改了而 dist 没变,恰恰是最容易让消费方导入失败的过期场景
  const alwaysPacked = ALWAYS_PACKED.filter((f) => existsSync(inSource(f)));
  for (const rel of [...src.files, ...alwaysPacked]) {
    const r = compareOne(inSource(rel), inCopy(rel));
    if (r === 'missing') diffs.push(`${rel}(副本缺此文件)`);
    else if (r === 'different') diffs.push(`${rel}(内容不同)`);
  }

  // 反向:副本里多出来的文件(源里已删的旧产物)。**只在 spec 根范围内**比,
  // 不扩展到整个副本目录 —— 否则会被 npm 顺带复制的 README / LICENSE 之类误报为多余
  for (const root of src.roots) {
    const rootAbs = root === '.' ? pkg.dir : inSource(root);
    if (!lstatSync(rootAbs, { throwIfNoEntry: false })?.isDirectory()) continue;
    const prefix = root === '.' ? '' : `${root}/`;
    const expected = new Set(
      src.files.filter((rel) => rel.startsWith(prefix)).map((rel) => rel.slice(prefix.length)),
    );
    for (const rel of listFilesUnder(root === '.' ? copyPath : inCopy(root))) {
      if (!expected.has(rel)) diffs.push(`${prefix}${rel}(副本多余)`);
    }
  }

  return {
    ok: diffs.length === 0,
    missing: false,
    copy: copyPath,
    diffs,
    fileCount: src.files.length + alwaysPacked.length,
  };
}

function main() {
  const { pkgs, pkgDirs } = discover();

  if (pkgs.length === 0) {
    log('没有发现任何 `file:` 依赖,无需同步。');
    return;
  }

  log(`发现 ${pkgs.length} 个本地包:`);
  for (const p of pkgs) {
    log(`  · ${p.name}  ←  ${relative(ROOT, p.dir) || '.'}  (声明于 ${relative(ROOT, p.declaredIn) || '根'})`);
  }
  log('');

  if (CHECK_ONLY) {
    let stale = 0;
    for (const p of pkgs) {
      // 源目录不存在就没有比对基准 —— 必须报过期,否则 CI 里会永远绿灯
      if (!existsSync(p.dir)) {
        warn(`✗ ${p.name}:源目录不存在,无法判定副本是否最新 —— ${relative(ROOT, p.dir)}`);
        stale += 1;
        continue;
      }
      // 副本可能只存在于其中一层(workspaces 通常提升到根);任一层存在就算已安装
      const present = copyPaths(p.name, pkgDirs).filter((c) => existsSync(c));
      if (present.length === 0) {
        warn(`✗ ${p.name}:副本不存在 —— 跑一次 \`npm install\`(或 npm run sync:local)`);
        stale += 1;
        continue;
      }
      const bad = present.map((c) => verify(p, c)).filter((v) => !v.ok);
      if (bad.length === 0) {
        log(`✓ ${p.name}:副本最新(比对 ${present.length} 处)`);
      } else {
        stale += 1;
        warn(`✗ ${p.name}:副本已过期 —— 跑 \`npm run sync:local\` 再继续`);
        for (const v of bad) {
          warn(`    ${relative(ROOT, v.copy)}:`);
          for (const d of v.diffs.slice(0, 8)) warn(`      - ${d}`);
          if (v.diffs.length > 8) warn(`      …还有 ${v.diffs.length - 8} 处`);
        }
      }
    }
    if (stale > 0) {
      warn('');
      warn(`${stale} 个包的副本不是最新的 —— 现在跑的是旧代码。`);
      if (STRICT) process.exitCode = 1;
    } else {
      log('\n全部最新。');
    }
    return;
  }

  // ── 同步:① build ② 删副本 ③ install ──────────────────
  for (const p of pkgs) {
    if (!existsSync(p.dir)) {
      throw new Error(`${p.name} 的源目录不存在:${p.dir}\n（file: 依赖要求源仓库就在这个路径上）`);
    }
    const srcPkg = readJson(join(p.dir, 'package.json'));
    if (srcPkg?.scripts?.build) {
      log(`[1/3] 构建 ${p.name} …`);
      const code = run(NPM, ['run', 'build'], p.dir);
      if (code !== 0) {
        throw new Error(
          `${p.name} 构建失败(exit ${code})。\n` +
            `提示:若源包还没装依赖,先在 ${p.dir} 跑一次 \`npm install\`。`,
        );
      }
    } else {
      warn(`[1/3] 跳过构建 ${p.name} —— 源包没有 build 脚本`);
    }

    log(`[2/3] 删除 ${p.name} 的旧副本 …`);
    let removed = 0;
    for (const c of copyPaths(p.name, pkgDirs)) {
      const what = removeCopy(c);
      if (what !== 'absent') {
        log(`      ${what === 'unlinked' ? '解除软链' : '已删除'} ${relative(ROOT, c)}`);
        removed += 1;
      }
    }
    if (removed === 0) log('      (没有找到旧副本,首次安装?)');
  }

  log('[3/3] 安装(把新产物复制进来)…');
  const code = run(NPM, ['install'], ROOT);
  if (code !== 0) throw new Error(`npm install 失败(exit ${code})`);

  // ── 校验:不通过就非零退出,别让"静默用旧代码"蒙混过关 ──
  log('\n校验副本内容:');
  let bad = 0;
  for (const p of pkgs) {
    const present = copyPaths(p.name, pkgDirs).filter((c) => existsSync(c));
    if (present.length === 0) {
      fail(`✗ ${p.name}:安装后副本仍不存在 —— npm install 没有复制它(检查 .npmrc 的 install-links)`);
      bad += 1;
      continue;
    }
    const results = present.map((c) => verify(p, c));
    const notOk = results.filter((v) => !v.ok);
    if (notOk.length === 0) {
      log(`  ✓ ${p.name}:已更新且与源产物一致(${results[0].fileCount} 个文件)`);
    } else {
      bad += 1;
      fail(`✗ ${p.name}:副本与源产物**不一致** —— 这次同步没生效`);
      for (const v of notOk) {
        fail(`    ${relative(ROOT, v.copy)}`);
        for (const d of v.diffs.slice(0, 8)) fail(`      - ${d}`);
      }
    }
  }

  if (bad === 0) log('\n同步完成。');
}

try {
  main();
} catch (e) {
  fail(`\n出错了:${e.message}`);
}
