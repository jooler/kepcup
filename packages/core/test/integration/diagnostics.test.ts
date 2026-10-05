import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryKeystore } from '@kepcup/core';
import { createTestCore } from '@kepcup/testkit';
import type { DiagnosticsOutput, Settings } from '@kepcup/shared';

/**
 * P13-B（任务 6 诊断 + 任务 4 引导状态）: `diagnostics.get` 聚合快照与
 * settings 的 onboarding 部分补丁合并语义。
 */

const cores: Array<{ close(): Promise<void>; home: string }> = [];

afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.close();
    await rm(core.home, { recursive: true, force: true });
  }
});

async function freshCore(): Promise<{
  close(): Promise<void>;
  home: string;
  rpc: { call(method: string, input?: unknown): Promise<unknown> };
}> {
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-diag-'));
  const core = await createTestCore({ home, keystore: createMemoryKeystore() });
  cores.push({ close: core.close, home });
  return { close: core.close, home, rpc: core.rpc };
}

describe('diagnostics.get (P13 任务 6)', () => {
  it('aggregates core status, databases with migration versions, keystore, sandbox, disk and logs rows', async () => {
    const { home, rpc } = await freshCore();
    const diag = (await rpc.call('diagnostics.get')) as DiagnosticsOutput;

    expect(diag.core.status).toBe('ready');
    expect(diag.core.platform).toBe(process.platform);
    expect(diag.core.uptimeSec).toBeGreaterThanOrEqual(0);
    // paths.home 是 canonicalPath（/var → /private/var 符号链接已解析）。
    expect(diag.dataDir).toBe(realpathSync(home));

    // 数据目录与日志目录的磁盘占用（就绪后日志已建立）；默认预算下无截断
    // 标记（BR-P13-006：标记只在超预算时出现）。
    expect(diag.dataDirBytes).toBeGreaterThan(0);
    expect(diag.dataDirTruncated).toBeFalsy();
    expect(diag.logsTruncated).toBeFalsy();
    expect(diag.logsDir).toBe(path.join(realpathSync(home), 'logs'));

    // 数据库行：main/runs 打开且迁移到当前目标版本；per-bot memory 库行存在。
    const main = diag.databases.find((row) => row.name === 'main.db');
    const runs = diag.databases.find((row) => row.name === 'runs.db');
    expect(main?.open).toBe(true);
    expect(runs?.open).toBe(true);
    expect(main?.version).toBe(main?.targetVersion);
    expect(runs?.version).toBe(runs?.targetVersion);
    expect((main?.version ?? 0) >= 11).toBe(true);
    const memoryRow = diag.databases.find((row) => row.name.startsWith('memory.db'));
    // 惰性打开（P07）：启动后连接池为空，磁盘上也没有任何 per-bot 库。
    expect(memoryRow?.open).toBe(false);
    expect(memoryRow?.detail).toContain('尚无 Bot 记忆库');

    // 钥匙串：测试注入 memory keystore，主密钥已建立 → ok。
    expect(diag.keystore.kind).toBe('memory');
    expect(diag.keystore.ok).toBe(true);

    // 沙箱行（srt 后端；enhanced 本机未装 → available false 或 null 均合法）。
    expect(diag.sandbox.backend).toBe('srt');
    expect(typeof diag.sandbox.available).toBe('boolean');

    // 工具链行（P06 doctor 数据源：system 探测 + 安装记录）。
    expect(Array.isArray(diag.toolchain)).toBe(true);
    expect(diag.toolchain.some((row) => row.id === 'system:git')).toBe(true);
  });

  it('reports the per-bot memory store state without opening stores (P07 lazy-open intact)', async () => {
    const { rpc } = await freshCore();
    const bot = (await rpc.call('bots.create', {
      profile: { identity: { name: '阿诊', bio: '' } },
    })) as { bot: { id: string } };
    expect(bot.bot.id).toBeTruthy();
    const diag = (await rpc.call('diagnostics.get')) as DiagnosticsOutput;
    const memoryRow = diag.databases.find((row) => row.name.startsWith('memory.db'));
    // bots.create 建 bot 目录但记忆库惰性打开——池仍为空，行如实报告。
    expect(memoryRow?.open).toBe(false);
  });

  it('flags the data-dir usage as a lower bound when the walk hits the budget (BR-P13-006)', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-diag-budget-'));
    const core = await createTestCore({
      home,
      keystore: createMemoryKeystore(),
      // 预算=1：数据目录本就有多个条目（main.db / logs/ / runs.db …），
      // 无需六位数文件量即可触发截断路径。
      diskUsageBudget: 1,
    });
    cores.push({ close: core.close, home });
    const diag = (await core.rpc.call('diagnostics.get')) as DiagnosticsOutput;
    expect(diag.dataDirTruncated).toBe(true);
    // bytes 仍如实返回（预算=1 时首个条目可能是目录，下界允许为 0——这正是
    // 「数字为下界」语义）。logs 目录可能尚为空（空目录无截断可言，标记缺席
    // 是正确行为），只断言字节字段仍是数字。
    expect(Number.isInteger(diag.dataDirBytes)).toBe(true);
    expect(Number.isInteger(diag.logsBytes)).toBe(true);
  });

  it('surfaces a locked core: keystore ok=false with the structured reason', async () => {
    // 同一 keystore 在两个核心实例间共享：第二个实例读到已有数据库但没有
    // 独立主密钥 → locked（fail-closed 语义，见 start.ts）。
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-diag-locked-'));
    const first = await createTestCore({ home, keystore: createMemoryKeystore() });
    const second = await createTestCore({ home, keystore: createMemoryKeystore() });
    try {
      const diag = (await second.rpc.call('diagnostics.get')) as DiagnosticsOutput;
      expect(diag.core.status).toBe('locked');
      expect(diag.keystore.ok).toBe(false);
      expect(diag.keystore.reason).toContain('主密钥');
      expect(diag.databases.find((row) => row.name === 'main.db')?.open).toBe(false);
    } finally {
      await first.close();
      await second.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('settings onboarding state (P13 任务 4)', () => {
  it('merges partial onboarding patches without erasing other flags; defaults appear on read', async () => {
    const { rpc } = await freshCore();

    const initial = (await rpc.call('settings.get')) as Settings;
    expect(initial.onboarding).toEqual({
      completed: false,
      modelConfigured: false,
      modelSkipped: false,
    });

    const afterSkip = (await rpc.call('settings.update', {
      onboarding: { modelSkipped: true },
    })) as Settings;
    expect(afterSkip.onboarding).toEqual({
      completed: false,
      modelConfigured: false,
      modelSkipped: true,
    });

    // 第二个补丁只写 completed：modelSkipped 保留（部分补丁语义）。
    const afterComplete = (await rpc.call('settings.update', {
      onboarding: { completed: true },
    })) as Settings;
    expect(afterComplete.onboarding).toEqual({
      completed: true,
      modelConfigured: false,
      modelSkipped: true,
    });

    // 不带 onboarding 的更新不触碰引导状态。
    const untouched = (await rpc.call('settings.update', {
      defaultLightModel: 'custom:mock/mock-light',
    })) as Settings;
    expect(untouched.onboarding).toEqual(afterComplete.onboarding);
  });
});
