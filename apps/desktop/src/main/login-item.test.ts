import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  applyLinuxAutostart,
  applyLoginItem,
  linuxAutostartDesktopFile,
  linuxAutostartDir,
  linuxAutostartExists,
  LINUX_AUTOSTART_FILE,
  type LoginItemApi,
} from './login-item.js';

/**
 * Launch-at-login (P13 任务 3): macOS/Windows go through
 * `app.setLoginItemSettings` (adapter verified against a fake; real
 * registration of an UNSIGNED macOS build is deferred to a signed build —
 * cross-platform list), Linux writes the XDG autostart desktop file.
 */

function fakeApi(options: { openAtLogin: boolean; fail?: boolean } = { openAtLogin: false }): {
  api: LoginItemApi;
  calls: Array<{ openAtLogin: boolean }>;
} {
  const calls: Array<{ openAtLogin: boolean }> = [];
  return {
    calls,
    api: {
      setLoginItemSettings(settings) {
        calls.push({ openAtLogin: settings.openAtLogin });
        if (options.fail) throw new Error('not signed');
        options.openAtLogin = settings.openAtLogin;
      },
      getLoginItemSettings() {
        return { openAtLogin: options.openAtLogin };
      },
    },
  };
}

const HOME = mkdtempSync(path.join(tmpdir(), 'kepcup-login-'));
const env = { HOME, XDG_CONFIG_HOME: path.join(HOME, '.config') };

describe('applyLoginItem (macOS/Windows adapter)', () => {
  test('enabling sets openAtLogin with openAsHidden (tray-resident app)', () => {
    const { api, calls } = fakeApi();
    const result = applyLoginItem(api, true, 'darwin', { execPath: '/x/Bot', env });
    expect(result).toEqual({ outcome: 'applied', enabled: true });
    expect(calls).toEqual([{ openAtLogin: true }]);
  });

  test('disabling clears openAtLogin', () => {
    const { api, calls } = fakeApi({ openAtLogin: true });
    const result = applyLoginItem(api, false, 'win32', { execPath: '/x/Bot.exe', env });
    expect(result).toEqual({ outcome: 'applied', enabled: false });
    expect(calls).toEqual([{ openAtLogin: false }]);
  });

  test('a setter that does not take effect is reported as failed, not applied', () => {
    // Typical unsigned-macOS symptom: the call succeeds but the registration
    // does not stick (SMAppService refuses). Must NOT report applied.
    const fake = fakeApi();
    fake.api.setLoginItemSettings = () => {}; // silently ignores the request
    const result = applyLoginItem(fake.api, true, 'darwin', { execPath: '/x/Bot', env });
    expect(result.outcome).toBe('failed');
    expect((result as { reason: string }).reason).toContain('did not take effect');
  });

  test('a throwing setter is reported as failed with its reason', () => {
    const { api } = fakeApi({ openAtLogin: false, fail: true });
    const result = applyLoginItem(api, true, 'darwin', { execPath: '/x/Bot', env });
    expect(result).toMatchObject({ outcome: 'failed', enabled: true, reason: 'not signed' });
  });
});

describe('applyLinuxAutostart (XDG desktop file)', () => {
  test('enabling writes the autostart desktop file pointing at the executable', () => {
    const result = applyLinuxAutostart(true, { execPath: '/opt/KepCup/kepcup', env });
    expect(result).toEqual({ outcome: 'applied', enabled: true });
    const file = path.join(linuxAutostartDir(env), LINUX_AUTOSTART_FILE);
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('[Desktop Entry]');
    expect(content).toContain('Exec=/opt/KepCup/kepcup');
    expect(linuxAutostartDesktopFile('/x')).toContain('X-GNOME-Autostart-enabled=true');
    expect(linuxAutostartExists(env)).toBe(true);
  });

  test('disabling removes the file (idempotent when absent)', () => {
    expect(applyLinuxAutostart(false, { execPath: '/x', env }).outcome).toBe('applied');
    expect(linuxAutostartExists(env)).toBe(false);
    expect(applyLinuxAutostart(false, { execPath: '/x', env }).outcome).toBe('applied');
  });
});
