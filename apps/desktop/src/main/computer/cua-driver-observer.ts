import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
import type { CuaDriverSnapshotStore } from './cua-driver-snapshot-store'
import type { CuaDriverWindowGeometry } from './cua-driver-coordinates'
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
/** 截图落盘子目录（相对 provider 的 userData/socket 目录）与保留策略。 */
export const SCREENSHOT_DIRECTORY_NAME = 'computer-screenshots'
export const MAX_KEPT_SCREENSHOTS = 20
export const SCREENSHOT_MAX_AGE_MS = 30 * 60 * 1000

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
      ? await this.nextScreenshotPath()
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
    return await this.normalizeWindowState(app, windowId, structured, screenshotOutFile, {
      includeTree,
      includeScreenshot: options.includeScreenshot
    })
  }

  /**
   * 截图落盘目录：帧保留在磁盘上并把路径交给模型（无视觉能力的客户端可以做像素
   * 读回）。目录 0700、单文件 0600；每张新帧读入后按数量 + 时效修剪，避免把用户
   * 屏幕内容长期留在磁盘上。
   */
  private async nextScreenshotPath(): Promise<string> {
    const directory = join(this.tempDirectory, SCREENSHOT_DIRECTORY_NAME)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `cua-shot-${Date.now()}-${randomBytes(4).toString('hex')}.png`)
    // 先以 0600 预创建：driver 覆盖写入会沿用已有权限位，否则按 umask（常见 0644）
    // 落盘，屏幕内容在 chmod 之前对同机其他用户可读。
    await writeFile(path, '', { mode: 0o600 })
    return path
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
    if (options.includeTree && windowBounds) {
      this.snapshotStore.remember({
        pid: app.pid,
        windowId,
        snapshotId,
        appName: app.name,
        bundleId: app.bundleId,
        windowTitle,
        windowBounds,
        geometry: this.resolveGeometry(
          app.pid,
          windowId,
          windowBounds,
          structured,
          options.includeScreenshot
        ),
        elements: parseCuaElementRecords(structured)
      })
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
   * 无截图的观察（动作后补观察 / noScreenshot）里 driver 不回任何像素元数据
   * （实测 screenshot_width/height/scale 全缺）。窗口尺寸没变时沿用上一次的像素
   * 栅格——driver 自身也保留上一帧——否则这次观察会把几何清零，下一次坐标寻址
   * 被 requireGeometry 误判成「还没拿过截屏」。
   *
   * 只对「本来就没要截图」的观察成立：请求了截图却失败时，driver 不会保留上一帧
   * （契约是 `include_screenshot:false` 才保留），必须清零，让坐标动作拿到
   * 「截屏不可用 + 检测截屏」的可行动错误，而不是拿旧栅格去撞 driver。
   */
  private resolveGeometry(
    pid: number,
    windowId: number,
    windowBounds: { x: number; y: number; width: number; height: number },
    structured: Record<string, unknown>,
    captureRequested: boolean
  ): CuaDriverWindowGeometry {
    const screenshotWidth = asInt(structured.screenshot_width)
    const screenshotHeight = asInt(structured.screenshot_height)
    if (screenshotWidth !== null && screenshotHeight !== null) {
      return cuaDriverSnapshotGeometry({
        windowBounds,
        screenshotWidth,
        screenshotHeight,
        screenshotScale: asNumber(structured.screenshot_scale) ?? 1
      })
    }
    const previous = !captureRequested ? this.snapshotStore.current(pid, windowId) : null
    if (
      previous &&
      previous.geometry.screenshotWidth > 0 &&
      previous.windowBounds.width === windowBounds.width &&
      previous.windowBounds.height === windowBounds.height
    ) {
      return { ...previous.geometry, boundsX: windowBounds.x, boundsY: windowBounds.y }
    }
    return cuaDriverSnapshotGeometry({
      windowBounds,
      screenshotWidth: 0,
      screenshotHeight: 0,
      screenshotScale: 1
    })
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
        '截屏不可用：若系统弹出「直接采集」同意框，选允许即可；也可以在 设置 › 计算机操控 ' +
        '点「检测截屏」定位原因。同意后无需重启，重新截屏即可。' +
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
    const filePath =
      screenshotOutFile ?? (structured.screenshot_file_path as string)
    try {
      const data = await readFile(filePath)
      // 文件里是用户屏幕内容：收紧到 0600（driver 按 umask 可能落成 0644）。
      await chmod(filePath, 0o600).catch(() => {})
      // 新帧落盘后再修剪（含刚写的一张），目录里始终不超过保留上限。
      await pruneScreenshots(dirname(filePath))
      return {
        data: data.toString('base64'),
        format: 'png',
        width: asInt(structured.screenshot_width) ?? 0,
        height: asInt(structured.screenshot_height) ?? 0,
        scale: asNumber(structured.screenshot_scale) ?? 1,
        path: filePath
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

  /**
   * 动作后调用：动作可能改了窗口几何（zoom / 缩放）。补观察在无截图时没有
   * `window_bounds`，只能拿 list_windows 的 bounds 判断「尺寸是否变化」，2s 缓存
   * 会把动作前的旧尺寸喂给判断，导致沿用已被作废的像素栅格。
   */
  invalidateWindowCache(pid?: number): void {
    if (pid === undefined) {
      this.windowCache.clear()
    } else {
      this.windowCache.delete(pid)
    }
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

/** 只保留最近 MAX_KEPT_SCREENSHOTS 张、且不超过 SCREENSHOT_MAX_AGE_MS 的截图。 */
async function pruneScreenshots(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: Array<{ path: string; atMs: number }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.png')) {
      continue
    }
    const path = join(directory, entry.name)
    const stats = await stat(path).catch(() => null)
    if (stats) {
      files.push({ path, atMs: stats.mtimeMs })
    }
  }
  files.sort((a, b) => b.atMs - a.atMs)
  const cutoff = Date.now() - SCREENSHOT_MAX_AGE_MS
  for (const [index, file] of files.entries()) {
    if (index >= MAX_KEPT_SCREENSHOTS || file.atMs < cutoff) {
      await unlink(file.path).catch(() => {})
    }
  }
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
