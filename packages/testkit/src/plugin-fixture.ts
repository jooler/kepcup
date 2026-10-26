import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildMcpbFixture,
  buildZip,
  type McpbFixtureOptions,
  type ZipEntryInput,
} from './mcpb-fixture.js';

/**
 * `.kepcup` plugin fixture (D104 P0a-1): builds a real plugin archive or an unpacked
 * development directory from a manifest plus skill / connector / mcp / mail contributions.
 * Embedded `.mcpb` bundles are produced by {@link buildMcpbFixture}; the zip itself comes
 * from {@link buildZip} so tests can also append hostile entries.
 */

export interface PluginFixtureSkill {
  name: string;
  description?: string;
  /** Additional files inside the skill folder, relative to it. */
  extraFiles?: Record<string, string>;
}

export interface PluginFixtureConnector {
  slug: string;
  url?: string;
  /** Shallow-merged over {@link connectorFixtureEntry}. */
  entry?: Record<string, unknown>;
  iconName?: string;
}

export interface PluginFixtureMcpb {
  id: string;
  fileName?: string;
  /** Options for the embedded `.mcpb` (manifest tweaks, hostile entries, …). */
  mcpb?: Omit<McpbFixtureOptions, 'dir'>;
  name?: string;
  description?: string;
}

export interface PluginFixtureHttp {
  id: string;
  url: string;
  name?: string;
  description?: string;
}

export interface PluginFixtureOptions {
  /** Output directory (created if missing). */
  dir: string;
  /** Default `${id.replace('/', '__')}-${version}.kepcup`. */
  fileName?: string;
  /** Shallow-merged over the default manifest; `null` removes a key. */
  manifest?: Record<string, unknown>;
  skills?: PluginFixtureSkill[];
  connectors?: PluginFixtureConnector[];
  mcpb?: PluginFixtureMcpb[];
  http?: PluginFixtureHttp[];
  mail?: Array<Record<string, unknown>>;
  /** Appended / overriding entries (hostile packages: `../x`, symlinks, duplicates, …). */
  extraEntries?: ZipEntryInput[];
  omitManifest?: boolean;
  /** Written as `plugin.json` verbatim (overrides the generated manifest). */
  rawManifest?: string;
}

export interface PluginFixture {
  path: string;
  sha256: string;
  size: number;
  manifest: Record<string, unknown>;
}

export interface PluginDirFixture {
  path: string;
  manifest: Record<string, unknown>;
}

interface PlannedContent {
  manifest: Record<string, unknown>;
  /** POSIX-style in-package paths (`skills/x/SKILL.md`); data is a string or bytes. */
  files: Array<{ name: string; data: Buffer | string }>;
}

/** The connector contribution body: `server.json` in the open-platform subset. */
export function connectorFixtureEntry(
  slug: string,
  options: { url?: string; tier?: string } = {},
): Record<string, unknown> {
  return {
    name: `test.${slug}/mcp`,
    title: `Fake ${slug}`,
    description: `测试应用 ${slug}`,
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: options.url ?? `https://mcp.${slug}.test/mcp` }],
    _meta: {
      'app.kepcup/connector': {
        slug,
        icon: `${slug}.svg`,
        category: 'productivity',
        tier: options.tier ?? 'builtin',
        auth: {
          kind: 'oauth',
          registration: 'auto',
          clientRef: null,
          scopes: { default: [], write: [] },
        },
        toolPolicy: {},
        skills: [],
        ui: false,
        privacyPolicy: 'https://example.com/privacy',
        releaseGate: 'test',
      },
    },
  };
}

function defaultManifest(options: PluginFixtureOptions): Record<string, unknown> {
  const contributions: Record<string, unknown> = {
    skills: (options.skills ?? []).map((skill) => ({ dir: `skills/${skill.name}` })),
    connectors: (options.connectors ?? []).map((connector) => ({
      file: `connectors/${connector.slug}/server.json`,
    })),
    mcp: [
      ...(options.mcpb ?? []).map((item) => ({
        kind: 'mcpb',
        id: item.id,
        file: `mcp/${item.id}.mcpb`,
        ...(item.name !== undefined ? { name: item.name } : {}),
        ...(item.description !== undefined ? { description: item.description } : {}),
      })),
      ...(options.http ?? []).map((item) => ({
        kind: 'http',
        id: item.id,
        url: item.url,
        ...(item.name !== undefined ? { name: item.name } : {}),
        ...(item.description !== undefined ? { description: item.description } : {}),
      })),
    ],
    mail: options.mail ?? [],
  };
  return {
    format_version: 1,
    id: 'io.github.tester/fixture',
    name: 'Fixture',
    version: '1.0.0',
    description: 'KepCup plugin fixture',
    contributions,
  };
}

function mergeManifest(
  base: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

function skillFile(name: string, description?: string): string {
  return `---\nname: ${name}\ndescription: ${description ?? 'Fixture skill'}\n---\n# ${name}\n`;
}

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

async function planContent(options: PluginFixtureOptions): Promise<PlannedContent> {
  const manifest = mergeManifest(defaultManifest(options), options.manifest);
  const files: PlannedContent['files'] = [];
  for (const skill of options.skills ?? []) {
    files.push({
      name: `skills/${skill.name}/SKILL.md`,
      data: skillFile(skill.name, skill.description),
    });
    for (const [relative, data] of Object.entries(skill.extraFiles ?? {})) {
      files.push({ name: `skills/${skill.name}/${relative}`, data });
    }
  }
  for (const connector of options.connectors ?? []) {
    const iconName = connector.iconName ?? `${connector.slug}.svg`;
    const entry = connectorFixtureEntry(connector.slug, { url: connector.url });
    files.push({
      name: `connectors/${connector.slug}/server.json`,
      data: JSON.stringify({ ...entry, ...connector.entry }, null, 2),
    });
    files.push({ name: `connectors/${connector.slug}/${iconName}`, data: ICON_SVG });
  }
  if ((options.mcpb ?? []).length > 0) {
    // Embedded bundles are real `.mcpb` files built once into a scratch directory and
    // then copied into the package bytes.
    const scratch = await mkdtemp(path.join(tmpdir(), 'plugin-fixture-mcpb-'));
    try {
      for (const item of options.mcpb ?? []) {
        const built = await buildMcpbFixture({ ...item.mcpb, dir: scratch });
        files.push({ name: `mcp/${item.id}.mcpb`, data: await readFile(built.path) });
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return { manifest, files };
}

/** Writes a `.kepcup` plugin package and returns its path, sha256 and the manifest used. */
export async function buildPluginFixture(options: PluginFixtureOptions): Promise<PluginFixture> {
  const { manifest, files } = await planContent(options);
  const entries: ZipEntryInput[] = [];
  if (options.omitManifest !== true) {
    entries.push({
      name: 'plugin.json',
      data: options.rawManifest ?? JSON.stringify(manifest, null, 2),
    });
  }
  entries.push(...files);
  entries.push(...(options.extraEntries ?? []));
  const bytes = buildZip(entries);
  await mkdir(options.dir, { recursive: true });
  const manifestId = String(manifest['id'] ?? 'plugin');
  const manifestVersion = String(manifest['version'] ?? '0.0.0');
  const file = path.join(
    options.dir,
    options.fileName ?? `${manifestId.replace('/', '__')}-${manifestVersion}.kepcup`,
  );
  await writeFile(file, bytes);
  return {
    path: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    manifest,
  };
}

/** The same content as an unpacked directory (development-directory installs). */
export async function buildPluginDir(
  options: Omit<PluginFixtureOptions, 'fileName'>,
): Promise<PluginDirFixture> {
  const { manifest, files } = await planContent(options);
  const root = options.dir;
  await mkdir(root, { recursive: true });
  if (options.omitManifest !== true) {
    await writeFile(
      path.join(root, 'plugin.json'),
      options.rawManifest ?? JSON.stringify(manifest, null, 2),
    );
  }
  for (const file of files) {
    const target = path.join(root, ...file.name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.data);
  }
  return { path: root, manifest };
}
