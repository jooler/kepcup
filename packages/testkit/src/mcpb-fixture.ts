import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

/**
 * MCPB fixture builder (D73 P2 §6.5): writes a real `.mcpb` (ZIP) into a temp directory from a
 * manifest and a tiny stdio MCP server, so installed bundles can actually be started by
 * McpService in tests. No ZIP library: stored/deflate entries are written by hand, which also
 * lets tests craft hostile archives (zip-slip names, symlinks, absolute paths).
 */

export interface ZipEntryInput {
  /** Stored verbatim — may be hostile (`../x`, `/abs`, `a\\b`). */
  name: string;
  data?: Buffer | string;
  /** Unix permission bits (e.g. 0o755). */
  mode?: number;
  /** Marks the entry as a symlink (data = link target). */
  symlink?: boolean;
  /** Default true. */
  deflate?: boolean;
}

let crcTable: Uint32Array | null = null;
function crc32(buffer: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a ZIP archive (Unix "version made by", central directory, no ZIP64). */
export function buildZip(entries: readonly ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data ?? '');
    const isDir = entry.name.endsWith('/');
    const deflate = entry.deflate !== false && raw.length > 0 && !isDir;
    const body = deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const typeBits = entry.symlink === true ? 0o120000 : isDir ? 0o040000 : 0o100000;
    const mode = typeBits | (entry.mode ?? (isDir ? 0o755 : 0o644));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

const require = createRequire(import.meta.url);

/**
 * A stdio MCP server (CommonJS) on the real `@modelcontextprotocol/sdk` — the absolute SDK
 * paths are baked in because an extracted bundle has no `node_modules`. Tools: `echo`,
 * `read_env` (an env var's value — proves secrets / config reach the process) and `argv`.
 */
export function mcpbEchoServerSource(): string {
  const serverModule = JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'));
  const stdioModule = JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'));
  const typesModule = JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'));
  return `'use strict';
const { Server } = require(${serverModule});
const { StdioServerTransport } = require(${stdioModule});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${typesModule});

const server = new Server(
  { name: 'mcpb-echo', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
const text = (value) => ({ content: [{ type: 'text', text: value }] });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the input text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'read_env',
      description: 'Return an environment variable of the server process',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'argv',
      description: 'Return the process arguments',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case 'echo':
      return text('echo:' + String(args.text ?? ''));
    case 'read_env':
      return text('env:' + String(process.env[String(args.name ?? '')] ?? 'MISSING'));
    case 'argv':
      return text('argv:' + JSON.stringify(process.argv.slice(2)));
    default:
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  }
});
server.connect(new StdioServerTransport());
`;
}

export interface McpbFixtureOptions {
  /** Directory the `.mcpb` is written to (created if missing). */
  dir: string;
  fileName?: string;
  /** Shallow-merged over the default manifest; `null` removes a key. */
  manifest?: Record<string, unknown>;
  /** Replaces the bundled server script (default: {@link mcpbEchoServerSource}). */
  serverSource?: string;
  /** Extra / overriding archive entries (appended after the generated ones). */
  extraEntries?: readonly ZipEntryInput[];
  /** Skip the generated `manifest.json` (for broken-bundle tests). */
  omitManifest?: boolean;
  /** Written as `manifest.json` verbatim (overrides the generated manifest). */
  rawManifest?: string;
}

export interface McpbFixture {
  path: string;
  sha256: string;
  size: number;
  manifest: Record<string, unknown>;
}

export function defaultMcpbManifest(): Record<string, unknown> {
  return {
    manifest_version: '0.3',
    name: 'echo-bundle',
    display_name: 'Echo Bundle',
    version: '1.0.0',
    description: 'KepCup test bundle',
    author: { name: 'KepCup tests' },
    server: {
      type: 'node',
      entry_point: 'server/index.cjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.cjs'],
        env: {},
      },
    },
    compatibility: { platforms: ['darwin', 'win32', 'linux'] },
  };
}

/** Writes a `.mcpb` bundle and returns its path, sha256 and the manifest used. */
export async function buildMcpbFixture(options: McpbFixtureOptions): Promise<McpbFixture> {
  const manifest: Record<string, unknown> = { ...defaultMcpbManifest() };
  for (const [key, value] of Object.entries(options.manifest ?? {})) {
    if (value === null) delete manifest[key];
    else manifest[key] = value;
  }
  const entries: ZipEntryInput[] = [];
  if (options.omitManifest !== true) {
    entries.push({
      name: 'manifest.json',
      data: options.rawManifest ?? JSON.stringify(manifest, null, 2),
    });
  }
  entries.push({ name: 'server/' });
  entries.push({
    name: 'server/index.cjs',
    data: options.serverSource ?? mcpbEchoServerSource(),
    mode: 0o755,
  });
  entries.push(...(options.extraEntries ?? []));
  const bytes = buildZip(entries);
  await mkdir(options.dir, { recursive: true });
  const file = path.join(
    options.dir,
    options.fileName ?? `${String(manifest['name'] ?? 'bundle')}.mcpb`,
  );
  await writeFile(file, bytes);
  return {
    path: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    manifest,
  };
}
