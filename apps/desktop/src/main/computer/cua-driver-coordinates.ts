// cua-driver 坐标换算（P-B1，todo/computer-use-cua-adapter.md WP3，findings Q4）。
//
// KepCup 契约：动作坐标是**窗口点**（window points，窗口局部、点为单位，来自
// 最近一帧截屏的窗口栅格）。cua-driver 的 x,y 语义：「the PNG returned by
// get_window_state」的像素——driver 自己逆转 Retina backing scale 与任何窗口图
// 降尺度。
//
// 换算唯一公式：px = pt × (screenshot_width / window_bounds.width)。
// 满分辨率时 ratio === screenshot_scale（Retina 2x / 普通 1x），降尺度（
// max_dimension 或会话级 max_image_dimension 天花板）时 ratio 自动跟上 PNG 实际
// 尺寸——单测覆盖 scale=1 / 2 / 降尺度三情形（findings Q4 的无损映射判据）。
//
// 元素 frame（structured elements）是**全局屏幕坐标**；窗口局部 = frame −
// window_bounds.(x, y)。

export type CuaDriverWindowGeometry = {
  /** 窗口在屏幕上的原点（全局点）。 */
  boundsX: number
  boundsY: number
  boundsWidth: number
  boundsHeight: number
  /** 最近一帧窗口截图的像素尺寸。 */
  screenshotWidth: number
  screenshotHeight: number
  /** driver 报告的 backing scale（诊断对照用，不参与换算）。 */
  screenshotScale: number
}

/** 窗口点 → 截图像素（动作入口用）。 */
export function windowPointToScreenshotPixel(
  geometry: CuaDriverWindowGeometry,
  point: { x: number; y: number }
): { x: number; y: number } {
  const ratio = screenshotPixelRatio(geometry)
  return { x: point.x * ratio, y: point.y * ratio }
}

/** 截图像素 → 窗口点（出口不反向换算——KepCup 出口无坐标反馈，保留为对照工具）。 */
export function screenshotPixelToWindowPoint(
  geometry: CuaDriverWindowGeometry,
  pixel: { x: number; y: number }
): { x: number; y: number } {
  const ratio = screenshotPixelRatio(geometry)
  return { x: pixel.x / ratio, y: pixel.y / ratio }
}

/** 全局屏幕点 → 截图像素（元素 frame 中心寻址用）。 */
export function globalPointToScreenshotPixel(
  geometry: CuaDriverWindowGeometry,
  globalPoint: { x: number; y: number }
): { x: number; y: number } {
  return windowPointToScreenshotPixel(geometry, {
    x: globalPoint.x - geometry.boundsX,
    y: globalPoint.y - geometry.boundsY
  })
}

/**
 * 每点像素比：PNG 宽 / 窗口宽。PNG 尺寸不可信（frame 校验失败）时回退
 * screenshot_scale——此时 driver 不会接受像素寻址（px_frame_mismatch 拒绝），
 * 调用方应在拿到 failed 截图状态后避免像素路径。
 */
export function screenshotPixelRatio(geometry: CuaDriverWindowGeometry): number {
  if (
    Number.isFinite(geometry.boundsWidth) &&
    geometry.boundsWidth > 0 &&
    Number.isFinite(geometry.screenshotWidth) &&
    geometry.screenshotWidth > 0
  ) {
    return geometry.screenshotWidth / geometry.boundsWidth
  }
  return geometry.screenshotScale > 0 ? geometry.screenshotScale : 1
}

/** 元素 frame（全局点矩形）中心。 */
export function elementFrameCenter(frame: { x: number; y: number; w: number; h: number }): {
  x: number
  y: number
} {
  return { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 }
}
