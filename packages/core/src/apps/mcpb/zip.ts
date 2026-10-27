import {
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_BYTES,
  ZIP_MAX_UNPACKED_BYTES,
  ZIP_MAX_FILE_BYTES,
  ZipArchive as GuardZipArchive,
  crc32,
  safeEntryPath as guardSafeEntryPath,
  type ZipEntry,
} from '@kepcup/package-guard';
import { AppError } from '@kepcup/shared';

/**
 * Thin adapter over `@kepcup/package-guard` (D104): the ZIP reader itself lives in the
 * dependency-free package; here it is pinned to the MCPB error policy (`MCPB_INVALID`
 * with the `.mcpb` label) so callers and tests keep their original surface.
 */

const invalid = (message: string): Error => new AppError('MCPB_INVALID', message);

export { crc32, type ZipEntry };
export const MCPB_MAX_ENTRIES = ZIP_MAX_ENTRIES;
export const MCPB_MAX_ENTRY_BYTES = ZIP_MAX_ENTRY_BYTES;
export const MCPB_MAX_UNPACKED_BYTES = ZIP_MAX_UNPACKED_BYTES;
export const MCPB_MAX_FILE_BYTES = ZIP_MAX_FILE_BYTES;
export const safeEntryPath = (name: string): string => guardSafeEntryPath(name, invalid);
export class ZipArchive {
  static open(filePath: string): Promise<GuardZipArchive> {
    return GuardZipArchive.open(filePath, { error: invalid, label: '.mcpb' });
  }
}
