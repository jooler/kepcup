// Shared helpers for the release scripts (docs/dev/06-release.md).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const desktopPackageJson = path.join(repoDir, 'apps/desktop/package.json');

/** The app version electron-builder ships (apps/desktop/package.json is the single source). */
export function appVersion() {
  return JSON.parse(readFileSync(desktopPackageJson, 'utf8')).version;
}

export const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Parses a dotenv file (same rules as apps/desktop/scripts/dist.mjs: KEY=VALUE,
 * optional `export`, quotes stripped, trailing ` # comment` dropped on unquoted values).
 */
export function parseEnvFile(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    value = quoted !== null ? quoted[2] : value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  return values;
}

/** `.env.release` (gitignored) under the shell environment: an exported variable wins. */
export function loadReleaseEnv() {
  const file = path.join(repoDir, '.env.release');
  if (!existsSync(file)) {
    throw new Error(
      `missing ${file} — cp .env.release.example .env.release && chmod 600 .env.release`,
    );
  }
  return { ...parseEnvFile(file), ...process.env };
}

/** Runs a command; throws on a non-zero exit. `capture` returns trimmed stdout. */
export function run(command, args, { capture = false, input, env, cwd = repoDir } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    env: env ?? process.env,
    encoding: 'utf8',
    stdio:
      capture || input !== undefined
        ? ['pipe', capture ? 'pipe' : 'inherit', 'inherit']
        : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
  return capture ? result.stdout.trim() : '';
}

export function requireTool(command, hint) {
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (probe.error) throw new Error(`${command} not found — ${hint}`);
}
