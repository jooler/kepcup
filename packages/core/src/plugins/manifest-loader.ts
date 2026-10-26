import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  PLUGIN_FORMAT_VERSION,
  PLUGIN_MANIFEST_MAX_BYTES,
  pluginManifestSchema,
  type PluginManifest,
} from '@kepcup/shared';
import { satisfiesRange } from '../apps/mcpb/manifest.js';

/**
 * Plugin manifest loading (D104): text → validated `PluginManifest`, environment
 * compatibility, and on-disk contribution checks for an already-extracted tree.
 * Parsing never echoes the raw text back; `format_version` ahead of the supported
 * one gets its own readable error before the schema runs.
 */

function invalid(message: string): AppError {
  return new AppError('PLUGIN_INVALID', message);
}

/** Parses and validates `plugin.json`; throws `PLUGIN_INVALID` / `PLUGIN_INCOMPATIBLE`. */
export function parsePluginManifestText(text: string): PluginManifest {
  if (Buffer.byteLength(text, 'utf8') > PLUGIN_MANIFEST_MAX_BYTES) {
    throw invalid(`plugin.json 超过 ${PLUGIN_MANIFEST_MAX_BYTES} 字节上限`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw invalid('plugin.json 不是合法的 JSON');
  }
  // A manifest from a newer KepCup is a deliberate upgrade prompt, not a parse error.
  const formatVersion = (json as { format_version?: unknown } | null)?.['format_version'];
  if (typeof formatVersion === 'number' && formatVersion > PLUGIN_FORMAT_VERSION) {
    throw new AppError('PLUGIN_INCOMPATIBLE', '此插件需要更新版本的 KepCup');
  }
  const parsed = pluginManifestSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.slice(0, 3).map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : 'plugin.json';
      return `${where}：${issue.message}`;
    });
    throw invalid(`plugin.json 不符合插件规范：${lines.join('；')}`);
  }
  return parsed.data;
}

/** `0.0.0` (dev / test, incl. `0.0.0-test`) skips the engines check entirely. */
function coreVersion(appVersion: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(appVersion);
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
}

export function checkPluginCompatibility(
  manifest: PluginManifest,
  env: { appVersion: string; platform: NodeJS.Platform },
): void {
  if (
    manifest.platforms !== undefined &&
    !(manifest.platforms as readonly string[]).includes(env.platform)
  ) {
    throw new AppError(
      'PLUGIN_INCOMPATIBLE',
      `此插件只支持 ${manifest.platforms.join(' / ')}，当前系统是 ${env.platform}`,
    );
  }
  const range = manifest.engines?.kepcup;
  if (range !== undefined && coreVersion(env.appVersion) !== '0.0.0') {
    if (!satisfiesRange(env.appVersion, range)) {
      throw new AppError('PLUGIN_INCOMPATIBLE', `需要 KepCup ${range}，当前 ${env.appVersion}`);
    }
  }
}

/**
 * Checks the extracted tree against the manifest: every declared contribution exists
 * as a regular file (skills as a directory containing SKILL.md), nothing is a symlink,
 * and every resolved path stays inside the plugin directory.
 */
export async function verifyContributionFiles(
  manifest: PluginManifest,
  dir: string,
): Promise<void> {
  const rootReal = await realpath(dir);
  const check = async (relative: string, expect: 'file' | 'dir'): Promise<void> => {
    const target = path.join(dir, ...relative.split('/'));
    let info;
    try {
      info = await lstat(target);
    } catch {
      throw invalid(`包内缺少贡献文件：${relative}`);
    }
    if (info.isSymbolicLink()) throw invalid(`包内含符号链接，已拒绝：${relative}`);
    if (expect === 'file' && !info.isFile()) throw invalid(`包内贡献不是普通文件：${relative}`);
    if (expect === 'dir' && !info.isDirectory()) {
      throw invalid(`包内技能贡献不是目录：${relative}`);
    }
    let resolved: string;
    try {
      resolved = await realpath(target);
    } catch {
      throw invalid(`包内贡献无法解析：${relative}`);
    }
    if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
      throw invalid(`包内路径越界（符号链接逃逸）：${relative}`);
    }
  };
  for (const skill of manifest.contributions.skills) {
    await check(skill.dir, 'dir');
    await check(`${skill.dir}/SKILL.md`, 'file');
  }
  for (const connector of manifest.contributions.connectors) {
    await check(connector.file, 'file');
  }
  for (const contribution of manifest.contributions.mcp) {
    if (contribution.kind === 'mcpb') await check(contribution.file, 'file');
  }
}
