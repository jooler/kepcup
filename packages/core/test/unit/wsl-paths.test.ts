import { describe, expect, it } from 'vitest';

import {
  distroCachePath,
  distroToWindowsPath,
  distroToolchainPath,
  distroWorkspacePath,
  isInsideWindowsPath,
  isWslUncPath,
  isWindowsAbsolutePath,
  mountpointFor,
  sameWindowsPath,
  windowsToDistroPath,
  wslUncPath,
  type DistroMount,
} from '../../src/sandbox/wsl/paths.js';

/**
 * Path conversion pure functions (P12 任务 4): 盘符 / UNC / 大小写 / 空格 /
 * \\wsl$ 形态. Windows comparisons are case-insensitive; mounted paths are
 * addressed by hash mountpoints so spaces and non-ASCII never cross a shell.
 */
describe('Windows path predicates', () => {
  it('accepts drive and UNC absolute paths, rejects relative and 9P shares', () => {
    expect(isWindowsAbsolutePath('C:\\Users\\me')).toBe(true);
    expect(isWindowsAbsolutePath('c:/Users/me')).toBe(true);
    expect(isWindowsAbsolutePath('\\\\server\\share\\dir')).toBe(true);
    expect(isWindowsAbsolutePath('relative\\path')).toBe(false);
    expect(isWindowsAbsolutePath('C:')).toBe(false); // drive-relative, not absolute
    expect(isWslUncPath('\\\\wsl$\\Kepcup\\home\\kepcup')).toBe(true);
    expect(isWslUncPath('\\\\wsl.localhost\\Kepcup\\x')).toBe(true);
    // 9P shares are NOT mountable Windows directories:
    expect(isWindowsAbsolutePath('\\\\wsl$\\Kepcup\\home')).toBe(false);
    expect(isWindowsAbsolutePath('\\\\wsl.localhost\\Ubuntu\\tmp')).toBe(false);
  });

  it('compares case-insensitively across separators', () => {
    expect(sameWindowsPath('C:\\Users\\Me\\Proj', 'c:/users/me/proj')).toBe(true);
    expect(sameWindowsPath('C:\\a', 'C:\\ab')).toBe(false);
    expect(isInsideWindowsPath('C:\\data\\home\\bots\\x', 'C:\\Data\\Home')).toBe(true);
    expect(isInsideWindowsPath('C:\\data\\homeX', 'C:\\data\\home')).toBe(false);
    expect(isInsideWindowsPath('C:\\data\\home', 'C:\\data\\home')).toBe(true);
  });
});

describe('mountpointFor', () => {
  it('is deterministic and case-insensitive, shaped /mnt/kepcup/<16hex>', () => {
    const a = mountpointFor('C:\\Users\\me\\proj');
    const b = mountpointFor('c:/users/ME/proj');
    expect(a).toBe(b);
    expect(a).toMatch(/^\/mnt\/kepcup\/[0-9a-f]{16}$/);
    expect(mountpointFor('D:\\other')).not.toBe(a);
  });
});

const mounts: DistroMount[] = [
  { source: 'C:\\Users\\me\\proj', mountpoint: '/mnt/kepcup/aaaaaaaaaaaaaaaa', mode: 'rw' },
];

describe('windowsToDistroPath', () => {
  it('maps the mounted root and descendants (spaces preserved)', () => {
    expect(windowsToDistroPath('C:\\Users\\me\\proj', mounts)).toBe('/mnt/kepcup/aaaaaaaaaaaaaaaa');
    expect(windowsToDistroPath('C:\\Users\\me\\proj\\my file\\a.txt', mounts)).toBe(
      '/mnt/kepcup/aaaaaaaaaaaaaaaa/my file/a.txt',
    );
  });

  it('returns null for paths without a mount (fail-closed, no naive translation)', () => {
    expect(windowsToDistroPath('C:\\Windows\\system32', mounts)).toBeNull();
    expect(windowsToDistroPath('D:\\data', mounts)).toBeNull();
  });

  it('maps case-insensitively', () => {
    expect(windowsToDistroPath('c:/USERS/me/PROJ/x', mounts)).toBe('/mnt/kepcup/aaaaaaaaaaaaaaaa/x');
  });
});

describe('distro-side helpers', () => {
  it('builds the workspace / cache / toolchain layouts', () => {
    expect(distroWorkspacePath('bot_1', 'conv_2')).toBe('/home/kepcup/workspaces/bot_1/conv_2');
    expect(distroCachePath('npm')).toBe('/home/kepcup/cache/npm');
    expect(distroToolchainPath('node', '24.21.0')).toBe('/opt/kepcup/toolchains/node/24.21.0');
  });

  it('renders the \\wsl$ UNC form of a distro path', () => {
    expect(wslUncPath('/home/kepcup/workspaces', 'Kepcup')).toBe('\\\\wsl$\\Kepcup\\home\\kepcup\\workspaces');
    expect(wslUncPath('home/kepcup', 'Kepcup')).toBe('\\\\wsl$\\Kepcup\\home\\kepcup');
  });

  it('maps distro violation paths back to Windows (best effort)', () => {
    expect(distroToWindowsPath('/mnt/kepcup/aaaaaaaaaaaaaaaa/src/a.py', mounts)).toBe(
      'C:\\Users\\me\\proj\\src\\a.py',
    );
    expect(distroToWindowsPath('/mnt/kepcup/aaaaaaaaaaaaaaaa', mounts)).toBe('C:\\Users\\me\\proj');
    expect(distroToWindowsPath('/etc/passwd', mounts)).toBeNull();
  });
});
