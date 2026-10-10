import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalDuration } from '@kepcup/shared';

import { ToolGateway, type GatewayDeps } from '../../src/gateway/index.js';
import { AppToolGrants } from '../../src/apps/grants.js';
import type { AppToolContext } from '../../src/apps/exposure.js';
import type { McpToolDecision } from '../../src/mcp/policy.js';
import { resolvePaths } from '../../src/infra/paths.js';
import { UnavailableSandboxBackend } from '../../src/sandbox/types.js';
import type { RunIdentity } from '../../src/agent/types.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

/**
 * D73 P1 §5.6：应用工具的网关决策——持续授权命中免卡；写入卡三档时长、破坏性只有「仅这一次」
 * 且给完整参数；批准 conversation / bot → 写 `app_tool_grants`；账号身份进审批载荷与审计。
 */

let env: RealMainDb | undefined;
const tempDirs: string[] = [];
afterEach(async () => {
  env?.dispose();
  env = undefined;
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

const CONNECTION: AppToolContext = {
  connectionId: 'conn_gh',
  connectorId: 'github',
  connectorSlug: 'github',
  accountLabel: 'jyy@example.com',
  appName: 'GitHub',
  tier: 'verified',
};
const SERVER = { id: 'conn_gh', name: 'GitHub（jyy@example.com）' };

const task: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'task',
};

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

async function harness(options: {
  decision: McpToolDecision;
  answer?: { decision: 'approved' | 'denied'; duration?: ApprovalDuration; autoApproved?: boolean };
}) {
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
  const audit: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const home = await mkdtemp(path.join(tmpdir(), 'app-gw-'));
  tempDirs.push(home);
  const answer = options.answer ?? { decision: 'approved' as const };
  const deps: GatewayDeps = {
    paths: resolvePaths(home),
    sandbox: new UnavailableSandboxBackend('test'),
    audit: {
      record: (_identity: unknown, action: string, detail: Record<string, unknown>) =>
        audit.push({ action, detail }),
    } as unknown as GatewayDeps['audit'],
    secrets: { redact: (text: string) => text } as unknown as GatewayDeps['secrets'],
    logger,
    approvals: {
      request: async (_identity: unknown, kind: string, payload: Record<string, unknown>) => {
        requests.push({ kind, payload });
        return {
          approval: {
            id: `apr_${requests.length}`,
            autoApproved: answer.autoApproved === true,
            decision: answer.duration !== undefined ? { duration: answer.duration } : null,
          },
          decision: answer.decision,
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
    mcpToolDecision: async () => options.decision,
  };
  return { gateway: new ToolGateway(deps), grants, requests, audit };
}

const call = (
  h: Awaited<ReturnType<typeof harness>>,
  args: Record<string, unknown> = {},
  identity: RunIdentity = task,
  toolName = 'create_issue',
) => h.gateway.mcpToolCall(identity, SERVER, toolName, args, { connection: CONNECTION });

describe('write tool card', () => {
  it('offers once / conversation / bot and carries the account identity', async () => {
    const h = await harness({ decision: decision() });
    await call(h, { title: 'x' });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.payload).toMatchObject({
      serverId: 'conn_gh',
      serverName: 'GitHub',
      toolName: 'create_issue',
      risk: 'write',
      connectionId: 'conn_gh',
      connectorSlug: 'github',
      accountLabel: 'jyy@example.com',
      durations: ['once', 'conversation', 'bot'],
    });
    expect(h.requests[0]!.payload['argsFull']).toBeUndefined();
  });

  it('"once" writes no grant; the audit names the account', async () => {
    const h = await harness({
      decision: decision(),
      answer: { decision: 'approved', duration: 'once' },
    });
    const outcome = await call(h);
    expect(outcome.approvedBy).toBe('user');
    expect(h.grants.list()).toEqual([]);
    expect(h.audit.find((a) => a.action === 'mcp_tool_call')?.detail).toMatchObject({
      connectionId: 'conn_gh',
      connectorSlug: 'github',
      accountLabel: 'jyy@example.com',
      appName: 'GitHub',
      approval: 'user',
    });
  });

  it('"conversation" creates a conversation-scoped grant with the approval id', async () => {
    const h = await harness({
      decision: decision(),
      answer: { decision: 'approved', duration: 'conversation' },
    });
    await call(h);
    expect(h.grants.list()).toMatchObject([
      {
        botId: 'bot_1',
        connectionId: 'conn_gh',
        toolName: 'create_issue',
        conversationId: 'conv_1',
        approvalId: 'apr_1',
      },
    ]);
  });

  it('"bot" creates a bot-wide grant', async () => {
    const h = await harness({
      decision: decision(),
      answer: { decision: 'approved', duration: 'bot' },
    });
    await call(h);
    expect(h.grants.list()).toMatchObject([{ conversationId: null, approvalId: 'apr_1' }]);
  });

  it('a denied card creates nothing', async () => {
    const h = await harness({
      decision: decision(),
      answer: { decision: 'denied', duration: 'bot' },
    });
    await expect(call(h)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(h.grants.list()).toEqual([]);
  });
});

describe('grant hit skips the card', () => {
  it('a conversation grant covers only that conversation; a bot grant covers all', async () => {
    const h = await harness({ decision: decision() });
    h.grants.create({
      botId: 'bot_1',
      connectionId: 'conn_gh',
      toolName: 'create_issue',
      conversationId: 'conv_1',
    });
    const first = await call(h);
    expect(first.approvedBy).toBe('grant');
    expect(h.requests).toHaveLength(0);
    expect(h.audit.find((a) => a.action === 'mcp_tool_call')?.detail).toMatchObject({
      approval: 'grant',
      grantId: first.grantId,
      accountLabel: 'jyy@example.com',
    });
    // Another conversation: the card comes back.
    await call(h, {}, { ...task, conversationId: 'conv_2' });
    expect(h.requests).toHaveLength(1);
    // A bot-wide grant then covers it.
    h.grants.create({ botId: 'bot_1', connectionId: 'conn_gh', toolName: 'create_issue' });
    expect((await call(h, {}, { ...task, conversationId: 'conv_2' })).approvedBy).toBe('grant');
    expect(h.requests).toHaveLength(1);
  });

  it('a revoked grant, another tool, another connection or another bot does not hit', async () => {
    const h = await harness({ decision: decision() });
    const grant = h.grants.create({
      botId: 'bot_1',
      connectionId: 'conn_gh',
      toolName: 'create_issue',
    });
    h.grants.revoke(grant.id);
    await call(h);
    h.grants.create({ botId: 'bot_1', connectionId: 'conn_gh', toolName: 'other_tool' });
    h.grants.create({ botId: 'bot_2', connectionId: 'conn_gh', toolName: 'create_issue' });
    await call(h);
    expect(h.requests).toHaveLength(2);
  });

  it('a per-tool 「每次确认」 policy overrides a standing grant and the longer durations', async () => {
    const h = await harness({ decision: decision({ approvalSource: 'policy' }) });
    h.grants.create({ botId: 'bot_1', connectionId: 'conn_gh', toolName: 'create_issue' });
    await call(h);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.payload['durations']).toEqual(['once']);
  });
});

describe('destructive tool card', () => {
  it('offers only once, with the full parameters, and never takes or creates grants', async () => {
    const h = await harness({
      decision: decision({ risk: 'destructive', riskSource: 'default' }),
      answer: { decision: 'approved', duration: 'bot' }, // a forged choice the card never offered
    });
    h.grants.create({ botId: 'bot_1', connectionId: 'conn_gh', toolName: 'delete_repo' });
    const args = { repo: 'a/b', note: 'x'.repeat(600) };
    await call(h, args, task, 'delete_repo');
    expect(h.requests).toHaveLength(1); // the grant was not honoured
    const payload = h.requests[0]!.payload;
    expect(payload['durations']).toEqual(['once']);
    expect(payload['risk']).toBe('destructive');
    // Summary is truncated, the full text is not.
    expect(String(payload['argsSummary']).length).toBeLessThan(450);
    expect(JSON.parse(String(payload['argsFull']))).toEqual(args);
    // Only the pre-existing grant remains (no new one from the forged duration).
    expect(h.grants.list()).toHaveLength(1);
  });
});

describe('unattended mode', () => {
  it('auto-approves every tier, records risk and account identity in the audit, creates no grants', async () => {
    for (const risk of ['read', 'write', 'destructive'] as const) {
      const h = await harness({
        decision: decision({ risk, approval: risk === 'read' ? 'auto' : 'ask' }),
        answer: { decision: 'approved', autoApproved: true },
      });
      const outcome = await call(h);
      expect(outcome.approvedBy).toBe(risk === 'read' ? 'auto' : 'unattended');
      expect(h.grants.list()).toEqual([]);
      expect(h.audit.find((a) => a.action === 'mcp_tool_call')?.detail).toMatchObject({
        risk,
        accountLabel: 'jyy@example.com',
        connectionId: 'conn_gh',
      });
      env?.dispose();
      env = undefined;
    }
  });
});

describe('plain MCP tools are unchanged', () => {
  it('no connection → no durations, no grants lookup, no identity in the payload', async () => {
    const h = await harness({ decision: decision() });
    h.grants.create({ botId: 'bot_1', connectionId: 'conn_gh', toolName: 'create_issue' });
    await h.gateway.mcpToolCall(task, { id: 'srv', name: '笔记服务器' }, 'create_issue', {});
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.payload).not.toHaveProperty('durations');
    expect(h.requests[0]!.payload).not.toHaveProperty('connectionId');
    expect(h.requests[0]!.payload['serverName']).toBe('笔记服务器');
  });
});
