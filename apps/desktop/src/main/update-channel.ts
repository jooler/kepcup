/**
 * Distribution channels whose updates the platform owns (docs/dev/06-release.md
 * 「各渠道的更新方式」): Microsoft Store (MSIX), Mac App Store, Flatpak and
 * Snap. There electron-updater must never run — it cannot replace a
 * store-signed, read-only or sandboxed install, and a GitHub feed would fight
 * the store.
 *
 * Kept in its own Electron-free module so the detection is unit-testable
 * (`updater.ts` itself imports electron-updater).
 */
export type ExternalUpdateChannel = 'microsoft-store' | 'mac-app-store' | 'flatpak' | 'snap';

export function externalUpdateChannel(
  proc: { windowsStore?: boolean; mas?: boolean; env: NodeJS.ProcessEnv } = process,
): ExternalUpdateChannel | null {
  if (proc.windowsStore === true) return 'microsoft-store';
  if (proc.mas === true) return 'mac-app-store';
  if (proc.env.FLATPAK_ID !== undefined && proc.env.FLATPAK_ID.length > 0) return 'flatpak';
  // snapd 把所有 snap 的运行时环境都注入了 SNAP_NAME；snap 是只读 squashfs，
  // 应用内更新必然失败，安装/更新由 snapd 负责。
  if (proc.env.SNAP_NAME !== undefined && proc.env.SNAP_NAME.length > 0) return 'snap';
  return null;
}
