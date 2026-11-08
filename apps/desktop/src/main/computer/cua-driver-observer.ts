import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AppError } from '@kepcup/shared'
import type {
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerScreenshotStatus,
  ComputerSnapshotResult,
  ComputerWindowInfo
} from '@kepcup/shared'
import type { CuaDriverDaemonClient } from './cua-driver-daemon-client'
import {
  cuaDriverSnapshotGeometry,
  normalizeCuaTreeText,
  parseCuaElementRecords
} from './cua-driver-tree-normalization'
import { CuaDriverSnapshotStore, type CuaDriverElementRecord } from './cua-driver-snapshot-store'
import { cuaDriverTransportError } from './cua-driver-error-map'

// cua-driver 观察归一化（P-B1，todo/computer-use-cua-adapter.md WP3）。
//
// snapshot() 把 get_window_state 的 structuredContent 造出
// ComputerSnapshotResult{snapshot, screenshot, screenshotStatus}：
// - snapshot.id = driver 的 snapshot_id（每窗口递增，随快照重排索引——findings Q3）；
// - treeText = tree_markdown 整形成 KepCup 行首数字格式（sidecar 的
//   ComputerTreeBaselines 依赖该格式做增量 diff；纯文本整形，不改语义）；
// - elementCount / truncation 来自 element_count 族字段；
// - focusedElementId：cua 无对应字段 → null；
// - screenshot 走 screenshot_out_file 落盘（不经 JSON 行搬 base64，findings Q1）。

export const CUA_DRIVER_APP_CACHE_TTL_MS = 5_000
export const CUA_DRIVER_WINDOW_CACHE_TTL_MS = 2_000
/** AX 树预算（driver 默认 2000 / depth 25；KepCup 不传即用 driver 默认，预留收口）。 */
export const CUA_DRIVER_MAX_ELEMENTS = 2_000

export type ResolvedCuaApp = {
  pid: number
  name: string
  bundleId: string | null
}

export type CuaWindowRecord = {
  window_id: number
  pid: number
  app_name: string
  title: string
  bounds: { x: number; y: number; width: number; height: number }
  is_on_screen: boolean
  z_index: number | null
  on_current_space?: boolean
}

export class CuaDriverObserver {
  private appCache: { apps: CuaDriverAppEntry[]; at: number } | null = null
  /** 窗口列表短缓存：一次 snapshot/action 里 resolve + normalize 各读一次是冗余的。 */
  private windowCache = new Map<number, { windows: CuaWindowRecord[]; at: number }>()

  constructor(
    private readonly client: CuaDriverDaemonClient,
    private readonly snapshotStore: CuaDriverSnapshotStore,
    private readonly tempDirectory: string
  ) {}

  async listApps(): Promise<ComputerListAppsResult> {
    const apps = await this.listAppsRaw()
    // 只回运行中的应用，对齐原生 provider 语义：core 的列表标题是「正在运行的
    // 应用（N）」，混入已安装未运行的应用会让标题失实（2026-11-07 复检发现）。
    // driver 的完整列表（含未运行）仍供 resolveApp 给「先启动它再操控」引导。
    return {
      apps: apps
        .filter((app) => app.running === true && app.pid !== 0)
        .map((app) => ({
          name: app.name,
          bundleId: app.bundle_id ?? null,
          pid: app.pid,
          isRunning: true,
          lastUsedAt: app.last_used ?? null,
          useCount: null
        }))
    }
  }

  async listWindows(params: Record<string, unknown>): Promise<ComputerListWindowsResult> {
    const app = await this.resolveApp(stringParam(params, 'app'))
    const windows = await this.listWindowsForPid(app.pid)
    return {
      app: { name: app.name, bundleId: app.bundleId, pid: app.pid },
      windows: windows.map((window, index) => ({
        id: window.window_id,
        index,
        app: { name: app.name, bundleId: app.bundleId, pid: app.pid },
        title: window.title,
        x: window.bounds.x,
        y: window.bounds.y,
        width: window.bounds.width,
        height: window.bounds.height,
        isMinimized: null,
        isOffscreen: window.is_on_screen !== true,
        screenIndex: null,
        isMain: pickMainWindow(windows)?.window_id === window.window_id
      }))
    }
  }

  async snapshot(params: Record<string, unknown>): Promise<ComputerSnapshotResult> {
    const noScreenshot = params.noScreenshot === true
    const app = await this.resolveApp(stringParam(params, 'app'))
    const windowId = await this.resolveWindowId(app, params)
    return await this.observeWindowState(app, windowId, { includeScreenshot: !noScreenshot })
  }

  /** 快照 + 动作后共用的观察入口；also 记录带树快照到索引表。 */
  async observeWindowState(
    app: ResolvedCuaApp,
    windowId: number,
    options: { includeScreenshot: boolean; includeTree?: boolean }
  ): Promise<ComputerSnapshotResult> {
    const includeTree = options.includeTree !== false
    const screenshotOutFile = options.includeScreenshot
      ? join(this.tempDirectory, `cua-shot-${randomBytes(6).toString('hex')}.png`)
      : undefined
    const result = await this.client.call('get_window_state', {
      pid: app.pid,
      window_id: windowId,
      // 0.40 契约：默认只回 markdown；元素索引表需要 structured elements（WP3）。
      ...(includeTree ? { tree_format: 'both' } : { include_accessibility_tree: false }),
      ...(options.includeScreenshot
        ? { include_screenshot: true, screenshot_out_file: screenshotOutFile }
        : { include_screenshot: false }),
      ...(includeTree ? { max_elements: CUA_DRIVER_MAX_ELEMENTS } : {})
    })
    const structured = result.structuredContent
    try {
      return await this.normalizeWindowState(app, windowId, structured, screenshotOutFile, {
        includeTree,
        includeScreenshot: options.includeScreenshot
      })
    } finally {
      if (screenshotOutFile) {
        await rm(screenshotOutFile, { force: true }).catch(() => {})
      }
    }
  }

  private async normalizeWindowState(
    app: ResolvedCuaApp,
    windowId: number,
    structured: Record<string, unknown>,
    screenshotOutFile: string | undefined,
    options: { includeTree: boolean; includeScreenshot: boolean }
  ): Promise<ComputerSnapshotResult> {
    // degraded（0.40 契约）：窗口被替换（动作开新窗 / zoom 换 CGWindowID）、应用
    // 启动中或锁屏——树按设计为空且无 snapshot_id。对 KepCup 这等价于「窗口失效，
    // 重新 list_windows 选窗」，与原生 provider 的 window_stale 同语义。
    const degradedReason = asString(structured.degraded_reason)
    if (degradedReason) {
      throw new AppError(
        'WINDOW_NOT_FOUND',
        `窗口 ${windowId} 观测降级（${degradedReason}）。用 computer_list_windows 重新选窗，再 computer_get_app_state 刷新。`
      )
    }
    const snapshotId = typeof structured.snapshot_id === 'string' ? structured.snapshot_id : null
    if (!snapshotId) {
      throw cuaDriverTransportError('get_window_state returned no snapshot_id')
    }
    const windowTitle = asString(structured.window_title) ?? ''
    const bounds = asBounds(structured.window_bounds)
    const windows = await this.listWindowsForPid(app.pid)
    const windowRecord = windows.find((window) => window.window_id === windowId)
    const windowBounds = bounds ?? windowRecord?.bounds ?? null
    const treeMarkdown = asString(structured.tree_markdown) ?? ''
    const elementCount = asInt(structured.element_count) ?? 0
    const returnedElementCount = asInt(structured.returned_element_count) ?? elementCount
    const totalElementCount = asInt(structured.total_element_count) ?? elementCount
    // 截断信号：truncated 布尔（0.40 契约）或 returned < total。注意不能用
    // elements_complete——0.28/0.40 实测它对完整走查也恒为 false（findings Q2）。
    const truncated =
      structured.truncated === true || returnedElementCount < totalElementCount

    // 截图状态先算：失败原因记在快照表（store 级，不被无截图观察覆盖），
    // 坐标寻址被挡时才能回带可行动指引（macOS 26+ 二段同意未完成时
    // scroll/drag/坐标点击会整条被挡，模型需要知道出口）。
    const screenshotStatus = this.screenshotStatus(structured, options.includeScreenshot)
    if (screenshotStatus.state === 'failed') {
      this.snapshotStore.rememberScreenshotFailure(app.pid, windowId, screenshotStatus.message)
    } else if (screenshotStatus.state === 'captured') {
      this.snapshotStore.clearScreenshotFailure(app.pid, windowId)
    }
    // 带树快照才更新索引表（截图后观测没有新索引，findings Q3）。
    let elementRecords = new Map<number, CuaDriverElementRecord>()
    if (options.includeTree) {
      elementRecords = parseCuaElementRecords(structured)
      if (windowBounds) {
        this.snapshotStore.remember({
          pid: app.pid,
          windowId,
          snapshotId,
          appName: app.name,
          bundleId: app.bundleId,
          windowTitle,
          windowBounds,
          geometry: cuaDriverSnapshotGeometry({
            windowBounds,
            screenshotWidth: asInt(structured.screenshot_width) ?? 0,
            screenshotHeight: asInt(structured.screenshot_height) ?? 0,
            screenshotScale: asNumber(structured.screenshot_scale) ?? 1
          }),
          elements: elementRecords
        })
      }
    }

    const snapshot: ComputerSnapshotResult['snapshot'] = {
      id: snapshotId,
      app: { name: app.name, bundleId: app.bundleId, pid: app.pid },
      window: {
        id: windowId,
        index: windowRecord ? windows.indexOf(windowRecord) : null,
        title: windowTitle,
        x: windowBounds?.x ?? null,
        y: windowBounds?.y ?? null,
        width: windowBounds?.width ?? 0,
        height: windowBounds?.height ?? 0,
        isMinimized: null,
        isOffscreen: windowRecord ? windowRecord.is_on_screen !== true : null,
        screenIndex: null
      } satisfies ComputerWindowInfo,
      coordinateSpace: 'window',
      treeText: normalizeCuaTreeText(treeMarkdown),
      elementCount,
      focusedElementId: null,
      ...(options.includeTree
        ? {
            truncation: {
              truncated,
              ...(truncated ? { maxNodes: CUA_DRIVER_MAX_ELEMENTS } : {})
            }
          }
        : {})
    }

    const screenshot = await this.readScreenshot(structured, screenshotOutFile, options.includeScreenshot)
    return { snapshot, screenshot, screenshotStatus }
  }

  /**
   * 截图失败原因 → 模型可见文本（core 把 message 渲染为「[截屏失败：<message>]」）。
   * macOS 26+ 直接采集二段同意未完成（px_capture_unavailable /
   * direct_capture_consent_required——findings 0.40.1 新增发现 2）时给可行动指引，
   * 其余失败保持 driver 原文（不臆造原因）。
   */
  private screenshotFailureMessage(rawReason: string): string {
    if (/direct_capture_consent_required|px_capture_unavailable/i.test(rawReason)) {
      return (
        '屏幕录制授权不可用（macOS 26+ 直接采集需要二次同意）：在 系统设置 › 隐私与安全性 › 屏幕录制 ' +
        '给 KepCup 开启授权（或对弹出的采集同意框点「允许」），然后重启 KepCup（TCC 按进程缓存）再试。' +
        `原始原因：${rawReason}`
      )
    }
    return rawReason
  }

  private screenshotStatus(
    structured: Record<string, unknown>,
    includeScreenshot: boolean
  ): ComputerScreenshotStatus {
    if (!includeScreenshot) {
      return { state: 'skipped', reason: 'no_screenshot_flag' }
    }
    // degraded（degraded_reason）已在 normalizeWindowState 前置抛 WINDOW_NOT_FOUND；
    // 这里处理「AX 负载有效但截图不可证」的剩余情形（px_frame_mismatch /
    // px_capture_unavailable / direct-capture 未同意——findings 0.40.1 复核）。
    const screenshotError = structured.screenshot_error as { code?: unknown; reason?: unknown } | null
    if (typeof structured.screenshot_file_path !== 'string') {
      const reason =
        screenshotError && typeof screenshotError.reason === 'string'
          ? screenshotError.reason
          : typeof structured.screenshot_file_path !== 'string' &&
              structured.screenshot_frame_valid === false
            ? 'driver refused the pixel frame (px_frame_mismatch); screenshot omitted'
            : 'driver returned no screenshot file'
      return {
        state: 'failed',
        code: 'screenshot_failed',
        message: this.screenshotFailureMessage(reason)
      }
    }
    return {
      state: 'captured',
      metadata: {
        engine: 'unknown',
        ...(typeof structured.window_id === 'number' ? { windowId: structured.window_id } : {})
      }
    }
  }

  private async readScreenshot(
    structured: Record<string, unknown>,
    screenshotOutFile: string | undefined,
    includeScreenshot: boolean
  ): Promise<ComputerSnapshotResult['screenshot']> {
    if (!includeScreenshot || typeof structured.screenshot_file_path !== 'string') {
      return null
    }
    try {
      const data = await readFile(screenshotOutFile ?? structured.screenshot_file_path as string)
      return {
        data: data.toString('base64'),
        format: 'png',
        width: asInt(structured.screenshot_width) ?? 0,
        height: asInt(structured.screenshot_height) ?? 0,
        scale: asNumber(structured.screenshot_scale) ?? 1
      }
    } catch {
      return null
    }
  }

  // --- app / window 解析 -----------------------------------------------------

  /** app 名或 bundle id → pid（list_apps 含已安装未运行；未运行 → APP_NOT_FOUND）。 */
  async resolveApp(appQuery: string): Promise<ResolvedCuaApp> {
    const apps = await this.listAppsRaw()
    const query = appQuery.trim().toLowerCase()
    const match = apps.find(
      (app) =>
        app.name.toLowerCase() === query ||
        (app.bundle_id ?? '').toLowerCase() === query
    )
    if (!match || match.running !== true || match.pid === 0) {
      throw new AppError(
        'APP_NOT_FOUND',
        `未找到正在运行的应用「${appQuery}」。先启动它，再重新 computer_list_apps 拿准确名称。`
      )
    }
    return { pid: match.pid, name: match.name, bundleId: match.bundle_id ?? null }
  }

  async listWindowsForPid(pid: number): Promise<CuaWindowRecord[]> {
    const cached = this.windowCache.get(pid)
    if (cached && Date.now() - cached.at < CUA_DRIVER_WINDOW_CACHE_TTL_MS) {
      return cached.windows
    }
    const windows = await this.callListWindows()
    const forPid = windows.filter((window) => window.pid === pid)
    this.windowCache.set(pid, { windows: forPid, at: Date.now() })
    return forPid
  }

  private async callListWindows(): Promise<CuaWindowRecord[]> {
    const result = await this.client.call('list_windows', { on_screen_only: true })
    const windows = (result.structuredContent as { windows?: unknown }).windows
    if (!Array.isArray(windows)) {
      throw cuaDriverTransportError('list_windows returned no windows array')
    }
    return windows as CuaWindowRecord[]
  }

  /** windowId / windowIndex / 缺省主窗口 → cua window_id。 */
  async resolveWindowId(app: ResolvedCuaApp, params: Record<string, unknown>): Promise<number> {
    const windows = await this.listWindowsForPid(app.pid)
    if (windows.length === 0) {
      throw new AppError(
        'WINDOW_NOT_FOUND',
        `${app.name} 没有在屏窗口。用 computer_list_windows 重新选窗。`
      )
    }
    const windowId = params.windowId
    const windowIndex = params.windowIndex
    if (typeof windowId === 'number' && typeof windowIndex === 'number') {
      throw new AppError('invalid_argument', 'Window targeting accepts either windowId or windowIndex, not both')
    }
    if (typeof windowId === 'number') {
      const match = windows.find((window) => window.window_id === windowId)
      if (!match) {
        throw new AppError(
          'WINDOW_NOT_FOUND',
          `window_id ${windowId} 不是 ${app.name} 的在屏窗口（owner_pid 不同或窗口已关）。用 computer_list_windows 重新选窗。`
        )
      }
      return windowId
    }
    if (typeof windowIndex === 'number') {
      const match = windows[windowIndex]
      if (!match) {
        throw new AppError(
          'WINDOW_NOT_FOUND',
          `window_index ${windowIndex} 超出 ${app.name} 的在屏窗口数（${windows.length}）。用 computer_list_windows 重新选窗。`
        )
      }
      return match.window_id
    }
    return pickMainWindow(windows)!.window_id
  }

  private async listAppsRaw(): Promise<CuaDriverAppEntry[]> {
    if (this.appCache && Date.now() - this.appCache.at < CUA_DRIVER_APP_CACHE_TTL_MS) {
      return this.appCache.apps
    }
    const result = await this.client.call('list_apps', {})
    const apps = (result.structuredContent as { apps?: unknown }).apps
    if (!Array.isArray(apps)) {
      throw cuaDriverTransportError('list_apps returned no apps array')
    }
    this.appCache = { apps: apps as CuaDriverAppEntry[], at: Date.now() }
    return this.appCache.apps
  }
}

export type CuaDriverAppEntry = {
  pid: number
  name: string
  running: boolean
  active?: boolean
  bundle_id?: string | null
  launch_path?: string | null
  kind?: string | null
  last_used?: string | null
}

/** 主窗口：z_index 最大的在屏窗口（上游语义：null 时不推断数组顺序，取首个）。 */
export function pickMainWindow(windows: CuaWindowRecord[]): CuaWindowRecord | null {
  if (windows.length === 0) {
    return null
  }
  const withZ = windows.filter((window) => typeof window.z_index === 'number')
  if (withZ.length === 0) {
    return windows[0]!
  }
  return withZ.reduce((best, window) =>
    (window.z_index as number) > (best.z_index as number) ? window : best
  )
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('invalid_argument', `Missing ${key}`)
  }
  return value
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBounds(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.x !== 'number' ||
    typeof record.y !== 'number' ||
    typeof record.width !== 'number' ||
    typeof record.height !== 'number'
  ) {
    return null
  }
  return { x: record.x, y: record.y, width: record.width, height: record.height }
}
