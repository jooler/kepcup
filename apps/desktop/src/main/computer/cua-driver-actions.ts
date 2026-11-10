import { AppError } from '@kepcup/shared'
import type {
  ComputerActionResult,
  ComputerActionMetadata,
  ComputerActionVerification,
  ComputerSnapshotResult
} from '@kepcup/shared'
import type { CuaDriverDaemonClient } from './cua-driver-daemon-client'
import type { CuaDriverObserver, ResolvedCuaApp } from './cua-driver-observer'
import type { CuaDriverSnapshotStore } from './cua-driver-snapshot-store'
import {
  elementFrameCenter,
  globalPointToScreenshotPixel,
  windowPointToScreenshotPixel,
  type CuaDriverWindowGeometry
} from './cua-driver-coordinates'
import { validateComputerProviderActionParams } from './computer-provider-action-validation'
import type { ComputerActionMethod } from './computer-action-method'

// cua-driver 动作映射（P-B1，todo/computer-use-cua-adapter.md WP4，附录 A）。
//
// 9 个 ComputerActionMethod → cua 工具。要点：
// - 元素寻址：模型的 element_index 经快照索引表换 driver 的 element_token
//   （0.34+ 契约只收 token，findings Q3）；
// - 坐标寻址：KepCup 窗口点 → 截图像素（px = pt × ratio，WP3 coordinates），
//   几何以最近一次带截图的观察为准；
// - click 分派：clickCount>1 → double_click；mouse_button right → right_click
//   （cua 的 count 仅像素路径有效）；modifiers 需要前台投递——本期无前台升级
//   入口（P-B2），显式拒绝而不是静默丢失修饰键；
// - pasteText 是唯一非 1:1：clipboard_write + hotkey(cmd+v)，验证恒为
//   unverified/clipboard_paste（防重放硬要求，不得报 verified）；
// - delivery_mode 默认 background；仅 drag 支持显式 foreground（后台合成拖拽在
//   Finder 内容区实测完全无效），其余方法仍恒后台；
// - 动作后补一次全树观察（与原生 provider 行为一致：动作结果携带新索引，
//   treeBaselines 才有新基线；截图留给下一次 get_app_state）。

type CuaDriverActionStructured = {
  effect?: unknown
  route?: unknown
  evidence?: unknown
  escalation?: unknown
  summary?: unknown
}

export class CuaDriverActions {
  constructor(
    private readonly client: CuaDriverDaemonClient,
    private readonly observer: CuaDriverObserver,
    private readonly snapshotStore: CuaDriverSnapshotStore
  ) {}

  async action(method: ComputerActionMethod, params: Record<string, unknown>): Promise<ComputerActionResult> {
    const app = await validateComputerProviderActionParams(
      method,
      params
    )
    const resolvedApp = await this.observer.resolveApp(app)
    const windowId = await this.resolveActionWindowId(resolvedApp, params)

    let structured: CuaDriverActionStructured
    let verificationOverride: ComputerActionVerification | null = null
    let pathOverride: ComputerActionMetadata['path'] | null = null
    let actionName: string | null = null
    // 投递方式本期只对 drag 开放（后台合成拖拽在 Finder 内容区实测完全无效，
    // 前台能成功；其它方法的升级入口等有实测需求再加）。
    let delivery: 'background' | 'foreground' = 'background'

    switch (method) {
      case 'click': {
        const dispatched = await this.dispatchClick(resolvedApp, windowId, params)
        structured = dispatched.structured
        actionName = dispatched.actionName
        break
      }
      case 'performSecondaryAction': {
        const element = this.snapshotStore.requireToken(resolvedApp.pid, windowId, requireIndex(params, 'elementIndex'))
        actionName = normalizeCuaClickAction(stringParam(params, 'action'))
        if (!actionName) {
          throw new AppError(
            'action_not_supported',
            `无障碍动作「${String(params.action)}」无法映射到 cua-driver 的 click action（press/show_menu/pick/confirm/cancel/open）。从树文本元素的动作列表里选一个。`
          )
        }
        // 0.40 契约：element_token 自带 pid/window，不允许再带 target。
        structured = await this.callActionTool('click', {
          element_token: element.token,
          action: actionName,
          delivery_mode: 'background'
        })
        break
      }
      case 'scroll': {
        const point = await this.resolveActionPoint(resolvedApp, windowId, params)
        const pages = typeof params.pages === 'number' && params.pages > 0 ? Math.round(params.pages) : 1
        structured = await this.callActionTool('scroll', {
          x: point.x,
          y: point.y,
          direction: stringParam(params, 'direction'),
          by: 'page',
          amount: pages,
          target: windowTarget(resolvedApp.pid, windowId),
          delivery_mode: 'background'
        })
        break
      }
      case 'drag': {
        const geometry = this.requireGeometry(resolvedApp.pid, windowId)
        const from = await this.resolveDragPoint(resolvedApp, windowId, params, 'from', geometry)
        const to = await this.resolveDragPoint(resolvedApp, windowId, params, 'to', geometry)
        delivery = params.delivery === 'foreground' ? 'foreground' : 'background'
        structured = await this.callActionTool('drag', {
          from_x: from.x,
          from_y: from.y,
          to_x: to.x,
          to_y: to.y,
          target: windowTarget(resolvedApp.pid, windowId),
          delivery_mode: delivery
        })
        break
      }
      case 'typeText': {
        const text = stringParam(params, 'text')
        // driver 0.40 的 type_text 收 element_token（AXSetAttribute(kAXSelectedText)
        // 直写该元素，token 自带 pid/window）；无元素索引时写 target 的焦点元素。
        const elementIndex = params.elementIndex
        const element =
          elementIndex !== undefined
            ? this.snapshotStore.requireToken(resolvedApp.pid, windowId, requireIndex(params, 'elementIndex'))
            : null
        structured = await this.callActionTool('type_text', {
          text,
          ...(element ? { element_token: element.token } : { target: windowTarget(resolvedApp.pid, windowId) }),
          delivery_mode: 'background'
        })
        break
      }
      case 'pressKey': {
        if (typeof params.holdSeconds === 'number' && params.holdSeconds > 0) {
          throw new AppError(
            'action_not_supported',
            'cua-driver 不支持按住秒数（hold_seconds）；只支持点按。'
          )
        }
        const key = stringParam(params, 'key')
        const repeat = typeof params.repeat === 'number' && params.repeat > 0 ? Math.floor(params.repeat) : 1
        structured = await this.callRepeated('press_key', {
          key,
          target: windowTarget(resolvedApp.pid, windowId),
          delivery_mode: 'background'
        }, repeat)
        break
      }
      case 'hotkey': {
        const keys = parseHotkeyKeys(stringParam(params, 'key'))
        const repeat = typeof params.repeat === 'number' && params.repeat > 0 ? Math.floor(params.repeat) : 1
        structured = await this.callRepeated('hotkey', {
          keys,
          target: windowTarget(resolvedApp.pid, windowId),
          delivery_mode: 'background'
        }, repeat)
        break
      }
      case 'pasteText': {
        const format = params.format
        if (format !== undefined && format !== 'plain' && format !== 'text') {
          throw new AppError(
            'action_not_supported',
            `cua-driver 剪贴板只支持纯文本粘贴（收到 format: ${String(format)}）。`
          )
        }
        const text = stringParam(params, 'text')
        await this.callActionTool('clipboard_write', { text })
        structured = await this.callActionTool('hotkey', {
          keys: ['cmd', 'v'],
          target: windowTarget(resolvedApp.pid, windowId),
          delivery_mode: 'background'
        })
        // 防重放硬要求（todo WP4）：组合路径永远不是 verified。
        verificationOverride = { state: 'unverified', reason: 'clipboard_paste' }
        pathOverride = 'clipboard'
        break
      }
      case 'setValue': {
        const element = this.snapshotStore.requireToken(resolvedApp.pid, windowId, requireIndex(params, 'elementIndex'))
        // 0.40 契约：set_value 只收 element_token/pid/value 等（无 delivery_mode /
        // target——AX 写值天然后台、不抢焦点）。
        structured = await this.callActionTool('set_value', {
          element_token: element.token,
          value: params.value
        })
        break
      }
    }

    const verification =
      verificationOverride ?? verificationFromDriverAction(structured)
    const action: ComputerActionMetadata = {
      path: pathOverride ?? cuaActionPath(structured.route),
      actionName,
      targetWindowId: windowId,
      targetWindowIndex: null,
      delivery,
      ...(verification ? { verification } : {}),
      ...(structured.escalation !== undefined && structured.escalation !== null
        ? { fallbackReason: JSON.stringify(structured.escalation) }
        : {})
    }

    // 动作可能改了窗口几何（zoom / 缩放）：补观察没有 window_bounds 时靠
    // list_windows 的 bounds 判断「尺寸是否变化」，2s 缓存会把动作前的旧尺寸喂给
    // 判断，导致沿用已作废的像素栅格。
    this.observer.invalidateWindowCache(resolvedApp.pid)

    // 动作后观测：全树（与原生 provider 一致——动作结果带新索引，模型可直接用；
    // 截图按需由下一次 get_app_state 拿）。动作可能已打开新窗口 / 替换窗口
    //（zoom 换 CGWindowID）：观测失败不得掩盖「动作可能已发出」语义（防重放
    // 硬要求）——降级为空观察快照，让模型重新 list_windows。
    let observation: ComputerSnapshotResult
    try {
      observation = await this.observer.observeWindowState(resolvedApp, windowId, {
        includeScreenshot: false,
        includeTree: true
      })
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'WINDOW_NOT_FOUND' || error.code === 'WINDOW_STALE')
      ) {
        observation = unobservedPostActionSnapshot(resolvedApp, windowId, error.message)
      } else {
        throw error
      }
    }
    return { ...observation, action }
  }

  private async dispatchClick(
    app: ResolvedCuaApp,
    windowId: number,
    params: Record<string, unknown>
  ): Promise<{ structured: CuaDriverActionStructured; actionName: string | null }> {
    if (params.modifiers !== undefined) {
      throw new AppError(
        'action_not_supported',
        '修饰键点击（modifiers）需要前台投递（cua-driver 语义），本期 provider 只支持后台投递。请改用 computer_key 发送组合键，或去掉 modifiers。'
      )
    }
    const mouseButton = params.mouseButton
    const clickCount = typeof params.clickCount === 'number' ? Math.round(params.clickCount) : 1
    const baseArgs = (): Record<string, unknown> => {
      const args: Record<string, unknown> = {
        delivery_mode: 'background'
      }
      if (params.elementIndex !== undefined) {
        const element = this.snapshotStore.requireToken(app.pid, windowId, requireIndex(params, 'elementIndex'))
        // 0.40 契约：element_token 自带 pid/window，不允许再带 pid/window_id。
        args.element_token = element.token
      } else {
        args.pid = app.pid
        args.window_id = windowId
        const geometry = this.requireGeometry(app.pid, windowId)
        const pixel = windowPointToScreenshotPixel(geometry, {
          x: typeof params.x === 'number' ? params.x : Number.NaN,
          y: typeof params.y === 'number' ? params.y : Number.NaN
        })
        args.x = pixel.x
        args.y = pixel.y
      }
      return args
    }
    if (mouseButton === 'right') {
      return {
        structured: await this.callActionTool('right_click', baseArgs()),
        actionName: 'right_click'
      }
    }
    if (clickCount > 1) {
      // cua 的 count 仅像素路径有效：多击统一走 double_click 工具（像素或元素均可）。
      return {
        structured: await this.callActionTool('double_click', baseArgs()),
        actionName: 'double_click'
      }
    }
    const args = baseArgs()
    if (mouseButton === 'middle') {
      args.button = 'middle'
    }
    return { structured: await this.callActionTool('click', args), actionName: null }
  }

  private async callActionTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CuaDriverActionStructured> {
    const result = await this.client.call(toolName, args)
    return result.structuredContent as CuaDriverActionStructured
  }

  private async callRepeated(
    toolName: string,
    args: Record<string, unknown>,
    repeat: number
  ): Promise<CuaDriverActionStructured> {
    let last: CuaDriverActionStructured = {}
    for (let index = 0; index < repeat; index += 1) {
      last = await this.callActionTool(toolName, args)
    }
    return last
  }

  private async resolveActionWindowId(app: ResolvedCuaApp, params: Record<string, unknown>): Promise<number> {
    if (params.windowId === undefined && params.windowIndex === undefined) {
      const current = this.snapshotStore.current(app.pid, undefined)
      if (current) {
        return current.windowId
      }
    }
    return await this.observer.resolveWindowId(app, params)
  }

  /** scroll 的目标点：elementIndex → 元素 frame 中心；x,y → 窗口点。 */
  private async resolveActionPoint(
    app: ResolvedCuaApp,
    windowId: number,
    params: Record<string, unknown>
  ): Promise<{ x: number; y: number }> {
    if (params.elementIndex !== undefined) {
      const geometry = this.requireGeometry(app.pid, windowId)
      const element = this.snapshotStore.requireToken(app.pid, windowId, requireIndex(params, 'elementIndex'))
      if (!element.frame) {
        throw new AppError(
          'action_not_supported',
          `元素 ${element.index} 没有 frame（不可定位），改用坐标或先重新观察。`
        )
      }
      return globalPointToScreenshotPixel(geometry, elementFrameCenter(element.frame))
    }
    const geometry = this.requireGeometry(app.pid, windowId)
    return windowPointToScreenshotPixel(geometry, {
      x: typeof params.x === 'number' ? params.x : Number.NaN,
      y: typeof params.y === 'number' ? params.y : Number.NaN
    })
  }

  private async resolveDragPoint(
    app: ResolvedCuaApp,
    windowId: number,
    params: Record<string, unknown>,
    side: 'from' | 'to',
    geometry: CuaDriverWindowGeometry
  ): Promise<{ x: number; y: number }> {
    const elementIndex = params[`${side}ElementIndex`]
    if (elementIndex !== undefined) {
      const element = this.snapshotStore.requireToken(app.pid, windowId, requireIndex(params, `${side}ElementIndex`))
      if (!element.frame) {
        throw new AppError(
          'action_not_supported',
          `元素 ${element.index} 没有 frame（不可定位），改用坐标或先重新观察。`
        )
      }
      return globalPointToScreenshotPixel(geometry, elementFrameCenter(element.frame))
    }
    return windowPointToScreenshotPixel(geometry, {
      x: typeof params[`${side}X`] === 'number' ? (params[`${side}X`] as number) : Number.NaN,
      y: typeof params[`${side}Y`] === 'number' ? (params[`${side}Y`] as number) : Number.NaN
    })
  }

  /** 像素寻址前提：最近一次带截图的观察（findings Q4——坐标是截图像素空间）。 */
  private requireGeometry(pid: number, windowId: number): CuaDriverWindowGeometry {
    const entry = this.snapshotStore.current(pid, windowId)
    if (!entry || entry.geometry.screenshotWidth <= 0) {
      // 截图请求过但失败（如 macOS 26+ 二段同意未完成）：报错必须带失败原因，
      // 否则模型在「先 get_app_state → 拿不到截图 → 再 scroll → 再被挡」里死循环。
      // 失败原因存 store 级（不带截图的观察不覆盖它），见 CuaDriverSnapshotStore。
      const failure = this.snapshotStore.screenshotFailure(pid, windowId)
      throw new AppError(
        'invalid_argument',
        failure
          ? `坐标寻址不可用：最近一次窗口截屏没有拿到。${failure}`
          : '坐标寻址需要先 computer_get_app_state（screenshot: true）拿一帧窗口截屏：坐标只取最近一帧截屏的窗口栅格。'
      )
    }
    return entry.geometry
  }
}

// --- driver 动作结果 → KepCup verification（findings Q5 映射表，不得简化为 verified） ----

export function verificationFromDriverAction(
  structured: CuaDriverActionStructured
): ComputerActionVerification | null {
  const effect = typeof structured.effect === 'string' ? structured.effect : null
  const route = typeof structured.route === 'string' ? structured.route : null
  const detail = evidenceDetail(structured.evidence)
  if (effect === 'confirmed') {
    if (hasEvidenceKind(structured.evidence, 'value_readback')) {
      return {
        state: 'verified',
        property: 'value',
        actualPreview: detail
      }
    }
    if (hasEvidenceKind(structured.evidence, 'window_change')) {
      return { state: 'unverified', reason: 'window_changed', actualPreview: detail }
    }
    return { state: 'unverified', reason: 'readback_unsupported', actualPreview: detail }
  }
  if (effect === 'partial') {
    return { state: 'unverified', reason: 'readback_unsupported', actualPreview: detail }
  }
  if (effect === 'suspected_noop') {
    return { state: 'unverified', reason: 'suspected_noop', actualPreview: detail }
  }
  if (effect === 'unverifiable') {
    if (route === 'accessibility') {
      return { state: 'unverified', reason: 'accessibility_action_unasserted', actualPreview: detail }
    }
    return { state: 'unverified', reason: 'synthetic_input', actualPreview: detail }
  }
  // refused 已在传输层转 AppError；未知 effect 一律按未确认处理。
  if (effect !== null && effect !== 'refused') {
    return { state: 'unverified', reason: 'readback_unsupported', actualPreview: detail }
  }
  return null
}

function cuaActionPath(route: unknown): ComputerActionMetadata['path'] {
  if (route === 'accessibility') {
    return 'accessibility'
  }
  return 'synthetic'
}

function hasEvidenceKind(evidence: unknown, kind: string): boolean {
  return evidenceDetailKind(evidence, kind)
}

function evidenceDetail(evidence: unknown): string | null {
  if (!Array.isArray(evidence)) {
    return null
  }
  for (const item of evidence) {
    if (typeof item === 'object' && item !== null) {
      const detail = (item as { detail?: unknown }).detail
      if (typeof detail === 'string' && detail.trim().length > 0) {
        return detail
      }
    }
  }
  return null
}

function evidenceDetailKind(evidence: unknown, kind: string): boolean {
  if (!Array.isArray(evidence)) {
    return false
  }
  return evidence.some(
    (item) => typeof item === 'object' && item !== null && (item as { kind?: unknown }).kind === kind
  )
}

// --- 小工具 -----------------------------------------------------------------

/** AX 次级动作名 → cua click action（press/show_menu/pick/confirm/cancel/open）。 */
export function normalizeCuaClickAction(action: string): string | null {
  const normalized = action.trim().toLowerCase().replace(/[\s_]+/g, '')
  switch (normalized) {
    case 'press':
    case 'axpress':
      return 'press'
    case 'showmenu':
    case 'axshowmenu':
      return 'show_menu'
    case 'pick':
    case 'axpick':
      return 'pick'
    case 'confirm':
    case 'axconfirm':
      return 'confirm'
    case 'cancel':
    case 'axcancel':
      return 'cancel'
    case 'open':
    case 'axopen':
      return 'open'
    default:
      return null
  }
}

/** KepCup 的 "cmd+a" 弦 → cua keys 数组（修饰键在前、非修饰键一个）。 */
export function parseHotkeyKeys(chord: string): string[] {
  return chord
    .split('+')
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
}

function windowTarget(pid: number, windowId: number): Record<string, unknown> {
  return { kind: 'window', pid, window_id: windowId }
}

/** 动作后观测不可用时的空观察快照（动作本身可能已生效，见防重放语义）。 */
function unobservedPostActionSnapshot(
  app: ResolvedCuaApp,
  windowId: number,
  reason: string
): ComputerActionResult {
  return {
    snapshot: {
      id: `post-action-unobserved-${Date.now()}`,
      app: { name: app.name, bundleId: app.bundleId, pid: app.pid },
      window: {
        id: windowId,
        index: null,
        title: '',
        x: null,
        y: null,
        width: 0,
        height: 0,
        isMinimized: null,
        isOffscreen: null,
        screenIndex: null
      },
      coordinateSpace: 'window',
      treeText: '',
      elementCount: 0,
      focusedElementId: null
    },
    screenshot: null,
    screenshotStatus: {
      state: 'failed',
      code: 'window_not_found',
      message: reason
    }
  }
}

function requireIndex(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AppError('invalid_argument', `${key} must be a non-negative integer`)
  }
  return value
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('invalid_argument', `Missing ${key}`)
  }
  return value
}
