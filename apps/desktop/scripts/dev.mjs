#!/usr/bin/env node

/**
 * pnpm dev 的入口（D105）：先确保 macOS computer-use helper .app 存在
 * （ensure-computer-use-helper.mjs——无产物自动构建一次，`--rebuild` 强制重建），
 * 再走原有的 patch-dev-electron.cjs + electron-vite dev 链。
 *
 * 单独包一层是因为 pnpm 把 `pnpm dev --rebuild` 的追加参数放在脚本链最后一个
 * 命令的 argv 上：这里把 `--rebuild` 消费掉转给 ensure 脚本，其余参数原样透传
 * 给 electron-vite（保持 `electron-vite dev [options] [-- app args]` 语义不变）。
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const restArgs = args.filter((arg) => arg !== '--rebuild');

const ensure = spawnSync(
  process.execPath,
  [path.join(scriptDir, 'ensure-computer-use-helper.mjs'), ...(rebuild ? ['--rebuild'] : [])],
  { stdio: 'inherit' },
);
if (ensure.status !== 0) process.exit(ensure.status ?? 1);

const patch = spawnSync(process.execPath, [path.join(scriptDir, 'patch-dev-electron.cjs')], {
  stdio: 'inherit',
});
if (patch.status !== 0) process.exit(patch.status ?? 1);

// 用 node 直接跑 electron-vite 的 bin 入口，而不是依赖 PATH 里的 .bin shim——
// Windows 的 shim 是 .cmd，spawn 不带 shell 拉不起来。bin 子路径不在 exports 里，
// 从（exports 放行的）package.json 位置推导。
const require = createRequire(import.meta.url);
const electronViteRoot = path.dirname(require.resolve('electron-vite/package.json'));
const electronViteBin = path.join(electronViteRoot, 'bin', 'electron-vite.js');
const dev = spawnSync(process.execPath, [electronViteBin, 'dev', ...restArgs], {
  stdio: 'inherit',
});
process.exit(dev.status ?? 1);
