import {
  AppError,
  allowlistPatternRefusal,
  newId,
  type AllowlistEntry,
  type AllowlistPlatform,
} from '@kepcup/shared';
import { matchAllowlistCommand, type AllowlistCheckContext, type AllowlistVerdict } from './allowlist-match.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface AllowlistRow {
  id: string;
  platform: AllowlistPlatform;
  pattern: string;
  builtin: number;
  enabled: number;
  created_at: number;
}

function rowToEntry(row: AllowlistRow): AllowlistEntry {
  return {
    id: row.id,
    platform: row.platform,
    pattern: row.pattern,
    builtin: row.builtin === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

/**
 * docs/design/13-permissions.md "只读命令白名单" built-ins.
 *
 * Every entry must be read-only AND unable to load workdir-controlled code or
 * reach the network when run unsandboxed in confirm mode (review P0):
 * package-manager / toolchain-proxy probes are excluded on purpose — `pnpm` /
 * `yarn --version` go through corepack (downloads the `packageManager`
 * version), `cargo` / `rustc` through rustup (`rust-toolchain.toml`), `go
 * version` through `GOTOOLCHAIN` (may download a toolchain). The remaining
 * probes resolve whatever the cleaned PATH yields (exempt runs drop relative
 * entries and entries inside the workspace / workdir, see `exemptCommandEnv`),
 * so never a Bot-written executable. That is not always a plain global binary:
 * a version-manager shim (pyenv / rbenv / nodenv / asdf) may pick an installed
 * version from files in the working directory — it runs no workdir code;
 * Volta shims, which can download a pinned toolchain, are bypassed
 * (`VOLTA_BYPASS=1`), so a probe may then report the system version or fail.
 * The shape is pinned by `allowlist-match.test.ts` ("built-in patterns"):
 * adding an entry needs an explicit decision there.
 */
export const BUILTIN_PATTERNS: Record<AllowlistPlatform, string[]> = {
  posix: [
    // Inspect / list
    'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'tree',
    'which', 'grep', 'rg', 'find',
    'echo', 'printf', 'true', 'false', 'dirname', 'basename', 'realpath', 'readlink',
    'uname',
    // Read-only git (`git branch` is listing-only in allowlist-match; repository
    // config that runs programs makes exempt git commands ask, see the gateway)
    'git status', 'git diff', 'git log', 'git show',
    'git branch', 'git rev-parse', 'git describe', 'git blame',
    'git ls-files', 'git ls-tree', 'git shortlog',
    // Version probes only (exact prefix; never bare `npm` / `node`)
    'node --version', 'node -v',
    'npm --version', 'npm -v',
    'python --version', 'python -V',
    'python3 --version', 'python3 -V',
    'pip --version', 'pip3 --version',
    'tsc --version', 'eslint --version', 'prettier --version',
    'ruby --version', 'php --version',
  ],
  windows: [
    'dir', 'type', 'Get-ChildItem', 'Get-Content', 'Select-String', 'Get-Location',
    'echo', 'Write-Output',
    'git status', 'git diff', 'git log', 'git show',
    'git branch', 'git rev-parse', 'git describe', 'git blame',
    'git ls-files', 'git ls-tree', 'git shortlog',
    'node --version', 'node -v',
    'npm --version', 'npm -v',
    'python --version', 'python -V',
    'python3 --version', 'python3 -V',
    'tsc --version', 'eslint --version', 'prettier --version',
  ],
};

/**
 * Built-ins seeded by an earlier version and since retired (review P0: they
 * could run workdir-controlled code or download toolchains). `#seed` deletes
 * their built-in rows so an upgraded install does not keep exempting them.
 */
export const RETIRED_BUILTIN_PATTERNS: Record<AllowlistPlatform, string[]> = {
  posix: [
    'pnpm --version', 'pnpm -v', 'yarn --version', 'yarn -v',
    'cargo --version', 'rustc --version', 'go version',
  ],
  windows: ['pnpm --version', 'pnpm -v', 'yarn --version', 'yarn -v', 'go version'],
};

export function platformOf(osPlatform: string): AllowlistPlatform {
  return osPlatform === 'win32' ? 'windows' : 'posix';
}

/**
 * Persistent read-only command allowlist. Built-ins are seeded once per
 * platform; users add custom prefixes at their own risk (设置页提示).
 */
export class AllowlistService {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;
  readonly #platform: AllowlistPlatform;

  constructor(deps: { db: SqliteDatabase; clock: Clock; osPlatform: string }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#platform = platformOf(deps.osPlatform);
    this.#seed();
  }

  get platform(): AllowlistPlatform {
    return this.#platform;
  }

  #seed(): void {
    // Retired built-ins go away (their rows were seeded enabled; a user-added
    // custom row with the same text stays — that one is the user's decision).
    const retire = this.#db.prepare(
      'delete from command_allowlist where platform = ? and pattern = ? and builtin = 1',
    );
    for (const pattern of RETIRED_BUILTIN_PATTERNS[this.#platform]) {
      retire.run(this.#platform, pattern);
    }
    // Insert any missing built-ins (first install and later list expansions).
    // Never re-enable a built-in the user turned off: match on platform+pattern.
    // A new built-in on an existing install starts enabled (DEVIATIONS: the
    // list holds only read-only, workdir-code-free entries, pinned by test).
    const insert = this.#db.prepare(
      'insert into command_allowlist (id, platform, pattern, builtin, enabled, created_at) values (?, ?, ?, 1, 1, ?)',
    );
    const exists = this.#db.prepare(
      'select 1 as ok from command_allowlist where platform = ? and pattern = ? limit 1',
    );
    for (const pattern of BUILTIN_PATTERNS[this.#platform]) {
      if (exists.get(this.#platform, pattern) !== undefined) continue;
      insert.run(newId('alw'), this.#platform, pattern, this.#clock.now());
    }
  }

  list(): AllowlistEntry[] {
    const rows = this.#db
      .prepare('select * from command_allowlist order by builtin desc, pattern')
      .all() as AllowlistRow[];
    return rows.map(rowToEntry);
  }

  listEnabled(platform: AllowlistPlatform = this.#platform): string[] {
    const rows = this.#db
      .prepare('select * from command_allowlist where platform = ? and enabled = 1')
      .all(platform) as AllowlistRow[];
    return rows.map((r) => r.pattern);
  }

  /**
   * Adds a user entry. Refused (INVALID_INPUT, the reason in the message) when
   * the prefix would exempt arbitrary code, network or destructive commands —
   * the shared `allowlistPatternRefusal` the approval card also uses.
   */
  add(pattern: string): AllowlistEntry[] {
    const trimmed = pattern.trim();
    const refusal = allowlistPatternRefusal(trimmed);
    if (refusal !== null) throw new AppError('INVALID_INPUT', refusal);
    this.#db
      .prepare(
        'insert into command_allowlist (id, platform, pattern, builtin, enabled, created_at) values (?, ?, ?, 0, 1, ?)',
      )
      .run(newId('alw'), this.#platform, trimmed, this.#clock.now());
    return this.list();
  }

  update(id: string, enabled: boolean): AllowlistEntry[] {
    this.#db
      .prepare('update command_allowlist set enabled = ? where id = ?')
      .run(enabled ? 1 : 0, id);
    return this.list();
  }

  /** Restores the defaults: custom rows gone, built-ins re-enabled. */
  reset(): AllowlistEntry[] {
    this.#db
      .prepare('delete from command_allowlist where platform = ? and builtin = 0')
      .run(this.#platform);
    this.#db
      .prepare('update command_allowlist set enabled = 1 where platform = ?')
      .run(this.#platform);
    return this.list();
  }

  /**
   * The single entry point the gateway uses; never throws. Built-in entries
   * are tried first; `custom` is true when any segment needed a user-added
   * entry — those are not proven read-only, so callers keep the D75 read-only
   * and D73 taint guards for them (review P1).
   */
  match(
    command: string,
    ctx: Omit<AllowlistCheckContext, 'platform' | 'entries'>,
  ): AllowlistVerdict & { custom: boolean } {
    const rows = this.#db
      .prepare('select pattern, builtin from command_allowlist where platform = ? and enabled = 1')
      .all(this.#platform) as Array<{ pattern: string; builtin: number }>;
    const norm = (p: string) => p.trim().split(/\s+/).join(' ');
    const builtins = new Set(rows.filter((r) => r.builtin === 1).map((r) => norm(r.pattern)));
    const ordered = [
      ...rows.filter((r) => r.builtin === 1),
      ...rows.filter((r) => r.builtin !== 1),
    ].map((r) => r.pattern);
    const verdict = matchAllowlistCommand(command, {
      platform: this.#platform,
      entries: ordered,
      ...ctx,
    });
    const custom =
      verdict.exempt && (verdict.matched ?? []).some((pattern) => !builtins.has(pattern));
    return { ...verdict, custom };
  }
}
