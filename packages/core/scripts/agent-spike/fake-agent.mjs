#!/usr/bin/env node
// 假 ACP Agent：用于 spike 脚本自测，也预留给 testkit（可用 --command 覆盖）。
// 行为由 prompt 文本关键字驱动；环境变量 FAKE_AUTH_REQUIRED=1 时 session/new 返回 -32000。
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const sessions = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mcpCall(server, name, args) {
  const headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]));
  headers['content-type'] = 'application/json';
  headers.accept = 'application/json, text/event-stream';
  const post = async (body) => {
    const r = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const res = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  return res?.result?.content?.[0]?.text ?? JSON.stringify(res);
}

class FakeAgent {
  constructor(conn) { this.conn = conn; }
  async initialize(params) {
    const terminal = params.clientCapabilities?.auth?.terminal === true;
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: {},
      },
      authMethods: terminal ? [{ id: 'fake-login', name: 'Fake login', type: 'terminal', args: ['--login'] }] : [],
      _meta: { steering: { supported: true } },
    };
  }
  async authenticate() { return {}; }
  async newSession(params) {
    if (process.env.FAKE_AUTH_REQUIRED === '1') throw acp.RequestError.authRequired(undefined, 'Authentication required');
    const sessionId = `fake-${sessions.size + 1}`;
    sessions.set(sessionId, { cancelled: false, steer: null, mcpServers: params.mcpServers ?? [], mode: 'default' });
    return {
      sessionId,
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] },
    };
  }
  async setSessionMode(params) { sessions.get(params.sessionId).mode = params.modeId; return {}; }
  async extMethod(method, params) {
    if (method !== '_session/steering') throw acp.RequestError.methodNotFound(method);
    const s = sessions.get(params.sessionId);
    if (!s.running) return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    s.steer = params.prompt;
    return { outcome: 'injected' };
  }
  async cancel(params) { const s = sessions.get(params.sessionId); if (s) s.cancelled = true; }
  async prompt(params) {
    const s = sessions.get(params.sessionId);
    s.cancelled = false; s.steer = null; s.running = true;
    const text = params.prompt.map((b) => b.text ?? '').join('\n');
    const send = (update) => this.conn.sessionUpdate({ sessionId: params.sessionId, update });
    const say = (t) => send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
    try {
      if (text.includes('FINISHED')) {
        await send({ sessionUpdate: 'tool_call', toolCallId: 'tc-long', title: 'bash: loop', kind: 'execute', status: 'in_progress', rawInput: { command: 'loop' } });
        for (let i = 1; i <= 30; i += 1) {
          await sleep(300);
          if (s.cancelled) return { stopReason: 'cancelled' };
          if (s.steer) { await say('STEERED'); return { stopReason: 'end_turn' }; }
          await say(`${i}\n`);
        }
        await say('FINISHED');
      } else if (text.includes('"echo"')) {
        const server = s.mcpServers[0];
        await send({ sessionUpdate: 'tool_call', toolCallId: 'tc-mcp', title: `${server.name}/echo`, kind: 'other', status: 'pending', rawInput: { text: 'ping-123' } });
        const out = await mcpCall(server, 'echo', { text: 'ping-123' });
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-mcp', status: 'completed', rawOutput: out });
        await say(`tool: echo; result: ${out}`);
      } else if (text.includes('web_search') || text.includes('tool_policy')) {
        await send({ sessionUpdate: 'tool_call', toolCallId: 'tc-ws', title: 'WebSearch', kind: 'search', status: 'completed', rawInput: { query: 'node lts' } });
        await say('Node.js 24');
      } else if (text.includes('shell command') || text.includes('Create the file') || text.includes('Read the file')) {
        const r = await this.conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'tc-perm', title: 'Run: echo spike-ok', kind: 'execute', status: 'pending' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        });
        await say(`permission outcome: ${JSON.stringify(r.outcome)}`);
      } else if (text.includes('fs-probe')) {
        try { await this.conn.readTextFile({ sessionId: params.sessionId, path: '/etc/hostname' }); await say('fs ok'); } catch (e) { await say(`fs error ${e.code}`); }
      } else if (text.includes('JSON')) {
        await say('{"answer": 51, "words": ["apple", "pear"]}');
      } else {
        await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
        await send({ sessionUpdate: 'tool_call', toolCallId: 'tc-ls', title: 'ls', kind: 'search', status: 'completed', rawInput: { path: '.' } });
        await send({ sessionUpdate: 'plan', entries: [{ content: 'step', priority: 'medium', status: 'pending' }] });
        await say('There is one file.');
        await send({ sessionUpdate: 'usage_update', used: 10, size: 1000 });
      }
      return { stopReason: 'end_turn' };
    } finally { s.running = false; }
  }
}

if (process.argv.includes('--login')) {
  process.stdout.write('fake login ok\n');
  process.exit(0);
}
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
