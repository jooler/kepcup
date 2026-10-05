import Database from 'better-sqlite3-multiple-ciphers';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCore,
  createMemoryKeystore,
  deriveKey,
  KEY_INFO,
  type CoreHarness,
} from '../../src/index.js';
import { openDatabase } from '../../src/infra/db.js';

const harnesses: CoreHarness[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const core of harnesses.splice(0)) await core.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function start(home: string): Promise<CoreHarness> {
  const core = await createCore({
    home,
    keystore: createMemoryKeystore(),
    env: { NODE_ENV: 'test', KEPCUP_KEYSTORE: 'memory' },
  });
  harnesses.push(core);
  return core;
}

describe('database encryption (security)', () => {
  it('cannot open main.db without the key', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sec-enc-'));
    homes.push(home);
    const core = await start(home);
    await core.close();
    harnesses.splice(harnesses.indexOf(core), 1);

    const raw = new Database(path.join(home, 'main.db'));
    expect(() => raw.prepare('select count(*) from sqlite_master').get()).toThrow();
    raw.close();
  });

  it('cannot open main.db with a wrong key', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sec-wrongkey-'));
    homes.push(home);
    const core = await start(home);
    await core.close();
    harnesses.splice(harnesses.indexOf(core), 1);

    const wrongKey = deriveKey(new Uint8Array(32).fill(7), KEY_INFO.mainDb);
    expect(() => openDatabase({ path: path.join(home, 'main.db'), key: wrongKey })).toThrowError(
      /decrypt/i,
    );
  });

  it('runs.db carries no plaintext SQLite header', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sec-runs-'));
    homes.push(home);
    const core = await start(home);
    await core.close();
    harnesses.splice(harnesses.indexOf(core), 1);

    // runs.db has no tables in P00, so the file may be zero bytes; either way
    // it must not be an unencrypted SQLite database.
    const header = readFileSync(path.join(home, 'runs.db')).subarray(0, 16).toString('latin1');
    expect(header.startsWith('SQLite format 3')).toBe(false);
  });

  it('main.db carries no plaintext SQLite header', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sec-main-header-'));
    homes.push(home);
    const core = await start(home);
    await core.close();
    harnesses.splice(harnesses.indexOf(core), 1);

    const header = readFileSync(path.join(home, 'main.db')).subarray(0, 16).toString('latin1');
    expect(header.startsWith('SQLite format 3')).toBe(false);
  });
});
