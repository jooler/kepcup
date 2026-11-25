#!/usr/bin/env node
/**
 * CI guard：剪除 pnpm-lock.yaml 中指向「无 package.json 目录」的 importer 段。
 *
 * 背景：仓库的闭源组件（apps/team-server，见该目录 README 与
 * docs/design/63-closed-source-team-server.md）作为嵌套私有仓推进开发，
 * 本地 lockfile 会带上它的 importer 段；公开仓 checkout 里该目录只有占位
 * README、没有 package.json，`pnpm install --frozen-lockfile` 会因 lockfile
 * 与 workspace 集不匹配而失败。此脚本在 CI install 前按目录判断（目录里
 * 没有 package.json 就剪除对应 importer），是通用逻辑、不点名任何组件；
 * 本地开发目录齐备时什么都不剪，行为不变。
 *
 * 用法：node scripts/prune-lockfile-importers.mjs [lockfile 路径]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const lockPath = process.argv[2] ?? 'pnpm-lock.yaml';
const lockRoot = path.dirname(path.resolve(lockPath));
if (!existsSync(lockPath)) {
  console.error(`[prune-lockfile-importers] 找不到 ${lockPath}，跳过`);
  process.exit(0);
}
const lines = readFileSync(lockPath, 'utf8').split('\n');

// importer 段的键行是两空格缩进（如 "  apps/team-server/server:"），其子行缩进
// 更深；下一个顶格键标志 importers: 段结束。根 importer（"."）始终保留。
const out = [];
let skipping = false;
let inImporters = false;
const pruned = [];
for (const line of lines) {
  if (/^[^\s#]/.test(line)) {
    inImporters = line.startsWith('importers:');
    skipping = false;
    out.push(line);
    continue;
  }
  if (!inImporters) {
    out.push(line);
    continue;
  }
  const keyMatch = line.match(/^ {2}(\S.*):$/);
  if (keyMatch) {
    const dir = keyMatch[1].replaceAll('"', '');
    skipping = dir !== '.' && !existsSync(path.join(lockRoot, dir, 'package.json'));
    if (skipping) pruned.push(dir);
  }
  if (!skipping) out.push(line);
}

if (pruned.length > 0) {
  writeFileSync(lockPath, out.join('\n'));
  console.log(
    `[prune-lockfile-importers] 已剪除 ${pruned.length} 个缺失包目录的 importer：${pruned.join(', ')}`,
  );
} else {
  console.log('[prune-lockfile-importers] lockfile 与 workspace 目录一致，无需剪除');
}
