import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * KepCup 版 `forked-child-entry-path`（解耦点 2，替代 orca src/main/forked-child-entry-path.ts）。
 *
 * sidecar 由 electron.vite.config.ts 的独立入口产出到 out/main/computer-sidecar.js——
 * 与主进程入口同级；本模块自身在 out/main/computer/ 下，因此入口是本目录的上一级。
 * 打包后 out/ 进 app.asar，`ELECTRON_RUN_AS_NODE=1` 的子进程不能读 asar 内的 ESM
 * 文件，按 stdio-proxy 先例（packages/core/src/infra/asar-path.ts）换到
 * app.asar.unpacked（正则本地复制：main 不依赖 core 包）。
 */

/** `…/app.asar/…` → `…/app.asar.unpacked/…`（asarUnpack 的落点）；不在 asar 内则原样返回。 */
export function unpackedAsarPath(file: string): string {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/** 解析 sidecar 入口：dev 下 out/main/<entryFileName>，打包后 app.asar.unpacked 下同名文件。 */
export function getForkedChildEntryPath(entryFileName: string): string {
  return unpackedAsarPath(join(dirname(fileURLToPath(import.meta.url)), '..', entryFileName))
}
