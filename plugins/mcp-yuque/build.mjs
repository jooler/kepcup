#!/usr/bin/env node
/**
 * 构建语雀 MCPB（plugins/mcp-yuque/mcp/yuque.mcpb）：
 *
 *   node plugins/mcp-yuque/build.mjs
 *
 * 1. 在临时目录 `npm install yuque-mcp@1`（官方 server，npm 包自带 dist 产物）；
 * 2. 拷入 `mcp/manifest.json`（MCPB v0.3 清单，user_config = token(sensitive) + host）；
 * 3. 用系统 `zip` 打包为 `mcp/yuque.mcpb`（相对路径、条目排序固定）。
 *
 * 构建需 macOS / Linux（依赖系统 `zip` 命令与 POSIX shell；Windows 无系统 zip）。
 * 产物需要先于 `kepcup-app validate` / `pack` 存在；发布批次见 plugins/README.md。
 * 仓库不追踪构建中间目录（node_modules），只追踪最终的 .mcpb。
 * ⚠️ 已入库的 .mcpb 不要随手重跑本脚本：依赖范围（^x）会拉到新版本、产物字节漂移，
 * 内容寻址发布体系里等于换包。升依赖版本是独立的一次发布（重跑 → validate → pack → 签名）。
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const mcpDir = path.join(pluginDir, 'mcp');
const output = path.join(mcpDir, 'yuque.mcpb');
const buildDir = path.join(pluginDir, '.build-yuque');

function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(path.join(root, entry.name), `${name}/`));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

// 独立 package.json：把 npm 限制在本目录（外层是 pnpm workspace，裸 install 会撞根清单）。
writeFileSync(
  path.join(buildDir, 'package.json'),
  JSON.stringify({ name: 'yuque-mcp-bundle', private: true, version: '1.0.0' }, null, 2),
);

// 1. 官方 server：固定主版本，仅运行时依赖。失败（registry 不可达等）也要清掉临时目录，
//    否则残留的 package.json / package-lock.json 会以 untracked 身份干扰下一次提交。
try {
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', 'yuque-mcp@^1.0.0'], {
    cwd: buildDir,
    stdio: 'inherit',
  });
} catch (error) {
  rmSync(buildDir, { recursive: true, force: true });
  throw error;
}

// 1b. 产物内容校验：npm 空装（registry 异常 / 包名变动）不该 zip 出"成功"的空包——
// 入口与官方 server 的 env 契约（YUQUE_PERSONAL_TOKEN / YUQUE_BASE_URL，见 manifest.json）
// 都必须在位，否则在打包前就失败。
const installed = listFiles(buildDir);
for (const required of [
  'node_modules/yuque-mcp/dist/cli.js',
  'node_modules/yuque-mcp/package.json',
]) {
  if (!installed.includes(required)) {
    rmSync(buildDir, { recursive: true, force: true });
    throw new Error(`yuque-mcp 安装产物缺少 ${required}——检查 npm 源与包版本`);
  }
}
const cliSource = readFileSync(path.join(buildDir, 'node_modules/yuque-mcp/dist/cli.js'), 'utf8');
for (const envKey of ['YUQUE_PERSONAL_TOKEN', 'YUQUE_BASE_URL']) {
  if (!cliSource.includes(envKey)) {
    rmSync(buildDir, { recursive: true, force: true });
    throw new Error(
      `yuque-mcp 的 cli.js 不再读取 ${envKey}——manifest.json 的 env 键名需要同步更新`,
    );
  }
}

// 2. MCPB 清单在包根。
cpSync(path.join(mcpDir, 'manifest.json'), path.join(buildDir, 'manifest.json'));

// 3. zip（条目按路径排序；-X 去掉额外属性，-q 静默）。
rmSync(output, { force: true });
execFileSync('zip', ['-r', '-X', '-q', output, ...listFiles(buildDir)], {
  cwd: buildDir,
  stdio: 'inherit',
});

rmSync(buildDir, { recursive: true, force: true });
const bytes = statSync(output).size;
console.log(`yuque.mcpb 构建完成：${output}（${(bytes / 1024 / 1024).toFixed(1)} MB）`);
