import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_CATALOG,
  agentModelRef,
  NEVER_INJECTED_TOOLS,
  resolveCapabilities,
  SUPPLEMENT_TOOL_DESCRIPTION_PREFIX,
  type AgentCatalogEntry,
  type Bot,
  type Conversation,
} from '@kepcup/shared';
import {
  agentTurn,
  botProfile,
  fakeAgentEntry,
  fakeAgentSpawner,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
} from '@kepcup/testkit';
import {
  buildAgentRunContext,
  buildAgentSessionPrompt,
  buildAgentToolPolicy,
  type AgentPromptTools,
} from '../../src/agent/context/system-prompt.js';
import {
  buildExternalAgentTools,
  bridgeToolMeta,
  fitToolName,
  hostToolNamer,
  MAX_AGENT_TOOL_NAME,
  newHostServerName,
  toolAnnotations,
} from '../../src/agent/external/capabilities.js';
import { ExternalAgentEngine } from '../../src/agent/external/engine.js';
import { AgentHost } from '../../src/agent/external/host.js';
import { claudeProvider } from '../../src/agent/external/providers/claude.js';
import { CODEX_PROCESS_CONFIG, codexProvider } from '../../src/agent/external/providers/codex.js';
import { buildProjectSection } from '../../src/project/context.js';
import type { RunSpec, ToolDefinition } from '../../src/agent/types.js';

/**
 * D72 P2：能力包落地、ACP 版提示词（平台规则 / <tool_policy> / run 级段）、
 * Claude / Codex Provider 的行为差异（以假 Agent 剧本模拟：指令下发方式、
 * `_meta.claudeCode.options`、档位映射、错误分类、进程级配置）。
 */

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const CLAUDE = AGENT_CATALOG.find((entry) => entry.id === 'claude-acp')!;
const CODEX = AGENT_CATALOG.find((entry) => entry.id === 'codex-acp')!;
const FAKE = AGENT_CATALOG.find((entry) => entry.id === 'fake')!;

/** One stand-in per response tool name (what buildResponseTools may return). */
const RESPONSE_TOOL_NAMES = [
  'send_message',
  'skip_reply',
  'search_messages',
  'get_messages_around',
  'get_attachment',
  'list_my_runs',
  'get_run',
  'request_access',
  'request_unsandboxed',
  'acquire_project_write',
  'git_remote',
  'request_environment',
  'read',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
  'bash',
  'remember',
  'recall_memory',
  'get_user_profile',
  'list_commitments',
  'memory_feedback',
  'forget',
  'propose_profile_change',
  'create_skill',
  'wiki_search',
  'wiki_read',
  'wiki_enqueue',
  'schedule',
  'list_schedules',
  'cancel_schedule',
  'browser_open',
  'browser_click',
  'generate_image',
  'understand_image',
  'generate_speech',
  'transcribe_audio',
  'generate_video',
  'web_search',
  'web_fetch',
  'install_skill',
  'delegate_task',
  'delegate_to_bot',
  'cancel_delegation',
  'list_bots',
  'propose_team',
  'mcp_srv1_lookup',
  'save_profile',
];

function stubTools(names: readonly string[] = RESPONSE_TOOL_NAMES): ToolDefinition[] {
  return names.map((name) => ({
    name,
    description: `${name} 原描述`,
    parameters: Type.Object({}),
    execute: async () => ({ ok: true, content: '' }),
  }));
}

function promptTools(
  entry: AgentCatalogEntry,
  tools: ToolDefinition[],
  provider = claudeProvider,
): AgentPromptTools {
  return {
    toolNames: tools.map((tool) => tool.name),
    nativeCapabilities: entry.nativeCapabilities,
    toolName: hostToolNamer(provider, 'kepcup'),
  };
}

const BOT = {
  id: 'bot_1',
  name: '助手',
  bio: '一个测试 Bot',
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

describe('capability packs (buildExternalAgentTools)', () => {
  it('drops never-injected and unpacked tools; prefixes supplement tools', () => {
    const capabilities = resolveCapabilities(null, CLAUDE);
    const tools = buildExternalAgentTools({ responseTools: stubTools(), capabilities });
    const names = tools.map((tool) => tool.name);
    for (const never of NEVER_INJECTED_TOOLS) expect(names).not.toContain(never);
    expect(names).not.toContain('save_profile');
    // Claude covers web natively: not injected by default.
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('understand_image');
    expect(names).toEqual(
      expect.arrayContaining(['send_message', 'remember', 'generate_image', 'mcp_srv1_lookup']),
    );
    const generate = tools.find((tool) => tool.name === 'generate_image')!;
    expect(generate.description).toBe(`${SUPPLEMENT_TOOL_DESCRIPTION_PREFIX}generate_image 原描述`);
    const remember = tools.find((tool) => tool.name === 'remember')!;
    expect(remember.description).toBe('remember 原描述');
    // Butler-only tools ride with the collaboration pack.
    expect(names).toContain('propose_team');
  });

  it('removing image_generation drops the tool and its prompt mentions; core stays', () => {
    const all = resolveCapabilities(null, FAKE).filter((id) => id !== 'image_generation');
    const capabilities = resolveCapabilities(
      all.filter((id) => id !== 'core'),
      FAKE,
    );
    expect(capabilities).toContain('core');
    const tools = buildExternalAgentTools({ responseTools: stubTools(), capabilities });
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain('generate_image');
    expect(names).toContain('send_message');
    const session = buildAgentSessionPrompt({
      bot: BOT,
      conversation: CONV,
      tools: promptTools(FAKE, tools),
    });
    expect(session).not.toContain('generate_image');
    expect(session).not.toContain('生成图片');
  });

  it('keeps prefixed tool names within the agent limit (user MCP tools)', () => {
    const long = `mcp_${'s'.repeat(20)}_${'t'.repeat(40)}`;
    const namer = hostToolNamer(claudeProvider, newHostServerName());
    expect(namer('')).toMatch(/^mcp__kepcup_[0-9a-f]{8}__$/);
    const tools = buildExternalAgentTools({
      responseTools: stubTools(['send_message', long]),
      capabilities: ['core', 'mcp'],
      maxNameLength: MAX_AGENT_TOOL_NAME - namer('').length,
    });
    const fitted = tools.find((tool) => tool.name !== 'send_message')!;
    expect(namer(fitted.name).length).toBeLessThanOrEqual(MAX_AGENT_TOOL_NAME);
    expect(fitted.name).toMatch(/^mcp_s+_t*_[0-9a-f]{8}$/);
    expect(fitToolName(long, 30)).toBe(fitToolName(long, 30));
    expect(fitToolName('send_message', 30)).toBe('send_message');
  });

  it('annotates read-only and destructive host tools for tools/list', () => {
    expect(toolAnnotations('search_messages')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(toolAnnotations('forget')).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(toolAnnotations('send_message')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it('marks bridge calls with their pack and native overlap', () => {
    expect(bridgeToolMeta('web_search', CLAUDE)).toEqual({
      capability: 'web',
      nativeOverlap: true,
    });
    expect(bridgeToolMeta('understand_image', CODEX)).toEqual({
      capability: 'image_understanding',
      nativeOverlap: false,
    });
    expect(bridgeToolMeta('remember', CLAUDE)).toEqual({
      capability: 'memory',
      nativeOverlap: false,
    });
  });
});

describe('ACP prompts', () => {
  it('session prompt: ACP platform rules with mapped tool names, no built-in file tool rules', () => {
    const tools = buildExternalAgentTools({
      responseTools: stubTools(),
      capabilities: resolveCapabilities(null, CLAUDE),
    });
    const session = buildAgentSessionPrompt({
      bot: BOT,
      conversation: CONV,
      tools: promptTools(CLAUDE, tools),
    });
    expect(session).toContain('<platform_rules>');
    expect(session).toContain('mcp__kepcup__remember');
    expect(session).toContain('mcp__kepcup__skip_reply');
    expect(session).not.toMatch(/(?<![\w])remember(?![\w])/);
    for (const banned of ['request_access', 'acquire_project_write', 'delegate_task']) {
      expect(session).not.toContain(banned);
    }
    expect(session).toContain('<identity>');
    expect(session).toContain('名字：助手');
    expect(session).toContain('<conversation_info>');
    // Time lives in the run-level part (sessions can span runs).
    expect(session).not.toContain('当前时间');
  });

  it('rules follow the injected tools: no memory rules without the memory pack', () => {
    const tools = buildExternalAgentTools({
      responseTools: stubTools(),
      capabilities: resolveCapabilities(['wiki'], FAKE),
    });
    const session = buildAgentSessionPrompt({
      bot: BOT,
      conversation: CONV,
      tools: promptTools(FAKE, tools, codexProvider),
    });
    expect(session).not.toContain('remember');
    expect(session).not.toContain('memory_feedback');
    expect(session).not.toContain('delegate_to_bot');
    expect(session).toContain('mcp__kepcup__send_message');
    // Read-only context stays independent of packs (memories are still injected).
    const run = buildAgentRunContext({
      timeZone: 'Asia/Shanghai',
      now: new Date('2026-10-07T08:00:00Z'),
      permission: 'read_only',
      relevantMemories: '- 用户喜欢猫',
      userProfile: '称呼：小王',
    });
    expect(run).toContain('<relevant_memories>\n- 用户喜欢猫');
    expect(run).toContain('<user_profile>');
    expect(run).toContain('当前时间：2026-10-07 08:00:00');
    expect(run).toContain('只读');
  });

  it('<tool_policy> names Claude / Codex native tools and skips packs not injected', () => {
    const withWeb = (entry: AgentCatalogEntry) =>
      buildExternalAgentTools({
        responseTools: stubTools(),
        capabilities: resolveCapabilities([...resolveCapabilities(null, entry), 'web'], entry),
      });
    const claudePolicy = buildAgentToolPolicy(promptTools(CLAUDE, withWeb(CLAUDE), claudeProvider));
    expect(claudePolicy).toContain(
      '用你自带的 WebSearch / WebFetch，不要用 mcp__kepcup__web_search / mcp__kepcup__web_fetch，除非它们不可用或失败',
    );
    const codexPolicy = buildAgentToolPolicy(promptTools(CODEX, withWeb(CODEX), codexProvider));
    expect(codexPolicy).toContain('用你自带的 web_search，不要用 mcp__kepcup__web_search');
    // Generic phrasing where the agent declares nothing native.
    expect(codexPolicy).toContain('识别图片内容：若你自带同类能力，优先使用自带的');
    // Host-first lines.
    expect(claudePolicy).toContain('mcp__kepcup__remember');
    expect(claudePolicy).toContain('不要写入 CLAUDE.md / AGENTS.md');
    expect(claudePolicy).toContain('不要用 cron');
    expect(claudePolicy).toContain('mcp__kepcup__request_environment');
    expect(claudePolicy).toContain('mcp__kepcup__delegate_to_bot');

    // Default Claude packs: web not injected → absent from the policy.
    const defaults = buildExternalAgentTools({
      responseTools: stubTools(),
      capabilities: resolveCapabilities(null, CLAUDE),
    });
    const defaultPolicy = buildAgentToolPolicy(promptTools(CLAUDE, defaults));
    expect(defaultPolicy).not.toContain('web_search');
    expect(defaultPolicy).not.toContain('WebSearch');
    // Only core: no supplement section, no schedule line.
    const coreOnly = buildExternalAgentTools({
      responseTools: stubTools(),
      capabilities: resolveCapabilities([], CLAUDE),
    });
    const corePolicy = buildAgentToolPolicy(promptTools(CLAUDE, coreOnly));
    expect(corePolicy).not.toContain('补位能力');
    expect(corePolicy).not.toContain('schedule');
    expect(corePolicy).toContain('mcp__kepcup__send_message');
  });

  it('<project> skips the guide files the agent reads itself', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-proj-'));
    try {
      writeFileSync(path.join(dir, 'AGENTS.md'), 'AGENTS 约定');
      writeFileSync(path.join(dir, 'CLAUDE.md'), 'CLAUDE 约定');
      mkdirSync(path.join(dir, 'src'));
      const builtin = await buildProjectSection({ path: dir, budget: 4_000, isIgnored: null });
      expect(builtin!.body).toContain('AGENTS 约定');
      const codex = await buildProjectSection({
        path: dir,
        budget: 4_000,
        isIgnored: null,
        skipGuideFiles: codexProvider.agentSideConfigFiles,
      });
      expect(codex!.body).not.toContain('AGENTS 约定');
      expect(codex!.body).toContain('CLAUDE 约定');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Claude / Codex providers (fake agent scripts)', () => {
  const dirs: string[] = [];
  const hosts: AgentHost[] = [];
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const CLAUDE_MODES = {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'acceptEdits', name: 'Accept Edits' },
      { id: 'plan', name: 'Plan' },
      { id: 'bypassPermissions', name: 'Bypass' },
    ],
  };
  const CODEX_MODES = {
    currentModeId: 'agent',
    availableModes: [
      { id: 'read-only', name: 'Read-only' },
      { id: 'workspace-write', name: 'Workspace' },
      { id: 'agent', name: 'Auto' },
      { id: 'agent-full-access', name: 'Full' },
    ],
  };

  function setup(provider: 'claude' | 'codex', script: FakeAgentScript) {
    const entry = fakeAgentEntry(`fake-${provider}`, { provider });
    const workdir = mkdtempSync(path.join(tmpdir(), 'kepcup-p2-'));
    dirs.push(workdir);
    const started: FakeAcpAgentHandle[] = [];
    const host = new AgentHost({
      logger,
      redact: (text) => text,
      appVersion: '1.0.0',
      resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
      spawn: fakeAgentSpawner({ [entry.id]: script }, started) as never,
    });
    hosts.push(host);
    const engine = new ExternalAgentEngine({
      host,
      catalog: () => [entry],
      logger,
      cancelGraceMs: 200,
    });
    const spec = (overrides: Partial<NonNullable<RunSpec['external']>> = {}): RunSpec => ({
      identity: { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' },
      model: agentModelRef(entry.id, ''),
      buildSystemPrompt: async () => 'UNUSED',
      messages: [{ role: 'user', content: 'HELLO', timestamp: 0 }],
      promptParts: { session: 'SESSION-PROMPT', run: 'RUN-CONTEXT', conversation: 'TRIGGER' },
      tools: [],
      limits: { maxTurns: 42 },
      workdir,
      external: {
        agentId: entry.id,
        permission: 'read_only',
        capabilities: [],
        sessionKey: 'k',
        ...overrides,
      },
    });
    const modes = () =>
      (started[0]?.observed.events ?? []).flatMap((event) =>
        event.kind === 'mode' ? [event.modeId] : [],
      );
    return { engine, started, spec, modes };
  }

  it('Claude: meta-append system prompt, safe claudeCode options + sandbox, read_only → default + no write tools', async () => {
    const { engine, started, spec, modes } = setup('claude', {
      modes: CLAUDE_MODES,
      turns: [agentTurn().text('好'), agentTurn().text('好')],
    });
    expect((await engine.startRun(spec()).done).status).toBe('completed');
    const observed = started[0]!.observed;
    expect(observed.sessions[0]!.meta).toEqual({
      systemPrompt: { append: 'SESSION-PROMPT' },
      claudeCode: {
        options: {
          settingSources: [],
          allowDangerouslySkipPermissions: false,
          maxTurns: 42,
          disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
          // P3: native sandbox always on (no isolation without the permission bridge).
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
          },
        },
      },
    });
    expect(observed.prompts[0]!.text).not.toContain('SESSION-PROMPT');
    expect(observed.prompts[0]!.text).toContain('RUN-CONTEXT');
    // plan mode would suppress MCP tools: read_only stays in `default` (already
    // current → no switch) and relies on disallowedTools + permission denials.
    expect(modes()).toEqual([]);
    // Host-enforced keys come last in the options object.
    expect(
      Object.keys(
        (observed.sessions[0]!.meta as { claudeCode: { options: object } }).claudeCode.options,
      ).slice(-3),
    ).toEqual(['sandbox', 'settingSources', 'allowDangerouslySkipPermissions']);
    // P3: workspace → acceptEdits (cwd edits auto-accepted, the rest asks the host).
    await engine.startRun(spec({ permission: 'workspace', loadUserConfig: true })).done;
    expect(modes()).toEqual(['acceptEdits']);
    expect(
      (observed.sessions[1]!.meta as { claudeCode: { options: Record<string, unknown> } })
        .claudeCode.options.disallowedTools,
    ).toBeUndefined();
    expect(
      (observed.sessions[1]!.meta as { claudeCode: { options: { settingSources: string[] } } })
        .claudeCode.options.settingSources,
    ).toEqual(['user']);
  });

  it('fails readably when host tools are due but the bridge is not running', async () => {
    const { engine, started, spec } = setup('claude', {
      modes: CLAUDE_MODES,
      turns: [agentTurn().text('不该运行')],
    });
    const outcome = await engine.startRun({ ...spec(), tools: stubTools(['send_message']) }).done;
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'AGENT_UNAVAILABLE' } });
    expect(outcome.error?.message).toContain('宿主工具桥未启动');
    expect(started[0]!.observed.prompts).toHaveLength(0);
  });

  it('Claude: a missing tier mode fails closed; -32000 at prompt is auth_required', async () => {
    const noModes = setup('claude', { turns: [agentTurn().text('不该运行')] });
    expect((await noModes.engine.startRun(noModes.spec()).done).error?.code).toBe(
      'AGENT_INCOMPATIBLE',
    );
    expect(noModes.started[0]!.observed.prompts).toHaveLength(0);

    const unauthenticated = setup('claude', {
      modes: CLAUDE_MODES,
      turns: [agentTurn().fail(-32000, 'Authentication required')],
    });
    const outcome = await unauthenticated.engine.startRun(unauthenticated.spec()).done;
    expect(outcome.error?.code).toBe('AGENT_AUTH_REQUIRED');
  });

  it('Claude: keeps only its login methods and reads MCP names from _meta', () => {
    const methods = claudeProvider.authMethods!([
      { id: 'claude-ai-login', name: 'Claude' },
      { id: 'console-login', name: 'Console' },
      { id: 'gateway', name: 'Gateway' },
    ] as never);
    expect(methods.map((method) => method.id)).toEqual(['claude-ai-login', 'console-login']);
    expect(
      claudeProvider.bridgeToolFromCall!(
        { title: 'whatever', _meta: { claudeCode: { toolName: 'mcp__kepcup_ab__remember' } } },
        'kepcup_ab',
      ),
    ).toBe('remember');
    // Another server with the bridge's old fixed name, or only a title: not ours.
    expect(
      claudeProvider.bridgeToolFromCall!(
        { _meta: { claudeCode: { toolName: 'mcp__kepcup__remember' } } },
        'kepcup_ab',
      ),
    ).toBeNull();
    expect(
      claudeProvider.bridgeToolFromCall!({ title: 'mcp__kepcup_ab__remember' }, 'kepcup_ab'),
    ).toBeNull();
  });

  it('Codex: prompt-prefix, process-level config only, read_only → read-only, never full access', async () => {
    const { engine, started, spec, modes } = setup('codex', {
      modes: CODEX_MODES,
      turns: [agentTurn().text('好'), agentTurn().text('好'), agentTurn().text('好')],
    });
    expect((await engine.startRun(spec()).done).status).toBe('completed');
    const observed = started[0]!.observed;
    expect(observed.sessions[0]!.meta).toBeNull();
    expect(observed.prompts[0]!.text).toContain('SESSION-PROMPT');
    expect(observed.prompts[0]!.text.indexOf('SESSION-PROMPT')).toBeLessThan(
      observed.prompts[0]!.text.indexOf('TRIGGER'),
    );
    // P3: ask stays read-only (every write asks the host); workspace → workspace-write.
    await engine.startRun(spec({ permission: 'ask' })).done;
    await engine.startRun(spec({ permission: 'workspace' })).done;
    expect(modes()).toEqual(['read-only', 'read-only', 'workspace-write']);
    expect(modes()).not.toContain('agent-full-access');

    const launch = codexProvider.launch({
      entry: CODEX,
      target: { command: 'codex-acp', args: [], env: {} },
      platform: 'linux',
    });
    expect(JSON.parse(launch.env.CODEX_CONFIG!)).toEqual(CODEX_PROCESS_CONFIG);
    expect(launch.env.INITIAL_AGENT_MODE).toBe('read-only');
    expect(codexProvider.agentSideConfigFiles).toEqual(['AGENTS.md', '.codex/']);
  });

  it('review M4: set_mode keeps the `mode` config expectation in step (no false revert)', async () => {
    const modeOption = (value: string) => ({
      id: 'mode',
      name: 'Mode',
      category: 'mode' as const,
      type: 'select' as const,
      currentValue: value,
      options: [
        { value: 'read-only', name: 'Read-only' },
        { value: 'workspace-write', name: 'Workspace' },
        { value: 'agent', name: 'Auto' },
      ],
    });
    const { engine, started, spec, modes } = setup('codex', {
      modes: CODEX_MODES,
      configOptions: [modeOption('agent')],
      turns: [
        agentTurn()
          // The agent echoes the preset through its config option too.
          .configUpdate([modeOption('workspace-write')])
          .sleep(50)
          // …and later moves itself to auto review: switched back.
          .configUpdate([modeOption('agent')])
          .sleep(50)
          .text('好'),
      ],
    });
    expect((await engine.startRun(spec({ permission: 'workspace' })).done).status).toBe('completed');
    expect(modes()).toEqual(['workspace-write']);
    expect(started[0]!.observed.configSets).toEqual([
      { sessionId: 'fake-session-1', configId: 'mode', value: 'workspace-write' },
    ]);
  });

  it('Codex: falls back to the mode config option; auth_required at session/new', async () => {
    const viaOption = setup('codex', {
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'read-only', name: 'Read-only' },
            { value: 'workspace-write', name: 'Workspace' },
          ],
        },
      ],
      turns: [agentTurn().text('好')],
    });
    expect((await viaOption.engine.startRun(viaOption.spec()).done).status).toBe('completed');
    expect(viaOption.started[0]!.observed.configSets).toEqual([
      { sessionId: 'fake-session-1', configId: 'mode', value: 'read-only' },
    ]);

    const unauthenticated = setup('codex', { requireAuth: true, modes: CODEX_MODES, turns: [] });
    const outcome = await unauthenticated.engine.startRun(unauthenticated.spec()).done;
    expect(outcome.error?.code).toBe('AGENT_AUTH_REQUIRED');
    expect(
      codexProvider.bridgeToolFromCall!(
        {
          title: 'mcp.kepcup_ab.remember',
          rawInput: { server: 'kepcup_ab', tool: 'remember', arguments: {} },
        },
        'kepcup_ab',
      ),
    ).toBe('remember');
    expect(
      codexProvider.bridgeToolFromCall!(
        {
          title: 'mcp.kepcup.remember',
          rawInput: { server: 'kepcup', tool: 'remember', arguments: {} },
        },
        'kepcup_ab',
      ),
    ).toBeNull();
    expect(
      codexProvider.bridgeToolFromCall!(
        { title: 'mcp__kepcup_ab__x', rawInput: { command: 'ls' } },
        'kepcup_ab',
      ),
    ).toBeNull();
  });
});
