import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, type MockLlmServer } from '@kepcup/testkit';

/**
 * P12-B e2e（docs/dev/phases/P12-windows-and-enhanced-sandbox.md 任务 7）：
 * 沙箱准备向导状态机与设置页后端展示。Windows 状态机路径在 macOS 上经
 * KEPCUP_WSL_TEST_FIXTURE 注入的 wsl.exe fixture runner 驱动（核心侧
 * test seam——UTF-16 输出形状与真实 wsl.exe 一致，路径见
 * packages/core/src/sandbox/wsl/fixture-runner.ts）；真实 Windows 行为留
 * todo/cross-platform-acceptance.md P12 真机项。第一例（srt/Lima 展示）
 * 无注入，走真实探测。
 */

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function launchApp(options: {
  home: string;
  llmUrl: string;
  wslFixture?: string;
}): Promise<LaunchedApp> {
  // 向导的导入步骤需要 rootfs 产物（真实安装包由 CI 产出）；e2e 用生产
  // 交付的 KEPCUP_WSL_ROOTFS 覆盖指向一个本地占位文件（fixture runner
  // 不读取其内容）。
  const rootfs = path.join(options.home, 'rootfs.tar');
  await writeFile(rootfs, 'e2e-rootfs-placeholder');
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: options.home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      // P13-B e2e seam: 非引导用例不出现首启向导（packaged 产物恒为 on）。
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(options.home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: options.llmUrl,
      ...(options.wslFixture !== undefined
        ? { KEPCUP_WSL_TEST_FIXTURE: options.wslFixture, KEPCUP_WSL_ROOTFS: rootfs }
        : {}),
    },
  });
  const page = await app.firstWindow();
  return { app, page, home: options.home };
}

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  llm: MockLlmServer;
}

async function startSession(
  prefix: string,
  options: { wslFixture?: string } = {},
): Promise<Session> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const launched = await launchApp({ home, llmUrl: llm.url, wslFixture: options.wslFixture });
  return { ...launched, llm };
}

async function closeSession(session: Session): Promise<void> {
  await session.app.close();
  await session.llm.stop();
  await rm(session.home, { recursive: true, force: true });
}

async function waitReady(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  // 等启动恢复收尾：chat-view（恢复了对话）/ 空态引导面板 / 首启向导三者
  // 之一都只在 bootstrap 完成后出现。ping ✓ 早于 bootstrap 结束，慢机器上
  // 直接往下走会与异步尾巴竞态。「+」面板的全屏 backdrop 会拦截后续一切
  // 点击，收尾后确保它已收起（面板只开一次，收掉后不会再出现）。
  await expect(
    page
      .locator('[data-testid="chat-view"]')
      .or(page.locator('[data-testid="start-chat-panel"]'))
      .or(page.locator('[data-testid="onboarding"]')),
  ).toBeVisible({ timeout: 60_000 });
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    // 可能有更高层的模态（如首启沙箱准备向导）盖住 backdrop：收不掉就交给
    // 各测试自己的既有处理（它们大多自带 try-click 收尾），不在这里硬等。
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  }
}

async function openSettings(page: Page): Promise<void> {
  // 弹框可能已开着（嵌套向导关闭后设置仍在）：先 Escape 归零再走菜单入口。
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
  // 空态启动时「+」面板可能自动展开：先收起（Esc 或点背景）再走菜单。
  try {
    await page.locator('[data-testid="start-chat-backdrop"]').click({ timeout: 1_500 });
  } catch {
    // 面板没有展开。
  }
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
}

async function createBotAndOpenChat(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await expect(page.locator('[data-testid="bot-create-dialog"]')).toBeVisible();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });

  // 「+」面板的自动展开是启动恢复的异步尾巴，可能落在建 Bot 之后（慢机器）；
  // 其全屏 backdrop 会拦截后续一切点击，进入测试主体前确保它已收起。
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

test('settings page shows the current backend and the enhanced (Lima) state; wizard shows no Windows content on macOS', async () => {
  const session = await startSession('kepcup-e2e-sbxw-mac-');
  const { page } = session;
  try {
    await waitReady(page);
    // 无注入（真实探测）：首次启动提示不适用于 macOS（applicable=false）。
    await expect(page.locator('[data-testid="sandbox-prompt"]')).toHaveCount(0);

    await openSettings(page);
    await page.locator('[data-testid="settings-nav-environment"]').click();
    const section = page.locator('[data-testid="settings-sandbox"]');
    await expect(section).toBeVisible();
    await expect(page.locator('[data-testid="sandbox-backend"]')).toContainText(/srt|wsl/, {
      timeout: 60_000,
    });
    if (process.platform !== 'win32') {
      await expect(page.locator('[data-testid="sandbox-backend"]')).toContainText('srt');
    }
    const state = page.locator('[data-testid="sandbox-state"]');
    await expect(state).toBeVisible();
    expect(['可用', '不可用']).toContain((await state.textContent())?.trim());

    // 增强级子状态（本机未装 Lima → 未安装 + 原因；装了则可用）。
    const enhanced = page.locator('[data-testid="sandbox-enhanced"]');
    if (process.platform !== 'win32') {
      await expect(enhanced).toBeVisible({ timeout: 60_000 });
      const enhancedState = await enhanced
        .locator('[data-testid="sandbox-enhanced-state"]')
        .textContent();
      expect(['可用', '未安装']).toContain(enhancedState?.trim());
      await expect(enhanced.locator('[data-testid="sandbox-enhanced-backend"]')).toContainText(
        /Lima|Podman/,
      );
    }

    // 向导入口随时可用；非 Windows 平台打开是增强沙箱入口，无 Windows 内容。
    await page.locator('[data-testid="sandbox-wizard-open"]').click();
    const wizard = page.locator('[data-testid="sandbox-wizard"]');
    await expect(wizard).toBeVisible();
    if (process.platform !== 'win32') {
      await expect(page.locator('[data-testid="wizard-enhanced"]')).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.locator('[data-testid="wizard-wsl"]')).toHaveCount(0);
    }
  } finally {
    await closeSession(session);
  }
});

test('wizard state machine (injected wsl fixture): not installed → enable → import → ready', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-sbxw-flow-', { wslFixture: 'not_installed' });
  const { page } = session;
  try {
    await waitReady(page);

    // 首次启动入口出现（未安装且未跳过）。
    const prompt = page.locator('[data-testid="sandbox-prompt"]');
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await page.locator('[data-testid="sandbox-prompt-prepare"]').click();

    // 向导：未安装状态 + 结构化原因 + 逐条确认说明。
    const wizardWsl = page.locator('[data-testid="wizard-wsl"]');
    await expect(wizardWsl).toBeVisible();
    await expect(wizardWsl).toHaveAttribute('data-phase', 'idle', { timeout: 60_000 });
    await expect(page.locator('[data-testid="wizard-reason"]')).toContainText('未安装');
    await expect(page.locator('[data-testid="wizard-confirm-note"]')).toContainText('逐条确认');

    // 开始准备：管理员授权（fixture 模拟 UAC 通过）→ awaiting_reboot（提示重启）。
    await page.locator('[data-testid="wizard-prepare"]').click();
    await expect(page.locator('[data-testid="wizard-reason"]')).toContainText('请重启', {
      timeout: 60_000,
    });

    // fixture 模拟「重启已完成」：状态机自动继续导入 → importing → ready。
    // 逐帧观察 data-phase，导入中阶段必须真实出现过（fixture import 有延迟）。
    let sawImporting = false;
    await expect
      .poll(
        async () => {
          const phase = await wizardWsl.getAttribute('data-phase');
          if (phase === 'importing') sawImporting = true;
          return phase;
        },
        { timeout: 120_000, intervals: [250, 500, 500] },
      )
      .toBe('ready');
    expect(sawImporting).toBe(true);
    await expect(page.locator('[data-testid="wizard-done"]')).toContainText('不再逐条确认');
    // 就绪后不再提供跳过。
    await expect(page.locator('[data-testid="wizard-skip"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="wizard-shared-vm-note"]')).toContainText(
      '共享一个虚拟机',
    );
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="sandbox-wizard"]')).toBeHidden();

    // 设置页：后端 WSL2 + 可用（导入完成后真实 probe 翻转），共享 VM 说明可见。
    await openSettings(page);
    await page.locator('[data-testid="settings-nav-environment"]').click();
    await expect(page.locator('[data-testid="sandbox-backend"]')).toContainText('WSL2', {
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="sandbox-state"]')).toContainText('可用');
    await expect(page.locator('[data-testid="sandbox-shared-vm-note"]')).toBeVisible();
  } finally {
    await closeSession(session);
  }
});

test('wizard with enterprise policy disabled (injected fixture): keeps per-command confirm mode, no prepare action', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-sbxw-policy-', {
    wslFixture: 'policy_disabled',
  });
  const { page } = session;
  try {
    await waitReady(page);

    // 策略禁用没有可做的准备动作：首启提示不出现。
    await expect(page.locator('[data-testid="sandbox-prompt"]')).toHaveCount(0, {
      timeout: 30_000,
    });

    await openSettings(page);
    await page.locator('[data-testid="settings-nav-environment"]').click();
    await expect(page.locator('[data-testid="sandbox-backend"]')).toContainText('WSL2', {
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="sandbox-state"]')).toContainText('不可用');
    await expect(page.locator('[data-testid="sandbox-reason"]')).toContainText('策略禁用');

    // 向导：policy_disabled 阶段 + 原因含「逐条确认」+ 无准备按钮 + 帮助链接。
    await page.locator('[data-testid="sandbox-wizard-open"]').click();
    const wizardWsl = page.locator('[data-testid="wizard-wsl"]');
    await expect(wizardWsl).toBeVisible();
    await expect(wizardWsl).toHaveAttribute('data-phase', 'policy_disabled', { timeout: 60_000 });
    await expect(page.locator('[data-testid="wizard-reason"]')).toContainText('逐条确认');
    await expect(page.locator('[data-testid="wizard-prepare"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="wizard-help-link"]')).toBeVisible();
    await page.keyboard.press('Escape');
    // 第二次 Escape 关闭设置弹框（向导是嵌套弹框，设置弹框仍在）。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();

    // 对话内的逐条确认横幅持续提示（P03 链路消费同一 probe 结果）。
    await createBotAndOpenChat(page, '阿确');
    await expect(page.locator('[data-testid="confirm-mode-banner"]')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="confirm-mode-banner"]')).toContainText('策略禁用');
  } finally {
    await closeSession(session);
  }
});

test('skipping the wizard keeps per-command confirm mode; preparation stays available from settings', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-sbxw-skip-', { wslFixture: 'not_installed' });
  const { page } = session;
  try {
    await waitReady(page);

    const prompt = page.locator('[data-testid="sandbox-prompt"]');
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await page.locator('[data-testid="sandbox-prompt-skip"]').click();
    await expect(prompt).toBeHidden();

    // 跳过 ≠ 沙箱可用：对话内逐条确认横幅持续提示。
    await createBotAndOpenChat(page, '阿跳');
    await expect(page.locator('[data-testid="confirm-mode-banner"]')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="confirm-mode-banner"]')).toContainText('未安装');

    // 设置页持续显示不可用原因 + 可随时开始准备（向导仍从未安装状态打开）。
    await openSettings(page);
    await page.locator('[data-testid="settings-nav-environment"]').click();
    await expect(page.locator('[data-testid="sandbox-state"]')).toContainText('不可用', {
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="sandbox-reason"]')).toContainText('未安装');
    await expect(page.locator('[data-testid="sandbox-wizard-open"]')).toBeVisible();
    await page.locator('[data-testid="sandbox-wizard-open"]').click();
    const wizardWsl = page.locator('[data-testid="wizard-wsl"]');
    await expect(wizardWsl).toBeVisible();
    await expect(wizardWsl).toHaveAttribute('data-phase', 'idle', { timeout: 60_000 });
    await expect(page.locator('[data-testid="wizard-skip"]')).toBeVisible();
  } finally {
    await closeSession(session);
  }
});
