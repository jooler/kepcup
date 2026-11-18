import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentModelRef } from '@kepcup/shared';
import {
  agentTurn,
  fakeAgentEntry,
  fakeAgentSpawner,
  type FakeAcpAgentHandle,
} from '@kepcup/testkit';
import { ExternalAgentEngine } from '../../src/agent/external/engine.js';
import { AgentHost } from '../../src/agent/external/host.js';
import type { AgentPermissionHandler } from '../../src/agent/external/permission-bridge.js';
import { completeStructured } from '../../src/agent/structured.js';
import type { CompletionRequest } from '../../src/agent/types.js';

/**
 * D72：`completeStructured` 的「只输出 JSON」约定（外部 Agent 与内置引擎两条
 * 路径）。后台任务与一次性 `complete()` 已随「后台收归内置」移除（2026-11
 * 修订）——外部引擎的 `complete()` 恒拒绝，不再有后台精简会话。
 */

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

const CLAUDE_MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'acceptEdits', name: 'Accept Edits' },
    { id: 'plan', name: 'Plan' },
  ],
};


describe('Claude sessions: who auto-allows sandboxed Bash (review P0, D73 × f2b9627)', () => {
  const dirs: string[] = [];
  const hosts: AgentHost[] = [];
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function sandboxFor(hostGates: boolean | undefined) {
    const entry = fakeAgentEntry('fake-claude-gate', { provider: 'claude' });
    const workspace = mkdtempSync(path.join(tmpdir(), 'kepcup-gate-ws-'));
    dirs.push(workspace);
    const started: FakeAcpAgentHandle[] = [];
    const host = new AgentHost({
      logger,
      redact: (text) => text,
      appVersion: '1.0.0',
      resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
      spawn: fakeAgentSpawner(
        { [entry.id]: { modes: CLAUDE_MODES, turns: [agentTurn().text('ok')] } },
        started,
      ) as never,
    });
    hosts.push(host);
    const permissions: AgentPermissionHandler = {
      decide: vi.fn(),
      isolationFor: () => ({ dataHome: '/x', denyRead: [], allowRead: [], denyWrite: [] }),
      ...(hostGates !== undefined ? { hostGatesSandboxedExec: () => hostGates } : {}),
      audit: () => {},
    };
    const engine = new ExternalAgentEngine({ host, catalog: () => [entry], logger, permissions });
    const outcome = await engine.startRun({
      identity: { runId: 'run_gate', botId: 'bot_1', conversationId: 'conv_1', loopType: 'task' },
      model: agentModelRef(entry.id, ''),
      buildSystemPrompt: async () => 'S',
      messages: [{ role: 'user', content: 'go', timestamp: 0 }],
      tools: [],
      limits: { maxTurns: 10 },
      cwd: workspace,
      external: { agentId: entry.id, permission: 'ask', capabilities: [], sessionKey: 'k' },
    }).done;
    expect(outcome.status).toBe('completed');
    const meta = started[0]!.observed.sessions[0]!.meta as {
      claudeCode: { options: { sandbox: Record<string, unknown> } };
    };
    return meta.claudeCode.options.sandbox;
  }

  it('taint control on → session/new turns the SDK auto-allow off (the host bridge decides)', async () => {
    expect(await sandboxFor(true)).toMatchObject({
      autoAllowBashIfSandboxed: false,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
  });

  it('taint control off (or no gate) → the ask tier keeps the SDK auto-allow of f2b9627', async () => {
    expect(await sandboxFor(false)).toMatchObject({ autoAllowBashIfSandboxed: true });
    expect(await sandboxFor(undefined)).toMatchObject({ autoAllowBashIfSandboxed: true });
  });
});

describe('completeStructured with an external agent (JSON only, P6)', () => {
  const schema = z.object({ decision: z.enum(['respond', 'no_action']) });
  const parametersSchema = Type.Object({
    decision: Type.Union([Type.Literal('respond'), Type.Literal('no_action')]),
  });

  it('offers no tool, puts the schema into the system prompt and retries asking for JSON only', async () => {
    const requests: CompletionRequest[] = [];
    const replies = ['我觉得应该回复。', '```json\n{"decision":"respond"}\n```'];
    const result = await completeStructured({
      complete: async (req) => {
        requests.push(req);
        return {
          text: replies.shift()!,
          toolCalls: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
        };
      },
      identity: { runId: 'r', botId: null, conversationId: null, loopType: 'triage' },
      model: agentModelRef('codex-acp', ''),
      systemPrompt: 'TRIAGE',
      messages: [{ role: 'user', content: 'GROUP', timestamp: 0 }],
      parametersSchema,
      schema,
    });
    expect(result).toEqual({ decision: 'respond' });
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req.tools).toBeUndefined();
      expect(req.systemPrompt.startsWith('TRIAGE\n\n<output_format>')).toBe(true);
      expect(req.systemPrompt).toContain('只输出一个 JSON 对象');
      expect(req.systemPrompt).toContain(JSON.stringify(parametersSchema));
    }
    expect(requests[1]!.messages.at(-1)!.content).toContain('只输出 JSON');
    expect(requests[1]!.messages.at(-1)!.content).not.toContain('submit');
  });

  it('retries only when the answer failed to parse, never after a failed call (审查 C3)', async () => {
    let calls = 0;
    await expect(
      completeStructured({
        complete: async () => {
          calls += 1;
          throw Object.assign(new Error('超时'), { code: 'TIMEOUT' });
        },
        identity: { runId: 'r', botId: null, conversationId: null, loopType: 'triage' },
        model: agentModelRef('codex-acp', ''),
        systemPrompt: 'TRIAGE',
        messages: [],
        parametersSchema,
        schema,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls).toBe(1);
  });

  it('a failed external agent call is charged as a zero-token row; built-in failures are not', async () => {
    const charged: unknown[] = [];
    const failing = async (): Promise<never> => {
      throw Object.assign(new Error('超时'), { code: 'TIMEOUT' });
    };
    const base = {
      complete: failing,
      identity: { runId: 'r', botId: 'b', conversationId: 'c', loopType: 'triage' as const },
      systemPrompt: 'TRIAGE',
      messages: [],
      parametersSchema,
      schema,
      onUsage: (usage: unknown) => charged.push(usage),
    };
    await expect(
      completeStructured({ ...base, model: agentModelRef('codex-acp', '') }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(charged).toEqual([{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null }]);

    // The ledger failing too (core shutting down): the call's error still wins.
    await expect(
      completeStructured({
        ...base,
        model: agentModelRef('codex-acp', ''),
        onUsage: () => {
          throw new Error('db closed');
        },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });

    charged.length = 0;
    await expect(
      completeStructured({ ...base, model: 'custom:mock/mock-light' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(charged).toEqual([]);
  });

  it('built-in models keep the submit tool', async () => {
    const seen: CompletionRequest[] = [];
    await completeStructured({
      complete: async (req) => {
        seen.push(req);
        return { text: '', toolCalls: [{ name: 'submit', arguments: { decision: 'no_action' } }] };
      },
      identity: { runId: 'r', botId: null, conversationId: null, loopType: 'triage' },
      model: 'custom:mock/mock-light',
      systemPrompt: 'TRIAGE',
      messages: [],
      parametersSchema,
      schema,
    });
    expect(seen[0]!.tools?.map((tool) => tool.name)).toEqual(['submit']);
    expect(seen[0]!.systemPrompt).toBe('TRIAGE');
  });
});
