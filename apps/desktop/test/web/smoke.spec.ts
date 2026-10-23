import { expect, test } from '@playwright/test';

/**
 * D96 WP5 web 冒烟（design 46 §8）：对 build:web 产物做纯前端断言——
 *   1. 页面加载 + PWA 壳资源（manifest / sw.js）可取；
 *   2. WebShellGate 配对态渲染（扫码提示 + 粘贴框）；
 *   3. 粘贴一个假配对链接后状态推进：确认设备名 → 请求配对 → 连接中转失败 →
 *      明确的错误态 + 重试入口（不要求真连中转——三端联调在 WP6）。
 *
 * 假链接的会话 id 用 ULID 形状（26 位 Crockford Base32）的字符串，绕过格式校验；
 * relay 指向不存在的地址，WebSocket 连接必然失败，验证失败态可见。
 */
const FAKE_PAIR_URL = `https://relay.example/#pair=${encodeURIComponent('wss://relay.example')},01J8Z3V7K2QW5R8TN9XYC4M6AH,AAABAABAABAABAABAABAABAABA`;

test('loads the PWA shell with manifest and service worker assets', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('KepCup');
  const manifestStatus = await page.request.get('/manifest.webmanifest');
  expect(manifestStatus.status()).toBe(200);
  const swStatus = await page.request.get('/sw.js');
  expect(swStatus.status()).toBe(200);
  const iconStatus = await page.request.get('/icon.svg');
  expect(iconStatus.status()).toBe(200);
});

test('shows the unpaired gate with the pairing link input', async ({ page }) => {
  await page.goto('/');
  const gate = page.getByTestId('web-gate');
  await expect(gate).toBeVisible();
  await expect(page.getByTestId('web-gate-unpaired')).toBeVisible();
  await expect(page.getByTestId('web-pair-input')).toBeVisible();
  // 手机端点不渲染 Electron 的 App UI（纯遥控器：配对前没有本地界面）。
  await expect(page.getByTestId('app-shell')).toHaveCount(0);
});

test('advances to the error state after submitting a fake pairing link', async ({ page }) => {
  await page.goto('/');
  const input = page.getByTestId('web-pair-input');
  await expect(input).toBeVisible();
  await input.fill(FAKE_PAIR_URL);
  await page.getByTestId('web-pair-submit').click();
  // 下一步：确认设备名（默认从 UA 提取摘要，headless chromium → Mac 浏览器）。
  await expect(page.getByTestId('web-gate-enter-name')).toBeVisible();
  await expect(page.getByTestId('web-device-name')).not.toHaveValue('');
  await page.getByTestId('web-pair-confirm').click();
  // 请求已发（配对状态推进）：短暂经过「连接中转」状态行。
  await expect(
    page.getByTestId('web-gate-status').or(page.getByTestId('web-gate-failed')).first(),
  ).toBeVisible({ timeout: 10_000 });
  // relay.example 不可达：连续 3 次握手失败后 transport 停进 failed 态等手动重试。
  await expect(page.getByTestId('web-gate-failed')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('web-failed-retry')).toBeVisible();
});
