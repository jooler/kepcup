import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';

import { commandTouchesDataDir, replaceHomeVariables } from '../../src/permissions/approvals.js';
import { GRANT_ABSOLUTE_TTL_MS } from '@kepcup/shared';
import { GrantsService } from '../../src/permissions/grants.js';
import { runInToolCall } from '../../src/permissions/tool-call-scope.js';
import { systemClock, type Clock } from '../../src/infra/clock.js';

const HOME = os.homedir();
const DATA_HOME = path.join(HOME, '.kepcup-test-data');

describe('replaceHomeVariables (BR-P03-001)', () => {
  it('expands POSIX, PowerShell and cmd home forms', () => {
    expect(replaceHomeVariables('$HOME/x', HOME)).toBe(`${HOME}/x`);
    expect(replaceHomeVariables('${HOME}/x', HOME)).toBe(`${HOME}/x`);
    expect(replaceHomeVariables('$HOME', HOME)).toBe(HOME);
    expect(replaceHomeVariables('$env:HOME', HOME)).toBe(HOME);
    expect(replaceHomeVariables('$env:USERPROFILE\\f', HOME)).toBe(`${HOME}\\f`);
    expect(replaceHomeVariables('%USERPROFILE%\\f', HOME)).toBe(`${HOME}\\f`);
    expect(replaceHomeVariables('%HOME%\\f', HOME)).toBe(`${HOME}\\f`);
  });
});

describe('commandTouchesDataDir (BR-P03-001 unattended floor)', () => {
  it('detects literal and tilde forms', () => {
    expect(commandTouchesDataDir(`cat ${DATA_HOME}/main.db`, DATA_HOME, HOME)).toBe(true);
    expect(commandTouchesDataDir('cat ~/.kepcup-test-data/main.db', DATA_HOME, HOME)).toBe(true);
    expect(commandTouchesDataDir('ls ~/.kepcup-test-data', DATA_HOME, HOME)).toBe(true);
  });

  it('detects home-variable forms that previously slipped through', () => {
    expect(commandTouchesDataDir('cat "$HOME/.kepcup-test-data/main.db"', DATA_HOME, HOME)).toBe(true);
    expect(commandTouchesDataDir('cat ${HOME}/.kepcup-test-data/main.db', DATA_HOME, HOME)).toBe(true);
    expect(commandTouchesDataDir('type $env:USERPROFILE\\.kepcup-test-data\\main.db', DATA_HOME, HOME)).toBe(true);
    expect(commandTouchesDataDir('type %USERPROFILE%\\.kepcup-test-data\\main.db', DATA_HOME, HOME)).toBe(true);
  });

  it('fails closed on a bare home ancestor plus relative tail', () => {
    expect(commandTouchesDataDir('cd ~ && cat .kepcup-test-data/main.db', DATA_HOME, HOME)).toBe(true);
    expect(commandTouchesDataDir('cd $HOME && cat .kepcup-test-data/main.db', DATA_HOME, HOME)).toBe(true);
    expect(commandTouchesDataDir('ls $HOME', DATA_HOME, HOME)).toBe(true);
    expect(commandTouchesDataDir('ls ~', DATA_HOME, HOME)).toBe(true);
  });

  it('leaves ordinary commands alone', () => {
    expect(commandTouchesDataDir('cat in.txt', DATA_HOME, HOME)).toBe(false);
    expect(commandTouchesDataDir('cat /etc/hosts', DATA_HOME, HOME)).toBe(false);
    expect(commandTouchesDataDir('echo "done"', DATA_HOME, HOME)).toBe(false);
    expect(commandTouchesDataDir(`ls ${path.join(HOME, 'Documents')}`, DATA_HOME, HOME)).toBe(false);
  });
});

describe('GrantsService.listEffective (BR-P03-003 once⇒runId predicate)', () => {
  it('honours once grants only for their own run, conversation grants for all runs', () => {
    const db = new Database(':memory:');
    db.exec(`
      create table conversations (id text primary key);
      create table grants (
        id text primary key, bot_id text not null, conversation_id text not null references conversations(id),
        path text not null, access text not null, duration text not null,
        run_id text, approval_id text, created_at integer not null, revoked_at integer
      );
      insert into conversations (id) values ('conv_1');
    `);
    const grants = new GrantsService({ db: db as never, clock: systemClock });
    const onceGrant = grants.create({
      botId: 'bot_1',
      conversationId: 'conv_1',
      path: '/tmp/granted',
      access: 'read',
      duration: 'once',
      runId: 'run_1',
    });
    const convGrant = grants.create({
      botId: 'bot_1',
      conversationId: 'conv_1',
      path: '/tmp/granted-conv',
      access: 'write',
      duration: 'conversation',
    });
    const otherBotGrant = grants.create({
      botId: 'bot_2',
      conversationId: 'conv_1',
      path: '/tmp/other-bot',
      access: 'read',
      duration: 'conversation',
    });

    // listActive orders by created_at desc; same-ms creations make the order
    // unstable, so assert as sets.
    expect(new Set(grants.listEffective({ runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' }).map((g) => g.id)))
      .toEqual(new Set([convGrant.id, onceGrant.id]));
    // A different run must NOT inherit the once grant.
    expect(grants.listEffective({ runId: 'run_2', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' }).map((g) => g.id))
      .toEqual([convGrant.id]);
    // Another bot gets nothing.
    expect(grants.listEffective({ runId: 'run_1', botId: 'bot_2', conversationId: 'conv_1', loopType: 'turn' }).map((g) => g.id))
      .toEqual([otherBotGrant.id]);
    // No identity → nothing.
    expect(grants.listEffective({ runId: 'run_1', botId: null, conversationId: null, loopType: 'turn' })).toEqual([]);

    // Revoked grants drop out everywhere.
    grants.revoke(onceGrant.id);
    expect(grants.listEffective({ runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' }).map((g) => g.id))
      .toEqual([convGrant.id]);
  });
});

function grantsDb() {
  const db = new Database(':memory:');
  db.exec(`
    create table grants (
      id text primary key, bot_id text not null, conversation_id text not null,
      path text not null, access text not null, duration text not null,
      run_id text, approval_id text, created_at integer not null, revoked_at integer
    );
  `);
  return db;
}

const run1 = { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'task' as const };

describe('GrantsService「仅这一次」= 单次工具调用 (D75 §7.3)', () => {
  function onceGrant(grants: GrantsService) {
    return grants.create({
      botId: 'bot_1',
      conversationId: 'conv_1',
      path: '/tmp/once',
      access: 'write',
      duration: 'once',
      runId: 'run_1',
    });
  }

  it('a once grant used inside a tool call stays valid for that call and dies with it', async () => {
    const grants = new GrantsService({ db: grantsDb() as never, clock: systemClock });
    const grant = onceGrant(grants);
    await runInToolCall(async () => {
      grants.noteOnceUse(grant);
      grants.noteOnceUse(grant); // idempotent within the call
      expect(grants.listEffective(run1).map((g) => g.id)).toEqual([grant.id]);
    });
    expect(grants.listEffective(run1)).toEqual([]);
    expect(grants.get(grant.id)?.revokedAt).not.toBeNull();
  });

  it('a use outside any tool call (or after it returned) consumes the grant on the spot', async () => {
    const grants = new GrantsService({ db: grantsDb() as never, clock: systemClock });
    const outsideUse = onceGrant(grants);
    grants.noteOnceUse(outsideUse);
    expect(grants.get(outsideUse.id)?.revokedAt).not.toBeNull();

    // Background work the tool left running still sees the ended scope.
    const late = onceGrant(grants);
    let background: (() => void) | null = null;
    await runInToolCall(async () => {
      background = () => grants.noteOnceUse(late);
    });
    background!();
    expect(grants.get(late.id)?.revokedAt).not.toBeNull();
  });

  it('conversation grants are never consumed by use', async () => {
    const grants = new GrantsService({ db: grantsDb() as never, clock: systemClock });
    const conv = grants.create({
      botId: 'bot_1',
      conversationId: 'conv_1',
      path: '/tmp/conv',
      access: 'read',
      duration: 'conversation',
    });
    await runInToolCall(async () => grants.noteOnceUse(conv));
    grants.noteOnceUse(conv);
    expect(grants.listEffective(run1).map((g) => g.id)).toEqual([conv.id]);
  });

  it('once grants expire after GRANT_ABSOLUTE_TTL_MS even when unused (injectable clock)', () => {
    let now = 1_000_000;
    const clock: Clock = { now: () => now };
    const grants = new GrantsService({ db: grantsDb() as never, clock });
    const once = onceGrant(grants);
    const conv = grants.create({
      botId: 'bot_1',
      conversationId: 'conv_1',
      path: '/tmp/conv',
      access: 'read',
      duration: 'conversation',
    });
    now += GRANT_ABSOLUTE_TTL_MS - 1;
    expect(new Set(grants.listEffective(run1).map((g) => g.id))).toEqual(new Set([once.id, conv.id]));
    expect(grants.listActivePaths()).toContain('/tmp/once');
    now += 1;
    expect(grants.listEffective(run1).map((g) => g.id)).toEqual([conv.id]);
    expect(grants.listActive('conv_1').map((g) => g.id)).toEqual([conv.id]);
    expect(grants.listActivePaths()).not.toContain('/tmp/once');
    // Revoked at the moment it expired, not at the moment somebody looked.
    now += 60_000;
    grants.listActive('conv_1');
    expect(grants.get(once.id)?.revokedAt).toBe(1_000_000 + GRANT_ABSOLUTE_TTL_MS);
  });
});
