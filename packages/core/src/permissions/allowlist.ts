import { newId, type AllowlistEntry, type AllowlistPlatform } from '@kepcup/shared';
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

/** docs/design/13-permissions.md "只读命令白名单" built-ins. */
export const BUILTIN_PATTERNS: Record<AllowlistPlatform, string[]> = {
  posix: [
    'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'tree',
    'which', 'grep', 'rg', 'find',
    'git status', 'git diff', 'git log', 'git show',
  ],
  windows: [
    'dir', 'type', 'Get-ChildItem', 'Get-Content', 'Select-String', 'Get-Location',
    'git status', 'git diff', 'git log', 'git show',
  ],
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
    const existing = this.#db
      .prepare("select count(*) as n from command_allowlist where platform = ? and builtin = 1")
      .get(this.#platform) as { n: number };
    if (existing.n > 0) return;
    const insert = this.#db.prepare(
      'insert into command_allowlist (id, platform, pattern, builtin, enabled, created_at) values (?, ?, ?, 1, 1, ?)',
    );
    for (const pattern of BUILTIN_PATTERNS[this.#platform]) {
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

  add(pattern: string): AllowlistEntry[] {
    const trimmed = pattern.trim();
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

  /** The single entry point the gateway uses; never throws. */
  match(command: string, ctx: Omit<AllowlistCheckContext, 'platform' | 'entries'>): AllowlistVerdict {
    return matchAllowlistCommand(command, {
      platform: this.#platform,
      entries: this.listEnabled(),
      ...ctx,
    });
  }
}
