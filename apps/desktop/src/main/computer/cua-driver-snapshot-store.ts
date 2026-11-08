import { AppError } from '@kepcup/shared'
import type { CuaDriverWindowGeometry } from './cua-driver-coordinates'

// cua-driver 快照索引表（P-B1，WP3「索引直通」的落地，findings Q3）。
//
// KepCup 契约（computer-tools.ts ADDRESS_RULE）：元素索引来自最近一次
// computer_get_app_state 的树文本；观察会重排索引，旧索引失效。cua-driver
// 0.34+ 的元素寻址只收 element_token（形如 "s00000001:0"，内嵌快照 id 与索引，
// driver 侧自行拒绝被新快照顶掉的 token）。所以适配器在每次**带树**的快照后
// 保存 (pid, window_id) → 最近快照的 {index → token/frame} 表；动作按模型的
// element_index 查表换成 token。表被同窗口下一次带树快照覆盖 = 旧索引失效；
// 查不到 → element_not_found（正好对应 ADDRESS_RULE 的声明语义，不需要维护
// 跨快照映射）。
//
// 仅截图的动作后观测（include_accessibility_tree:false）**不更新**本表：
// 没有新树就没有新索引，模型下一次动作仍按 ADDRESS_RULE 用最近一次带树快照。

export const MAX_CACHED_CUA_SNAPSHOTS = 32
export const MAX_CACHED_CUA_SNAPSHOT_AGE_MS = 2 * 60 * 1000

export type CuaDriverElementRecord = {
  index: number
  token: string
  role: string
  label: string | null
  /** 全局屏幕坐标 frame（driver structured elements 原样）。 */
  frame: { x: number; y: number; w: number; h: number } | null
  actions: string[]
}

export type CuaDriverSnapshotEntry = {
  pid: number
  windowId: number
  snapshotId: string
  appName: string
  bundleId: string | null
  windowTitle: string
  /** 窗口在屏幕上的原点与尺寸（全局点）。 */
  windowBounds: { x: number; y: number; width: number; height: number }
  geometry: CuaDriverWindowGeometry
  elements: Map<number, CuaDriverElementRecord>
  createdAtMs: number
}

export class CuaDriverSnapshotStore {
  private readonly entries = new Map<string, CuaDriverSnapshotEntry>()
  /**
   * 最近一次截图失败原因（带可行动指引），独立于 entries 存放：不带截图的观察
   * （noSnapshot / 动作后补观察）会覆盖 entry 但**不得**抹掉失败原因，否则
   * scroll/drag 的报错退化为通用提示，模型失去授权出口（2026-11-07 复检发现）。
   */
  private readonly screenshotFailures = new Map<string, { message: string; atMs: number }>()

  clear(): void {
    this.entries.clear()
    this.screenshotFailures.clear()
  }

  rememberScreenshotFailure(pid: number, windowId: number, message: string): void {
    this.screenshotFailures.set(storeKey(pid, windowId), { message, atMs: Date.now() })
  }

  /** 成功拿到截图即清除（几何可用后 requireGeometry 不再走到失败分支）。 */
  clearScreenshotFailure(pid: number, windowId: number): void {
    this.screenshotFailures.delete(storeKey(pid, windowId))
  }

  screenshotFailure(pid: number, windowId: number): string | null {
    return this.screenshotFailures.get(storeKey(pid, windowId))?.message ?? null
  }

  remember(entry: Omit<CuaDriverSnapshotEntry, 'createdAtMs'>): void {
    const key = storeKey(entry.pid, entry.windowId)
    this.entries.delete(key)
    this.entries.set(key, { ...entry, createdAtMs: Date.now() })
    this.prune()
  }

  /** 最近一次带树快照：显式 windowId 优先，其次该应用唯一在快照表里的窗口。 */
  current(pid: number, windowId: number | undefined): CuaDriverSnapshotEntry | null {
    this.prune()
    if (windowId !== undefined) {
      return this.entries.get(storeKey(pid, windowId)) ?? null
    }
    let found: CuaDriverSnapshotEntry | null = null
    for (const entry of this.entries.values()) {
      if (entry.pid === pid) {
        if (found !== null) {
          // 同 pid 多窗口且未指明 windowId：无法确定目标，拒绝猜测。
          return null
        }
        found = entry
      }
    }
    return found
  }

  /** 查 element_index → element_token；查不到按契约报 element_not_found。 */
  requireToken(
    pid: number,
    windowId: number | undefined,
    elementIndex: number
  ): CuaDriverElementRecord {
    const entry = this.current(pid, windowId)
    if (!entry) {
      throw new AppError(
        'ELEMENT_NOT_FOUND',
        `元素索引失效：还没有 ${pid} 的带元素索引快照。先 computer_get_app_state 拿新索引。`
      )
    }
    const element = entry.elements.get(elementIndex)
    if (!element) {
      throw new AppError(
        'ELEMENT_NOT_FOUND',
        `元素索引失效：快照 ${entry.snapshotId} 里没有索引 ${elementIndex}（观察会重排索引，旧索引失效）。重新 computer_get_app_state 拿新索引。`
      )
    }
    return element
  }

  private prune(): void {
    const cutoff = Date.now() - MAX_CACHED_CUA_SNAPSHOT_AGE_MS
    while (this.entries.size > MAX_CACHED_CUA_SNAPSHOTS) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.entries.delete(oldest)
    }
    for (const [key, entry] of this.entries) {
      if (entry.createdAtMs < cutoff) {
        this.entries.delete(key)
      }
    }
    for (const [key, failure] of this.screenshotFailures) {
      if (failure.atMs < cutoff) {
        this.screenshotFailures.delete(key)
      }
    }
  }
}

function storeKey(pid: number, windowId: number): string {
  return `${pid}:${windowId}`
}
