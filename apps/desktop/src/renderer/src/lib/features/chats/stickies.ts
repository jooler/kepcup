import type { Stickie, StickiePosition } from '@kepcup/shared';

export type { Stickie, StickiePosition, StickieScope } from '@kepcup/shared';

/** 卡片定宽（w-72），高度随内容（内部滚动）；坐标夹取共用这两个常量。 */
export const STICKIE_WIDTH = 288;
export const STICKIE_MARGIN = 12;

export function isStickieVisible(stickie: Stickie, conversationId: string): boolean {
  return stickie.scope === 'global' || stickie.conversationId === conversationId;
}

/**
 * 把左上角限制在容器内。容器小于卡片时退到 margin（卡片可能被裁剪，
 * 但拖拽手柄永远在可视范围内，可以拉回来）。
 */
export function clampStickiePosition(
  position: StickiePosition,
  containerWidth: number,
  containerHeight: number,
  cardHeight = 96,
): StickiePosition {
  const maxX = Math.max(STICKIE_MARGIN, containerWidth - STICKIE_WIDTH - STICKIE_MARGIN);
  const maxY = Math.max(STICKIE_MARGIN, containerHeight - cardHeight - STICKIE_MARGIN);
  return {
    x: Math.min(Math.max(position.x, STICKIE_MARGIN), maxX),
    y: Math.min(Math.max(position.y, STICKIE_MARGIN), maxY),
  };
}

/** 默认落点：右上角（避开左缘的 Bot 气泡），按已有卡片数级联错开。 */
export function defaultStickiePosition(
  containerWidth: number,
  containerHeight: number,
  slot: number,
): StickiePosition {
  const offset = (slot % 6) * 28;
  return clampStickiePosition(
    { x: containerWidth - STICKIE_WIDTH - 24, y: 64 + offset },
    containerWidth,
    containerHeight,
  );
}
