/**
 * 选中文本浮动工具栏的定位计算（纯函数）：水平居中于选区、默认出现在
 * 选区上方，贴顶时翻到下方，整体夹在视口内（四周留 8px）。
 */
export interface SelectionRectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function placeSelectionToolbar(
  selection: SelectionRectLike,
  viewportWidth: number,
  viewportHeight: number,
  toolbarWidth: number,
  toolbarHeight: number,
): { x: number; y: number } {
  const x = Math.min(
    Math.max((selection.left + selection.right) / 2 - toolbarWidth / 2, 8),
    Math.max(8, viewportWidth - toolbarWidth - 8),
  );
  const maxY = Math.max(8, viewportHeight - toolbarHeight - 8);
  const above = selection.top - toolbarHeight - 6;
  const y = above >= 8 ? above : selection.bottom + 6;
  return { x, y: Math.min(Math.max(y, 8), maxY) };
}
