import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolvePaths, type AppPaths } from '../../src/infra/paths.js';
import { LIMA_VM_NAME } from '../../src/sandbox/lima/constants.js';
import { limaInstanceState, parseLimaList } from '../../src/sandbox/lima/list.js';
import { buildProvisionScript } from '../../src/sandbox/lima/provision.js';
import type {
  LimaRunOptions,
  LimaRunResult,
  LimaRunner,
} from '../../src/sandbox/lima/runner.js';
import { LimaSetup } from '../../src/sandbox/lima/setup.js';
import { buildLimaInstanceYaml } from '../../src/sandbox/lima/yaml.js';

/**
 * Lima 准备状态机（macOS 增强沙箱向导）的 fixture 测试：全部 limactl 调用
 * 经注入 runner 驱动，非 macOS 机器也能覆盖 create → start → provision →
 * selfcheck → ready、失败重试与单飞。
 */

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

interface Recorded {
  argv: string[];
  input?: string;
}

interface FakeScript {
  instance: 'missing' | 'stopped' | 'running';
  createExitCode?: number;
  startExitCode?: number;
  provisionExitCode?: number;
  selfcheckExitCode?: number;
  record: Recorded[];
}

function fakeRunner(script: FakeScript): LimaRunner {
  return {
    async run(argv: string[], options: LimaRunOptions = {}): Promise<LimaRunResult> {
      script.record.push({
        argv,
        ...(options.input !== undefined ? { input: options.input } : {}),
      });
      const ok = (stdout = ''): LimaRunResult => ({
        exitCode: 0,
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
      });
      const fail = (code = 1, stderr = 'boom'): LimaRunResult => ({
        exitCode: code,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(stderr),
      });

      if (argv[0] === 'list') {
        if (script.instance === 'missing') return ok('');
        const entry = {
          name: LIMA_VM_NAME,
          status: script.instance === 'running' ? 'Running' : 'Stopped',
        };
        return ok(`${JSON.stringify(entry)}\n`);
      }
      if (argv[0] === 'create') {
        if ((script.createExitCode ?? 0) !== 0) return fail(script.createExitCode);
        script.instance = 'stopped';
        return ok('created');
      }
      if (argv[0] === 'start') {
        if ((script.startExitCode ?? 0) !== 0) return fail(script.startExitCode);
        script.instance = 'running';
        return ok('started');
      }
      if (argv[0] === 'shell') {
        const command = argv.join(' ');
        if (command.includes('--selfcheck')) {
          return (script.selfcheckExitCode ?? 0) === 0
            ? ok('selfcheck ok')
            : fail(script.selfcheckExitCode, 'selfcheck failed');
        }
        if (command.includes('bash -s')) {
          return (script.provisionExitCode ?? 0) === 0
            ? ok('[kepcup] 沙箱工具初始化完成')
            : fail(script.provisionExitCode, 'apt failed');
        }
        return ok('');
      }
      return ok('');
    },
  };
}

function tempSetup(input: {
  script: FakeScript;
  run?: (options: { shimPath: string; paths: AppPaths }) => LimaSetup;
}): LimaSetup {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kepcup-lima-setup-'));
  homes.push(home);
  const paths = resolvePaths(home);
  const shimPath = path.join(home, 'kepcup-sandbox.cjs');
  writeFileSync(shimPath, '#!/opt/kepcup/bin/node\nprocess.exit(0)\n', 'utf8');
  if (input.run !== undefined) {
    return input.run({ shimPath, paths });
  }
  return new LimaSetup({
    paths,
    runner: fakeRunner(input.script),
    shimPath,
    nodeVersion: '24.21.0',
    srtVersion: '0.0.78',
  });
}

describe('parseLimaList / limaInstanceState', () => {
  it('accepts JSONL and JSON array output', () => {
    const entry = { name: LIMA_VM_NAME, status: 'Running', running: true };
    expect(parseLimaList(`${JSON.stringify(entry)}\n`)).toEqual([entry]);
    expect(parseLimaList(JSON.stringify([entry]))).toEqual([entry]);
    expect(parseLimaList('')).toEqual([]);
  });

  it('maps instance states (missing / stopped / running)', () => {
    expect(limaInstanceState([])).toBe('missing');
    expect(limaInstanceState([{ name: LIMA_VM_NAME, status: 'Stopped' }])).toBe('stopped');
    expect(limaInstanceState([{ name: LIMA_VM_NAME, status: 'Running' }])).toBe('running');
    expect(limaInstanceState([{ name: LIMA_VM_NAME, running: true }])).toBe('running');
  });
});

describe('buildLimaInstanceYaml', () => {
  it('bases on Debian 12, disables containerd and mounts ~ writable', () => {
    const yaml = buildLimaInstanceYaml();
    expect(yaml).toContain('template:debian-12');
    expect(yaml).toContain('  system: false');
    expect(yaml).toContain('  user: false');
    expect(yaml).toContain('location: "~"');
    expect(yaml).toContain('writable: true');
  });
});

describe('buildProvisionScript', () => {
  it('pins node/srt versions, is idempotent and embeds the shim', () => {
    const script = buildProvisionScript({
      nodeVersion: '24.21.0',
      srtVersion: '0.0.78',
      shimBase64: 'c2hpbQ==',
    });
    expect(script).toContain('WANT_NODE="24.21.0"');
    expect(script).toContain('WANT_SRT="0.0.78"');
    expect(script).toContain('WANT_SHIM_SHA=');
    expect(script).toContain('@anthropic-ai/sandbox-runtime@$WANT_SRT');
    expect(script).toContain('.lima-provisioned');
    expect(script).toContain('base64 -d');
    expect(script).toContain('c2hpbQ==');
  });
});

describe('LimaSetup 状态机', () => {
  it('missing → create → start → provision → selfcheck → ready', async () => {
    const script: FakeScript = { instance: 'missing', record: [] };
    const setup = tempSetup({ script });
    const first = await setup.status();
    expect(first).toMatchObject({ instance: 'missing', action: 'create', phase: 'idle' });

    await setup.prepare({ wait: true });

    const argv = script.record.map((entry) => entry.argv);
    expect(argv.some((args) => args[0] === 'create' && args.includes(LIMA_VM_NAME))).toBe(true);
    expect(argv.some((args) => args[0] === 'start' && args.includes(LIMA_VM_NAME))).toBe(true);
    const provision = script.record.find((entry) => entry.argv.join(' ').includes('bash -s'));
    expect(provision?.input).toContain('sandbox-runtime');
    expect(argv.some((args) => args.join(' ').includes('--selfcheck'))).toBe(true);

    const done = await setup.status();
    expect(done).toMatchObject({ instance: 'running', phase: 'ready', action: 'none' });
  });

  it('stopped VM → start only（不重复创建）', async () => {
    const script: FakeScript = { instance: 'stopped', record: [] };
    const setup = tempSetup({ script });
    await setup.prepare({ wait: true });
    expect(script.record.some((entry) => entry.argv[0] === 'create')).toBe(false);
    expect(script.record.some((entry) => entry.argv[0] === 'start')).toBe(true);
    expect((await setup.status()).phase).toBe('ready');
  });

  it('失败 → failed + retry；再次 prepare 收敛到 ready', async () => {
    const script: FakeScript = { instance: 'missing', createExitCode: 1, record: [] };
    const setup = tempSetup({ script });
    await setup.prepare({ wait: true });
    const failed = await setup.status();
    expect(failed).toMatchObject({ phase: 'failed', action: 'retry' });
    expect(failed.reason).toContain('创建虚拟机失败');

    script.createExitCode = 0;
    await setup.prepare({ wait: true });
    expect((await setup.status()).phase).toBe('ready');
  });

  it('并发 prepare 单飞（只创建一次）', async () => {
    const script: FakeScript = { instance: 'missing', record: [] };
    const setup = tempSetup({ script });
    await Promise.all([setup.prepare(), setup.prepare(), setup.prepare()]);
    await setup.prepare({ wait: true });
    expect(script.record.filter((entry) => entry.argv[0] === 'create')).toHaveLength(1);
  });

  it('缺少 shim 资源 → failed（安装包不完整）', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'kepcup-lima-missing-shim-'));
    homes.push(home);
    const setup = new LimaSetup({
      paths: resolvePaths(home),
      runner: fakeRunner({ instance: 'missing', record: [] }),
      shimPath: path.join(home, 'nope.cjs'),
    });
    await setup.prepare({ wait: true });
    const report = await setup.status();
    expect(report.phase).toBe('failed');
    expect(report.reason).toContain('缺少沙箱 shim');
  });

  it('重启后遗留的进行中 phase 视为可重试失败', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'kepcup-lima-stale-'));
    homes.push(home);
    const paths = resolvePaths(home);
    const shimPath = path.join(home, 'kepcup-sandbox.cjs');
    writeFileSync(shimPath, '#!/bin/sh\n', 'utf8');
    mkdirSync(path.join(home, 'sandbox', 'lima'), { recursive: true });
    writeFileSync(
      path.join(home, 'sandbox', 'lima', 'setup-state.json'),
      JSON.stringify({ phase: 'provisioning', updatedAt: 1 }),
      'utf8',
    );
    const setup = new LimaSetup({
      paths,
      runner: fakeRunner({ instance: 'running', record: [] }),
      shimPath,
    });
    const report = await setup.status();
    expect(report).toMatchObject({ phase: 'failed', action: 'retry' });
  });
});
