/**
 * UI 视觉参数集中配置：把散在各组件里需要手调的视觉常量收敛到这一个文件，
 * 改这里即可全站生效，后续其它参数（间距、头像尺寸、行距等）按同样方式
 * 逐组迁入。数值一律用 px，便于直接对照设计稿调节。
 */

/**
 * 消息气泡的度量（单聊 / 项目组 / Bot 间交换会话三处视图共用，见 MessageBody）。
 * 常规圆角不单独配置——由行高与上下内边距自动推导（见 messageBubbleStyle）。
 */
export type MessageBubbleMetrics = {
  /** 连排（相邻同发送者）时对齐侧缩小的圆角（px）。 */
  radiusMerged: number;
  /** 左右内边距（px）。 */
  paddingX: number;
  /** 上下内边距（px）。 */
  paddingY: number;
  /** 正文字号（px）。 */
  fontSize: number;
  /** 正文行高（px）。 */
  lineHeight: number;
};

export const uiConfig = {
  /** 消息气泡（chats/MessageBody 渲染；extension-center/ImCard 的入站气泡同形）。 */
  messageBubble: {
    /** 用户气泡（含交换会话发起方按用户形态渲染的气泡）。 */
    user: {
      radiusMerged: 6,
      paddingX: 12,
      paddingY: 8,
      fontSize: 14,
      lineHeight: 21,
    } satisfies MessageBubbleMetrics,
    /** Bot 气泡。 */
    bot: {
      radiusMerged: 6,
      paddingX: 12,
      paddingY: 8,
      fontSize: 14,
      lineHeight: 21,
    } satisfies MessageBubbleMetrics,
  },
} as const;

/**
 * 气泡的内联样式串：padding / 字号 / 行高直接取配置；常规圆角自动推导——
 * 单行气泡高度（行高 + 上下内边距 ×2）的一半，单行时成药丸形，调行高或
 * padding 时圆角自动跟随。圆角按连排状态收对齐侧两角（align 是气泡的
 * 对齐侧——用户气泡 right、Bot 气泡 left；上相邻同发送者收上角、下相邻
 * 收下角），同方连发在对齐侧看上去是一整块。
 */
export function messageBubbleStyle(
  metrics: MessageBubbleMetrics,
  merge: { above: boolean; below: boolean },
  align: 'left' | 'right',
): string {
  const radius = (metrics.lineHeight + metrics.paddingY * 2) / 2;
  const radiusMerged = metrics.radiusMerged;
  // border-radius 四角顺序：左上 右上 右下 左下。
  const topLeft = align === 'left' && merge.above ? radiusMerged : radius;
  const topRight = align === 'right' && merge.above ? radiusMerged : radius;
  const bottomRight = align === 'right' && merge.below ? radiusMerged : radius;
  const bottomLeft = align === 'left' && merge.below ? radiusMerged : radius;
  return [
    `border-radius: ${topLeft}px ${topRight}px ${bottomRight}px ${bottomLeft}px`,
    `padding: ${metrics.paddingY}px ${metrics.paddingX}px`,
    `font-size: ${metrics.fontSize}px`,
    `line-height: ${metrics.lineHeight}px`,
  ].join('; ');
}
