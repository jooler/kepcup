import Database from 'better-sqlite3-multiple-ciphers';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/infra/migrate.js';
import { SettingsService } from '../../src/domain/settings.js';
import { UserProfileAvatarService } from '../../src/domain/user-profile.js';
import type { AppPaths } from '../../src/infra/paths.js';
import type { SqliteDatabase } from '../../src/infra/db.js';

const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));

const openDbs: SqliteDatabase[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeService(): { service: UserProfileAvatarService; settings: SettingsService; home: string } {
  const db = new Database(':memory:') as SqliteDatabase;
  runMigrations(db, mainMigrations);
  openDbs.push(db);
  const settings = new SettingsService(db, { now: () => 0 });
  const home = mkdtempSync(path.join(tmpdir(), 'kepcup-user-avatar-'));
  tempDirs.push(home);
  const paths = { home } as AppPaths;
  return {
    service: new UserProfileAvatarService({ paths, clock: { now: () => 1_000 }, settings }),
    settings,
    home,
  };
}

describe('UserProfileAvatarService', () => {
  it('upload writes the file, points settings.userProfileAvatar at it and prunes older uploads', () => {
    const { service, settings, home } = makeService();
    const first = service.upload('image/png', Buffer.from('one'));
    expect(first).toMatch(/^upload:avatar-\d+\.png$/);
    expect(settings.get().userProfileAvatar).toBe(first);
    service.upload('image/png', Buffer.from('two'));
    const files = readdirSync(path.join(home, 'user', 'avatar'));
    expect(files).toHaveLength(1);
  });

  it('read returns the current avatar bytes and rejects foreign / stale file names', () => {
    const { service } = makeService();
    const ref = service.upload('image/png', Buffer.from('hello'));
    const file = ref.slice('upload:'.length);
    expect(service.read(file)).toEqual({ mime: 'image/png', base64: Buffer.from('hello').toString('base64') });
    expect(() => service.read('../escape')).toThrow();
    expect(() => service.read('avatar-999.png')).toThrow();
    service.upload('image/webp', Buffer.from('next'));
    expect(() => service.read(file)).toThrow();
  });

  it('rejects unsupported mime, empty and oversized payloads', () => {
    const { service } = makeService();
    expect(() => service.upload('image/gif', Buffer.from('x'))).toThrow();
    expect(() => service.upload('image/png', Buffer.alloc(0))).toThrow();
    expect(() => service.upload('image/png', Buffer.alloc(3_000_001))).toThrow();
  });
});
