import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalDuration } from '@kepcup/shared';

import { ToolGateway, type GatewayDeps } from '../../src/gateway/index.js';
import { AppToolGrants } from '../../src/apps/grants.js';
import type { AppToolContext } from '../../src/apps/exposure.js';
import {
  appToolDurations,
  assertGrantAllowedForTier,
  tierAllowsBotLevelGrant,
  tierRequiresConnectAck,
} from '../../src/apps/tier.js';
import type { McpToolDecision } from '../../src/mcp/policy.js';
import { resolvePaths } from '../../src/infra/paths.js';
import { UnavailableSandboxBackend } from '../../src/sandbox/types.js';
import type { RunIdentity } from '../../src/agent/types.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

/**
 * 分级信任落地（D73 P3 §7.2）：`community` 的写入类工具不提供「对该 Bot 总是允许」，
 * 伪造的 `bot` 决定降级，创建 Bot 级授权被兜底拒绝；builtin / verified / 破坏性不变。
 */

describe('tier rules (pure)', () => {
  it('community write has no bot duration; builtin and verified keep all three', () => {
    expect(appToolDurations({ tier: 'community', risk: 'write', grantable: true })).toEqual([
      'once',
      'conversation',
    ]);
    for (const tier of ['builtin', 'verified']) {
      expect(appToolDurations({ tier, risk: 'write', grantable: true })).toEqual([
        'once',
        'conversation',
        'bot',
      ]);
    }
  });

  it('destructive and non-grantable calls are once only in every tier', () => {
    for (const tier of ['builtin', 'verified', 'community', 'developer', undefined]) {
      expect(appToolDurations({ tier, risk: 'destructive', grantable: false })).toEqual(['once']);
      expect(appToolDurations({ tier, risk: 'write', grantable: false })).toEqual(['once']);
      expect(appToolDurations({ tier, risk: 'read', grantable: true })).toEqual(['once']);
    }
  });

  it('unknown tiers fail closed; only community needs the first-connect acknowledgement', () => {
    expect(tierAllowsBotLevelGrant('mystery')).toBe(false);
    expect(tierAllowsBotLevelGrant(undefined)).toBe(false);
    expect(appToolDurations({ tier: undefined, risk: 'write', grantable: true })).toEqual([
      'once',
      'conversation',
    ]);
    expect(tierAllowsBotLevelGrant('community')).toBe(false);
    expect(tierAllowsBotLevelGrant('verified')).toBe(true);
    expect(tierRequiresConnectAck('community')).toBe(true);
    expect(tierRequiresConnectAck('verified')).toBe(false);
    expect(tierRequiresConnectAck('builtin')).toBe(false);
  });

  it('refuses bot-level grants for restricted tiers but allows conversation grants', () => {
    expect(() => assertGrantAllowedForTier({ tier: 'community', conversationId: null })).toThrow(
      /总是允许/,
    );
    expect(() =>
      assertGrantAllowedForTier({ tier: 'community', conversationId: 'c1' }),
    ).not.toThrow();
    expect(() =>
      assertGrantAllowedForTier({ tier: 'verified', conversationId: null }),
    ).not.toThrow();
    // an unknown / missing tier fails closed
    expect(() => assertGrantAllowedForTier({ tier: undefined, conversationId: null })).toThrow();
  });
});

let env: RealMainDb | undefined;
const tempDirs: string[] = [];
function release(): void {
  env?.dispose();
  env = undefined;
}
afterEach(async () => {
  release();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const SERVER = { id: 'conn_gh', name: 'GitHub（jyy@example.com）' };
const task: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'task',
};

function context(tier: string | undefined): AppToolContext {
  return {
    connectionId: 'conn_gh',
    connectorId: 'github',
    connectorSlug: 'github',
    accountLabel: 'jyy@example.com',
    appName: 'GitHub',
    tier,
  };
}

function decision(overrides: Partial<McpToolDecision> = {}): McpToolDecision {
  return {
    risk: 'write',
    riskSource: 'annotation',
    approval: 'ask',
    approvalSource: 'default',
    enabled: true,
    ...overrides,
  };
}

async function harness(answer: { duration?: ApprovalDuration } = {}, tool = decision()) {
  env = openRealMainDb();
  env.db
    .prepare(
      "insert into app_connections (id, connector_id, label, status, created_at, updated_at) values ('conn_gh', 'github', 'g', 'connected', 1, 1)",
    )
    .run();
  for (const id of ['conv_1', 'conv_2']) {
    env.db
      .prepare("insert into conversations (id, type, created_at) values (?, 'group', 1)")
      .run(id);
  }
  const grants = new AppToolGrants({ db: env.db, clock: env.clock });
  const requests: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const home = await mkdtemp(path.join(tmpdir(), 'app-tier-'));
  tempDirs.push(home);
  const deps: GatewayDeps = {
    paths: resolvePaths(home),
    sandbox: new UnavailableSandboxBackend('test'),
    audit: { record() {} } as unknown as GatewayDeps['audit'],
    secrets: { redact: (text: string) => text } as unknown as GatewayDeps['secrets'],
    logger,
    approvals: {
      request: async (_identity: unknown, kind: string, payload: Record<string, unknown>) => {
        requests.push({ kind, payload });
        // Same degrade rule as ApprovalService.decide(): a duration the card did not offer → once.
        const offered = (payload['durations'] as ApprovalDuration[] | undefined) ?? ['once'];
        const chosen =
          answer.duration !== undefined && offered.includes(answer.duration)
            ? answer.duration
            : 'once';
        return {
          approval: {
            id: `apr_${requests.length}`,
            autoApproved: false,
            decision: { duration: chosen },
          },
          decision: 'approved',
        };
      },
    } as unknown as GatewayDeps['approvals'],
    grants: {} as GatewayDeps['grants'],
    allowlist: {} as GatewayDeps['allowlist'],
    unattended: {} as GatewayDeps['unattended'],
    projects: {} as GatewayDeps['projects'],
    platform: 'linux',
    readOnlyRootsOverride: [],
    sensitiveOverride: [],
    appGrants: grants,
    mcpToolDecision: async () => tool,
  };
  return { gateway: new ToolGateway(deps), grants, requests };
}

const call = (
  h: Awaited<ReturnType<typeof harness>>,
  tier: string | undefined,
  identity: RunIdentity = task,
) => h.gateway.mcpToolCall(identity, SERVER, 'create_issue', {}, { connection: context(tier) });

describe('gateway: community write card', () => {
  it('offers once / conversation only; verified and builtin still offer bot', async () => {
    const community = await harness();
    await call(community, 'community');
    expect(community.requests[0]!.payload['durations']).toEqual(['once', 'conversation']);
    release();
    for (const tier of ['verified', 'builtin']) {
      const h = await harness();
      await call(h, tier);
      expect(h.requests[0]!.payload['durations'], tier).toEqual(['once', 'conversation', 'bot']);
      release();
    }
  });

  it('a forged bot decision degrades to once and creates no grant', async () => {
    const h = await harness({ duration: 'bot' });
    const result = await call(h, 'community');
    expect(result.approvedBy).toBe('user');
    expect(h.grants.list()).toEqual([]);
    // the next call asks again
    await call(h, 'community');
    expect(h.requests).toHaveLength(2);
  });

  it('a conversation grant is still available and applies to that conversation only', async () => {
    const h = await harness({ duration: 'conversation' });
    await call(h, 'community');
    expect(h.grants.list()).toMatchObject([{ conversationId: 'conv_1', toolName: 'create_issue' }]);
    await call(h, 'community'); // covered by the grant: no second card
    expect(h.requests).toHaveLength(1);
    await call(h, 'community', { ...task, conversationId: 'conv_2' });
    expect(h.requests).toHaveLength(2);
  });

  it('destructive cards stay once-only in every tier', async () => {
    for (const tier of ['community', 'verified', 'builtin']) {
      const h = await harness({}, decision({ risk: 'destructive' }));
      await call(h, tier);
      expect(h.requests[0]!.payload['durations'], tier).toEqual(['once']);
      release();
    }
  });

  it('ignores a bot-level grant left over from before a demotion to community', async () => {
    const h = await harness();
    h.grants.create({ botId: 'bot_1', connectionId: 'conn_gh', toolName: 'create_issue' });
    await call(h, 'verified');
    expect(h.requests).toHaveLength(0); // covered while verified
    await call(h, 'community');
    expect(h.requests).toHaveLength(1); // demoted: the stale bot-level grant no longer applies
  });
});

describe('AppToolGrants: defensive tier checks', () => {
  it('create() refuses a bot-level grant on a community connection, allows conversation-level', async () => {
    const h = await harness();
    expect(() =>
      h.grants.create({
        botId: 'bot_1',
        connectionId: 'conn_gh',
        toolName: 'create_issue',
        connectionTier: 'community',
      }),
    ).toThrow(/总是允许/);
    expect(
      h.grants.create({
        botId: 'bot_1',
        connectionId: 'conn_gh',
        toolName: 'create_issue',
        conversationId: 'conv_1',
        connectionTier: 'community',
      }).conversationId,
    ).toBe('conv_1');
    expect(
      h.grants.create({
        botId: 'bot_1',
        connectionId: 'conn_gh',
        toolName: 'other',
        connectionTier: 'verified',
      }).conversationId,
    ).toBeNull();
  });

  it('find() can exclude bot-level grants', async () => {
    const h = await harness();
    h.grants.create({ botId: 'bot_1', connectionId: 'conn_gh', toolName: 't' });
    const key = {
      botId: 'bot_1',
      connectionId: 'conn_gh',
      toolName: 't',
      conversationId: 'conv_1',
    };
    expect(h.grants.find(key)).not.toBeNull();
    expect(h.grants.find({ ...key, excludeBotLevel: true })).toBeNull();
  });
});
