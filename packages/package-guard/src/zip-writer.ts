import { deflateRawSync } from 'node:zlib';
import { crc32, resolveZipGuard, safeEntryPath, type ZipGuardOptions } from './zip.js';

/**
 * Deterministic ZIP writer for plugin packages (`kepcup-app pack`). The byte layout
 * mirrors `testkit/src/mcpb-fixture.ts`'s `buildZip`: stored / deflate entries, Unix
 * "version made by", UTF-8 names, no ZIP64, encryption or symlinks. Entries are sorted by
 * name and timestamps are fixed at 1980-01-01 00:00 so identical input always produces
 * identical bytes.
 */

export interface ZipWriteEntry {
  /** Relative POSIX path; a trailing `/` marks a directory. Always goes through {@link safeEntryPath}. */
  name: string;
  /** File content; omitted for directories. */
  data?: Uint8Array;
  /** Unix permission bits; only the executable bit is honoured (0o755 vs 0o644). */
  mode?: number;
}

interface PlannedEntry {
  name: string;
  isDirectory: boolean;
  data: Buffer;
  mode: number;
}

const DOS_DATE = 0x0021;
const DOS_TIME = 0;

function permissionMode(mode: number | undefined): number {
  return mode !== undefined && (mode & 0o111) !== 0 ? 0o755 : 0o644;
}

/** Builds a ZIP archive; throws via the configured error factory on any guard violation. */
export function buildZipBuffer(
  entries: readonly ZipWriteEntry[],
  options: ZipGuardOptions = {},
): Buffer {
  const { error, limits } = resolveZipGuard(options);
  if (entries.length > limits.maxEntries) {
    throw error(`包内条目过多（上限 ${limits.maxEntries}）`);
  }
  const planned: PlannedEntry[] = [];
  const seen = new Set<string>();
  let unpacked = 0;
  for (const entry of entries) {
    const isDirectory = entry.name.endsWith('/');
    const safe = safeEntryPath(entry.name, error);
    const key = safe.toLowerCase();
    if (seen.has(key)) throw error(`包内有重复路径：${entry.name}`);
    seen.add(key);
    const data = isDirectory ? Buffer.alloc(0) : Buffer.from(entry.data ?? new Uint8Array());
    if (data.length > limits.maxEntryBytes) throw error(`包内文件过大：${entry.name}`);
    unpacked += data.length;
    if (unpacked > limits.maxUnpackedBytes) throw error('包内容体积超过上限');
    planned.push({
      name: isDirectory ? `${safe}/` : safe,
      isDirectory,
      data,
      mode: permissionMode(entry.mode),
    });
  }
  planned.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of planned) {
    const name = Buffer.from(entry.name, 'utf8');
    const body =
      !entry.isDirectory && entry.data.length > 0
        ? deflateRawSync(entry.data, { level: 9 })
        : entry.data;
    const method = body === entry.data ? 0 : 8;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const typeBits = entry.isDirectory ? 0o040000 : 0o100000;
    const mode = typeBits | entry.mode;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((mode << 16) | (entry.isDirectory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(planned.length, 8);
  eocd.writeUInt16LE(planned.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const output = Buffer.concat([...locals, centralBuffer, eocd]);
  if (output.length > limits.maxFileBytes) throw error(`包文件过大（上限 ${limits.maxFileBytes}）`);
  return output;
}
