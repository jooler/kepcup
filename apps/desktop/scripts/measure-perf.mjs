#!/usr/bin/env node
/**
 * P13 性能测量（冷启动 + 空闲内存；规模场景见 measure-scale.mjs）。
 *
 *   node scripts/measure-perf.mjs
 *
 * 测什么（任务书验收标准「性能」）：
 *  - 冷启动到窗口可交互：进程启动 → 首窗出现 → app-shell 可见 → 核心 ready（ping ✓）；
 *  - 空闲内存：就绪后 10 秒，主/渲染/工具进程（utilityProcess）各自的内存
 *    （app.getAppMetrics() 的 memory.workingSetSize，单位 MB）与总和。
 *
 * 说明：测量跑的是仓库构建产物 out/（electron-vite build），与打包产物
 * 同一代码路径。P13-B 优化后口径（渲染层 markdown 管线已改为惰性加载，
 * 空闲首屏不含 streamdown/shiki/katex）。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scriptDir);

function machineInfo() {
  const chip = execSync('sysctl -n machdep.cpu.brand_string').toString().trim();
  const memGb = Math.round(Number(execSync('sysctl -n hw.memsize').toString().trim()) / 1024 ** 3);
  const cores = Number(execSync('sysctl -n hw.ncpu').toString().trim());
  const version = execSync('sw_vers -productVersion').toString().trim();
  return `${chip} / ${cores} 核 / ${memGb}GB / macOS ${version}`;
}

const home = mkdtempSync(path.join(tmpdir(), 'kepcup-perf-'));
const t0 = Date.now();
const app = await _electron.launch({
  args: ['.'],
  cwd: appDir,
  env: {
    ...process.env,
    KEPCUP_HOME: home,
    NODE_ENV: 'test',
    KEPCUP_KEYSTORE: 'memory',
    // 与 measure-scale.mjs 对齐（BR-P13-008）：首启向导不进入测量路径。
    KEPCUP_ONBOARDING: 'off',
  },
});

try {
  const launchAt = Date.now() - t0;
  const page = await app.firstWindow();
  const windowAt = Date.now() - t0;
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 120_000 });
  const shellAt = Date.now() - t0;
  await page.waitForSelector('[data-testid="ping-result"]', {
    timeout: 120_000,
    state: 'visible',
  });
  // ping ✓ means core ready (RPC round-trip done).
  for (let i = 0; i < 60; i++) {
    const text = await page.locator('[data-testid="ping-result"]').textContent();
    if (text?.includes('ping ✓')) break;
    await page.waitForTimeout(250);
  }
  const interactiveAt = Date.now() - t0;

  // Idle for 10s, then sample memory (settle transient allocations).
  await page.waitForTimeout(10_000);
  const metrics = await app.evaluate(({ app: electronApp }) => {
    // workingSetSize is reported in kilobytes; convert to MB for the baseline.
    return electronApp.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      mb: Math.round((m.memory.workingSetSize ?? 0) / 1024),
    }));
  });
  const totalMb = metrics.reduce((sum, m) => sum + m.mb, 0);

  const line = (label, value) => console.log(`${label.padEnd(28)} ${value}`);
  console.log('=== P13 性能基线（本机实测） ===');
  line('机器档位', machineInfo());
  line('冷启动→进程启动完成', `${launchAt} ms`);
  line('冷启动→首窗创建', `${windowAt} ms`);
  line('冷启动→app-shell 可见', `${shellAt} ms`);
  line('冷启动→核心就绪可交互', `${interactiveAt} ms`);
  for (const m of metrics) line(`空闲内存 ${m.type} (pid ${m.pid})`, `${m.mb} MB`);
  line('空闲内存总计', `${totalMb} MB`);
  console.log('（任务书达标值：冷启动 ≤3s、空闲 ≤300MB——逐进程构成与口径说明见 PROGRESS P13 小节）');
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
