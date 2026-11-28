import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCore,
  createMemoryKeystore,
  type CoreHarness,
  type Keystore,
} from '../../src/index.js';

/**
 * update.activeRuns 的服务未就绪语义（P13 任务 2 红线「不得强制中断」+
 * DB_FROM_NEWER_VERSION 例外放行）：
 *
 * - 终局 error（进程存活、服务永不就绪——低版本打开高版本数据、钥匙串读取
 *   失败等）且执行器未武装（executorsArmed=false：失败发生在
 *   jobsRunner.start() 之前）→ 空集是事实而非猜测，更新门控据此收敛
 *   ready-to-install，下载完成后能出「应用更新」（否则干等 30 分钟排空
 *   超时，用户只能靠退出应用 autoInstallOnAppQuit 兜底）。
 * - locked / starting 等未知态 → 仍 fail-closed 抛错（门控按 busy 处理，
   绝不把未知当空）。
 * - ready 后走真实列表（本用例空库 → 空集）。
 */

const harnesses: CoreHarness[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const core of harnesses.splice(0)) await core.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function newTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'core-active-runs-'));
  homes.push(home);
  return home;
}

describe('update.activeRuns（服务未就绪语义）', () => {
  it('终局 error 且执行器未武装：放行空集（门控可收敛 ready）', async () => {
    // getSecret 抛错 → 启动在 DB 打开前终局失败（error），服务从未建立。
    const throwing: Keystore = {
      kind: 'memory',
      getSecret() {
        throw new Error('keychain unavailable');
      },
      setSecret() {},
      deleteSecret() {},
    };
    const core = await createCore({ home: await newTempHome(), keystore: throwing });
    harnesses.push(core);

    expect(core.services.status).toBe('error');
    expect(core.services.executorsArmed).toBe(false);
    expect(core.services.domain).toBeNull();
    await expect(
      core.services.platformMethods['update.activeRuns']!.handle(undefined),
    ).resolves.toEqual({ runs: [] });
  });

  it('locked（存密无效）仍 fail-closed 抛错（未知态绝不按空处理）', async () => {
    const keystore = createMemoryKeystore();
    // 非 32 字节的存密 → failLocked（'系统钥匙串中存储的密钥数据无效'）。
    keystore.setSecret('!!not-a-valid-master-key!!');
    const core = await createCore({ home: await newTempHome(), keystore });
    harnesses.push(core);

    expect(core.services.status).toBe('locked');
    expect(core.services.executorsArmed).toBe(false);
    await expect(
      core.services.platformMethods['update.activeRuns']!.handle(undefined),
    ).rejects.toThrow('core services not ready');
  });

  it('ready 后走真实列表（空库无在途执行 → 空集）', async () => {
    const core = await createCore({ home: await newTempHome(), keystore: createMemoryKeystore() });
    harnesses.push(core);

    expect(core.services.status).toBe('ready');
    expect(core.services.executorsArmed).toBe(true);
    await expect(
      core.services.platformMethods['update.activeRuns']!.handle(undefined),
    ).resolves.toEqual({ runs: [] });
  });
});
