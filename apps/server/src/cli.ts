#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, parseConfig, usageText } from './config.js';
import { createAdminClient } from './admin.js';
import { qrTerminal } from './qr.js';
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

  await runServer(config);
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`${error.message}\n\n${usageText()}`);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
