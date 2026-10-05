import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PodmanSandboxBackend,
  cwdCoverageRejections,
  type CliRunner,
} from '../../src/sandbox/backend-container.js';
import { encodeExecResponse } from '../../src/sandbox/wsl/protocol.js';
import type { SandboxExecRequest, SandboxPolicy } from '../../src/sandbox/types.js';

/**
 * 容器增强后端（Lima/Podman 共用基类）的纯函数与请求构造单测（P12 修复轮
 * BR-P12-005/006/007）：cwd 覆盖判定走标准路径原语、发行版基础 env 随请求
 * 注入、结果记录必须回带请求 nonce。真实 podman/lima 的平台绑定集成登记于
 * todo/cross-platform-acceptance.md P12。
 */

const logger = { info: () => {}, warn: () => {}, error: () => {} } as never;

// 测试目录放在宿主家目录下：mounts.ts 的 isSystemRoot 会把家目录外的绝对路径
// 当作「镜像自带系统目录」跳过（真实 Linux 上 /home/user 在家目录内）。
const PROJECT = path.join(homedir(), 'kepcup-container-test', 'proj');

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    readWrite: [PROJECT],
    readOnly: [],
    denyRead: [homedir()],
    network: { mode: 'none', allowDomains: [] },
    env: { PATH: '/opt/kepcup/toolchains/node/bin:/usr/bin', npm_config_cache: '/home/user/.kepcup/cache/npm' },
    ...overrides,
  };
}

function execRequest(overrides: Partial<SandboxExecRequest> = {}): SandboxExecRequest {
  return { command: 'echo hi', cwd: PROJECT, policy: policy(), timeoutMs: 30_000, ...overrides };
}

interface Captured {
  argv: string[][];
  inputs: string[];
  /** Nonce the shim echoes back; defaults to the request's own. */
  echoNonce?: string | null;
}

function podmanBackend(capture: Captured): PodmanSandboxBackend {
  const runner: CliRunner = {
    async run(argv, options = {}) {
      if (argv[0] === 'podman' && argv[1] === '--version') {
        return { exitCode: 0, stdout: Buffer.from('podman version 5.0.0'), stderr: Buffer.alloc(0) };
      }
      if (argv[0] === 'podman' && argv[1] === 'image') {
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      capture.argv.push(argv);
      const input = options.input ?? '';
      capture.inputs.push(input);
      const request = JSON.parse(input) as { nonce?: string };
      const nonce =
        capture.echoNonce === undefined
          ? request.nonce
          : capture.echoNonce === null
            ? undefined
            : capture.echoNonce;
      return {
        exitCode: 0,
        stdout: Buffer.from(
          `${encodeExecResponse({ exitCode: 0, timedOut: false, violations: [], ...(nonce !== undefined ? { nonce } : {}) })}\n`,
          'utf8',
        ),
        stderr: Buffer.alloc(0),
      };
    },
  };
  return new PodmanSandboxBackend({
    logger,
    platform: 'linux',
    registration: { registeredWindowsPaths: () => [PROJECT] },
    dataHome: path.join(homedir(), 'kepcup-container-test', '.kepcup'),
    runner,
  });
}

describe('cwdCoverageRejections（BR-P12-007：标准路径原语）', () => {
  const mounts = [{ source: '/home/user/proj', mode: 'ro' as const, role: 'grant' as const }];

  it('covers the mount itself and nested paths', () => {
    expect(cwdCoverageRejections('/home/user/proj', mounts, 'linux')).toEqual([]);
    expect(cwdCoverageRejections('/home/user/proj/sub/dir', mounts, 'linux')).toEqual([]);
  });

  it('rejects look-alike prefixes and unrelated cwds (boundary, not startsWith)', () => {
    // 手写 startsWith 时代的经典隐患：/home/user/proj-twin 不是 /home/user/proj 内部。
    expect(cwdCoverageRejections('/home/user/proj-twin', mounts, 'linux')).toHaveLength(1);
    expect(cwdCoverageRejections('/opt/elsewhere', mounts, 'linux')).toHaveLength(1);
    for (const cwd of ['/home/user/proj-twin', '/opt/elsewhere']) {
      expect(cwdCoverageRejections(cwd, mounts, 'linux')[0]).toMatchObject({ kind: 'cwd', path: cwd });
    }
  });

  it('windows flavor compares case-insensitively with both separators', () => {
    const winMounts = [{ source: 'C:\\Code\\proj', mode: 'rw' as const, role: 'workspace' as const }];
    expect(cwdCoverageRejections('c:/code/proj/sub', winMounts, 'win32')).toEqual([]);
    expect(cwdCoverageRejections('C:\\CODE\\proj', winMounts, 'win32')).toEqual([]);
    expect(cwdCoverageRejections('C:\\Code\\other', winMounts, 'win32')).toHaveLength(1);
  });
});

describe('PodmanSandboxBackend exec 请求构造', () => {
  it('注入发行版基础 env（BR-P12-006）；策略 PATH 覆盖宿主尾部', async () => {
    const capture: Captured = { argv: [], inputs: [] };
    const backend = podmanBackend(capture);
    const result = await backend.exec(execRequest());
    expect(result.exitCode).toBe(0);

    const request = JSON.parse(capture.inputs[0]!) as { env: Record<string, string> };
    // 基础身份/locale/temp 变量随请求进入镜像（shim 全量替换 env）。
    expect(request.env.HOME).toBe('/home/kepcup');
    expect(request.env.USER).toBe('kepcup');
    expect(request.env.LOGNAME).toBe('kepcup');
    expect(request.env.TMPDIR).toBe('/tmp');
    expect(request.env.LANG).toBe('C.UTF-8');
    // PATH：host 工具链前缀保留（1:1 绑定同径），宿主 PATH 尾部被镜像 PATH 替换。
    expect(request.env.PATH).toBe('/opt/kepcup/toolchains/node/bin:/opt/kepcup/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('结果记录回带请求 nonce；不匹配的记录拒绝执行（BR-P12-005）', async () => {
    const capture: Captured = { argv: [], inputs: [] };
    const backend = podmanBackend(capture);
    const result = await backend.exec(execRequest());
    expect(result.exitCode).toBe(0);
    const request = JSON.parse(capture.inputs[0]!) as { nonce?: string };
    expect(typeof request.nonce).toBe('string');

    // shim 回带错误 nonce → host 拒绝（命令输出无法伪造结果）。
    const forged: Captured = { argv: [], inputs: [], echoNonce: 'forged' };
    const backend2 = podmanBackend(forged);
    await expect(backend2.exec(execRequest())).rejects.toThrowError(/nonce/);

    // 缺 nonce → 同样拒绝。
    const missing: Captured = { argv: [], inputs: [], echoNonce: null };
    const backend3 = podmanBackend(missing);
    await expect(backend3.exec(execRequest())).rejects.toThrowError(/nonce/);
  });

  it('podman argv：1:1 绑定 + workdir + 固定 shim 入口（红线挂载参数形态）', async () => {
    const capture: Captured = { argv: [], inputs: [] };
    const backend = podmanBackend(capture);
    await backend.exec(execRequest());
    const argv = capture.argv[0]!;
    expect(argv.slice(0, 5)).toEqual(['podman', 'run', '--rm', '-i', '--user']);
    expect(argv).toContain('-v');
    expect(argv.filter((arg) => arg === '-v')).toHaveLength(1);
    // 末位固定为镜像内 shim 入口（stdin JSON 协议，无 shell）。
    expect(argv[argv.length - 1]).toBe('/opt/kepcup/bin/kepcup-sandbox');
    expect(argv).toContain('-w');
  });
});
