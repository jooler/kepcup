import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { MessagesService } from '../../src/domain/messages.js';
import { FileReadState } from '../../src/tools/fs-state.js';
import { previewMaxBytesOf, previewMimeOf } from '../../src/rpc/file-preview.js';
import type { Clock } from '../../src/infra/clock.js';
import { insertProjectConversation } from '../support/projects.js';

const dir = mkdtempSync(path.join(tmpdir(), 'file-artifacts-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRig(): {
  db: SqliteDatabase;
  messages: MessagesService;
  conversationId: string;
} {
  const home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  const clock: Clock = { now: () => 1_000_000 };
  const conversationId = 'conv_files';
  db.prepare(
    "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_lead', 'lead', '{}', 'active', 0, 0)",
  ).run();
  insertProjectConversation(db, { id: conversationId, leadBotId: 'bot_lead' });
  return { db, messages: new MessagesService(db, clock), conversationId };
}

describe('run file artifacts', () => {
  it('dedupes writes per run and keeps the first change kind', () => {
    const state = new FileReadState();
    state.recordChange('run_1', { path: '/tmp/a.md', change: 'created', size: 3 });
    state.recordChange('run_1', { path: '/tmp/a.md', change: 'modified', size: 7 });
    state.recordChange('run_1', { path: '/tmp/b.png', change: 'modified', size: 9 });
    expect(state.changesOf('run_1')).toEqual([
      { path: '/tmp/a.md', change: 'created', size: 7 },
      { path: '/tmp/b.png', change: 'modified', size: 9 },
    ]);
    state.release('run_1');
    expect(state.changesOf('run_1')).toEqual([]);
  });

  it('persists artifacts on the message and exposes the preview path scope', () => {
    const rig = makeRig();
    try {
      const message = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'bot',
        senderBotId: 'bot_lead',
        kind: 'text',
        text: '改好了',
        artifacts: [{ path: '/tmp/report.md', name: 'report.md', change: 'created', size: 12 }],
      });
      expect(message.content).toMatchObject({
        text: '改好了',
        artifacts: [{ path: '/tmp/report.md', name: 'report.md', change: 'created' }],
      });
      expect(rig.messages.hasArtifactPath(rig.conversationId, '/tmp/report.md')).toBe(true);
      expect(rig.messages.hasArtifactPath(rig.conversationId, '/tmp/other.md')).toBe(false);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('classifies preview paths and mime types', () => {
    expect(previewMimeOf('/x/report.MD')).toBe('text/markdown');
    expect(previewMimeOf('/x/slides.pptx')).toContain('presentationml');
    expect(previewMimeOf('/x/unknown.bin')).toBe('application/octet-stream');
    expect(previewMaxBytesOf('/x/clip.mp4')).toBeGreaterThan(previewMaxBytesOf('/x/a.md'));
    expect(previewMaxBytesOf('/x/sheet.xlsx')).toBeLessThanOrEqual(12 * 1024 * 1024);
  });
});
