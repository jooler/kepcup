import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  AppError,
  isReservedPluginNamespace,
  MCP_SERVER_ID_PATTERN,
  pluginIdSchema,
  pluginNamespaceOf,
  pluginVersionSchema,
} from '@kepcup/shared';

/**
 * Plugin identity helpers (D104): the on-disk directory name, the guarded install dir
 * (same defence-in-depth shape as `McpbInstaller.installDirOf`), the stable MCP server id
 * derived from `{pluginId}#{contributionId}`, and the reserved-namespace gate that only
 * marketplace / local installs go through (the builtin loader never calls it).
 */

/** `io.github.alice/doc-tools@1.2.0`, lower-cased: one slot per id on case-insensitive file systems. */
export function pluginDirName(id: string, version: string): string {
  return `${id}@${version}`.toLowerCase();
}

/** Absolute install dir `{pluginsDir}/{ns}/{name}@{version}`; rejects anything outside it. */
export function pluginDirOf(pluginsDir: string, id: string, version: string): string {
  const root = path.resolve(pluginsDir);
  const name = pluginDirName(id, version);
  const dir = path.resolve(root, name);
  // The name itself contains one `/`, so "exactly two segments" is checked on the
  // path-relative form rather than on dirname/basename.
  const relative = path.relative(root, dir);
  // Defence in depth: id / version come from an untrusted manifest.
  if (
    !pluginIdSchema.safeParse(id).success ||
    !pluginVersionSchema.safeParse(version).success ||
    !dir.startsWith(root + path.sep) ||
    relative.split(path.sep).length !== 2 ||
    relative.split(path.sep).join('/') !== name
  ) {
    throw new AppError('PLUGIN_INVALID', `安装目录越界：${id}@${version}`);
  }
  return dir;
}

/** The lower-cased `{name}@{version}` slot an install dir's basename must be. */
export const PLUGIN_SLOT_PATTERN = /^[a-z0-9][a-z0-9._-]*@[0-9a-z][0-9a-z.+-]*$/;

/**
 * `{name}@{version}.prev` — where the old directory waits while a same-slot update is in
 * flight (D104 P1-2). Derived only from a plain slot basename, never from a `.prev` or
 * `.staging` path, and always a sibling of the input.
 */
export function pluginPrevDirOf(dir: string): string {
  const resolved = path.resolve(dir);
  const base = path.basename(resolved);
  if (!PLUGIN_SLOT_PATTERN.test(base) || base.endsWith('.prev')) {
    throw new AppError('PLUGIN_INVALID', `非法的插件目录：${base}`);
  }
  return path.resolve(path.dirname(resolved), `${base}.prev`);
}

/**
 * `plg_` + first 12 hex chars of sha256(`{pluginId}#{key}`) — stable across updates so
 * `mcp:{serverId}` capabilities, per-tool policies and Bot selections survive them.
 */
export function pluginServerId(pluginId: string, key: string): string {
  const id = `plg_${createHash('sha256').update(`${pluginId}#${key}`).digest('hex').slice(0, 12)}`;
  if (!MCP_SERVER_ID_PATTERN.test(id)) {
    throw new AppError('PLUGIN_INVALID', `生成的 MCP server id 不合法：${id}`);
  }
  return id;
}

/** Marketplace / local installs must never claim the reserved namespaces. */
export function assertInstallablePluginId(id: string): void {
  const namespace = pluginNamespaceOf(id);
  if (isReservedPluginNamespace(namespace)) {
    throw new AppError('PLUGIN_INVALID', `命名空间 ${namespace} 为 KepCup 保留`);
  }
}
