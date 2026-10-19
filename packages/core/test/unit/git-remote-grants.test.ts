import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ToolGateway, type GatewayDeps } from '../../src/gateway/index.js';
import {
  GitRemoteGrants,
  gitRemoteGrantTarget,
} from '../../src/permissions/git-remote-grants.js';
import type { ApprovalOutcome } from '../../src/permissions/approvals.js';
import { resolvePaths } from '../../src/infra/paths.js';
import type { RunIdentity } from '../../src/agent/types.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';
import { insertProjectConversation } from '../support/projects.js';

/**
 * git 远程操作的持续授权（docs/design/13-permissions.md）：`git_remote` 审批卡的
 * 时长三档（仅这一次 / 本对话内 / 对该 Bot）、用户批准落 `git_remote_grants` 后
 * 免卡、带选项的调用始终弹卡（fail closed）、无人值守自动批准不落授权。
 */

let env: RealMainDb | undefined;
const tempDirs: string[] = [];
afterEach(async () => {
  env?.dispose();
  env = undefined;
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

const BOT = 'bot_1';
const CONV = 'conv_1';
const task: RunIdentity = { runId: 'run_1', botId: BOT, conversationId: CONV, loopType: 'task' };

interface HarnessOptions {
  answer?: 'approved' | 'denied';
  duration?: 'once' | 'conversation' | 'bot';
  unattended?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  env = openRealMainDb();
  env.db
    .prepare(
      "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_lead', 'lead', '{}', 'active', 0, 0)",
    )
    .run();
  insertProjectConversation(env.db, { id: CONV, leadBotId: 'bot_lead' });
  const grants = new GitRemoteGrants({ db: env.db, clock: env.clock });
  const requests: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const home = await mkdtemp(path.join(tmpdir(), 'grg-gw-'));
  tempDirs.push(home);
  const answer = options.answer ?? 'approved';
  const deps: GatewayDeps = {
    paths: resolvePaths(home),
    sandbox: { kind: 'srt', probe: async () => ({ backend: 'srt', available: true }) } as never,
    audit: {
      record: (_i: unknown, action: string, detail: Record<string, unknown>) => {
        audits.push({ action, detail });
      },
    } as unknown as GatewayDeps['audit'],
    secrets: { redact: (text: string) => text } as unknown as GatewayDeps['secrets'],
    logger,
    approvals: {
      request: async (
        _identity: unknown,
        kind: string,
        payload: Record<string, unknown>,
      ): Promise<ApprovalOutcome> => {
        requests.push({ kind, payload });
        return {
          approval: {
            id: `apr_${requests.length}`,
            autoApproved: options.unattended === true,
            decision: options.duration !== undefined ? { duration: options.duration } : null,
          },
          decision: answer,
        } as ApprovalOutcome;
      },
    } as unknown as GatewayDeps['approvals'],
    grants: { listEffective: () => [], noteOnceUse() {} } as unknown as GatewayDeps['grants'],
    allowlist: { match: () => ({ exempt: false }) } as unknown as GatewayDeps['allowlist'],
    unattended: {
      effective: () => ({ enabled: options.unattended === true }),
    } as unknown as GatewayDeps['unattended'],
    workdirs: {
      writeDenial: () => null,
      boundWorkdir: () => null,
      gitRemote: async (
        _identity: RunIdentity,
        input: { operation: string; args: string[] },
        handler: {
          requestApproval(payload: Record<string, unknown>): Promise<'approved' | 'denied'>;
        },
      ) => {
        const decision = await handler.requestApproval({
          operation: input.operation,
          args: input.args,
          cwd: '/p',
          reason: '',
        });
        if (decision !== 'approved') throw Object.assign(new Error('denied'), { code: 'APPROVAL_DENIED' });
        return { exitCode: 0, output: '' };
      },
    } as unknown as GatewayDeps['workdirs'],
    platform: 'linux',
    readOnlyRootsOverride: [],
    sensitiveOverride: [],
    gitRemoteGrants: grants,
  };
  const gateway = new ToolGateway(deps);
  return { gateway, grants, requests, audits };
}

describe('gitRemoteGrantTarget', () => {
  it('grantable: push / pull / fetch with a remote and option-free extra args', () => {
    expect(gitRemoteGrantTarget('push', ['origin', 'main'])).toEqual({
      operation: 'push',
      remote: 'origin',
    });
    expect(gitRemoteGrantTarget('push', ['origin'])).toEqual({
      operation: 'push',
      remote: 'origin',
    });
    expect(gitRemoteGrantTarget('pull', ['upstream', 'main'])).toEqual({
      operation: 'pull',
      remote: 'upstream',
    });
    expect(gitRemoteGrantTarget('fetch', ['origin', '--tags'])).toBeNull();
    expect(gitRemoteGrantTarget('push', ['origin', '-f', 'main'])).toBeNull();
    expect(gitRemoteGrantTarget('push', ['--force', 'origin'])).toEqual({
      operation: 'push',
      remote: '--force',
    });
    expect(gitRemoteGrantTarget('push', [])).toBeNull();
    expect(gitRemoteGrantTarget('clone', ['https://example.com/x.git'])).toBeNull();
    expect(gitRemoteGrantTarget('remote_add', ['origin', 'https://example.com/x.git'])).toBeNull();
    expect(gitRemoteGrantTarget('init', [])).toBeNull();
  });
});

describe('gateway gitRemote standing grants', () => {
  it('first push raises a card offering durations; a bot-level decision mints a grant that skips later cards', async () => {
    const h = await harness({ duration: 'bot' });
    await h.gateway.gitRemote(task, { operation: 'push', args: ['origin', 'main'], reason: '推送' });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.payload['durations']).toEqual(['once', 'conversation', 'bot']);

    await h.gateway.gitRemote(task, { operation: 'push', args: ['origin', 'dev'], reason: '再推' });
    expect(h.requests).toHaveLength(1); // no second card
    expect(h.audits.filter((a) => a.action === 'git_remote_call').map((a) => a.detail.approvedBy)).toEqual([
      'user',
      'grant',
    ]);

    const grant = h.grants.find({
      botId: BOT,
      conversationId: CONV,
      operation: 'push',
      remote: 'origin',
    });
    expect(grant).not.toBeNull();
    expect(grant!.conversationId).toBeNull(); // bot level
  });

  it('a conversation-level decision only covers that conversation', async () => {
    const h = await harness({ duration: 'conversation' });
    await h.gateway.gitRemote(task, { operation: 'push', args: ['origin', 'main'], reason: '推送' });
    expect(
      h.grants.find({ botId: BOT, conversationId: CONV, operation: 'push', remote: 'origin' }),
    ).toMatchObject({ conversationId: CONV });
    expect(
      h.grants.find({ botId: BOT, conversationId: 'conv_2', operation: 'push', remote: 'origin' }),
    ).toBeNull();
  });

  it('a choice the card never offered degrades: no durations in the payload keeps clone a one-shot', async () => {
    const h = await harness({ duration: 'bot' });
    await h.gateway.gitRemote(task, {
      operation: 'clone',
      args: ['https://example.com/x.git'],
      reason: '克隆',
    });
    expect(h.requests[0]!.payload['durations']).toBeUndefined();
    // clone is not grantable at all — nothing can be minted for it
    expect(gitRemoteGrantTarget('clone', ['https://example.com/x.git'])).toBeNull();
  });

  it('option-carrying args never match a standing grant', async () => {
    const h = await harness({ duration: 'bot' });
    await h.gateway.gitRemote(task, { operation: 'push', args: ['origin', 'main'], reason: '推送' });
    h.requests.length = 0;
    await h.gateway.gitRemote(task, {
      operation: 'push',
      args: ['origin', '--force', 'main'],
      reason: '强推',
    });
    expect(h.requests).toHaveLength(1);
  });

  it('unattended mode auto-approves but mints no grant', async () => {
    const h = await harness({ unattended: true, duration: undefined });
    await h.gateway.gitRemote(task, { operation: 'push', args: ['origin', 'main'], reason: '推送' });
    expect(h.requests).toHaveLength(1);
    expect(
      h.grants.find({ botId: BOT, conversationId: CONV, operation: 'push', remote: 'origin' }),
    ).toBeNull();
    expect(h.audits.at(-1)!.detail.approvedBy).toBe('unattended');
  });

  it('a denial mints nothing', async () => {
    const h = await harness({ answer: 'denied', duration: 'bot' });
    await expect(
      h.gateway.gitRemote(task, { operation: 'push', args: ['origin', 'main'], reason: '推送' }),
    ).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(
      h.grants.find({ botId: BOT, conversationId: CONV, operation: 'push', remote: 'origin' }),
    ).toBeNull();
  });
});

describe('GitRemoteGrants service', () => {
  it('find prefers the bot-level grant; revokes are scoped', async () => {
    env = openRealMainDb();
    env.db
      .prepare(
        "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_lead', 'lead', '{}', 'active', 0, 0)",
      )
      .run();
    insertProjectConversation(env.db, { id: CONV, leadBotId: 'bot_lead' });
    const grants = new GitRemoteGrants({ db: env.db, clock: env.clock });
    const conv = grants.create({
      botId: BOT,
      conversationId: CONV,
      operation: 'push',
      remote: 'origin',
    });
    const botLevel = grants.create({ botId: BOT, operation: 'push', remote: 'origin' });
    expect(
      grants.find({ botId: BOT, conversationId: CONV, operation: 'push', remote: 'origin' })!.id,
    ).toBe(botLevel.id);
    expect(
      grants.find({ botId: BOT, conversationId: 'conv_2', operation: 'push', remote: 'origin' })!.id,
    ).toBe(botLevel.id);
    expect(grants.find({ botId: 'bot_2', conversationId: CONV, operation: 'push', remote: 'origin' })).toBeNull();

    // idempotent create
    expect(
      grants.create({ botId: BOT, operation: 'push', remote: 'origin' }).id,
    ).toBe(botLevel.id);

    expect(grants.revokeForBotInConversation(BOT, CONV)).toBe(1);
    expect(grants.get(conv.id)!.revokedAt).not.toBeNull();
    expect(grants.get(botLevel.id)!.revokedAt).toBeNull();
    expect(grants.revokeForBot(BOT)).toBe(1);
    expect(grants.get(botLevel.id)!.revokedAt).not.toBeNull();
  });
});
