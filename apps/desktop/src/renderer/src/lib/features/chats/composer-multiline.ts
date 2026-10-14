/**
 * Composer 单行 / 多行（沉底）布局判定。
 *
 * 直接用 scrollHeight 切布局会振荡：换行 → 输入区变满宽 → 同行按钮下沉 →
 * 可用宽度变大 → 又装得下单行 → 切回 → 再换行……
 *
 * 策略：始终按**单行布局下**放不放得下来判定，与当前处在哪种布局无关。
 * - 单行布局：浏览器的换行（scrollHeight 超过单行上限）就是答案。
 * - 沉底布局：满宽下仍换行（含硬换行）→ 多行；否则比较内容的单行宽度（px）
 *   与单行布局下编辑区的可用宽度。已是多行时要比可用宽度再窄
 *   `COMPOSER_MULTILINE_EXIT_MARGIN_PX` 才回单行（滞回带，吸收光标与亚像素
 *   误差），回去后不会立刻又换行。
 *
 * 以前按内容**字符数**锁定：字形宽度不一（30 个汉字换行后换成 60 个窄 ASCII
 * 字符，一行放得下，但长度 ≥ 30，一直不回单行），所以改为按测得的宽度判定。
 * 可用宽度由组件从药丸外壳宽度推算，窗口变宽变窄时自然跟着变，无需丢弃锁定。
 */

/** 单行编辑区高度上限（px）：与 TipTap min-h-10 + 内边距目测阈值一致。 */
export const COMPOSER_SINGLE_LINE_MAX_PX = 48;

/** 从多行回单行时，内容宽度至少要比单行可用宽度窄这么多（px）。 */
export const COMPOSER_MULTILINE_EXIT_MARGIN_PX = 8;

export interface MultilineMeasurement {
  /** 当前是否多行（沉底）。 */
  multiline: boolean;
  /** 本次测量所在的布局：`stacked` = 输入占满整行（多行或有待发送附件）。 */
  layout: 'single' | 'stacked';
  /** 编辑器内容为空。 */
  empty: boolean;
  /** 当前布局下 scrollHeight 是否超过单行上限（含硬换行）。 */
  wraps: boolean;
  /** 内容排成一行所需宽度（px）；未换行时测得，换行时为 null。 */
  contentWidthPx: number | null;
  /** 单行布局下编辑区的可用宽度（px）；未知为 null。 */
  singleLineWidthPx: number | null;
}

/** 下一次的 multiline 值。纯函数：同样的测量得到同样的结果。 */
export function nextMultiline(m: MultilineMeasurement): boolean {
  if (m.empty) return false;
  // 当前布局下就换行：满宽都放不下或有硬换行，单行布局只会更放不下。
  if (m.wraps) return true;
  // 单行布局里没换行：放得下。
  if (m.layout === 'single') return false;
  // 沉底布局、满宽一行放得下：看单行布局的可用宽度。
  if (m.contentWidthPx === null || m.singleLineWidthPx === null) {
    // 宽度未知（还没在单行布局里测过）：回单行，组件在单行布局里再测一次。
    return false;
  }
  const limit = m.multiline
    ? m.singleLineWidthPx - COMPOSER_MULTILINE_EXIT_MARGIN_PX
    : m.singleLineWidthPx;
  return m.contentWidthPx > limit;
}
