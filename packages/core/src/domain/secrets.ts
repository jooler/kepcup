import { AppError, newId } from '@kepcup/shared';
import { deriveKey, KEY_INFO, open as openSealed, seal } from '../infra/crypto.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';

const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;

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

  setValue(name: string, value: string): void {
    if (!SECRET_NAME_PATTERN.test(name)) {
      throw new AppError('INVALID_INPUT', `Invalid secret name "${name}"`);
    }
    const existing = this.#db.prepare('select id from secrets where name = ?').get(name) as
      | { id: string }
      | undefined;
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
    this.#db.prepare('delete from secrets where name = ?').run(name);
    this.#knownValues.delete(name);
    this.#logger.info({ secret: name }, 'secret removed');
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
    return result;
  }
}
