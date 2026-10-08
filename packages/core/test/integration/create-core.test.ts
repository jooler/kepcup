import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, createMemoryKeystore, type CoreHarness } from '../../src/index.js';
import { resolvePaths } from '../../src/infra/paths.js';

const harnesses: CoreHarness[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const core of harnesses.splice(0)) await core.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function newTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'core-it-'));
  homes.push(home);
  return home;
}

async function start(home?: string, keystore?: ReturnType<typeof createMemoryKeystore>) {
  const core = await createCore({
    home: home ?? (await newTempHome()),
    keystore,
    env: { NODE_ENV: 'test', KEPCUP_KEYSTORE: 'memory' },
  });
  harnesses.push(core);
  return core;
}

describe('createCore (integration)', () => {
  it('answers system.ping over the in-process RPC channel', async () => {
    const core = await start();
    const pong = await core.ping();
    expect(pong.pong).toBe(true);
    expect(typeof pong.ts).toBe('number');
  });

  it('emits core.status ready after startup', async () => {
    const core = await start();
    expect(core.services.status).toBe('ready');
    const events: Array<{ status: string }> = [];
    const off = core.onCoreStatus((payload) => events.push({ status: payload.status }));
    core.services.events.emit('core.status', { status: 'ready' });
    expect(events.at(-1)?.status).toBe('ready');
    off();
  });

  it('returns runtime info including node version and data dir', async () => {
    const home = await newTempHome();
    const core = await start(home);
    const info = await core.info();
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(/^\d+\.\d+\.\d+/.test(info.nodeVersion)).toBe(true);
    expect(info.dataDir).toBe(resolvePaths(home).home); // canonical (realpath) home
    expect(info.coreStatus).toBe('ready');
  });

  it('creates the data directory layout on first run', async () => {
    const home = await newTempHome();
    await start(home);
    expect(existsSync(path.join(home, 'main.db'))).toBe(true);
    expect(existsSync(path.join(home, 'runs.db'))).toBe(true);
    expect(existsSync(path.join(home, 'logs'))).toBe(true);
  });

  it('applies the settings migration', async () => {
    const core = await start();
    const services = core.services;
    const tables = services
      .mainDb!.prepare("select name from sqlite_master where type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('settings');
    // P01 tables (docs/dev/03-data-model.md, tables marked P01).
    for (const table of [
      'secrets',
      'bots',
      'conversations',
      'conversation_members',
      'messages',
      'messages_fts',
      'attachments',
      'drafts',
      'jobs',
      'usage_ledger',
    ]) {
      expect(tables.map((t) => t.name)).toContain(table);
    }
    // 0001 init + 0002 runs + 0003 run continuation (D56) + 0004 subagent parent (D66/D67)
    // + 0005 run engine (D72) + 0006 tasks (D75) + 0007 'response' → 'turn' (D75 W2)
    // + 0008 turn trigger parts / retry origin (D75 审查 L3 / L6)。
    expect(services.runsDb!.pragma('user_version', { simple: true })).toBe(8);
    const runsTables = services
      .runsDb!.prepare("select name from sqlite_master where type='table'")
      .all() as Array<{ name: string }>;
    expect(runsTables.map((t) => t.name)).toContain('runs');
    expect(runsTables.map((t) => t.name)).toContain('run_steps');
  });

  it('second start reuses the stored master key', async () => {
    const home = await newTempHome();
    const keystore = createMemoryKeystore();
    const first = await start(home, keystore);
    await first.close();
    harnesses.splice(harnesses.indexOf(first), 1);

    const second = await start(home, keystore);
    expect(second.services.status).toBe('ready');
    const info = await second.info();
    expect(info.coreStatus).toBe('ready');
  });

  it('enters locked state when the key is gone but the database exists, leaving the db untouched', async () => {
    const home = await newTempHome();
    const keystore = createMemoryKeystore();
    const first = await start(home, keystore);
    const secret = keystore.getSecret();
    expect(secret).not.toBeNull();
    // Simulate the keychain losing the entry.
    keystore.deleteSecret();
    await first.close();
    harnesses.splice(harnesses.indexOf(first), 1);

    const dbPath = path.join(home, 'main.db');
    const before = readFileSync(dbPath);

    const second = await start(home, keystore);
    expect(second.services.status).toBe('locked');
    expect(second.services.statusReason).toBeTruthy();
    expect(second.services.mainDb).toBeNull();

    const after = readFileSync(dbPath);
    expect(after.equals(before)).toBe(true);

    // RPC stays reachable and reports the locked state.
    const info = await second.info();
    expect(info.coreStatus).toBe('locked');
  });

  it('maps invalid input to INVALID_INPUT errors', async () => {
    const core = await start();
    await expect(core.rpc.call('system.ping', { unexpected: true })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('never writes the master key to log files', async () => {
    const home = await newTempHome();
    const keystore = createMemoryKeystore();
    const core = await start(home, keystore);
    const secret = keystore.getSecret()!;
    await core.close();
    harnesses.splice(harnesses.indexOf(core), 1);

    const logsDir = path.join(home, 'logs');
    const files = readdirSync(logsDir);
    const text = files.map((f) => readFileSync(path.join(logsDir, f), 'utf8')).join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(secret);
  });
});
