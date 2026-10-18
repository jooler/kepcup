import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { core } from '$lib/rpc/client.svelte';
import { setupWindowControlsOverlay } from '$lib/features/shell/window-controls-overlay';

// macOS 毛玻璃（app.css「vibrancy」块）：主进程对 darwin 窗口开了 vibrancy，
// 渲染层据此把 html/body 透明、侧栏改半透明。必须在 mount 前打标，首帧即生效。
if (/Mac/i.test(navigator.platform)) {
  document.documentElement.classList.add('platform-mac');
}

// Windows 亚克力毛玻璃（app.css「acrylic」块）：主进程对 Win11 22H2+ 窗口开了
// backgroundMaterial（注释见 main/window.ts），材质标记经 additionalArguments →
// preload 同步传来，据此把 html/body 透明、侧栏改半透明。必须在 mount 前打标，
// 首帧即生效；系统「透明效果」关闭时由 prefers-reduced-transparency 自动回退。
if (window.kepcup.windowMaterial === 'acrylic') {
  document.documentElement.classList.add('platform-win-acrylic');
}

// Windows / Linux 原生 caption 三键（titleBarOverlay，window-controls-overlay.ts）：
// 同样在 mount 前发布几何（--wco-inset-end / html.wco），首帧顶栏就让位。
setupWindowControlsOverlay();

// e2e seam (dead-code-eliminated from packaged builds, like the dev status bar): lets a spec
// drive core RPC from the page, e.g. to register a fake MCP server without clicking through settings.
if (__KEPCUP_TEST_HOOKS__) {
  (
    window as unknown as { __kepcupRpc: (method: string, input?: unknown) => Promise<unknown> }
  ).__kepcupRpc = (method, input) => core.call(method, input);
}

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
