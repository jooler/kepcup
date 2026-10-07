import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentModelRef, type AgentCatalogEntry } from '@kepcup/shared';
import {
  agentTurn,
  fakeAcpAgentLaunch,
  fakeAgentSpawner,
  readFakeAgentRecord,
  writeFakeAgentScript,
  type FakeAcpAgentHandle,
  type FakeAgentObservation,
  type FakeAgentScript,
} from '@kepcup/testkit';
import { Type } from '@earendil-works/pi-ai';
import { ExternalAgentEngine } from '../../src/agent/external/engine.js';
import { AgentHost } from '../../src/agent/external/host.js';
import { HostMcpBridge } from '../../src/agent/external/mcp-bridge.js';
import { providerFor } from '../../src/agent/external/providers/index.js';
import type { ProviderRegistry } from '../../src/agent/external/types.js';
import type {
  EngineEvent,
  RunHandle,
  RunSpec,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../src/agent/types.js';

/**
 * Provider 契约测试（todo/acp-external-agents.md §4.1，D72 §10）：一组与
 * Provider 无关的用例——启动、initialize、会话、prompt 与事件映射、cancel、
 * 权限默认拒绝、未处理请求立即报错、run 外更新丢弃、宿主 MCP 桥往返（P2：
 * 工具列表、调用、镜像更新忽略、伪造 token / run 外调用被拒、取消时 abort、
 * skip_reply、errorCode）。
 * 每个目录条目以 testkit 假 Agent 剧本执行（进程内 + 子进程两种接法）；
 * 真实 Agent 由 P0 spike 脚本手动 / 夜间执行同一组探测。
 */

export type ContractMode = 'in-process' | 'subprocess';

export interface ContractTarget {
  entry: AgentCatalogEntry;
  mode: ContractMode;
  providers?: ProviderRegistry;
  /**
   * What every script of this target adds (e.g. the session modes a real
   * agent offers, which its provider's tier mapping requires).
   */
  scriptDefaults?: Partial<FakeAgentScript>;
  /**
   * The permission options the agent offers (real optionIds, P3) and the ids
   * the host must pick from them; default = the fake agent's generic ids.
   */
  permission?: {
    options: Array<{
      optionId: string;
      name: string;
      kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    }>;
    allow: string;
    reject: string;
  };
  /**
   * Where the agent's mirror updates carry the MCP tool name; `opaque` = the
   * agent has no structured name at all (OpenCode): the host cannot hide its
   * mirrors, so the bridge cases run without them (the provider's own tests
   * cover the unrecognized mirror).
   */
  mirrorNameIn?:
    'name' | 'claude_meta' | 'codex_raw_input' | 'antigravity_meta' | 'cursor_raw_input' | 'opaque';
}

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

interface Harness {
  engine: ExternalAgentEngine;
  host: AgentHost;
  bridge: HostMcpBridge;
  observed(): FakeAgentObservation;
  workdir: string;
  dispose(): Promise<void>;
}

async function createHarness(target: ContractTarget, rawScript: FakeAgentScript): Promise<Harness> {
  const script = { ...target.scriptDefaults, ...rawScript };
  const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-contract-'));
  const workdir = path.join(dir, 'work');
  const started: FakeAcpAgentHandle[] = [];
  const scriptFile = path.join(dir, 'script.json');
  const recordFile = path.join(dir, 'record.jsonl');
  if (target.mode === 'subprocess') writeFakeAgentScript(scriptFile, script);
  const host = new AgentHost({
    logger,
    redact: (text) => text,
    appVersion: '9.9.9-test',
    resolveLaunch: () => fakeAcpAgentLaunch(scriptFile, recordFile),
    // Providers that relocate the agent's global config (OpenCode, Cursor,
    // Antigravity) refuse to start without a private state directory.
    stateDirFor: (id) => path.join(dir, 'state', id),
    ...(target.providers !== undefined ? { providers: target.providers } : {}),
    ...(target.mode === 'in-process'
      ? { spawn: fakeAgentSpawner({ [target.entry.id]: script }, started) as never }
      : {}),
  });
  const bridge = new HostMcpBridge({ logger, appVersion: '9.9.9-test' });
  await bridge.start();
  const engine = new ExternalAgentEngine({
    host,
    bridge,
    catalog: () => [target.entry],
    logger,
    cancelGraceMs: 2_000,
  });
  return {
    engine,
    host,
    bridge,
    workdir,
    observed: () =>
      target.mode === 'in-process' ? started[0]!.observed : readFakeAgentRecord(recordFile),
    dispose: async () => {
      host.dispose();
      await bridge.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runSpec(
  entry: AgentCatalogEntry,
  workdir: string,
  text = '你好',
  tools: ToolDefinition[] = [],
): RunSpec {
  return {
    identity: {
      runId: 'run_contract',
      botId: 'bot_x',
      conversationId: 'conv_x',
      loopType: 'response',
    },
    model: agentModelRef(entry.id, ''),
    buildSystemPrompt: async () => '<identity>契约测试 Bot</identity>',
    messages: [{ role: 'user', content: text, timestamp: 0 }],
    tools,
    limits: { maxTurns: 60 },
    workdir,
    external: {
      agentId: entry.id,
      permission: 'read_only',
      capabilities: tools.length > 0 ? ['core', 'memory'] : [],
      sessionKey: 'bot_x:conv_x',
    },
  };
}

function start(
  harness: Harness,
  entry: AgentCatalogEntry,
  text?: string,
  tools?: ToolDefinition[],
) {
  const handle: RunHandle = harness.engine.startRun(runSpec(entry, harness.workdir, text, tools));
  const events: EngineEvent[] = [];
  handle.onEvent((event) => events.push(event));
  return { handle, events };
}

async function eventually<T>(probe: () => T | null | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function runAgentProviderContract(target: ContractTarget): void {
  const { entry } = target;
  describe(`agent provider contract: ${entry.id} (${entry.provider}, ${target.mode})`, () => {
    const harnesses: Harness[] = [];
    const permissionOptions = target.permission?.options;
    const allowId = target.permission?.allow ?? 'allow_once';
    const rejectId = target.permission?.reject ?? 'reject_once';
    const make = async (script: FakeAgentScript) => {
      const harness = await createHarness(target, script);
      harnesses.push(harness);
      return harness;
    };
    afterEach(async () => {
      for (const harness of harnesses.splice(0)) await harness.dispose();
    });
    const provider = providerFor(entry, target.providers);
    const metaAppend = provider.instructionMode === 'meta-append';

    it('starts the agent and initializes with an honest KepCup clientInfo', async () => {
      const harness = await make({ turns: [agentTurn().text('在')] });
      const { handle } = start(harness, entry);
      const outcome = await handle.done;
      expect(outcome.status).toBe('completed');
      const init = harness.observed().initialize;
      expect(init?.protocolVersion).toBe(1);
      expect(init?.clientInfo).toMatchObject({ name: 'KepCup', version: '9.9.9-test' });
      expect(init?.clientCapabilities?.fs).toMatchObject({
        readTextFile: false,
        writeTextFile: false,
      });
      expect(init?.clientCapabilities?.terminal).toBe(false);
    });

    it('opens a session in the run workdir; no host MCP server without host tools', async () => {
      const harness = await make({ turns: [agentTurn().text('ok')] });
      const { handle } = start(harness, entry);
      await handle.done;
      const sessions = harness.observed().sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.cwd).toBe(harness.workdir);
      expect(sessions[0]!.mcpServers).toEqual([]);
      const prompt = harness.observed().prompts[0]!;
      expect(prompt.text).toContain('你好');
      // The session prompt goes where the provider's instructionMode says.
      if (metaAppend) {
        expect(prompt.text).not.toContain('契约测试 Bot');
        expect(JSON.stringify(sessions[0]!.meta)).toContain('契约测试 Bot');
      } else {
        expect(prompt.text).toContain('契约测试 Bot');
      }
    });

    it('maps text → tool → text → end onto PiEngine-shaped events', async () => {
      const harness = await make({
        turns: [
          agentTurn()
            .text('我先看一下。')
            .toolCall('t1', 'Read README.md', {
              name: 'Read',
              kind: 'read',
              input: { path: 'README.md' },
            })
            .toolResult('t1', '# readme')
            .text('看完了，结论是 42。'),
        ],
      });
      const { handle, events } = start(harness, entry);
      const outcome = await handle.done;
      expect(outcome).toMatchObject({ status: 'completed', finalText: '看完了，结论是 42。' });
      expect(events.map((event) => event.type)).toEqual([
        'request',
        'assistant',
        'tool_call',
        'tool_result',
        'assistant',
      ]);
      expect(events[1]!.payload).toEqual({
        text: '我先看一下。',
        stopReason: 'toolUse',
        errorMessage: undefined,
      });
      expect(events[2]!.payload).toEqual({
        toolCallId: 't1',
        toolName: 'Read',
        args: { path: 'README.md' },
        // The status line shows the agent's title (P5).
        title: 'Read README.md',
      });
      expect(events[3]!.payload).toEqual({
        toolCallId: 't1',
        toolName: 'Read',
        ok: true,
        content: '# readme',
      });
      expect(events[4]!.payload).toMatchObject({ text: '看完了，结论是 42。', stopReason: 'stop' });
    });

    it('cancels through session/cancel and settles cancelled', async () => {
      const harness = await make({ turns: [agentTurn().text('开始').waitCancel()] });
      const { handle, events } = start(harness, entry);
      await eventually(() => events.find((event) => event.type === 'request'));
      handle.abort('user');
      const outcome = await handle.done;
      expect(outcome.status).toBe('cancelled');
      expect(outcome.finalText).toBe('');
      await eventually(() => (harness.observed().cancels.length > 0 ? true : null));
    });

    it('rejects permission requests by default (P1 read-only)', async () => {
      const harness = await make({
        turns: [
          agentTurn()
            .permission('w1', 'Write /etc/passwd', { options: permissionOptions })
            // A kepcup-looking tool is still refused: P1 sessions carry no
            // host bridge, and the free-text title never counts.
            .permission('w2', 'mcp__kepcup__send_message', {
              name: 'mcp__kepcup__send_message',
              options: permissionOptions,
            })
            .permission('w3', 'mcp__kepcup__send_message', { options: permissionOptions })
            .text('被拒绝了'),
        ],
      });
      const { handle, events } = start(harness, entry);
      const outcome = await handle.done;
      expect(outcome.status).toBe('completed');
      await eventually(() => (harness.observed().permissions.length === 3 ? true : null));
      for (const [index, toolCallId] of ['w1', 'w2', 'w3'].entries()) {
        expect(harness.observed().permissions[index]).toEqual({
          toolCallId,
          outcome: { outcome: 'selected', optionId: rejectId },
        });
      }
      expect(
        events.some(
          (event) => event.type === 'progress' && event.payload.text.includes('Write /etc/passwd'),
        ),
      ).toBe(true);
    });

    it('answers unhandled agent→client requests immediately with an error', async () => {
      const harness = await make({
        turns: [
          agentTurn()
            .request('vendor/ask_question', { question: '?' })
            // Underscore-prefixed extension methods take a different SDK route.
            .request('_vendor/x', { sessionId: 'x' })
            .request('fs/read_text_file', { sessionId: 'x', path: '/etc/hosts' })
            .request('fs/write_text_file', { sessionId: 'x', path: '/tmp/x', content: 'x' })
            .request('terminal/create', { sessionId: 'x', command: 'ls' })
            .request('terminal/output', { sessionId: 'x', terminalId: 't' })
            .request('terminal/release', { sessionId: 'x', terminalId: 't' })
            .request('terminal/wait_for_exit', { sessionId: 'x', terminalId: 't' })
            .request('terminal/kill', { sessionId: 'x', terminalId: 't' })
            .text('继续'),
        ],
      });
      const { handle } = start(harness, entry);
      const outcome = await handle.done;
      expect(outcome).toMatchObject({ status: 'completed', finalText: '继续' });
      await eventually(() => (harness.observed().requests.length === 9 ? true : null));
      for (const request of harness.observed().requests) {
        expect(request.error?.code, request.method).toBe(-32601);
        expect(request.result, request.method).toBeUndefined();
      }
    });

    it('drops updates that arrive outside any run', async () => {
      const harness = await make({
        turns: [
          agentTurn()
            .text('第一轮')
            .afterTurn([{ type: 'text', text: '自主输出' }], 30),
          agentTurn().text('第二轮'),
        ],
      });
      const first = start(harness, entry);
      expect((await first.handle.done).finalText).toBe('第一轮');
      const settledCount = first.events.length;
      // The agent really sent the autonomous chunk on the old session…
      await eventually(() =>
        harness
          .observed()
          .emitted.filter(
            (e) => e.sessionId === 'fake-session-1' && e.update === 'agent_message_chunk',
          ).length === 2
          ? true
          : null,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      // …and no run received it.
      expect(first.events).toHaveLength(settledCount);
      const second = start(harness, entry, '再来');
      const outcome = await second.handle.done;
      expect(outcome.finalText).toBe('第二轮');
      expect(JSON.stringify(second.events)).not.toContain('自主输出');
    });

    it('records the agent auth status pushed via _auth/status_update', async () => {
      const harness = await make({
        turns: [
          agentTurn()
            .notify('_auth/status_update', { authStatus: { kind: 'none' } })
            .text('ok'),
        ],
      });
      expect(harness.host.authStatus(entry.id)).toBeNull();
      await start(harness, entry).handle.done;
      const status = await eventually(() => harness.host.authStatus(entry.id));
      expect(status.kind).toBe('none');
    });

    // —— 宿主 MCP 桥（P2，design 28 §4.4）——

    const mirrorNameIn = target.mirrorNameIn ?? 'name';
    // Options of bridge calls whose mirrors the host is expected to hide.
    const mirrorOpts = mirrorNameIn === 'opaque' ? { mirror: false as const } : { mirrorNameIn };

    it('round-trips host tools through the bridge; ACP mirrors are ignored', async () => {
      const harness = await make({
        turns: [
          agentTurn()
            .text('我先记下来。')
            .mcpList()
            .mcpCall('m1', 'remember', { content: '用户喜欢猫' }, mirrorOpts)
            .mcpCall('m2', 'send_message', { text: '记好了' }, mirrorOpts)
            .text('都办好了。'),
        ],
      });
      const { tools, executed } = hostTools();
      const { handle, events } = start(harness, entry, '记住我喜欢猫', tools);
      const outcome = await handle.done;
      expect(outcome).toMatchObject({ status: 'completed', finalText: '都办好了。' });

      const session = harness.observed().sessions[0]!;
      expect(session.mcpServers).toEqual([
        {
          type: 'http',
          // Per-session name: no user MCP server can pose as the bridge.
          name: expect.stringMatching(/^kepcup_[0-9a-f]{8}$/),
          url: harness.bridge.url,
          headers: [{ name: 'Authorization', value: expect.stringMatching(/^Bearer \S{40,}$/) }],
        },
      ]);
      const mcp = harness.observed().mcp;
      expect(mcp[0]).toMatchObject({ method: 'tools/list', ok: true });
      expect((mcp[0]!.result as Array<{ name: string }>).map((t) => t.name)).toEqual([
        'send_message',
        'remember',
        'wait_forever',
        'skip_reply',
        'slow_lookup',
        'needs_setup',
      ]);
      expect(mcp.slice(1)).toMatchObject([
        { method: 'tools/call', tool: 'remember', ok: true },
        { method: 'tools/call', tool: 'send_message', ok: true },
      ]);
      expect(executed).toEqual([
        { tool: 'remember', args: { content: '用户喜欢猫' }, runId: 'run_contract' },
        { tool: 'send_message', args: { text: '记好了' }, runId: 'run_contract' },
      ]);
      // Bridge-reported steps only (no mirror duplicates), PiEngine-shaped:
      // two sequential calls are two model turns.
      expect(events.map((event) => event.type)).toEqual([
        'request',
        'assistant',
        'tool_call',
        'tool_result',
        'assistant',
        'tool_call',
        'tool_result',
        'assistant',
      ]);
      expect(events[1]!.payload).toMatchObject({ text: '我先记下来。', stopReason: 'toolUse' });
      expect(events[2]!.payload).toMatchObject({
        toolName: 'remember',
        args: { content: '用户喜欢猫' },
        capability: 'memory',
        nativeOverlap: false,
      });
      expect(events[3]!.payload).toMatchObject({
        toolName: 'remember',
        ok: true,
        content: '已记住',
      });
      expect(events[4]!.payload).toMatchObject({ text: '', stopReason: 'toolUse' });
      expect(events[7]!.payload).toMatchObject({ text: '都办好了。', stopReason: 'stop' });
    });

    it('allows permission requests for bridge tools only on bridged sessions', async () => {
      const harness = await make({
        turns: [
          agentTurn()
            .permission('p1', 'kepcup tool', {
              bridgeTool: 'send_message',
              options: permissionOptions,
            })
            .permission('p2', 'Write /etc/passwd', { options: permissionOptions })
            // A user / project MCP server called "kepcup" is not the bridge.
            .permission('p3', 'impostor', {
              name: 'mcp__kepcup__send_message',
              options: permissionOptions,
            })
            // The bridge server, but a tool this run does not inject.
            .permission('p4', 'not injected', { bridgeTool: 'bash', options: permissionOptions })
            .text('ok'),
        ],
      });
      await start(harness, entry, '你好', hostTools().tools).handle.done;
      await eventually(() => (harness.observed().permissions.length === 4 ? true : null));
      // An agent with no structured tool name (opaque) gets no automatic
      // allow: the `mcp__…` name does not match its own tool naming.
      const bridgeVerdict = mirrorNameIn === 'opaque' ? rejectId : allowId;
      expect(harness.observed().permissions).toEqual([
        { toolCallId: 'p1', outcome: { outcome: 'selected', optionId: bridgeVerdict } },
        { toolCallId: 'p2', outcome: { outcome: 'selected', optionId: rejectId } },
        { toolCallId: 'p3', outcome: { outcome: 'selected', optionId: rejectId } },
        { toolCallId: 'p4', outcome: { outcome: 'selected', optionId: rejectId } },
      ]);
    });

    it('records a bridge-named update with no bridge call behind it as a native call', async () => {
      const harness = await make({
        turns: [
          agentTurn()
            .mcpCall('fake1', 'send_message', { text: '假的' }, { mirrorNameIn, skipCall: true })
            .text('完成'),
        ],
      });
      const { tools, executed } = hostTools();
      const { handle, events } = start(harness, entry, '你好', tools);
      await handle.done;
      expect(executed).toEqual([]);
      const calls = events.filter((event) => event.type === 'tool_call');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.payload).toMatchObject({ toolCallId: 'fake1' });
      expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
        toolCallId: 'fake1',
        ok: true,
      });
    });

    it('skip_reply waits for sibling bridge calls before cancelling', async () => {
      const harness = await make({
        turns: [
          agentTurn()
            .parallel([
              [{ type: 'mcp_call', id: 'slow', tool: 'slow_lookup', args: {}, ...mirrorOpts }],
              [
                // The skip lands while the sibling is already executing.
                { type: 'sleep', ms: 60 },
                {
                  type: 'mcp_call',
                  id: 'skip',
                  tool: 'skip_reply',
                  args: { reason: '无关' },
                  ...mirrorOpts,
                },
              ],
            ])
            .waitCancel(),
        ],
      });
      const { tools, executed, aborted } = hostTools();
      const { handle } = start(harness, entry, '群聊', tools);
      const outcome = await handle.done;
      expect(outcome).toMatchObject({ status: 'completed', skipReply: true });
      expect(executed.map((call) => call.tool).sort()).toEqual(['skip_reply', 'slow_lookup']);
      expect(aborted).toEqual([]);
      expect(harness.observed().mcp.filter((call) => call.method === 'tools/call')).toMatchObject([
        { ok: true },
        { ok: true },
      ]);
    });

    it('refuses forged tokens and calls outside the run', async () => {
      const harness = await make({
        turns: [
          agentTurn()
            .mcpCall(
              'f1',
              'send_message',
              { text: '伪造' },
              { token: 'forged-token', mirror: false },
            )
            .text('第一轮')
            .afterTurn(
              [
                {
                  type: 'mcp_call',
                  id: 'late',
                  tool: 'send_message',
                  args: { text: '迟到' },
                  mirror: false,
                },
              ],
              30,
            ),
        ],
      });
      const { tools, executed } = hostTools();
      const outcome = await start(harness, entry, '你好', tools).handle.done;
      expect(outcome.finalText).toBe('第一轮');
      await eventually(() => (harness.observed().mcp.length === 2 ? true : null));
      expect(harness.observed().mcp).toMatchObject([
        { method: 'tools/call', ok: false, status: 401 },
        { method: 'tools/call', ok: false, status: 401 },
      ]);
      expect(executed).toEqual([]);
    });

    it('aborts an in-flight bridge call when the run is cancelled', async () => {
      const harness = await make({
        turns: [agentTurn().mcpCall('w1', 'wait_forever', {}, mirrorOpts)],
      });
      const { tools, aborted } = hostTools();
      const { handle, events } = start(harness, entry, '等着', tools);
      await eventually(() =>
        events.some(
          (event) => event.type === 'tool_call' && event.payload.toolName === 'wait_forever',
        )
          ? true
          : null,
      );
      handle.abort('user');
      const outcome = await handle.done;
      expect(outcome.status).toBe('cancelled');
      await eventually(() => (aborted.length > 0 ? true : null));
      expect(aborted).toEqual(['wait_forever']);
    });

    it('skip_reply cancels the prompt and settles completed without a final text', async () => {
      const harness = await make({
        turns: [
          agentTurn().mcpCall('s1', 'skip_reply', { reason: '与我无关' }, mirrorOpts).waitCancel(),
        ],
      });
      const { handle, events } = start(harness, entry, '群里的闲聊', hostTools().tools);
      const outcome = await handle.done;
      expect(outcome).toMatchObject({ status: 'completed', finalText: '', skipReply: true });
      await eventually(() => (harness.observed().cancels.length > 0 ? true : null));
      expect(events.filter((event) => event.type === 'assistant')).toHaveLength(1);
    });

    it('keeps the errorCode of bridge results (SETUP_REQUIRED interrupts the run)', async () => {
      const harness = await make({
        turns: [agentTurn().mcpCall('e1', 'needs_setup', {}, mirrorOpts).text('之后')],
      });
      const { handle, events } = start(harness, entry, '搜一下', hostTools().tools);
      await handle.done;
      expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
        toolName: 'needs_setup',
        ok: false,
        errorCode: 'SETUP_REQUIRED',
      });
    });
  });
}

/** Host tools for the bridge cases (stand-ins for buildResponseTools output). */
function hostTools(): {
  tools: ToolDefinition[];
  executed: Array<{ tool: string; args: unknown; runId: string }>;
  aborted: string[];
} {
  const executed: Array<{ tool: string; args: unknown; runId: string }> = [];
  const aborted: string[] = [];
  const define = (
    name: string,
    parameters: unknown,
    run: (params: unknown, ctx: ToolContext) => Promise<ToolResult>,
  ): ToolDefinition => ({
    name,
    description: `${name}（契约测试）`,
    parameters,
    execute: async (params, ctx) => {
      executed.push({ tool: name, args: params, runId: ctx.identity.runId });
      return run(params, ctx);
    },
  });
  return {
    executed,
    aborted,
    tools: [
      define('send_message', Type.Object({ text: Type.String() }), async () => ({
        ok: true,
        content: '已发送',
      })),
      define('remember', Type.Object({ content: Type.String() }), async () => ({
        ok: true,
        content: '已记住',
      })),
      define(
        'wait_forever',
        Type.Object({}),
        (_params, ctx) =>
          new Promise((resolve) =>
            ctx.signal.addEventListener('abort', () => {
              aborted.push('wait_forever');
              resolve({ ok: false, content: '已取消', errorCode: 'CANCELLED' });
            }),
          ),
      ),
      define('skip_reply', Type.Object({ reason: Type.String() }), async () => ({
        ok: true,
        content: '好的，本次执行结束，不发送回复。',
        terminate: true,
      })),
      define(
        'slow_lookup',
        Type.Object({}),
        (_params, ctx) =>
          new Promise((resolve) => {
            let done = false;
            const timer = setTimeout(() => {
              done = true;
              resolve({ ok: true, content: '查到了' });
            }, 150);
            ctx.signal.addEventListener('abort', () => {
              // The run's signal aborts at release too: only count a real cut-off.
              if (done) return;
              clearTimeout(timer);
              aborted.push('slow_lookup');
              resolve({ ok: false, content: '已取消', errorCode: 'CANCELLED' });
            });
          }),
      ),
      define('needs_setup', Type.Object({}), async () => ({
        ok: false,
        content: '需要先配置检索服务',
        errorCode: 'SETUP_REQUIRED',
      })),
    ],
  };
}
