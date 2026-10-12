/**
 * 窄屏布局状态（响应式状态必须在 .svelte.ts 中，$state 才会被编译）：窗口宽度断点、
 * 底部 tab、Bot 详情覆盖层。
 *
 * 宽度经 App.svelte 的 `<svelte:window bind:innerWidth>` 回填——resize 即时更新
 * （不使用 matchMedia：其 change 监听在部分环境拖拽窗口时不触发，导致切换
 * 滞后到刷新）。窄屏 / 宽屏是同一窗口的两种形态，不持久化；判定带滞回（640 进入、
 * 680 退出，见 nextNarrow），避免断点附近抖动导致整树反复重挂载。
 *
 * 切 tab 离开对话详情层时覆盖层一并收起；宽 / 窄切换时覆盖层状态由
 * shell.resetForLayoutChange 统一复位（宽屏的右栏开合归 shell.rightPanelCollapsed）。
 */
import { isNarrowWidth, nextNarrow, type NarrowTab } from './narrow-layout';

class NarrowLayoutState {
  #windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);
  /** 窗口处于窄屏模式（带滞回，见 nextNarrow）。 */
  narrow = $state(isNarrowWidth(typeof window !== 'undefined' ? window.innerWidth : 1280));
  /** 底部全局 tab（第一层导航）。 */
  tab = $state<NarrowTab>('chats');
  /** 会话详情顶部的 Bot 药丸打开的全屏覆盖层（右栏内容）。 */
  botDetailOpen = $state(false);

  /** 窗口内容宽（svelte:window bind:innerWidth 回填；写入同时按滞回更新 narrow）。 */
  get windowWidth(): number {
    return this.#windowWidth;
  }

  set windowWidth(width: number) {
    this.#windowWidth = width;
    const narrow = nextNarrow(this.narrow, width);
    if (narrow !== this.narrow) this.narrow = narrow;
  }

  selectTab(tab: NarrowTab): void {
    this.tab = tab;
    // 切 tab = 离开对话详情层，覆盖层随之收起。
    this.botDetailOpen = false;
  }

  openBotDetail(): void {
    this.botDetailOpen = true;
  }

  closeBotDetail(): void {
    this.botDetailOpen = false;
  }
}

export const narrowLayout = new NarrowLayoutState();
