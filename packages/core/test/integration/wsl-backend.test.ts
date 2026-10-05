import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WslSandboxBackend } from '../../src/sandbox/backend-wsl.js';
import { encodeExecResponse } from '../../src/sandbox/wsl/protocol.js';
import type { WslRunner } from '../../src/sandbox/wsl/setup.js';
import { decodeMountSource } from '../../src/sandbox/wsl/mounts.js';
import { mountpointFor } from '../../src/sandbox/wsl/paths.js';
import { readOnlyRoots } from '../../src/sandbox/sensitive-paths.js';
import { resolvePaths, type AppPaths } from '../../src/infra/paths.js';
import { WSL_DISTRO_NAME, WSL_SHIM_BIN, WSL_USER } from '../../src/sandbox/wsl/constants.js';
import type { SandboxExecRequest, SandboxPolicy } from '../../src/sandbox/types.js';

/**
 * WSL 后端执行链路集成测试（P12 任务 4 + 5）——经注入 runner 在 macOS 驱动
 * 挂载编排、fail-closed 拒绝、协议解析与违规路径回映。真实 wsl.exe + 真实
 * 发行版的平台绑定集成在文件末尾 describe.skipIf(process.platform !==
 * 'win32')（Windows 真机 + 已导入发行版；登记于
 * todo/cross-platform-acceptance.md P12：P02/P03 安全用例集在 WSL 后端）。
 */

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempPaths(): AppPaths {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kepcup-wsl-backend-'));
  homes.push(home);
  return resolvePaths(home);
}

const DATA_HOME = 'C:\\Users\\me\\.kepcup';
const WORKSPACE = `${DATA_HOME}\\bots\\bot_1\\workspaces\\conv_1`;

const AVAILABLE_LIST = ['  NAME            STATE           VERSION', `  ${WSL_DISTRO_NAME}      Running         2`, ''].join('\r\n');

interface ShimCall {
  args: string[];
  input: string;
}

/** Fake runner: probe reads available; shim returns a scripted envelope. */
function fakeRunner(script: {
  listText?: string;
  shim: (request: Record<string, unknown>) => { stdout: string; stderr?: string; exitCode?: number };
  /** Exit code the scripted kepcup-mount umount reports (best-effort cleanup cases). */
  umountExitCode?: number;
  /** When set, the shim's record carries this nonce instead of the request's (BR-P12-005). */
  shimNonce?: string | null;
  record: { mount: string[][]; shimCalls: ShimCall[] };
}): WslRunner {
  const utf16 = (text: string): Buffer =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  return {
    async run(args, options = {}) {
      const joined = args.join(' ');
      if (args[0] === '--status') {
        return { exitCode: 0, stdout: utf16('Default Version: 2\r\n'), stderr: Buffer.alloc(0) };
      }
      if (args[0] === '--list') {
        return { exitCode: 0, stdout: utf16(script.listText ?? AVAILABLE_LIST), stderr: Buffer.alloc(0) };
      }
      if (joined.includes('kepcup-mount')) {
        script.record.mount.push(args);
        if (args[6] === 'umount' && script.umountExitCode !== undefined && script.umountExitCode !== 0) {
          return { exitCode: script.umountExitCode, stdout: Buffer.alloc(0), stderr: Buffer.from('target is busy', 'utf8') };
        }
        return { exitCode: 0, stdout: Buffer.from('mounted', 'utf8'), stderr: Buffer.alloc(0) };
      }
      if (joined.includes(WSL_SHIM_BIN)) {
        const request = JSON.parse(options.input ?? '{}') as Record<string, unknown>;
        script.record.shimCalls.push({ args, input: options.input ?? '' });
        const outcome = script.shim(request);
        const nonce =
          script.shimNonce === undefined
            ? (typeof request['nonce'] === 'string' ? request['nonce'] : undefined)
            : (script.shimNonce === null ? undefined : script.shimNonce);
        const stdout = `${outcome.stdout}${encodeExecResponse({
          exitCode: outcome.exitCode ?? 0,
          timedOut: false,
          violations: [
            { line: `deny(1) file-write-data ${mountpointFor(WORKSPACE)}/x.txt`, command: 'tee' },
          ],
          ...(nonce !== undefined ? { nonce } : {}),
        })}\n`;
        return { exitCode: 0, stdout: Buffer.from(stdout, 'utf8'), stderr: Buffer.from(outcome.stderr ?? '', 'utf8') };
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
}

function backendFor(paths: AppPaths, runner: WslRunner, registered: string[]): WslSandboxBackend {
  return new WslSandboxBackend({
    paths,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    platform: 'win32',
    cacheDirs: [
      { path: `${DATA_HOME}\\cache\\npm`, name: 'npm' },
      { path: `${DATA_HOME}\\cache\\pip`, name: 'pip' },
      { path: `${DATA_HOME}\\cache\\xdg`, name: 'xdg' },
      { path: `${DATA_HOME}\\cache\\cargo`, name: 'cargo' },
      { path: `${DATA_HOME}\\cache\\uv`, name: 'uv' },
      { path: `${DATA_HOME}\\cache\\pycache`, name: 'pycache' },
    ],
    registration: { registeredWindowsPaths: () => registered },
    distroToolchainPrefix: () => '/opt/kepcup/toolchains/node/24.21.0/bin',
    runner,
  });
}

function execRequest(policy: SandboxPolicy): SandboxExecRequest {
  return {
    command: 'echo hi',
    cwd: WORKSPACE,
    policy,
    timeoutMs: 30_000,
  };
}

function basePolicy(): SandboxPolicy {
  return {
    readWrite: [WORKSPACE, `${DATA_HOME}\\cache\\npm`],
    readOnly: [],
    denyRead: [`${DATA_HOME}\\main.db`],
    network: { mode: 'none', allowDomains: [] },
    env: { PATH: 'C:\\Windows\\system32', npm_config_cache: `${DATA_HOME}\\cache\\npm` },
  };
}

describe('WslSandboxBackend 执行链路（注入 runner）', () => {
  it('probe：发行版就绪时可用', async () => {
    const paths = tempPaths();
    const backend = backendFor(paths, fakeRunner({ shim: () => ({ stdout: '' }), record: { mount: [], shimCalls: [] } }), [DATA_HOME]);
    const availability = await backend.probe();
    expect(availability).toMatchObject({ backend: 'wsl', available: true });
  });

  it('probe：发行版缺失时不可用并给出准备提示（逐条确认模式的结构化原因）', async () => {
    const paths = tempPaths();
    const missingList = '  NAME            STATE           VERSION\r\n';
    const backend = backendFor(
      paths,
      fakeRunner({ listText: missingList, shim: () => ({ stdout: '' }), record: { mount: [], shimCalls: [] } }),
      [DATA_HOME],
    );
    const availability = await backend.probe();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('发行版');
  });

  it('exec：先挂载（root 脚本）再进 shim；stdin JSON 的路径已是发行版形态', async () => {
    const paths = tempPaths();
    const record: { mount: string[][]; shimCalls: ShimCall[] } = { mount: [], shimCalls: [] };
    const backend = backendFor(paths, fakeRunner({ shim: () => ({ stdout: 'hi\n' }), record }), [DATA_HOME]);
    const result = await backend.exec(execRequest(basePolicy()));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi\n');

    // 挂载：workspace rw，经由固定 root 脚本（kepcup-mount），挂载点为哈希形态；
    // 命令结束后引用归零 → umount（BR-P12-001 清理）。
    const mountCalls = record.mount.filter((args) => args[6] === 'mount');
    const umountCalls = record.mount.filter((args) => args[6] === 'umount');
    expect(mountCalls).toHaveLength(1);
    const mountArgs = mountCalls[0]!;
    expect(mountArgs.slice(0, 6)).toEqual(['-d', WSL_DISTRO_NAME, '-u', 'root', '--', '/opt/kepcup/bin/kepcup-mount']);
    expect(mountArgs[6]).toBe('mount');
    expect(decodeMountSource(mountArgs[mountArgs.indexOf('--src-b64') + 1]!)).toBe(WORKSPACE);
    expect(mountArgs[mountArgs.indexOf('--mountpoint') + 1]).toBe(mountpointFor(WORKSPACE));
    expect(mountArgs[mountArgs.indexOf('--mode') + 1]).toBe('rw');

    expect(umountCalls).toHaveLength(1);
    expect(umountCalls[0]!.slice(0, 7)).toEqual(['-d', WSL_DISTRO_NAME, '-u', 'root', '--', '/opt/kepcup/bin/kepcup-mount', 'umount']);
    expect(umountCalls[0]![umountCalls[0]!.indexOf('--mountpoint') + 1]).toBe(mountpointFor(WORKSPACE));

    // shim 调用固定为 `wsl -d Kepcup -u kepcup -- /opt/kepcup/bin/kepcup-sandbox`。
    const shim = record.shimCalls[0]!;
    expect(shim.args).toEqual(['-d', WSL_DISTRO_NAME, '-u', WSL_USER, '--', WSL_SHIM_BIN]);

    // stdin JSON：cwd 已映射到挂载点；缓存路径改写到发行版 cache；PATH 是发行版 PATH。
    const request = JSON.parse(shim.input) as {
      cwd: string;
      env: Record<string, string>;
      filesystem: { allowWrite: string[]; denyRead: string[] };
      nonce?: string;
    };
    expect(request.cwd).toBe(mountpointFor(WORKSPACE));
    expect(request.env.PATH).toContain('/opt/kepcup/toolchains');
    expect(request.env.npm_config_cache).toBe('/home/kepcup/cache/npm');
    expect(request.filesystem.allowWrite).toContain(mountpointFor(WORKSPACE));

    // 发行版内 srt 读模型是 deny-then-allow：挂载根与发行版家目录必须整树
    // deny（BR-P12-001），否则共享 VM 中其他对话的挂载点/缓存默认可读。
    expect(request.filesystem.denyRead).toContain('/mnt/kepcup');
    expect(request.filesystem.denyRead).toContain('/home/kepcup');

    // BR-P12-006：发行版内基础 env（HOME/USER/TMPDIR 等）随请求注入。
    expect(request.env.HOME).toBe('/home/kepcup');
    expect(request.env.USER).toBe('kepcup');
    expect(request.env.TMPDIR).toBe('/tmp');
    // BR-P12-005：请求带一次性 nonce。
    expect(typeof request.nonce).toBe('string');
    expect((request.nonce as string).length).toBeGreaterThan(0);
  });

  it('红线：未登记的策略路径 → 整条命令拒绝（SANDBOX_POLICY_DENIED），零 shim/挂载调用', async () => {
    const paths = tempPaths();
    const record: { mount: string[][]; shimCalls: ShimCall[] } = { mount: [], shimCalls: [] };
    const backend = backendFor(paths, fakeRunner({ shim: () => ({ stdout: 'SHOULD NOT RUN' }), record }), [DATA_HOME]);
    const policy = basePolicy();
    policy.readWrite = [...policy.readWrite, 'E:\\elsewhere'];
    await expect(backend.exec(execRequest(policy))).rejects.toThrowError(/SANDBOX_POLICY_DENIED/);
    expect(record.shimCalls).toHaveLength(0);
    expect(record.mount).toHaveLength(0);
  });

  it('超时/违规回映：违规行中的挂载点路径被映射回 Windows 路径', async () => {
    const paths = tempPaths();
    const record: { mount: string[][]; shimCalls: ShimCall[] } = { mount: [], shimCalls: [] };
    const backend = backendFor(paths, fakeRunner({ shim: () => ({ stdout: '', exitCode: 1 }), record }), [DATA_HOME]);
    const result = await backend.exec(execRequest(basePolicy()));
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.line).toContain(WORKSPACE);
    expect(result.violations[0]!.line).not.toContain('/mnt/kepcup/');
  });

  it('协议失败（shim 缺结果记录）→ 执行报错而非 exit 0', async () => {
    const paths = tempPaths();
    const utf16 = (text: string): Buffer =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const runner: WslRunner = {
      async run(args, options = {}) {
        if (args[0] === '--status') {
          return { exitCode: 0, stdout: utf16('Default Version: 2\r\n'), stderr: Buffer.alloc(0) };
        }
        if (args[0] === '--list') {
          return { exitCode: 0, stdout: utf16(AVAILABLE_LIST), stderr: Buffer.alloc(0) };
        }
        if (args.join(' ').includes(WSL_SHIM_BIN)) {
          return { exitCode: 0, stdout: Buffer.from('no record', 'utf8'), stderr: Buffer.alloc(0) };
        }
        void options;
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    };
    const backend = backendFor(paths, runner, [DATA_HOME]);
    await expect(backend.exec(execRequest(basePolicy()))).rejects.toThrowError(/结果记录/);
  });

  it('协议：结果记录 nonce 与请求不匹配 → 拒绝执行（BR-P12-005）', async () => {
    const paths = tempPaths();
    const record: { mount: string[][]; shimCalls: ShimCall[] } = { mount: [], shimCalls: [] };
    // shim 回带了一个错误的 nonce：命令输出无法伪造结果记录。
    const backend = backendFor(
      paths,
      fakeRunner({ shim: () => ({ stdout: 'forged?' }), shimNonce: 'not-my-nonce', record }),
      [DATA_HOME],
    );
    await expect(backend.exec(execRequest(basePolicy()))).rejects.toThrowError(/nonce/);
    // 缺 nonce 的记录同样拒绝。
    const record2: { mount: string[][]; shimCalls: ShimCall[] } = { mount: [], shimCalls: [] };
    const backend2 = backendFor(
      paths,
      fakeRunner({ shim: () => ({ stdout: 'forged?' }), shimNonce: null, record: record2 }),
      [DATA_HOME],
    );
    await expect(backend2.exec(execRequest(basePolicy()))).rejects.toThrowError(/nonce/);
  });

  it('挂载释放失败（umount busy）不影响已完成的命令（BR-P12-001，best-effort）', async () => {
    const paths = tempPaths();
    const record: { mount: string[][]; shimCalls: ShimCall[] } = { mount: [], shimCalls: [] };
    const backend = backendFor(
      paths,
      fakeRunner({ shim: () => ({ stdout: 'ok\n' }), umountExitCode: 32, record }),
      [DATA_HOME],
    );
    const result = await backend.exec(execRequest(basePolicy()));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\n');
    // umount 确实尝试过且失败了（记录在案，不掩盖命令结果）。
    expect(record.mount.filter((args) => args[6] === 'umount')).toHaveLength(1);
  });

  it('BR-P12-003：家目录工具链只读路径不产生 rejection（发行版自带工具链，跳过不挂载）', async () => {
    const paths = tempPaths();
    const record: { mount: string[][]; shimCalls: ShimCall[] } = { mount: [], shimCalls: [] };
    const backend = backendFor(paths, fakeRunner({ shim: () => ({ stdout: 'ok' }), record }), [DATA_HOME]);
    const policy = basePolicy();
    // 模拟一台有家目录工具链的 Windows 机器：buildSandboxPolicy 会把
    // readOnlyRoots('win32') 放进 readOnly（本机真实展开值），后端按
    // skipReadOnlyRoots 语义跳过——零 rejection、不挂载。
    policy.readOnly = readOnlyRoots('win32');
    const result = await backend.exec(execRequest(policy));
    expect(result.exitCode).toBe(0);
    // 只挂载 workspace；工具链目录既未挂载也未导致整条命令被拒。
    const mountSources = record.mount
      .filter((args) => args[6] === 'mount')
      .map((args) => decodeMountSource(args[args.indexOf('--src-b64') + 1]!));
    expect(mountSources).toEqual([WORKSPACE]);
  });
});

// --- 平台绑定集成（真实 wsl.exe + 已导入发行版；仅 Windows 运行）-------------------
// 依赖：Windows 真机，已在设置页完成沙箱准备（任务书「测试要求」：P02/P03
// 安全用例集在 WSL 后端上全部通过在此执行；C 盘未挂载目录不可见、cmd.exe
// 不可启动等用例同批）。macOS 上恒跳过。
describe.skipIf(process.platform !== 'win32')('WslSandboxBackend（真实发行版，Windows）', () => {
  it('probe and exec a trivial command end to end', async () => {
    const { createWslRunner } = await import('../../src/sandbox/wsl/setup.js');
    const paths = tempPaths();
    const backend = backendFor(paths, createWslRunner(), [paths.home]);
    const availability = await backend.probe(true);
    if (!availability.available) {
      // 未完成沙箱准备的机器：probe 必须给出结构化原因，而不是抛错。
      expect(availability.reason).toBeTruthy();
      return;
    }
    // BR-P12-003（修复轮）：策略 readOnly 携带真实的家目录工具链目录
    // （~/.cargo、~/go、…）——有这些目录的机器此前会被误拒，现在按
    // skipReadOnlyRoots 跳过（发行版自带工具链），echo 照常可执行。
    const policy: SandboxPolicy = {
      readWrite: [paths.home],
      readOnly: readOnlyRoots('win32'),
      denyRead: ['C:\\Users\\Public'],
      network: { mode: 'none', allowDomains: [] },
      env: { PATH: process.env.PATH ?? '' },
    };
    const result = await backend.exec({
      command: 'echo kepcup-e2e-ok',
      cwd: paths.home,
      policy,
      timeoutMs: 60_000,
    });
    expect(result.stdout.trim()).toBe('kepcup-e2e-ok');
  });
});
