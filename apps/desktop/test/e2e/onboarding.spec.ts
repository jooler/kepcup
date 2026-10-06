import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

/**
 * P13 任务 4 首次启动引导 e2e（docs/dev/phases/P13-release.md 任务 4）。
 * 全流程：新数据目录启动 → 走完引导（欢迎/数据位置 → 模型〔跳过〕→ 权限 →
 * 沙箱〔macOS 自动检测〕→ 第一个 Bot〔模板〕）→ 与第一个 Bot 对话成功
 * （mock LLM）；覆盖「返回上一步」「跳过模型配置后的持续提示」「重启后不再
 * 出现」（完成状态写 settings 的持久化）。
 *
 * 驱动方式如实说明：本 spec 不设置 KEPCUP_ONBOARDING（其余既有 spec 以
 * 该 e2e seam 关闭向导）；向导内容本身全部是生产代码路径。
 */

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  llm: MockLlmServer;
}

async function launchApp(options: { home: string; llmUrl: string }): Promise<LaunchedApp> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: options.home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(options.home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: options.llmUrl,
    },
  });
  const page = await app.firstWindow();
  return { app, page, home: options.home };
}

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const launched = await launchApp({ home, llmUrl: llm.url });
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

test('full first-run flow: welcome → skip model → permissions → sandbox → butler → chat; the skipped-model banner persists until a key is set', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-onb-full-');
  const { page, home, llm } = session;
  try {
    await waitReady(page);

    // ① 欢迎：数据存放位置说明（system.info 的真实数据目录绝对路径）。
    const wizard = page.locator('[data-testid="onboarding"]');
    await expect(wizard).toBeVisible({ timeout: 30_000 });
    await expect(wizard).toHaveAttribute('data-step', 'welcome');
    await expect(page.locator('[data-testid="onboarding-data-dir"]')).toContainText(
      path.basename(home),
    );
    await page.locator('[data-testid="onboarding-start"]').click();

    // ② 模型：mock LLM 种子的 custom:mock 厂商可选；跳过（可跳过但持续提示）。
    await expect(wizard).toHaveAttribute('data-step', 'model');
    await page.locator('[data-testid="onboarding-provider-select"]').selectOption('custom:mock');
    await page.locator('[data-testid="onboarding-model-skip"]').click();

    // ③ 权限：自启开关（默认开）+ 系统通知说明与测试入口。
    await expect(wizard).toHaveAttribute('data-step', 'permissions');
    // bits-ui Checkbox 是 button[role=checkbox]（踩坑清单）；默认开。
    const autostart = page.locator('[data-testid="onboarding-autostart"]');
    await expect(autostart).toHaveAttribute('aria-checked', /true|mixed/);
    await expect(page.locator('[data-testid="onboarding-notify-test"]')).toBeVisible();
    // 「返回上一步」回到模型步，再跳过回来——每步可返回（验收标准）。
    await page.locator('[data-testid="onboarding-back"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'model');
    await page.locator('[data-testid="onboarding-model-skip"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'permissions');
    await page.locator('[data-testid="onboarding-next"]').click();

    // ④ 沙箱：macOS 自动检测（srt 后端），无 Windows 内容。
    await expect(wizard).toHaveAttribute('data-step', 'sandbox');
    await expect(page.locator('[data-testid="onboarding-sandbox-state"]')).toContainText('srt', {
      timeout: 30_000,
    });
    await page.locator('[data-testid="onboarding-next"]').click();

    // ⑤ 认识管家（D70）：建立唯一管家并进入组队访谈。
    await expect(wizard).toHaveAttribute('data-step', 'bot');
    await expect(page.locator('[data-testid="onboarding-butler-points"]')).toBeVisible();
    llm.script('mock-main', [step().replyText('你好，我是你的管家')]);
    await page.locator('[data-testid="onboarding-butler-start"]').click();

    // 向导关闭，进入管家的私聊（左栏置顶），首问卡由 core 确定性下发。
    await expect(wizard).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="conversation-name"]').first()).toHaveText('管家');

    // 跳过模型配置后的持续提示（不阻塞其余功能）。
    const banner = page.locator('[data-testid="no-model-banner"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // 与第一个 Bot 对话成功（mock LLM）。对话不因未配 key 而崩溃——用户消息
    // 入队发送，Bot 回复失败时内联提示；这里先补上 key 再对话（任务书语义：
    // 跳过后「无法与 Bot 对话」，配置 key 后应可用）。
    await banner.locator('[data-testid="no-model-go-settings"]').click();
    await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
    // 卡片式厂商区：custom:mock 无 key 也作为自定义卡片显示，经卡片
    // 「设置 Key」弹框落盘（保存后卡片即时出现已配置标记）。
    await page.locator('[data-testid="key-dialog-custom:mock"]').click();
    await expect(page.locator('[data-testid="provider-add-dialog"]')).toBeVisible();
    await page.locator('[data-testid="key-input-custom:mock"]').fill('sk-onboarding-e2e');
    await page.locator('[data-testid="provider-add-save"]').click();
    await expect(page.locator('[data-testid="key-state-custom:mock"]')).toBeVisible({
      timeout: 15_000,
    });

    // key 配好后横幅消失；关闭设置弹框回到对话发送消息。
    await expect(banner).toBeHidden({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
    await page.locator('[data-testid^="conversation-item-"]').first().click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('第一次对话');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('[data-testid="bot-bubble"]').last()).toContainText(
      '你好，我是你的管家',
      { timeout: 30_000 },
    );
  } finally {
    await closeSession(session);
  }
});

test('model step saves key + default main model: the first bot chats right away and settings lists only keyed providers', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-onb-model-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    const wizard = page.locator('[data-testid="onboarding"]');
    await expect(wizard).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="onboarding-start"]').click();

    // ② 模型：选厂商后默认主/轻量模型下拉随之出现——已存设置有效则各自
    // 回填，用户改选后与 key 一并保存（不再需要先跳过、事后在设置页补救）。
    await expect(wizard).toHaveAttribute('data-step', 'model');
    await page.locator('[data-testid="onboarding-provider-select"]').selectOption('custom:mock');
    const defaultSelect = page.locator('[data-testid="onboarding-default-model"]');
    await expect(defaultSelect).toHaveValue('custom:mock/mock-main');
    const lightSelect = page.locator('[data-testid="onboarding-light-model"]');
    await expect(lightSelect).toHaveValue('custom:mock/mock-light');
    await defaultSelect.selectOption('custom:mock/mock-light');
    await lightSelect.selectOption('custom:mock/mock-main');
    await page.locator('[data-testid="onboarding-key-input"]').fill('sk-onboarding-e2e');
    await page.locator('[data-testid="onboarding-model-save"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'permissions');

    // ③④ 权限 → 沙箱（macOS 自动检测）。
    await page.locator('[data-testid="onboarding-next"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'sandbox');
    await expect(page.locator('[data-testid="onboarding-sandbox-state"]')).toContainText('srt', {
      timeout: 30_000,
    });
    await page.locator('[data-testid="onboarding-next"]').click();

    // ⑤ 管家（D70）：建好后直接可对话——对话走的是向导写入的默认主模型
    // （runtime.model 为空回退 settings.defaultMainModel），只编排 mock-light
    // 的脚本：若实现仍落在 mock-main，mock LLM 会因未匹配而失败。
    await expect(wizard).toHaveAttribute('data-step', 'bot');
    await page.locator('[data-testid="onboarding-butler-start"]').click();
    await expect(wizard).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('[data-testid="no-model-banner"]')).toHaveCount(0);
    llm.script('mock-light', [step().replyText('默认模型直接可用')]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('第一次对话');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').last()).toContainText(
      '默认模型直接可用',
      {
        timeout: 30_000,
      },
    );

    // 设置页：默认主/轻量模型 = 向导所选项；下拉只列已配置 key 的厂商
    // （此处仅 custom:mock 的两个模型 + 占位项）。
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-settings"]').click();
    await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
    await page.locator('[data-testid="settings-nav-models"]').click();
    const defaultMain = page.locator('[data-testid="default-main-model"]');
    await expect(defaultMain).toHaveValue('custom:mock/mock-light');
    await expect(page.locator('[data-testid="default-main-model"] option')).toHaveCount(3);
    await expect(page.locator('[data-testid="default-light-model"]')).toHaveValue(
      'custom:mock/mock-main',
    );
  } finally {
    await closeSession(session);
  }
});

test('completion persists in settings: a relaunch of the same data home does not show the wizard again', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-onb-persist-');
  const { page, home } = session;
  try {
    await waitReady(page);
    const wizard = page.locator('[data-testid="onboarding"]');
    await expect(wizard).toBeVisible({ timeout: 30_000 });
    // 「跳过引导」路径也是完成：completed=true（welcome 步直达）。
    await page.locator('[data-testid="onboarding-skip-all"]').click();
    await expect(wizard).toBeHidden({ timeout: 15_000 });

    // BR-P13-004：跳过引导直达完成的新用户同样得到「未配置模型」持续提示
    // （横幅条件是「已完成引导 && 无任何 key」，不要求 modelSkipped 标记）。
    const banner = page.locator('[data-testid="no-model-banner"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    // 无 Bot 空态会让「+」面板自动展开：点背景收起，避免挡住横幅按钮。
    try {
      await page.locator('[data-testid="start-chat-backdrop"]').click({ timeout: 2_000 });
    } catch {
      // 面板没有展开，无需处理。
    }

    // 配置 key 后横幅消失（横幅对 key 状态响应式）。
    await banner.locator('[data-testid="no-model-go-settings"]').click();
    await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
    await page.locator('[data-testid="key-dialog-custom:mock"]').click();
    await expect(page.locator('[data-testid="provider-add-dialog"]')).toBeVisible();
    await page.locator('[data-testid="key-input-custom:mock"]').fill('sk-onboarding-e2e');
    await page.locator('[data-testid="provider-add-save"]').click();
    await expect(page.locator('[data-testid="key-state-custom:mock"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(banner).toBeHidden({ timeout: 15_000 });
  } finally {
    // 只关应用：mock LLM 留给重启后的第二个会话（最后统一清理）。
    await session.app.close();
  }

  // 同一数据目录重启：引导不再出现（settings.onboarding.completed 持久化），
  // 且 key 已配置 → 横幅也不出现。
  const relaunched = await launchApp({ home, llmUrl: session.llm.url });
  try {
    await waitReady(relaunched.page);
    await expect(relaunched.page.locator('[data-testid="onboarding"]')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(relaunched.page.locator('[data-testid="no-model-banner"]')).toHaveCount(0, {
      timeout: 15_000,
    });
  } finally {
    await relaunched.app.close();
    await session.llm.stop();
    await rm(home, { recursive: true, force: true });
  }
});
