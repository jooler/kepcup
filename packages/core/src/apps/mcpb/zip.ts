import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { AppError } from '@kepcup/shared';

/**
 * Minimal read-only ZIP reader (stored + deflate, no ZIP64, no encryption) for
 * `.mcpb` bundles. Reads only the central directory plus the byte ranges of the
 * requested entries, and enforces hard caps so a hostile archive cannot exhaust
 * memory or disk before extraction is even decided.
 */

export const MCPB_MAX_ENTRIES = 20_000;
export const MCPB_MAX_ENTRY_BYTES = 200 * 1024 * 1024;
export const MCPB_MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
export const MCPB_MAX_FILE_BYTES = 512 * 1024 * 1024;

const READ_CHUNK_BYTES = 1024 * 1024;
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export interface ZipEntry {
  /** Raw entry name as stored (validated separately by {@link safeEntryPath}). */
  name: string;
  isDirectory: boolean;
  /** Unix file-type bits of external attributes (0 when the archive is not Unix-made). */
  unixMode: number;
  isSymlink: boolean;
  compressedSize: number;
  size: number;
  method: number;
  crc32: number;
  localOffset: number;
}

function invalid(message: string): AppError {
  return new AppError('MCPB_INVALID', message);
}

/** Reserved Windows device names, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

let crcTable: Uint32Array | null = null;
export function crc32(buffer: Uint8Array): number {
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

export class ZipArchive {
  readonly entries: readonly ZipEntry[];
  readonly #handle: FileHandle;

  readonly #fileSize: number;

  private constructor(handle: FileHandle, entries: ZipEntry[], fileSize: number) {
    this.#handle = handle;
    this.entries = entries;
    this.#fileSize = fileSize;
  }

  static async open(filePath: string): Promise<ZipArchive> {
    const handle = await open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      if (size > MCPB_MAX_FILE_BYTES) throw invalid('包文件过大');
      if (size < 22) throw invalid('不是有效的 .mcpb（ZIP）文件');
      const tailLength = Math.min(size, 22 + 0xffff);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, size - tailLength);
      let eocd = -1;
      for (let i = tailLength - 22; i >= 0; i -= 1) {
        if (tail.readUInt32LE(i) === EOCD_SIG) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw invalid('不是有效的 .mcpb（ZIP）文件：找不到目录结尾');
      const total = tail.readUInt16LE(eocd + 10);
      const cenSize = tail.readUInt32LE(eocd + 12);
      const cenOffset = tail.readUInt32LE(eocd + 16);
      if (total === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) {
        throw invalid('不支持 ZIP64 的 .mcpb 包');
      }
      if (total > MCPB_MAX_ENTRIES) throw invalid(`包内文件过多（上限 ${MCPB_MAX_ENTRIES}）`);
      if (cenOffset + cenSize > size) throw invalid('ZIP 目录越界');
      const cen = Buffer.alloc(cenSize);
      await handle.read(cen, 0, cenSize, cenOffset);
      const entries: ZipEntry[] = [];
      let offset = 0;
      let unpacked = 0;
      for (let i = 0; i < total; i += 1) {
        if (offset + 46 > cenSize || cen.readUInt32LE(offset) !== CEN_SIG) {
          throw invalid('ZIP 目录损坏');
        }
        const versionMadeBy = cen.readUInt16LE(offset + 4);
        const flags = cen.readUInt16LE(offset + 8);
        const method = cen.readUInt16LE(offset + 10);
        const crc = cen.readUInt32LE(offset + 16);
        const compressedSize = cen.readUInt32LE(offset + 20);
        const entrySize = cen.readUInt32LE(offset + 24);
        const nameLength = cen.readUInt16LE(offset + 28);
        const extraLength = cen.readUInt16LE(offset + 30);
        const commentLength = cen.readUInt16LE(offset + 32);
        const externalAttrs = cen.readUInt32LE(offset + 38);
        const localOffset = cen.readUInt32LE(offset + 42);
        if (offset + 46 + nameLength > cenSize) throw invalid('ZIP 目录损坏');
        const name = cen.toString('utf8', offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + extraLength + commentLength;
        if ((flags & 1) !== 0) throw invalid('不支持加密的 .mcpb 包');
        if (compressedSize === 0xffffffff || entrySize === 0xffffffff) {
          throw invalid('不支持 ZIP64 的 .mcpb 包');
        }
        if (entrySize > MCPB_MAX_ENTRY_BYTES || compressedSize > MCPB_MAX_ENTRY_BYTES) {
          throw invalid(`包内文件过大：${name}`);
        }
        // Declared sizes come from the (untrusted) central directory: bound them by the real
        // file before anything is allocated or read.
        if (compressedSize > size || localOffset + 30 + compressedSize > size) {
          throw invalid(`ZIP 条目大小越界：${name}`);
        }
        if (method === 0 && compressedSize !== entrySize) {
          throw invalid(`ZIP 条目大小与目录不符：${name}`);
        }
        unpacked += entrySize;
        if (unpacked > MCPB_MAX_UNPACKED_BYTES) throw invalid('包解压后体积超过上限');
        // Unix mode bits only mean something when the archive was made on Unix (host 3).
        const unixMode = versionMadeBy >> 8 === 3 ? (externalAttrs >>> 16) & 0xffff : 0;
        const isSymlink = (unixMode & 0xf000) === 0xa000;
        entries.push({
          name,
          isDirectory: name.endsWith('/'),
          unixMode,
          isSymlink,
          compressedSize,
          size: entrySize,
          method,
          crc32: crc,
          localOffset,
        });
      }
      return new ZipArchive(handle, entries, size);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  get unpackedSize(): number {
    return this.entries.reduce((sum, entry) => sum + entry.size, 0);
  }

  async read(entry: ZipEntry): Promise<Buffer> {
    const header = Buffer.alloc(30);
    const headerRead = await this.#handle.read(header, 0, 30, entry.localOffset);
    if (headerRead.bytesRead !== 30 || header.readUInt32LE(0) !== LOC_SIG) {
      throw invalid(`ZIP 条目损坏：${entry.name}`);
    }
    const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (dataStart + entry.compressedSize > this.#fileSize) {
      throw invalid(`ZIP 条目被截断：${entry.name}`);
    }
    const compressed = Buffer.alloc(entry.compressedSize);
    // Chunked: a single huge fs.read length aborts the process on some Node versions.
    for (let done = 0; done < entry.compressedSize;) {
      const length = Math.min(READ_CHUNK_BYTES, entry.compressedSize - done);
      const { bytesRead } = await this.#handle.read(compressed, done, length, dataStart + done);
      if (bytesRead === 0) throw invalid(`ZIP 条目被截断：${entry.name}`);
      done += bytesRead;
    }
    let data: Buffer;
    if (entry.method === 0) {
      data = compressed;
    } else if (entry.method === 8) {
      try {
        // maxOutputLength bounds a decompression bomb to the (already capped) declared size.
        data = inflateRawSync(compressed, { maxOutputLength: Math.max(entry.size, 1) });
      } catch {
        throw invalid(`ZIP 条目解压失败：${entry.name}`);
      }
    } else {
      throw invalid(`不支持的压缩方式（${entry.method}）：${entry.name}`);
    }
    if (data.length !== entry.size) throw invalid(`ZIP 条目大小与目录不符：${entry.name}`);
    if (crc32(data) !== entry.crc32) throw invalid(`ZIP 条目校验失败：${entry.name}`);
    return data;
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

/**
 * Validates an entry name and returns its normalized relative POSIX path
 * (directory names lose the trailing slash). Rejects absolute paths, drive
 * letters, backslashes, NUL, and any `.` / `..` / empty segment (zip-slip).
 */
export function safeEntryPath(name: string): string {
  const bad = (reason: string) => invalid(`包内路径不安全（${reason}）：${JSON.stringify(name)}`);
  if (name.length === 0 || name.length > 1024) throw bad('长度');
  if (name.includes('\0')) throw bad('含 NUL');
  if (name.includes('\\')) throw bad('含反斜杠');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw bad('绝对路径');
  if (name.includes(':')) throw bad('含冒号');
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw bad('越界路径段');
    if (/[. ]$/.test(segment)) throw bad('路径段以点或空格结尾');
    if (WINDOWS_DEVICE_NAME.test(segment)) throw bad('Windows 保留设备名');
  }
  return segments.join('/');
}
