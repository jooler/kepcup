import { describe, expect, it } from 'vitest';
import {
  AGENT_CATALOG,
  agentCatalogEntrySchema,
  agentModelRef,
  agentSetupReasonForError,
  agentSetupReasonOf,
  botRuntimeSchema,
  capabilityOfTool,
  defaultCapabilities,
  filterReleasedAgents,
  HOST_CAPABILITIES,
  hostCapabilityIdSchema,
  NEVER_INJECTED_TOOLS,
  parseAgentModelRef,
  resolveCapabilities,
  runSchema,
  settingsSchema,
  type AgentCatalogEntry,
} from '../../src/index.js';

/** D72 描述层：目录条目、能力包登记表与默认值（纯函数）。 */

describe('host capability packs', () => {
  it('registers every capability id exactly once, core first and required', () => {
    const ids = HOST_CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...hostCapabilityIdSchema.options].sort());
    expect(HOST_CAPABILITIES[0]).toMatchObject({
      id: 'core',
      default: 'required',
      category: 'host',
    });
  });

  it('classifies packs as host semantics vs supplements (design 28 §4.1)', () => {
    const category = Object.fromEntries(HOST_CAPABILITIES.map((c) => [c.id, c.category]));
    for (const id of [
      'core',
      'memory',
      'wiki',
      'schedule',
      'collaboration',
      'skills',
      'host_ops',
    ]) {
      expect(category[id]).toBe('host');
    }
    for (const id of [
      'browser',
      'web',
      'image_generation',
      'image_understanding',
      'speech',
      'transcription',
      'video',
      'mcp',
    ]) {
      expect(category[id]).toBe('supplement');
    }
    // Only supplements overlap with agent-native abilities.
    for (const capability of HOST_CAPABILITIES) {
      if (capability.category === 'host') expect(capability.overlapsNative).toBeNull();
    }
  });

  it('never lists a never-injected tool in any pack', () => {
    const packed = HOST_CAPABILITIES.flatMap((c) => [...c.tools, ...c.butlerTools]);
    for (const tool of NEVER_INJECTED_TOOLS) expect(packed).not.toContain(tool);
    expect(new Set(packed).size).toBe(packed.length);
  });

  it('defaults to every pack when the agent declares no native abilities', () => {
    expect(defaultCapabilities({ nativeCapabilities: {} })).toEqual(
      HOST_CAPABILITIES.map((capability) => capability.id),
    );
  });

  it('drops supplements the agent covers natively, keeping required and host packs', () => {
    const defaults = defaultCapabilities({
      nativeCapabilities: {
        web: ['WebSearch', 'WebFetch'],
        vision: ['Read'],
        image_generation: [],
      },
    });
    expect(defaults).not.toContain('web');
    expect(defaults).not.toContain('image_understanding');
    // An empty tool list does not count as a native ability.
    expect(defaults).toContain('image_generation');
    expect(defaults).toContain('core');
    expect(defaults).toContain('memory');
    expect(defaults).toContain('mcp');
  });
});

describe('capability resolution (P2)', () => {
  it('maps tools to their pack (exact names, prefixes, butler tools)', () => {
    expect(capabilityOfTool('send_message')?.id).toBe('core');
    expect(capabilityOfTool('browser_click')?.id).toBe('browser');
    expect(capabilityOfTool('mcp_srv1_lookup')?.id).toBe('mcp');
    expect(capabilityOfTool('propose_team')?.id).toBe('collaboration');
    expect(capabilityOfTool('save_profile')).toBeNull();
    expect(capabilityOfTool('bash')).toBeNull();
  });

  it('uses defaults for null, always keeps core, forces collaboration for the butler', () => {
    const claude = { nativeCapabilities: { web: ['WebSearch'] } };
    expect(resolveCapabilities(null, claude)).toEqual(defaultCapabilities(claude));
    expect(resolveCapabilities(['memory', 'bogus'], claude)).toEqual(['core', 'memory']);
    expect(resolveCapabilities([], claude, { isButler: true })).toEqual(['core', 'collaboration']);
    // Opting into a natively covered supplement pack is allowed.
    expect(resolveCapabilities(['web'], claude)).toEqual(['core', 'web']);
  });
});

describe('agent catalog', () => {
  it('ships only schema-valid entries: the testkit fake, Claude Agent, Codex (P2) and the P5 agents', () => {
    for (const entry of AGENT_CATALOG) {
      expect(agentCatalogEntrySchema.safeParse(entry).success).toBe(true);
    }
    expect(AGENT_CATALOG.map((entry) => entry.id)).toEqual([
      'fake',
      'claude-acp',
      'codex-acp',
      'opencode',
      'dsh',
      'cursor',
      'antigravity-acp',
    ]);
    expect(AGENT_CATALOG[0]).toMatchObject({ provider: 'generic-acp', releaseGate: 'testkit' });
    expect(AGENT_CATALOG[1]).toMatchObject({
      provider: 'claude',
      releaseGate: 'claude',
      distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.86.0' } },
      nativeCapabilities: { web: ['WebSearch', 'WebFetch'], vision: ['Read'] },
    });
    expect(AGENT_CATALOG[2]).toMatchObject({
      provider: 'codex',
      releaseGate: 'codex',
      distribution: { npx: { package: '@agentclientprotocol/codex-acp@2.1.1' } },
      nativeCapabilities: { web: ['web_search'] },
    });
  });

  it('P5 agents: own providers and release gates, pinned binaries, preview tiers, terms keys', () => {
    const byId = (id: string) => AGENT_CATALOG.find((entry) => entry.id === id)!;
    const expected: Array<[string, string, string, 'supported' | 'preview', string]> = [
      ['opencode', 'opencode', 'opencode', 'supported', 'agents.terms.opencode'],
      ['dsh', 'dsh', 'dsh', 'preview', 'agents.terms.dsh'],
      ['cursor', 'cursor', 'cursor', 'supported', 'agents.terms.cursor'],
      ['antigravity-acp', 'antigravity', 'antigravity', 'preview', 'agents.terms.antigravity'],
    ];
    for (const [id, provider, gate, tier, noticeKey] of expected) {
      expect(byId(id), id).toMatchObject({
        provider,
        releaseGate: gate,
        tier,
        terms: { noticeKey },
        transport: 'acp',
      });
      expect(byId(id).sizeBytes, id).toBeGreaterThan(0);
    }
    // Binary agents: all six platforms, each archive pinned by sha256.
    for (const id of ['opencode', 'cursor', 'antigravity-acp']) {
      const binary = byId(id).distribution.binary!;
      expect(Object.keys(binary).sort(), id).toEqual([
        'darwin-aarch64',
        'darwin-x86_64',
        'linux-aarch64',
        'linux-x86_64',
        'windows-aarch64',
        'windows-x86_64',
      ]);
      for (const target of Object.values(binary)) expect(target.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(byId('dsh').distribution.npx).toEqual({
      package: '@deepseek-ai/dsh@0.2.0-rc.2',
      args: ['--profile', 'acp'],
    });
    expect(byId('dsh').auth).toMatchObject({ kinds: ['api-key'], apiKeyEnv: 'DEEPSEEK_API_KEY' });
    expect(byId('opencode').auth.kinds).toContain('anonymous');
    expect(byId('cursor').auth).toMatchObject({ apiKeyEnv: 'CURSOR_API_KEY' });
    expect(byId('antigravity-acp').auth).toMatchObject({
      kinds: ['api-key'],
      apiKeyEnv: 'GEMINI_API_KEY',
    });
  });

  it('round-trips the agent pseudo model ref', () => {
    expect(agentModelRef('fake', '')).toBe('agent:fake/default');
    expect(agentModelRef('codex', 'gpt-5')).toBe('agent:codex/gpt-5');
    expect(parseAgentModelRef('agent:fake/default')).toEqual({ agentId: 'fake', model: '' });
    expect(parseAgentModelRef('agent:codex/gpt-5/mini')).toEqual({
      agentId: 'codex',
      model: 'gpt-5/mini',
    });
    expect(parseAgentModelRef('custom:mock/mock-main')).toBeNull();
    expect(parseAgentModelRef('agent:/x')).toBeNull();
  });

  it('filters entries whose release gate is not approved (release builds only)', () => {
    const entries = [
      { ...AGENT_CATALOG[0]!, id: 'open', releaseGate: undefined },
      { ...AGENT_CATALOG[0]!, id: 'claude', releaseGate: 'claude' },
      { ...AGENT_CATALOG[0]!, id: 'fake', releaseGate: 'testkit' },
    ] as AgentCatalogEntry[];
    expect(filterReleasedAgents(entries, null).map((e) => e.id)).toEqual([
      'open',
      'claude',
      'fake',
    ]);
    // Fail-closed: an entry without a gate is not shipped either.
    expect(filterReleasedAgents(entries, []).map((e) => e.id)).toEqual([]);
    expect(filterReleasedAgents(entries, ['claude']).map((e) => e.id)).toEqual(['claude']);
  });

  it('every curated entry declares its release gate', () => {
    for (const entry of AGENT_CATALOG) expect(entry.releaseGate, entry.id).toBeTruthy();
  });
});

describe('profile and settings defaults', () => {
  it('bot runtime defaults to the built-in engine', () => {
    expect(botRuntimeSchema.parse({}).agent).toEqual({
      id: '',
      model: '',
      effort: '',
      permission: 'workspace',
      capabilities: null,
    });
  });

  it('settings default to no agents and the experimental switch off', () => {
    const settings = settingsSchema.parse({});
    expect(settings.agents).toEqual({});
    expect(settings.customAgents).toEqual([]);
    expect(settings.experimental).toEqual({ externalAgents: false });
    expect(settings.backgroundAgentId).toBeUndefined();
    expect(settingsSchema.parse({ agents: { fake: { enabled: true } } }).agents.fake).toEqual({
      enabled: true,
      source: 'managed',
      loadUserConfig: false,
    });
  });

  it('tolerates unknown / damaged stored agent values instead of failing settings', () => {
    const settings = settingsSchema.parse({
      agents: { a: { enabled: true, source: 'brew' }, b: 'garbage' },
      customAgents: [{ id: 42 }],
      experimental: { externalAgents: 'yes' },
      backgroundAgentId: 7,
    });
    expect(settings.agents.a).toEqual({ enabled: true, source: 'managed', loadUserConfig: false });
    expect(settings.agents.b).toEqual({ enabled: false, source: 'managed', loadUserConfig: false });
    expect(settings.customAgents).toEqual([{ id: 42 }]);
    expect(settings.experimental.externalAgents).toBe(false);
    expect(settings.backgroundAgentId).toBeUndefined();
    expect(
      botRuntimeSchema.parse({ agent: { id: 'fake', permission: 'yolo', capabilities: 'all' } })
        .agent,
    ).toEqual({ id: 'fake', model: '', effort: '', permission: 'workspace', capabilities: null });
  });
});

describe('agent setup requirement (P4-B, D58)', () => {
  it('maps the local status view to a setup reason (null = may run)', () => {
    expect(agentSetupReasonOf({ enabled: true, status: 'ready' }, false)).toBe('experimental_off');
    expect(agentSetupReasonOf(null, true)).toBeNull();
    expect(agentSetupReasonOf({ enabled: false, status: 'available' }, true)).toBe('not_enabled');
    expect(agentSetupReasonOf({ enabled: true, status: 'installing' }, true)).toBe('not_installed');
    expect(agentSetupReasonOf({ enabled: true, status: 'error' }, true)).toBe('not_installed');
    expect(agentSetupReasonOf({ enabled: true, status: 'needs_auth' }, true)).toBe('auth_required');
    expect(agentSetupReasonOf({ enabled: true, status: 'incompatible' }, true)).toBe(
      'incompatible',
    );
    expect(agentSetupReasonOf({ enabled: true, status: 'ready' }, true)).toBeNull();
    expect(agentSetupReasonOf({ enabled: true, status: 'update_available' }, true)).toBeNull();
  });

  it('maps run failure codes to a setup reason; other failures stay plain', () => {
    expect(agentSetupReasonForError('AGENT_AUTH_REQUIRED', null)).toBe('auth_required');
    expect(agentSetupReasonForError('AGENT_INCOMPATIBLE', null)).toBe('incompatible');
    expect(agentSetupReasonForError('AGENT_UNAVAILABLE', 'not_installed')).toBe('not_installed');
    expect(agentSetupReasonForError('AGENT_UNAVAILABLE', null)).toBe('unavailable');
    expect(agentSetupReasonForError('AGENT_FAILED', null)).toBeNull();
    expect(agentSetupReasonForError('AGENT_PROCESS_EXITED', null)).toBeNull();
    expect(agentSetupReasonForError(undefined, null)).toBeNull();
  });

  it('run.setup accepts the agent kind; settings.defaultAgentId defaults to empty', () => {
    const base = runSchema.shape.setup;
    expect(base.parse({ kind: 'agent', agentId: 'codex-acp', reason: 'auth_required' })).toEqual({
      kind: 'agent',
      agentId: 'codex-acp',
      reason: 'auth_required',
    });
    expect(base.safeParse({ kind: 'agent', agentId: 'x', reason: 'nope' }).success).toBe(false);
    expect(settingsSchema.parse({}).defaultAgentId).toBe('');
  });
});
