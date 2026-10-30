import { describe, expect, test } from 'vitest';
import { externalUpdateChannel } from './update-channel.js';

/**
 * 渠道判定（docs/dev/06-release.md「各渠道的更新方式」）：商店/Flatpak/Snap
 * 的自更新由平台负责，应用内 electron-updater 必须完全不启动。
 */
describe('externalUpdateChannel', () => {
  test('普通安装（无渠道环境变量）→ 应用内更新照常启用', () => {
    expect(externalUpdateChannel({ env: {} })).toBeNull();
  });

  test('Microsoft Store / Mac App Store 优先于环境变量', () => {
    expect(
      externalUpdateChannel({ windowsStore: true, env: { FLATPAK_ID: 'app.kepcup.desktop' } }),
    ).toBe('microsoft-store');
    expect(externalUpdateChannel({ mas: true, env: { SNAP_NAME: 'kepcup' } })).toBe(
      'mac-app-store',
    );
  });

  test('Flatpak：FLATPAK_ID 由 flatpak run 注入', () => {
    expect(externalUpdateChannel({ env: { FLATPAK_ID: 'app.kepcup.desktop' } })).toBe('flatpak');
  });

  test('Snap：snapd 注入 SNAP_NAME', () => {
    expect(externalUpdateChannel({ env: { SNAP_NAME: 'kepcup' } })).toBe('snap');
  });

  test('空值不算渠道（避免空字符串环境变量误判）', () => {
    expect(externalUpdateChannel({ env: { FLATPAK_ID: '', SNAP_NAME: '' } })).toBeNull();
  });
});
