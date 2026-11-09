import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  prepareCuaDriverSocketDirectory,
  resolveCuaDriverBundlePath
} from './cua-driver-paths'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function createFakeBundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'kepcup-cua-fake-'))
  cleanup.push(root)
  const app = join(root, 'CuaDriver.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'MacOS', 'cua-driver'), '#!/bin/sh\n')
  return app
}

describe.skipIf(process.platform === 'win32')('prepareCuaDriverSocketDirectory', () => {
  it('creates a user-owned 0700 directory under userData', () => {
    const userData = mkdtempSync(join(tmpdir(), 'kepcup-cua-paths-'))
    cleanup.push(userData)

    const directory = prepareCuaDriverSocketDirectory(userData)

    expect(directory).toBe(join(userData, 'cua-driver'))
    const stat = statSync(directory)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
  })

  it('uses a unique temp directory when the userData socket path is too long', () => {
    const directory = prepareCuaDriverSocketDirectory(join(tmpdir(), 'x'.repeat(120)))
    cleanup.push(directory)

    expect(directory.startsWith(join(tmpdir(), 'kepcup-cua-'))).toBe(true)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
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
