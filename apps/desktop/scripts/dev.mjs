#!/usr/bin/env node

/**
 * pnpm dev 的入口（D105 / P-B2）：先确保 CuaDriver 产物存在
 * （fetch-cua-driver.mjs——已安装则秒回；缓存缺失时下载约 85MB，下载失败只打印
 * 可行动错误、不阻塞其它开发——运行时会把 computer-use 报为不可用），
 * 再走原有的 patch-dev-electron.cjs + electron-vite dev 链。
 *
 * `--rebuild` 会先删除 resources/cua-driver/darwin-<arch> 再重新 fetch；
 * 其余参数原样透传给 electron-vite（保持 `electron-vite dev [options] [-- app args]`
 * 语义不变）。KEPCUP_SKIP_COMPUTER_USE=1 跳过整个获取步骤。
 *
 * 单独包一层是因为 pnpm 把 `pnpm dev --rebuild` 的追加参数放在脚本链最后一个
 * 命令的 argv 上。
 */

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const restArgs = args.filter((arg) => arg !== '--rebuild');

if (process.env.KEPCUP_SKIP_COMPUTER_USE === '1') {
  console.log('[dev] KEPCUP_SKIP_COMPUTER_USE=1，跳过 CuaDriver 获取');
} else {
  if (rebuild) {
    const arch = process.arch === 'x64' ? 'x64' : 'arm64';
    rmSync(path.join(scriptDir, '..', 'resources', 'cua-driver', `darwin-${arch}`), {
      recursive: true,
      force: true,
    });
  }
  const fetchCuaDriver = spawnSync(
    process.execPath,
    [path.join(scriptDir, 'fetch-cua-driver.mjs')],
    { stdio: 'inherit' },
  );
  if (fetchCuaDriver.status !== 0) {
    console.error(
      '[dev] CuaDriver 获取失败：计算机操控将不可用。检查网络后重跑 node scripts/fetch-cua-driver.mjs，' +
        '或设置 KEPCUP_SKIP_COMPUTER_USE=1 显式跳过。',
    );
  }
}

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
