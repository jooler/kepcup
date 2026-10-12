/**
 * Esc 层级仲裁（窄屏全屏层 / 覆盖层 / 弹出层共用）：一次 Esc 只关最顶层。
 *
 * 为什么需要：窄屏的 Bot 详情覆盖层、设置全屏页、搜索层、「+」面板……都是自绘的
 * fixed 层，不像宽屏弹框由 bits-ui 的 escape-layer 统一仲裁。过去各处在 window
 * 上各挂一个 keydown：同一个 window 目标上的多个监听器互相拦不住（stopPropagation
 * 只挡冒泡、挡不住同目标的其余监听器），于是「设置页开在 Bot 覆盖层之上」时一次 Esc
 * 关两层；行内编辑框、头像选择器等内部控件处理了 Esc 外层也不知道。
 *
 * 约定：
 * - 全局只有一个 window keydown 监听（冒泡阶段，晚于控件自身的 onkeydown 与 bits-ui
 *   挂在 document 上的 escape-layer；bits-ui 响应 Esc 时会 preventDefault）。
 * - 事件已被 preventDefault（内部控件或 bits-ui 弹层已处理）→ 仲裁器不再处理。
 *   内部控件消费 Esc 的唯一契约就是 `event.preventDefault()`。
 * - 层打开时 `register`、关闭时注销；优先级对齐视觉叠放（z-index），同级后注册者在上。
 *   只让最顶层处理一次并 preventDefault；层处理器返回 false 表示「不是我的」，
 *   继续让下一层处理。
 */

/** 层优先级：数值大者在上，对齐各层的 z-index 档位。 */
export const ESCAPE_PRIORITY = {
  /** 输入区内联状态（录音中）：在所有覆盖层 / 全屏页之下——任何层开着时 Esc 先关那一层。 */
  inline: 30,
  /** Bot 详情覆盖层（z-40）。 */
  overlay: 40,
  /** 局部弹出层（头像选择器、宽屏的右键菜单 / 「+」面板）：压在覆盖层之内、全屏页之下。 */
  popover: 45,
  /** 全屏页（设置页 / 搜索层 / 窄屏「开始对话」层，z-50）。 */
  page: 50,
  /** 媒体灯箱（z-50，Portal 到 body 末尾，视觉上压过一切自绘层）：Esc 先关灯箱。 */
  lightbox: 60,
} as const;

export interface EscapeLayer {
  priority: number;
  /**
   * 处理 Esc。返回 false = 本层不处理（交给下一层）；其余（含 undefined）= 已处理。
   * 无需自己 preventDefault，仲裁器统一做。
   */
  onEscape: (event: KeyboardEvent) => boolean | void;
}

/** 仲裁器用到的事件最小面（单测用替身）。 */
export type EscapeEventLike = Pick<
  KeyboardEvent,
  'key' | 'defaultPrevented' | 'isComposing' | 'repeat' | 'preventDefault'
>;

interface Entry {
  layer: EscapeLayer;
  order: number;
}

export class EscapeLayerStack {
  #entries: Entry[] = [];
  #seq = 0;

  get size(): number {
    return this.#entries.length;
  }

  /** 注册一层，返回注销函数（幂等）。 */
  register(layer: EscapeLayer): () => void {
    const entry: Entry = { layer, order: (this.#seq += 1) };
    this.#entries.push(entry);
    return () => {
      const index = this.#entries.indexOf(entry);
      if (index >= 0) this.#entries.splice(index, 1);
    };
  }

  /** 从上到下遍历：优先级高者先，同级后注册者先。 */
  #topDown(): Entry[] {
    return [...this.#entries].sort(
      (a, b) => b.layer.priority - a.layer.priority || b.order - a.order,
    );
  }

  /**
   * 派发一次 keydown。返回是否被某一层消费（已 preventDefault）。
   * 已被 preventDefault / 输入法合成 / 长按重复的 Esc 一律不处理。
   */
  dispatch(event: EscapeEventLike): boolean {
    if (event.key !== 'Escape') return false;
    if (event.defaultPrevented || event.isComposing || event.repeat) return false;
    for (const { layer } of this.#topDown()) {
      if (layer.onEscape(event as KeyboardEvent) === false) continue;
      event.preventDefault();
      return true;
    }
    return false;
  }
}

/** 应用级单例。 */
export const escapeLayers = new EscapeLayerStack();

let listenerInstalled = false;

/**
 * 注册一层并确保全局监听已安装（首次注册时挂到 window）。用法（组件内）：
 *
 *   $effect(() => {
 *     if (!open) return;
 *     return registerEscapeLayer({ priority: ESCAPE_PRIORITY.page, onEscape: () => close() });
 *   });
 */
export function registerEscapeLayer(layer: EscapeLayer): () => void {
  if (!listenerInstalled && typeof window !== 'undefined') {
    listenerInstalled = true;
    window.addEventListener('keydown', (event) => {
      escapeLayers.dispatch(event);
    });
  }
  return escapeLayers.register(layer);
}

/** 事件目标是否为可输入控件（input / textarea / select / contenteditable）。 */
export function isEditableTarget(target: EventTarget | null): target is HTMLElement {
  if (target === null || typeof (target as HTMLElement).tagName !== 'string') return false;
  const element = target as HTMLElement;
  const tag = element.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true
  );
}

/**
 * 全屏层的统一前置处理：Esc 落在输入控件里时先让控件失焦（「先退出输入，再退出页面」），
 * 避免一次 Esc 丢掉正在编辑的内容。返回 true = 已消费。
 */
export function blurEditableTarget(event: Pick<KeyboardEvent, 'target'>): boolean {
  if (!isEditableTarget(event.target)) return false;
  event.target.blur();
  return true;
}
