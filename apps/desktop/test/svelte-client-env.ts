import type { Environment } from 'vitest/runtime';

/**
 * 没有 DOM 的「客户端」测试环境：只为让 vite-plugin-svelte 按**客户端**编译 `.svelte.ts`
 * （vitest 的 node 环境走 SSR 变换，会生成 `svelte/internal/server` 的空实现，`$effect` 不会跑）。
 * 用于 `desktop-svelte` 项目里的 `*.svelte.test.ts`（`$effect.root` + `flushSync`）。
 */
export default {
  name: 'svelte-client',
  viteEnvironment: 'client',
  setup() {
    return { teardown() {} };
  },
} satisfies Environment;
