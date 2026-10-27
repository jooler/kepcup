#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { Interface as RlInterface } from 'node:readline/promises';
import { pluginInspectOutputSchema, type PluginInspectOutput } from '@kepcup/shared';
import { ConfigError, parseConfig, usageText, type ServerConfig } from './config.js';
import { createAdminClient } from './admin.js';
import { qrTerminal } from './qr.js';
import { AuthStore, MIN_PASSWORD_LENGTH } from './auth.js';
import {
  formatPluginInspection,
  missingRequiredUserConfig,
  parseUserConfigText,
  type PluginUserConfig,
} from './plugin-cli.js';
import { runServer, serverVersion } from './server.js';

/**
 * bin 入口（D102）：run（缺省）/ pair / devices / version。pair 与 devices 是
 * 运行中服务本机 admin 接口的薄客户端（读同一数据目录下的 admin-token）。
 */

function readAdminToken(dataDir: string): string {
  try {
    return readFileSync(path.join(dataDir, 'admin-token'), 'utf8').trim();
  } catch {
    console.error(`读不到 ${path.join(dataDir, 'admin-token')}：服务是否在此数据目录运行过？`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));

  if (config.command === 'version') {
    console.log(serverVersion());
    return;
  }

  if (config.command === 'password') {
    await changeAdminPassword(config);
    return;
  }

  if (config.command === 'plugin') {
    await installPlugin(config);
    return;
  }

  if (config.command === 'pair') {
    const client = createAdminClient(config.port, readAdminToken(config.dataDir));
    if (config.acceptRequestId !== null) {
      const outcome = await client.confirmPairing(config.acceptRequestId, true);
      console.log(config.json ? JSON.stringify(outcome) : `配对确认结果：${outcome.status}`);
      return;
    }
    const offer = await client.pair();
    if (config.json) {
      console.log(JSON.stringify(offer));
      return;
    }
    console.log('配对码已生成（5 分钟内有效，一次性），手机扫码或打开链接：');
    console.log();
    console.log(qrTerminal(offer.url));
    console.log();
    console.log(`    ${offer.url}`);
    return;
  }

  if (config.command === 'devices') {
    const client = createAdminClient(config.port, readAdminToken(config.dataDir));
    if (config.revokeDeviceId !== null) {
      const device = await client.revoke(config.revokeDeviceId);
      console.log(
        config.json ? JSON.stringify(device) : `已撤销：${device.name}（${device.deviceId}）`,
      );
      return;
    }
    const { devices } = await client.devices();
    if (config.json) {
      console.log(JSON.stringify(devices));
      return;
    }
    if (devices.length === 0) {
      console.log('暂无已配对设备（运行 kepcup-server pair 生成配对码）。');
      return;
    }
    for (const device of devices) {
      console.log(
        `${device.online === true ? '●' : '○'} ${device.name}  ${device.deviceId}  配对于 ${new Date(device.createdAt).toLocaleString()}`,
      );
    }
    return;
  }

  if (config.relayUrl === null && config.auth === 'password') {
    await ensureAdminAccount(config);
  }
  await runServer(config);
}

/**
 * `kepcup-server plugin install <path>`（D104 P2）：运行中服务的本机 admin 接口薄客户端。
 * file / folder 来源只在服务器本机可用；网页端没有本地文件选择器。
 */
async function installPlugin(config: ServerConfig): Promise<void> {
  if (config.pluginAction !== 'install' || config.pluginPath === null) {
    throw new ConfigError('plugin 子命令不完整（需要 plugin install <路径>）');
  }
  const client = createAdminClient(config.port, readAdminToken(config.dataDir));
  const target = path.resolve(config.pluginPath);
  let source: { kind: 'folder' | 'file'; path: string };
  let info: PluginInspectOutput;
  try {
    source = (await stat(target)).isDirectory()
      ? { kind: 'folder', path: target }
      : { kind: 'file', path: target };
    info = pluginInspectOutputSchema.parse(await client.pluginsInspect({ source }));
  } catch (error) {
    console.error(`读取插件失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  (config.json ? console.error : console.log)(formatPluginInspection(info));
  if (!info.installable) {
    console.error('插件不可安装：');
    for (const blocker of info.blockers) console.error(`  - ${blocker}`);
    for (const conflict of info.conflicts) {
      console.error(`  - 冲突 ${conflict.kind} ${conflict.ref} ↔ ${conflict.withWhat}`);
    }
    process.exit(1);
  }

  let userConfig: PluginUserConfig = {};
  if (config.pluginConfigFile !== null) {
    try {
      userConfig = parseUserConfigText(readFileSync(config.pluginConfigFile, 'utf8'));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
  const missing = missingRequiredUserConfig(info, userConfig);
  if (missing.length > 0) {
    console.error(`缺少必填配置：${missing.join(', ')}`);
    console.error('用 --config <json 文件> 提供（终端里不输入敏感值）。');
    process.exit(1);
  }

  if (!config.pluginYes) {
    if (!process.stdin.isTTY) {
      console.error('非交互环境不能确认安装；确认无误后加 --yes 重试。');
      process.exit(1);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = (await rl.question('继续安装？[y/N] ')).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (answer !== 'y' && answer !== 'yes') {
      console.log('已取消。');
      process.exit(1);
    }
  }

  try {
    const result = await client.pluginsInstall({
      source,
      sha256: info.packageSha256,
      userConfig,
    });
    if (config.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`已安装：${info.name}（${info.id}@${info.version}）`);
    }
  } catch (error) {
    console.error(`安装失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * 密码模式首启建号（D102 修订）：已配置（auth.json 存在）直接过；否则优先用
 * --admin-user/--admin-password（systemd 非交互），都没有且是交互终端则提示输入
 * （用户名默认 admin，密码输两次、不回显），非交互又没给参数则由 server 层报错。
 */
async function ensureAdminAccount(
  dataDir: string,
  adminUser: string | null,
  adminPassword: string | null,
): Promise<void>;
async function ensureAdminAccount(config: {
  dataDir: string;
  adminUser: string | null;
  adminPassword: string | null;
}): Promise<void>;
async function ensureAdminAccount(
  configOrDir: { dataDir: string; adminUser: string | null; adminPassword: string | null } | string,
  maybeUser?: string | null,
  maybePassword?: string | null,
): Promise<void> {
  const dataDir = typeof configOrDir === 'string' ? configOrDir : configOrDir.dataDir;
  const adminUser = typeof configOrDir === 'string' ? (maybeUser ?? null) : configOrDir.adminUser;
  const adminPassword =
    typeof configOrDir === 'string' ? (maybePassword ?? null) : configOrDir.adminPassword;
  mkdirSync(dataDir, { recursive: true });
  const auth = new AuthStore(dataDir);
  if (auth.isConfigured()) return;
  if (adminUser !== null && adminPassword !== null) {
    await auth.setupAdmin(adminUser, adminPassword);
    console.log(`管理员账号已创建：${adminUser}`);
    return;
  }
  if (!process.stdin.isTTY) {
    // 留给 server 层统一报错（提示 systemd 参数）。
    return;
  }
  console.log('首次启动：设置管理员账号（用于网页登录，请务必记住）。');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const username = (await rl.question('管理员用户名 [admin]: ')).trim() || 'admin';
    const password = await askHidden(rl, `密码（≥${MIN_PASSWORD_LENGTH} 位）: `);
    const confirm = await askHidden(rl, '再输一次密码: ');
    if (password !== confirm) {
      console.error('两次输入不一致，未创建账号。重新运行 kepcup-server 再试。');
      process.exit(2);
    }
    auth.setupAdmin(username, password);
    console.log(`管理员账号已创建：${username}`);
  } finally {
    rl.close();
  }
}

/** 隐藏输入：node 原生 readline 无 hideEchoBack——问句先打、再吞掉输出流（键入不回显）。 */
async function askHidden(rl: RlInterface, question: string): Promise<string> {
  // promises Interface 的类型面没有 output（运行时存在）；回调式 Interface 有。
  const output = (rl as unknown as { output: WritableLike }).output;
  const originalWrite = output.write.bind(output);
  originalWrite(question);
  output.write = () => true;
  try {
    return await rl.question('');
  } finally {
    output.write = originalWrite;
    originalWrite('\n');
  }
}

interface WritableLike {
  write(chunk: string): boolean;
}

/**
 * `kepcup-server password`：改管理员密码（校验旧密码；改完全部旧会话失效——
 * 网页端需重新登录）。非交互场景用 --admin-password（仅当账号尚未初始化时可直接建号）。
 */
async function changeAdminPassword(config: ReturnType<typeof parseConfig>): Promise<void> {
  mkdirSync(config.dataDir, { recursive: true });
  const auth = new AuthStore(config.dataDir);
  if (!process.stdin.isTTY) {
    console.error(
      'password 子命令需要交互终端；脚本场景请删除 <data-dir>/auth.json 后用 --admin-user/--admin-password 重建。',
    );
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!auth.isConfigured()) {
      console.log('管理员账号未初始化，直接创建。');
      const username = (await rl.question('管理员用户名 [admin]: ')).trim() || 'admin';
      const password = await askHidden(rl, `密码（≥${MIN_PASSWORD_LENGTH} 位）: `);
      const confirm = await askHidden(rl, '再输一次密码: ');
      if (password !== confirm) {
        console.error('两次输入不一致。');
        process.exit(2);
      }
      await auth.setupAdmin(username, password);
      console.log(`管理员账号已创建：${username}`);
      return;
    }
    console.log(`修改管理员 ${auth.username ?? ''} 的密码（改完所有已登录会话失效）。`);
    const oldPassword = await askHidden(rl, '旧密码: ');
    const newPassword = await askHidden(rl, `新密码（≥${MIN_PASSWORD_LENGTH} 位）: `);
    const confirm = await askHidden(rl, '再输一次新密码: ');
    if (newPassword !== confirm) {
      console.error('两次输入不一致，密码未修改。');
      process.exit(2);
    }
    await auth.changePassword(oldPassword, newPassword);
    console.log('密码已修改。');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    if (error.message === 'help') {
      // 显式 --help/-h 是正常退出（审查 P3：原先落到错误分支退 2）。
      console.log(usageText());
      process.exit(0);
    }
    console.error(`${error.message}\n\n${usageText()}`);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
