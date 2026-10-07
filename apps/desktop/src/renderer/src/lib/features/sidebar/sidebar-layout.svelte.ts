import {
  clampSidebarWidth,
  isSidebarCollapsed,
  loadSidebarWidth,
  saveSidebarWidth,
  settleSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
} from './sidebar-layout';

/**
 * 左栏宽度布局状态（响应式状态必须在 .svelte.ts 中，$state 才会被编译）：
 * 右缘拖拽手柄调宽（pointer capture 逐帧跟手），释放低于吸附阈值收成
 * 图标模式（最小宽 = macOS 红绿灯占位），宽度落 localStorage。
 */
class SidebarLayoutState {
  width = $state(loadSidebarWidth(globalThis.localStorage ?? null));
  /** 拖拽进行中：宽度不加过渡动画（逐帧跟手）。 */
  dragging = $state(false);

  /** 最小宽即图标模式。 */
  collapsed = $derived(isSidebarCollapsed(this.width));

  /** 注入 Sidebar.Provider 的 wrapper 变量（覆盖套件默认值，全树继承）。 */
  widthStyle = $derived(`--sidebar-width: ${this.width}px;`);

  /** 拖拽中不加过渡（跟手）；松手吸附与双击复位才有平滑动画。 */
  transitionClass = $derived(this.dragging ? '' : 'transition-[width] duration-200 ease-linear');

  setWidth(width: number): void {
    this.width = clampSidebarWidth(width);
    saveSidebarWidth(globalThis.localStorage ?? null, this.width);
  }

  /** 双击手柄复位默认宽。 */
  resetWidth(): void {
    this.setWidth(SIDEBAR_DEFAULT_WIDTH);
  }

  /**
   * 右缘手柄按下：pointer capture 持续跟手调宽。clientX 以窗口内容左缘为
   * 零点（侧栏贴左），减去 wrapper 偏移兜底未来布局变化。
   */
  startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    this.dragging = true;
    // capture 后事件固定回手柄，但光标/选区仍按命中元素走，全局接管更稳。
    const body = document.body;
    const prevCursor = body.style.cursor;
    const prevUserSelect = body.style.userSelect;
    body.style.cursor = 'col-resize';
    body.style.userSelect = 'none';
    const originLeft =
      document.querySelector('[data-slot="sidebar-wrapper"]')?.getBoundingClientRect().left ?? 0;

    const onMove = (move: PointerEvent): void => {
      this.width = clampSidebarWidth(move.clientX - originLeft);
    };
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      // 先落吸附宽、再复位 dragging：复位后 width 过渡类恢复，吸附有动画。
      this.width = settleSidebarWidth(this.width);
      this.dragging = false;
      body.style.cursor = prevCursor;
      body.style.userSelect = prevUserSelect;
      saveSidebarWidth(globalThis.localStorage ?? null, this.width);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }
}

export const sidebarLayout = new SidebarLayoutState();
