import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { core } from '$lib/rpc/client.svelte';

// macOS 毛玻璃（app.css「vibrancy」块）：主进程对 darwin 窗口开了 vibrancy，
// 渲染层据此把 html/body 透明、侧栏改半透明。必须在 mount 前打标，首帧即生效。
if (/Mac/i.test(navigator.platform)) {
  document.documentElement.classList.add('platform-mac');
}

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
