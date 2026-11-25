import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  prepareCuaDriverSocketDirectory,
  resolveCuaDriverBundlePath,
  resolveCuaDriverSocketPath,
  resolveCuaDriverUnavailableReason
} from './cua-driver-paths'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

/** 按本机平台造一个可执行运行时：darwin 是 .app bundle，win/linux 是裸目录。 */
function createFakeBundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'kepcup-cua-fake-'))
  cleanup.push(root)
  if (process.platform === 'darwin') {
    const app = join(root, 'CuaDriver.app')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'MacOS', 'cua-driver'), '#!/bin/sh\n')
    return app
  }
  writeFileSync(join(root, process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'), '')
  return root
}

describe('prepareCuaDriverSocketDirectory', () => {
  it('creates the runtime directory under userData', () => {
    const userData = mkdtempSync(join(tmpdir(), 'kepcup-cua-paths-'))
    cleanup.push(userData)

    const directory = prepareCuaDriverSocketDirectory(userData)

    expect(directory).toBe(join(userData, 'cua-driver'))
    expect(statSync(directory).isDirectory()).toBe(true)
  })

  if (process.platform !== 'win32') {
    it('creates a user-owned 0700 directory (POSIX permission hygiene)', () => {
      const userData = mkdtempSync(join(tmpdir(), 'kepcup-cua-paths-'))
      cleanup.push(userData)

      const directory = prepareCuaDriverSocketDirectory(userData)

      expect(statSync(directory).mode & 0o777).toBe(0o700)
    })

    it('uses a unique temp directory when the userData socket path is too long', () => {
      const directory = prepareCuaDriverSocketDirectory(join(tmpdir(), 'x'.repeat(120)))
      cleanup.push(directory)

      expect(directory.startsWith(join(tmpdir(), 'kepcup-cua-'))).toBe(true)
      expect(statSync(directory).mode & 0o777).toBe(0o700)
    })
  }
})

describe('resolveCuaDriverSocketPath', () => {
  it('win32 uses a per-user named pipe derived from the runtime directory', () => {
    if (process.platform !== 'win32') {
      return
    }
    const socketPath = resolveCuaDriverSocketPath(join(tmpdir(), 'kepcup-cua-pipe'))
    expect(socketPath).toMatch(/^\\\\\.\\pipe\\kepcup-cua-[0-9a-f]{12}$/)
    // 目录路径相同 → pipe 名稳定（孤儿清理据此找到上一代 daemon）。
    expect(resolveCuaDriverSocketPath(join(tmpdir(), 'kepcup-cua-pipe'))).toBe(socketPath)
    // 目录路径不同 → pipe 名不同（多用户 / 多目录互不冲突）。
    expect(resolveCuaDriverSocketPath(join(tmpdir(), 'other'))).not.toBe(socketPath)
  })

  it('non-win32 uses <dir>/driver.sock within the 104-byte unix socket limit', () => {
    if (process.platform === 'win32') {
      return
    }
    const directory = join(tmpdir(), 'kepcup-cua-sock')
    expect(resolveCuaDriverSocketPath(directory)).toBe(join(directory, 'driver.sock'))
  })
})

describe('resolveCuaDriverBundlePath env override gating', () => {
  const originalPath = process.env.KEPCUP_CUA_DRIVER_APP_PATH
  const originalAllow = process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.KEPCUP_CUA_DRIVER_APP_PATH
    } else {
      process.env.KEPCUP_CUA_DRIVER_APP_PATH = originalPath
    }
    if (originalAllow === undefined) {
      delete process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE
    } else {
      process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE = originalAllow
    }
  })

  it('ignores KEPCUP_CUA_DRIVER_APP_PATH without the explicit allow flag', () => {
    const fake = createFakeBundle()
    process.env.KEPCUP_CUA_DRIVER_APP_PATH = fake
    delete process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE

    expect(resolveCuaDriverBundlePath()?.appPath).not.toBe(fake)
  })

  it('honors the override only with the explicit allow flag', () => {
    const fake = createFakeBundle()
    process.env.KEPCUP_CUA_DRIVER_APP_PATH = fake
    process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE = '1'

    expect(resolveCuaDriverBundlePath()?.appPath).toBe(fake)
  })
})

describe('resolveCuaDriverUnavailableReason', () => {
  it('names the missing runtime and the fetch script when the runtime lacks an executable', () => {
    // 覆盖目录存在但没有可执行体 → 与「没 fetch」同判；与机器状态无关。
    const empty = mkdtempSync(join(tmpdir(), 'kepcup-cua-empty-'))
    cleanup.push(empty)
    process.env.KEPCUP_CUA_DRIVER_APP_PATH = empty
    process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE = '1'

    const reason = resolveCuaDriverUnavailableReason()
    expect(reason).toMatch(/was not found/)
    expect(reason).toMatch(/fetch-cua-driver\.mjs/)
  })

  it('reports no reason once a fake runtime is provided via the override', () => {
    const fake = createFakeBundle()
    process.env.KEPCUP_CUA_DRIVER_APP_PATH = fake
    process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE = '1'

    // lock 读取走 DESKTOP_APP_DIRECTORIES（仓库 resources/ 在 checkout 内存在）。
    expect(resolveCuaDriverUnavailableReason()).toBeNull()
  })
})
