import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PLUGIN_MANIFEST_FILE, pluginManifestSchema } from '@kepcup/shared';
import { buildZipBuffer, safeEntryPath, type ZipWriteEntry } from '@kepcup/package-guard';
import type { PackPluginArgs } from '../args.js';
import { formatReport } from '../report.js';
import { REPORT_SCHEMA_VERSION, makeCheck, summarize, type ValidationReport } from '../types.js';
import { errorMessage } from '../util.js';
import { validatePlugin } from './validate.js';

/**
 * `kepcup-app pack <dir>`: collects the directory minus the exclusions (`.git` /
 * `node_modules` / `.DS_Store` / old `.kepcup` files / `.kepcup-ignore` paths), builds a
 * reproducible `.kepcup` (sorted entries, fixed timestamps), validates **that archive** through
 * the same `package-guard` + `validatePlugin` path the installer uses, and only then writes it
 * to the output path. What gets validated is exactly what ships, so a development directory
 * with `node_modules` packs fine and `pack` never claims success for an archive the installer
 * would reject.
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
  /** Present when the failure is about the plugin's content (CLI exit 1); null for tool failures (exit 2). */
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

/** A one-check plugin report for problems found while walking the directory itself. */
function directoryReport(root: string, message: string, subject: string): ValidationReport {
  const checks = [makeCheck('plugin.files-path', 'error', message, { subject })];
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: 'plugin',
    target: root,
    remote: null,
    auth: false,
    summary: summarize(checks),
    exitCode: 1,
    checks,
  };
}

async function collectEntries(root: string): Promise<ZipWriteEntry[]> {
  const rules = await readIgnoreRules(root);
  const entries: ZipWriteEntry[] = [];
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative === '' ? root : path.join(root, ...relative.split('/'));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new PluginPackError(
        `Symbolic links cannot be packed: ${relative}`,
        directoryReport(root, `Symbolic links are not allowed: ${relative}`, relative),
      );
    }
    if (info.isDirectory()) {
      if (relative !== '') entries.push({ name: `${safeEntryPath(relative)}/` });
      for (const child of await readdir(absolute)) {
        const childRelative = relative === '' ? child : `${relative}/${child}`;
        if (SKIPPED_DIRS.has(child)) continue;
        if (ignored(childRelative, rules)) continue;
        await walk(childRelative);
      }
      return;
    }
    if (!info.isFile()) {
      throw new PluginPackError(
        `Not a regular file: ${relative}`,
        directoryReport(root, `Not a regular file: ${relative}`, relative),
      );
    }
    const base = path.basename(relative);
    if (
      base === '.DS_Store' ||
      base === '.kepcup-ignore' ||
      base.toLowerCase().endsWith('.kepcup')
    ) {
      return;
    }
    entries.push({
      name: safeEntryPath(relative),
      data: await readFile(absolute),
      mode: (info.mode & 0o111) !== 0 ? 0o755 : 0o644,
    });
  };
  const rootInfo = await lstat(root).catch(() => null);
  if (rootInfo === null || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new PluginPackError(
      `Not a plugin directory: ${root}`,
      directoryReport(root, 'The plugin path is not a directory.', root),
    );
  }
  await walk('');
  return entries;
}

/**
 * Packs `dir` and writes the archive; throws {@link PluginPackError} (with the report when
 * the plugin content is at fault) and writes nothing on failure.
 */
export async function packPluginDirectory(options: {
  dir: string;
  out?: string | null;
}): Promise<PackPluginResult> {
  const root = path.resolve(options.dir);
  const entries = await collectEntries(root);
  let bytes: Buffer;
  try {
    bytes = buildZipBuffer(entries);
  } catch (error) {
    throw new PluginPackError(
      `Cannot build the archive: ${errorMessage(error)}`,
      directoryReport(root, errorMessage(error), root),
    );
  }

  // Validate the bytes that will ship, through the same archive path the installer takes.
  const stagingDir = await mkdtemp(path.join(tmpdir(), 'kepcup-app-pack-'));
  try {
    const candidate = path.join(stagingDir, 'candidate.kepcup');
    await writeFile(candidate, bytes);
    const report = await validatePlugin(candidate, { displayTarget: root });
    if (report.exitCode !== 0) {
      throw new PluginPackError(
        'The plugin has validation errors; no archive was written.',
        report,
      );
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  const manifestEntry = entries.find((entry) => entry.name === PLUGIN_MANIFEST_FILE);
  const manifest = pluginManifestSchema.parse(
    JSON.parse(Buffer.from(manifestEntry?.data ?? new Uint8Array()).toString('utf8')) as unknown,
  );
  const out = path.resolve(
    options.out ?? `${manifest.id.replaceAll('/', '__')}-${manifest.version}.kepcup`,
  );
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, bytes);
  return {
    path: out,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

/** CLI wrapper: text / JSON output; exit 1 for plugin content problems, 2 for tool failures. */
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
      io.stderr(`kepcup-app: ${error.message}\n`);
      return 1;
    }
    io.stderr(`kepcup-app: ${errorMessage(error)}\n`);
    return 2;
  }
}
