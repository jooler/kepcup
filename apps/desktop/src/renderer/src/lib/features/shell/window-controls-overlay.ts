/**
 * Windows 原生 caption 三键（main/window.ts 的 titleBarOverlay，即 Window
 * Controls Overlay）让位的几何发布：
 *
 * 三键是 Chromium 绘制的非 DOM 控件，永远压在窗口右上角（常规态顶条高约
 * 32px、条宽随系统缩放变化），落在这一区域的网页内容收不到点击——顶栏 /
 * 浮层右上角的按钮若伸进去会被盖住、点不到。
 *
 * Chromium 经 WCO API 暴露「仍可交互」的标题区矩形（getTitlebarAreaRect）。
 * 本模块把「右端被三键占掉的宽度」写进 :root 的 --wco-inset-end，并给 html
 * 打 wco 标；app.css 的「wco-inset-end」块只在 html.wco 时把该变量变成
 * padding-inline-end——个别顶栏挂上 .wco-inset-end 类即让位，非 Windows /
 * 未启用 overlay（mac / linux / e2e 浏览器环境）时类是死规则，元素无感。
 *
 * 不需要渲染层管字形颜色：主进程随 nativeTheme 同步（main/index.ts）。
 */
export function setupWindowControlsOverlay(): void {
  // Electron 类型尚未（或永远不）收录该 API 的版本兼容写法；jsdom / 浏览器里为 undefined。
  const overlay = (
    navigator as Navigator & {
      windowControlsOverlay?: {
        /** entering/leaving fullscreen 等形态时为 false（三键被隐藏）。 */
        readonly visible: boolean;
        getTitlebarAreaRect(): DOMRect;
        /** 缩放变化 / 最大化还原 / 全屏进出 / 窗口宽度变化都会触发。 */
        addEventListener(type: 'geometrychange', listener: () => void): void;
      };
    }
  ).windowControlsOverlay;
  if (!overlay?.visible) return;

  const root = document.documentElement;

  const sync = (): void => {
    if (!overlay.visible) {
      // 三键隐藏（全屏等）：撤掉让位，顶栏恢复原 padding。
      root.classList.remove('wco');
      return;
    }
    root.classList.add('wco');
    const rect = overlay.getTitlebarAreaRect();
    // 三键条贴着窗口右缘：被占宽度 = 窗宽 −（可交互区左缘 + 可交互区宽）。
    // 窗口拖大拖小条宽不变（等 geometrychange / resize 重算一次即可）。
    const insetEnd = Math.max(0, Math.round(window.innerWidth - rect.x - rect.width));
    root.style.setProperty('--wco-inset-end', `${insetEnd}px`);
  };

  sync();
  overlay.addEventListener('geometrychange', sync);
  window.addEventListener('resize', sync);
}
