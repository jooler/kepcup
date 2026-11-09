import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computerActionResultSchema, computerSnapshotResultSchema } from '@kepcup/shared'
import { CuaDriverProviderClient } from './cua-driver-provider-client'

// P-B1 C 层（todo/computer-use-cua-adapter.md WP7）：macOS 真机集成。
//
//   KEPCUP_CUA_DRIVER_BIN="$PWD/apps/desktop/resources/cua-driver/darwin-arm64/CuaDriver.app/Contents/MacOS/cua-driver" \
//     node scripts/run-tests.mjs run apps/desktop/src/main/computer/cua-driver-provider.live.test.ts
//
// 需要 KepCup 宿主侧的辅助功能 + 屏幕录制授权（embedded daemon 继承测试进程的
// 责任链）；无二进制或无授权时 skip，绝不让 CI 变红（GitHub runner 无 GUI 会话，
// 必 skip）。断言不依赖窗口位置与系统语言（按 bundle id / role / actions 寻址）。

const BIN = process.env.KEPCUP_CUA_DRIVER_BIN

// 从二进制路径反推 CuaDriver.app 路径（Contents/MacOS/<bin> 向上两级）。
function appPathFromBin(binPath: string): string {
  return join(binPath, '..', '..', '..')
}

function textEditRunning(): boolean {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-x', 'TextEdit'], { encoding: 'utf8' })
    return out.trim().length > 0
  } catch {
    return false
  }
}

function waitForTextEditWindow(timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (textEditRunning()) {
      return
    }
    execFileSync('/bin/sleep', ['0.2'])
  }
  throw new Error('TextEdit did not start within timeout')
}

describe.skipIf(!BIN)('cua-driver provider（live：macOS 真机）', () => {
  let provider: CuaDriverProviderClient
  let workspace: string
  let notePath: string
  let textEditWasRunning: boolean

  beforeAll(() => {
    if (process.platform !== 'darwin') {
      return
    }
    process.env.KEPCUP_CUA_DRIVER_APP_PATH = appPathFromBin(BIN!)
    process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE = '1'
    workspace = mkdtempSync(join(tmpdir(), 'cua-live-'))
    notePath = join(workspace, 'probe-note.txt')
    writeFileSync(notePath, 'live test document\n')
    textEditWasRunning = textEditRunning()
    execFileSync('/usr/bin/open', ['-a', 'TextEdit', notePath])
    waitForTextEditWindow()
    provider = new CuaDriverProviderClient({ userDataDirectory: workspace })
  }, 30_000)

  afterAll(async () => {
    if (provider) {
      provider.shutdown()
    }
    if (!textEditWasRunning) {
      try {
        execFileSync('/usr/bin/osascript', ['-e', 'tell application "TextEdit" to quit saving no'])
      } catch {
        // 已经退出。
      }
    } else {
      // 只关测试开的文档窗口（按文件名找窗口关闭）。
      try {
        execFileSync('/usr/bin/osascript', ['-e', 'tell application "TextEdit" to close (every document whose name contains "probe-note.txt") saving no'])
      } catch {
        // 尽力而为。
      }
    }
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true })
    }
    delete process.env.KEPCUP_CUA_DRIVER_APP_PATH
    delete process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE
  })

  it('闭环：listApps → listWindows → 快照（含截图）→ typeText → setValue → click（按索引）→ 再观测', async () => {
    // 1. listApps：TextEdit 在运行（按 bundle id 断言，不依赖语言）。
    const apps = await provider.listApps()
    const textEdit = apps.apps.find((app) => app.bundleId === 'com.apple.TextEdit')
    expect(textEdit).toBeDefined()
    expect(textEdit!.isRunning).toBe(true)

    // 2. listWindows：TextEdit 至少一个在屏窗口；优先测试自己的文档窗口
    //（文件名是测试起的，语言无关；避免抓到 Open 面板）。
    const windows = await provider.listWindows({ app: 'com.apple.TextEdit' })
    expect(windows.windows.length).toBeGreaterThan(0)
    const docWindow =
      windows.windows.find((window) => window.title.includes('probe-note.txt')) ??
      windows.windows[0]!
    const target = docWindow
    expect(target.id).not.toBeNull()

    // 3. 快照（带截图）：树文本非空、元素索引表可用；截图允许 Tahoe
    //    direct-capture 未同意时的如实 failed（screenshot_failed）。
    const snapshot = await provider.snapshot({ app: 'com.apple.TextEdit', windowId: target.id! })
    const parsed = computerSnapshotResultSchema.parse(snapshot)
    expect(parsed.snapshot.coordinateSpace).toBe('window')
    expect(parsed.snapshot.treeText.length).toBeGreaterThan(0)
    expect(parsed.snapshot.elementCount).toBeGreaterThan(0)
    expect(parsed.screenshotStatus.state === 'captured' || parsed.screenshotStatus.state === 'failed').toBe(true)

    // 4. typeText：写进文本区（AXTextArea 的 AXSelectedText），confirmed → value 读回。
    // 树文本已整形为行首数字格式（无方括号）。
    const textArea = [...snapshot.snapshot.treeText.matchAll(/(?:^|\n)\t*(\d+)\s+AXTextArea/g)][0]
    expect(textArea).toBeDefined()
    const textAreaIndex = Number(textArea![1])
    const typed = await provider.action('typeText', {
      app: 'com.apple.TextEdit',
      elementIndex: textAreaIndex,
      text: 'LIVE-TYPE-OK '
    })
    const typedParsed = computerActionResultSchema.parse(typed)
    expect(typedParsed.action?.verification?.state).toBe('verified')

    // 5. setValue：直接写值（同一元素），confirmed。
    const setValue = await provider.action('setValue', {
      app: 'com.apple.TextEdit',
      elementIndex: textAreaIndex,
      value: 'LIVE-SET-VALUE'
    })
    const setValueParsed = computerActionResultSchema.parse(setValue)
    expect(setValueParsed.action?.verification?.state).toBe('verified')
    const afterSet = await provider.snapshot({ app: 'com.apple.TextEdit', windowId: target.id! })
    expect(afterSet.snapshot.treeText).toContain('LIVE-SET-VALUE')

    // 6. click 按索引：zoom 按钮（actions 含 zoomwindow，语言无关）→ 窗口尺寸变化。
    // zoom 会替换 CGWindowID（driver 报 "Action opened new window(s)"）——点击后
    // 按 title 重新找窗口，动作结果的观测降级不掩盖动作本身。
    const zoomIndex = findZoomButtonIndex(afterSet.snapshot.treeText)
    if (zoomIndex !== null) {
      const before = afterSet.snapshot.window
      const click = await provider.action('click', { app: 'com.apple.TextEdit', elementIndex: zoomIndex })
      const clickParsed = computerActionResultSchema.parse(click)
      expect(clickParsed.action?.verification?.state).toBeDefined()
      const refound = await provider.listWindows({ app: 'com.apple.TextEdit' })
      const after = refound.windows.find((window) => window.title.includes('probe-note.txt'))
      if (after) {
        const changed =
          after.width !== before.width ||
          after.height !== before.height ||
          after.x !== before.x ||
          after.y !== before.y
        if (changed) {
          // 还原（再点一次取消 zoom），不留下被放大的窗口。
          const restored = await provider.snapshot({ app: 'com.apple.TextEdit', windowId: after.id! })
          const restoredZoom = findZoomButtonIndex(restored.snapshot.treeText)
          if (restoredZoom !== null) {
            await provider.action('click', { app: 'com.apple.TextEdit', elementIndex: restoredZoom })
          }
        }
      }
    }

    // 7. 权限归属：embedded 模式 attribution === 'host'（findings Q6 的正确性信号）。
    const permissions = await provider.permissionsStatus()
    if (permissions.accessibility || permissions.screenRecording) {
      expect(permissions.attribution).toBe('host')
    } else {
      // 完全未授权时 live 断言没意义，但 status 读取本身不该抛。
      expect(permissions.attribution).not.toBeNull()
    }
  }, 120_000)
})

/** 从树文本里找 zoom 按钮（zoomwindow 动作，语言无关）。 */
function findZoomButtonIndex(treeText: string): number | null {
  for (const match of treeText.matchAll(/(?:^|\n)\t*(\d+)\s+AXButton[^\n]*/g)) {
    if (match[0].includes('zoomwindow')) {
      return Number(match[1])
    }
  }
  return null
}
