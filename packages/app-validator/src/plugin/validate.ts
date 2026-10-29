import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PLUGIN_FORMAT_VERSION,
  PLUGIN_ICON_MAX_BYTES,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_MAX_BYTES,
  capabilityFactsOf,
  connectorCatalogEntrySchema,
  connectorMetaOf,
  isReservedPluginNamespace,
  isSafeDirectoryRemoteUrl,
  pluginCapabilitySummary,
  pluginManifestSchema,
  pluginNamespaceOf,
  type PluginField,
  type PluginManifest,
} from '@kepcup/shared';
import {
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_BYTES,
  ZIP_MAX_UNPACKED_BYTES,
  ZipArchive,
  extractZip,
  safeEntryPath,
} from '@kepcup/package-guard';
import { checkManifest } from '../checks/manifest.js';
import { redactCheck } from '../redact.js';
import {
  REPORT_SCHEMA_VERSION,
  makeCheck,
  summarize,
  type Check,
  type ValidationReport,
} from '../types.js';
import { errorMessage } from '../util.js';

/**
 * Offline plugin validation (D104 P2): a plugin directory or a `.kepcup` archive is checked
 * without any network access and without executing package code. The package layer shares
 * `@kepcup/package-guard` with the installer, connector files go through the existing
 * `checkManifest` plus the installer's strict schema, and MCPB bundles only get a structural
 * preview here — the full check (runtimes, user_config, launch template) runs in KepCup
 * during install.
 */

export interface PluginValidateOptions {
  log?: ((line: string) => void) | undefined;
  /** What `report.target` should say when `target` is an internal temp copy (`pack` self-check). */
  displayTarget?: string | undefined;
}

const MCPB_MANIFEST_VERSIONS = new Set(['0.1', '0.2', '0.3']);

function guardError(message: string): Error {
  return new Error(message);
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Same host policy as `isSafeSkillSourceUrl`'s host part (no IPs, localhost, private
 * suffixes), plus the whole-string rule that the URL form enforces: no whitespace or control
 * characters anywhere.
 */
function isPublicMailHost(raw: string): boolean {
  if (/[\s\p{Cc}]/u.test(raw)) return false;
  const host = raw.toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.startsWith('[') || host.includes(':') || /^[0-9.]+$/.test(host)) return false;
  if (!host.includes('.')) return false;
  if (/\.(?:localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return false;
  return true;
}

interface ReferencedPath {
  relative: string;
  expect: 'file' | 'dir';
}

/**
 * Directory mode: walks the tree like `PluginPackager.stage(folder)` — no symlinks, no
 * non-regular files, realpath stays inside, the same entry / size caps. Returns false when
 * the tree itself is unusable (the emitted check explains why).
 */
async function scanDirectoryTree(root: string, checks: Check[]): Promise<boolean> {
  let rootReal: string;
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      checks.push(
        makeCheck('plugin.files-path', 'error', 'The plugin path is not a directory.', {
          subject: root,
        }),
      );
      return false;
    }
    rootReal = await realpath(root);
  } catch (error) {
    checks.push(
      makeCheck(
        'plugin.files-path',
        'error',
        `Cannot read the plugin directory: ${errorMessage(error)}`,
        {
          subject: root,
        },
      ),
    );
    return false;
  }

  let entries = 0;
  let bytes = 0;
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative === '' ? root : path.join(root, ...relative.split('/'));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new CheckFailure(
        'plugin.files-path',
        `Symbolic links are not allowed: ${relative}`,
        relative,
      );
    }
    if (info.isDirectory()) {
      if (relative !== '') {
        entries += 1;
        if (entries > ZIP_MAX_ENTRIES) {
          throw new CheckFailure(
            'plugin.files-limits',
            `The plugin has more than ${ZIP_MAX_ENTRIES} entries.`,
            relative,
          );
        }
        safeEntryPath(relative, guardError);
        const resolved = await realpath(absolute);
        if (!isInside(rootReal, resolved)) {
          throw new CheckFailure(
            'plugin.files-path',
            `The path escapes the plugin directory: ${relative}`,
            relative,
          );
        }
      }
      for (const child of await readdir(absolute)) {
        await walk(relative === '' ? child : `${relative}/${child}`);
      }
      return;
    }
    if (!info.isFile()) {
      throw new CheckFailure('plugin.files-path', `Not a regular file: ${relative}`, relative);
    }
    safeEntryPath(relative, guardError);
    entries += 1;
    if (entries > ZIP_MAX_ENTRIES) {
      throw new CheckFailure(
        'plugin.files-limits',
        `The plugin has more than ${ZIP_MAX_ENTRIES} entries.`,
        relative,
      );
    }
    if (info.size > ZIP_MAX_ENTRY_BYTES) {
      throw new CheckFailure(
        'plugin.files-limits',
        `A file exceeds ${ZIP_MAX_ENTRY_BYTES} bytes: ${relative}`,
        relative,
      );
    }
    bytes += info.size;
    if (bytes > ZIP_MAX_UNPACKED_BYTES) {
      throw new CheckFailure(
        'plugin.files-limits',
        `The plugin exceeds ${ZIP_MAX_UNPACKED_BYTES} bytes unpacked.`,
        relative,
      );
    }
    const resolved = await realpath(absolute);
    if (!isInside(rootReal, resolved)) {
      throw new CheckFailure(
        'plugin.files-path',
        `The path escapes the plugin directory: ${relative}`,
        relative,
      );
    }
  };

  try {
    await walk('');
    return true;
  } catch (error) {
    if (error instanceof CheckFailure) {
      checks.push(makeCheck(error.id, 'error', error.message, { subject: error.subject }));
      return false;
    }
    throw error;
  }
}

class CheckFailure extends Error {
  readonly id: string;
  readonly subject: string;

  constructor(id: string, message: string, subject: string) {
    super(message);
    this.id = id;
    this.subject = subject;
  }
}

/** Extracts an archive into a fresh temp directory; any guard failure becomes one check. */
async function extractArchive(target: string, checks: Check[]): Promise<string | null> {
  let zip: ZipArchive | null = null;
  let dir: string | null = null;
  try {
    zip = await ZipArchive.open(target, { error: guardError, label: '.kepcup' });
    dir = await mkdtemp(path.join(tmpdir(), 'kepcup-app-plugin-'));
    await extractZip(zip, dir, { error: guardError, label: '.kepcup' });
    return dir;
  } catch (error) {
    checks.push(
      makeCheck('plugin.package-entries', 'error', errorMessage(error), {
        ...(dir !== null
          ? { hint: 'Fix the archive (paths, symlinks, duplicate entries, size).' }
          : {}),
      }),
    );
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    return null;
  } finally {
    await zip?.close();
  }
}

interface ReadManifest {
  manifest: PluginManifest;
  /** The parsed JSON object before schema defaults, for "did the author declare X" checks. */
  raw: Record<string, unknown>;
}

async function readManifest(root: string, checks: Check[]): Promise<ReadManifest | null> {
  const file = path.join(root, PLUGIN_MANIFEST_FILE);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    checks.push(
      makeCheck('plugin.manifest-read', 'error', `Missing ${PLUGIN_MANIFEST_FILE}.`, {
        hint: 'A plugin package must contain plugin.json at its root.',
        subject: PLUGIN_MANIFEST_FILE,
      }),
    );
    return null;
  }
  if (bytes.length > PLUGIN_MANIFEST_MAX_BYTES) {
    checks.push(
      makeCheck(
        'plugin.manifest-read',
        'error',
        `${PLUGIN_MANIFEST_FILE} is larger than ${PLUGIN_MANIFEST_MAX_BYTES} bytes.`,
        { subject: PLUGIN_MANIFEST_FILE },
      ),
    );
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    checks.push(
      makeCheck(
        'plugin.manifest-read',
        'error',
        `${PLUGIN_MANIFEST_FILE} is not valid JSON: ${errorMessage(error)}`,
        {
          subject: PLUGIN_MANIFEST_FILE,
        },
      ),
    );
    return null;
  }
  const raw = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const formatVersion = raw['format_version'];
  if (typeof formatVersion === 'number' && formatVersion > PLUGIN_FORMAT_VERSION) {
    checks.push(
      makeCheck(
        'plugin.manifest-format',
        'error',
        `format_version ${formatVersion} is newer than the supported ${PLUGIN_FORMAT_VERSION}.`,
        {
          hint: 'Upgrade KepCup or target the current plugin format.',
          subject: PLUGIN_MANIFEST_FILE,
        },
      ),
    );
    return null;
  }
  const parsed = pluginManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : PLUGIN_MANIFEST_FILE;
      return `${where}: ${issue.message}`;
    });
    checks.push(
      makeCheck(
        'plugin.manifest-schema',
        'error',
        `plugin.json does not match the plugin schema: ${issues.join('; ')}`,
        {
          hint: 'Compare with docs/design/51-plugin-system.md section 3.',
          subject: PLUGIN_MANIFEST_FILE,
          details: { issues },
        },
      ),
    );
    return null;
  }
  return { manifest: parsed.data, raw };
}

async function checkRequiredPath(
  root: string,
  rootReal: string,
  reference: ReferencedPath,
  checks: Check[],
): Promise<boolean> {
  const absolute = path.join(root, ...reference.relative.split('/'));
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      checks.push(
        makeCheck(
          'plugin.files-path',
          'error',
          `Contribution is a symbolic link: ${reference.relative}`,
          {
            subject: reference.relative,
          },
        ),
      );
      return false;
    }
    if (reference.expect === 'file' ? !info.isFile() : !info.isDirectory()) {
      checks.push(
        makeCheck(
          'plugin.files-path',
          'error',
          `Contribution is not a ${reference.expect === 'file' ? 'file' : 'directory'}: ${reference.relative}`,
          { subject: reference.relative },
        ),
      );
      return false;
    }
    const resolved = await realpath(absolute);
    if (!isInside(rootReal, resolved)) {
      checks.push(
        makeCheck(
          'plugin.files-path',
          'error',
          `Contribution escapes the plugin directory: ${reference.relative}`,
          {
            subject: reference.relative,
          },
        ),
      );
      return false;
    }
    return true;
  } catch {
    checks.push(
      makeCheck('plugin.files-path', 'error', `Contribution is missing: ${reference.relative}`, {
        subject: reference.relative,
      }),
    );
    return false;
  }
}

interface PermissionFacts {
  hosts: Set<string>;
  scopes: Set<string>;
  mcpb: Array<{ id: string; userConfig: string[] }>;
  mail: string[];
}

/**
 * Lightweight frontmatter check mirroring core's `splitFrontmatter` (skills/parse.ts): BOM
 * stripped, CRLF normalized, the file must start with `---` and a later line must start with
 * `---`. Anything the installer accepts must pass here too (no false errors).
 */
async function checkSkill(root: string, skillDir: string, checks: Check[]): Promise<void> {
  let text: string;
  try {
    text = await readFile(path.join(root, ...skillDir.split('/'), 'SKILL.md'), 'utf8');
  } catch {
    return;
  }
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  if (!(lines[0] ?? '').startsWith('---')) {
    checks.push(
      makeCheck(
        'plugin.skill-frontmatter',
        'error',
        'SKILL.md does not start with a frontmatter block.',
        {
          hint: 'Start the file with ---, then name: and description:, then a closing ---.',
          subject: skillDir,
        },
      ),
    );
    return;
  }
  const end = lines.findIndex((line, index) => index >= 1 && line.startsWith('---'));
  if (end < 0) {
    checks.push(
      makeCheck('plugin.skill-frontmatter', 'error', 'SKILL.md frontmatter has no closing ---.', {
        subject: skillDir,
      }),
    );
    return;
  }
  const block = lines.slice(1, end).join('\n');
  const missing = ['name', 'description'].filter(
    (key) => !new RegExp(`^${key}\\s*:`, 'm').test(block),
  );
  if (missing.length > 0) {
    checks.push(
      makeCheck(
        'plugin.skill-frontmatter',
        'error',
        `SKILL.md frontmatter is missing: ${missing.join(', ')}.`,
        {
          hint: 'Full parsing and sandbox-compatibility scanning run inside KepCup at install time.',
          subject: skillDir,
        },
      ),
    );
  }
}

async function checkConnector(
  root: string,
  rootReal: string,
  file: string,
  permissions: PermissionFacts,
  checks: Check[],
): Promise<void> {
  const absolute = path.join(root, ...file.split('/'));
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolute, 'utf8')) as unknown;
  } catch (error) {
    checks.push(
      makeCheck(
        'plugin.connector-entry',
        'error',
        `Connector file is not valid JSON: ${errorMessage(error)}`,
        {
          subject: file,
        },
      ),
    );
    return;
  }
  const result = checkManifest(raw);
  for (const check of result.checks) {
    if (check.severity === 'info') continue;
    checks.push(
      makeCheck('plugin.connector-entry', check.severity, `[${check.id}] ${check.message}`, {
        ...(check.hint !== undefined ? { hint: check.hint } : {}),
        subject: check.subject === undefined ? file : `${file} [${check.subject}]`,
        ...(check.details !== undefined ? { details: check.details } : {}),
      }),
    );
  }
  // `checkManifest` is the submission-side check: it fills a `releaseGate` placeholder before
  // parsing. The installer (`rewriteConnectorEntry`) parses the raw JSON strictly instead, so
  // a file that only passes with the placeholder would validate here and still fail to
  // install. Run the installer's parse too and report what it would reject.
  const strict = connectorCatalogEntrySchema.safeParse(raw);
  if (!strict.success) {
    const issues = strict.error.issues.slice(0, 3).map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : file;
      return `${where}: ${issue.message}`;
    });
    checks.push(
      makeCheck(
        'plugin.connector-entry',
        'error',
        `Connector file does not match the catalog entry schema the installer uses: ${issues.join('; ')}`,
        {
          hint: 'Plugin connector entries must be complete as written (KepCup rewrites releaseGate to "plugin" but does not fill it in).',
          subject: file,
          details: { issues },
        },
      ),
    );
    return;
  }
  const entry = strict.data;
  if (entry.packages.length > 0) {
    checks.push(
      makeCheck(
        'plugin.connector-packages',
        'error',
        'Connector entries inside a plugin must not carry packages[]; use mcp contributions for local execution.',
        { subject: file },
      ),
    );
  }
  if (entry.remotes.length === 0) {
    checks.push(
      makeCheck(
        'plugin.connector-remote',
        'error',
        'Connector entries inside a plugin need at least one remote endpoint.',
        { subject: file },
      ),
    );
  }
  for (const remote of entry.remotes) {
    if (!isSafeDirectoryRemoteUrl(remote.url)) {
      checks.push(
        makeCheck(
          'plugin.connector-remote',
          'error',
          `Connector remote must be a public https URL: ${remote.url}`,
          { subject: file },
        ),
      );
    } else {
      permissions.hosts.add(new URL(remote.url).host);
    }
  }
  const meta = connectorMetaOf(entry);
  for (const scope of [...meta.auth.scopes.default, ...meta.auth.scopes.write]) {
    permissions.scopes.add(scope);
  }
  const icon = path.join(path.dirname(absolute), meta.icon);
  try {
    const info = await lstat(icon);
    const resolved = await realpath(icon);
    if (info.isSymbolicLink() || !info.isFile() || !isInside(rootReal, resolved))
      throw new Error('bad icon');
  } catch {
    checks.push(
      makeCheck(
        'plugin.connector-icon',
        'error',
        `Icon must be a file next to server.json: ${meta.icon}`,
        {
          subject: `${file} [${meta.icon}]`,
        },
      ),
    );
  }
}

async function checkMcpb(
  root: string,
  file: string,
  id: string,
  permissions: PermissionFacts,
  checks: Check[],
): Promise<void> {
  let zip: ZipArchive | null = null;
  try {
    zip = await ZipArchive.open(path.join(root, ...file.split('/')), {
      error: guardError,
      label: '.mcpb',
    });
    const manifestEntry = zip.entries.find((entry) => entry.name === 'manifest.json');
    if (manifestEntry === undefined) {
      checks.push(
        makeCheck('plugin.mcpb-package', 'error', 'The embedded .mcpb has no manifest.json.', {
          subject: file,
        }),
      );
      return;
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse((await zip.read(manifestEntry)).toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch (error) {
      checks.push(
        makeCheck(
          'plugin.mcpb-package',
          'error',
          `The embedded .mcpb manifest is not valid JSON: ${errorMessage(error)}`,
          {
            subject: file,
          },
        ),
      );
      return;
    }
    const version = manifest['manifest_version'] ?? manifest['dxt_version'];
    if (typeof version !== 'string' || !MCPB_MANIFEST_VERSIONS.has(version)) {
      checks.push(
        makeCheck(
          'plugin.mcpb-package',
          'error',
          `Unsupported MCPB manifest_version: ${String(version ?? 'missing')} (supported: 0.1 / 0.2 / 0.3).`,
          { subject: file },
        ),
      );
      return;
    }
    const server =
      typeof manifest['server'] === 'object' && manifest['server'] !== null
        ? (manifest['server'] as Record<string, unknown>)
        : null;
    const type = typeof server?.['type'] === 'string' ? (server['type'] as string) : '';
    const entryPoint =
      typeof server?.['entry_point'] === 'string' ? (server['entry_point'] as string) : '';
    if (entryPoint === '') {
      checks.push(
        makeCheck('plugin.mcpb-package', 'error', 'The embedded .mcpb has no server.entry_point.', {
          subject: file,
        }),
      );
      return;
    }
    if (type !== 'uv') {
      const normalized = entryPoint.replace(/^\.\//, '');
      if (!zip.entries.some((entry) => entry.name === normalized)) {
        checks.push(
          makeCheck(
            'plugin.mcpb-package',
            'error',
            `server.entry_point is not inside the bundle: ${entryPoint}`,
            { subject: file },
          ),
        );
      }
    }
    const userConfig =
      typeof manifest['user_config'] === 'object' && manifest['user_config'] !== null
        ? Object.keys(manifest['user_config'] as Record<string, unknown>)
        : [];
    permissions.mcpb.push({ id, userConfig });
    checks.push(
      makeCheck(
        'plugin.mcpb-package',
        'info',
        'Basic MCPB structure is valid. Full validation runs at install time.',
        {
          subject: file,
        },
      ),
    );
  } catch (error) {
    checks.push(
      makeCheck(
        'plugin.mcpb-package',
        'error',
        `The embedded .mcpb is not a valid archive: ${errorMessage(error)}`,
        {
          subject: file,
        },
      ),
    );
  } finally {
    await zip?.close();
  }
}

/** The scalar JS type a declared field type accepts (`directory` / `file` are strings). */
function expectedScalarOf(field: PluginField): 'string' | 'number' | 'boolean' {
  return field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : 'string';
}

/** null = the default agrees with the declared type (and min/max for numbers). */
function defaultMismatch(field: PluginField): string | null {
  if (field.default === undefined) return null;
  const scalar = expectedScalarOf(field);
  const checkScalar = (value: unknown): string | null => {
    if (typeof value === 'string') return scalar === 'string' ? null : 'expected a non-string';
    if (typeof value === 'boolean') return scalar === 'boolean' ? null : 'expected a non-boolean';
    if (typeof value === 'number') {
      if (scalar !== 'number') return 'expected a non-number';
      if (field.min !== undefined && value < field.min) return `below min (${field.min})`;
      if (field.max !== undefined && value > field.max) return `above max (${field.max})`;
      return null;
    }
    return 'unsupported default type';
  };
  if (field.multiple) {
    if (!Array.isArray(field.default)) return 'multiple fields take an array default';
    for (const item of field.default) {
      const issue = checkScalar(item);
      if (issue !== null) return `array item ${issue}`;
    }
    return null;
  }
  return checkScalar(field.default);
}

/**
 * Plugin icon (top-level `icon`): required for a good marketplace listing, but the
 * host has a built-in fallback, so a missing declaration is a warning. A DECLARED icon
 * must actually exist, stay in the package, be SVG / PNG and fit the size cap —
 * otherwise the app would silently show the fallback and the author would never know.
 */
async function checkPluginIcon(
  root: string,
  rootReal: string,
  manifest: PluginManifest,
  checks: Check[],
): Promise<void> {
  const icon = manifest.icon;
  if (icon === undefined) {
    checks.push(
      makeCheck(
        'plugin.icon',
        'warn',
        'The plugin has no icon; the app shows its default icon instead.',
        {
          hint: 'Add icon.svg (64×64 or larger) or icon.png to the package and set "icon" in plugin.json.',
          subject: 'icon',
        },
      ),
    );
    return;
  }
  const ok = await checkRequiredPath(root, rootReal, { relative: icon, expect: 'file' }, checks);
  if (!ok) return;
  const absolute = path.join(root, ...icon.split('/'));
  try {
    const info = await lstat(absolute);
    if (info.size > PLUGIN_ICON_MAX_BYTES) {
      checks.push(
        makeCheck(
          'plugin.icon',
          'error',
          `The icon is larger than ${Math.floor(PLUGIN_ICON_MAX_BYTES / 1024)} KiB: ${icon}`,
          { hint: 'Use a small SVG, or a PNG no larger than the cap.', subject: icon },
        ),
      );
      return;
    }
    const bytes = await readFile(absolute);
    const svg = icon.toLowerCase().endsWith('.svg');
    const usable = svg
      ? /<svg[\s>]/i.test(bytes.subarray(0, 512).toString('utf8'))
      : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!usable) {
      checks.push(
        makeCheck(
          'plugin.icon',
          'error',
          `The icon is not a valid ${svg ? 'SVG' : 'PNG'} file: ${icon}`,
          { subject: icon },
        ),
      );
      return;
    }
    checks.push(makeCheck('plugin.icon', 'info', `Plugin icon: ${icon}.`));
  } catch (error) {
    checks.push(
      makeCheck('plugin.icon', 'error', `The icon cannot be read: ${errorMessage(error)}`, {
        subject: icon,
      }),
    );
  }
}

/**
 * Declarative config / instance fields (D105): the manifest schema already enforces the
 * shape (strict field schema, count caps, duplicate keys, mail builtin-key clashes) —
 * these checks cover what a schema cannot say: `default`/type agreement, the two default
 * semantics traps (manifest defaults never materialize into `config_json` — consumers
 * fall back to the declared default themselves; a sensitive field's default never lands
 * anywhere readable), and a preview of the one-line capability summary the consent card
 * and the market/installed cards will show (generated from the manifest, never authored).
 */
function checkDeclarativeFields(manifest: PluginManifest, checks: Check[]): void {
  const fieldSets: Array<{ subject: string; fields: readonly PluginField[] }> = [
    { subject: 'config', fields: manifest.config?.fields ?? [] },
  ];
  for (const template of manifest.contributions.mail) {
    fieldSets.push({ subject: `mail:${template.id}`, fields: template.instanceFields ?? [] });
  }
  for (const { subject, fields } of fieldSets) {
    fields.forEach((field, index) => {
      const where = `${subject}[${index}] ${field.key}`;
      if (field.sensitive && field.default !== undefined) {
        checks.push(
          makeCheck(
            'plugin.field-default',
            'warn',
            `Sensitive field declares a default: ${where}. The default is never readable for a sensitive field — drop it and let the user enter the value.`,
            { subject: where },
          ),
        );
      }
      const mismatch = defaultMismatch(field);
      if (mismatch !== null) {
        checks.push(
          makeCheck(
            'plugin.field-default',
            'warn',
            `default does not match the declared type: ${where} (${mismatch}).`,
            { subject: where },
          ),
        );
      }
    });
  }
  const summary = pluginCapabilitySummary(capabilityFactsOf(manifest));
  checks.push(
    makeCheck(
      'plugin.capabilities',
      'info',
      `Users will see the capability line "${summary}" on the consent and plugin cards.`,
      {
        details: {
          capabilitySummary: summary,
          configFields: manifest.config?.fields.length ?? 0,
          instanceKinds: manifest.instances ?? [],
        },
      },
    ),
  );
}

function checkMail(
  id: string,
  template: PluginManifest['contributions']['mail'][number],
  permissions: PermissionFacts,
  checks: Check[],
): void {
  for (const [kind, host] of [
    ['imap', template.imap.host],
    ['smtp', template.smtp.host],
  ] as const) {
    // D105 P3: an empty host is the GENERIC mail plugin shape — endpoints become
    // per-instance form fields instead of locked values (the manifest schema enforces
    // both sides empty at once).
    if (host === '') {
      continue;
    }
    if (isPublicMailHost(host)) {
      permissions.hosts.add(host);
      continue;
    }
    checks.push(
      makeCheck('plugin.mail-host', 'error', `${kind}.host must be a public domain name: ${host}`, {
        subject: `${id} [${kind}]`,
      }),
    );
  }
  permissions.mail.push(id);
}

/** Plugin-mode report (offline; no remote, no authorization). */
export async function validatePlugin(
  target: string,
  options: PluginValidateOptions = {},
): Promise<ValidationReport> {
  const checks: Check[] = [];
  const log = options.log ?? (() => undefined);
  const finish = (): ValidationReport => {
    const summary = summarize(checks);
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      mode: 'plugin',
      target: options.displayTarget ?? target,
      remote: null,
      auth: false,
      summary,
      exitCode: summary.errors > 0 ? 1 : 0,
      checks: checks.map(redactCheck),
    };
  };

  const archive = target.toLowerCase().endsWith('.kepcup');
  let root: string;
  let cleanup: (() => Promise<void>) | null = null;
  if (archive) {
    log('Extracting the plugin package ...');
    const extracted = await extractArchive(target, checks);
    if (extracted === null) return finish();
    root = extracted;
    cleanup = () => rm(extracted, { recursive: true, force: true });
  } else {
    root = path.resolve(target);
  }

  try {
    if (!(await scanDirectoryTree(root, checks))) return finish();
    const rootReal = await realpath(root);
    log('Checking plugin.json ...');
    const read = await readManifest(root, checks);
    if (read === null) return finish();
    const { manifest, raw: rawManifest } = read;

    if (isReservedPluginNamespace(pluginNamespaceOf(manifest.id))) {
      checks.push(
        makeCheck(
          'plugin.manifest-namespace',
          'error',
          `The namespace is reserved: ${manifest.id}`,
          {
            hint: 'Use your own reverse-domain namespace (com.kepcup and local.kepcup are builtin-only).',
            subject: PLUGIN_MANIFEST_FILE,
          },
        ),
      );
    }

    for (const [key, hint] of [
      ['description', 'Users see the description on the consent card.'],
      ['author', 'Author information helps users judge the source.'],
      ['homepage', 'A homepage makes the plugin reviewable.'],
      ['engines', 'Declare engines.kepcup so incompatible clients fail early.'],
    ] as const) {
      const value = rawManifest[key];
      if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
        checks.push(
          makeCheck('plugin.manifest-metadata', 'warn', `The manifest does not declare ${key}.`, {
            hint,
            subject: key,
          }),
        );
      }
    }

    try {
      const readme = await lstat(path.join(root, 'README.md'));
      if (!readme.isFile()) throw new Error('not a file');
    } catch {
      checks.push(
        makeCheck('plugin.readme', 'warn', 'The plugin has no README.md.', {
          hint: 'A README is shown on the plugin detail page.',
        }),
      );
    }

    checkDeclarativeFields(manifest, checks);
    await checkPluginIcon(root, rootReal, manifest, checks);

    const permissions: PermissionFacts = {
      hosts: new Set<string>(),
      scopes: new Set<string>(),
      mcpb: [],
      mail: [],
    };
    const { contributions } = manifest;
    for (const skill of contributions.skills) {
      const ok = await checkRequiredPath(
        root,
        rootReal,
        { relative: skill.dir, expect: 'dir' },
        checks,
      );
      if (!ok) continue;
      if (
        await checkRequiredPath(
          root,
          rootReal,
          { relative: `${skill.dir}/SKILL.md`, expect: 'file' },
          checks,
        )
      ) {
        await checkSkill(root, skill.dir, checks);
      }
    }
    for (const connector of contributions.connectors) {
      if (
        await checkRequiredPath(
          root,
          rootReal,
          { relative: connector.file, expect: 'file' },
          checks,
        )
      ) {
        await checkConnector(root, rootReal, connector.file, permissions, checks);
      }
    }
    for (const contribution of contributions.mcp) {
      if (contribution.kind === 'mcpb') {
        if (
          await checkRequiredPath(
            root,
            rootReal,
            { relative: contribution.file, expect: 'file' },
            checks,
          )
        ) {
          await checkMcpb(root, contribution.file, contribution.id, permissions, checks);
        }
      } else if (!isSafeDirectoryRemoteUrl(contribution.url)) {
        checks.push(
          makeCheck(
            'plugin.mcp-http',
            'error',
            `http contribution URL must be a public https URL: ${contribution.url}`,
            { subject: contribution.id },
          ),
        );
      } else {
        permissions.hosts.add(new URL(contribution.url).host);
        checks.push(
          makeCheck(
            'plugin.mcp-http',
            'info',
            'http contribution is a public https endpoint. Remote servers that need OAuth must be connector contributions.',
            { subject: contribution.id },
          ),
        );
      }
    }
    for (const template of contributions.mail) {
      checkMail(template.id, template, permissions, checks);
    }

    const hosts = [...permissions.hosts].sort();
    const scopes = [...permissions.scopes].sort();
    checks.push(
      makeCheck(
        'plugin.permissions',
        'info',
        `The consent card will show ${hosts.length} host(s), ${scopes.length} OAuth scope(s), ` +
          `${permissions.mcpb.length} embedded MCPB bundle(s) and ${permissions.mail.length} mail template(s).`,
        {
          details: {
            hosts,
            oauthScopes: scopes,
            mcpb: permissions.mcpb,
            mail: permissions.mail,
          },
        },
      ),
    );
    return finish();
  } finally {
    if (cleanup !== null) await cleanup();
  }
}
