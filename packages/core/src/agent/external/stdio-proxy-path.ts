import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unpackedAsarPath } from '../../infra/asar-path.js';

/**
 * stdio ↔ HTTP MCP 代理脚本（`stdio-proxy.mjs`，D72 §4.4）的运行时路径。
 *
 * 脚本始终与引用它的模块同目录分发：
 * - 测试 / 开发：`src/agent/external/stdio-proxy.mjs`；
 * - `pnpm --filter @kepcup/core build`：tsc 不复制 .mjs，由
 *   `packages/core/scripts/copy-assets.mjs` 拷到 `dist/agent/external/`；
 * - 打包应用：core 被 esbuild 并进 `out/main/core-entry/index.js`（模块 URL
 *   即该文件），`apps/desktop/scripts/dist.mjs` 把脚本拷到同目录，
 *   electron-builder `asarUnpack` 解出 asar——子进程（`ELECTRON_RUN_AS_NODE=1`）
 *   读 `app.asar.unpacked` 下的真实文件。
 *
 * 返回 null = 未随应用分发（调用方不注入 stdio 代理）。P4 只提供解析，尚未
 * 接线：本期 Agent 都支持 http MCP（P5 遇到只支持 stdio 的 Agent 时接入）。
 */
export function resolveStdioProxyPath(
  moduleUrl: string = import.meta.url,
  exists: (file: string) => boolean = existsSync,
): string | null {
  const candidate = unpackedAsarPath(fileURLToPath(new URL('./stdio-proxy.mjs', moduleUrl)));
  return exists(candidate) ? candidate : null;
}

// 映射规则与组件查询子进程的驱动路径共用（infra/asar-path.ts）。
export { unpackedAsarPath };
