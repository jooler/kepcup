import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CATALOG, agentModelRef } from '@kepcup/shared';
import {
  agentTurn,
  fakeAgentSpawner,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
} from '@kepcup/testkit';
import { ExternalAgentEngine } from '../../src/agent/external/engine.js';
import { AgentHost } from '../../src/agent/external/host.js';
import { isSessionNotFound } from '../../src/agent/external/acp/client.js';
import { limitAgentLines } from '../../src/agent/external/acp/line-limit.js';
import type { EngineEvent, RunSpec } from '../../src/agent/types.js';

/**
 * 连接加固（D118，todo/acp-hardening-and-new-targets.md §1）：stdout 单行字节
 * 上限、turn 停滞看门狗（等待权限不算停滞）、无输出崩溃 / 会话丢失的一次透明
 * 重试、`isSessionNotFound` 的判定面。
 */

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const FAKE = AGENT_CATALOG.find((entry) => entry.id === 'fake')!;

const dirs: string[] = [];
const hosts: AgentHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  scripts: FakeAgentScript | FakeAgentScript[],
  options: {
    turnStallMs?: number;
    cancelGraceMs?: number;
    permissions?: ConstructorParameters<typeof ExternalAgentEngine>[0]['permissions'];
    specOverrides?: (spec: RunSpec) => RunSpec;
  } = {},
) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'kepcup-d118-'));
  dirs.push(cwd);
  const started: FakeAcpAgentHandle[] = [];
  const host = new AgentHost({
    logger,
    redact: (text) => text,
    appVersion: '1.0.0',
    resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
    spawn: fakeAgentSpawner({ [FAKE.id]: scripts }, started) as never,
  });
  hosts.push(host);
  const engine = new ExternalAgentEngine({
    host,
    catalog: () => [FAKE],
    logger,
    ...(options.turnStallMs !== undefined ? { turnStallMs: options.turnStallMs } : {}),
    cancelGraceMs: options.cancelGraceMs ?? 200,
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
  });
  const spec = (): RunSpec => {
    const base: RunSpec = {
      identity: { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' },
      model: agentModelRef(FAKE.id, ''),
      buildSystemPrompt: async () => 'SYSTEM',
      messages: [{ role: 'user', content: 'HELLO', timestamp: 0 }],
      tools: [],
      limits: { maxTurns: 60 },
      cwd,
      external: { agentId: FAKE.id, permission: 'read_only', capabilities: [], sessionKey: 'k' },
    };
    return options.specOverrides !== undefined ? options.specOverrides(base) : base;
  };
  return { engine, host, started, spec, cwd };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('isSessionNotFound', () => {
  it('matches the protocol -32002, a provider hook, and nothing else', () => {
    expect(isSessionNotFound({ code: -32002 })).toBe(true);
    expect(isSessionNotFound({ code: -32002, message: 'session not found' })).toBe(true);
    expect(
      isSessionNotFound({ code: -32602 }, {
        sessionNotFound: (error) => (error as { code: number }).code === -32602,
      }),
    ).toBe(true);
    expect(isSessionNotFound({ code: -32602 })).toBe(false);
    expect(isSessionNotFound({ code: -32000 })).toBe(false);
    expect(isSessionNotFound(new Error('boom'))).toBe(false);
    expect(isSessionNotFound(null)).toBe(false);
    // The hook is additive: a refusing hook falls back to the protocol code.
    expect(isSessionNotFound({ code: -32002 }, { sessionNotFound: () => false })).toBe(true);
  });
});

describe('limitAgentLines', () => {
  async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of readable) chunks.push(chunk);
    return chunks;
  }
  const encoder = new TextEncoder();

  it('passes chunks through while lines stay within the limit', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n{"b":'));
        controller.enqueue(encoder.encode('2}\n'));
        controller.close();
      },
    });
    let limited = false;
    const chunks = await collect(limitAgentLines(source, 1000, () => (limited = true)));
    // Chunks pass through verbatim; the count is internal.
    expect(chunks.map((c) => new TextDecoder().decode(c))).toEqual(['{"a":1}\n{"b":', '2}\n']);
    expect(limited).toBe(false);
  });

  it('errors the stream when one line exceeds the limit (across chunks too)', async () => {
    let limited = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('x'.repeat(60)));
        controller.enqueue(encoder.encode('y'.repeat(60)));
        controller.close();
      },
    });
    await expect(collect(limitAgentLines(source, 100, () => (limited = true)))).rejects.toThrow(
      /line exceeded/,
    );
    expect(limited).toBe(true);

    // A newline in a later chunk resets the count: not a single long line.
    let limited2 = false;
    const ok = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('a'.repeat(90)));
        controller.enqueue(encoder.encode('\n' + 'b'.repeat(90)));
        controller.close();
      },
    });
    const chunks = await collect(limitAgentLines(ok, 100, () => (limited2 = true)));
    expect(chunks).toHaveLength(2);
    expect(limited2).toBe(false);
  });
});

describe('turn stall watchdog (D118)', () => {
  it('cancels and fails a silent prompt after the stall budget', async () => {
    const { engine, started, spec } = setup(
      { turns: [agentTurn().text('开始').sleep(60_000)] },
      { turnStallMs: 80 },
    );
    const outcome = await engine.startRun(spec()).done;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('TIMEOUT');
    expect(outcome.error?.message).toContain('分钟没有任何更新');
    expect(started[0]!.observed.cancels).toEqual(['fake-session-1']);
  });

  it('does not fire while updates keep arriving', async () => {
    const { engine, spec } = setup(
      { turns: [agentTurn().text('一').sleep(30).text('二').sleep(30).text('三')] },
      { turnStallMs: 200 },
    );
    const outcome = await engine.startRun(spec()).done;
    expect(outcome).toMatchObject({ status: 'completed', finalText: '一二三' });
  });

  it('a pending permission request is not a stall; the run completes after it', async () => {
    // Discriminating form: the decision alone outlasts the stall budget, and
    // the agent then finishes. Deleting the `pendingPermissions` guard in
    // #onStall would cancel mid-wait and fail this case as TIMEOUT (审查 D118).
    let decideApplied = false;
    const { engine, spec } = setup(
      { turns: [agentTurn().permission('t1', '跑一条命令').text('批完了')] },
      {
        turnStallMs: 80,
        permissions: {
          decide: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                decideApplied = true;
                resolve({
                  response: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
                  decision: 'allowed',
                });
              }, 250);
            }),
          isolationFor: () => undefined,
          audit: () => {},
        } as never,
      },
    );
    const outcome = await engine.startRun(spec()).done;
    expect(decideApplied).toBe(true);
    expect(outcome).toMatchObject({ status: 'completed', finalText: '批完了' });
  });

  it('the watchdog re-arms after a decision and still cancels a silent agent', async () => {
    let decideApplied = false;
    const { engine, spec } = setup(
      {
        turns: [
          agentTurn()
            .permission('t1', '跑一条命令')
            .sleep(60_000),
        ],
      },
      {
        turnStallMs: 80,
        permissions: {
          decide: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                decideApplied = true;
                resolve({
                  response: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
                  decision: 'rejected',
                });
              }, 250);
            }),
          isolationFor: () => undefined,
          audit: () => {},
        } as never,
      },
    );
    const outcome = await engine.startRun(spec()).done;
    expect(decideApplied).toBe(true);
    // The watchdog waited for the permission (~250 ms), then the silent agent
    // hit the budget right after it resolved.
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('TIMEOUT');
  });
});

describe('one transparent retry (D118)', () => {
  it('retries a crash before any output: new process, new session, prompt re-sent', async () => {
    const requests: EngineEvent[] = [];
    const sessions: Array<{ id: string; mode: string }> = [];
    const { engine, started, spec } = setup(
      [{ turns: [agentTurn().crash()] }, { turns: [agentTurn().text('重试成功')] }],
      {
        specOverrides: (base) => ({
          ...base,
          external: {
            ...base.external!,
            onSession: (agentSessionId, mode) => sessions.push({ id: agentSessionId, mode }),
          },
        }),
      },
    );
    const handle = engine.startRun(spec());
    handle.onEvent((event) => {
      if (event.type === 'request') requests.push(event);
    });
    const outcome = await handle.done;
    expect(outcome).toMatchObject({ status: 'completed', finalText: '重试成功' });
    // A fresh process, a fresh session, the same prompt twice. (The fake
    // agent numbers sessions per process: both are `fake-session-1`.)
    expect(started).toHaveLength(2);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((entry) => entry.mode === 'new')).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.payload.prompt).toEqual(requests[1]!.payload.prompt);
  });

  it('does not retry once the agent produced output', async () => {
    const { engine, started, spec } = setup([
      { turns: [agentTurn().text('半截').crash()] },
      { turns: [agentTurn().text('不该跑')] },
    ]);
    const outcome = await engine.startRun(spec()).done;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('AGENT_PROCESS_EXITED');
    expect(started).toHaveLength(1);
  });

  it('retries a prompt-level session-not-found once, in the same process', async () => {
    const { engine, started, spec } = setup({
      turns: [
        agentTurn().fail(-32002, 'session not found'),
        agentTurn().text('换个会话成功'),
      ],
    });
    const outcome = await engine.startRun(spec()).done;
    expect(outcome).toMatchObject({ status: 'completed', finalText: '换个会话成功' });
    // Same process (it is alive), two sessions opened, two prompts sent.
    expect(started).toHaveLength(1);
    expect(started[0]!.observed.sessions).toHaveLength(2);
    expect(started[0]!.observed.prompts).toHaveLength(2);
  });

  it('retries only once: a second failure settles the run', async () => {
    const { engine, started, spec } = setup({
      turns: [
        agentTurn().fail(-32002, 'session not found'),
        agentTurn().fail(-32002, 'session not found'),
        agentTurn().text('不该跑'),
      ],
    });
    const outcome = await engine.startRun(spec()).done;
    expect(outcome.status).toBe('failed');
    expect(started[0]!.observed.prompts).toHaveLength(2);
  });

  it('a crash during session setup does not retry (next run resumes the row)', async () => {
    const { engine, started, spec } = setup([
      { newSessionDelayMs: 60_000, turns: [] },
      { turns: [agentTurn().text('下次再跑')] },
    ]);
    const handle = engine.startRun(spec());
    await pause(150);
    // Kill the process while the session/new is still pending: no output, but
    // the failure happened before the prompt phase — no transparent retry.
    started[0]!.kill();
    const outcome = await handle.done;
    expect(outcome.status).toBe('failed');
    expect(started).toHaveLength(1);
  });
});

describe('per-entry init timeout (D118)', () => {
  it('dsh overrides the shared default', () => {
    const dsh = AGENT_CATALOG.find((entry) => entry.id === 'dsh')!;
    expect(dsh.initTimeoutMs).toBe(120_000);
    for (const entry of AGENT_CATALOG) {
      if (entry.id !== 'dsh') expect(entry.initTimeoutMs).toBeUndefined();
    }
  });
});
