import { defineConfig } from '@playwright/test';

/**
 * web（PWA）冒烟（D96 WP5，design 46 §8）：对 `build:web` 产物起 `vite preview`
 * （webServer 钩子），chromium headless 跑纯前端断言——配对门渲染、假配对链接的
 * 状态推进。不真连中转（真实三端链路在 WP6 联调）。
 *
 * 与 Electron e2e 的 playwright.config.ts 完全独立：-c 显式指定，testDir 不同，
 * 互不影响。
 */
export default defineConfig({
  testDir: './test/web',
  timeout: 60_000,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    // --host 定指 127.0.0.1：vite preview 默认绑 localhost（本机解析成 ::1），
    // 与这里的 baseURL/探活 URL 保持同栈。
    command:
      'pnpm exec vite preview -c vite.config.web.ts --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
