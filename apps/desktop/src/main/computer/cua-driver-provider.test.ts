import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppError } from '@kepcup/shared'
import {
  computerActionResultSchema,
  computerListAppsResultSchema,
  computerListWindowsResultSchema,
  computerProviderCapabilitiesSchema,
  computerSnapshotResultSchema
} from '@kepcup/shared'
import { CuaDriverProviderClient } from './cua-driver-provider-client'
import { CuaDriverDaemonClient, CuaDriverLineBuffer } from './cua-driver-daemon-client'
import {
  mapCuaDriverErrorCode,
  cuaDriverToolError
} from './cua-driver-error-map'
import { windowPointToScreenshotPixel } from './cua-driver-coordinates'

// P-B1 单元层（todo/computer-use-cua-adapter.md WP7 A 层）：伪 daemon（node:net
// 监听 tmpdir 路径）按脚本应答，覆盖 5 个 provider 方法 + 9 个 action 方法 +
// 错误码映射 + 坐标换算 + 索引过期。不需要授权、不需要真机桌面、全 CI 可跑。

type FakeHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>

const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function startFakeDaemon(handlers: Record<string, FakeHandler> = {}): Promise<{
  socketPath: string
  calls: Array<{ name: string; args: Record<string, unknown> }>
  close: () => void
}> {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'cua-fake-')), 'driver.sock')
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        void handleLine(line, socket)
        index = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => {})
  })
  const handleLine = async (line: string, socket: net.Socket): Promise<void> => {
    const request = JSON.parse(line) as {
      method: string
      name?: string
      args?: Record<string, unknown>
    }
    if (request.method === 'sessions_list') {
      socket.write(`${JSON.stringify({ ok: true, result: { count: 0, sessions: [] } })}\n`)
      return
    }
    if (request.method === 'session_end') {
      socket.write(`${JSON.stringify({ ok: true, result: { ended: true } })}\n`)
      return
    }
    const name = request.name ?? ''
    calls.push({ name, args: request.args ?? {} })
    const handler = handlers[name]
    let structured: Record<string, unknown> = {}
    let isError = false
    let content: Array<{ type: string; text?: string }> = [{ type: 'text', text: 'fake' }]
    if (handler) {
      const outcome = await handler(request.args ?? {})
      if (outcome && typeof outcome === 'object' && '__error' in (outcome as Record<string, unknown>)) {
        const payload = (outcome as Record<string, unknown>).payload as Record<string, unknown>
        structured = payload
        isError = true
        if (Array.isArray(payload.__content)) {
          content = payload.__content as Array<{ type: string; text?: string }>
          structured = { ...payload, __content: undefined }
        }
      } else {
        structured = (outcome ?? {}) as Record<string, unknown>
        if (Array.isArray((outcome as Record<string, unknown> | null)?.__content)) {
          content = (outcome as Record<string, unknown>).__content as Array<{ type: string; text?: string }>
          structured = { ...structured, __content: undefined }
        }
      }
    }
    socket.write(
      `${JSON.stringify({
        ok: true,
        result: {
          content,
          structuredContent: structured,
          ...(isError ? { isError: true } : {})
        }
      })}\n`
    )
  }
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    calls,
    close: () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      sockets.clear()
      server.close()
      rmSync(socketPath, { force: true })
    }
  }
}

const toolError = (payload: Record<string, unknown>): Record<string, unknown> => ({
  __error: true,
  payload
})

function makeClient(socketPath: string, tempDir: string): CuaDriverProviderClient {
  return new CuaDriverProviderClient({
    userDataDirectory: tempDir,
    client: new CuaDriverDaemonClient(socketPath),
    skipOrphanCleanup: true
  })
}

// 模块级夹具：每个用例一个新的临时目录；withProvider 注册 fake daemon 并在
// afterEach 统一回收（作用域覆盖全部 describe 块）。
let tempDir: string
const running: Array<() => void> = []

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cua-test-'))
})

afterEach(() => {
  for (const close of running) {
    close()
  }
  running.length = 0
  rmSync(tempDir, { recursive: true, force: true })
})

async function withProvider(
  handlers: Record<string, FakeHandler>
): Promise<{ provider: CuaDriverProviderClient; daemon: Awaited<ReturnType<typeof startFakeDaemon>> }> {
  const daemon = await startFakeDaemon(handlers)
  running.push(daemon.close)
  return { provider: makeClient(daemon.socketPath, tempDir), daemon }
}

/** 标准 fake 环境：一个运行中的 app（pid 100）带一个窗口（window_id 7）。 */
function standardHandlers(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    list_apps: () => ({
      apps: [
        {
          pid: 100,
          name: 'Notes',
          running: true,
          bundle_id: 'com.apple.Notes',
          last_used: '2026-11-06T00:00:00Z'
        }
      ]
    }),
    list_windows: () => ({
      windows: [
        {
          window_id: 7,
          pid: 100,
          app_name: 'Notes',
          title: 'MainWindow',
          bounds: { x: 10, y: 20, width: 400, height: 300 },
          is_on_screen: true,
          z_index: 5
        }
      ]
    }),
    get_window_state: (args) => {
      const outFile = args.screenshot_out_file
      if (typeof outFile === 'string') {
        mkdirSync(join(outFile, '..'), { recursive: true })
        writeFileSync(outFile, Buffer.from(tinyPngBase64, 'base64'))
      }
      return {
        snapshot_id: 's00000001',
        pid: 100,
        window_id: 7,
        app_name: 'Notes',
        window_title: 'MainWindow',
        window_bounds: { x: 10, y: 20, width: 400, height: 300 },
        element_count: 3,
        returned_element_count: 3,
        total_element_count: 3,
        tree_markdown: [
          '- [0] AXWindow "MainWindow" [actions=[raise]]',
          '  - [1] AXButton "OK" [actions=[press]]',
          '  - [2] AXTextArea = "hello" [actions=[showmenu]]'
        ].join('\n'),
        elements: [
          {
            element_index: 0,
            element_token: 's00000001:0',
            role: 'AXWindow',
            label: 'MainWindow',
            frame: { x: 10, y: 20, w: 400, h: 300 },
            actions: ['AXRaise']
          },
          {
            element_index: 1,
            element_token: 's00000001:1',
            role: 'AXButton',
            label: 'OK',
            frame: { x: 50, y: 60, w: 40, h: 20 },
            actions: ['AXPress']
          },
          {
            element_index: 2,
            element_token: 's00000001:2',
            role: 'AXTextArea',
            label: null,
            frame: { x: 20, y: 100, w: 300, h: 150 },
            actions: ['AXShowMenu']
          }
        ],
        ...(typeof args.include_screenshot === 'boolean' && args.include_screenshot
          ? {
              screenshot_file_path: outFile,
              screenshot_width: 800,
              screenshot_height: 600,
              screenshot_scale: 2,
              screenshot_mime_type: 'image/png',
              screenshot_frame_valid: true
            }
          : {})
      }
    },
    ...overrides
  }
}

/** 0.40 真实形态：AX 负载有效但截图被二段同意挡下（screenshot_* 字段全缺）。 */
function consentBlockedWindowState(args: Record<string, unknown>): Record<string, unknown> {
  const base = standardHandlers().get_window_state!(args) as Record<string, unknown>
  const withoutScreenshot = { ...base }
  for (const key of Object.keys(withoutScreenshot)) {
    if (key.startsWith('screenshot_')) {
      delete withoutScreenshot[key]
    }
  }
  return {
    ...withoutScreenshot,
    screenshot_error: {
      code: 'px_capture_unavailable',
      reason: 'direct_capture_consent_required: screen capture skipped'
    },
    screenshot_frame_valid: false
  }
}

describe('CuaDriverProviderClient（伪 daemon）', () => {
  it('listApps 只回运行中的应用（对齐原生语义；core 标题「正在运行的应用」才不失实）', async () => {
    const { provider } = await withProvider({
      list_apps: () => ({
        apps: [
          { pid: 100, name: 'Notes', running: true, bundle_id: 'com.apple.Notes', last_used: '2026-11-06T00:00:00Z' },
          { pid: 0, name: 'Xcode', running: false, bundle_id: 'com.apple.dt.Xcode' }
        ]
      })
    })
    const result = await provider.listApps()
    expect(() => computerListAppsResultSchema.parse(result)).not.toThrow()
    expect(result.apps).toEqual([
      { name: 'Notes', bundleId: 'com.apple.Notes', pid: 100, isRunning: true, lastUsedAt: '2026-11-06T00:00:00Z', useCount: null }
    ])
  })

  it('listWindows 按 pid 过滤并带 index / isMain', async () => {
    const { provider } = await withProvider(
      standardHandlers({
        list_windows: () => ({
          windows: [
            { window_id: 7, pid: 100, app_name: 'Notes', title: 'Main', bounds: { x: 1, y: 2, width: 300, height: 200 }, is_on_screen: true, z_index: 9 },
            { window_id: 8, pid: 999, app_name: 'Other', title: 'X', bounds: { x: 0, y: 0, width: 10, height: 10 }, is_on_screen: true, z_index: 1 }
          ]
        })
      })
    )
    const result = await provider.listWindows({ app: 'Notes' })
    expect(() => computerListWindowsResultSchema.parse(result)).not.toThrow()
    expect(result.app).toEqual({ name: 'Notes', bundleId: 'com.apple.Notes', pid: 100 })
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]).toMatchObject({ id: 7, index: 0, isMain: true, isOffscreen: false })
  })

  it('snapshot 过 zod：树整形为行首数字格式，截图从落盘文件读出', async () => {
    const { provider } = await withProvider(standardHandlers())
    const result = await provider.snapshot({ app: 'Notes', noScreenshot: false })
    const parsed = computerSnapshotResultSchema.parse(result)
    expect(parsed.snapshot.id).toBe('s00000001')
    expect(parsed.snapshot.coordinateSpace).toBe('window')
    expect(parsed.snapshot.treeText.split('\n')[0]).toBe('0 AXWindow "MainWindow" [actions=[raise]]')
    expect(parsed.snapshot.treeText.split('\n')[1]).toBe('\t1 AXButton "OK" [actions=[press]]')
    expect(parsed.snapshot.elementCount).toBe(3)
    expect(parsed.snapshot.focusedElementId).toBeNull()
    expect(parsed.screenshotStatus.state).toBe('captured')
    expect(parsed.screenshot?.data).toBe(tinyPngBase64)
    expect(parsed.screenshot?.scale).toBe(2)
    // 临时截图文件读后即删。
    expect(existsSync(join(tempDir, 'cua-driver'))).toBe(false)
  })

  it('snapshot(noScreenshot) → screenshotStatus skipped', async () => {
    const { provider } = await withProvider(standardHandlers())
    const result = await provider.snapshot({ app: 'Notes', noScreenshot: true })
    expect(result.screenshotStatus).toEqual({ state: 'skipped', reason: 'no_screenshot_flag' })
    expect(result.screenshot).toBeNull()
  })

  it('degraded_reason（窗口被替换 / AX 未解析）→ WINDOW_NOT_FOUND', async () => {
    const { provider } = await withProvider(
      standardHandlers({
        get_window_state: () => ({
          pid: 100,
          window_id: 7,
          app_name: 'Notes',
          window_title: 'MainWindow',
          degraded_reason: 'ax_window_unresolved: window_id 7 exists but no AXWindow element reports it',
          element_count: 0,
          returned_element_count: 0,
          total_element_count: 0,
          tree_markdown: '',
          elements: []
        })
      })
    )
    await expect(provider.snapshot({ app: 'Notes', noScreenshot: false })).rejects.toMatchObject({
      code: 'WINDOW_NOT_FOUND'
    })
  })

  it('screenshot_error（px_capture_unavailable 等）→ screenshotStatus failed（保留 AX 负载）', async () => {
    const { provider } = await withProvider(
      standardHandlers({ get_window_state: consentBlockedWindowState })
    )
    const result = await provider.snapshot({ app: 'Notes', noScreenshot: false })
    expect(result.screenshotStatus.state).toBe('failed')
    if (result.screenshotStatus.state === 'failed') {
      // 二段同意是可恢复状态：文案必须可行动（P-B1 验收清单项 2），原始码保留可诊断。
      expect(result.screenshotStatus.message).toContain('屏幕录制授权不可用')
      expect(result.screenshotStatus.message).toContain('屏幕录制')
      expect(result.screenshotStatus.message).toContain('direct_capture_consent_required')
    }
    // truthful AX 负载保留。
    expect(result.snapshot.elementCount).toBe(3)
  })

  it('截图被挡后 scroll → invalid_argument 带授权指引（不把模型关进先截图死循环）', async () => {
    const { provider } = await withProvider(
      standardHandlers({ get_window_state: consentBlockedWindowState })
    )
    // 观察「成功」（AX 树在），但截图没拿到——索引表有了、几何没有。
    await provider.snapshot({ app: 'Notes', noScreenshot: false })
    await expect(
      provider.action('scroll', { app: 'Notes', elementIndex: 2, direction: 'down' })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('屏幕录制授权不可用')
    })
  })

  it('截图被挡后插入 noScreenshot 观察，scroll 报错仍带授权指引（失败记忆不被覆盖）', async () => {
    const { provider } = await withProvider(
      standardHandlers({ get_window_state: consentBlockedWindowState })
    )
    await provider.snapshot({ app: 'Notes', noScreenshot: false })
    // 模型常见的省 token 操作：中间再观察一次但不带截图——不得抹掉失败记忆
    // （2026-11-07 复检「报错信息可诊断性回退」回归）。
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    await expect(
      provider.action('scroll', { app: 'Notes', elementIndex: 2, direction: 'down' })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('屏幕录制授权不可用')
    })
  })

  it('截图被挡后元素动作 + 动作后补观察，scroll 报错仍带授权指引', async () => {
    const { provider } = await withProvider(
      standardHandlers({
        // 动作后补观察不带截图：走标准夹具（树在、无 screenshot_* 字段）。
        get_window_state: (args) =>
          args.include_screenshot === true
            ? consentBlockedWindowState(args)
            : (standardHandlers().get_window_state!(args) as Record<string, unknown>),
        click: () => ({ effect: 'confirmed', route: 'accessibility', evidence: [{ kind: 'value_readback' }] })
      })
    )
    await provider.snapshot({ app: 'Notes', noScreenshot: false })
    // 元素点击不需要几何，可以成功；其动作后观察（无截图）不得抹掉失败记忆。
    await provider.action('click', { app: 'Notes', elementIndex: 1 })
    await expect(
      provider.action('scroll', { app: 'Notes', elementIndex: 2, direction: 'down' })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('屏幕录制授权不可用')
    })
  })

  it('capabilities 静态合成且过 zod（focus/moveResize/menus 不虚报）', async () => {
    const { provider } = await withProvider({})
    const capabilities = await provider.capabilities()
    expect(() => computerProviderCapabilitiesSchema.parse(capabilities)).not.toThrow()
    expect(capabilities.provider).toBe('cua-driver')
    expect(capabilities.supports.windows.focus).toBe(false)
    expect(capabilities.supports.windows.moveResize).toBe(false)
    expect(capabilities.supports.surfaces.menus).toBe(false)
    expect(capabilities.supports.actions.pasteText).toBe(true)
    expect(capabilities.supports.input?.background).toBe(true)
  })

  // --- 动作方法 -------------------------------------------------------------

  it('click 按元素索引 → element_token 寻址（无先观察 → ELEMENT_NOT_FOUND）', async () => {
    const { provider, daemon } = await withProvider(
      standardHandlers({
        click: () => ({ effect: 'confirmed', route: 'accessibility', evidence: [{ kind: 'value_readback' }] })
      })
    )
    // 契约（ADDRESS_RULE）：元素索引来自最近一次 get_app_state——先观察再动作。
    await expect(
      provider.action('click', { app: 'Notes', elementIndex: 1 })
    ).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' })
    const result = await provider.snapshot({ app: 'Notes', noScreenshot: true }).then(() =>
      provider.action('click', { app: 'Notes', elementIndex: 1 })
    )
    const clickCall = daemon.calls.find((call) => call.name === 'click')
    expect(clickCall?.args.element_token).toBe('s00000001:1')
    expect(clickCall?.args).not.toHaveProperty('element_index')
    expect(clickCall?.args.delivery_mode).toBe('background')
    const parsed = computerActionResultSchema.parse(result)
    expect(parsed.action?.path).toBe('accessibility')
    expect(parsed.action?.verification).toEqual({
      state: 'verified',
      property: 'value',
      actualPreview: null
    })
    // 动作后补全树观察（结果带新快照）。
    expect(parsed.snapshot.treeText).toContain('AXButton')
  })

  it('click 坐标寻址：窗口点 × ratio 换算为截图像素（Retina 2x）', async () => {
    let received: { x?: unknown; y?: unknown } = {}
    const { provider } = await withProvider(
      standardHandlers({
        click: (args) => {
          received = args
          return { effect: 'unverifiable', route: 'synthetic_events' }
        }
      })
    )
    // 先观察一次带截图（建立 geometry：bounds 400pt 宽，PNG 800px 宽 → ratio 2）。
    await provider.snapshot({ app: 'Notes' })
    await provider.action('click', { app: 'Notes', x: 100, y: 50 })
    expect(received.x).toBe(200)
    expect(received.y).toBe(100)
  })

  it('click 多击 → double_click；右键 → right_click', async () => {
    const { provider, daemon } = await withProvider(
      standardHandlers({
        double_click: () => ({ effect: 'unverifiable', route: 'synthetic_events' }),
        right_click: () => ({ effect: 'unverifiable', route: 'synthetic_events' })
      })
    )
    await provider.snapshot({ app: 'Notes' })
    await provider.action('click', { app: 'Notes', elementIndex: 1, clickCount: 2 })
    await provider.action('click', { app: 'Notes', elementIndex: 1, mouseButton: 'right' })
    const names = daemon.calls.filter((call) => call.name === 'double_click' || call.name === 'right_click').map((call) => call.name)
    expect(names).toEqual(['double_click', 'right_click'])
  })

  it('click 带 modifiers 显式拒绝（本期无前台投递，不静默丢修饰键）', async () => {
    const { provider } = await withProvider(standardHandlers())
    await provider.snapshot({ app: 'Notes' })
    await expect(
      provider.action('click', { app: 'Notes', elementIndex: 1, modifiers: 'cmd' })
    ).rejects.toMatchObject({ code: 'action_not_supported' })
  })

  it('performSecondaryAction 把 AX 动作名归一化；未知动作 ACTION_UNAVAILABLE', async () => {
    const { provider, daemon } = await withProvider(
      standardHandlers({
        click: () => ({ effect: 'confirmed', route: 'accessibility', evidence: [{ kind: 'value_readback' }] })
      })
    )
    await provider.snapshot({ app: 'Notes' })
    await provider.action('performSecondaryAction', { app: 'Notes', elementIndex: 2, action: 'showmenu' })
    const call = daemon.calls.find((c) => c.name === 'click')
    expect(call?.args.action).toBe('show_menu')
    await expect(
      provider.action('performSecondaryAction', { app: 'Notes', elementIndex: 2, action: 'zoomwindow' })
    ).rejects.toMatchObject({ code: 'action_not_supported' })
  })

  it('scroll 元素寻址 → 元素 frame 中心的截图像素 + by:page', async () => {
    let scrollArgs: Record<string, unknown> = {}
    const { provider } = await withProvider(
      standardHandlers({
        scroll: (args) => {
          scrollArgs = args
          return { effect: 'unverifiable', route: 'synthetic_events' }
        }
      })
    )
    await provider.snapshot({ app: 'Notes' })
    await provider.action('scroll', { app: 'Notes', elementIndex: 1, direction: 'down', pages: 2 })
    // 元素 1 frame 中心 = 全局 (70, 70) → 窗口局部 (60, 50) → ×2 = (120, 100)。
    expect(scrollArgs.x).toBe(120)
    expect(scrollArgs.y).toBe(100)
    expect(scrollArgs.direction).toBe('down')
    expect(scrollArgs.by).toBe('page')
    expect(scrollArgs.amount).toBe(2)
  })

  it('drag 元素对 → 起止点都换算成截图像素', async () => {
    let dragArgs: Record<string, unknown> = {}
    const { provider } = await withProvider(
      standardHandlers({
        drag: (args) => {
          dragArgs = args
          return { effect: 'unverifiable', route: 'synthetic_events' }
        }
      })
    )
    await provider.snapshot({ app: 'Notes' })
    await provider.action('drag', { app: 'Notes', fromElementIndex: 1, toElementIndex: 2 })
    // 元素 1 中心 (120,100)；元素 2 中心 = (20+150, 100+75) 全局 → 局部 (160,155) ×2 = (320,310)。
    expect(dragArgs.from_x).toBe(120)
    expect(dragArgs.from_y).toBe(100)
    expect(dragArgs.to_x).toBe(320)
    expect(dragArgs.to_y).toBe(310)
  })

  it('typeText 带元素索引：element_token 直传（0.40 契约）', async () => {
    const { provider, daemon } = await withProvider(
      standardHandlers({
        type_text: () => ({ effect: 'confirmed', route: 'accessibility', evidence: [{ kind: 'value_readback' }] })
      })
    )
    await provider.snapshot({ app: 'Notes' })
    await provider.action('typeText', { app: 'Notes', text: 'hello', elementIndex: 2 })
    const names = daemon.calls.filter((c) => c.name === 'type_text').map((c) => c.name)
    expect(names).toEqual(['type_text'])
    const typeCall = daemon.calls.find((c) => c.name === 'type_text')
    expect(typeCall?.args.text).toBe('hello')
    expect(typeCall?.args.element_token).toBe('s00000001:2')
  })

  it('pressKey / hotkey：键名与弦的映射，repeat 循环', async () => {
    const { provider, daemon } = await withProvider(
      standardHandlers({
        press_key: () => ({ effect: 'unverifiable', route: 'synthetic_events' }),
        hotkey: () => ({ effect: 'unverifiable', route: 'synthetic_events' })
      })
    )
    await provider.snapshot({ app: 'Notes' })
    await provider.action('pressKey', { app: 'Notes', key: 'return', repeat: 2 })
    await provider.action('hotkey', { app: 'Notes', key: 'cmd+a' })
    const pressCalls = daemon.calls.filter((c) => c.name === 'press_key')
    expect(pressCalls).toHaveLength(2)
    expect(pressCalls[0]?.args.key).toBe('return')
    const hotkeyCall = daemon.calls.find((c) => c.name === 'hotkey')
    expect(hotkeyCall?.args.keys).toEqual(['cmd', 'a'])
  })

  it('pasteText = clipboard_write + hotkey(cmd+v)，验证恒为 unverified/clipboard_paste', async () => {
    const { provider, daemon } = await withProvider(
      standardHandlers({
        clipboard_write: () => ({ supported: true, written_type: 'text', types: ['public.utf8-plain-text'] }),
        hotkey: () => ({ effect: 'unverifiable', route: 'synthetic_events' })
      })
    )
    await provider.snapshot({ app: 'Notes' })
    const result = await provider.action('pasteText', { app: 'Notes', text: 'secret-payload' })
    const names = daemon.calls.map((c) => c.name)
    expect(names).toEqual(['list_apps', 'list_windows', 'get_window_state', 'clipboard_write', 'hotkey', 'get_window_state'])
    expect(daemon.calls.find((c) => c.name === 'clipboard_write')?.args.text).toBe('secret-payload')
    expect(daemon.calls.find((c) => c.name === 'hotkey')?.args.keys).toEqual(['cmd', 'v'])
    const parsed = computerActionResultSchema.parse(result)
    expect(parsed.action?.path).toBe('clipboard')
    expect(parsed.action?.verification).toEqual({ state: 'unverified', reason: 'clipboard_paste' })
  })

  it('pasteText 拒绝非纯文本 format', async () => {
    const { provider } = await withProvider(standardHandlers())
    await provider.snapshot({ app: 'Notes' })
    await expect(
      provider.action('pasteText', { app: 'Notes', text: 'x', format: 'html' })
    ).rejects.toMatchObject({ code: 'action_not_supported' })
  })

  it('setValue 按元素 token 寻址；confirmed 读回 → verified', async () => {
    const { provider, daemon } = await withProvider(
      standardHandlers({
        set_value: () => ({ effect: 'confirmed', route: 'accessibility', evidence: [{ kind: 'value_readback', detail: 'newValue' }] })
      })
    )
    await provider.snapshot({ app: 'Notes' })
    const result = await provider.action('setValue', { app: 'Notes', elementIndex: 2, value: 'newValue' })
    const call = daemon.calls.find((c) => c.name === 'set_value')
    expect(call?.args.element_token).toBe('s00000001:2')
    expect(call?.args.value).toBe('newValue')
    const parsed = computerActionResultSchema.parse(result)
    expect(parsed.action?.verification).toEqual({ state: 'verified', property: 'value', actualPreview: 'newValue' })
  })

  it('索引过期：新快照后旧索引查不到 → ELEMENT_NOT_FOUND（带重新观察引导）', async () => {
    let snapshotCounter = 0
    const { provider } = await withProvider(
      standardHandlers({
        get_window_state: (args) => {
          snapshotCounter += 1
          const base = standardHandlers().get_window_state!(args) as Record<string, unknown>
          if (snapshotCounter >= 2) {
            // 第二次快照只剩窗口元素：索引 1/2 不存在了。
            return {
              ...base,
              snapshot_id: 's00000002',
              element_count: 1,
              returned_element_count: 1,
              total_element_count: 1,
              tree_markdown: '- [0] AXWindow "MainWindow" [actions=[raise]]',
              elements: (base.elements as unknown[]).slice(0, 1)
            }
          }
          return base
        }
      })
    )
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    await expect(
      provider.action('click', { app: 'Notes', elementIndex: 1 })
    ).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' })
  })

  it('driver 侧 stale_element_token 拒绝 → ELEMENT_NOT_FOUND', async () => {
    const { provider } = await withProvider(
      standardHandlers({
        click: () => toolError({ refusal: { code: 'stale_element_token', message: 'element_token is stale; call get_window_state again to refresh' } })
      })
    )
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    await expect(
      provider.action('click', { app: 'Notes', elementIndex: 1 })
    ).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' })
  })

  // --- 错误码映射（WP2 表） --------------------------------------------------

  it.each([
    ['permission_denied', 'PERMISSION_DENIED'],
    ['app_not_found', 'APP_NOT_FOUND'],
    ['window_id_not_found', 'WINDOW_NOT_FOUND'],
    ['window_owner_pid_mismatch', 'WINDOW_NOT_FOUND'],
    ['background_unavailable', 'BACKGROUND_UNAVAILABLE'],
    ['screenshot_context_missing', 'ELEMENT_NOT_FOUND']
  ])('driver 码 %s → KepCup %s', (driverCode, kepcupCode) => {
    expect(mapCuaDriverErrorCode(driverCode)).toBe(kepcupCode)
  })

  it('未知 driver 码不变成 INTERNAL 的白板：落 accessibility_error + 原始码进 message', () => {
    expect(mapCuaDriverErrorCode('some_future_code')).toBe('accessibility_error')
    const error = cuaDriverToolError('some_future_code', 'something broke')
    expect(error).toBeInstanceOf(AppError)
    expect(error.code).toBe('accessibility_error')
    expect(error.code).not.toBe('INTERNAL')
    expect(error.message).toContain('some_future_code')
    expect(error.message).toContain('something broke')
  })

  it('未知码的动作报错带人类可读文本且 code 不是 INTERNAL', async () => {
    const { provider } = await withProvider(
      standardHandlers({
        click: () => toolError({ code: 'weird_new_refusal', reason: 'an unhandled refusal path' })
      })
    )
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    const error = await provider
      .action('click', { app: 'Notes', elementIndex: 1 })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('accessibility_error')
    expect((error as AppError).code).not.toBe('INTERNAL')
    expect((error as AppError).message).toContain('weird_new_refusal')
  })

  it('window_not_found 拒绝 → WINDOW_NOT_FOUND，message 带真实线索', async () => {
    const { provider } = await withProvider(
      standardHandlers({
        click: () =>
          toolError({
            code: 'window_not_found',
            effect: 'refused',
            pid: 100,
            window_id: 7,
            reason: 'WindowServer has no record of window 7 (closed or stale); re-enumerate windows and re-target'
          })
      })
    )
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    const error = await provider.action('click', { app: 'Notes', elementIndex: 1 }).catch((caught: unknown) => caught)
    expect((error as AppError).code).toBe('WINDOW_NOT_FOUND')
    expect((error as AppError).message).toContain('WindowServer has no record')
  })

  // --- 传输层（WP2 验收） ----------------------------------------------------

  it('伪 daemon 断连 → COMPUTER_UNAVAILABLE（不是 INTERNAL）', async () => {
    const daemon = await startFakeDaemon(standardHandlers())
    running.push(daemon.close)
    const rawClient = new CuaDriverDaemonClient(daemon.socketPath)
    const provider = new CuaDriverProviderClient({
      userDataDirectory: tempDir,
      client: rawClient,
      skipOrphanCleanup: true
    })
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    daemon.close()
    // 让旧连接的 'close' 事件先结算：连接死了之后下一次调用在连接阶段失败，
    // 而不是写进半死的缓冲等 30s 读超时。
    await new Promise((resolve) => setTimeout(resolve, 30))
    await expect(provider.snapshot({ app: 'Notes', noScreenshot: true })).rejects.toMatchObject({
      code: 'COMPUTER_UNAVAILABLE'
    })
    rawClient.close()
  })

  it('超长行（超 32MB 无换行）→ 传输错误而不是 OOM', async () => {
    const buffer = new CuaDriverLineBuffer()
    const huge = 'x'.repeat(32 * 1024 * 1024 + 1)
    expect(() => buffer.push(huge, () => {})).toThrow(/line exceeded/)
  })

  it('非 JSON 行 → 传输错误', async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), 'cua-fake-')), 'driver.sock')
    running.push(() => rmSync(socketPath, { force: true }))
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('not-json\n')
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    running.push(() => server.close())
    const client = new CuaDriverDaemonClient(socketPath)
    await expect(client.call('list_apps', {})).rejects.toMatchObject({ code: 'COMPUTER_UNAVAILABLE' })
    client.close()
  })

  it('读超时 → action_timeout + 连接重置（下次调用可重连）', async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), 'cua-fake-')), 'driver.sock')
    running.push(() => rmSync(socketPath, { force: true }))
    const server = net.createServer((socket) => {
      // 吞掉请求不应答。
      socket.on('data', () => {})
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    running.push(() => server.close())
    const client = new CuaDriverDaemonClient(socketPath)
    await expect(client.call('list_apps', {}, { timeoutMs: 80 })).rejects.toMatchObject({
      code: 'action_timeout'
    })
    client.close()
  })
})

// --- 坐标换算三情形（findings Q4：无损映射判据） ------------------------------

describe('cua-driver 坐标换算', () => {
  const base = { boundsX: 10, boundsY: 20, boundsWidth: 400, boundsHeight: 300 }

  it('scale=1：px = pt × 1', () => {
    expect(
      windowPointToScreenshotPixel({ ...base, screenshotWidth: 400, screenshotHeight: 300, screenshotScale: 1 }, { x: 100, y: 50 })
    ).toEqual({ x: 100, y: 50 })
  })

  it('Retina 2x：px = pt × 2', () => {
    expect(
      windowPointToScreenshotPixel({ ...base, screenshotWidth: 800, screenshotHeight: 600, screenshotScale: 2 }, { x: 100, y: 50 })
    ).toEqual({ x: 200, y: 100 })
  })

  it('降尺度（max_dimension 天花板）：ratio 跟 PNG 实际尺寸，scale 不再等于 ratio', () => {
    // bounds 400pt，PNG 被 max_dimension 压到 320px：ratio = 320/400 = 0.8（≠ scale 2）。
    expect(
      windowPointToScreenshotPixel({ ...base, screenshotWidth: 320, screenshotHeight: 240, screenshotScale: 2 }, { x: 100, y: 50 })
    ).toEqual({ x: 80, y: 40 })
  })
})

// --- B 层契约（fixtures：真实应答过 zod） ------------------------------------

describe('cua-driver fixtures（真实应答录制）', () => {
  it('录制的 get_window_state 应答经归一化后过 zod 且关键字段不丢', async () => {
    const { readCuaDriverFixture } = await import('./cua-driver-fixtures')
    const fixture = readCuaDriverFixture('get-window-state-textedit.json')
    const daemon = await startFakeDaemon(
      standardHandlers({
        get_window_state: (args) => ({
          ...fixture.structuredContent,
          // 伪 daemon 补落盘截图（fixture 的 base64 是录制机上的文件内容）。
          ...(typeof args.screenshot_out_file === 'string'
            ? (() => {
                writeFileSync(args.screenshot_out_file, Buffer.from(fixture.screenshotBase64 ?? tinyPngBase64, 'base64'))
                return { screenshot_file_path: args.screenshot_out_file }
              })()
            : {}),
          // fixture 录的是 TextEdit；resolveApp 走 list_apps，这里对齐 app 名。
          app_name: 'Notes'
        })
      })
    )
    try {
      const provider = makeClient(daemon.socketPath, tempDir)
      const result = await provider.snapshot({ app: 'Notes' })
      const parsed = computerSnapshotResultSchema.parse(result)
      expect(parsed.screenshot?.scale).toBe(fixture.structuredContent.screenshot_scale)
      expect(parsed.snapshot.elementCount).toBe(fixture.structuredContent.element_count)
      expect(parsed.snapshot.id).toBe(fixture.structuredContent.snapshot_id)
      expect(parsed.snapshot.treeText.length).toBeGreaterThan(0)
      expect(parsed.screenshotStatus.state).toBe('captured')
      // 截断信号忠实透传（0.40 的 truncated 字段）。
      expect(parsed.snapshot.truncation?.truncated).toBe(fixture.structuredContent.truncated === true)
    } finally {
      daemon.close()
    }
  })

  it('录制的 click 应答（unverifiable + accessibility）映射为 unverified/accessibility_action_unasserted', async () => {
    const { readCuaDriverFixture } = await import('./cua-driver-fixtures')
    const fixture = readCuaDriverFixture('click-element-unverifiable.json')
    const structured = fixture.result?.structuredContent ?? {}
    const { provider } = await withProvider(
      standardHandlers({
        click: () => structured
      })
    )
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    const result = await provider.action('performSecondaryAction', { app: 'Notes', elementIndex: 1, action: 'press' })
    const parsed = computerActionResultSchema.parse(result)
    expect(parsed.action?.path).toBe('accessibility')
    expect(parsed.action?.verification).toEqual({
      state: 'unverified',
      reason: 'accessibility_action_unasserted',
      actualPreview: null
    })
  })

  it('录制的 type_text 应答（confirmed + value_readback）映射为 verified/value', async () => {
    const { readCuaDriverFixture } = await import('./cua-driver-fixtures')
    const fixture = readCuaDriverFixture('type-text-confirmed.json')
    const structured = fixture.result?.structuredContent ?? {}
    const { provider } = await withProvider(
      standardHandlers({
        type_text: () => structured
      })
    )
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    const result = await provider.action('typeText', { app: 'Notes', text: 'PROBE-TYPE ', elementIndex: 2 })
    const parsed = computerActionResultSchema.parse(result)
    expect(parsed.action?.path).toBe('accessibility')
    expect(parsed.action?.verification).toEqual({
      state: 'verified',
      property: 'value',
      actualPreview: null
    })
  })

  it('录制的错误应答（isError 无 structuredContent）→ accessibility_error', async () => {
    const { readCuaDriverFixture } = await import('./cua-driver-fixtures')
    const fixture = readCuaDriverFixture('click-element-action-failed.json')
    const content = fixture.result?.content ?? [{ type: 'text', text: 'AX action failed: AXUIElementPerformAction(AXPress) returned -25200' }]
    const { provider } = await withProvider(
      standardHandlers({
        click: () => toolError({ __content: content })
      })
    )
    // 无 structuredContent 的工具级失败：错误提取走 content 文本回退。
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    const error = await provider.action('click', { app: 'Notes', elementIndex: 0 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('accessibility_error')
    expect((error as AppError).message).toContain('AXPress')
  })

  it('工具级失败带 content 文本（无 structuredContent）时文本进 message', async () => {
    const { provider } = await withProvider(
      standardHandlers({
        click: () =>
          toolError({
            __content: [{ type: 'text', text: 'AX action failed: AXUIElementPerformAction(AXPress) returned -25200' }]
          })
      })
    )
    await provider.snapshot({ app: 'Notes', noScreenshot: true })
    const error = await provider.action('click', { app: 'Notes', elementIndex: 0 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('accessibility_error')
    expect((error as AppError).message).toContain('-25200')
  })
})
