import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Launch-at-login (P13 任务 3, docs/dev/phases/P13-release.md 任务 3): the
 * setting lives in core's settings row (`launchAtLogin`, default ON); the
 * main process applies it to the OS whenever the value changes and once at
 * platform-port bind (`platform.autostart` event).
 *
 * Platform notes:
 * - macOS/Windows: `app.setLoginItemSettings` (macOS LaunchServices/SMAppService,
 *   Windows Run registry key). On macOS the reliable path needs a SIGNED app —
 *   unsigned builds may fail to register; errors are reported, not thrown
 *   through (verification on a signed build is on the cross-platform list).
 * - Linux: XDG autostart desktop file written by hand (`~/.config/autostart/`),
 *   matching docs/dev/phases/P13-release.md ("Linux 写入 autostart desktop 文件").
 */

/** Structural subset of Electron's app login-item surface (keeps this testable). */
export interface LoginItemApi {
  setLoginItemSettings(settings: { openAtLogin: boolean; openAsHidden?: boolean }): void;
  getLoginItemSettings(): { openAtLogin: boolean };
}

export type LoginItemResult =
  | { outcome: 'applied'; enabled: boolean }
  | { outcome: 'failed'; enabled: boolean; reason: string };

export const LINUX_AUTOSTART_FILE = 'app.kepcup.desktop';

/** Contents of the XDG autostart entry. */
export function linuxAutostartDesktopFile(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    // 与 app-brand.ts 的 APP_NAME 保持一致（本模块刻意不依赖 electron，
    // 让单测能在纯 Node 环境跑，故这里保留字面量）。
    'Name=KepCup',
    `Exec=${execPath}`,
    'Comment=KepCup 在登录后自动启动（可在设置页关闭）',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
  ].join('\n');
}

/** `~/.config/autostart` (XDG_CONFIG_HOME respected), for tests and the writer. */
export function linuxAutostartDir(env: { HOME?: string; XDG_CONFIG_HOME?: string }): string {
  const configHome = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? '', '.config');
  return path.join(configHome, 'autostart');
}

/**
 * Linux XDG autostart writer. `execPath` should be the packaged executable
 * (app.getPath('exe')); a hidden-launch flag keeps the window closed.
 */
export function applyLinuxAutostart(
  enabled: boolean,
  options: { execPath: string; env: { HOME?: string; XDG_CONFIG_HOME?: string } },
): LoginItemResult {
  const dir = linuxAutostartDir(options.env);
  const file = path.join(dir, LINUX_AUTOSTART_FILE);
  try {
    if (!enabled) {
      rmSync(file, { force: true });
      return { outcome: 'applied', enabled: false };
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, linuxAutostartDesktopFile(options.execPath), { encoding: 'utf8' });
    return { outcome: 'applied', enabled: true };
  } catch (error) {
    return {
      outcome: 'failed',
      enabled,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * macOS/Windows adapter. Idempotent: Electron's setter and the file writer
 * both tolerate being applied repeatedly with the same value.
 */
export function applyLoginItem(
  api: LoginItemApi,
  enabled: boolean,
  platform: string,
  options: { execPath: string; env: { HOME?: string; XDG_CONFIG_HOME?: string } },
): LoginItemResult {
  if (platform === 'linux') {
    return applyLinuxAutostart(enabled, options);
  }
  try {
    // openAsHidden: the app is tray-resident (docs/design/07-local-runtime.md);
    // a login launch should not pop the window.
    api.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    const applied = api.getLoginItemSettings().openAtLogin;
    if (applied !== enabled) {
      return {
        outcome: 'failed',
        enabled,
        // Typical cause: unsigned macOS build (SMAppService refuses to
        // register) — verification deferred to a signed build.
        reason: `setLoginItemSettings did not take effect (openAtLogin=${applied})`,
      };
    }
    return { outcome: 'applied', enabled };
  } catch (error) {
    return {
      outcome: 'failed',
      enabled,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** True when an XDG autostart entry currently exists (diagnostics/tests). */
export function linuxAutostartExists(env: { HOME?: string; XDG_CONFIG_HOME?: string }): boolean {
  return existsSync(path.join(linuxAutostartDir(env), LINUX_AUTOSTART_FILE));
}
