import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, openDirect, startFileServer, waitFor, type TestStack } from '@kepcup/testkit';
import type { EnvInstall } from '@kepcup/shared';
import type { Catalog } from '../../src/env/catalog.js';
import type { DistroToolchainInstaller } from '../../src/env/distro.js';
import { DISTRO_TOOLCHAINS_PREFIX, distroToolchainDir } from '../../src/env/distro.js';
import type { CoreHarness } from '../../src/index.js';

/**
 * P12 发行版内工具链安装（任务书「工具链」）：Windows 主机上 wslDistro 条目
 * （node/python）经 EnvManager 装进私有发行版。注入 fake distroInstaller +
 * 本地文件服务器（绝不触真实网络）；`platform: 'win32'` 注入使发行版分支在
 * mac 上可达。真实 wsl.exe 上的完整安装列
 * todo/cross-platform-acceptance.md P12。
 */

const stacks: TestStack[] = [];
const fileServers: Array<{ stop(): Promise<void> }> = [];
const tempHomes: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const server of fileServers.splice(0)) await server.stop();
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A tar.gz whose root holds bin/node printing a version line. */
function fakeNodeArchive(dir: string): { buffer: Buffer; sha256: string } {
  const root = path.join(dir, 'node-fake');
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  const script = path.join(root, 'bin', 'node');
  writeFileSync(script, '#!/bin/sh\necho "node 1.0.0"\n');
  chmodSync(script, 0o755);
  const archive = path.join(dir, 'node.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', dir, 'node-fake']);
  const buffer = execFileSync('cat', [archive]);
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

interface RecordingInstaller extends DistroToolchainInstaller {
  extracts: Array<{ hostDir: string; distroDir: string }>;
  uvInstalls: Array<{ pythonVersion: string; distroDir: string }>;
  verifies: Array<{ command: string; expect: string; binName: string; binDir: string; targetDir: string }>;
  removes: string[];
  ready: boolean;
}

function fakeDistroInstaller(): RecordingInstaller {
  const installer: RecordingInstaller = {
    extracts: [],
    uvInstalls: [],
    verifies: [],
    removes: [],
    ready: true,
    async available() {
      return installer.ready;
    },
    async extractDir(hostDir, distroDir) {
      installer.extracts.push({ hostDir, distroDir });
    },
    async installPythonViaUv(input) {
      installer.uvInstalls.push(input);
      return `${input.distroDir}/cpython-1/bin`;
    },
    async verify(input) {
      installer.verifies.push(input);
    },
    async removeDir(distroDir) {
      installer.removes.push(distroDir);
    },
  };
  return installer;
}

/** wslDistro catalog: linux-arm64 artifact on the local file server. */
function distroCatalog(archiveUrl: string, sha256: string, sizeBytes: number): Catalog {
  return [
    {
      item: 'node',
      version: '1.0.0',
      displayName: 'Node',
      source: archiveUrl,
      install: { via: 'archive' },
      wslDistro: true,
      platforms: {
        // 主机条目（审批卡片的平台键）；发行版安装走 linux-arm64 产物。
        'darwin-arm64': { url: archiveUrl, sha256, sizeBytes, kind: 'archive' },
        'linux-arm64': { url: archiveUrl, sha256, sizeBytes, kind: 'archive' },
      },
      verify: { command: '"{bin}" --version', expect: 'node 1.0.0' },
    },
  ];
}

async function requestNodeInstall(core: CoreHarness, botId: string, conversationId: string): Promise<void> {
  const outcome = await core.services.environment!.request(
    { runId: 'run_distro', botId, conversationId, loopType: 'turn' },
    { item: 'node', reason: 'distro toolchain' },
  );
  if (outcome.status === 'submitted') {
    await core.rpc.call('approvals.decide', { id: outcome.approvalId, approve: true });
  }
  expect(['submitted', 'installing']).toContain(outcome.status);
}

function waitForInstall(core: CoreHarness, status: 'installed' | 'failed'): Promise<EnvInstall> {
  return waitFor(
    async () => {
      const result = (await core.rpc.call('environment.list', void 0)) as {
        installs: EnvInstall[];
      };
      return result.installs.find((entry) => entry.item === 'node' && entry.status === status) ?? null;
    },
    { label: `distro install ${status}`, timeoutMs: 60_000 },
  );
}

describe('P12 发行版内工具链安装（fake distroInstaller + platform win32 注入）', () => {
  it('node：linux 产物 → 校验 → 移入发行版 → 行 rel_path 为发行版 bin → 前缀注入', async () => {
    const installer = fakeDistroInstaller();
    const staging = mkdtempSync(path.join(os.tmpdir(), 'kepcup-distro-arc-'));
    tempHomes.push(staging);
    const { buffer, sha256 } = fakeNodeArchive(staging);
    const fileServer = await startFileServer({ 'node.tar.gz': buffer });
    fileServers.push(fileServer);
    const stack = await createTestStack({
      envCatalog: distroCatalog(`${fileServer.url}/node.tar.gz`, sha256, buffer.length),
      distroInstaller: installer,
      platform: 'win32',
    });
    stacks.push(stack);
    const bot = await makeBot(stack.core, '阿node');
    const conversation = await openDirect(stack.core, bot.id);
    await requestNodeInstall(stack.core, bot.id, conversation.id);

    const install = await waitForInstall(stack.core, 'installed');
    expect(install.relPath).toBe('/opt/kepcup/toolchains/node/1.0.0/bin');
    expect(install.binDirs).toEqual(['/opt/kepcup/toolchains/node/1.0.0/bin']);

    // 提取调用落在发行版工具链根下；发行版内验证执行（宿主不能跑 linux 二进制）。
    expect(installer.extracts).toHaveLength(1);
    expect(installer.extracts[0]!.distroDir).toBe(distroToolchainDir('node', '1.0.0'));
    expect(installer.extracts[0]!.distroDir.startsWith(DISTRO_TOOLCHAINS_PREFIX)).toBe(true);
    expect(installer.verifies).toHaveLength(1);
    expect(installer.verifies[0]!.expect).toBe('node 1.0.0');

    // WSL 后端的 PATH 前缀拿到发行版 bin 目录。
    const prefix = stack.core.services.environment!.distroToolchainPathPrefix();
    expect(prefix).toBe('/opt/kepcup/toolchains/node/1.0.0/bin');
  }, 60_000);

  it('发行版未就绪：行 failed 且不产生任何提取/验证调用', async () => {
    const installer = fakeDistroInstaller();
    installer.ready = false;
    const staging = mkdtempSync(path.join(os.tmpdir(), 'kepcup-distro-arc-'));
    tempHomes.push(staging);
    const { buffer, sha256 } = fakeNodeArchive(staging);
    const fileServer = await startFileServer({ 'node.tar.gz': buffer });
    fileServers.push(fileServer);
    const stack = await createTestStack({
      envCatalog: distroCatalog(`${fileServer.url}/node.tar.gz`, sha256, buffer.length),
      distroInstaller: installer,
      platform: 'win32',
    });
    stacks.push(stack);
    const bot = await makeBot(stack.core, '阿fail');
    const conversation = await openDirect(stack.core, bot.id);
    await requestNodeInstall(stack.core, bot.id, conversation.id);
    await waitForInstall(stack.core, 'failed');
    expect(installer.extracts).toHaveLength(0);
    expect(installer.verifies).toHaveLength(0);
  }, 60_000);

  it('发行版行的 remove 走 removeDir（发行版内删除）', async () => {
    const installer = fakeDistroInstaller();
    const staging = mkdtempSync(path.join(os.tmpdir(), 'kepcup-distro-arc-'));
    tempHomes.push(staging);
    const { buffer, sha256 } = fakeNodeArchive(staging);
    const fileServer = await startFileServer({ 'node.tar.gz': buffer });
    fileServers.push(fileServer);
    const stack = await createTestStack({
      envCatalog: distroCatalog(`${fileServer.url}/node.tar.gz`, sha256, buffer.length),
      distroInstaller: installer,
      platform: 'win32',
    });
    stacks.push(stack);
    const bot = await makeBot(stack.core, '阿rm');
    const conversation = await openDirect(stack.core, bot.id);
    await requestNodeInstall(stack.core, bot.id, conversation.id);
    const install = await waitForInstall(stack.core, 'installed');
    await stack.core.rpc.call('environment.remove', { id: install.id });
    await waitFor(
      async () => (installer.removes.length > 0 ? installer.removes : null),
      { label: 'distro removeDir called' },
    );
    expect(installer.removes[0]).toBe('/opt/kepcup/toolchains/node/1.0.0');
  }, 60_000);
});
