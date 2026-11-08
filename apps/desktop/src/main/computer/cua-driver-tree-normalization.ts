import type { CuaDriverWindowGeometry } from './cua-driver-coordinates'
import type { CuaDriverElementRecord } from './cua-driver-snapshot-store'

// cua-driver 树文本整形与元素记录解析（P-B1，WP3）。
//
// driver 的 tree_markdown 是 `- [N] AXRole …`（缩进 2 空格一层，无索引的行描述
// 不可定位子元素）。KepCup 的树文本契约（computer-use-tree-text.ts ELEMENT_LINE）
// 是「tab 缩进 + 行首数字」，sidecar 的 ComputerTreeBaselines 增量 diff 依赖它，
// 工具描述也承诺「元素索引在行首数字」。这里做纯文本整形（不改任何语义）：
// `- [N] rest` → `\t…N rest`；无索引行原样保留（解析器把它们挂在上一元素名下）。

const CUA_INDEXED_LINE = /^(\s*)- \[(\d+)\] ?(.*)$/u

export function normalizeCuaTreeText(markdown: string): string {
  if (markdown.length === 0) {
    return ''
  }
  const lines = markdown.split('\n')
  const normalized: string[] = []
  let sawIndexedLine = false
  for (const line of lines) {
    const match = CUA_INDEXED_LINE.exec(line)
    if (match) {
      sawIndexedLine = true
      const depth = Math.floor(match[1]!.length / 2)
      normalized.push(`${'\t'.repeat(depth)}${match[2]} ${match[3]}`.trimEnd())
    } else {
      normalized.push(line)
    }
  }
  // 整形失败（上游换了渲染格式）时原样返回：core 只当不透明文本，索引仍可读。
  return sawIndexedLine ? normalized.join('\n') : markdown
}

type CuaStructuredElement = {
  element_index?: unknown
  element_token?: unknown
  role?: unknown
  label?: unknown
  frame?: unknown
  actions?: unknown
}

/**
 * structuredContent.elements → index→record 表（索引直通的另一半：动作按模型的
 * element_index 查表换 driver 的 element_token，findings Q3）。
 */
export function parseCuaElementRecords(
  structured: Record<string, unknown>
): Map<number, CuaDriverElementRecord> {
  const records = new Map<number, CuaDriverElementRecord>()
  const elements = structured.elements
  if (!Array.isArray(elements)) {
    return records
  }
  for (const raw of elements as CuaStructuredElement[]) {
    const index = raw.element_index
    const token = raw.element_token
    const role = raw.role
    if (typeof index !== 'number' || typeof token !== 'string' || typeof role !== 'string') {
      continue
    }
    records.set(index, {
      index,
      token,
      role,
      label: typeof raw.label === 'string' ? raw.label : null,
      frame: parseCuaFrame(raw.frame),
      actions: Array.isArray(raw.actions) ? raw.actions.filter((a): a is string => typeof a === 'string') : []
    })
  }
  return records
}

function parseCuaFrame(value: unknown): { x: number; y: number; w: number; h: number } | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const frame = value as Record<string, unknown>
  if (
    typeof frame.x !== 'number' ||
    typeof frame.y !== 'number' ||
    typeof frame.w !== 'number' ||
    typeof frame.h !== 'number'
  ) {
    return null
  }
  return { x: frame.x, y: frame.y, w: frame.w, h: frame.h }
}

/** get_window_state 输出的尺寸字段 → 坐标换算几何（bounds 缺失时宽度回退 0 → ratio 走 scale）。 */
export function cuaDriverSnapshotGeometry(input: {
  windowBounds: { x: number; y: number; width: number; height: number }
  screenshotWidth: number
  screenshotHeight: number
  screenshotScale: number
}): CuaDriverWindowGeometry {
  return {
    boundsX: input.windowBounds.x,
    boundsY: input.windowBounds.y,
    boundsWidth: input.windowBounds.width,
    boundsHeight: input.windowBounds.height,
    screenshotWidth: input.screenshotWidth,
    screenshotHeight: input.screenshotHeight,
    screenshotScale: input.screenshotScale > 0 ? input.screenshotScale : 1
  }
}
