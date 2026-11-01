/**
 * 左栏条目选中态底色（Tailwind 原子类）：展开态、图标态各一套，全左栏共用。
 *
 * 为什么不用 `bg-sidebar-accent`：它与 hover 共用，选中态对比不够。亮色侧栏底色
 * 是 0.985，条目压到 0.925；暗色侧栏在 macOS 上是半透明毛玻璃，提亮会和透出的
 * 底叠在一起，所以行压到 0.25，图标块再暗一档压到 0.16（侧栏底色 0.205）。
 *
 * 工作台入口、对话条目（Bot）、设置项原来是各自内联的字面量，工作台展开态一度
 * 写成 0.98 / 0.5——亮色几乎等于侧栏底色看不出高亮，暗色又明显过亮。集中到这里
 * 后，同一种形态的条目只能取同一套 token（见 sidebar-active-class.test.ts）。
 */

/** 展开态条目（工作台入口、对话行）的选中底色。 */
export const SIDEBAR_ROW_ACTIVE_CLASS =
  'data-active:bg-[oklch(0.925_0_0)] dark:data-active:bg-[oklch(0.25_0_0)]';

/** 图标（折叠）态条目的选中底色。 */
export const SIDEBAR_ICON_ACTIVE_CLASS =
  'data-active:bg-[oklch(0.93_0_0)] dark:data-active:bg-[oklch(0.16_0_0)]';
