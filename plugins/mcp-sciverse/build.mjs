#!/usr/bin/env node
/**
 * 构建 Sciverse MCPB（plugins/mcp-sciverse/mcp/sciverse.mcpb）：
 *
 *   node plugins/mcp-sciverse/build.mjs
 *
 * 1. 在临时目录 `npm install sciverse-mcp-server@^1`（官方 server，npm 包自带 dist 产物）；
 * 2. 拷入 `mcp/manifest.json`（MCPB v0.3 清单，user_config = token(sensitive)）；
 * 3. 用系统 `zip` 打包为 `mcp/sciverse.mcpb`（相对路径、条目排序固定）。
 *
 * 构建需 macOS / Linux（依赖系统 `zip` 命令与 POSIX shell；Windows 无系统 zip）。
 * 产物需要先于 `kepcup-app validate` / `pack` 存在；发布批次见 plugins/README.md。
 * 仓库不追踪构建中间目录（node_modules），只追踪最终的 .mcpb。
 * ⚠️ 已入库的 .mcpb 不要随手重跑本脚本：依赖范围（^x）会拉到新版本、产物字节漂移，
 * 内容寻址发布体系里等于换包。升依赖版本是独立的一次发布（重跑 → validate → pack → 签名）。
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const mcpDir = path.join(pluginDir, 'mcp');
const output = path.join(mcpDir, 'sciverse.mcpb');
const buildDir = path.join(pluginDir, '.build-sciverse');

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
  JSON.stringify({ name: 'sciverse-mcp-bundle', private: true, version: '1.0.0' }, null, 2),
);

// 1. 官方 server：固定主版本，仅运行时依赖。失败（registry 不可达等）也要清掉临时目录，
//    否则残留的 package.json / package-lock.json 会以 untracked 身份干扰下一次提交。
try {
  execFileSync(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', 'sciverse-mcp-server@^1.0.1'],
    {
      cwd: buildDir,
      stdio: 'inherit',
    },
  );
} catch (error) {
  rmSync(buildDir, { recursive: true, force: true });
  throw error;
}

// 1b. 产物内容校验：npm 空装（registry 异常 / 包名变动）不该 zip 出"成功"的空包——
// 入口与官方 server 的 env 契约（SCIVERSE_API_TOKEN，见 manifest.json）都必须在位，
// 否则在打包前就失败。token 解析在官方包的 config/credentials 模块里而非 cli.js，
// 因此扫整个 dist 目录。
const installed = listFiles(buildDir);
for (const required of [
  'node_modules/sciverse-mcp-server/dist/cli.js',
  'node_modules/sciverse-mcp-server/package.json',
]) {
  if (!installed.includes(required)) {
    rmSync(buildDir, { recursive: true, force: true });
    throw new Error(`sciverse-mcp-server 安装产物缺少 ${required}——检查 npm 源与包版本`);
  }
}
const distFiles = installed.filter(
  (f) => f.startsWith('node_modules/sciverse-mcp-server/dist/') && f.endsWith('.js'),
);
if (distFiles.length === 0) {
  rmSync(buildDir, { recursive: true, force: true });
  throw new Error('sciverse-mcp-server 的 dist 目录为空——检查 npm 源与包版本');
}
const distSource = distFiles
  .map((f) => readFileSyncSafe(path.join(buildDir, f)))
  .join('\n');
if (!distSource.includes('SCIVERSE_API_TOKEN')) {
  rmSync(buildDir, { recursive: true, force: true });
  throw new Error(
    'sciverse-mcp-server 的 dist 产物不再读取 SCIVERSE_API_TOKEN——manifest.json 的 env 键名需要同步更新',
  );
}
// 取证：明确本次实际安装到的官方包版本（^x 范围会随上游发版漂移，版本变了就是独立升版发布）。
const officialVersion = JSON.parse(
  readFileSync(path.join(buildDir, 'node_modules/sciverse-mcp-server/package.json'), 'utf8'),
).version;
console.log(`sciverse-mcp-server 安装版本：${officialVersion}`);

// 2. MCPB 清单在包根。
cpSync(path.join(mcpDir, 'manifest.json'), path.join(buildDir, 'manifest.json'));

// 3. zip（条目按路径排序；-X 去掉额外属性，-q 静默）。
//    排除构建脚手架 package.json / package-lock.json：它们只是把 npm 限制在本目录用的
//    临时文件，不该进发布产物——MCPB 根只有 manifest.json + node_modules/。
const bundled = listFiles(buildDir).filter(
  (f) => f !== 'package.json' && f !== 'package-lock.json',
);
rmSync(output, { force: true });
try {
  execFileSync('zip', ['-r', '-X', '-q', output, ...bundled], {
    cwd: buildDir,
    stdio: 'inherit',
  });
} catch (error) {
  // 与 npm install 失败同口径：清掉临时目录再抛，别留 untracked 残骸干扰下一次提交。
  rmSync(buildDir, { recursive: true, force: true });
  throw error;
}

rmSync(buildDir, { recursive: true, force: true });
const bytes = statSync(output).size;
console.log(`sciverse.mcpb 构建完成：${output}（${(bytes / 1024 / 1024).toFixed(1)} MB）`);

function readFileSyncSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
