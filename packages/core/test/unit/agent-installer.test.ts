import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { startFileServer, type TestFileServer } from '@kepcup/testkit';
import { AGENT_CATALOG, type AgentCatalogEntry } from '@kepcup/shared';
import {
  AgentInstaller,
  agentPlatformKey,
  defaultAgentDownloader,
  npmCiArgs,
  archiveKind,
  extractZip,
  extractVersion,
  parseNpmSpec,
  satisfiesRange,
  type AgentExec,
} from '../../src/agent/external/installer.js';
import { AGENT_NPX_LOCKFILES } from '../../src/agent/external/npx-lockfiles.generated.js';

/**
 * 外部智能体安装器（D72 P4，todo §7.1）：binary 下载 + sha256 校验 + 解压 +
 * 可执行位 + 卸载；npx 命令构造（环境管理器 Node + npm）；system 探测与版本
 * 范围。下载走 testkit 的本地文件服务器，npm 由注入的 exec 模拟。
 */

const dirs: string[] = [];
const servers: TestFileServer[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) await server.stop();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function baseEntry(overrides: Partial<AgentCatalogEntry> = {}): AgentCatalogEntry {
  return {
    id: 'demo',
    name: 'Demo Agent',
    version: '1.2.3',
    description: 'test',
    authors: ['t'],
    license: 'MIT',
    icon: 'demo.svg',
    distribution: {},
    provider: 'generic-acp',
    transport: 'acp',
    tier: 'preview',
    nativeCapabilities: {},
    auth: { kinds: [], note: '' },
    ...overrides,
  };
}

const PLATFORM_KEY = agentPlatformKey(process.platform, process.arch)!;

/** tar.gz whose root holds `bin/demo-agent` (a shell script). */
function demoArchive(): { buffer: Buffer; sha256: string } {
  const dir = tempDir('kepcup-agent-archive-');
  mkdirSync(path.join(dir, 'pkg', 'bin'), { recursive: true });
  writeFileSync(path.join(dir, 'pkg', 'bin', 'demo-agent'), '#!/bin/sh\necho demo 1.2.3\n');
  chmodSync(path.join(dir, 'pkg', 'bin', 'demo-agent'), 0o644); // installer must set +x
  writeFileSync(path.join(dir, 'pkg', 'LICENSE'), 'MIT');
  const archive = path.join(dir, 'demo.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', path.join(dir, 'pkg'), '.']);
  const buffer = readFileSync(archive);
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

function installerFor(
  root: string,
  overrides: Partial<ConstructorParameters<typeof AgentInstaller>[0]> = {},
) {
  return new AgentInstaller({
    toolchainsDir: path.join(root, 'toolchains'),
    downloadsDir: path.join(root, 'downloads'),
    nodeRuntime: async () => {
      throw new Error('node runtime not expected');
    },
    ...overrides,
  });
}

describe('AgentInstaller — binary', () => {
  it('downloads, verifies sha256, extracts, sets the executable bit, uninstalls', async () => {
    const { buffer, sha256 } = demoArchive();
    const server = await startFileServer({ 'demo.tar.gz': buffer });
    servers.push(server);
    const root = tempDir('kepcup-agent-install-');
    const installer = installerFor(root);
    const entry = baseEntry({
      distribution: {
        binary: {
          [PLATFORM_KEY]: {
            archive: `${server.url}/demo.tar.gz`,
            cmd: './bin/demo-agent',
            args: ['acp'],
            sha256,
          },
        },
      },
    });
    const stages: string[] = [];
    const installed = await installer.install(entry, {
      onProgress: (progress) => stages.push(progress.stage),
    });
    expect(installed.dir).toBe(path.join(root, 'toolchains', 'agents', 'demo@1.2.3'));
    expect(installed.kind).toBe('binary');
    expect(stages).toEqual(
      expect.arrayContaining(['downloading', 'verifying', 'extracting', 'checking']),
    );
    if (process.platform !== 'win32') {
      expect(statSync(installed.entry).mode & 0o111).not.toBe(0);
    }
    expect(installer.invocation(installed)).toEqual({
      command: installed.entry,
      prefixArgs: [],
      args: ['acp'],
      env: {},
    });
    expect(installer.installedVersions('demo')).toEqual(['1.2.3']);
    // Nothing left behind in the downloads dir or as staging.
    expect(readdirSync(path.join(root, 'downloads'))).toEqual([]);
    expect(readdirSync(path.join(root, 'toolchains', 'agents'))).toEqual(['demo@1.2.3']);

    installer.uninstall('demo');
    expect(existsSync(installed.dir)).toBe(false);
    expect(installer.installed('demo', '1.2.3')).toBeNull();
  });

  it('rejects an archive whose sha256 does not match and leaves nothing behind', async () => {
    const { buffer } = demoArchive();
    const server = await startFileServer({ 'demo.tar.gz': buffer });
    servers.push(server);
    const root = tempDir('kepcup-agent-install-');
    const installer = installerFor(root);
    const entry = baseEntry({
      distribution: {
        binary: {
          [PLATFORM_KEY]: {
            archive: `${server.url}/demo.tar.gz`,
            cmd: './bin/demo-agent',
            sha256: 'a'.repeat(64),
          },
        },
      },
    });
    await expect(installer.install(entry)).rejects.toMatchObject({ code: 'ENV_CHECKSUM_MISMATCH' });
    expect(installer.installed('demo', '1.2.3')).toBeNull();
    expect(readdirSync(path.join(root, 'downloads'))).toEqual([]);
    expect(readdirSync(path.join(root, 'toolchains', 'agents'))).toEqual([]);
  });

  it('a binary-only entry without an artifact for this platform is incompatible', async () => {
    const installer = installerFor(tempDir('kepcup-agent-install-'));
    const other = PLATFORM_KEY === 'linux-x86_64' ? 'darwin-aarch64' : 'linux-x86_64';
    const entry = baseEntry({
      distribution: {
        binary: {
          [other]: { archive: 'https://x.invalid/a.tar.gz', cmd: './a', sha256: 'b'.repeat(64) },
        },
      },
    });
    expect(installer.kindFor(entry)).toBe('none');
    await expect(installer.install(entry)).rejects.toMatchObject({ code: 'AGENT_INCOMPATIBLE' });
  });
});

/** Minimal zip writer (deflate) for the extractor tests. */
function makeZip(files: Array<{ name: string; data?: string; mode?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data ?? '', 'utf8');
    const compressed = file.name.endsWith('/') ? Buffer.alloc(0) : deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.name.endsWith('/') ? 0 : 8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.name.endsWith('/') ? 0 : 8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('zip extraction', () => {
  it('extracts stored directories and deflated files with their unix mode', () => {
    const dir = tempDir('kepcup-zip-');
    const zip = path.join(dir, 'a.zip');
    writeFileSync(
      zip,
      makeZip([
        { name: 'dist/' },
        { name: 'dist/agent', data: '#!/bin/sh\necho hi\n', mode: 0o100755 },
        { name: 'dist/README.md', data: 'hello' },
      ]),
    );
    const out = path.join(dir, 'out');
    mkdirSync(out);
    extractZip(zip, out);
    expect(readFileSync(path.join(out, 'dist', 'README.md'), 'utf8')).toBe('hello');
    if (process.platform !== 'win32') {
      expect(statSync(path.join(out, 'dist', 'agent')).mode & 0o777).toBe(0o755);
    }
  });

  it('refuses members escaping the target directory', () => {
    const dir = tempDir('kepcup-zip-');
    const zip = path.join(dir, 'evil.zip');
    writeFileSync(zip, makeZip([{ name: '../evil.txt', data: 'x' }]));
    const out = path.join(dir, 'out');
    mkdirSync(out);
    expect(() => extractZip(zip, out)).toThrow(/越界/);
    expect(existsSync(path.join(dir, 'evil.txt'))).toBe(false);
  });

  it('installs a zip binary through the same pipeline', async () => {
    const zip = makeZip([{ name: 'demo-agent', data: '#!/bin/sh\necho ok\n', mode: 0o100644 }]);
    const server = await startFileServer({ 'demo.zip': zip });
    servers.push(server);
    const installer = installerFor(tempDir('kepcup-agent-install-'));
    const entry = baseEntry({
      distribution: {
        binary: {
          [PLATFORM_KEY]: {
            archive: `${server.url}/demo.zip`,
            cmd: './demo-agent',
            sha256: createHash('sha256').update(zip).digest('hex'),
          },
        },
      },
    });
    const installed = await installer.install(entry);
    expect(readFileSync(installed.entry, 'utf8')).toContain('echo ok');
    if (process.platform !== 'win32') expect(statSync(installed.entry).mode & 0o111).not.toBe(0);
  });
});

describe('AgentInstaller — npx', () => {
  const LOCK = {
    packageJson: {
      name: 'kepcup-agent-demo',
      private: true,
      dependencies: { '@acme/demo-acp': '1.2.3' },
    },
    lockfile: { name: 'kepcup-agent-demo', lockfileVersion: 3, packages: {} },
  };
  const lockfileFor = (spec: string) => (spec.endsWith('@1.2.3') ? LOCK : null);

  it('runs `npm ci --ignore-scripts` on the shipped lockfile with a whitelisted env', async () => {
    const root = tempDir('kepcup-agent-npx-');
    const calls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> =
      [];
    const exec: AgentExec = async (command, args, options) => {
      calls.push({
        command,
        args,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
      const prefix = args[args.indexOf('--prefix') + 1]!;
      // npm ci consumes exactly the shipped manifest + lockfile.
      expect(JSON.parse(readFileSync(path.join(prefix, 'package-lock.json'), 'utf8'))).toEqual(
        LOCK.lockfile,
      );
      expect(JSON.parse(readFileSync(path.join(prefix, 'package.json'), 'utf8'))).toEqual(
        LOCK.packageJson,
      );
      const pkg = path.join(prefix, 'node_modules', '@acme', 'demo-acp');
      mkdirSync(path.join(pkg, 'dist'), { recursive: true });
      writeFileSync(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: '@acme/demo-acp', bin: { 'demo-acp': 'dist/index.js' } }),
      );
      writeFileSync(path.join(pkg, 'dist', 'index.js'), 'console.log("acp")');
      return { code: 0, stdout: '', stderr: '' };
    };
    const installer = installerFor(root, {
      exec,
      lockfileFor,
      npmCacheDir: path.join(root, 'npm-cache'),
      env: {
        PATH: '/usr/bin',
        HOME: '/home/u',
        OPENAI_API_KEY: 'sk-should-not-leak',
        GITHUB_TOKEN: 'ghp-should-not-leak',
        NODE_OPTIONS: '--require /tmp/evil.js',
      },
      nodeRuntime: async () => ({
        node: '/opt/kepcup/node/bin/node',
        npmCli: '/opt/kepcup/npm-cli.js',
      }),
      installedNode: () => '/opt/kepcup/node/bin/node',
    });
    const entry = baseEntry({
      distribution: {
        npx: { package: '@acme/demo-acp@1.2.3', args: ['--acp'], env: { DEMO_MODE: 'acp' } },
      },
    });
    expect(installer.kindFor(entry)).toBe('npx');
    const installed = await installer.install(entry);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('/opt/kepcup/node/bin/node');
    const staging = call.args[call.args.indexOf('--prefix') + 1]!;
    expect(call.args).toEqual(npmCiArgs('/opt/kepcup/npm-cli.js', staging));
    expect(call.args.slice(1, 2)).toEqual(['ci']);
    expect(call.args).toContain('--ignore-scripts');
    expect(call.env).toMatchObject({
      PATH: '/opt/kepcup/node/bin:/usr/bin',
      HOME: '/home/u',
      npm_config_ignore_scripts: 'true',
      npm_config_cache: path.join(root, 'npm-cache'),
    });
    expect(call.env?.OPENAI_API_KEY).toBeUndefined();
    expect(call.env?.GITHUB_TOKEN).toBeUndefined();
    expect(call.env?.NODE_OPTIONS).toBeUndefined();
    // Lockfile kept with the install.
    expect(existsSync(path.join(installed.dir, 'package-lock.json'))).toBe(true);

    expect(installer.invocation(installed)).toEqual({
      command: '/opt/kepcup/node/bin/node',
      prefixArgs: [
        path.join(installed.dir, 'node_modules', '@acme', 'demo-acp', 'dist', 'index.js'),
      ],
      args: ['--acp'],
      env: { DEMO_MODE: 'acp' },
    });
  });

  it('refuses an npx entry without a shipped lockfile', async () => {
    const root = tempDir('kepcup-agent-npx-');
    const installer = installerFor(root, {
      lockfileFor: () => null,
      exec: async () => {
        throw new Error('npm must not run');
      },
    });
    await expect(
      installer.install(baseEntry({ distribution: { npx: { package: 'demo@1.2.3' } } })),
    ).rejects.toMatchObject({ code: 'AGENT_INCOMPATIBLE' });
    expect(readdirSync(path.join(root, 'toolchains', 'agents'))).toEqual([]);
  });

  it('every curated npx catalog entry has a shipped lockfile', () => {
    for (const entry of AGENT_CATALOG) {
      const npx = entry.distribution.npx;
      if (npx === undefined) continue;
      const spec = parseNpmSpec(npx.package, entry.version);
      expect(AGENT_NPX_LOCKFILES[`${spec.name}@${spec.version}`], entry.id).toBeDefined();
    }
  });

  it('falls back to ELECTRON_RUN_AS_NODE when the managed Node is not installed', async () => {
    const root = tempDir('kepcup-agent-npx-');
    const installer = installerFor(root, {
      lockfileFor: () => LOCK,
      exec: async (_command, args) => {
        const prefix = args[args.indexOf('--prefix') + 1]!;
        const pkg = path.join(prefix, 'node_modules', 'demo');
        mkdirSync(pkg, { recursive: true });
        writeFileSync(
          path.join(pkg, 'package.json'),
          JSON.stringify({ name: 'demo', bin: 'cli.js' }),
        );
        writeFileSync(path.join(pkg, 'cli.js'), '');
        return { code: 0, stdout: '', stderr: '' };
      },
      nodeRuntime: async () => ({ node: '/n/node', npmCli: '/n/npm-cli.js' }),
      installedNode: () => null,
    });
    const installed = await installer.install(
      baseEntry({ distribution: { npx: { package: 'demo' } } }),
    );
    const invocation = installer.invocation(installed);
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a package bin that is a symlink out of the install',
    async () => {
      const root = tempDir('kepcup-agent-npx-');
      const outside = path.join(tempDir('kepcup-outside-'), 'id_rsa');
      writeFileSync(outside, 'secret');
      const installer = installerFor(root, {
        lockfileFor: () => LOCK,
        exec: async (_command, args) => {
          const prefix = args[args.indexOf('--prefix') + 1]!;
          const pkg = path.join(prefix, 'node_modules', 'demo');
          mkdirSync(pkg, { recursive: true });
          writeFileSync(
            path.join(pkg, 'package.json'),
            JSON.stringify({ name: 'demo', bin: 'cli.js' }),
          );
          symlinkSync(outside, path.join(pkg, 'cli.js'));
          return { code: 0, stdout: '', stderr: '' };
        },
        nodeRuntime: async () => ({ node: '/n/node', npmCli: '/n/npm-cli.js' }),
      });
      await expect(
        installer.install(baseEntry({ distribution: { npx: { package: 'demo' } } })),
      ).rejects.toThrow(/符号链接/);
      expect(statSync(outside).mode & 0o111).toBe(0);
    },
  );

  it('a failing npm install reports the tail of its output and leaves nothing behind', async () => {
    const root = tempDir('kepcup-agent-npx-');
    const installer = installerFor(root, {
      lockfileFor: () => LOCK,
      exec: async () => ({ code: 1, stdout: '', stderr: 'npm ERR! 404 Not Found' }),
      nodeRuntime: async () => ({ node: '/n/node', npmCli: '/n/npm-cli.js' }),
    });
    await expect(
      installer.install(baseEntry({ distribution: { npx: { package: 'missing-pkg' } } })),
    ).rejects.toThrow(/404 Not Found/);
    expect(readdirSync(path.join(root, 'toolchains', 'agents'))).toEqual([]);
  });
});

describe('AgentInstaller — archive safety', () => {
  async function installArchive(buffer: Buffer, name: string, cmd: string) {
    const server = await startFileServer({ [name]: buffer });
    servers.push(server);
    const root = tempDir('kepcup-agent-install-');
    const installer = installerFor(root);
    const entry = baseEntry({
      distribution: {
        binary: {
          [PLATFORM_KEY]: {
            archive: `${server.url}/${name}`,
            cmd,
            sha256: createHash('sha256').update(buffer).digest('hex'),
          },
        },
      },
    });
    return { root, installer, promise: installer.install(entry) };
  }

  function tarOf(build: (dir: string) => void, extra: string[] = []): Buffer {
    const dir = tempDir('kepcup-tar-src-');
    build(dir);
    const archive = path.join(tempDir('kepcup-tar-out-'), 'a.tar.gz');
    execFileSync('tar', ['-czf', archive, ...extra, '-C', dir, '.']);
    return readFileSync(archive);
  }

  it.skipIf(process.platform === 'win32')(
    'tar: a symlink entry (cmd) pointing outside is rejected and never chmod-ed',
    async () => {
      const outside = path.join(tempDir('kepcup-outside-'), 'id_rsa');
      writeFileSync(outside, 'secret');
      chmodSync(outside, 0o600);
      const buffer = tarOf((dir) => symlinkSync(outside, path.join(dir, 'agent')));
      const { root, promise } = await installArchive(buffer, 'a.tar.gz', './agent');
      await expect(promise).rejects.toMatchObject({ code: 'ENV_INSTALL_FAILED' });
      expect(statSync(outside).mode & 0o777).toBe(0o600);
      expect(readdirSync(path.join(root, 'toolchains', 'agents'))).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tar: a symlink to a regular file inside the archive is still refused as entry',
    async () => {
      const buffer = tarOf((dir) => {
        writeFileSync(path.join(dir, 'real-agent'), '#!/bin/sh\n');
        symlinkSync('real-agent', path.join(dir, 'agent'));
      });
      const { promise } = await installArchive(buffer, 'a.tar.gz', './agent');
      await expect(promise).rejects.toThrow(/符号链接/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tar: members escaping with ../ are not written outside',
    async () => {
      const victimDir = tempDir('kepcup-victim-');
      const buffer = tarOf(
        (dir) => {
          writeFileSync(path.join(dir, 'agent'), '#!/bin/sh\n');
          writeFileSync(path.join(dir, 'evil'), 'pwned');
        },
        ['--transform', `s,^\\./evil$,../../../../../../../../..${victimDir}/evil,`],
      );
      const { promise } = await installArchive(buffer, 'a.tar.gz', './agent');
      await promise.catch(() => undefined);
      expect(existsSync(path.join(victimDir, 'evil'))).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')('zip: contained symlinks are created', () => {
    const dir = tempDir('kepcup-zip-');
    const zip = path.join(dir, 'a.zip');
    writeFileSync(
      zip,
      makeZip([
        { name: 'sub/' },
        { name: 'sub/real', data: 'x' },
        { name: 'link', data: 'sub/real', mode: 0o120777 },
        { name: 'dirlink', data: 'sub', mode: 0o120777 },
        { name: 'dirlink/through', data: 'ok' },
      ]),
    );
    const out = path.join(dir, 'out');
    mkdirSync(out);
    extractZip(zip, out);
    expect(readFileSync(path.join(out, 'link'), 'utf8')).toBe('x');
    expect(readFileSync(path.join(out, 'sub', 'through'), 'utf8')).toBe('ok');
  });

  it.skipIf(process.platform === 'win32')(
    'zip: links out of the target and writes through them are refused',
    () => {
      const dir = tempDir('kepcup-zip-');
      const victim = tempDir('kepcup-victim-');
      const out = path.join(dir, 'out');
      for (const [label, files] of [
        ['absolute link', [{ name: 'l', data: victim, mode: 0o120777 }]],
        ['relative escape', [{ name: 'l', data: '../../..', mode: 0o120777 }]],
        [
          'write through escaping link',
          [
            { name: 'l', data: path.relative(out, victim), mode: 0o120777 },
            { name: 'l/evil', data: 'pwned' },
          ],
        ],
      ] as const) {
        rmSync(out, { recursive: true, force: true });
        mkdirSync(out);
        const zip = path.join(dir, 'evil.zip');
        writeFileSync(zip, makeZip([...files]));
        expect(() => extractZip(zip, out), label).toThrow(/符号链接|越界/);
      }
      expect(readdirSync(victim)).toEqual([]);
    },
  );

  it('rejects path-like versions and markers pointing outside', () => {
    const root = tempDir('kepcup-agent-install-');
    const installer = installerFor(root);
    expect(() => installer.dirFor('demo', '../../../../tmp/p')).toThrow();
    expect(installer.installed('demo', '../../../../tmp/p')).toBeNull();
    const dir = installer.dirFor('demo', '1.2.3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.kepcup-agent.json'),
      JSON.stringify({
        id: 'demo',
        version: '1.2.3',
        kind: 'binary',
        entry: '../../../../bin/sh',
        args: [],
        env: {},
      }),
    );
    expect(installer.installed('demo', '1.2.3')).toBeNull();
  });
});

describe('downloader', () => {
  it('aborts a download that stalls (idle timeout)', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write(Buffer.alloc(10));
      // ...and never more.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        defaultAgentDownloader({
          url: `http://127.0.0.1:${port}/x`,
          target: path.join(tempDir('kepcup-dl-'), 'x'),
          onProgress: () => undefined,
          idleTimeoutMs: 200,
        }),
      ).rejects.toThrow(/没有进展/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reports write errors instead of hanging', async () => {
    const server = await startFileServer({ 'x.bin': Buffer.alloc(1024) });
    servers.push(server);
    await expect(
      defaultAgentDownloader({
        url: `${server.url}/x.bin`,
        target: path.join(tempDir('kepcup-dl-'), 'missing-dir', 'x.bin'),
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'ENV_INSTALL_FAILED' });
  });
});

describe('AgentInstaller — system CLI', () => {
  function fakeCli(version: string): { dir: string; env: NodeJS.ProcessEnv } {
    const dir = tempDir('kepcup-agent-path-');
    const file = path.join(dir, 'democli');
    writeFileSync(file, `#!/bin/sh\necho "democli version ${version}"\n`);
    chmodSync(file, 0o755);
    return { dir, env: { PATH: dir } };
  }

  const systemEntry = (versionRange?: string) =>
    baseEntry({
      distribution: {
        system: {
          cmd: 'democli',
          args: ['acp'],
          detect: ['--version'],
          ...(versionRange !== undefined ? { versionRange } : {}),
        },
      },
    });

  it.skipIf(process.platform === 'win32')(
    'detects the CLI on PATH and checks the version range',
    async () => {
      const { dir, env } = fakeCli('3.14.2');
      const installer = installerFor(tempDir('kepcup-agent-sys-'), { env });
      expect(installer.kindFor(systemEntry())).toBe('system');
      expect(await installer.detectSystem(systemEntry('3.14.x'))).toEqual({
        found: true,
        path: path.join(dir, 'democli'),
        version: '3.14.2',
        versionRange: '3.14.x',
        compatible: true,
      });
      expect(await installer.detectSystem(systemEntry('>=4.0.0'))).toMatchObject({
        found: true,
        compatible: false,
      });
      expect(installer.systemInvocation(systemEntry())).toEqual({
        command: path.join(dir, 'democli'),
        prefixArgs: [],
        args: ['acp'],
        env: {},
      });
    },
  );

  it('reports a missing CLI', async () => {
    const installer = installerFor(tempDir('kepcup-agent-sys-'), {
      env: { PATH: tempDir('empty-') },
    });
    expect(await installer.detectSystem(systemEntry())).toMatchObject({
      found: false,
      compatible: false,
    });
    expect(installer.systemInvocation(systemEntry())).toBeNull();
  });
});

describe('installer helpers', () => {
  it('maps node platforms to ACP Registry keys', () => {
    expect(agentPlatformKey('linux', 'x64')).toBe('linux-x86_64');
    expect(agentPlatformKey('darwin', 'arm64')).toBe('darwin-aarch64');
    expect(agentPlatformKey('win32', 'x64')).toBe('windows-x86_64');
    expect(agentPlatformKey('freebsd', 'x64')).toBeNull();
  });

  it('parses npm specs with and without a pinned version', () => {
    expect(parseNpmSpec('@agentclientprotocol/claude-agent-acp@0.86.0', 'x')).toEqual({
      name: '@agentclientprotocol/claude-agent-acp',
      version: '0.86.0',
    });
    expect(parseNpmSpec('@deepseek-ai/dsh', '0.2.0-rc.2')).toEqual({
      name: '@deepseek-ai/dsh',
      version: '0.2.0-rc.2',
    });
    expect(parseNpmSpec('opencode@1.0.0', 'x')).toEqual({ name: 'opencode', version: '1.0.0' });
  });

  it('classifies archives by extension', () => {
    expect(archiveKind('https://a/b/opencode-linux-x64.tar.gz')).toBe('tar');
    expect(archiveKind('https://a/b/agent.tgz?x=1')).toBe('tar');
    expect(archiveKind('https://a/b/agent.zip')).toBe('zip');
    expect(archiveKind('https://a/b/agent')).toBe('raw');
  });

  it('checks semver ranges', () => {
    expect(satisfiesRange('3.14.2', '3.14.x')).toBe(true);
    expect(satisfiesRange('3.15.0', '3.14.x')).toBe(false);
    expect(satisfiesRange('1.18.35', '>=1.18.0 <2')).toBe(true);
    expect(satisfiesRange('2.0.0', '>=1.18.0 <2.0.0')).toBe(false);
    expect(satisfiesRange('0.86.3', '^0.86.0')).toBe(true);
    expect(satisfiesRange('0.87.0', '^0.86.0')).toBe(false);
    expect(satisfiesRange('1.4.0', '~1.3.0 || ^1.4.0')).toBe(true);
    expect(satisfiesRange('0.2.0-rc.2', '>=0.2.0')).toBe(false);
    expect(satisfiesRange('garbage', '*')).toBe(false);
    expect(extractVersion('opencode v1.18.35 (abc)')).toBe('1.18.35');
  });
});
