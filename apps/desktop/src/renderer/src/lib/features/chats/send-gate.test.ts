import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_RUNTIME, type AgentView } from '@kepcup/shared';
import { sendGateRequirement } from './send-gate';

/** 发送门禁（18-inline-setup「发送门禁」+ D72 P4 Agent 设置卡）：拦下即草稿保留、卡片出现。 */

function bot(
  runtime: { model?: string; agentId?: string },
  setupState: 'interviewing' | null = null,
) {
  return {
    setupState,
    profile: {
      runtime: {
        model: runtime.model ?? '',
        agent: { ...BUILTIN_AGENT_RUNTIME, id: runtime.agentId ?? '' },
      },
    },
  } as never;
}

function settings(
  overrides: {
    defaultMainModel?: string;
    experimental?: boolean;
    enabled?: Record<string, boolean>;
  } = {},
) {
  return {
    defaultMainModel: overrides.defaultMainModel ?? '',
    experimental: { externalAgents: overrides.experimental ?? true },
    agents: Object.fromEntries(
      Object.entries(overrides.enabled ?? {}).map(([id, enabled]) => [
        id,
        { enabled, source: 'managed' as const, loadUserConfig: false },
      ]),
    ),
  };
}

function agents(views: Record<string, Pick<AgentView, 'enabled' | 'status'>>, loaded = true) {
  return { loaded, get: (id: string) => views[id] ?? null };
}

describe('sendGateRequirement', () => {
  it('built-in bots: gate only when neither the bot nor the app has a main model', () => {
    const base = { conversationType: 'direct', agents: agents({}) };
    expect(sendGateRequirement({ ...base, bot: bot({}), settings: settings() })).toEqual({
      kind: 'main-model',
    });
    expect(
      sendGateRequirement({ ...base, bot: bot({ model: 'a/b' }), settings: settings() }),
    ).toBeNull();
    expect(
      sendGateRequirement({
        ...base,
        bot: bot({}),
        settings: settings({ defaultMainModel: 'a/b' }),
      }),
    ).toBeNull();
    // Unloaded settings / group chats pass through (core falls back).
    expect(sendGateRequirement({ ...base, bot: bot({}), settings: null })).toBeNull();
    expect(
      sendGateRequirement({
        ...base,
        conversationType: 'group',
        bot: bot({}),
        settings: settings(),
      }),
    ).toBeNull();
  });

  it('agent bots are gated by the agent state, never by the built-in model', () => {
    const agentBot = bot({ agentId: 'codex-acp' });
    const gate = (views: Parameters<typeof agents>[0], s = settings(), loaded = true) =>
      sendGateRequirement({
        conversationType: 'direct',
        bot: agentBot,
        settings: s,
        agents: agents(views, loaded),
      });
    expect(gate({ 'codex-acp': { enabled: true, status: 'ready' } })).toBeNull();
    expect(gate({}, settings({ experimental: false }))).toEqual({
      kind: 'agent',
      agentId: 'codex-acp',
      reason: 'experimental_off',
    });
    expect(gate({ 'codex-acp': { enabled: false, status: 'available' } })).toMatchObject({
      reason: 'not_enabled',
    });
    expect(gate({ 'codex-acp': { enabled: true, status: 'needs_auth' } })).toMatchObject({
      reason: 'auth_required',
    });
    expect(gate({ 'codex-acp': { enabled: true, status: 'installing' } })).toMatchObject({
      reason: 'not_installed',
    });
    // Views not loaded yet: only the settings switch is known.
    expect(gate({}, settings({ enabled: { 'codex-acp': false } }), false)).toMatchObject({
      reason: 'not_enabled',
    });
    expect(gate({}, settings({ enabled: { 'codex-acp': true } }), false)).toBeNull();
    // Unknown agent (not in the catalog any more): core reports it.
    expect(gate({})).toBeNull();
  });

  it('the setup interview always runs on the built-in engine', () => {
    expect(
      sendGateRequirement({
        conversationType: 'direct',
        bot: bot({ agentId: 'codex-acp' }, 'interviewing'),
        settings: settings(),
        agents: agents({}),
      }),
    ).toEqual({ kind: 'main-model' });
  });
});
