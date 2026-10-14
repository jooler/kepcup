/**
 * Composer 单行 / 多行（沉底）布局滞回。
 *
 * 直接用 scrollHeight 切布局会振荡：换行 → 输入区变满宽 → 同行按钮下沉 →
 * 可用宽度变大 → 又装得下单行 → 切回 → 再换行……
 *
 * 策略：一旦判定换行，记下当时的内容长度作 latch；在长度回落到 latch 之下
 * （或清空）之前保持多行。窗口 / 输入坞宽度变化时丢弃 latch，按当前 wraps
 * 重新标定（宽度取药丸外壳，不随单行↔沉底切换而变）。
 */

/** 单行编辑区高度上限（px）：与 TipTap min-h-10 + 内边距目测阈值一致。 */
export const COMPOSER_SINGLE_LINE_MAX_PX = 48;

export type MultilineLayoutState = {
  multiline: boolean;
  /** 进入多行时的内容长度；单行时为 null。 */
  latchLength: number | null;
};

export function nextMultilineLayoutState(input: {
  contentLength: number;
  /** 当前布局下 scrollHeight 是否超过单行上限。 */
  wraps: boolean;
  latchLength: number | null;
  /** 输入坞宽度变了：丢弃 latch，按 wraps 重标定。 */
  widthChanged: boolean;
}): MultilineLayoutState {
  const { contentLength, wraps, widthChanged } = input;
  let latchLength = input.latchLength;

  if (contentLength <= 0) {
    return { multiline: false, latchLength: null };
  }

  if (widthChanged) {
    latchLength = null;
  }

  // 滞回：已锁定则内容未短于 latch 时保持多行，避免满宽测量把布局拉回去。
  if (latchLength !== null && contentLength >= latchLength) {
    return { multiline: true, latchLength };
  }

  // 短于 latch（或无 latch）：按当前 wraps 重新决定，并在换行时记下新 latch。
  if (wraps) {
    return { multiline: true, latchLength: contentLength };
  }
  return { multiline: false, latchLength: null };
}
