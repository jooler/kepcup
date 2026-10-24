#!/usr/bin/env node
// kepcup-server 打包（D102 §4）：产出单一自包含 tar.gz——同一文件两种用法：
//   npm 方式（优先）：npm i -g <tarball 文件或 URL>
//   tar 方式（补充）：解压后 ./dist/cli.js 直接跑（离线可装）
//
// 流程：pnpm deploy（workspace 依赖内联成真实 node_modules，原生模块按当前平台
// 预构建）→ 改写 package.json（dependencies → bundledDependencies、改 kepcup-server
// 名与版本）→ chmod bin → tar.gz。平台由构建机决定（CI 按 matrix 出
// linux-x64 / linux-arm64）。
//
//   node scripts/pack-server.mjs [--out <dir>] [--version <v>] [--skip-web]
//
// --version 缺省取 apps/desktop/package.json（发版触发同源）；--skip-web 跳过
// web 构建复用已有 apps/server/web（本地迭代用）。

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { out: path.join(root, 'release-server'), version: undefined, skipWeb: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') options.out = path.resolve(root, argv[++i]);
    else if (argv[i] === '--version') options.version = argv[++i];
    else if (argv[i] === '--skip-web') options.skipWeb = true;
    else throw new Error(`未知参数 ${argv[i]}`);
  }
  return options;
}

function run(command, args, env = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
}

const options = parseArgs(process.argv.slice(2));
const desktopVersion = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).version;
const version = options.version ?? desktopVersion;
const stage = path.join(options.out, 'stage');
const pkgDir = path.join(stage, 'package');

console.log(`[pack-server] 版本 ${version}，暂存 ${stage}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1) web 构建（PWA 静态产物 → apps/server/web）。复用同一份 vite 配置，只改投递目录。
if (!options.skipWeb) {
  console.log('[pack-server] 构建 web（renderer 同源 PWA）');
  run('pnpm', ['--filter', '@kepcup/desktop', 'run', 'build:web'], {
    // vite 配置里 resolve(__dirname, env) 以 apps/desktop 为基——必须给绝对路径。
    KEPCUP_WEB_OUTDIR: path.join(root, 'apps', 'server', 'web'),
  });
}
if (!existsSync(path.join(root, 'apps/server/web/index.html'))) {
  throw new Error('apps/server/web/index.html 缺失：先跑 web 构建（去掉 --skip-web）');
}

// 2) server 自身构建（dist/）。
console.log('[pack-server] 构建 @kepcup/server');
run('pnpm', ['--filter', '@kepcup/server', 'run', 'build']);

// 3) pnpm deploy：自包含目录（workspace 包构建产物 + 生产依赖 node_modules）。
//    pnpm 10+ 的 deploy 需要 --legacy（无 inject-workspace 配置的打包场景）。
console.log('[pack-server] pnpm deploy');
run('pnpm', ['--filter', '@kepcup/server', 'deploy', '--prod', '--legacy', pkgDir]);

// 4) 改写 package.json：bundledDependencies 让 npm 把 node_modules 视为包内容
//    （npm i -g <tarball> 不再尝试解析依赖）；发布名 kepcup-server（npm i -g 后
//    命令即 kepcup-server）。
const pkgPath = path.join(pkgDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const dependencies = Object.keys(pkg.dependencies ?? {});
delete pkg.devDependencies;
pkg.name = 'kepcup-server';
pkg.version = version;
pkg.description = 'KepCup headless 服务端：自托管常驻大脑（NAS / 云服务器）';
pkg.private = false;
if (dependencies.length > 0) {
  pkg.bundledDependencies = dependencies;
  delete pkg.dependencies;
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// 5) 入口可执行（tar 方式解压直接 ./dist/cli.js）。
chmodSync(path.join(pkgDir, 'dist', 'cli.js'), 0o755);

// 6) tar.gz（tarball 根 = package/，npm 两种安装方式都认）。
const platform = process.platform;
const arch = process.arch;
const tarball = path.join(options.out, `kepcup-server-v${version}-${platform}-${arch}.tar.gz`);
console.log(`[pack-server] 打 tar：${tarball}`);
rmSync(tarball, { force: true });
run('tar', ['-czf', tarball, '-C', pkgDir, '.']);

// 收尾：stage 目录留给人工检查，重跑会清。
console.log(`[pack-server] 完成：${path.relative(root, tarball)}`);
console.log('[pack-server] 验证：tar -tzf 解包清单 / 解压后 ./dist/cli.js version');
