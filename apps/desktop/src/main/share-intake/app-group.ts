import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * D94 §5.1 / §7.1：Share Extension 与主应用之间的 App Group 容器。
 *
 * 扩展只往这个目录写（inbox + 目标快照），主应用只读 inbox、只写快照。
 * 不用 `Library/Caches`——系统可能清掉它。
 *
 * 组 id 必须与 entitlements 里的 `com.apple.security.application-groups`
 * 一致（`<TeamID>.app.kepcup.desktop`）。TeamID 在签名时确定，所以：
 *  - 打包产物可用 `KEPCUP_SHARE_GROUP_ID` 注入完整组 id；
 *  - 开发 / 测试用 `KEPCUP_SHARE_GROUP_DIR` 直接指定目录，跳过容器查找。
 */

/** 默认组 id（无 TeamID 前缀；正式构建用 KEPCUP_SHARE_GROUP_ID 覆盖）。 */
export const DEFAULT_SHARE_GROUP_ID = 'app.kepcup.desktop';

/** 完整组 id 的环境变量（打包构建注入 `<TeamID>.app.kepcup.desktop`）。 */
export const SHARE_GROUP_ID_ENV = 'KEPCUP_SHARE_GROUP_ID';
/** 直接指定 App Group 容器目录（开发 / 测试）。 */
export const SHARE_GROUP_DIR_ENV = 'KEPCUP_SHARE_GROUP_DIR';

/** App Group 容器目录；null = 非 macOS 或没配置（本功能不可用）。 */
export function shareGroupDir(env: NodeJS.ProcessEnv, resourcesPath?: string): string | null {
  const override = env[SHARE_GROUP_DIR_ENV];
  if (override !== undefined && override.length > 0) return override;
  if (process.platform !== 'darwin') return null;
  const groupId = resolveShareGroupId(env, resourcesPath);
  const home = env['HOME'] !== undefined && env['HOME'].length > 0 ? env['HOME'] : homedir();
  return path.join(home, 'Library', 'Group Containers', groupId);
}

/**
 * 完整的组 id（含 TeamID 前缀）。优先顺序：
 *  1. `KEPCUP_SHARE_GROUP_ID`（开发 / CI 注入）；
 *  2. 打包产物里的 `Resources/share-extension/group.json`（构建脚本写入，
 *     见 scripts/build-share-extension.mjs）；
 *  3. 默认值（无 TeamID 前缀，仅本地调试用）。
 */
export function resolveShareGroupId(env: NodeJS.ProcessEnv, resourcesPath?: string): string {
  const fromEnv = env[SHARE_GROUP_ID_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (resourcesPath !== undefined) {
    try {
      const raw = readFileSync(path.join(resourcesPath, 'share-extension', 'group.json'), 'utf8');
      const parsed = JSON.parse(raw) as { groupId?: unknown };
      if (typeof parsed.groupId === 'string' && parsed.groupId.length > 0) {
        return parsed.groupId;
      }
    } catch {
      // 没有这个文件就用默认值。
    }
  }
  return DEFAULT_SHARE_GROUP_ID;
}

/** 扩展写入的 inbox：`{group}/share-inbox/{intakeId}/`。 */
export function shareInboxDir(groupDir: string): string {
  return path.join(groupDir, 'share-inbox');
}

/** 目标快照：`{group}/targets.v1.json`。 */
export function shareTargetsPath(groupDir: string): string {
  return path.join(groupDir, 'targets.v1.json');
}
