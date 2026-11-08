import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TestClock } from '@kepcup/testkit';
import type {
  CollabDraftChangedPayload,
  CollabDraftClearedPayload,
  CollabDraftOwnerChangedPayload,
  Message,
} from '@kepcup/shared';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { DraftService, type DraftSendInput } from '../../src/collab/drafts.js';

/** D120 共享草稿：租约 / 版本 / 发送原子性 / 合流 / 过期。 */

const dir = mkdtempSync(path.join(tmpdir(), 'collab-drafts-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-09T10:00:00.000Z');

function openDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `drafts-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 21), KEY_INFO.mainDb),
  });
  db.exec(`
    create table conversations (id text primary key);
    create table composer_drafts (
      conversation_id  text primary key references conversations(id) on delete cascade,
      doc_json         text not null,
      mentions_json    text not null default '[]',
      reply_to         text,
      attachments_json text not null default '[]',
      version          integer not null default 0,
      updated_at       integer not null
    );
    insert into conversations (id) values ('conv-1');
  `);
  return db;
}

function doc(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function setup() {
  const db = openDb();
  const clock = new TestClock(NOW);
  const changed: CollabDraftChangedPayload[] = [];
  const ownerChanged: CollabDraftOwnerChangedPayload[] = [];
  const cleared: CollabDraftClearedPayload[] = [];
  const sent: Array<{ conversationId: string; input: DraftSendInput }> = [];
  let sendError: Error | null = null;
  let sendErrorAfterPersist: Error | null = null;
  const service = new DraftService({
    db,
    clock,
    publish: (name, payload) => {
      if (name === 'collab.draftChanged') changed.push(payload as CollabDraftChangedPayload);
      if (name === 'collab.draftOwnerChanged') {
        ownerChanged.push(payload as CollabDraftOwnerChangedPayload);
      }
      if (name === 'collab.draftCleared') cleared.push(payload as CollabDraftClearedPayload);
    },
    sendMessage: (conversationId, input, onPersisted) => {
      if (sendError !== null) throw sendError;
      sent.push({ conversationId, input });
      onPersisted();
      if (sendErrorAfterPersist !== null) throw sendErrorAfterPersist;
      return {
        message: { id: 'msg-1' } as unknown as Message,
        runId: 'run-1',
      };
    },
  });
  return {
    db,
    clock,
    changed,
    ownerChanged,
    cleared,
    sent,
    service,
    setSendError: (error: Error | null) => (sendError = error),
    setSendErrorAfterPersist: (error: Error | null) => (sendErrorAfterPersist = error),
  };
}

const draftInput = {
  conversationId: 'conv-1',
  clientId: 'client-a',
  clientName: '小明的 MacBook',
};

describe('DraftService', () => {
  it('starts empty and stores versioned snapshots', () => {
    const { service, changed } = setup();
    expect(service.get('conv-1').draft).toMatchObject({ version: 0, updatedAt: 0 });

    service.claim(draftInput);
    const result = service.update({
      ...draftInput,
      baseVersion: 0,
      doc: doc('hello'),
      mentions: ['bot:1'],
      attachments: [{ attachmentId: 'att-1', fileName: 'a.png', mime: 'image/png', size: 12 }],
    });
    expect(result.version).toBe(1);
    service.flushNow();

    const stored = service.get('conv-1').draft;
    expect(stored).toMatchObject({ version: 1, mentions: ['bot:1'] });
    expect(stored.attachments.map((attachment) => attachment.attachmentId)).toEqual(['att-1']);
    expect(changed.at(-1)).toMatchObject({ conversationId: 'conv-1' });
    expect(changed.at(-1)?.draft.version).toBe(1);
  });

  it('enforces the single-writer lease and supports explicit takeover', () => {
    const { service } = setup();
    service.claim(draftInput);

    expect(() =>
      service.claim({ conversationId: 'conv-1', clientId: 'client-b', clientName: 'B' }),
    ).toThrowError(/另一位用户正在编辑/);

    const takeover = service.claim({
      conversationId: 'conv-1',
      clientId: 'client-b',
      clientName: 'B',
      force: true,
    });
    expect(takeover.lease.ownerClientId).toBe('client-b');

    expect(() => service.update({ ...draftInput, baseVersion: 0, doc: doc('a') })).toThrowError(
      /没有这个会话草稿的编辑权/,
    );
  });

  it('rejects stale base versions instead of overwriting', () => {
    const { service } = setup();
    service.claim(draftInput);
    service.update({ ...draftInput, baseVersion: 0, doc: doc('one') });

    expect(() => service.update({ ...draftInput, baseVersion: 0, doc: doc('two') })).toThrowError(
      /草稿已被更新/,
    );
    expect(service.update({ ...draftInput, baseVersion: 1, doc: doc('two') }).version).toBe(2);
  });

  it('clears a reply with replyTo: null while keeping omitted fields unchanged', () => {
    const { service } = setup();
    service.claim(draftInput);
    service.update({ ...draftInput, baseVersion: 0, doc: doc('one'), replyTo: 'msg-1' });
    expect(service.get('conv-1').draft.replyTo).toBe('msg-1');

    service.update({ ...draftInput, baseVersion: 1, doc: doc('two'), replyTo: null });
    expect(service.get('conv-1').draft.replyTo).toBeNull();
  });

  it('expires leases and reports the owner as gone', () => {
    const { service, clock, ownerChanged } = setup();
    service.claim(draftInput);
    ownerChanged.length = 0;

    clock.advance(20_001);
    service.claim({ conversationId: 'conv-1', clientId: 'client-b', clientName: 'B' });
    expect(ownerChanged.some((event) => event.owner === null)).toBe(true);
  });

  it('release makes the draft claimable again', () => {
    const { service } = setup();
    service.claim(draftInput);
    service.release({ conversationId: 'conv-1', clientId: 'client-a' });
    expect(service.get('conv-1').lease).toBeNull();

    const next = service.claim({ conversationId: 'conv-1', clientId: 'client-b', clientName: 'B' });
    expect(next.lease.ownerClientId).toBe('client-b');
  });

  it('send is atomic: message, draft row and lease all clear together', () => {
    const { service, sent, cleared, ownerChanged } = setup();
    service.claim(draftInput);
    service.update({ ...draftInput, baseVersion: 0, doc: doc('send me') });

    const result = service.send({
      ...draftInput,
      baseVersion: 1,
      text: 'send me',
    });
    expect(result.runId).toBe('run-1');
    expect(sent[0]).toMatchObject({ conversationId: 'conv-1', input: { text: 'send me' } });
    expect(service.get('conv-1')).toMatchObject({
      draft: { version: 0 },
      lease: null,
    });
    expect(cleared.at(-1)).toMatchObject({ conversationId: 'conv-1', byClientId: 'client-a' });
    expect(ownerChanged.at(-1)).toMatchObject({ owner: null });
  });

  it('a failed send leaves the draft and lease intact', () => {
    const { service, setSendError } = setup();
    service.claim(draftInput);
    service.update({ ...draftInput, baseVersion: 0, doc: doc('keep me') });
    setSendError(new Error('conversation read only'));

    expect(() => service.send({ ...draftInput, baseVersion: 1, text: 'keep me' })).toThrowError(
      /read only/,
    );
    expect(service.get('conv-1').draft.version).toBe(1);
    expect(service.get('conv-1').lease?.ownerClientId).toBe('client-a');
  });

  it('deletes the draft inside the message transaction even if routing then throws', () => {
    const { service, setSendErrorAfterPersist } = setup();
    service.claim(draftInput);
    service.update({ ...draftInput, baseVersion: 0, doc: doc('send once') });
    setSendErrorAfterPersist(new Error('routing failed'));

    expect(() => service.send({ ...draftInput, baseVersion: 1, text: 'send once' })).toThrowError(
      /routing failed/,
    );
    // 草稿已随消息事务删除：客户端不会因为重试再发一遍。
    expect(service.get('conv-1').draft.version).toBe(0);
  });

  it('scopes the lease to the connection so two tabs of one client cannot both own it', () => {
    const { service } = setup();
    service.claim({ ...draftInput, connectionId: 'tab-1' });
    service.claim({ ...draftInput, connectionId: 'tab-2' });

    expect(() =>
      service.update({
        ...draftInput,
        connectionId: 'tab-1',
        baseVersion: 0,
        doc: doc('stale tab'),
      }),
    ).toThrowError(/没有这个会话草稿的编辑权/);
    expect(
      service.update({
        ...draftInput,
        connectionId: 'tab-2',
        baseVersion: 0,
        doc: doc('active tab'),
      }).version,
    ).toBe(1);
  });

  it('releases only the disconnecting connection lease', () => {
    const { service } = setup();
    service.claim({ ...draftInput, connectionId: 'tab-1' });
    service.releaseClientConnection('client-a', 'tab-2');
    expect(service.get('conv-1').lease?.ownerClientId).toBe('client-a');
    service.releaseClientConnection('client-a', 'tab-1');
    expect(service.get('conv-1').lease).toBeNull();
  });

  it('rejects deeply nested documents and oversized mention tokens', () => {
    const { service } = setup();
    service.claim(draftInput);
    let deep: Record<string, unknown> = { type: 'text', text: 'x' };
    for (let index = 0; index < 150; index += 1) {
      deep = { type: 'paragraph', content: [deep] };
    }
    expect(() =>
      service.update({
        ...draftInput,
        baseVersion: 0,
        doc: { type: 'doc', content: [deep] },
      }),
    ).toThrowError(/嵌套过深/);

    expect(() =>
      service.update({
        ...draftInput,
        baseVersion: 0,
        doc: doc('mention'),
        mentions: ['x'.repeat(5000)],
      }),
    ).toThrowError(/提及内容过长/);
  });

  it('coalesces draftChanged per conversation and keeps the latest snapshot', () => {
    const { service, changed } = setup();
    service.claim(draftInput);
    service.update({ ...draftInput, baseVersion: 0, doc: doc('a') });
    service.update({ ...draftInput, baseVersion: 1, doc: doc('ab') });
    service.flushNow();

    expect(changed).toHaveLength(1);
    expect(changed[0]?.draft.version).toBe(2);
  });

  it('rejects drafts above the size cap', () => {
    const { service } = setup();
    service.claim(draftInput);
    const huge = doc('x'.repeat(600 * 1024));
    expect(() => service.update({ ...draftInput, baseVersion: 0, doc: huge })).toThrowError(
      /草稿过大/,
    );
  });
});
