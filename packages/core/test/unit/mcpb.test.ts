import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, type McpServer, type Settings } from '@kepcup/shared';
import { buildMcpbFixture, buildZip, defaultMcpbManifest } from '@kepcup/testkit';
import {
  checkCompatibility,
  formatLaunch,
  manifestFields,
  McpbInstaller,
  parseMcpbManifest,
  renderLaunch,
  satisfiesRange,
  validateUserConfig,
  type McpbInstallerDeps,
} from '../../src/apps/mcpb/index.js';

/**
 * MCPB（D73 P2 §6.5）单测：manifest 解析与兼容性、启动模板、zip 安全（zip-slip / 符号链接 /
 * 绝对路径）、sha256 绑定、安装产物（settings / secrets / 解包目录 / 标记文件）、卸载、
 * 审批卡 payload。运行时与 settings / secrets 用内存替身，不碰环境管理器。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcpb-unit-'));
  dirs.push(dir);
  return dir;
}

interface Harness {
  installer: McpbInstaller;
  home: string;
  servers: McpServer[];
  secrets: Map<string, string>;
  approvals: Array<Record<string, unknown>>;
  settingsJson(): string;
}

async function harness(
  overrides: Partial<McpbInstallerDeps> & { approve?: boolean } = {},
): Promise<Harness> {
  const home = await tmp();
  const servers: McpServer[] = [];
  const secrets = new Map<string, string>();
  const approvals: Array<Record<string, unknown>> = [];
  const settings = {
    get: () => ({ mcpServers: servers }) as unknown as Settings,
    update: (patch: Partial<Settings>) => {
      if (patch.mcpServers !== undefined) {
        servers.splice(0, servers.length, ...patch.mcpServers);
      }
      return { mcpServers: servers } as unknown as Settings;
    },
  };
  const deps: McpbInstallerDeps = {
    paths: { toolchainsDir: path.join(home, 'toolchains') },
    settings,
    secrets: {
      setValue: (name, value) => void secrets.set(name, value),
      removeByPrefix: (prefix) => {
        const removed = [...secrets.keys()].filter((name) => name.startsWith(prefix));
        for (const name of removed) secrets.delete(name);
        return removed;
      },
    },
    logger,
    homeDir: '/home/tester',
    platform: 'linux',
    arch: 'x64',
    resolveRuntime: (kind) =>
      kind === 'node' ? { command: '/managed/node/bin/node', version: '24.21.0' } : null,
    requestApproval: async (_context, payload) => {
      approvals.push(payload);
      return overrides.approve !== false;
    },
    ...overrides,
  };
  return {
    installer: new McpbInstaller(deps),
    home,
    servers,
    secrets,
    approvals,
    settingsJson: () => JSON.stringify(servers),
  };
}

async function expectCode(promise: Promise<unknown>, code: string, match?: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  if (match !== undefined) expect((error as AppError).message).toMatch(match);
}

describe('mcpb manifest', () => {
  it('parses a valid manifest and exposes user_config fields', () => {
    const manifest = parseMcpbManifest({
      ...defaultMcpbManifest(),
      user_config: {
        api_key: { type: 'string', title: 'API Key', sensitive: true, required: true },
        port: { type: 'number', title: 'Port', default: 8080, min: 1, max: 65535 },
      },
    });
    expect(manifest.name).toBe('echo-bundle');
    expect(manifestFields(manifest).map((f) => [f.key, f.sensitive, f.required])).toEqual([
      ['api_key', true, true],
      ['port', false, false],
    ]);
  });

  it('reports readable errors', () => {
    const bad = (patch: Record<string, unknown>) => () =>
      parseMcpbManifest({ ...defaultMcpbManifest(), ...patch });
    expect(() => parseMcpbManifest('{not json')).toThrow(/不是合法的 JSON/);
    expect(bad({ name: '../evil' })).toThrow(/name：/);
    expect(bad({ version: 'a/b' })).toThrow(/version：/);
    expect(bad({ manifest_version: '9.9' })).toThrow(/不支持的 manifest_version：9\.9/);
    expect(bad({ manifest_version: undefined })).toThrow(/缺少 manifest_version/);
    expect(bad({ server: { type: 'node', entry_point: 'a.js' } })).toThrow(
      /缺少 server\.mcp_config/,
    );
    expect(bad({ server: { type: 'node' } })).toThrow(/server\.entry_point/);
    expect(
      bad({
        server: {
          type: 'node',
          entry_point: 'a.js',
          mcp_config: { command: 'node', args: ['${user_config.nope}'] },
        },
      }),
    ).toThrow(/未声明的 user_config\.nope/);
    expect(
      bad({
        server: { type: 'node', entry_point: 'a.js', mcp_config: { command: '${WHAT}' } },
      }),
    ).toThrow(/不认识的变量/);
    expect(bad({ user_config: { 'bad key': { type: 'string', title: 'x' } } })).toThrow(
      /键名不合法/,
    );
    expect(bad({ user_config: { k: { type: 'array', title: 'x' } } })).toThrow(
      /user_config\.k\.type/,
    );
  });

  it('checks platform, runtime version and server.type compatibility', () => {
    const manifest = parseMcpbManifest({
      ...defaultMcpbManifest(),
      compatibility: { platforms: ['darwin'], runtimes: { node: '>=26.0.0' } },
    });
    const platform = checkCompatibility(manifest, { platform: 'linux' });
    expect(platform).toEqual({
      ok: false,
      reason: expect.stringMatching(/只支持 darwin.*当前系统是 linux/),
    });
    const runtime = checkCompatibility(manifest, {
      platform: 'darwin',
      runtimes: { node: '24.21.0' },
    });
    expect(runtime).toEqual({
      ok: false,
      reason: expect.stringMatching(/需要 node >=26\.0\.0.*24\.21\.0/),
    });
    expect(
      checkCompatibility(manifest, { platform: 'darwin', runtimes: { node: '26.1.0' } }),
    ).toEqual({
      ok: true,
    });
    const ruby = parseMcpbManifest({
      ...defaultMcpbManifest(),
      server: { type: 'ruby', entry_point: 'a.rb', mcp_config: { command: 'ruby' } },
    });
    expect(checkCompatibility(ruby, { platform: 'linux' })).toEqual({
      ok: false,
      reason: expect.stringMatching(/不支持的 server\.type：ruby/),
    });
  });

  it('satisfiesRange handles comparator sets', () => {
    expect(satisfiesRange('24.1.0', '>=18')).toBe(true);
    expect(satisfiesRange('24.1.0', '>=18 <22')).toBe(false);
    expect(satisfiesRange('18.4.0', '^18.2.0')).toBe(true);
    expect(satisfiesRange('19.0.0', '^18.2.0')).toBe(false);
    expect(satisfiesRange('3.12.11', '~3.12')).toBe(true);
    expect(satisfiesRange('3.13.0', '~3.12')).toBe(false);
  });

  it('renders launch commands: preview keeps user_config, install substitutes and masks secrets', () => {
    const manifest = parseMcpbManifest({
      ...defaultMcpbManifest(),
      server: {
        type: 'node',
        entry_point: 'server/index.cjs',
        mcp_config: {
          command: 'node',
          args: [
            '${__dirname}/server/index.cjs',
            '--root',
            '${user_config.root}',
            '${user_config.extra}',
          ],
          env: { API_TOKEN: '${user_config.api_key}', MODE: 'fast-${user_config.mode}' },
        },
      },
      user_config: {
        api_key: { type: 'string', title: 'k', sensitive: true },
        root: { type: 'directory', title: 'r' },
        extra: { type: 'string', title: 'e', multiple: true },
        mode: { type: 'string', title: 'm' },
      },
    });
    const base = { dir: '/data/mcpb/x@1', home: '/home/u', platform: 'linux' };
    const preview = renderLaunch(manifest, {
      ...base,
      mode: 'preview',
      commandOverride: '/m/node',
    });
    expect(formatLaunch(preview)).toBe(
      'API_TOKEN=${user_config.api_key} MODE=fast-${user_config.mode} /m/node /data/mcpb/x@1/server/index.cjs --root ${user_config.root} ${user_config.extra}',
    );
    const values = validateUserConfig(manifestFields(manifest), {
      api_key: 'sk-secret',
      root: '/work',
      extra: ['a', 'b'],
      mode: 'x',
    });
    const spec = renderLaunch(manifest, { ...base, mode: 'install', values });
    expect(spec.args).toEqual(['/data/mcpb/x@1/server/index.cjs', '--root', '/work', 'a', 'b']);
    expect(spec.env).toEqual({ API_TOKEN: 'secret:env:api_key', MODE: 'fast-x' });
    expect(JSON.stringify(spec)).not.toContain('sk-secret');
    expect(formatLaunch(spec, new Set(['api_key']))).toContain('API_TOKEN=***');
  });

  it('refuses a sensitive value embedded in a longer string', () => {
    const manifest = parseMcpbManifest({
      ...defaultMcpbManifest(),
      server: {
        type: 'node',
        entry_point: 'server/index.cjs',
        mcp_config: { command: 'node', args: ['--token=${user_config.t}'] },
      },
      user_config: { t: { type: 'string', title: 't', sensitive: true } },
    });
    expect(() =>
      renderLaunch(manifest, {
        dir: '/d',
        home: '/h',
        platform: 'linux',
        mode: 'install',
        values: { t: 'secret' },
      }),
    ).toThrow(/只能整体作为/);
  });

  it('validates user_config values', () => {
    const fields = manifestFields(
      parseMcpbManifest({
        ...defaultMcpbManifest(),
        user_config: {
          name: { type: 'string', title: '名称', required: true },
          port: { type: 'number', title: '端口', min: 1, max: 100 },
          dir: { type: 'directory', title: '目录' },
        },
      }),
    );
    expect(() => validateUserConfig(fields, {})).toThrow(/请填写必填配置项：名称/);
    expect(() => validateUserConfig(fields, { name: 'a', port: 500 })).toThrow(/端口 不能大于 100/);
    expect(() => validateUserConfig(fields, { name: 'a', dir: 'relative' })).toThrow(/绝对路径/);
    expect(() => validateUserConfig(fields, { name: 'a', other: 'x' })).toThrow(
      /未声明的配置项：other/,
    );
    expect(validateUserConfig(fields, { name: 'a', port: '8' })).toEqual({ name: 'a', port: 8 });
  });
});

describe('mcpb archive safety', () => {
  it('rejects zip-slip, absolute, backslash and symlink entries', async () => {
    const h = await harness();
    const dir = await tmp();
    const cases: Array<[string, { name: string; symlink?: boolean }, RegExp]> = [
      ['slip', { name: '../evil.txt' }, /路径不安全/],
      ['nested-slip', { name: 'a/../../evil.txt' }, /路径不安全/],
      ['absolute', { name: '/etc/passwd' }, /绝对路径/],
      ['drive', { name: 'C:/x' }, /绝对路径/],
      ['backslash', { name: 'a\\b' }, /反斜杠/],
      ['symlink', { name: 'server/link', symlink: true }, /符号链接/],
    ];
    for (const [label, entry, match] of cases) {
      const fixture = await buildMcpbFixture({
        dir,
        fileName: `${label}.mcpb`,
        extraEntries: [{ ...entry, data: 'x' }],
      });
      await expectCode(h.installer.inspect(fixture.path), 'MCPB_INVALID', match);
    }
    expect(existsSync(path.join(h.home, 'evil.txt'))).toBe(false);
  });

  it('rejects duplicate paths, a missing manifest and a missing entry point', async () => {
    const h = await harness();
    const dir = await tmp();
    const dup = await buildMcpbFixture({
      dir,
      fileName: 'dup.mcpb',
      extraEntries: [{ name: 'Server/Index.cjs', data: 'x' }],
    });
    await expectCode(h.installer.inspect(dup.path), 'MCPB_INVALID', /重复路径/);
    const none = await buildMcpbFixture({ dir, fileName: 'none.mcpb', omitManifest: true });
    await expectCode(h.installer.inspect(none.path), 'MCPB_INVALID', /没有 manifest\.json/);
    const entry = await buildMcpbFixture({
      dir,
      fileName: 'entry.mcpb',
      manifest: {
        server: { type: 'node', entry_point: 'missing.js', mcp_config: { command: 'node' } },
      },
    });
    await expectCode(
      h.installer.inspect(entry.path),
      'MCPB_INVALID',
      /entry_point 指向的文件不在包内/,
    );
    const junk = path.join(dir, 'junk.mcpb');
    await writeFile(junk, 'not a zip at all, definitely not');
    await expectCode(h.installer.inspect(junk), 'MCPB_INVALID', /ZIP/);
  });

  it('detects a corrupted entry (crc mismatch) at extraction', async () => {
    const h = await harness();
    const dir = await tmp();
    const bytes = buildZip([
      { name: 'manifest.json', data: JSON.stringify(defaultMcpbManifest()), deflate: false },
    ]);
    // Flip a payload byte: the stored CRC no longer matches.
    const index = bytes.indexOf('echo-bundle');
    bytes[index] = bytes[index]! ^ 0xff;
    const file = path.join(dir, 'corrupt.mcpb');
    await writeFile(file, bytes);
    await expectCode(h.installer.inspect(file), 'MCPB_INVALID', /校验失败/);
  });
});

describe('mcpb install / uninstall', () => {
  const userConfigManifest = {
    server: {
      type: 'node',
      entry_point: 'server/index.cjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.cjs', '${user_config.token}'],
        env: { MODE: '${user_config.mode}', GREETING: 'hi' },
      },
    },
    user_config: {
      token: { type: 'string', title: 'Token', sensitive: true, required: true },
      mode: { type: 'string', title: 'Mode', default: 'fast' },
    },
  };

  it('inspect returns summary, launch preview and sha256', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest: userConfigManifest });
    const info = await h.installer.inspect(fixture.path);
    expect(info.sha256).toBe(fixture.sha256);
    expect(info.size).toBe(fixture.size);
    expect(info.displayName).toBe('Echo Bundle');
    expect(info.compatible).toBe(true);
    expect(info.runtime).toEqual({ kind: 'node', available: true });
    expect(info.installDir).toBe(path.join(h.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0'));
    expect(info.launchCommand).toBe(
      `MODE=\${user_config.mode} GREETING=hi /managed/node/bin/node ${info.installDir}/server/index.cjs \${user_config.token}`,
    );
    expect(info.userConfigFields.map((f) => f.key)).toEqual(['token', 'mode']);
  });

  it('installs: stdio server with source/tier, secrets outside settings, extracted tree + marker', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest: userConfigManifest });
    const { serverId } = await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { token: 'sk-very-secret' },
    });
    const dir = path.join(h.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0');
    expect(h.servers).toHaveLength(1);
    const server = h.servers[0]!;
    expect(server).toMatchObject({
      id: serverId,
      name: 'Echo Bundle',
      transport: 'stdio',
      command: '/managed/node/bin/node',
      args: [`${dir}/server/index.cjs`, 'secret:env:token'],
      env: { MODE: 'fast', GREETING: 'hi' },
      enabled: true,
      autoApprove: false,
      tier: 'developer',
      source: { kind: 'mcpb', name: 'echo-bundle', version: '1.0.0', sha256: fixture.sha256 },
    });
    expect(h.secrets.get(`mcp:${serverId}:env:token`)).toBe('sk-very-secret');
    expect(h.settingsJson()).not.toContain('sk-very-secret');
    expect(existsSync(path.join(dir, 'server', 'index.cjs'))).toBe(true);
    const marker = JSON.parse(await readFile(path.join(dir, '.kepcup-mcpb.json'), 'utf8'));
    expect(marker).toMatchObject({ name: 'echo-bundle', version: '1.0.0', sha256: fixture.sha256 });
    expect(await h.installer.verify(server.source!)).toEqual({ ok: true });
    // Tampering is detected by the content-hash marker.
    await writeFile(path.join(dir, 'server', 'index.cjs'), '// changed');
    expect(await h.installer.verify(server.source!)).toMatchObject({ ok: false });
    // Staging directories never leak.
    expect(existsSync(path.join(h.home, 'toolchains', 'mcpb'))).toBe(true);
  });

  it('rejects a sha256 that differs from the inspected file', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest: userConfigManifest });
    await expectCode(
      h.installer.install({
        filePath: fixture.path,
        sha256: '0'.repeat(64),
        userConfig: { token: 'x' },
      }),
      'MCPB_INVALID',
      /sha256 不符/,
    );
    expect(h.servers).toHaveLength(0);
    expect(existsSync(path.join(h.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0'))).toBe(false);
  });

  it('fails readably when the runtime is not installed, or the bundle is incompatible', async () => {
    const noRuntime = await harness({ resolveRuntime: () => null });
    const fixture = await buildMcpbFixture({ dir: await tmp() });
    await expectCode(
      noRuntime.installer.install({ filePath: fixture.path, sha256: fixture.sha256 }),
      'MCPB_RUNTIME_MISSING',
      /Node\.js.*设置 → 环境/,
    );
    const h = await harness({ platform: 'win32' });
    const mac = await buildMcpbFixture({
      dir: await tmp(),
      manifest: { compatibility: { platforms: ['darwin'] } },
    });
    await expectCode(
      h.installer.install({ filePath: mac.path, sha256: mac.sha256 }),
      'MCPB_INCOMPATIBLE',
      /只支持 darwin/,
    );
  });

  it('required user_config is enforced', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest: userConfigManifest });
    await expectCode(
      h.installer.install({ filePath: fixture.path, sha256: fixture.sha256 }),
      'MCPB_INVALID',
      /请填写必填配置项：Token/,
    );
  });

  it('binary bundles run directly without a managed runtime', async () => {
    const h = await harness({ resolveRuntime: () => null });
    const fixture = await buildMcpbFixture({
      dir: await tmp(),
      manifest: {
        name: 'native',
        server: {
          type: 'binary',
          entry_point: 'bin/server',
          mcp_config: { command: '${__dirname}/bin/server', args: ['--stdio'] },
        },
      },
      extraEntries: [{ name: 'bin/server', data: '#!/bin/sh\n', mode: 0o755 }],
    });
    await h.installer.install({ filePath: fixture.path, sha256: fixture.sha256 });
    expect(h.servers[0]!.command).toBe(
      path.join(h.home, 'toolchains', 'mcpb', 'native@1.0.0', 'bin', 'server'),
    );
    expect(h.servers[0]!.args).toEqual(['--stdio']);
  });

  it('uninstall removes entry, secrets and directory; a shared directory stays while in use', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest: userConfigManifest });
    const first = await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { token: 'one' },
    });
    const second = await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { token: 'two' },
    });
    const dir = path.join(h.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0');
    expect(h.servers).toHaveLength(2);
    expect(await h.installer.uninstall(first.serverId)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(h.secrets.has(`mcp:${first.serverId}:env:token`)).toBe(false);
    expect(await h.installer.uninstall(second.serverId)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(h.servers).toHaveLength(0);
    expect(h.secrets.size).toBe(0);
    expect(await h.installer.uninstall('nope')).toBe(false);
  });

  it('catalog installs omit the developer tier and must match the pinned sha256', async () => {
    const fixture = await buildMcpbFixture({ dir: await tmp() });
    const entry = (sha: string) =>
      ({
        packages: [{ registryType: 'mcpb', identifier: 'x.mcpb', fileSha256: sha }],
      }) as never;
    const ok = await harness({ catalogEntry: () => entry(fixture.sha256) });
    await ok.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      fromCatalog: { slug: 'demo' },
    });
    expect(ok.servers[0]!.tier).toBeUndefined();
    const bad = await harness({ catalogEntry: () => entry('f'.repeat(64)) });
    await expectCode(
      bad.installer.install({
        filePath: fixture.path,
        sha256: fixture.sha256,
        fromCatalog: { slug: 'demo' },
      }),
      'MCPB_INVALID',
      /目录登记的 sha256 不符/,
    );
    const missing = await harness({ catalogEntry: () => null });
    await expectCode(
      missing.installer.install({
        filePath: fixture.path,
        sha256: fixture.sha256,
        fromCatalog: { slug: 'demo' },
      }),
      'NOT_FOUND',
    );
  });

  it('approval payload carries the full launch command (secrets masked); a denial installs nothing', async () => {
    const fixture = await buildMcpbFixture({ dir: await tmp(), manifest: userConfigManifest });
    const approved = await harness();
    await approved.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { token: 'sk-hidden' },
      approvalContext: { conversationId: 'conv_1' },
    });
    expect(approved.approvals).toHaveLength(1);
    const payload = approved.approvals[0]!;
    const dir = path.join(approved.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0');
    expect(payload).toMatchObject({
      item: 'mcpb:echo-bundle',
      version: '1.0.0',
      displayName: 'Echo Bundle',
      sizeBytes: fixture.size,
      source: fixture.path,
    });
    expect(payload['reason']).toContain(`/managed/node/bin/node ${dir}/server/index.cjs ***`);
    expect(payload['reason']).toContain(fixture.sha256);
    expect(JSON.stringify(payload)).not.toContain('sk-hidden');

    const denied = await harness({ approve: false });
    await expectCode(
      denied.installer.install({
        filePath: fixture.path,
        sha256: fixture.sha256,
        userConfig: { token: 'x' },
        approvalContext: { conversationId: 'conv_1' },
      }),
      'APPROVAL_DENIED',
    );
    expect(denied.servers).toHaveLength(0);
    expect(existsSync(path.join(denied.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0'))).toBe(
      false,
    );
  });
});

describe('mcpb hardening (review fixes)', () => {
  /** Central-directory entry `index` starts at cenOffset + sum(46 + name length). */
  function patchCentral(
    bytes: Buffer,
    patch: (central: Buffer, offset: number) => void,
    entryName = 'manifest.json',
  ): Buffer {
    const copy = Buffer.from(bytes);
    const eocd = copy.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let offset = copy.readUInt32LE(eocd + 16);
    for (let i = 0; i < copy.readUInt16LE(eocd + 10); i += 1) {
      const nameLength = copy.readUInt16LE(offset + 28);
      const name = copy.toString('utf8', offset + 46, offset + 46 + nameLength);
      if (name === entryName) {
        patch(copy, offset);
        return copy;
      }
      offset += 46 + nameLength + copy.readUInt16LE(offset + 30) + copy.readUInt16LE(offset + 32);
    }
    throw new Error('entry not found');
  }

  async function bundleBytes(): Promise<Buffer> {
    const fixture = await buildMcpbFixture({ dir: await tmp() });
    return readFile(fixture.path);
  }

  it('bounds declared sizes: a 2^31..2^32-2 compressedSize is MCPB_INVALID, never a process abort', async () => {
    const h = await harness();
    const dir = await tmp();
    const bytes = await bundleBytes();
    const cases: Array<[string, (central: Buffer, offset: number) => void]> = [
      ['huge-compressed', (c, o) => c.writeUInt32LE(0xfffffff0, o + 20)],
      ['2gib-compressed', (c, o) => c.writeUInt32LE(0x80000000, o + 20)],
      ['over-entry-cap', (c, o) => c.writeUInt32LE(0x7fffffff, o + 20)],
      ['offset-overflow', (c, o) => c.writeUInt32LE(0xfffffff0, o + 42)],
      [
        'stored-size-mismatch',
        (c, o) => {
          c.writeUInt16LE(0, o + 10);
          c.writeUInt32LE(5, o + 24);
        },
      ],
    ];
    for (const [label, patch] of cases) {
      const file = path.join(dir, `${label}.mcpb`);
      await writeFile(file, patchCentral(bytes, patch));
      await expectCode(h.installer.inspect(file), 'MCPB_INVALID');
    }
  });

  it('applies the file-size cap from stat, before any hashing', async () => {
    const h = await harness();
    const dir = await tmp();
    const file = path.join(dir, 'huge.mcpb');
    const { truncate } = await import('node:fs/promises');
    await writeFile(file, '');
    await truncate(file, 513 * 1024 * 1024); // sparse
    await expectCode(h.installer.inspect(file), 'MCPB_INVALID', /包文件过大/);
  });

  it('rejects Windows device names, colons and trailing dot/space segments', async () => {
    const h = await harness();
    const dir = await tmp();
    for (const [index, name] of [
      'nul',
      'server/COM1.txt',
      'a:b',
      'trailing.',
      'x /y',
      'Lpt9',
    ].entries()) {
      const fixture = await buildMcpbFixture({
        dir,
        fileName: `w${index}.mcpb`,
        extraEntries: [{ name, data: 'x' }],
      });
      await expectCode(h.installer.inspect(fixture.path), 'MCPB_INVALID', /路径不安全/);
    }
  });

  it('refuses mcp_config.command that depends on user_config', () => {
    expect(() =>
      parseMcpbManifest({
        ...defaultMcpbManifest(),
        server: {
          type: 'node',
          entry_point: 'a.js',
          mcp_config: { command: '${user_config.bin}' },
        },
        user_config: { bin: { type: 'file', title: 'bin' } },
      }),
    ).toThrow(/command 不能引用 user_config/);
  });

  it('never leaves snapshot / staging files behind, even after a failed install', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({
      dir: await tmp(),
      manifest: {
        user_config: {
          k: { type: 'string', title: 'K', required: true },
        },
      },
    });
    await h.installer.inspect(fixture.path);
    await expect(
      h.installer.install({ filePath: fixture.path, sha256: fixture.sha256 }),
    ).rejects.toBeInstanceOf(AppError);
    await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { k: 'v' },
    });
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(path.join(h.home, 'toolchains', 'mcpb'));
    expect(names.filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('install dir names are lower-cased and Foo@1 / foo@1 are one slot', async () => {
    const h = await harness();
    const dir = await tmp();
    const upper = await buildMcpbFixture({ dir, fileName: 'u.mcpb', manifest: { name: 'Foo' } });
    const lower = await buildMcpbFixture({
      dir,
      fileName: 'l.mcpb',
      manifest: { name: 'foo', description: 'different bytes' },
    });
    const info = await h.installer.inspect(upper.path);
    expect(path.basename(info.installDir)).toBe('foo@1.0.0');
    await h.installer.install({ filePath: upper.path, sha256: upper.sha256 });
    await expectCode(
      h.installer.install({ filePath: lower.path, sha256: lower.sha256 }),
      'MCPB_INVALID',
      /内容不同/,
    );
  });

  it('re-extracts when the installed tree no longer matches its marker', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({ dir: await tmp() });
    const first = await h.installer.install({ filePath: fixture.path, sha256: fixture.sha256 });
    const dir = path.join(h.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0');
    const script = path.join(dir, 'server', 'index.cjs');
    const original = await readFile(script, 'utf8');
    await writeFile(script, '// tampered');
    await h.installer.install({ filePath: fixture.path, sha256: fixture.sha256 });
    expect(await readFile(script, 'utf8')).toBe(original);
    expect(first.serverId).toMatch(/^mcpb_/);
  });

  it('writes files as 0755 / 0644 only (no group/world-writable bits)', async () => {
    const h = await harness();
    const fixture = await buildMcpbFixture({
      dir: await tmp(),
      extraEntries: [
        { name: 'data/open.txt', data: 'x', mode: 0o666 },
        { name: 'data/tool.sh', data: 'x', mode: 0o777 },
      ],
    });
    await h.installer.install({ filePath: fixture.path, sha256: fixture.sha256 });
    const { stat } = await import('node:fs/promises');
    const base = path.join(h.home, 'toolchains', 'mcpb', 'echo-bundle@1.0.0');
    expect((await stat(path.join(base, 'data', 'open.txt'))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(base, 'data', 'tool.sh'))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(base, 'server', 'index.cjs'))).mode & 0o777).toBe(0o755);
  });

  it('audits install and uninstall with package identity only', async () => {
    const records: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const h = await harness({
      audit: { recordSystem: (action, detail) => void records.push({ action, detail }) },
    });
    const fixture = await buildMcpbFixture({
      dir: await tmp(),
      manifest: {
        user_config: { token: { type: 'string', title: 'T', sensitive: true } },
        server: {
          type: 'node',
          entry_point: 'server/index.cjs',
          mcp_config: { command: 'node', args: ['${user_config.token}'] },
        },
      },
    });
    const { serverId } = await h.installer.install({
      filePath: fixture.path,
      sha256: fixture.sha256,
      userConfig: { token: 'sk-audit-secret' },
    });
    await h.installer.uninstall(serverId);
    expect(records.map((r) => r.action)).toEqual(['mcpb_install', 'mcpb_uninstall']);
    expect(records[0]!.detail).toEqual({
      serverId,
      name: 'echo-bundle',
      version: '1.0.0',
      sha256: fixture.sha256,
      tier: 'developer',
    });
    expect(JSON.stringify(records)).not.toContain('sk-audit-secret');
  });

  it('a malformed stored source is dropped by the schema, and installDirOf stays inside the root', async () => {
    const { mcpServerSchema } = await import('@kepcup/shared');
    const parsed = mcpServerSchema.parse({
      id: 'x',
      name: 'x',
      transport: 'stdio',
      command: 'node',
      enabled: true,
      source: { kind: 'mcpb', name: 'ok', version: '../../..', sha256: 'a'.repeat(64) },
    });
    expect(parsed.source).toBeUndefined();
    const h = await harness();
    for (const [name, version] of [
      ['..', '1'],
      ['a', '../../b'],
      ['a/b', '1'],
      ['a', '..\\x'],
    ] as const) {
      expect(() => h.installer.installDirOf(name, version)).toThrow(/越界/);
    }
  });

  it('only deletes a directory whose marker matches name / version / sha256', async () => {
    const h = await harness();
    const dir = path.join(h.home, 'toolchains', 'mcpb', 'victim@1.0.0');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'precious.txt'), 'keep me');
    const source = {
      kind: 'mcpb' as const,
      name: 'victim',
      version: '1.0.0',
      sha256: 'b'.repeat(64),
    };
    const server = {
      id: 'mcpb_x',
      name: 'v',
      transport: 'stdio',
      enabled: true,
      autoApprove: false,
      auth: 'none',
      source,
    } as McpServer;
    await h.installer.afterServerRemoved([server], 'mcpb_x'); // no marker
    expect(existsSync(path.join(dir, 'precious.txt'))).toBe(true);
    await writeFile(
      path.join(dir, '.kepcup-mcpb.json'),
      JSON.stringify({
        name: 'victim',
        version: '1.0.0',
        sha256: 'c'.repeat(64),
        treeHash: 'x',
        files: 1,
      }),
    );
    await h.installer.afterServerRemoved([server], 'mcpb_x'); // marker for another sha
    expect(existsSync(path.join(dir, 'precious.txt'))).toBe(true);
  });
});
