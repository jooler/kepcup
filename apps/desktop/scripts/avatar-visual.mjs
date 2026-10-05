/**
 * 头像功能的视觉验收脚本（不进 e2e 套件）：启动打包前的 out/ 产物，
 * 建 Bot → 截右栏新布局 → 打开头像编辑卡（预置页签）→ 选形状/换颜色 →
 * Reset → 上传页签真实上传一张本脚本生成的 PNG → 名称/简介点按直编。
 * 截图输出到 /tmp/kepcup-avatar-visual/，交由视觉验收审查。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT_DIR = '/tmp/kepcup-avatar-visual';

/** 256×256 纯色带圆点的 PNG（手写最小 PNG 过于繁琐，用 data 前缀的 1px 放大即可）。 */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const uploadPng = path.join(OUT_DIR, 'upload-fixture.png');
  await writeFile(uploadPng, Buffer.from(PNG_1PX_BASE64, 'base64'));

  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-visual-'));
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'memory',
      KEPCUP_ONBOARDING: 'off',
    },
  });
  const page = await app.firstWindow();
  const shot = (name) => page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });

  await page.locator('[data-testid="app-shell"]').waitFor({ timeout: 60_000 });
  await page.locator('[data-testid="ping-result"]').filter({ hasText: 'ping ✓' }).waitFor({ timeout: 60_000 });

  // 收起启动自动拉开的「+」面板
  await page.locator('[data-testid="start-chat-backdrop"]').click({ timeout: 15_000 }).catch(() => {});

  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill('小启');
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-bio-input"]').fill('要认真可靠地完成每一件小事');
  await page.locator('[data-testid="bot-create-save"]').click();
  await page.locator('[data-testid="chat-view"]').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  await shot('01-right-panel-new-layout');

  // 打开头像编辑卡（预置页签）
  await page.locator('[data-testid="bot-avatar-button"]').click();
  await page.locator('[data-testid="avatar-picker"]').waitFor();
  await page.waitForTimeout(400);
  await shot('02-avatar-picker-preset');

  // 换形状 + 换颜色
  await page.locator('[data-testid="avatar-shape-heart"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="avatar-color-blue"]').click();
  await page.waitForTimeout(400);
  await shot('03-avatar-heart-blue');

  // Reset 回第一个形状第一种颜色
  await page.locator('[data-testid="avatar-reset"]').click();
  await page.waitForTimeout(400);
  await shot('04-avatar-reset-default');

  // 上传页签：真实走一次 core 落盘
  await page.locator('[data-testid="avatar-tab-upload"]').click();
  await page.waitForTimeout(200);
  await shot('05-avatar-upload-tab');
  await page.locator('[data-testid="avatar-upload-input"]').setInputFiles(uploadPng);
  await page.locator('[data-testid="bot-avatar-button"] img').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await shot('06-avatar-uploaded');

  // 名称/简介点按直编
  await page.locator('[data-testid="bot-name-edit"]').click();
  await page.locator('[data-testid="bot-name-inline-input"]').fill('小诚');
  await page.waitForTimeout(200);
  await shot('07-name-editing');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await page.locator('[data-testid="bot-bio-edit"]').click();
  await page.locator('[data-testid="bot-bio-inline-input"]').fill('可靠、务实，重视承诺');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await shot('08-name-bio-saved');

  await app.close();
  await rm(home, { recursive: true, force: true });
  console.log(`done -> ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
