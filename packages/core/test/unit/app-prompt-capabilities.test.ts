import { describe, expect, it } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import {
  AGENT_CATALOG,
  APP_TOOL_NAME_MAX,
  capabilityOfTool,
  defaultCapabilities,
  hostCapability,
  resolveCapabilities,
  SUPPLEMENT_TOOL_DESCRIPTION_PREFIX,
  type Bot,
  type Conversation,
} from '@kepcup/shared';
import { botProfile } from '@kepcup/testkit';

import {
  buildAgentRunContext,
  buildAgentSessionPrompt,
  buildAgentToolPolicy,
  buildSystemPrompt,
} from '../../src/agent/context/system-prompt.js';
import {
  buildExternalAgentTools,
  fitToolName,
  hostToolNamer,
  MAX_AGENT_TOOL_NAME,
  newHostServerName,
  toolAnnotations,
} from '../../src/agent/external/capabilities.js';
import { claudeProvider } from '../../src/agent/external/providers/claude.js';
import { appToolName } from '../../src/apps/naming.js';
import { APP_REQUEST_CONNECTION_RULE } from '../../src/apps/prompt.js';
import { dropBuiltinNameConflicts, buildResponseTools } from '../../src/tools/index.js';
import type { RunIdentity, ToolDefinition } from '../../src/agent/types.js';

/**
 * D73 P1：全局去重（MCP / 应用工具不得与内置工具同名）、提示词里的应用段落与平台规则、
 * `apps` 能力包（归包、桥上工具名长度、tools/list 注解与风险一致、ACP 提示词）。
 */

const CLAUDE = AGENT_CATALOG.find((entry) => entry.id === 'claude-acp')!;

function stub(name: string, mcp?: ToolDefinition['mcp']): ToolDefinition {
  return {
    name,
    description: `${name} 原描述`,
    parameters: Type.Object({}),
    execute: async () => ({ ok: true, content: '' }),
    ...(mcp !== undefined ? { mcp } : {}),
  };
}

const identity: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'task',
};

describe('global tool-name dedupe (tools/index.ts)', () => {
  it('drops an MCP / app tool whose name equals a built-in tool, with a warning; keeps the built-in', () => {
    const builtin = stub('app_request_connection');
    const clash = stub('app_request_connection', {
      serverId: 'conn_x',
      toolName: 'connection',
      risk: 'read',
    });
    const fine = stub('app_github_list_repos', {
      serverId: 'conn_gh',
      toolName: 'list_repos',
      risk: 'read',
    });
    const warnings: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const result = dropBuiltinNameConflicts([clash, builtin, fine], new Set([clash, fine]), {
      warn: (fields, msg) => warnings.push({ fields, msg }),
    });
    expect(result).toEqual([builtin, fine]);
    expect(result[0]).toBe(builtin); // the built-in object, not the impostor
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields).toMatchObject({
      name: 'app_request_connection',
      serverId: 'conn_x',
    });
  });

  it('also drops repeated names among external tools (first wins) and never touches built-ins', () => {
    const a = stub('mcp_s_echo', { serverId: 's', toolName: 'echo', risk: 'read' });
    const b = stub('mcp_s_echo', { serverId: 't', toolName: 'echo', risk: 'read' });
    const twin1 = stub('send_message');
    const twin2 = stub('send_message');
    expect(dropBuiltinNameConflicts([a, b, twin1, twin2], new Set([a, b]))).toEqual([
      a,
      twin1,
      twin2,
    ]);
    expect(dropBuiltinNameConflicts([twin1], new Set())).toEqual([twin1]);
  });

  it('buildResponseTools applies it: a connector "request" with tool "connection" cannot shadow app_request_connection', () => {
    expect(appToolName('request', 'connection')).toBe('app_request_connection');
    const impostor = stub('app_request_connection', {
      serverId: 'conn_x',
      toolName: 'connection',
      risk: 'write',
    });
    const warnings: string[] = [];
    const tools = buildResponseTools({
      identity,
      deps: {
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
        apps: { requestConnection: () => ({ ok: true, message: 'ok' }) },
        mcp: { tools: [impostor, stub('mcp_s_echo')], omitted: 0 },
        logger: { warn: (_fields, msg) => warnings.push(msg) },
      } as never,
    });
    const requests = tools.filter((tool) => tool.name === 'app_request_connection');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.mcp).toBeUndefined(); // the built-in one survived
    expect(tools.map((tool) => tool.name)).toContain('mcp_s_echo');
    expect(warnings).toEqual(['external tool name collides with a built-in tool; dropping it']);
  });
});

const BOT = {
  id: 'bot_1',
  name: '助手',
  bio: '',
  systemRole: null,
  setupState: 'done',
  profile: botProfile({ name: '助手' }),
} as unknown as Bot;
const CONV = {
  id: 'conv_1',
  type: 'direct',
  title: null,
  description: null,
} as unknown as Conversation;

describe('built-in engine prompt', () => {
  const input = {
    bot: BOT,
    conversation: CONV,
    timeZone: 'UTC',
    now: new Date(0),
  } as never;
  const connectedApps = '- GitHub（账号 work，connection_id: conn_gh）：可用';
  const availableApps = '- Notion（connector: notion）—— 笔记';

  it('adds <connected_apps> and <available_apps> plus the app_request_connection platform rule', () => {
    for (const loop of ['task', 'turn'] as const) {
      const prompt = buildSystemPrompt({
        ...(input as object),
        loop,
        connectedApps,
        availableApps,
      } as never);
      expect(prompt).toContain('<connected_apps>');
      expect(prompt).toContain('<available_apps>');
      expect(prompt.indexOf('<available_apps>')).toBeGreaterThan(
        prompt.indexOf('<connected_apps>'),
      );
      expect(prompt).toContain(`${APP_REQUEST_CONNECTION_RULE}`);
      expect(prompt).toContain('需要未连接或需重连的应用时调用 app_request_connection');
      // Numbered like the other rules.
      expect(prompt).toMatch(/\n\d+\. 需要未连接或需重连的应用时调用 app_request_connection/);
    }
  });

  it('carries neither the sections nor the rule when the bot has no app context', () => {
    for (const loop of ['task', 'turn'] as const) {
      const prompt = buildSystemPrompt({ ...(input as object), loop } as never);
      expect(prompt).not.toContain('<connected_apps>');
      expect(prompt).not.toContain('<available_apps>');
      expect(prompt).not.toContain('app_request_connection');
    }
    // Just available apps is enough to need the rule.
    expect(buildSystemPrompt({ ...(input as object), availableApps } as never)).toContain(
      APP_REQUEST_CONNECTION_RULE,
    );
  });
});

describe('apps capability pack', () => {
  it('is a supplement pack following the bot, prefix app_, no native overlap', () => {
    const pack = hostCapability('apps');
    expect(pack).toMatchObject({
      id: 'apps',
      category: 'supplement',
      default: 'follow_bot',
      toolPrefixes: ['app_'],
      overlapsNative: null,
      prerequisite: null,
    });
    expect(pack.tools).toEqual([]);
    expect(capabilityOfTool('app_request_connection')?.id).toBe('apps');
    expect(capabilityOfTool('app_github_list_repos')?.id).toBe('apps');
    // Not swallowed by the mcp pack or any other.
    expect(capabilityOfTool('mcp_srv_x')?.id).toBe('mcp');
    expect(defaultCapabilities({ nativeCapabilities: {} })).toContain('apps');
    expect(resolveCapabilities(null, CLAUDE)).toContain('apps');
  });

  const appTools = [
    stub('app_request_connection'),
    stub('app_github_list_repos', { serverId: 'conn_gh', toolName: 'list_repos', risk: 'read' }),
    stub(appToolName('github', 'x'.repeat(120)), {
      serverId: 'conn_gh',
      toolName: 'x',
      risk: 'destructive',
    }),
  ];

  it('injects app tools only when the pack is selected; no native-first description prefix', () => {
    const withPack = buildExternalAgentTools({
      responseTools: [stub('send_message'), ...appTools],
      capabilities: resolveCapabilities(null, CLAUDE),
    });
    expect(withPack.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['app_request_connection', 'app_github_list_repos']),
    );
    for (const tool of withPack.filter((entry) => entry.name.startsWith('app_'))) {
      expect(tool.description.startsWith(SUPPLEMENT_TOOL_DESCRIPTION_PREFIX)).toBe(false);
    }
    const without = buildExternalAgentTools({
      responseTools: [stub('send_message'), ...appTools],
      capabilities: resolveCapabilities(['core'], CLAUDE),
    });
    expect(without.map((tool) => tool.name)).toEqual(['send_message']);
  });

  it('keeps bridge names within 64 characters after fitToolName, with either bridge prefix', () => {
    for (const namer of [
      hostToolNamer(claudeProvider, 'kepcup'), // mcp__kepcup__
      hostToolNamer(claudeProvider, newHostServerName()), // mcp__kepcup_<8hex>__
    ]) {
      const tools = buildExternalAgentTools({
        responseTools: appTools,
        capabilities: ['core', 'apps'],
        maxNameLength: MAX_AGENT_TOOL_NAME - namer('').length,
      });
      expect(tools).toHaveLength(appTools.length);
      for (const tool of tools) {
        expect(namer(tool.name).length).toBeLessThanOrEqual(MAX_AGENT_TOOL_NAME);
        expect(tool.name.startsWith('app_')).toBe(true);
        expect(tool.mcp?.risk).toBe(
          appTools.find((t) => t.name.startsWith(tool.name.slice(0, 20)))?.mcp?.risk,
        );
      }
    }
    // The 50-char app limit leaves room for the documented `mcp__kepcup__` prefix untouched.
    const longApp = appToolName('github', 'y'.repeat(120));
    expect(longApp.length).toBe(APP_TOOL_NAME_MAX);
    expect(fitToolName(longApp, MAX_AGENT_TOOL_NAME - 'mcp__kepcup__'.length)).toBe(longApp);
  });

  it('tools/list annotations follow the tool risk: read → readOnly, destructive → destructive, write → neither', () => {
    const risky = (risk: 'read' | 'write' | 'destructive') =>
      stub('app_github_t', { serverId: 'conn_gh', toolName: 't', risk });
    expect(toolAnnotations('app_github_t', risky('read'))).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(toolAnnotations('app_github_t', risky('write'))).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(toolAnnotations('app_github_t', risky('destructive'))).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    // Shortened (hashed) names keep the prefix, so they are annotated the same way.
    const fitted = fitToolName(appToolName('github', 'z'.repeat(120)), 30);
    expect(toolAnnotations(fitted, risky('read')).readOnlyHint).toBe(true);
    // Unchanged for host tools and for tools without a recorded risk.
    expect(toolAnnotations('search_messages')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(toolAnnotations('forget')).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(toolAnnotations('app_request_connection', stub('app_request_connection'))).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
    // A plain MCP tool is not re-annotated by this change.
    expect(
      toolAnnotations('mcp_s_x', stub('mcp_s_x', { serverId: 's', toolName: 'x', risk: 'read' })),
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });
});

describe('ACP prompt', () => {
  const namer = hostToolNamer(claudeProvider, 'kepcup');
  const toolsFor = (names: string[]) => ({
    toolNames: names,
    nativeCapabilities: CLAUDE.nativeCapabilities,
    toolName: namer,
  });

  it('session prompt: the app_request_connection rule appears, spelled the agent way, only with the tool', () => {
    const withTool = buildAgentSessionPrompt({
      bot: BOT,
      conversation: CONV,
      tools: toolsFor(['send_message', 'app_request_connection', 'app_github_list_repos']),
    });
    expect(withTool).toContain(
      '需要未连接或需重连的应用时调用 mcp__kepcup__app_request_connection',
    );
    const without = buildAgentSessionPrompt({
      bot: BOT,
      conversation: CONV,
      tools: toolsFor(['send_message']),
    });
    expect(without).not.toContain('app_request_connection');
  });

  it('<tool_policy> lists the apps pack as host-only (no "use your native" wording)', () => {
    const policy = buildAgentToolPolicy(toolsFor(['send_message', 'app_github_list_repos']));
    expect(policy).toContain('已连接的第三方应用');
    expect(policy).toContain('mcp__kepcup__app_github_list_repos');
    const line = policy.split('\n').find((entry) => entry.includes('已连接的第三方应用'))!;
    expect(line).not.toContain('优先使用自带');
  });

  it('run context carries both app sections (after <recommended_skills>) and omits them when empty', () => {
    const base = { timeZone: 'UTC', now: new Date(0), permission: 'ask' as never };
    const empty = buildAgentRunContext(base);
    expect(empty).not.toContain('<connected_apps>');
    expect(empty).not.toContain('<available_apps>');
    const full = buildAgentRunContext({
      ...base,
      recommendedSkills: '- x',
      connectedApps: '- GitHub（账号 work，connection_id: conn_gh）：可用',
      availableApps: '- Notion（connector: notion）—— 笔记',
    });
    expect(full).toContain('<connected_apps>');
    expect(full).toContain('<available_apps>');
    expect(full.indexOf('<connected_apps>')).toBeGreaterThan(full.indexOf('<recommended_skills>'));
    expect(full.indexOf('<available_apps>')).toBeGreaterThan(full.indexOf('<connected_apps>'));
  });
});
