import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * KepCup 版 `forked-child-entry-path`（解耦点 2，替代 orca src/main/forked-child-entry-path.ts）。
 *
 * sidecar 由 electron.vite.config.ts 的独立入口产出到 out/main/computer-sidecar.js——
 * 与主进程入口同级。入口按「与引用它的 bundle 同目录」解析：rollup 把本模块内联进
 * out/main/index.js，import.meta.url 指向 bundle 自身而非源码里的 computer/ 目录，
 * 不能按源码层级回溯（多退一级到 out/ 后产物不在那里，capabilities 握手必挂——
 * 2026-10-31 冒烟测试实测）。打包后 out/ 进 app.asar，`ELECTRON_RUN_AS_NODE=1`
 * 的子进程不能读 asar 内的 ESM 文件，按 stdio-proxy 先例
 * （packages/core/src/infra/asar-path.ts）换到 app.asar.unpacked（正则本地复制：
 * main 不依赖 core 包）；electron-builder asarUnpack 与 helper 的 socket peer
 * 校验（main.swift 按 /out/main/computer-sidecar.js 前缀识别 sidecar）都锚定
 * 这个同目录布局。
 */

/** `…/app.asar/…` → `…/app.asar.unpacked/…`（asarUnpack 的落点）；不在 asar 内则原样返回。 */
export function unpackedAsarPath(file: string): string {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/** 解析 sidecar 入口：dev 下 out/main/<entryFileName>，打包后 app.asar.unpacked/out/main/ 下同名文件。 */
export function getForkedChildEntryPath(
  entryFileName: string,
  moduleUrl: string = import.meta.url,
): string {
  return unpackedAsarPath(join(dirname(fileURLToPath(moduleUrl)), entryFileName))
}
