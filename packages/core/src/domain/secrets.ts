import { AppError, newId } from '@kepcup/shared';
import { deriveKey, KEY_INFO, open as openSealed, seal } from '../infra/crypto.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';

const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const SECRET_PREFIX_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;

/**
 * Cap on values kept only for `redact` after they were overwritten or removed
 * (OAuth token rotation would otherwise grow the set for the whole process
 * lifetime). Oldest entries are evicted first.
 */
export const REDACT_ONLY_MAX = 512;

/**
 * Field-level encrypted secrets (API keys). Values are only ever handed out
 * through `getValue` (used by the model auth callback); no RPC surface
 * returns them (docs/design/11-storage.md).
 */
export class SecretsService {
  readonly #db: SqliteDatabase;
  readonly #masterKey: Uint8Array;
  readonly #clock: Clock;
  readonly #logger: CoreLogger;
  /** Decrypted cache so `redact` can strip known values from any output. */
  readonly #knownValues = new Map<string, string>();
  /**
   * Values that no longer belong to any stored secret (overwritten by `setValue`,
   * deleted by `removeValue` / `removeByPrefix`) but must keep being masked until
   * the process ends: logs and run records may still hold them. Keyed by the
   * value; Map insertion order doubles as the LRU order (re-adding refreshes).
   */
  readonly #redactOnly = new Map<string, true>();

  constructor(deps: {
    db: SqliteDatabase;
    masterKey: Uint8Array;
    clock: Clock;
    logger: CoreLogger;
  }) {
    this.#db = deps.db;
    this.#masterKey = deps.masterKey;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
  }

  /** Key derived per secret row id; the id is the AES-GCM additional data. */
  #key(id: string): Buffer {
    return deriveKey(this.#masterKey, `${KEY_INFO.secrets}:${id}`);
  }

  /** Moves a no-longer-stored value into the redact-only set (LRU, capped). */
  #retireValue(value: string | undefined): void {
    if (value === undefined || value.length === 0) return;
    this.#redactOnly.delete(value);
    this.#redactOnly.set(value, true);
    while (this.#redactOnly.size > REDACT_ONLY_MAX) {
      const oldest = this.#redactOnly.keys().next();
      if (oldest.done === true) break;
      this.#redactOnly.delete(oldest.value);
    }
  }

  /** Current plaintext of a stored secret for retiring it; never throws. */
  #currentValue(name: string): string | undefined {
    const cached = this.#knownValues.get(name);
    if (cached !== undefined) return cached;
    try {
      return this.getValue(name) ?? undefined;
    } catch {
      return undefined;
    }
  }

  setValue(name: string, value: string): void {
    if (!SECRET_NAME_PATTERN.test(name)) {
      throw new AppError('INVALID_INPUT', `Invalid secret name "${name}"`);
    }
    const existing = this.#db.prepare('select id from secrets where name = ?').get(name) as
      | { id: string }
      | undefined;
    // The overwritten value stays masked (the cache may not hold it after a restart).
    const previous = existing ? this.#currentValue(name) : undefined;
    const now = this.#clock.now();
    const id = existing?.id ?? newId('sec');
    const sealed = seal(this.#key(id), value, id);
    const iv = sealed.subarray(0, 12);
    const tag = sealed.subarray(12, 28);
    const ciphertext = sealed.subarray(28);
    if (existing) {
      this.#db
        .prepare('update secrets set ciphertext = ?, iv = ?, tag = ?, updated_at = ? where id = ?')
        .run(ciphertext, iv, tag, now, id);
    } else {
      this.#db
        .prepare(
          'insert into secrets (id, name, ciphertext, iv, tag, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, name, ciphertext, iv, tag, now, now);
    }
    if (previous !== undefined && previous !== value) this.#retireValue(previous);
    this.#knownValues.set(name, value);
    this.#logger.info({ secret: name }, 'secret stored');
  }

  /** Returns null when no value is stored for the name. */
  getValue(name: string): string | null {
    const row = this.#db
      .prepare('select id, ciphertext, iv, tag from secrets where name = ?')
      .get(name) as
      | { id: string; ciphertext: Buffer; iv: Buffer; tag: Buffer }
      | undefined;
    if (!row) return null;
    const sealed = Buffer.concat([row.iv, row.tag, row.ciphertext]);
    let value: string;
    try {
      value = openSealed(this.#key(row.id), sealed, row.id).toString('utf8');
    } catch (error) {
      throw new AppError('INTERNAL', `Cannot decrypt secret "${name}"`, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    this.#knownValues.set(name, value);
    return value;
  }

  hasValue(name: string): boolean {
    return (
      (this.#db.prepare('select 1 from secrets where name = ?').get(name) as unknown) !== undefined
    );
  }

  removeValue(name: string): void {
    const previous = this.#currentValue(name);
    this.#db.prepare('delete from secrets where name = ?').run(name);
    this.#knownValues.delete(name);
    this.#retireValue(previous);
    this.#logger.info({ secret: name }, 'secret removed');
  }

  /**
   * Removes every secret whose name starts with `prefix` (e.g. `conn:{id}:`,
   * `mcp:{id}:`) and returns the removed names. The removed values stay masked
   * by `redact` until the process ends.
   */
  removeByPrefix(prefix: string): string[] {
    if (!SECRET_PREFIX_PATTERN.test(prefix)) {
      throw new AppError('INVALID_INPUT', `Invalid secret name prefix "${prefix}"`);
    }
    // substr comparison, not LIKE: `_` in names is a LIKE wildcard.
    const names = (
      this.#db
        .prepare('select name from secrets where substr(name, 1, ?) = ? order by name')
        .all(prefix.length, prefix) as Array<{ name: string }>
    ).map((row) => row.name);
    for (const name of names) {
      const previous = this.#currentValue(name);
      this.#db.prepare('delete from secrets where name = ?').run(name);
      this.#knownValues.delete(name);
      this.#retireValue(previous);
    }
    if (names.length > 0) {
      this.#logger.info({ prefix, count: names.length }, 'secrets removed by prefix');
    }
    return names;
  }

  /** Names of all stored secrets (no values). */
  names(): string[] {
    const rows = this.#db.prepare('select name from secrets order by name').all() as Array<{
      name: string;
    }>;
    return rows.map((r) => r.name);
  }

  /**
   * Replaces every known secret value in `text` with `[REDACTED]`; used for
   * run-step payloads and any other persisted/logged free text.
   */
  redact(text: string): string {
    let result = text;
    for (const value of this.#knownValues.values()) {
      if (value.length === 0) continue;
      result = result.split(value).join('[REDACTED]');
    }
    for (const value of this.#redactOnly.keys()) {
      result = result.split(value).join('[REDACTED]');
    }
    return result;
  }
}
