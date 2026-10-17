import { defineConfig } from '@playwright/test';

// e2e seam：真实 Windows runner 上 WSL 未就绪会弹「沙箱准备」提示框，常开地
// 盖住 backdrop 阻塞其余用例（核心在 __KEPCUP_TEST_HOOKS__ 下才读；打包产物 DCE
// 折叠恒开）。sandbox-wizard.spec 的 fixture 场景不受它影响。
process.env.KEPCUP_WSL_PROMPT ??= 'off';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 90_000,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
});
