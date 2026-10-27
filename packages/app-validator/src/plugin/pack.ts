import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PLUGIN_MANIFEST_FILE, pluginManifestSchema } from '@kepcup/shared';
import {
  ZipArchive,
  buildZipBuffer,
  extractZip,
  safeEntryPath,
  type ZipWriteEntry,
} from '@kepcup/package-guard';
import type { PackPluginArgs } from '../args.js';
import { formatReport } from '../report.js';
import type { ValidationReport } from '../types.js';
import { errorMessage } from '../util.js';
import { validatePlugin } from './validate.js';

/**
 * `kepcup-app pack <dir>`: validates the directory, then writes a reproducible `.kepcup`
 * archive (sorted entries, fixed timestamps, no `.git` / `node_modules` / `.DS_Store` /
 * old `.kepcup` files). The result is read back and validated once more before it is
 * reported, so `pack` never claims success for an archive the installer would reject.
 */

export interface PackPluginIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface PackPluginResult {
  path: string;
  sha256: string;
  size: number;
}

export class PluginPackError extends Error {
  readonly report: ValidationReport | null;

  constructor(message: string, report: ValidationReport | null = null) {
    super(message);
    this.report = report;
  }
}

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

interface IgnoreRules {
  exact: Set<string>;
  prefixes: string[];
}

async function readIgnoreRules(root: string): Promise<IgnoreRules> {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  let text: string;
  try {
    text = await readFile(path.join(root, '.kepcup-ignore'), 'utf8');
  } catch {
    return { exact, prefixes };
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const normalized = line.replace(/^\.\//, '');
    if (
      normalized.includes('\\') ||
      normalized.startsWith('/') ||
      normalized.split('/').includes('..')
    ) {
      throw new PluginPackError(`.kepcup-ignore has an invalid path: ${line}`);
    }
    if (normalized.endsWith('/')) prefixes.push(normalized.slice(0, -1));
    else exact.add(normalized);
  }
  return { exact, prefixes };
}

function ignored(relative: string, rules: IgnoreRules): boolean {
  if (rules.exact.has(relative)) return true;
  return rules.prefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}

async function collectEntries(root: string): Promise<ZipWriteEntry[]> {
  const rules = await readIgnoreRules(root);
  const entries: ZipWriteEntry[] = [];
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative === '' ? root : path.join(root, ...relative.split('/'));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new PluginPackError(`Symbolic links cannot be packed: ${relative}`);
    }
    if (info.isDirectory()) {
      if (relative !== '' && !SKIPPED_DIRS.has(path.basename(relative))) {
        entries.push({ name: `${safeEntryPath(relative)}/` });
      }
      for (const child of await readdir(absolute)) {
        const childRelative = relative === '' ? child : `${relative}/${child}`;
        if (SKIPPED_DIRS.has(child)) continue;
        if (ignored(childRelative, rules)) continue;
        await walk(childRelative);
      }
      return;
    }
    if (!info.isFile()) throw new PluginPackError(`Not a regular file: ${relative}`);
    const base = path.basename(relative);
    if (base === '.DS_Store' || base === '.kepcup-ignore' || base.endsWith('.kepcup')) return;
    entries.push({
      name: safeEntryPath(relative),
      data: await readFile(absolute),
      mode: (info.mode & 0o111) !== 0 ? 0o755 : 0o644,
    });
  };
  await walk('');
  return entries;
}

/** Validates `dir` and writes the archive; throws {@link PluginPackError} with the report on failure. */
export async function packPluginDirectory(options: {
  dir: string;
  out?: string | null;
}): Promise<PackPluginResult> {
  const root = path.resolve(options.dir);
  const first = await validatePlugin(root);
  if (first.exitCode !== 0) {
    throw new PluginPackError('The plugin has validation errors; no archive was written.', first);
  }
  const manifestText = await readFile(path.join(root, PLUGIN_MANIFEST_FILE), 'utf8');
  const manifest = pluginManifestSchema.parse(JSON.parse(manifestText) as unknown);
  const entries = await collectEntries(root);
  const bytes = buildZipBuffer(entries);
  const out = path.resolve(
    options.out ?? `${manifest.id.replaceAll('/', '__')}-${manifest.version}.kepcup`,
  );
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  let checkDir: string | null = null;
  let zip: ZipArchive | null = null;
  try {
    zip = await ZipArchive.open(out, { label: '.kepcup' });
    checkDir = await mkdtemp(path.join(tmpdir(), 'kepcup-app-pack-'));
    await extractZip(zip, checkDir, { label: '.kepcup' });
    const second = await validatePlugin(checkDir);
    if (second.exitCode !== 0) {
      throw new PluginPackError(
        'The packed archive failed its self-check; the output file was removed.',
        second,
      );
    }
  } catch (error) {
    await rm(out, { force: true });
    if (error instanceof PluginPackError) throw error;
    throw new PluginPackError(`The packed archive failed its self-check: ${errorMessage(error)}`);
  } finally {
    await zip?.close();
    if (checkDir !== null) await rm(checkDir, { recursive: true, force: true });
  }
  return { path: out, sha256, size: bytes.length };
}

/** CLI wrapper: text / JSON output, exit code 1 for validation and pack failures. */
export async function packPlugin(args: PackPluginArgs, io: PackPluginIo): Promise<number> {
  try {
    const result = await packPluginDirectory(args);
    if (args.json) {
      io.stdout(`${JSON.stringify(result)}\n`);
    } else {
      io.stdout(`Packed ${result.path}\nsha256: ${result.sha256}\nsize: ${result.size} bytes\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof PluginPackError && error.report !== null) {
      io.stderr(formatReport(error.report));
    }
    io.stderr(`kepcup-app: ${errorMessage(error)}\n`);
    return 1;
  }
}
