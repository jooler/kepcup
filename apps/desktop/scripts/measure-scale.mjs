#!/usr/bin/env node
/**
 * P13 任务 7 规模场景测量（1 万条消息的对话 + 50 个 Bot）。
 *
 *   node scripts/measure-scale.mjs [--messages 10000] [--bots 50]
 *
 * 两段式：
 *   ① 夹具生成（不入仓库）：本进程内直接起核心服务（file keystore，密钥落
 *      临时数据目录，第二段复用同一目录与密钥），经 domain 服务直写 50 个
 *      Bot 与 1 万条消息（不经过模型/执行循环——测量对象是「打开」与列表，
 *      不是生成）。写完干净关闭（WAL checkpoint）。
 *   ② 真实应用测量：启动 Electron（与 e2e/measure-perf 同一代码路径），
 *      测冷启动可交互、打开 1 万条消息对话的耗时、50 Bot 联系人列表打开
 *      耗时、空闲内存（按进程）。
 *
 * 机器档位随结果一并打印（M1 Max 口径记 PROGRESS）。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scriptDir);

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
}
const MESSAGE_COUNT = argValue('--messages', 10_000);
const BOT_COUNT = argValue('--bots', 50);

function machineInfo() {
  const chip = execSync('sysctl -n machdep.cpu.brand_string').toString().trim();
  const memGb = Math.round(Number(execSync('sysctl -n hw.memsize').toString().trim()) / 1024 ** 3);
  const cores = Number(execSync('sysctl -n hw.ncpu').toString().trim());
  const version = execSync('sw_vers -productVersion').toString().trim();
  return `${chip} / ${cores} 核 / ${memGb}GB / macOS ${version}`;
}

const home = mkdtempSync(path.join(tmpdir(), 'kepcup-scale-'));
const env = {
  ...process.env,
  NODE_ENV: 'test',
  KEPCUP_KEYSTORE: 'file',
  KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.scale-master-key'),
  // 测量脚本不是引导用例：关闭首启向导（e2e seam，packaged 产物恒为 on）。
  KEPCUP_ONBOARDING: 'off',
};

// --- ① 夹具生成（in-process core，与应用同源 dist） ---------------------------
const { createCoreServices } = await import('@kepcup/core');
{
  const t0 = Date.now();
  const services = await createCoreServices({ home, env, appVersion: '0.0.0', dev: true });
  const domain = services.domain;
  const bots = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    bots.push(
      domain.bots.create({
        identity: { name: `规模 Bot ${String(i + 1).padStart(2, '0')}`, bio: '规模场景夹具' },
        persona: { personality: '简洁直接' },
      }),
    );
  }
  const conversation = domain.conversations.openDirect(bots[0].id).conversation;
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const isUser = i % 2 === 0;
    domain.messages.append({
      conversationId: conversation.id,
      senderType: isUser ? 'user' : 'bot',
      ...(isUser ? {} : { senderBotId: bots[0].id }),
      kind: 'text',
      text: `规模夹具消息 #${i + 1}：一行普通的对话文本，带少量 markdown（**粗体**）与代码 \`inline\`。`,
    });
  }
  const fixtureMs = Date.now() - t0;
  await services.close();
  console.log(`夹具生成：${BOT_COUNT} 个 Bot + ${MESSAGE_COUNT} 条消息，用时 ${fixtureMs}ms（已干净关闭）`);
}

// --- ② 真实应用测量 -----------------------------------------------------------
const t0 = Date.now();
const app = await _electron.launch({
  args: ['.'],
  cwd: appDir,
  env: { ...env, KEPCUP_HOME: home },
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 120_000 });
  await page.waitForSelector('[data-testid="ping-result"]', { timeout: 120_000 });
  for (let i = 0; i < 120; i++) {
    const text = await page.locator('[data-testid="ping-result"]').textContent();
    if (text?.includes('ping ✓')) break;
    await page.waitForTimeout(250);
  }
  const interactiveMs = Date.now() - t0;

  // 打开 1 万条消息的对话：点击侧栏第一个对话 → 消息气泡出现（最后一页加载）。
  const conversationItem = page.locator('[data-testid^="conversation-item-"]').first();
  await conversationItem.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(2_000); // 首屏列表渲染就绪后再计时
  const openStart = Date.now();
  await conversationItem.click();
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 30_000 });
  // 等到消息气泡真实出现（首屏 60 条的分页加载 + 渲染）。
  await page.waitForSelector('[data-testid="bot-bubble"]', { timeout: 30_000 });
  const openMs = Date.now() - openStart;
  const bubbleCount = await page.locator('[data-testid^="message-"]').count();

  // 50 Bot 联系人列表打开耗时。
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-contacts"]').click();
  await page.waitForSelector('[data-testid="contacts-page-content"]', { timeout: 30_000 });
  const contactsStart = Date.now();
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-contacts"]').click();
  await page.waitForSelector('[data-testid="bot-create"]', { timeout: 30_000 });
  const contactsMs = Date.now() - contactsStart;

  // 空闲 8s 后采样内存（就绪且完成上述操作后）。
  await page.waitForTimeout(8_000);
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({
      type: m.type,
      mb: Math.round((m.memory.workingSetSize ?? 0) / 1024),
    })),
  );
  const totalMb = metrics.reduce((sum, m) => sum + m.mb, 0);

  const line = (label, value) => console.log(`${label.padEnd(30)} ${value}`);
  console.log('=== P13 规模场景（本机实测） ===');
  line('机器档位', machineInfo());
  line(`场景`, `${BOT_COUNT} 个 Bot / ${MESSAGE_COUNT} 条消息的对话`);
  line('冷启动→核心就绪可交互', `${interactiveMs} ms（任务书 ≤3s）`);
  line('打开 1 万条消息对话', `${openMs} ms（任务书 ≤500ms；首屏分页 60 条）`);
  line('（对话首屏已渲染消息数）', `${bubbleCount}`);
  line('50 Bot 联系人列表打开', `${contactsMs} ms（任务书无阈值，如实记录）`);
  for (const m of metrics) line(`内存 ${m.type}`, `${m.mb} MB`);
  line('内存总计', `${totalMb} MB`);
  console.log('（空闲内存口径见 measure-perf.mjs 与 PROGRESS：任务书「核心服务内存」为核心 Utility 进程）');
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
