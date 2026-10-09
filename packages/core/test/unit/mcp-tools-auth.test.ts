import { describe, expect, it } from 'vitest';
import type { McpServer, SetupRequirement } from '@kepcup/shared';

import { AppAuthRequiredError } from '../../src/apps/auth/errors.js';
import { connectedAppsSectionBody } from '../../src/apps/prompt.js';
import { buildSystemPrompt, buildAgentRunContext } from '../../src/agent/context/system-prompt.js';
import { buildMcpTools, resolveMcpToolEntries } from '../../src/mcp/tools.js';
import { buildAppTools, type AppToolFacade } from '../../src/tools/app-tools.js';
import { buildResponseTools } from '../../src/tools/index.js';
import { TOOL_SETUP_REQUIRED } from '../../src/tools/image-tools.js';

/** D73 §4.8: authorization problems in tool listing / tool calls / prompts. */

const logger = { warn() {} };
const identity = { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'task' as const };
const ctx = { signal: new AbortController().signal, runId: 'run_1' } as never;

function server(id: string, name = id, auth: McpServer['auth'] = 'oauth'): McpServer {
  return {
    id,
    name,
    transport: 'http',
    url: `http://127.0.0.1/${id}`,
    enabled: true,
    autoApprove: true,
    auth,
  };
}

const ECHO_TOOL = { name: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };

function fakeMcp(handlers: {
  listTools?: (server: McpServer) => unknown[];
  callTool?: (server: McpServer, name: string) => unknown;
}) {
  return {
    listTools: async (s: McpServer) => {
      const tools = handlers.listTools?.(s);
      return tools ?? [ECHO_TOOL];
    },
    callTool: async (s: McpServer, name: string) => handlers.callTool?.(s, name),
  } as never;
}

const gateway = { mcpToolCall: async () => ({}), audit: () => {}, logger } as never;
const secrets = { redact: (text: string) => text } as never;

describe('resolveMcpToolEntries: authorization failures are collected, not just logged', () => {
  it('returns the servers that need (re)connecting next to the usable tools', async () => {
    const warns: unknown[] = [];
    const a = server('a', 'Notion');
    const b = server('b', 'Linear');
    const c = server('c', 'Broken', 'none');
    const mcp = {
      listTools: async (s: McpServer) => {
        if (s.id === 'a') {
          throw new AppAuthRequiredError({ connectionId: 'custom:a', reason: 'expired' });
        }
        if (s.id === 'c') throw new Error('boom');
        return [ECHO_TOOL];
      },
    } as never;
    const { entries, unavailable } = await resolveMcpToolEntries({
      servers: [a, b, c],
      mcp,
      logger: { warn: (fields, msg) => warns.push({ fields, msg }) },
    });
    expect(entries.map((entry) => entry.name)).toEqual(['mcp_b_echo']);
    expect(unavailable).toEqual([
      { serverId: 'a', serverName: 'Notion', connectionId: 'custom:a', reason: 'expired' },
    ]);
    // Only the real fault is logged as a skipped server.
    expect(warns).toHaveLength(1);
  });

  it('recognises a wrapped AppAuthRequiredError and carries step-up scopes', async () => {
    const mcp = {
      listTools: async () => {
        throw new Error('listing failed', {
          cause: new AppAuthRequiredError({ connectionId: 'custom:a', reason: 'scope', scopes: ['x', 'y'] }),
        });
      },
    } as never;
    const { unavailable } = await resolveMcpToolEntries({ servers: [server('a')], mcp, logger });
    expect(unavailable).toMatchObject([{ reason: 'scope', scopes: ['x', 'y'] }]);
  });

  it('buildMcpTools returns { tools, unavailable }', async () => {
    const result = await buildMcpTools({
      identity,
      servers: [server('a'), server('b')],
      mcp: fakeMcp({
        listTools: (s) => {
          if (s.id === 'a') throw new AppAuthRequiredError({ connectionId: 'custom:a', reason: 'not_connected' });
          return [ECHO_TOOL];
        },
      }),
      gateway,
      secrets,
      logger,
    });
    expect(result.tools.map((tool) => tool.name)).toEqual(['mcp_b_echo']);
    expect(result.unavailable.map((entry) => entry.serverId)).toEqual(['a']);
  });
});

describe('wrapMcpTool: AppAuthRequiredError → connect-app setup + SETUP_REQUIRED', () => {
  async function toolWith(callTool: () => never, onSetupRequired?: (r: SetupRequirement) => void) {
    const { tools } = await buildMcpTools({
      identity,
      servers: [server('a', 'Notion')],
      mcp: fakeMcp({ callTool }),
      gateway,
      secrets,
      logger,
      onSetupRequired,
    });
    return tools[0]!;
  }

  it('records the requirement and answers SETUP_REQUIRED with a reconnect text', async () => {
    const hits: SetupRequirement[] = [];
    const tool = await toolWith(
      () => {
        throw new AppAuthRequiredError({ connectionId: 'custom:a', reason: 'expired' });
      },
      (requirement) => hits.push(requirement),
    );
    const result = await tool.execute({}, ctx);
    expect(result).toMatchObject({ ok: false, errorCode: TOOL_SETUP_REQUIRED });
    expect(result.content).toContain('需要重新连接「Notion」');
    expect(hits).toEqual([
      {
        kind: 'connect-app',
        target: { kind: 'custom', serverId: 'a' },
        connectionId: 'custom:a',
        reason: 'expired',
      },
    ]);
  });

  it('scope step-up keeps the scopes; a wrapped error counts; other errors stay MCP_CALL_FAILED', async () => {
    const hits: SetupRequirement[] = [];
    const scoped = await toolWith(
      () => {
        throw new Error('call failed', {
          cause: new AppAuthRequiredError({ connectionId: 'custom:a', reason: 'scope', scopes: ['write'] }),
        });
      },
      (requirement) => hits.push(requirement),
    );
    expect((await scoped.execute({}, ctx)).errorCode).toBe(TOOL_SETUP_REQUIRED);
    expect(hits[0]).toMatchObject({ reason: 'scope', scopes: ['write'] });

    const other = await toolWith(
      () => {
        throw new Error('network down');
      },
      (requirement) => hits.push(requirement),
    );
    const failed = await other.execute({}, ctx);
    expect(failed.errorCode).toBe('MCP_CALL_FAILED');
    expect(hits).toHaveLength(1);
  });

  it('works without a handler (no crash)', async () => {
    const tool = await toolWith(() => {
      throw new AppAuthRequiredError({ connectionId: 'custom:a', reason: 'not_connected' });
    });
    expect((await tool.execute({}, ctx)).errorCode).toBe(TOOL_SETUP_REQUIRED);
  });
});

describe('<connected_apps> prompt section', () => {
  const unavailable = [
    { serverId: 'a', serverName: 'No\ntion', connectionId: 'custom:a', reason: 'expired' as const },
    { serverId: 'b', serverName: 'Linear', connectionId: 'custom:b', reason: 'not_connected' as const },
  ];

  it('lists only apps needing reconnection with the app_request_connection rule; empty → empty', () => {
    expect(connectedAppsSectionBody([])).toBe('');
    const body = connectedAppsSectionBody(unavailable);
    expect(body).toContain('No tion（connection_id: custom:a）：授权已失效');
    expect(body).toContain('Linear（connection_id: custom:b）：尚未连接');
    expect(body).toContain('app_request_connection');
    expect(body).toContain('不要让用户粘贴令牌');
  });

  it('buildAgentRunContext carries the section only when given', () => {
    const base = { timeZone: 'UTC', now: new Date(0), permission: 'ask' as never };
    expect(buildAgentRunContext(base)).not.toContain('<connected_apps>');
    const withApps = buildAgentRunContext({ ...base, connectedApps: connectedAppsSectionBody(unavailable) });
    expect(withApps).toContain('<connected_apps>');
    expect(withApps).toContain('custom:a');
  });

  it('buildSystemPrompt places it after <skills> and omits it when empty', () => {
    const input = {
      bot: { id: 'bot_1', name: 'B', profile: minimalProfile() },
      conversation: { id: 'conv_1', type: 'direct', title: '', directBotId: 'bot_1' },
      timeZone: 'UTC',
      now: new Date(0),
      skills: '- demo: skill',
    } as never;
    const empty = buildSystemPrompt(input);
    expect(empty).not.toContain('<connected_apps>');
    const withApps = buildSystemPrompt({
      ...(input as object),
      connectedApps: connectedAppsSectionBody(unavailable),
    } as never);
    expect(withApps.indexOf('<connected_apps>')).toBeGreaterThan(withApps.indexOf('<skills>'));
    expect(withApps).toContain('app_request_connection');
  });
});

function minimalProfile() {
  return {
    identity: { name: 'B', bio: '' },
    persona: { personality: '', tone: '', style: '', values: '', sample_dialogues: '' },
    role: { expertise: '', responsibilities: '' },
    boundaries: [],
    runtime: { model: '', light_model: '', network_policy: 'open', network_allowlist: [], mcp_server_ids: [] },
    behavior: {},
  };
}

describe('app_request_connection tool', () => {
  function facade(): { apps: AppToolFacade; calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      apps: {
        requestConnection: (input) => {
          calls.push(input);
          return input.serverId === 'a' || input.connectionId === 'custom:a'
            ? { ok: true, message: '已请求用户连接' }
            : { ok: false, message: '没有可连接的应用' };
        },
      },
    };
  }

  it('SETUP_REQUIRED for a valid target, INVALID_INPUT for an unknown one or no target', async () => {
    const { apps, calls } = facade();
    const [tool] = buildAppTools({ identity, apps });
    expect(tool!.name).toBe('app_request_connection');
    const ok = await tool!.execute({ connection_id: 'custom:a', reason: '需要读 Notion' }, ctx);
    expect(ok).toMatchObject({ ok: false, errorCode: TOOL_SETUP_REQUIRED });
    expect(calls[0]).toEqual({ connectionId: 'custom:a', reason: '需要读 Notion' });
    expect((await tool!.execute({ server_id: 'zzz' }, ctx)).errorCode).toBe('INVALID_INPUT');
    expect((await tool!.execute({}, ctx)).errorCode).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(2); // the empty call never reached the facade
  });

  it('is registered in the turn and task toolsets only when the facade is present', () => {
    const base = {
      messages: {} as never,
      attachments: {} as never,
      runs: {} as never,
      secrets: {} as never,
      renderOptions: {} as never,
      gateway: {} as never,
      workspacePath: '/tmp/ws',
      projectPath: null,
      projects: {} as never,
      network: { mode: 'open', allowDomains: [] } as never,
      fsState: {} as never,
      environment: { request: async () => ({}), offeredItems: () => [] } as never,
    };
    for (const loopType of ['turn', 'task'] as const) {
      const id = { ...identity, loopType };
      const without = buildResponseTools({ identity: id, deps: base as never }).map((t) => t.name);
      expect(without).not.toContain('app_request_connection');
      const withApps = buildResponseTools({
        identity: id,
        deps: { ...base, apps: facade().apps } as never,
      }).map((t) => t.name);
      expect(withApps).toContain('app_request_connection');
    }
  });
});
