#!/usr/bin/env node
/**
 * tsc 不复制非 TS 源文件：把运行时需要的静态资源拷到 dist/ 的对应位置。
 * 目前只有外部智能体的 stdio ↔ HTTP MCP 代理（D72 §4.4，运行路径见
 * src/agent/external/stdio-proxy-path.ts）。
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSETS = ['agent/external/stdio-proxy.mjs'];

for (const relative of ASSETS) {
  const from = path.join(packageDir, 'src', relative);
  const to = path.join(packageDir, 'dist', relative);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}
