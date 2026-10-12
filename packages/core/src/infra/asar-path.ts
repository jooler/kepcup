/**
 * 打包应用里，凡是要交给**子进程**（`ELECTRON_RUN_AS_NODE=1` 的 Electron 自带 Node）
 * 直接加载的磁盘文件，都取 `app.asar.unpacked` 下的真实路径：子进程不该依赖 Electron
 * 的 asar 文件系统补丁（ESM 加载器根本不走它；fuse / `process.noAsar` 也能关掉它）。
 * 解出由 electron-builder 负责——显式的 `asarUnpack` 规则，或 smartUnpack 对含 `.node`
 * 的整个 npm 包目录自动解出（apps/desktop/electron-builder.yml）。
 *
 * 用法：D72 stdio 代理脚本（agent/external/stdio-proxy-path.ts）、组件查询子进程的
 * SQLite 驱动（widgets/query-runner.ts）。
 */

/** `…/app.asar/…` → `…/app.asar.unpacked/…`（asarUnpack 的落点）；不在 asar 内则原样返回。 */
export function unpackedAsarPath(file: string): string {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}
