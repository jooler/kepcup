import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { systemClock } from '../../src/infra/clock.js';
import { BotsService } from '../../src/domain/bots.js';
import { ConversationsService } from '../../src/domain/conversations.js';
import { MessagesService } from '../../src/domain/messages.js';
import { ApprovalsService } from '../../src/permissions/approvals.js';
import { PermissionModeService } from '../../src/permissions/mode.js';
import type { RunIdentity } from '../../src/agent/types.js';
import type { CoreLogger } from '../../src/infra/logger.js';
import type { Paths } from '../../src/infra/paths.js';
import type { PermissionMode } from '@kepcup/shared';

const dir = mkdtempSync(path.join(tmpdir(), 'permission-modes-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };

function services(
  options: { mode?: PermissionMode; source?: 'conversation' | 'unattended' } = {},
) {
  const db: SqliteDatabase = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  const clock = systemClock;
  const bots = new BotsService(db, clock);
  const conversations = new ConversationsService(db, clock);
  const messages = new MessagesService(db, clock);
  const bot = bots.create({ identity: { name: 'Coder' } });
  const conversationId = conversations.openDirect(bot.id).conversation.id;
  const identity: RunIdentity = {
    runId: 'run_modes',
    botId: bot.id,
    conversationId,
    loopType: 'task',
  };
  const mode = options.mode ?? 'manual';
  const approvals = new ApprovalsService({
    db,
    clock,
    logger: logger as unknown as CoreLogger,
    paths: { home: dir } as unknown as Paths,
    homeDir: dir,
    messages,
    conversations,
    bots,
    runs: { get: () => null, update: () => null } as never,
    secrets: { redact: (input: string) => input } as never,
    permissionMode: {
      effective: () => ({ mode, source: options.source ?? 'conversation' }),
    },
    publish: () => {},
    notify: () => {},
    audit: () => {},
  });
  return { approvals, identity, messages, conversationId };
}

function pendingStatus(approvals: ApprovalsService, identity: RunIdentity): string | undefined {
  return approvals.list(identity.conversationId ?? undefined)[0]?.status;
}

describe('bypass level decisions', () => {
  it('auto-approves access without a blocking card and records the level', async () => {
    const { approvals, identity } = services({ mode: 'bypass' });
    const outcome = await approvals.request(identity, 'access', {
      path: '/tmp/somewhere',
      access: 'write',
      reason: 'build',
      sensitive: false,
    });
    expect(outcome.decision).toBe('approved');
    expect(outcome.approval.autoApproved).toBe(true);
    expect(outcome.approval.decision).toMatchObject({ duration: 'once', via: 'bypass' });
  });

  it('still refuses commands that touch the app data directory', async () => {
    const { approvals, identity } = services({ mode: 'bypass' });
    const outcome = await approvals.request(identity, 'command', {
      command: `cat ${path.join(dir, 'main.db')}`,
      cwd: dir,
      reason: '',
      confirmModeReason: 'no sandbox',
    });
    expect(outcome.decision).toBe('denied');
    expect(outcome.approval.status).toBe('denied');
  });

  it('keeps the human-only kinds pending', () => {
    const { approvals, identity } = services({ mode: 'bypass' });
    const submitted = approvals.submitNonBlocking(identity, 'mail_send', { to: ['a@b.c'] }, () => {});
    expect(submitted.status).toBe('pending');
  });
});

describe('auto level decisions', () => {
  it('auto-approves file access and records the level', async () => {
    const { approvals, identity } = services({ mode: 'auto' });
    const outcome = await approvals.request(identity, 'access', {
      path: '/tmp/somewhere',
      access: 'write',
      reason: 'build',
      sensitive: false,
    });
    expect(outcome.decision).toBe('approved');
    expect(outcome.approval.decision).toMatchObject({ duration: 'once', via: 'auto' });
  });

  it('still asks for commands and MCP tools', () => {
    const { approvals, identity } = services({ mode: 'auto' });
    void approvals.request(identity, 'command', {
      command: 'make install',
      cwd: dir,
      reason: '',
      confirmModeReason: 'no sandbox',
    });
    void approvals.request(identity, 'mcp_tool', {
      server: 'github',
      tool: 'create_issue',
      args: {},
      risk: 'write',
    });
    const statuses = approvals.list(identity.conversationId ?? undefined).map((a) => a.status);
    expect(statuses).toEqual(['pending', 'pending']);
  });
});

describe('manual level decisions', () => {
  it('asks before outside-workspace writes', () => {
    const { approvals, identity } = services();
    void approvals.request(identity, 'access', {
      path: '/tmp/somewhere',
      access: 'write',
      reason: 'build',
      sensitive: false,
    });
    expect(pendingStatus(approvals, identity)).toBe('pending');
  });
});

describe('unattended forces bypass everywhere', () => {
  it('decides like bypass and keeps the unattended wording', async () => {
    const { approvals, identity } = services({ mode: 'bypass', source: 'unattended' });
    const outcome = await approvals.request(identity, 'access', {
      path: '/tmp/somewhere',
      access: 'write',
      reason: 'build',
      sensitive: false,
    });
    expect(outcome.decision).toBe('approved');
    expect(outcome.approval.decision).toEqual({ duration: 'once' });
  });
});

describe('PermissionModeService', () => {
  function modeService(options: {
    unattended?: boolean;
    scopes?: Record<string, string>;
  } = {}) {
    let now = 1_000;
    const published: string[] = [];
    const mode = new PermissionModeService({
      clock: { now: () => now } as never,
      logger: logger as unknown as CoreLogger,
      publish: (state) => published.push(state.mode),
      unattended: { effective: () => ({ enabled: options.unattended === true }) },
      ...(options.scopes !== undefined
        ? { resolveScope: (id: string) => options.scopes![id] ?? id }
        : {}),
    });
    return {
      mode,
      published,
      advance: (ms: number) => {
        now += ms;
      },
      now: () => now,
    };
  }

  it('defaults to manual, needs acknowledgement and expires', async () => {
    const h = modeService();
    expect(h.mode.get('conv')).toMatchObject({ mode: 'manual' });
    expect(() => h.mode.set({ conversationId: 'conv', mode: 'bypass' })).toThrow();
    expect(() => h.mode.set({ conversationId: 'conv', mode: 'auto' })).toThrow();
    const enabled = h.mode.set({
      conversationId: 'conv',
      mode: 'bypass',
      acknowledgeRisk: true,
      hours: 1,
    });
    expect(enabled.mode).toBe('bypass');
    expect(h.mode.isBypass('conv')).toBe(true);
    h.advance(3_600_001);
    expect(h.mode.isBypass('conv')).toBe(false);
    // 过期发布延后到微任务（不从读取路径同步发事件），这里等它落地。
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(h.published).toContain('manual');
  });

  it('is per conversation and resets on clearAll', () => {
    const h = modeService();
    h.mode.set({ conversationId: 'a', mode: 'auto', acknowledgeRisk: true });
    expect(h.mode.modeOf('a')).toBe('auto');
    expect(h.mode.modeOf('b')).toBe('manual');
    h.mode.clearAll();
    expect(h.mode.modeOf('a')).toBe('manual');
  });

  it('delegated and card conversations inherit their origin scope', () => {
    const h = modeService({ scopes: { exchange: 'origin', card: 'project' } });
    h.mode.set({ conversationId: 'origin', mode: 'bypass', acknowledgeRisk: true });
    h.mode.set({ conversationId: 'project', mode: 'auto', acknowledgeRisk: true });

    expect(h.mode.effective('exchange')).toMatchObject({
      mode: 'bypass',
      inheritedFrom: 'origin',
    });
    expect(h.mode.effective('card')).toMatchObject({ mode: 'auto', inheritedFrom: 'project' });
    expect(h.mode.effective('project').inheritedFrom).toBeNull();

    // A level set through an inheriting conversation belongs to its scope.
    h.mode.set({ conversationId: 'exchange', mode: 'manual' });
    expect(h.mode.modeOf('origin')).toBe('manual');
  });

  it('unattended forces bypass for every conversation without touching settings', () => {
    const h = modeService({ unattended: true });
    h.mode.set({ conversationId: 'conv', mode: 'auto', acknowledgeRisk: true });
    expect(h.mode.effective('conv')).toMatchObject({ mode: 'bypass', source: 'unattended' });
    expect(h.mode.effective('other')).toMatchObject({ mode: 'bypass', source: 'unattended' });
  });
});
