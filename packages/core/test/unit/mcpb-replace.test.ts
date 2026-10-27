import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, type McpServer, type Settings } from '@kepcup/shared';
import { buildMcpbFixture } from '@kepcup/testkit';
import { McpbInstaller } from '../../src/apps/mcpb/install.js';

/**
 * MCPB 替换模式（D104 P1-2 步骤 2）：`register.replaceExisting` 的原位替换——id 与数组
 * 位置不变、`enabled` / `toolPolicies` 保留、`autoApprove` 强制 false；敏感 user_config
 * 留空 = 保留已存 secret（内存占位值绝不落盘）、提供新值 = 覆盖、无已存 secret 且必填 =
 * 报缺失；旧解包树在替换后仍由 `releaseIfUnused` 释放（仍被引用则不删）；目标不存在 /
 * 非 plugin 来源 / 别的插件 → NOT_FOUND；无 `replaceExisting` 的既有路径不变。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcpb-replace-'));
  dirs.push(dir);
  return dir;
}

interface Harness {
  installer: McpbInstaller;
  home: string;
  servers: McpServer[];
  secrets: Map<string, string>;
}

async function harness(options: { secretsHasValue?: boolean } = {}): Promise<Harness> {
  const home = await tmp();
  const servers: McpServer[] = [];
  const secrets = new Map<string, string>();
  const settings = {
    get: () => ({ mcpServers: servers }) as unknown as Settings,
    update: (patch: Partial<Settings>) => {
      if (patch.mcpServers !== undefined) {
        servers.splice(0, servers.length, ...patch.mcpServers);
      }
      return { mcpServers: servers } as unknown as Settings;
    },
  };
  const installer = new McpbInstaller({
    paths: { toolchainsDir: path.join(home, 'toolchains') },
    settings,
    secrets: {
      setValue: (name, value) => void secrets.set(name, value),
      removeByPrefix: (prefix) => {
        const removed = [...secrets.keys()].filter((name) => name.startsWith(prefix));
        for (const name of removed) secrets.delete(name);
        return removed;
      },
      // Default: the real SecretsService.hasValue is wired (start.ts); the absent case is
      // its own test (an un-wired host treats every stored secret as non-existent).
      ...(options.secretsHasValue === false ? {} : { hasValue: (name) => secrets.has(name) }),
    },
    logger,
    homeDir: '/home/tester',
    platform: 'linux',
    arch: 'x64',
    resolveRuntime: (kind) =>
      kind === 'node' ? { command: '/managed/node/bin/node', version: '24.21.0' } : null,
  });
  return { installer, home, servers, secrets };
}

const SENSITIVE_MANIFEST = {
  server: {
    type: 'node',
    entry_point: 'server/index.cjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.cjs'],
      env: { API_KEY: '${user_config.api_key}' },
    },
  },
  user_config: {
    api_key: { type: 'string', title: 'API Key', sensitive: true, required: true },
  },
};

const PLUGIN_ID = 'io.github.tester/updater';
const SERVER_ID = 'plg_replace0001';

/** `echo-bundle` 的两个内容代次（版本不同 → 解包槽位不同）。 */
async function bundle(dir: string, generation: 'v1' | 'v2') {
  const version = generation === 'v1' ? '1.0.0' : '2.0.0';
  return buildMcpbFixture({
    dir,
    fileName: `echo-bundle-${generation}.mcpb`,
    manifest: {
      ...SENSITIVE_MANIFEST,
      name: 'echo-bundle',
      version,
      description: `bundle ${generation}`,
    },
  });
}

/** Registration for the given generation, bound to the bundle's real sha256. */
function registration(generation: 'v1' | 'v2', sha256: string, replaceExisting: boolean) {
  const version = generation === 'v1' ? '1.0.0' : '2.0.0';
  return {
    serverId: SERVER_ID,
    source: {
      kind: 'plugin',
      pluginId: PLUGIN_ID,
      version,
      key: 'dbtools',
      mcpb: { name: 'echo-bundle', version, sha256 },
    },
    tier: 'developer' as const,
    name: 'DB Tools',
    ...(replaceExisting ? { replaceExisting: true as const } : {}),
  };
}

const fresh = (generation: 'v1' | 'v2', sha256: string) => registration(generation, sha256, false);
const replace = (generation: 'v1' | 'v2', sha256: string) => registration(generation, sha256, true);

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

/**
 * 同槽（同名同版本）不同内容的替换现场：槽位已被新内容占用，旧树完整停在旁边的
 * `.rb-` 备份里。这是唯一一条 `#extract` 会覆盖旧树、因而必须先停放的替换路径。
 */
async function parkedSameSlotHarness(): Promise<{
  h: Harness;
  slot: string;
  siblings: string[];
  oldPkg: { name: string; version: string; sha256: string };
  newSha: string;
}> {
  const h = await harness();
  const v1 = await bundle(h.home, 'v1');
  const r1 = await h.installer.inspect(v1.path);
  await h.installer.install({
    filePath: v1.path,
    sha256: r1.sha256,
    userConfig: { api_key: 'sk-1' },
    register: fresh('v1', r1.sha256),
  });
  const v1b = await buildMcpbFixture({
    dir: h.home,
    fileName: 'echo-bundle-v1b.mcpb',
    manifest: {
      ...SENSITIVE_MANIFEST,
      name: 'echo-bundle',
      version: '1.0.0',
      description: 'rebuilt at the same version',
    },
  });
  const r1b = await h.installer.inspect(v1b.path);
  expect(r1b.sha256).not.toBe(r1.sha256);
  const reg = replace('v1', r1b.sha256);
  reg.source = {
    kind: 'plugin',
    pluginId: PLUGIN_ID,
    version: '1.0.0',
    key: 'dbtools',
    mcpb: { name: 'echo-bundle', version: '1.0.0', sha256: r1b.sha256 },
  };
  await h.installer.install({
    filePath: v1b.path,
    sha256: r1b.sha256,
    userConfig: {},
    register: reg,
  });

  const slot = h.installer.installDirOf('echo-bundle', '1.0.0');
  // 槽位现在是新内容；旧树被完整停放在旁边的 .rb- 备份里（回滚仍需要它）
  expect(
    await h.installer.verify({ name: 'echo-bundle', version: '1.0.0', sha256: r1b.sha256 }),
  ).toEqual({ ok: true });
  const siblings = (await readdir(path.dirname(slot))).filter((entry) =>
    entry.startsWith('echo-bundle@1.0.0.rb-'),
  );
  expect(siblings).toHaveLength(1);
  expect(
    await h.installer.verify({ name: 'echo-bundle', version: '1.0.0', sha256: r1.sha256 }),
  ).toEqual({ ok: false, reason: '安装目录与记录的包不一致' });
  return {
    h,
    slot,
    siblings,
    oldPkg: { name: 'echo-bundle', version: '1.0.0', sha256: r1.sha256 },
    newSha: r1b.sha256,
  };
}

describe('McpbInstaller replaceExisting', () => {
  it('替换：id 与位置不变，enabled / toolPolicies 保留，autoApprove 强制 false；新树存在、旧树仍在', async () => {
    const h = await harness();
    const v1 = await bundle(h.home, 'v1');
    const v2 = await bundle(h.home, 'v2');
    const r1 = await h.installer.inspect(v1.path);
    const r2 = await h.installer.inspect(v2.path);
    await h.installer.install({
      filePath: v1.path,
      sha256: r1.sha256,
      userConfig: { api_key: 'sk-old' },
      register: fresh('v1', r1.sha256),
    });
    // Simulate the user's accumulated state on the old server.
    const old = h.servers[0]!;
    old.enabled = false;
    old.autoApprove = true;
    old.toolPolicies = { dangerous: { mode: 'ask' } };
    // An unrelated server AFTER the target: its position must survive the in-place replace.
    h.servers.push({ ...old, id: 'plg_unrelated1', source: undefined } as McpServer);

    const { serverId } = await h.installer.install({
      filePath: v2.path,
      sha256: r2.sha256,
      userConfig: {},
      register: replace('v2', r2.sha256),
    });

    expect(serverId).toBe(SERVER_ID);
    expect(h.servers).toHaveLength(2); // no append — replaced in place
    expect(h.servers[1]!.id).toBe('plg_unrelated1');
    const replaced = h.servers[0]!;
    expect(replaced.id).toBe(SERVER_ID);
    expect(replaced.enabled).toBe(false);
    expect(replaced.toolPolicies).toEqual({ dangerous: { mode: 'ask' } });
    expect(replaced.autoApprove).toBe(false);
    expect(replaced.source).toMatchObject({
      kind: 'plugin',
      pluginId: PLUGIN_ID,
      version: '2.0.0',
      mcpb: { name: 'echo-bundle', version: '2.0.0' },
    });
    // The new tree exists; the old tree is still there (a rollback may need it).
    expect(existsSync(h.installer.installDirOf('echo-bundle', '2.0.0'))).toBe(true);
    expect(existsSync(h.installer.installDirOf('echo-bundle', '1.0.0'))).toBe(true);
  });

  it('敏感字段留空：secret 值未变，env 仍是 secret:env:KEY 占位符；提供新值则覆盖', async () => {
    const h = await harness();
    const v1 = await bundle(h.home, 'v1');
    const v2 = await bundle(h.home, 'v2');
    const r1 = await h.installer.inspect(v1.path);
    const r2 = await h.installer.inspect(v2.path);
    const secretName = `mcp:${SERVER_ID}:env:api_key`;

    await h.installer.install({
      filePath: v1.path,
      sha256: r1.sha256,
      userConfig: { api_key: 'sk-keep-me' },
      register: fresh('v1', r1.sha256),
    });

    // Leave the field empty: the stored secret survives, the env stays a placeholder.
    await h.installer.install({
      filePath: v2.path,
      sha256: r2.sha256,
      userConfig: {},
      register: replace('v2', r2.sha256),
    });
    expect(h.secrets.get(secretName)).toBe('sk-keep-me');
    expect(h.servers[0]!.env).toEqual({ API_KEY: 'secret:env:api_key' });

    // Provide a new value: the secret is overwritten.
    const v2b = await buildMcpbFixture({
      dir: h.home,
      fileName: 'echo-bundle-v2b.mcpb',
      manifest: { ...SENSITIVE_MANIFEST, name: 'echo-bundle', version: '2.1.0' },
    });
    const r2b = await h.installer.inspect(v2b.path);
    const reg = replace('v2', r2b.sha256);
    reg.source = {
      kind: 'plugin',
      pluginId: PLUGIN_ID,
      version: '2.1.0',
      key: 'dbtools',
      mcpb: { name: 'echo-bundle', version: '2.1.0', sha256: r2b.sha256 },
    };
    await h.installer.install({
      filePath: v2b.path,
      sha256: r2b.sha256,
      userConfig: { api_key: 'sk-rotated' },
      register: reg,
    });
    expect(h.secrets.get(secretName)).toBe('sk-rotated');
    expect(h.servers[0]!.env).toEqual({ API_KEY: 'secret:env:api_key' });
  });

  it('敏感字段留空且 hasValue 缺省（未注入）：视为不存在 → 报缺失', async () => {
    const h = await harness({ secretsHasValue: false }); // no hasValue: treats secrets as absent
    const v1 = await bundle(h.home, 'v1');
    const r1 = await h.installer.inspect(v1.path);
    h.secrets.set(`mcp:${SERVER_ID}:env:api_key`, 'sk-unseen'); // value exists, unknown to installer
    h.servers.push({
      id: SERVER_ID,
      name: 'DB Tools',
      transport: 'stdio',
      command: 'node',
      args: [],
      enabled: true,
      autoApprove: false,
      auth: 'none',
      source: {
        kind: 'plugin',
        pluginId: PLUGIN_ID,
        version: '1.0.0',
        key: 'dbtools',
        mcpb: { name: 'echo-bundle', version: '1.0.0', sha256: r1.sha256 },
      },
      tier: 'developer',
    });
    const error = await expectCode(
      h.installer.install({
        filePath: v1.path,
        sha256: r1.sha256,
        userConfig: {},
        register: replace('v1', r1.sha256),
      }),
      'MCPB_INVALID',
    );
    expect(error.message).toContain('API Key');
    expect(h.secrets.get(`mcp:${SERVER_ID}:env:api_key`)).toBe('sk-unseen');
  });

  it('敏感必填留空且没有已存 secret → 报缺失', async () => {
    const h = await harness();
    const v1 = await bundle(h.home, 'v1');
    const r1 = await h.installer.inspect(v1.path);
    h.servers.push({
      id: SERVER_ID,
      name: 'DB Tools',
      transport: 'stdio',
      command: 'node',
      args: [],
      enabled: true,
      autoApprove: false,
      auth: 'none',
      source: {
        kind: 'plugin',
        pluginId: PLUGIN_ID,
        version: '1.0.0',
        key: 'dbtools',
        mcpb: { name: 'echo-bundle', version: '1.0.0', sha256: r1.sha256 },
      },
      tier: 'developer',
    });
    const error = await expectCode(
      h.installer.install({
        filePath: v1.path,
        sha256: r1.sha256,
        userConfig: {},
        register: replace('v1', r1.sha256),
      }),
      'MCPB_INVALID',
    );
    expect(error.message).toContain('API Key');
  });

  it('replaceExisting 对不存在 / 非 plugin 来源 / 别的 pluginId 的 server → NOT_FOUND', async () => {
    const h = await harness();
    const v1 = await bundle(h.home, 'v1');
    const r1 = await h.installer.inspect(v1.path);
    const reg = replace('v1', r1.sha256);

    // No server at all.
    await expectCode(
      h.installer.install({ filePath: v1.path, sha256: r1.sha256, register: reg }),
      'NOT_FOUND',
    );

    // Same id, but a non-plugin source.
    h.servers.push({
      id: SERVER_ID,
      name: 'Manual',
      transport: 'stdio',
      command: 'node',
      args: [],
      enabled: true,
      autoApprove: false,
      auth: 'none',
      source: { kind: 'mcpb', name: 'echo-bundle', version: '1.0.0', sha256: r1.sha256 },
      tier: 'developer',
    });
    await expectCode(
      h.installer.install({ filePath: v1.path, sha256: r1.sha256, register: reg }),
      'NOT_FOUND',
    );

    // Same id, plugin source, but a DIFFERENT plugin owns it.
    h.servers[0]!.source = {
      kind: 'plugin',
      pluginId: 'io.github.other/who',
      version: '1.0.0',
      key: 'dbtools',
      mcpb: { name: 'echo-bundle', version: '1.0.0', sha256: r1.sha256 },
    };
    await expectCode(
      h.installer.install({ filePath: v1.path, sha256: r1.sha256, register: reg }),
      'NOT_FOUND',
    );
    expect(h.servers[0]!.name).toBe('Manual'); // nothing was replaced
  });

  it('releaseIfUnused：仍被引用的包不删，无引用的旧树释放，marker 不符不动', async () => {
    const h = await harness();
    const v1 = await bundle(h.home, 'v1');
    const v2 = await bundle(h.home, 'v2');
    const r1 = await h.installer.inspect(v1.path);
    const r2 = await h.installer.inspect(v2.path);
    await h.installer.install({
      filePath: v1.path,
      sha256: r1.sha256,
      userConfig: { api_key: 'x' },
      register: fresh('v1', r1.sha256),
    });
    await h.installer.install({
      filePath: v2.path,
      sha256: r2.sha256,
      userConfig: { api_key: 'x' },
      register: replace('v2', r2.sha256),
    });
    const oldPkg = { name: 'echo-bundle', version: '1.0.0', sha256: r1.sha256 };
    const oldDir = h.installer.installDirOf('echo-bundle', '1.0.0');
    expect(existsSync(oldDir)).toBe(true);

    // Another server still references the old package → kept.
    h.servers.push({
      ...(h.servers[0] as McpServer),
      id: 'plg_bystander1',
      source: { kind: 'mcpb', ...oldPkg },
    } as McpServer);
    await h.installer.releaseIfUnused(oldPkg);
    expect(existsSync(oldDir)).toBe(true);

    // Reference gone → released.
    h.servers.pop();
    await h.installer.releaseIfUnused(oldPkg);
    expect(existsSync(oldDir)).toBe(false);

    // A marker mismatch (wrong sha) is never removed.
    await h.installer.releaseIfUnused({ ...oldPkg, sha256: 'a'.repeat(64) });
    expect(existsSync(h.installer.installDirOf('echo-bundle', '2.0.0'))).toBe(true);
  });

  it('同槽不同内容替换：旧树停进 .rb- 备份，槽位被新内容占用', async () => {
    await parkedSameSlotHarness(); // 断言都在 helper 里
  });

  it('同槽替换后 restoreRollbackBackup：旧内容回到原槽位，备份被消费', async () => {
    const parked = await parkedSameSlotHarness();
    expect(await parked.h.installer.restoreRollbackBackup(parked.oldPkg)).toBe(true);
    expect(await parked.h.installer.verify(parked.oldPkg)).toEqual({ ok: true });
    expect(existsSync(path.join(path.dirname(parked.slot), parked.siblings[0]!))).toBe(false);
  });

  it('同槽替换后 discardRollbackBackups：备份被清理，槽位保持新内容', async () => {
    const parked = await parkedSameSlotHarness();
    await parked.h.installer.discardRollbackBackups(parked.oldPkg);
    expect(
      (await readdir(path.dirname(parked.slot))).filter((entry) =>
        entry.startsWith('echo-bundle@1.0.0.rb-'),
      ),
    ).toHaveLength(0);
    expect(
      await parked.h.installer.verify({
        name: 'echo-bundle',
        version: '1.0.0',
        sha256: parked.newSha,
      }),
    ).toEqual({ ok: true });
  });

  it('无 replaceExisting：id 已存在仍报 ALREADY_EXISTS（既有路径不变）', async () => {
    const h = await harness();
    const v1 = await bundle(h.home, 'v1');
    const r1 = await h.installer.inspect(v1.path);
    await h.installer.install({
      filePath: v1.path,
      sha256: r1.sha256,
      userConfig: { api_key: 'x' },
      register: fresh('v1', r1.sha256),
    });
    const repeat = { ...fresh('v1', r1.sha256) };
    await expectCode(
      h.installer.install({
        filePath: v1.path,
        sha256: r1.sha256,
        userConfig: { api_key: 'x' },
        register: repeat,
      }),
      'ALREADY_EXISTS',
    );
  });
});
