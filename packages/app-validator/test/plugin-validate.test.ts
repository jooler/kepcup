import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZIP_MAX_ENTRY_BYTES } from '@kepcup/package-guard';
import { validatePlugin } from '../src/plugin/validate.js';
import {
  buildPluginDir,
  buildPluginFixture,
  connectorFixtureEntry,
  type PluginFixtureOptions,
} from '../../testkit/src/plugin-fixture.js';

/**
 * Offline plugin validation (D104 P2 step 4): every `plugin.*` check gets a trigger and a
 * non-trigger, directory and `.kepcup` inputs produce the same findings, and no network
 * call is ever made.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'app-validator-plugin-'));
  dirs.push(dir);
  return dir;
}

const MAIL = {
  id: 'fastmail',
  label: 'Fastmail',
  imap: { host: 'imap.fastmail.com', port: 993, secure: 'ssl' },
  smtp: { host: 'smtp.fastmail.com', port: 465, secure: 'ssl' },
};

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>';

function legalOptions(dir: string): PluginFixtureOptions {
  return {
    dir,
    manifest: {
      icon: 'icon.svg',
      author: { name: 'Tester' },
      homepage: 'https://example.com/plugin',
      engines: { kepcup: '>=0.4.0' },
      // P3：邮件贡献必须伴随 instances: ['mail']（实例供给规范）。
      instances: ['mail'],
    },
    skills: [{ name: 'hello', description: 'Says hello' }],
    connectors: [{ slug: 'acme', entry: connectorFixtureEntry('acme', { tier: 'community' }) }],
    mcpb: [{ id: 'echo' }],
    http: [{ id: 'docs', url: 'https://mcp.example.com/mcp' }],
    mail: [MAIL],
  };
}

async function legalDir(): Promise<string> {
  const dir = await tmp();
  await buildPluginDir(legalOptions(dir));
  await writeFile(path.join(dir, 'README.md'), '# Demo plugin\n');
  await writeFile(path.join(dir, 'icon.svg'), ICON_SVG);
  return dir;
}

function ids(
  report: { checks: Array<{ id: string; severity: string }> },
  severity?: string,
): string[] {
  return report.checks
    .filter((check) => severity === undefined || check.severity === severity)
    .map((check) => check.id);
}

describe('validatePlugin: a complete legal plugin', () => {
  it('has zero errors and reports the derived permissions', async () => {
    const report = await validatePlugin(await legalDir());
    expect(report.mode).toBe('plugin');
    expect(report.schemaVersion).toBe(1);
    expect(report.remote).toBeNull();
    expect(report.auth).toBe(false);
    expect(ids(report, 'error')).toEqual([]);
    expect(report.exitCode).toBe(0);
    const permissions = report.checks.find((check) => check.id === 'plugin.permissions');
    expect(permissions?.severity).toBe('info');
    expect(permissions?.details).toMatchObject({
      hosts: ['imap.fastmail.com', 'mcp.acme.test', 'mcp.example.com', 'smtp.fastmail.com'],
      mcpb: [{ id: 'echo', userConfig: [] }],
      mail: ['fastmail'],
    });
    expect(ids(report)).toContain('plugin.mcpb-package');
    expect(ids(report)).toContain('plugin.mcp-http');
    expect(ids(report, 'info')).toContain('plugin.icon');
  });

  it('requires an icon and rejects an unusable one', async () => {
    const dir = await tmp();
    await buildPluginDir({
      ...legalOptions(dir),
      manifest: { ...legalOptions(dir).manifest, icon: null },
    });
    await writeFile(path.join(dir, 'README.md'), '# Demo plugin\n');
    const missing = await validatePlugin(dir);
    expect(missing.checks.find((check) => check.id === 'plugin.icon')?.severity).toBe('error');

    const manifest = JSON.parse(
      await readFile(path.join(dir, 'plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ ...manifest, icon: 'icon.svg' }),
    );
    await writeFile(path.join(dir, 'icon.svg'), 'not an svg');
    const broken = await validatePlugin(dir);
    expect(
      broken.checks.some(
        (check) => check.id === 'plugin.icon' && check.severity === 'error',
      ),
    ).toBe(true);
  });

  it('warns when the icon exceeds the marketplace-index cap', async () => {
    const dir = await legalDir();
    await writeFile(path.join(dir, 'icon.svg'), `<svg>${'x'.repeat(65 * 1024)}</svg>`);
    const report = await validatePlugin(dir);
    expect(
      report.checks.some((check) => check.id === 'plugin.icon' && check.severity === 'warn'),
    ).toBe(true);
  });

  it('does not touch the network', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled')));
    vi.stubGlobal('fetch', fetchSpy);
    await validatePlugin(await legalDir());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('validatePlugin: archive input', () => {
  it('reports the same checks as the directory (except package-level errors)', async () => {
    const dir = await legalDir();
    const packed = await buildPluginFixture({
      ...legalOptions(await tmp()),
      extraEntries: [
        { name: 'README.md', data: '# Demo plugin\n' },
        { name: 'icon.svg', data: ICON_SVG },
      ],
    });
    const fromDir = await validatePlugin(dir);
    const fromArchive = await validatePlugin(packed.path);
    expect(new Set(ids(fromArchive))).toEqual(new Set(ids(fromDir)));
  });

  it('turns a hostile archive into plugin.package-entries', async () => {
    const traversal = await buildPluginFixture({
      dir: await tmp(),
      extraEntries: [{ name: '../escape.txt', data: 'evil' }],
    });
    const traversalReport = await validatePlugin(traversal.path);
    expect(traversalReport.exitCode).toBe(1);
    expect(ids(traversalReport, 'error')).toEqual(['plugin.package-entries']);

    const symlink = await buildPluginFixture({
      dir: await tmp(),
      extraEntries: [{ name: 'link', data: '/etc/passwd', symlink: true, deflate: false }],
    });
    const symlinkReport = await validatePlugin(symlink.path);
    expect(symlinkReport.exitCode).toBe(1);
    expect(ids(symlinkReport, 'error')).toEqual(['plugin.package-entries']);
  });

  it('rejects a non-zip file with the .kepcup suffix', async () => {
    const file = path.join(await tmp(), 'fake.kepcup');
    await writeFile(file, 'not a zip');
    const report = await validatePlugin(file);
    expect(report.checks.some((check) => check.id === 'plugin.package-entries')).toBe(true);
    expect(report.exitCode).toBe(1);
  });
});

describe('validatePlugin: manifest checks', () => {
  it('reports a missing / oversized / non-JSON manifest', async () => {
    const missing = await tmp();
    expect(ids(await validatePlugin(missing), 'error')).toContain('plugin.manifest-read');

    const broken = await tmp();
    await writeFile(path.join(broken, 'plugin.json'), 'not json');
    expect(ids(await validatePlugin(broken), 'error')).toContain('plugin.manifest-read');

    const huge = await tmp();
    await writeFile(path.join(huge, 'plugin.json'), `"${'x'.repeat(70 * 1024)}"`);
    expect(ids(await validatePlugin(huge), 'error')).toContain('plugin.manifest-read');
  });

  it('reports a newer format_version before the schema check', async () => {
    const dir = await tmp();
    await buildPluginDir({
      dir,
      rawManifest: JSON.stringify({
        format_version: 2,
        id: 'io.github.test/p',
        name: 'P',
        version: '1.0.0',
      }),
      skills: [{ name: 'hello' }],
    });
    expect(ids(await validatePlugin(dir), 'error')).toEqual(['plugin.manifest-format']);
  });

  it('reports schema violations with the subject path', async () => {
    const dir = await tmp();
    await buildPluginDir({ dir, rawManifest: JSON.stringify({ format_version: 1 }) });
    const report = await validatePlugin(dir);
    const check = report.checks.find((item) => item.id === 'plugin.manifest-schema');
    expect(check?.severity).toBe('error');
    expect(check?.subject).toBe('plugin.json');
  });

  it('rejects the reserved namespace', async () => {
    const dir = await tmp();
    await buildPluginDir({
      dir,
      manifest: { id: 'com.kepcup/evil' },
      skills: [{ name: 'hello' }],
    });
    expect(ids(await validatePlugin(dir), 'error')).toContain('plugin.manifest-namespace');
  });

  it('warns for each missing metadata field and a missing README', async () => {
    const dir = await tmp();
    await buildPluginDir({
      dir,
      manifest: { description: '', author: null, homepage: null, engines: null },
      skills: [{ name: 'hello' }],
    });
    const report = await validatePlugin(dir);
    const metadata = report.checks.filter((check) => check.id === 'plugin.manifest-metadata');
    expect(metadata.map((check) => check.subject)).toEqual([
      'description',
      'author',
      'homepage',
      'engines',
    ]);
    expect(metadata.every((check) => check.severity === 'warn')).toBe(true);
    expect(
      report.checks.some((check) => check.id === 'plugin.readme' && check.severity === 'warn'),
    ).toBe(true);
  });
});

describe('validatePlugin: contribution checks', () => {
  it('reports missing contribution files', async () => {
    const dir = await tmp();
    await buildPluginDir({
      dir,
      manifest: { contributions: { skills: [{ dir: 'skills/missing' }] } },
    });
    const report = await validatePlugin(dir);
    const check = report.checks.find((item) => item.id === 'plugin.files-path');
    expect(check?.severity).toBe('error');
    expect(check?.subject).toBe('skills/missing');
  });

  it('reports directory limit violations', async () => {
    const dir = await tmp();
    await buildPluginDir({ dir, skills: [{ name: 'hello' }] });
    const huge = path.join(dir, 'huge.bin');
    await writeFile(huge, '');
    await truncate(huge, ZIP_MAX_ENTRY_BYTES + 1);
    const report = await validatePlugin(dir);
    expect(ids(report, 'error')).toContain('plugin.files-limits');
  });

  it('reports a skill without frontmatter', async () => {
    const dir = await tmp();
    await buildPluginDir({ dir, skills: [{ name: 'hello' }] });
    await writeFile(path.join(dir, 'skills', 'hello', 'SKILL.md'), '# no frontmatter\n');
    const report = await validatePlugin(dir);
    expect(ids(report, 'error')).toContain('plugin.skill-frontmatter');
  });

  it('accepts what the installer parser accepts: BOM, CRLF and a closing line that starts with ---', async () => {
    const dir = await tmp();
    await buildPluginDir({ dir, skills: [{ name: 'hello' }] });
    await writeFile(
      path.join(dir, 'skills', 'hello', 'SKILL.md'),
      '\uFEFF---\r\nname: hello\r\ndescription: Says hello\r\n--- \r\n\r\nBody\r\n',
    );
    const report = await validatePlugin(dir);
    expect(ids(report, 'error')).not.toContain('plugin.skill-frontmatter');
  });

  it('forwards connector manifest checks with the file path', async () => {
    const dir = await tmp();
    await buildPluginDir({
      dir,
      connectors: [{ slug: 'acme' }],
      manifest: {
        author: { name: 'T' },
        homepage: 'https://example.com',
        engines: { kepcup: '>=0.4.0' },
      },
    });
    const report = await validatePlugin(dir);
    const forwarded = report.checks.filter((check) => check.id === 'plugin.connector-entry');
    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded[0]?.subject).toContain('connectors/acme/server.json');
    expect(forwarded.some((check) => check.message.includes('manifest.tier'))).toBe(true);
  });

  it('accepts a connector file without meta.releaseGate (the plugin rewrite assigns it)', async () => {
    // D104 商店化收尾：连接器目录通道下线后 catalog schema 不再有 releaseGate 字段，
    // 插件来源条目的分级门禁由投影器改写（releaseGate ← 'plugin'）——不再要求作者自填。
    const dir = await tmp();
    const entry = connectorFixtureEntry('acme', { tier: 'community' });
    const meta = (entry._meta as Record<string, Record<string, unknown>>)['app.kepcup/connector']!;
    delete meta.releaseGate;
    await buildPluginDir({
      dir,
      connectors: [{ slug: 'acme', entry }],
      manifest: { icon: 'icon.svg' },
    });
    await writeFile(path.join(dir, 'icon.svg'), ICON_SVG);
    const report = await validatePlugin(dir);
    const strictErrors = report.checks.filter(
      (check) => check.id === 'plugin.connector-entry' && check.severity === 'error',
    );
    expect(strictErrors).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it('requires at least one remote endpoint on a plugin connector (packages alone do not count)', async () => {
    const dir = await tmp();
    const entry = {
      ...connectorFixtureEntry('acme', { tier: 'community' }),
      remotes: [],
      packages: [{ registryType: 'npm', identifier: 'x', version: '1.0.0' }],
    };
    await buildPluginDir({ dir, connectors: [{ slug: 'acme', entry }] });
    const report = await validatePlugin(dir);
    const errors = ids(report, 'error');
    expect(errors).toContain('plugin.connector-packages');
    expect(errors).toContain('plugin.connector-remote');
  });

  it('rejects connector packages, unsafe remotes and a misplaced icon', async () => {
    const dir = await tmp();
    await buildPluginDir({
      dir,
      connectors: [
        {
          slug: 'acme',
          iconName: 'other.svg',
          entry: {
            ...connectorFixtureEntry('acme', { tier: 'community', url: 'http://example.com/mcp' }),
            packages: [{ registryType: 'npm', identifier: 'x', version: '1.0.0' }],
          },
        },
      ],
    });
    const report = await validatePlugin(dir);
    const errors = ids(report, 'error');
    expect(errors).toContain('plugin.connector-packages');
    expect(errors).toContain('plugin.connector-remote');
    expect(errors).toContain('plugin.connector-icon');
  });

  it('rejects a broken embedded MCPB', async () => {
    const dir = await tmp();
    await buildPluginDir({
      dir,
      mcpb: [{ id: 'broken', mcpb: { omitManifest: true } }],
    });
    const report = await validatePlugin(dir);
    const check = report.checks.find((item) => item.id === 'plugin.mcpb-package');
    expect(check?.severity).toBe('error');
  });

  it('rejects an unsafe http contribution URL', async () => {
    const dir = await tmp();
    await buildPluginDir({
      dir,
      http: [{ id: 'docs', url: 'http://localhost:3000/mcp' }],
    });
    const report = await validatePlugin(dir);
    expect(ids(report, 'error')).toContain('plugin.mcp-http');
  });

  it('rejects mail hosts that are local or not public domains', async () => {
    const dir = await tmp();
    await buildPluginDir({
      dir,
      manifest: { instances: ['mail'] },
      mail: [
        {
          ...MAIL,
          imap: { host: 'localhost', port: 993, secure: 'ssl' },
          smtp: { host: '192.168.1.5', port: 465, secure: 'ssl' },
        },
      ],
    });
    const report = await validatePlugin(dir);
    expect(report.checks.filter((check) => check.id === 'plugin.mail-host')).toHaveLength(2);
  });

  it('rejects mail hosts with whitespace or control characters', async () => {
    const dir = await tmp();
    await buildPluginDir({
      dir,
      manifest: { instances: ['mail'] },
      mail: [
        {
          ...MAIL,
          // P3 分层：首尾空白由 manifest schema 的 trim 纪律拒绝；内部空格 /
          // 控制字符由 mail-host 出口规则拒绝（两值都过 schema，mail-host 才可达）。
          imap: { host: 'imap example.com', port: 993, secure: 'ssl' },
          smtp: { host: 'smtp.example.com\u0001', port: 465, secure: 'ssl' },
        },
      ],
    });
    const report = await validatePlugin(dir);
    expect(report.checks.filter((check) => check.id === 'plugin.mail-host')).toHaveLength(2);
  });
});

describe('validatePlugin: JSON shape', () => {
  it('is JSON-serialisable with mode plugin and schemaVersion 1', async () => {
    const report = await validatePlugin(await legalDir());
    const parsed = JSON.parse(JSON.stringify(report)) as {
      mode: string;
      schemaVersion: number;
      checks: unknown[];
    };
    expect(parsed.mode).toBe('plugin');
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

describe('validatePlugin: declarative config / instance fields (D105 P5)', () => {
  it('previews the generated capability line and instance kinds as info', async () => {
    const report = await validatePlugin(await legalDir());
    expect(ids(report, 'error')).toEqual([]);
    const capabilities = report.checks.find((check) => check.id === 'plugin.capabilities');
    expect(capabilities?.severity).toBe('info');
    expect(capabilities?.details).toMatchObject({
      instanceKinds: ['mail'],
      configFields: 0,
    });
    expect(String((capabilities?.details as { capabilitySummary: string }).capabilitySummary)).toContain(
      '1 个技能',
    );
  });

  it('warns when a default disagrees with the declared type / bounds, and on sensitive defaults', async () => {
    const dir = await tmp();
    await buildPluginDir({
      ...legalOptions(dir),
      manifest: {
        icon: 'icon.svg',
        author: { name: 'Tester' },
        instances: ['mail'],
        config: {
          fields: [
            { key: 'okText', type: 'string', title: '正常' },
            { key: 'badNumber', type: 'number', title: '类型错', default: 'nope' },
            { key: 'outOfRange', type: 'number', title: '越界', min: 5, default: 1 },
            { key: 'secretDefault', type: 'string', title: '敏感默认', sensitive: true, default: 'x' },
            { key: 'badMultiple', type: 'string', title: '多值错', multiple: true, default: 'x' },
          ],
        },
      },
      skills: [{ name: 'hello', description: 'Says hello' }],
    });
    await writeFile(path.join(dir, 'icon.svg'), ICON_SVG);
    const report = await validatePlugin(dir);
    // 全部是 authoring 警告：不拦打包（core 对 default 的消费语义见开发文档）。
    expect(ids(report, 'error')).toEqual([]);
    const warnings = report.checks.filter(
      (check) => check.id === 'plugin.field-default' && check.severity === 'warn',
    );
    const subjects = warnings.map((check) => check.subject);
    expect(subjects).toContain('config[1] badNumber');
    expect(subjects).toContain('config[2] outOfRange');
    expect(subjects).toContain('config[3] secretDefault');
    expect(subjects).toContain('config[4] badMultiple');
    expect(subjects).not.toContain('config[0] okText');
  });

  it('also checks mail instanceFields defaults', async () => {
    const dir = await tmp();
    await buildPluginDir({
      ...legalOptions(dir),
      mail: [
        {
          ...MAIL,
          instanceFields: [
            { key: 'folder', type: 'string', title: '文件夹' },
            { key: 'pageSize', type: 'number', title: '分页', default: true },
          ],
        },
      ],
    });
    const report = await validatePlugin(dir);
    const warnings = report.checks.filter(
      (check) => check.id === 'plugin.field-default' && check.severity === 'warn',
    );
    expect(warnings.map((check) => check.subject)).toEqual(['mail:fastmail[1] pageSize']);
  });
});
