import { installWebShim } from '$lib/features/web-shell/web-shim';

/**
 * web 构建入口（D96 WP5）：与 Electron 共用同一份 renderer（main.ts / App.svelte），
 * 区别只有前置的 `window.kepcup` 垫片与 PWA 壳（SW 注册 / 安装引导）。
 *
 * 顺序是这里的关键：静态 import 会被提升到本文件任何语句之前执行，而垫片必须
 * 先于任何 renderer 模块打标（endpoint.ts 等在模块加载期就读 `window.kepcup`）。
 * 因此本文件除 web-shim（纯函数模块，自身不读 window.kepcup）外，一律动态 import。
 */

installWebShim(__KEPCUP_WEB_VERSION__);

// lang 标注跟随运行时 locale（审查修复：静态 html 固定 zh-CN 会误导 en-US 用户的
// 辅助技术；i18n 初始化前先用浏览器语言兜底）。
document.documentElement.lang = navigator.language.startsWith('zh') ? 'zh-CN' : 'en-US';

// Service Worker：P0 只做静态壳缓存（sw.js），失败静默——PWA 是增强而非前提。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// 安装引导：捕获 beforeinstallprompt（浏览器在用户可安装时发一次），转交给
// Gate 出「添加到主屏幕」按钮。事件可能在模块加载前到达，先暂存再冲账。
let queuedInstallEvent: Event | null = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  queuedInstallEvent = event;
});

void Promise.all([import('./main'), import('$lib/features/web-shell/gate.svelte')]).then(
  ([, gate]) => {
    if (queuedInstallEvent !== null) gate.webGate.captureInstallPrompt(queuedInstallEvent);
    window.addEventListener('appinstalled', () => gate.webGate.markInstalled());
  },
);
