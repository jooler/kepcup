import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { Entry } from '@napi-rs/keyring';
import { AppError } from '@kepcup/shared';
// Registers the dev-time global default for __KEPCUP_TEST_HOOKS__ (tsc
// output); in the packaged artifact the guarded branches below are removed
// with their imports (P13 产物剔除).
import './test-hooks.js';

export const KEYSTORE_SERVICE = 'kepcup';
export const KEYSTORE_ACCOUNT = 'master-key';

export interface Keystore {
  readonly kind: 'system' | 'memory' | 'file';
  /** Returns null when no secret is stored. */
  getSecret(): string | null;
  setSecret(secret: string): void;
  deleteSecret(): void;
}

/**
 * System keychain. On Linux the Secret Service store is pinned explicitly:
 * the kernel keyring would lose the key on reboot and lock out the databases
 * (design/11-storage.md). When Secret Service is unavailable the library
 * throws instead of falling back, which we surface as KEYSTORE_UNAVAILABLE.
 */
export function createSystemKeystore(): Keystore {
  const options =
    process.platform === 'linux' ? { linux: { store: 'secret-service' as const } } : undefined;
  const entry = new Entry(KEYSTORE_SERVICE, KEYSTORE_ACCOUNT, options);

  return {
    kind: 'system',
    getSecret() {
      try {
        return entry.getPassword();
      } catch (error) {
        throw keystoreUnavailable(error);
      }
    },
    setSecret(secret) {
      try {
        entry.setPassword(secret);
      } catch (error) {
        throw keystoreUnavailable(error);
      }
    },
    deleteSecret() {
      try {
        entry.deletePassword();
      } catch (error) {
        throw keystoreUnavailable(error);
      }
    },
  };
}

/** Process-memory implementation. Only for tests, see `selectKeystore`. */
export function createMemoryKeystore(): Keystore {
  let secret: string | null = null;
  return {
    kind: 'memory',
    getSecret() {
      return secret;
    },
    setSecret(next) {
      secret = next;
    },
    deleteSecret() {
      secret = null;
    },
  };
}

/**
 * Plaintext-file implementation for tests that restart the core process (the
 * in-memory store cannot survive a restart, so the restarted core would find
 * an existing database without a key and lock). The secret stays on disk
 * unencrypted, so this refuses to run outside NODE_ENV=test.
 */
export function createFileKeystore(filePath: string): Keystore {
  return {
    kind: 'file',
    getSecret() {
      return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
    },
    setSecret(secret) {
      writeFileSync(filePath, secret, { encoding: 'utf8', mode: 0o600 });
    },
    deleteSecret() {
      if (existsSync(filePath)) unlinkSync(filePath);
    },
  };
}

export function selectKeystore(env: NodeJS.ProcessEnv, home?: string): Keystore {
  const requested = env.KEPCUP_KEYSTORE;
  const isTest = env.NODE_ENV === 'test';

  // Test-only keystores (P13 产物剔除): the packaged artifact eliminates this
  // whole branch — KEPCUP_KEYSTORE=memory/file then hits the
  // unknown-value error below instead of silently degrading security.
  if (__KEPCUP_TEST_HOOKS__) {
    if (requested === 'memory') {
      if (!isTest) {
        throw new AppError(
          'KEYSTORE_UNAVAILABLE',
          'KEPCUP_KEYSTORE=memory is only allowed when NODE_ENV=test',
        );
      }
      return createMemoryKeystore();
    }

    if (requested === 'file') {
      if (!isTest) {
        throw new AppError(
          'KEYSTORE_UNAVAILABLE',
          'KEPCUP_KEYSTORE=file is only allowed when NODE_ENV=test',
        );
      }
      const configured = env.KEPCUP_FILE_KEYSTORE_PATH;
      const file =
        configured !== undefined && configured !== ''
          ? configured
          : path.join(home ?? process.cwd(), '.test-master-key');
      return createFileKeystore(file);
    }
  }

  if (requested) {
    throw new AppError('KEYSTORE_UNAVAILABLE', `Unknown KEPCUP_KEYSTORE value "${requested}"`);
  }

  return createSystemKeystore();
}

function keystoreUnavailable(error: unknown): AppError {
  const reason = error instanceof Error ? error.message : String(error);
  return new AppError('KEYSTORE_UNAVAILABLE', 'System keychain is not available', { reason });
}
