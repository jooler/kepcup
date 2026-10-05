import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';

async function launchApp(): Promise<{ app: ElectronApplication; page: Page; home: string }> {
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-life-'));
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      // The crash-restart test needs the master key to survive a core process
      // restart, which the in-memory keystore cannot do.
      KEPCUP_KEYSTORE: 'file',
      // P13-B e2e seam: 非引导用例不出现首启向导（packaged 产物恒为 on）。
      KEPCUP_ONBOARDING: 'off',
    },
  });
  const page = await app.firstWindow();
  return { app, page, home };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('closing the window hides it; the app keeps running in the tray', async () => {
  const { app, page, home } = await launchApp();
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });

  // The window intercepts close and hides instead (tray-resident).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect
    .poll(
      async () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const pid = app.process().pid;
  expect(pid !== undefined && processAlive(pid)).toBe(true);

  await app.close();
  await rm(home, { recursive: true, force: true });
});

test('a killed core service restarts automatically and the UI recovers', async () => {
  test.setTimeout(120_000);
  const { app, page, home } = await launchApp();
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });

  // Kill the core service (the NodeService utilityProcess). Resolved through
  // the Electron API so the test stays cross-platform (no pgrep, BR-P00-006).
  const corePids = await app.evaluate(({ app: electronApp }) =>
    electronApp
      .getAppMetrics()
      .filter((metric) => metric.type === 'Utility')
      .map((metric) => metric.pid),
  );
  expect(corePids.length).toBeGreaterThan(0);
  for (const pid of corePids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // may have already exited
    }
  }

  // The renderer shows the reconnect banner, then recovers on its own.
  await expect(page.locator('[data-testid="reconnect-banner"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('[data-testid="reconnect-banner"]')).toBeHidden({
    timeout: 30_000,
  });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });

  await app.close();
  await rm(home, { recursive: true, force: true });
});
