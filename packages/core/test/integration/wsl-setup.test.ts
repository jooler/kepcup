import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { decodeWslOutput } from '../../src/sandbox/wsl/decode.js';
import { buildWslConf } from '../../src/sandbox/wsl/conf.js';
import { WslSetup, type WslRunResult, type WslRunner } from '../../src/sandbox/wsl/setup.js';
import { resolvePaths, sandboxWslDir, wslSetupStatePath, type AppPaths } from '../../src/infra/paths.js';
import { WSL_DISTRO_NAME } from '../../src/sandbox/wsl/constants.js';

/**
 * WSL 状态机集成测试（P12 任务 2 + 3）——全部 WSL 行为经注入的 WslRunner
 * fixture 在 macOS 上驱动；真实 wsl.exe 的平台绑定集成在文件末尾
 * describe.skipIf(process.platform !== 'win32')（需要 Windows + WSL2 真机，
 * 登记于 todo/cross-platform-acceptance.md P12）。
 */

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempPaths(): AppPaths {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kepcup-wsl-setup-'));
  homes.push(home);
  return resolvePaths(home);
}

const LIST_WITH_DISTRO = [
  '  NAME            STATE           VERSION',
  `  ${WSL_DISTRO_NAME}      Stopped         2`,
  '',
].join('\r\n');
const OK_STATUS = 'Default Version: 2\r\n';

interface Recorded {
  args: string[];
  input?: string;
  stdinFile?: string;
}

/** Scriptable fake runner: matches wsl.exe invocations by their leading flag. */
function fakeRunner(script: {
  status?: { exitCode: number; text: string };
  list?: { exitCode: number; text: string };
  elevatedExitCode?: number;
  selfcheckExitCode?: number;
  selfcheckStderr?: string;
  record: Recorded[];
}): WslRunner {
  const utf16 = (text: string): Buffer =>
    // wsl.exe emits UTF-16LE with a BOM (the fixture mirrors that shape so
    // decodeWslOutput's real-world path is exercised).
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  return {
    async run(args, options = {}): Promise<WslRunResult> {
      script.record.push({ args, ...(options.input !== undefined ? { input: options.input } : {}), ...(options.stdinFile !== undefined ? { stdinFile: options.stdinFile } : {}) });
      if (args[0] === '--status') {
        const scripted = script.status ?? { exitCode: 0, text: OK_STATUS };
        return { exitCode: scripted.exitCode, stdout: utf16(scripted.text), stderr: Buffer.alloc(0) };
      }
      if (args[0] === '--list') {
        const scripted = script.list ?? { exitCode: 0, text: LIST_WITH_DISTRO };
        return { exitCode: scripted.exitCode, stdout: utf16(scripted.text), stderr: Buffer.alloc(0) };
      }
      if (args[0] === '-d') {
        // In-distro commands: tee (wsl.conf), useradd, kepcup-mount, kepcup-sandbox.
        const isSelfcheck = args.join(' ').includes('kepcup-sandbox --selfcheck');
        const isMount = args.join(' ').includes('kepcup-mount');
        if (isSelfcheck && script.selfcheckExitCode !== undefined && script.selfcheckExitCode !== 0) {
          return {
            exitCode: script.selfcheckExitCode,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(script.selfcheckStderr ?? 'srt unavailable in image', 'utf8'),
          };
        }
        if (isMount) return { exitCode: 0, stdout: Buffer.from('mounted', 'utf8'), stderr: Buffer.alloc(0) };
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    async runElevated(args): Promise<WslRunResult> {
      script.record.push({ args: ['elevated', ...args] });
      return { exitCode: script.elevatedExitCode ?? 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
}

describe('WslSetup 状态机（注入 runner）', () => {
  it('ok + 已注册发行版 → status ready', async () => {
    const paths = tempPaths();
    const setup = new WslSetup({ paths, runner: fakeRunner({ record: [] }) });
    const report = await setup.status();
    expect(report.state.install.kind).toBe('ok');
    expect(report.state.distro).toEqual({ kind: 'registered', running: false });
    expect(report.phase).toBe('ready');
  });

  it('企业策略禁用 → 结构化原因 + 保持逐条确认模式（phase policy_disabled 持久化）', async () => {
    const paths = tempPaths();
    const policy = { exitCode: 126, text: '适用于 Linux 的 Windows 子系统已被组策略禁用。\r\n' };
    const setup = new WslSetup({
      paths,
      runner: fakeRunner({ status: policy, list: policy, record: [] }),
    });
    const report = await setup.status();
    expect(report.phase).toBe('policy_disabled');
    expect(report.reason).toContain('逐条确认');
    // 持久化：下一次启动读到同一 phase。
    const reopened = new WslSetup({ paths, runner: fakeRunner({ status: policy, list: policy, record: [] }) });
    expect(reopened.snapshot()?.phase).toBe('policy_disabled');
  });

  it('策略解除后转出 policy_disabled → 向导重新可准备（BR-P12-009）', async () => {
    const paths = tempPaths();
    const policy = { exitCode: 126, text: '适用于 Linux 的 Windows 子系统已被组策略禁用。\r\n' };
    const setup = new WslSetup({ paths, runner: fakeRunner({ status: policy, list: policy, record: [] }) });
    await setup.status();
    expect(setup.snapshot()?.phase).toBe('policy_disabled');

    // 策略解除：两条命令恢复 ok、发行版尚未导入（策略禁用期间从未完成导入）。
    // 持久化的 policy_disabled 若永不转出，向导将永远不渲染准备按钮（跨重启死局）。
    const absentList = { exitCode: 0, text: '  NAME            STATE           VERSION\r\n' };
    const lifted = new WslSetup({
      paths,
      runner: fakeRunner({ list: absentList, record: [] }),
    });
    const report = await lifted.status();
    expect(report.phase).toBe('idle');
    expect(report.reason).toContain('尚未导入');
    expect(report.fixHint).toContain('沙箱准备');
    expect(lifted.snapshot()?.phase).toBe('idle');
  });

  it('未安装 → 原因与 fixHint 指向沙箱准备', async () => {
    const paths = tempPaths();
    const none = { exitCode: 1, text: '适用于 Linux 的 Windows 子系统没有已安装的分发版。\r\n' };
    const setup = new WslSetup({ paths, runner: fakeRunner({ status: none, list: none, record: [] }) });
    const report = await setup.status();
    expect(report.reason).toContain('WSL2 未安装');
    expect(report.fixHint).toContain('沙箱准备');
  });

  it('WSL1 形态 → failed + 重新导入提示', async () => {
    const paths = tempPaths();
    const listWsl1 = ['  NAME            STATE           VERSION', `  ${WSL_DISTRO_NAME}      Stopped         1`, ''].join('\r\n');
    const setup = new WslSetup({
      paths,
      runner: fakeRunner({ list: { exitCode: 0, text: listWsl1 }, record: [] }),
    });
    const report = await setup.status();
    expect(report.state.distro).toEqual({ kind: 'wsl1' });
    expect(report.reason).toContain('WSL1');
  });

  it('requestEnable 成功 → awaiting_reboot 持久化（重启后续导）', async () => {
    const paths = tempPaths();
    const record: Recorded[] = [];
    const setup = new WslSetup({ paths, runner: fakeRunner({ record }) });
    const report = await setup.requestEnable();
    expect(report.phase).toBe('awaiting_reboot');
    expect(record.some((entry) => entry.args[0] === 'elevated' && entry.args.includes('--install') && entry.args.includes('--no-distribution'))).toBe(true);
    expect(wslSetupStatePath(paths)).toBeDefined();
    const reopened = new WslSetup({ paths, runner: fakeRunner({ record: [] }) });
    expect(reopened.snapshot()?.phase).toBe('awaiting_reboot');
  });

  it('requestEnable 失败（UAC 拒绝）→ failed + 原因', async () => {
    const paths = tempPaths();
    const setup = new WslSetup({ paths, runner: fakeRunner({ elevatedExitCode: 1, record: [] }) });
    const report = await setup.requestEnable();
    expect(report.phase).toBe('failed');
    expect(report.reason).toContain('启用 WSL 失败');
  });

  it('ensureDistro 全流程：import → wsl.conf（stdin）→ 建用户 → terminate → srt 自检 → ready', async () => {
    const paths = tempPaths();
    const record: Recorded[] = [];
    const rootfs = path.join(paths.home, 'rootfs.tar');
    writeFileSync(rootfs, 'fake-rootfs');
    const setup = new WslSetup({
      paths,
      runner: fakeRunner({
        list: { exitCode: 0, text: '  NAME            STATE           VERSION\r\n' }, // 发行版缺失
        record,
      }),
      env: { KEPCUP_WSL_ROOTFS: rootfs },
    });
    const report = await setup.ensureDistro();
    expect(report.phase).toBe('ready');

    // import 参数（任务 3）：wsl --import Kepcup <sandbox/wsl> rootfs.tar --version 2
    const importCall = record.find((entry) => entry.args[0] === '--import');
    expect(importCall).toBeDefined();
    expect(importCall!.args).toEqual([
      '--import',
      WSL_DISTRO_NAME,
      sandboxWslDir(paths),
      rootfs,
      '--version',
      '2',
    ]);

    // wsl.conf 内容经 stdin 送达 tee（automount/interop 关闭，安全基线）。
    const confCall = record.find((entry) => entry.input !== undefined && entry.args.join(' ').includes('tee /etc/wsl.conf'));
    expect(confCall).toBeDefined();
    expect(confCall!.input).toBe(buildWslConf());

    // 幂等建普通用户 kepcup。
    const userCall = record.find((entry) => entry.args.join(' ').includes('useradd'));
    expect(userCall).toBeDefined();
    expect(userCall!.args.join(' ')).toContain('id -u kepcup');

    // terminate 使配置生效 + shim 自检（srt 可用性验证）。
    expect(record.some((entry) => entry.args[0] === '--terminate')).toBe(true);
    const selfcheck = record.find((entry) => entry.args.join(' ').includes('kepcup-sandbox --selfcheck'));
    expect(selfcheck).toBeDefined();
    expect(selfcheck!.args).toContain('-u');
    expect(selfcheck!.args.join(' ')).not.toContain('-u root');
  });

  it('ensureDistro 幂等：已导入时不再 import', async () => {
    const paths = tempPaths();
    const record: Recorded[] = [];
    const rootfs = path.join(paths.home, 'rootfs.tar');
    writeFileSync(rootfs, 'fake-rootfs');
    const setup = new WslSetup({ paths, runner: fakeRunner({ record }) }); // 默认 list 已含发行版
    const report = await setup.ensureDistro();
    expect(report.phase).toBe('ready');
    expect(record.some((entry) => entry.args[0] === '--import')).toBe(false);
  });

  it('srt 自检失败 → failed，原因可读（srt 依赖待发行版内验证的落点）', async () => {
    const paths = tempPaths();
    const rootfs = path.join(paths.home, 'rootfs.tar');
    writeFileSync(rootfs, 'fake-rootfs');
    const setup = new WslSetup({
      paths,
      runner: fakeRunner({
        list: { exitCode: 0, text: '  NAME            STATE           VERSION\r\n' },
        selfcheckExitCode: 1,
        selfcheckStderr: 'bubblewrap failed',
        record: [],
      }),
      env: { KEPCUP_WSL_ROOTFS: rootfs },
    });
    const report = await setup.ensureDistro();
    expect(report.phase).toBe('failed');
    expect(report.reason).toContain('srt 自检失败');
    expect(report.reason).toContain('bubblewrap failed');
  });

  it('缺少 rootfs 产物 → failed（安装包不完整，不伪造导入）', async () => {
    const paths = tempPaths();
    const record: Recorded[] = [];
    const setup = new WslSetup({
      paths,
      runner: fakeRunner({ list: { exitCode: 0, text: '  NAME            STATE           VERSION\r\n' }, record }),
    });
    const report = await setup.ensureDistro();
    expect(report.phase).toBe('failed');
    expect(report.reason).toContain('rootfs');
    expect(record.some((entry) => entry.args[0] === '--import')).toBe(false);
  });

  it('decodeWslOutput 与 runner 输出的衔接：UTF-16 fixture 端到端可解析', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(OK_STATUS, 'utf16le')]);
    expect(decodeWslOutput(bytes)).toBe(OK_STATUS);
  });

  it('skip 持久化（P12-B）：markSkipped 跨实例保留，且不被后续 phase 迁移清除', async () => {
    const paths = tempPaths();
    const none = { exitCode: 1, text: '适用于 Linux 的 Windows 子系统没有已安装的分发版。\r\n' };
    const setup = new WslSetup({
      paths,
      runner: fakeRunner({ status: none, list: none, record: [] }),
    });
    expect(setup.skipped).toBe(false);
    setup.markSkipped();
    expect(setup.skipped).toBe(true);
    // 重新打开（模拟重启）：skip 标记从状态文件恢复。
    const reopened = new WslSetup({
      paths,
      runner: fakeRunner({ status: none, list: none, record: [] }),
    });
    expect(reopened.skipped).toBe(true);
    expect(reopened.snapshot()?.phase).toBe('idle');
    // 后续 phase 迁移（如 policy_disabled 持久化）不清除用户的跳过决定。
    const policy = { exitCode: 126, text: '适用于 Linux 的 Windows 子系统已被组策略禁用。\r\n' };
    const afterPolicy = new WslSetup({
      paths,
      runner: fakeRunner({ status: policy, list: policy, record: [] }),
    });
    await afterPolicy.status();
    expect(afterPolicy.snapshot()?.phase).toBe('policy_disabled');
    expect(afterPolicy.skipped).toBe(true);
  });
});

// --- fixture seam 的生产加固（修复轮）---------------------------------------------
describe('KEPCUP_WSL_TEST_FIXTURE seam 的生产守卫', () => {
  it('NODE_ENV=production 时 seam 恒不激活（防生产环境变量意外点燃）', async () => {
    const { wslFixtureScenarioFromEnv } = await import('../../src/sandbox/wsl/fixture-runner.js');
    expect(wslFixtureScenarioFromEnv({ NODE_ENV: 'production', KEPCUP_WSL_TEST_FIXTURE: 'ready' })).toBeNull();
    expect(wslFixtureScenarioFromEnv({ NODE_ENV: 'test', KEPCUP_WSL_TEST_FIXTURE: 'ready' })).toBe('ready');
    expect(wslFixtureScenarioFromEnv({ NODE_ENV: 'test' })).toBeNull();
  });
});

// --- 平台绑定集成（真实 wsl.exe；仅 Windows 运行）---------------------------------
// 依赖：Windows 10 19041+ / Windows 11 真机或自建运行器（todo/cross-platform-
// acceptance.md P12：真机全套）。macOS 上恒跳过。
describe.skipIf(process.platform !== 'win32')('WslSetup（真实 wsl.exe，Windows）', () => {
  it('probe reads the real WSL state', async () => {
    const { createWslRunner } = await import('../../src/sandbox/wsl/setup.js');
    const paths = tempPaths();
    const setup = new WslSetup({ paths, runner: createWslRunner() });
    const report = await setup.status();
    expect(['ok', 'not_installed', 'needs_enable', 'policy_disabled']).toContain(report.state.install.kind);
  });
});
