import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Type } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  BRIDGE_AUDIT_ARGS_MAX_CHARS,
  HostMcpBridge,
  type BridgeRunBinding,
  type BridgeToolCallEvent,
  type BridgeToolResultEvent,
} from '../../src/agent/external/mcp-bridge.js';
import { SCREENSHOT_OMITTED_NOTE } from '../../src/agent/tool-execution.js';
import type { EffectRecorder } from '../../src/agent/effects/recorder.js';
import { truncateToBudget } from '../../src/agent/tokens.js';
import type {
  RunIdentity,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../src/agent/types.js';

/**
 * 宿主 MCP 桥（D72 P2，design 28 §4.4）：本机绑定 + Host / Origin 校验、会话级
 * token（伪造 / 过期）、无 run 拒绝、tools/list 与 tools/call 往返（RunIdentity、
 * 事件、审计、参数校验、截断 / 图片共用规则）、run 取消时进行中调用收到
 * abort、终止型工具在响应发出后才通知；stdio 代理往返。
 */

const logger = { info: () => {}, warn: () => {} };
const LONG = '截断规则与内置引擎一致。'.repeat(TOOL_OUTPUT_MAX_CHARS);
const IDENTITY: RunIdentity = {
  runId: 'run_bridge',
  botId: 'bot_b',
  conversationId: 'conv_b',
  loopType: 'turn',
};

interface HttpReply {
  status: number;
  body: string;
  json: () => { result?: unknown; error?: { message: string } };
}

function post(
  bridge: HostMcpBridge,
  body: unknown,
  options: { token?: string | null; host?: string; origin?: string; method?: string } = {},
): Promise<HttpReply> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: bridge.port,
        path: '/mcp',
        method: options.method ?? 'POST',
        headers: {
          host: options.host ?? `127.0.0.1:${bridge.port}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(options.origin !== undefined ? { origin: options.origin } : {}),
          ...(options.token !== null && options.token !== undefined
            ? { authorization: `Bearer ${options.token}` }
            : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: text, json: () => JSON.parse(text) }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

function call(name: string, args: Record<string, unknown>, id = 2) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function tool(
  name: string,
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>,
  parameters: unknown = Type.Object({ text: Type.String() }),
): ToolDefinition {
  return { name, description: `${name} 的描述`, parameters, execute: execute as never };
}

interface Recorder {
  calls: BridgeToolCallEvent[];
  results: BridgeToolResultEvent[];
  terminated: string[];
  audits: Array<{ identity: RunIdentity; action: string; detail: Record<string, unknown> }>;
}

function binding(
  tools: ToolDefinition[],
  recorder: Recorder,
  extra: Partial<BridgeRunBinding> = {},
): BridgeRunBinding {
  return {
    identity: IDENTITY,
    tools,
    signal: new AbortController().signal,
    acceptsImages: false,
    meta: (toolName) => ({
      capability: toolName === 'web_search' ? 'web' : 'core',
      nativeOverlap: toolName === 'web_search',
    }),
    onToolCall: (event) => recorder.calls.push(event),
    onToolResult: (event) => recorder.results.push(event),
    progress: () => {},
    onTerminate: (reason) => recorder.terminated.push(reason),
    ...extra,
  };
}

describe('HostMcpBridge', () => {
  const bridges: HostMcpBridge[] = [];
  let recorder: Recorder;
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) await bridge.stop();
  });

  async function startBridge(): Promise<HostMcpBridge> {
    recorder = { calls: [], results: [], terminated: [], audits: [] };
    const bridge = new HostMcpBridge({
      logger,
      appVersion: '9.9.9',
      audit: (identity, action, detail) => recorder.audits.push({ identity, action, detail }),
    });
    await bridge.start();
    bridges.push(bridge);
    return bridge;
  }

  it('listens on 127.0.0.1 only and refuses foreign Host / Origin (DNS rebinding)', async () => {
    const bridge = await startBridge();
    expect(bridge.url).toBe(`http://127.0.0.1:${bridge.port}/mcp`);
    const token = bridge.issueSessionToken('s1');
    bridge.bindRun('s1', binding([], recorder));
    expect((await post(bridge, INIT, { token })).status).toBe(200);
    expect((await post(bridge, INIT, { token, host: `evil.example:${bridge.port}` })).status).toBe(
      403,
    );
    expect((await post(bridge, INIT, { token, host: `localhost:${bridge.port}` })).status).toBe(
      403,
    );
    expect((await post(bridge, INIT, { token, origin: 'http://evil.example' })).status).toBe(403);
    expect(
      (await post(bridge, INIT, { token, origin: `http://localhost:${bridge.port}` })).status,
    ).toBe(200);
  });

  it('refuses forged, missing and expired tokens, and sessions without a run', async () => {
    const bridge = await startBridge();
    const old = bridge.issueSessionToken('s1');
    bridge.bindRun('s1', binding([], recorder));
    expect((await post(bridge, INIT, { token: 'forged' })).status).toBe(401);
    expect((await post(bridge, INIT, { token: null })).status).toBe(401);
    // Re-issuing for the session expires the previous token.
    const fresh = bridge.issueSessionToken('s1');
    expect((await post(bridge, INIT, { token: old })).status).toBe(401);
    expect((await post(bridge, INIT, { token: fresh })).status).toBe(200);
    // A stale revoke (the old token) leaves the current one alone.
    bridge.revoke('s1', old);
    expect((await post(bridge, INIT, { token: fresh })).status).toBe(200);
    // No run in progress → refused.
    bridge.unbindRun('s1', 'some_other_run');
    expect((await post(bridge, INIT, { token: fresh })).status).toBe(200);
    bridge.unbindRun('s1', IDENTITY.runId);
    const refused = await post(bridge, INIT, { token: fresh });
    expect(refused.status).toBe(403);
    expect(refused.json().error?.message).toContain('no run');
    bridge.revoke('s1');
    expect((await post(bridge, INIT, { token: fresh })).status).toBe(401);
    // Only POST is served (stateless: no SSE stream).
    const t2 = bridge.issueSessionToken('s2');
    bridge.bindRun('s2', binding([], recorder));
    expect((await post(bridge, undefined, { token: t2, method: 'GET' })).status).toBe(405);
  });

  it('lists the bound tools and runs calls with the run identity, events and audit', async () => {
    const bridge = await startBridge();
    const token = bridge.issueSessionToken('s1');
    const seen: ToolContext[] = [];
    bridge.bindRun(
      's1',
      binding(
        [
          tool('send_message', async (params, ctx) => {
            seen.push(ctx);
            return { ok: true, content: `已发送：${String(params.text)}` };
          }),
          tool('web_search', async () => ({
            ok: false,
            content: '未配置检索',
            errorCode: 'SETUP_REQUIRED',
          })),
        ],
        recorder,
      ),
    );
    const list = await post(bridge, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { token });
    const tools = (list.json().result as { tools: Array<{ name: string; inputSchema: unknown }> })
      .tools;
    expect(tools.map((t) => t.name)).toEqual(['send_message', 'web_search']);
    expect(tools[0]!.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    });

    const sent = await post(bridge, call('send_message', { text: '你好' }), { token });
    expect(sent.json().result).toEqual({ content: [{ type: 'text', text: '已发送：你好' }] });
    expect(seen[0]!.identity).toEqual(IDENTITY);
    expect(recorder.calls[0]).toMatchObject({
      toolName: 'send_message',
      args: { text: '你好' },
      capability: 'core',
      nativeOverlap: false,
    });
    expect(recorder.results[0]).toEqual({
      toolCallId: recorder.calls[0]!.toolCallId,
      toolName: 'send_message',
      ok: true,
      content: '已发送：你好',
    });
    expect(recorder.audits[0]).toEqual({
      identity: IDENTITY,
      action: 'agent_bridge_tool_call',
      detail: { toolName: 'send_message', capability: 'core', args: { text: '你好' } },
    });

    // errorCode survives (SETUP_REQUIRED interrupts the run in the orchestrator).
    const failed = await post(bridge, call('web_search', { text: 'q' }), { token });
    expect(failed.json().result).toMatchObject({ isError: true });
    expect(recorder.results[1]).toMatchObject({ ok: false, errorCode: 'SETUP_REQUIRED' });
    expect(recorder.calls[1]).toMatchObject({ capability: 'web', nativeOverlap: true });

    // Unknown tools and invalid arguments come back as tool errors.
    const unknown = await post(bridge, call('bash', { text: 'rm -rf /' }), { token });
    expect(unknown.json().result).toMatchObject({ isError: true });
    // pi coerces scalars ("42"); a missing required field is invalid.
    const invalid = await post(bridge, call('send_message', {}), { token });
    expect(invalid.json().result).toMatchObject({ isError: true });
    expect(recorder.results.at(-1)).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
  });

  it('shares truncation / image rules with PiEngine and reports thrown tools as failures', async () => {
    const bridge = await startBridge();
    const token = bridge.issueSessionToken('s1');
    const image = { mimeType: 'image/png', base64: 'aGk=' };
    bridge.bindRun(
      's1',
      binding(
        [
          tool('browser_screenshot', async () => ({
            ok: true,
            content: LONG,
            images: [image],
          })),
          tool('boom', async () => {
            throw new Error('炸了');
          }),
        ],
        recorder,
      ),
    );
    const shot = await post(bridge, call('browser_screenshot', { text: '' }), { token });
    const content = (shot.json().result as { content: Array<{ type: string; text?: string }> })
      .content;
    expect(content[0]!.text).toBe(truncateToBudget(LONG, TOOL_OUTPUT_MAX_CHARS).text);
    expect(content[0]!.text!.length).toBeLessThan(LONG.length);
    expect(content[1]).toEqual({ type: 'text', text: SCREENSHOT_OMITTED_NOTE });
    const boom = await post(bridge, call('boom', { text: '' }), { token });
    expect(boom.json().result).toMatchObject({ isError: true });
    expect(recorder.results.at(-1)).toMatchObject({ ok: false, errorCode: 'INTERNAL' });

    // An agent accepting images gets the image block.
    const t2 = bridge.issueSessionToken('s2');
    bridge.bindRun(
      's2',
      binding(
        [tool('browser_screenshot', async () => ({ ok: true, content: 'snap', images: [image] }))],
        recorder,
        {
          acceptsImages: true,
        },
      ),
    );
    const withImage = await post(bridge, call('browser_screenshot', { text: '' }), { token: t2 });
    expect((withImage.json().result as { content: unknown[] }).content[1]).toEqual({
      type: 'image',
      data: 'aGk=',
      mimeType: 'image/png',
    });
  });

  it('W2: tool-reported / ledger uncertain outcomes reach the tool_result report', async () => {
    recorder = { calls: [], results: [], terminated: [], audits: [] };
    // A ledger that settles every call it sees as uncertain (thrown → uncertain).
    const effects: EffectRecorder = {
      begin: () => ({
        escalate: () => {},
        noteApproval: () => {},
        settle: () => null,
        settleThrown: () => 'uncertain',
      }),
    };
    const bridge = new HostMcpBridge({ logger, appVersion: '9.9.9', effects });
    await bridge.start();
    bridges.push(bridge);
    const token = bridge.issueSessionToken('s1');
    bridge.bindRun(
      's1',
      binding(
        [
          tool('mcp_srv_post', async () => ({
            ok: false,
            content: 'MCP 调用失败：socket hang up',
            errorCode: 'MCP_CALL_FAILED',
            effect: { outcome: 'uncertain' },
          })),
          tool('git_remote', async () => {
            throw new Error('炸了');
          }),
        ],
        recorder,
      ),
    );
    await post(bridge, call('mcp_srv_post', { text: '' }), { token });
    expect(recorder.results.at(-1)).toMatchObject({
      toolName: 'mcp_srv_post',
      errorCode: 'MCP_CALL_FAILED',
      outcome: 'uncertain',
    });
    await post(bridge, call('git_remote', { text: '' }), { token });
    expect(recorder.results.at(-1)).toMatchObject({
      toolName: 'git_remote',
      errorCode: 'INTERNAL',
      outcome: 'uncertain',
    });
  });

  it('aborts in-flight calls when the run is cancelled', async () => {
    const bridge = await startBridge();
    const token = bridge.issueSessionToken('s1');
    const run = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    bridge.bindRun(
      's1',
      binding(
        [
          tool('wait', (_params, ctx) => {
            started();
            return new Promise((resolve) =>
              ctx.signal.addEventListener('abort', () =>
                resolve({ ok: false, content: '已取消', errorCode: 'CANCELLED' }),
              ),
            );
          }),
        ],
        recorder,
        { signal: run.signal },
      ),
    );
    const pending = post(bridge, call('wait', { text: '' }), { token });
    await running;
    run.abort();
    const reply = await pending;
    expect(reply.json().result).toMatchObject({ isError: true });
    expect(recorder.results[0]).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
  });

  it('notifies terminating tools only after the agent got their result', async () => {
    const bridge = await startBridge();
    const token = bridge.issueSessionToken('s1');
    bridge.bindRun(
      's1',
      binding(
        [
          tool('skip_reply', async () => {
            expect(recorder.terminated).toEqual([]);
            return { ok: true, content: '好的', terminate: true };
          }),
        ],
        recorder,
      ),
    );
    const reply = await post(bridge, call('skip_reply', { text: '无关' }), { token });
    expect(reply.json().result).toEqual({ content: [{ type: 'text', text: '好的' }] });
    expect(recorder.terminated).toEqual(['skip_reply']);
  });

  it('stdio proxy forwards JSON-RPC lines to the bridge (token via env)', async () => {
    const bridge = await startBridge();
    const token = bridge.issueSessionToken('s1');
    bridge.bindRun(
      's1',
      binding(
        [
          tool('remember', async (params) => ({
            ok: true,
            content: `记住了：${String(params.text)}`,
          })),
        ],
        recorder,
      ),
    );
    const proxy = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../src/agent/external/stdio-proxy.mjs', import.meta.url))],
      {
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          KEPCUP_MCP_URL: bridge.url,
          KEPCUP_MCP_TOKEN: token,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const lines: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
    let buffer = '';
    proxy.stdout.setEncoding('utf8');
    proxy.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) if (part.trim().length > 0) lines.push(JSON.parse(part));
    });
    const until = async (count: number) => {
      const deadline = Date.now() + 10_000;
      while (lines.length < count) {
        if (Date.now() > deadline) throw new Error('proxy did not answer');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    proxy.stdin.write(`${JSON.stringify(INIT)}\n`);
    await until(1);
    proxy.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    proxy.stdin.write(`${JSON.stringify(call('remember', { text: '喜欢猫' }, 7))}\n`);
    await until(2);
    expect(lines[0]).toMatchObject({ id: 1, result: { serverInfo: { name: 'kepcup' } } });
    expect(lines[1]).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: '记住了：喜欢猫' }] },
    });
    // Refusals come back as JSON-RPC errors for the request.
    bridge.unbindRun('s1');
    proxy.stdin.write(`${JSON.stringify(call('remember', { text: 'x' }, 8))}\n`);
    await until(3);
    expect(lines[2]).toMatchObject({ id: 8, error: { code: -32603 } });
    proxy.stdin.end();
    await new Promise((resolve) => proxy.once('exit', resolve));
  }, 20_000);

  it('serves a real MCP SDK client (stateless initialize, tools/list, tools/call)', async () => {
    const bridge = await startBridge();
    const token = bridge.issueSessionToken('s1');
    bridge.bindRun(
      's1',
      binding(
        [
          tool('search_messages', async (params) => ({
            ok: true,
            content: `找到：${String(params.text)}`,
          })),
          tool('forget', async () => ({ ok: true, content: '已忘记' })),
        ],
        recorder,
      ),
    );
    const client = new Client({ name: 'sdk-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    // connect() = initialize + notifications/initialized (+ the optional GET
    // stream, which the stateless bridge answers 405 and the SDK tolerates).
    await client.connect(transport);
    expect(transport.sessionId).toBeUndefined();
    expect(client.getServerVersion()).toMatchObject({ name: 'kepcup' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => [t.name, t.annotations])).toEqual([
      ['search_messages', { readOnlyHint: true, destructiveHint: false }],
      ['forget', { readOnlyHint: false, destructiveHint: true }],
    ]);
    const result = await client.callTool({ name: 'search_messages', arguments: { text: '猫' } });
    expect(result.content).toEqual([{ type: 'text', text: '找到：猫' }]);
    await client.close();

    // The negotiated protocol version header is checked on later requests.
    const badVersion = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: bridge.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
            'mcp-protocol-version': '1999-01-01',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }));
    });
    expect(badVersion).toBe(400);
  });

  it('caps the audited arguments', async () => {
    const bridge = await startBridge();
    const token = bridge.issueSessionToken('s1');
    bridge.bindRun(
      's1',
      binding([tool('send_message', async () => ({ ok: true, content: 'ok' }))], recorder),
    );
    await post(
      bridge,
      call('send_message', { text: '长'.repeat(BRIDGE_AUDIT_ARGS_MAX_CHARS * 2) }),
      {
        token,
      },
    );
    const detail = recorder.audits[0]!.detail;
    expect(detail.args).toBeUndefined();
    expect(detail.argsTruncated).toBe(true);
    expect(String(detail.argsSummary).length).toBeLessThan(BRIDGE_AUDIT_ARGS_MAX_CHARS + 20);
  });

  it('a terminating call waits for its sibling calls before ending the run', async () => {
    const bridge = await startBridge();
    const token = bridge.issueSessionToken('s1');
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));
    let slowStarted!: () => void;
    const slowRunning = new Promise<void>((resolve) => (slowStarted = resolve));
    bridge.bindRun(
      's1',
      binding(
        [
          tool('slow', async () => {
            slowStarted();
            await slowGate;
            return { ok: true, content: '慢' };
          }),
          tool('skip_reply', async () => ({ ok: true, content: '好的', terminate: true })),
        ],
        recorder,
      ),
    );
    const slow = post(bridge, call('slow', { text: '' }), { token });
    await slowRunning;
    await post(bridge, call('skip_reply', { text: '' }, 3), { token });
    // The skip answered, but a sibling call is still running: no cancel yet.
    expect(recorder.terminated).toEqual([]);
    releaseSlow();
    await slow;
    expect(recorder.terminated).toEqual(['skip_reply']);
  });
});
