import { describe, expect, it } from 'vitest';
import { agentSetupReasonForError, findAgentEntry, AGENT_CATALOG } from '@kepcup/shared';
import { classifierFor, toAgentError } from '../../src/agent/external/errors.js';
import {
  claudeProvider,
  isClaudeSandboxUnavailable,
} from '../../src/agent/external/providers/claude.js';
import { agentRunGate } from '../../src/agent/external/catalog.js';
import { settingsSchema } from '@kepcup/shared';

/**
 * P4-B 结构化 setup 的错误映射（D58 + D72）：Claude 沙箱起不来
 * （failIfUnavailable，Linux 缺 bubblewrap / socat）→ AGENT_SANDBOX_UNAVAILABLE
 * → `{kind:'agent', reason:'sandbox_unavailable'}`；run 门禁的原因判定。
 */

describe('Claude sandbox-unavailable classification', () => {
  it('only a message naming the sandbox and a concrete dependency counts (review #10)', () => {
    expect(
      isClaudeSandboxUnavailable({
        code: -32603,
        message: 'Sandbox dependencies: bubblewrap (bwrap) not installed',
      }),
    ).toBe(true);
    expect(
      isClaudeSandboxUnavailable({ code: -32603, message: 'sandbox: socat not installed' }),
    ).toBe(true);
    expect(
      isClaudeSandboxUnavailable({ code: -32603, message: 'sandbox-exec is not available' }),
    ).toBe(true);
    // Without naming the sandbox, or without a dependency name, or only in
    // `data`: an ordinary failure.
    expect(isClaudeSandboxUnavailable({ code: -32603, message: 'socat not installed' })).toBe(
      false,
    );
    expect(
      isClaudeSandboxUnavailable({ code: -32603, message: 'sandbox dependencies missing' }),
    ).toBe(false);
    expect(
      isClaudeSandboxUnavailable({
        code: -32603,
        message: 'Internal error',
        data: { details: 'Sandbox unavailable: bubblewrap not installed' },
      }),
    ).toBe(false);
    expect(isClaudeSandboxUnavailable({ code: -32603, message: 'rate limited' })).toBe(false);
  });

  it('maps through the provider classifier to a sandbox setup reason (auth still wins)', () => {
    const classify = classifierFor(claudeProvider);
    const sandbox = toAgentError(
      Object.assign(new Error('Sandbox unavailable: bubblewrap (bwrap) not installed'), {
        code: -32603,
      }),
      'Claude Agent',
      classify,
      'prompt',
    );
    expect(sandbox.code).toBe('AGENT_SANDBOX_UNAVAILABLE');
    expect(sandbox.message).toContain('沙箱无法启动');
    expect(agentSetupReasonForError(sandbox.code, null)).toBe('sandbox_unavailable');
    const auth = toAgentError(
      Object.assign(new Error('Authentication required'), { code: -32000 }),
      'Claude Agent',
      classify,
      'prompt',
    );
    expect(agentSetupReasonForError(auth.code, null)).toBe('auth_required');
    const other = toAgentError(new Error('boom'), 'Claude Agent', classify, 'prompt');
    expect(agentSetupReasonForError(other.code, null)).toBeNull();
  });
});

describe('agentRunGate', () => {
  const entry = findAgentEntry(AGENT_CATALOG, 'fake')!;
  const settings = (patch: Record<string, unknown>) => settingsSchema.parse(patch);

  it('experimental off / not in catalog / not enabled / state-derived reasons', () => {
    expect(agentRunGate(settings({}), [entry], 'fake')?.reason).toBe('experimental_off');
    const on = settings({ experimental: { externalAgents: true } });
    expect(agentRunGate(on, [entry], 'missing')).toMatchObject({ reason: null });
    expect(agentRunGate(on, [entry], 'fake')?.reason).toBe('not_enabled');
    const enabled = settings({
      experimental: { externalAgents: true },
      agents: { fake: { enabled: true } },
    });
    expect(agentRunGate(enabled, [entry], 'fake')).toBeNull();
    const view = (status: 'needs_auth' | 'incompatible' | 'error' | 'ready') => () => ({
      enabled: true,
      status,
      statusDetail: status === 'incompatible' ? '协议不兼容' : null,
    });
    expect(agentRunGate(enabled, [entry], 'fake', view('needs_auth'))?.reason).toBe(
      'auth_required',
    );
    expect(agentRunGate(enabled, [entry], 'fake', view('incompatible'))).toMatchObject({
      reason: 'incompatible',
      message: expect.stringContaining('协议不兼容'),
    });
    expect(agentRunGate(enabled, [entry], 'fake', view('error'))?.reason).toBe('not_installed');
    expect(agentRunGate(enabled, [entry], 'fake', view('ready'))).toBeNull();
  });
});

describe('agent_tool targetUncertain (schema field, unattended floor)', () => {
  it('is part of the shared payload schema and read through it by the floor', async () => {
    const { agentToolApprovalPayloadSchema } = await import('@kepcup/shared');
    const { agentToolUnattendedRefusal } = await import('../../src/permissions/approvals.js');
    const payload = agentToolApprovalPayloadSchema.parse({
      agentId: 'codex-acp',
      kind: 'write',
      locations: ['/p/a'],
      targetUncertain: true,
    });
    expect(payload.targetUncertain).toBe(true);
    expect(agentToolUnattendedRefusal(payload)).toBe(true);
    expect(agentToolUnattendedRefusal({ ...payload, targetUncertain: false })).toBe(false);
    // A payload the schema rejects is refused (fail closed).
    expect(
      agentToolUnattendedRefusal({ kind: 'write', locations: ['/p/a'], targetUncertain: 'yes' }),
    ).toBe(true);
    expect(agentToolUnattendedRefusal({ kind: 'bogus', locations: ['/p/a'] })).toBe(true);
  });
});
