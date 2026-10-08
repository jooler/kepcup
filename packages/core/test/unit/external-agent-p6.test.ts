import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentModelRef, type AgentCatalogEntry } from '@kepcup/shared';
import {
  agentTurn,
  fakeAgentEntry,
  fakeAgentSpawner,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
} from '@kepcup/testkit';
import { ExternalAgentEngine } from '../../src/agent/external/engine.js';
import { AgentHost } from '../../src/agent/external/host.js';
import type { AgentPermissionHandler } from '../../src/agent/external/permission-bridge.js';
import { completeStructured } from '../../src/agent/structured.js';
import type { CompletionRequest, RunSpec } from '../../src/agent/types.js';

/**
 * D72 P6：外部智能体的 `complete()`（一次性精简会话）与后台精简会话
 * （`external.background`）、`completeStructured` 的「只输出 JSON」约定。
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

describe('ExternalAgentEngine.complete() / background sessions (P6)', () => {
  const dirs: string[] = [];
  const hosts: AgentHost[] = [];
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(
    script: FakeAgentScript,
    options: { entry?: AgentCatalogEntry; permissions?: AgentPermissionHandler } = {},
  ) {
    const entry = options.entry ?? fakeAgentEntry('fake-bg');
    const workspace = mkdtempSync(path.join(tmpdir(), 'kepcup-p6-ws-'));
    dirs.push(workspace);
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
      ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
    });
    const request = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
      identity: { runId: 'run_bg', botId: 'bot_1', conversationId: 'conv_1', loopType: 'triage' },
      model: agentModelRef(entry.id, ''),
      systemPrompt: 'SYSTEM-RULES',
      messages: [{ role: 'user', content: 'INPUT-MESSAGE', timestamp: 0 }],
      ...overrides,
    });
    return { engine, started, request, entry, workspace };
  }

  it('one-shot session: temp private cwd (removed), system prompt + input, closed afterwards, never reused', async () => {
    const { engine, started, request, workspace } = setup({
      sessionClose: true,
      turns: [agentTurn().text('{"ok":true}'), agentTurn().text('{"ok":false}')],
    });
    const first = await engine.complete(request());
    expect(first).toMatchObject({ text: '{"ok":true}', toolCalls: [], stopReason: 'stop' });
    const second = await engine.complete(request());
    expect(second.text).toBe('{"ok":false}');

    const observed = started[0]!.observed;
    // Two calls → two fresh sessions, both closed; no MCP bridge.
    expect(observed.sessions).toHaveLength(2);
    await vi.waitFor(() =>
      expect(observed.closedSessions).toEqual(
        observed.sessions.map((session) => session.sessionId),
      ),
    );
    for (const session of observed.sessions) {
      expect(session.mcpServers).toEqual([]);
      expect(session.cwd).not.toBe(workspace);
      expect(path.basename(session.cwd)).toMatch(/^kepcup-agent-bg-/);
      expect(existsSync(session.cwd)).toBe(false);
    }
    expect(observed.sessions[0]!.cwd).not.toBe(observed.sessions[1]!.cwd);
    // prompt-prefix agent: the task's system prompt leads the prompt text.
    expect(observed.prompts[0]!.text).toMatch(/^SYSTEM-RULES\n\nINPUT-MESSAGE$/);
  });

  it('usage: summed when reported, a zero entry when the agent reports none', async () => {
    const { engine, request } = setup({
      turns: [
        agentTurn().text('a').usage({ inputTokens: 120, outputTokens: 30, totalTokens: 150 }),
        agentTurn().text('b'),
      ],
    });
    expect((await engine.complete(request())).usage).toEqual({
      input: 120,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
    });
    // No report → still a (zero) usage entry: the ledger row counts the round.
    expect((await engine.complete(request())).usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
    });
  });

  it('Claude: replacing system prompt string, tools: [], settingSources: [], read_only', async () => {
    const entry = fakeAgentEntry('fake-claude-bg', { provider: 'claude' });
    const { engine, started, request } = setup(
      { modes: CLAUDE_MODES, turns: [agentTurn().text('{}')] },
      { entry },
    );
    await engine.complete(request());
    const observed = started[0]!.observed;
    const meta = observed.sessions[0]!.meta as {
      systemPrompt: unknown;
      claudeCode: { options: Record<string, unknown> };
    };
    expect(meta.systemPrompt).toBe('SYSTEM-RULES');
    expect(meta.claudeCode.options).toMatchObject({
      tools: [],
      settingSources: [],
      allowDangerouslySkipPermissions: false,
      disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
    });
    // meta-append: the system prompt is not repeated in the prompt text.
    expect(observed.prompts[0]!.text).toBe('INPUT-MESSAGE');
  });

  it('failures reject with the engine code; an aborted signal cancels the session', async () => {
    const auth = setup({ requireAuth: true, turns: [] });
    await expect(auth.engine.complete(auth.request())).rejects.toMatchObject({
      code: 'AGENT_AUTH_REQUIRED',
    });
    const unknown = setup({ turns: [] });
    await expect(
      unknown.engine.complete(unknown.request({ model: agentModelRef('nope', '') })),
    ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' });
    await expect(
      unknown.engine.complete(unknown.request({ model: 'custom:mock/mock-light' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const slow = setup({ turns: [agentTurn().text('半句').waitCancel().end('cancelled')] });
    const controller = new AbortController();
    const pending = slow.engine.complete(slow.request({ signal: controller.signal }));
    await vi.waitFor(() => expect(slow.started[0]?.observed.prompts.length).toBe(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(slow.started[0]!.observed.cancels).toHaveLength(1);
  });

  it('background runs never reach the permission bridge: bridge-less native requests are rejected', async () => {
    const decide = vi.fn();
    const permissions: AgentPermissionHandler = {
      decide,
      isolationFor: () => ({ dataHome: '/x', denyRead: [], allowRead: [], denyWrite: [] }),
      audit: () => {},
    };
    const { engine, started, entry, workspace } = setup(
      {
        turns: [
          agentTurn()
            .permission('t1', 'Write /etc/passwd', { kind: 'edit', locations: ['/etc/passwd'] })
            .text('done'),
        ],
      },
      { permissions },
    );
    const spec: RunSpec = {
      identity: {
        runId: 'run_w',
        botId: 'bot_1',
        conversationId: null,
        loopType: 'wiki_maintenance',
      },
      model: agentModelRef(entry.id, ''),
      buildSystemPrompt: async () => 'MAINTAIN',
      messages: [{ role: 'user', content: 'TASK', timestamp: 0 }],
      tools: [],
      limits: { maxTurns: 10 },
      workdir: workspace,
      external: {
        agentId: entry.id,
        // Background sessions are always read_only, whatever is asked.
        permission: 'workspace',
        capabilities: [],
        sessionKey: 'bg:run_w',
        session: { reuseId: null, fingerprint: 'f' },
        background: true,
      },
    };
    const outcome = await engine.startRun(spec).done;
    expect(outcome).toMatchObject({ status: 'completed', finalText: 'done' });
    expect(decide).not.toHaveBeenCalled();
    const observed = started[0]!.observed;
    expect(observed.permissions).toEqual([
      { toolCallId: 't1', outcome: expect.objectContaining({ outcome: 'selected' }) },
    ]);
    expect(JSON.stringify(observed.permissions[0]!.outcome)).toContain('reject');
    expect(observed.sessions[0]!.cwd).not.toBe(workspace);
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
