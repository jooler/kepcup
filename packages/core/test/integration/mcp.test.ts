import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type McpServer, type Settings, type SecretsService } from '@kepcup/shared';
import { TestClock } from '@kepcup/testkit';
import { McpService, type McpServiceDeps } from '../../src/mcp/service.js';
import { buildMcpTools } from '../../src/mcp/tools.js';
import { decideMcpTool } from '../../src/mcp/policy.js';
import { ToolGateway, type GatewayDeps } from '../../src/gateway/index.js';
import { resolvePaths } from '../../src/infra/paths.js';
import { UnavailableSandboxBackend } from '../../src/sandbox/types.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * MCP（D65）集成（真实 stdio 传输，内联 node 脚本做最小 MCP server）：
 * 懒连接 → tools 列表 → 工具包装（<untrusted> / isError 映射）→ 密钥占位符
 * 解析 → 进程被杀后重连与失败计数。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

const SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1.0.0' },
    } });
    return;
  }
  if (String(msg.method).startsWith('notifications/')) return;
  if (msg.method === 'ping') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: '回显输入',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'always_fails', description: '总是失败', inputSchema: { type: 'object', properties: {} } },
      { name: 'secret_reader', description: '读取环境变量证密钥已解析',
        inputSchema: { type: 'object', properties: {} } },
    ] } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = String(msg.params?.name ?? '');
    const args = msg.params?.arguments ?? {};
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'echo:' + String(args.text ?? '') }], isError: false } });
    } else if (name === 'always_fails') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'boom' }], isError: true } });
    } else if (name === 'secret_reader') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'TOKEN=' + (process.env.TOKEN ?? 'MISSING') }], isError: false } });
    }
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope: ' + msg.method } });
});
`;

const tempDirs: string[] = [];
const services: McpService[] = [];
const servers: Server[] = [];
const sessions = new Map<string, ServerResponse>();

afterEach(async () => {
  for (const service of services.splice(0)) await service.closeAll().catch(() => {});
  for (const server of servers.splice(0)) server.close();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeScriptPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'server.cjs');
  await writeFile(file, SERVER_SCRIPT);
  return file;
}

function makeDeps(overrides?: Partial<McpServiceDeps>): McpServiceDeps {
  const secrets = {
    getValue: (name: string) => (name === 'mcp:srv1:env:TOKEN' ? 'real-token-value' : null),
    hasValue: (name: string) => name === 'mcp:srv1:env:TOKEN',
    redact: (text: string) => text,
  } as unknown as SecretsService;
  return {
    settings: { get: () => ({ mcpServers: [] }) as Settings },
    secrets,
    logger,
    clock: new TestClock(1_000),
    statusSink: { emit: () => {} },
    ...overrides,
  };
}

function serverOf(scriptPath: string, overrides?: Partial<McpServer>): McpServer {
  return {
    id: 'srv1',
    name: '测试服务器',
    transport: 'stdio',
    command: process.execPath,
    args: [scriptPath],
    env: { TOKEN: 'secret:env:TOKEN' },
    enabled: true,
    autoApprove: false,
    ...overrides,
  };
}

const identity = {
  runId: 'run_1',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'turn' as const,
};

describe('mcp stdio integration', () => {
  it('lists tools through the real transport with names sanitized', async () => {
    const scriptPath = await makeScriptPath();
    const service = new McpService(makeDeps());
    services.push(service);
    const tools = await service.listTools(serverOf(scriptPath));
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'always_fails',
      'echo',
      'secret_reader',
    ]);
  });

  it('wraps tools: echo returns untrusted text; always_fails maps to ok:false', async () => {
    const scriptPath = await makeScriptPath();
    const service = new McpService(makeDeps());
    services.push(service);
    const gateway = {
      mcpToolCall: async () => {},
      audit: () => {},
      logger,
    };
    const tools = await buildMcpTools({
      identity,
      servers: [serverOf(scriptPath)],
      mcp: service,
      gateway: gateway as never,
      secrets: makeDeps().secrets,
      logger,
    });
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['mcp_srv1_always_fails', 'mcp_srv1_echo', 'mcp_srv1_secret_reader']);

    const echo = tools.find((tool) => tool.name === 'mcp_srv1_echo')!;
    const echoResult = await echo.execute({ text: '你好' }, { ...identityContext() });
    expect(echoResult.ok).toBe(true);
    expect(echoResult.content).toContain('echo:你好');
    expect(echoResult.content.startsWith('<untrusted>')).toBe(true);

    const fail = tools.find((tool) => tool.name === 'mcp_srv1_always_fails')!;
    const failResult = await fail.execute({}, identityContext());
    expect(failResult.ok).toBe(false);
    expect(failResult.errorCode).toBe('MCP_CALL_FAILED');
    expect(failResult.content).toContain('boom');

    // 密钥占位符经 secrets 解析后才传给 server 进程。
    const secretReader = tools.find((tool) => tool.name === 'mcp_srv1_secret_reader')!;
    const secretResult = await secretReader.execute({}, identityContext());
    expect(secretResult.content).toContain('TOKEN=real-token-value');
  });

  it('kills the server process, reconnects on the next call', async () => {
    const scriptPath = await makeScriptPath();
    const service = new McpService(makeDeps());
    services.push(service);
    const server = serverOf(scriptPath);

    await service.listTools(server);
    // 杀掉 stdio server 进程：找到 node <script> 子进程。
    const { execSync } = await import('node:child_process');
    try {
      execSync(`pkill -f "${scriptPath.replace(/\//g, '\\/')}"`);
    } catch {
      // pkill 无匹配返回非零：进程已死也无妨。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    // 下一次调用自动重连成功。
    const tools = await service.listTools(server);
    expect(tools.map((tool) => tool.name)).toContain('echo');
  });

  it('marks the server failed after repeated connect failures', async () => {
    const service = new McpService(makeDeps());
    services.push(service);
    const dead = serverOf('/nonexistent/server.cjs');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.listTools(dead)).rejects.toMatchObject({ code: 'MCP_CONNECT_FAILED' });
    }
    // 重试超限：转为 MCP_SERVER_FAILED。
    await expect(service.listTools(dead)).rejects.toMatchObject({ code: 'MCP_SERVER_FAILED' });
  });

  it('missing secrets stay as placeholders and are reported by testServer', async () => {
    const scriptPath = await makeScriptPath();
    const service = new McpService(makeDeps());
    services.push(service);
    const report = await service.testServer(
      serverOf(scriptPath, { env: { TOKEN: 'secret:env:TOKEN', OTHER: 'secret:env:MISSING' } }),
    );
    expect(report.missingSecrets).toEqual(['secret:env:MISSING']);
    expect(report.tools).toContain('echo');
  });

  it('testServer resolves draft secret overrides without the secrets store', async () => {
    const scriptPath = await makeScriptPath();
    const service = new McpService(makeDeps());
    services.push(service);
    // 草稿 id 未落过 secrets：占位符只能靠 secretValues 解析（设置页保存前测试）。
    const draft = serverOf(scriptPath, { id: 'srv_draft', env: { TOKEN: 'secret:env:TOKEN' } });
    const report = await service.testServer(draft, { env: { TOKEN: 'draft-token' } });
    expect(report.missingSecrets).toEqual([]);
    expect(report.tools).toContain('echo');
    // 未带覆盖时同一占位符照旧上报 missing。
    const bare = await service.testServer(draft);
    expect(bare.missingSecrets).toEqual(['secret:env:TOKEN']);
  });

  it('connects to a legacy HTTP-with-SSE server via the sse transport', async () => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/sse') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.write('event: endpoint\ndata: /messages?sessionId=s1\n\n');
        sessions.set('s1', res);
        req.on('close', () => sessions.delete('s1'));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const sink = sessions.get(url.searchParams.get('sessionId') ?? '');
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          if (!sink) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(202).end();
          const msg = JSON.parse(raw) as { id?: number; method?: string };
          if (msg.method === 'initialize') {
            sink.write(`event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'sse-fake', version: '1.0.0' },
              },
            })}\n\n`);
            return;
          }
          if (msg.method === 'tools/list') {
            sink.write(`event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  { name: 'echo', description: '回显', inputSchema: { type: 'object', properties: {} } },
                ],
              },
            })}\n\n`);
          }
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const service = new McpService(makeDeps());
    services.push(service);
    const port = (server.address() as { port: number }).port;
    const report = await service.testServer({
      id: 'srv_sse',
      name: 'sse',
      transport: 'sse',
      url: `http://127.0.0.1:${port}/sse`,
      enabled: true,
      autoApprove: false,
    });
    expect(report.missingSecrets).toEqual([]);
    expect(report.tools).toContain('echo');
  });

  it('hints at endpoint path / protocol type when http test hits 404', async () => {
    const server = createServer((req, res) => {
      res.writeHead(404).end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const service = new McpService(makeDeps());
    services.push(service);
    const port = (server.address() as { port: number }).port;
    const error = await service
      .testServer({
        id: 'srv_404',
        name: '404',
        transport: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        enabled: true,
        autoApprove: false,
      })
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain('把类型改为 SSE');
  });

  it('hints at Bearer header setup when http test hits 401', async () => {
    const server = createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'Missing or invalid Authorization' }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const service = new McpService(makeDeps());
    services.push(service);
    const port = (server.address() as { port: number }).port;
    const error = await service
      .testServer({
        id: 'srv_401',
        name: '401',
        transport: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        enabled: true,
        autoApprove: false,
      })
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain('Bearer');
    expect((error as Error).message).toContain('Authorization');
  });
});

function identityContext(ctxIdentity: RunIdentity = identity) {
  return {
    identity: ctxIdentity,
    signal: new AbortController().signal,
    terminate: () => {},
    progress: () => {},
  };
}

// --- W5: risk tiers, per-tool policies, read-only surface ---------------------

/**
 * 带注解的最小 MCP server：list_notes（readOnlyHint）、create_note
 * （destructiveHint:false → write）、purge（无注解 → destructive）、
 * get_status（无注解 + 只读动词 → read）、hidden_tool（被策略停用）。调用
 * flip 后 list_notes 改报 readOnlyHint:false 并发 tools/list_changed（调用时
 * 风险重新解析）。
 */
const ANNOTATED_SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
let flipped = false;
function tools() {
  const empty = { type: 'object', properties: {} };
  return [
    { name: 'list_notes', description: '列出笔记', inputSchema: empty,
      annotations: flipped ? { readOnlyHint: false } : { readOnlyHint: true } },
    { name: 'create_note', description: '新建笔记', inputSchema: empty,
      annotations: { destructiveHint: false } },
    { name: 'purge', description: '清空', inputSchema: empty },
    { name: 'get_status', description: '状态', inputSchema: empty },
    { name: 'hidden_tool', description: '被停用', inputSchema: empty, annotations: { readOnlyHint: true } },
    { name: 'flip', description: '改注解', inputSchema: empty, annotations: { readOnlyHint: true } },
  ];
}
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'annotated', version: '1.0.0' } } });
    return;
  }
  if (String(msg.method).startsWith('notifications/')) return;
  if (msg.method === 'ping') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: tools() } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = String(msg.params?.name ?? '');
    if (name === 'flip') {
      flipped = true;
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: 'called:' + name }], isError: false } });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
});
`;

async function makeAnnotatedServer(overrides?: Partial<McpServer>): Promise<McpServer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-risk-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'server.cjs');
  await writeFile(file, ANNOTATED_SERVER_SCRIPT);
  return {
    id: 'ann',
    name: '注解服务器',
    transport: 'stdio',
    command: process.execPath,
    args: [file],
    enabled: true,
    autoApprove: false,
    toolPolicies: { hidden_tool: { enabled: false } },
    ...overrides,
  };
}

interface Harness {
  service: McpService;
  gateway: ToolGateway;
  setServer(next: McpServer): void;
  approvalRequests: Array<{ kind: string; payload: Record<string, unknown> }>;
  audit: Array<{ action: string; detail: Record<string, unknown> }>;
}

/** Real McpService + real ToolGateway (approvals / audit stubbed, unattended off). */
async function makeHarness(
  initial: McpServer,
  answer: 'approved' | 'denied' = 'approved',
  unattended = false,
): Promise<Harness> {
  let current = initial;
  const service = new McpService(
    makeDeps({ settings: { get: () => ({ mcpServers: [current] }) as unknown as Settings } as never }),
  );
  services.push(service);
  const approvalRequests: Harness['approvalRequests'] = [];
  const audit: Harness['audit'] = [];
  const home = await mkdtemp(path.join(tmpdir(), 'mcp-gw-'));
  tempDirs.push(home);
  const deps: GatewayDeps = {
    paths: resolvePaths(home),
    sandbox: new UnavailableSandboxBackend('test'),
    audit: {
      record: (_identity: unknown, action: string, detail: Record<string, unknown>) =>
        audit.push({ action, detail }),
    } as unknown as GatewayDeps['audit'],
    secrets: { redact: (text: string) => text } as unknown as GatewayDeps['secrets'],
    logger: logger as GatewayDeps['logger'],
    approvals: {
      request: async (_identity: unknown, kind: string, payload: Record<string, unknown>) => {
        approvalRequests.push({ kind, payload });
        // Unattended mode: ApprovalsService auto-approves every mcp_tool tier.
        return { approval: { id: 'apr', autoApproved: unattended }, decision: answer };
      },
    } as unknown as GatewayDeps['approvals'],
    grants: {} as GatewayDeps['grants'],
    allowlist: {} as GatewayDeps['allowlist'],
    unattended: {} as GatewayDeps['unattended'],
    projects: {} as GatewayDeps['projects'],
    platform: 'linux',
    readOnlyRootsOverride: [],
    sensitiveOverride: [],
    mcpToolDecision: async ({ serverId, toolName, signal }) => {
      if (current.id !== serverId) throw new Error('unknown server');
      return decideMcpTool(
        current,
        toolName,
        await service.resolveRisk(current, toolName, signal !== undefined ? { signal } : {}),
      );
    },
  };
  return {
    service,
    gateway: new ToolGateway(deps),
    setServer: (next) => {
      current = next;
    },
    approvalRequests,
    audit,
  };
}

const taskIdentity: RunIdentity = { runId: 'run_task', botId: 'bot_1', conversationId: 'conv_1', loopType: 'task' };
const turnIdentity: RunIdentity = { runId: 'run_turn', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' };

describe('mcp risk tiers and per-tool policies (W5)', () => {
  it('classifies annotated tools; toolRisks keeps policies of vanished tools as missing', async () => {
    const server = await makeAnnotatedServer({
      toolPolicies: { hidden_tool: { enabled: false }, gone_tool: { approval: 'auto' } },
    });
    const { service } = await makeHarness(server);
    const report = await service.toolRisks('ann');
    const byName = Object.fromEntries(report.tools.map((t) => [t.name, t]));
    expect(byName['list_notes']).toMatchObject({ risk: 'read', source: 'annotation', missing: false });
    expect(byName['create_note']).toMatchObject({ risk: 'write', source: 'annotation' });
    expect(byName['purge']).toMatchObject({ risk: 'destructive', source: 'default' });
    expect(byName['get_status']).toMatchObject({ risk: 'read', source: 'name' });
    // The policy of a tool the server no longer lists survives (greyed out in settings).
    expect(byName['gone_tool']).toMatchObject({ missing: true, risk: 'destructive' });
    expect(report.error).toBeUndefined();
    // riskOf answers synchronously from the cached annotations.
    expect(service.riskOf('ann', 'create_note')).toEqual({ risk: 'write', source: 'annotation' });
    expect(service.riskOf('ann', 'never_listed')).toEqual({ risk: 'destructive', source: 'default' });
  });

  it('read tools run without a card; write tools ask with risk in the payload; audit records the risk', async () => {
    const server = await makeAnnotatedServer();
    const h = await makeHarness(server);
    const tools = await buildMcpTools({
      identity: taskIdentity,
      servers: [server],
      mcp: h.service,
      gateway: h.gateway,
      secrets: makeDeps().secrets,
      logger,
    });
    const byName = new Map(tools.map((t) => [t.name, t]));
    // enabled:false is not registered.
    expect(byName.has('mcp_ann_hidden_tool')).toBe(false);
    expect(byName.has('mcp_ann_purge')).toBe(true);

    const read = await byName.get('mcp_ann_list_notes')!.execute({}, identityContext(taskIdentity));
    expect(read.ok).toBe(true);
    expect(read.content.startsWith('<untrusted>')).toBe(true);
    expect(h.approvalRequests).toHaveLength(0);

    const write = await byName.get('mcp_ann_create_note')!.execute({}, identityContext(taskIdentity));
    expect(write.ok).toBe(true);
    expect(h.approvalRequests).toEqual([
      expect.objectContaining({ kind: 'mcp_tool', payload: expect.objectContaining({ toolName: 'create_note', risk: 'write' }) }),
    ]);
    await byName.get('mcp_ann_purge')!.execute({}, identityContext(taskIdentity));
    expect(h.approvalRequests[1]!.payload['risk']).toBe('destructive');

    const calls = h.audit.filter((a) => a.action === 'mcp_tool_call');
    expect(calls.map((c) => [c.detail['toolName'], c.detail['risk'], c.detail['approval']])).toEqual([
      ['list_notes', 'read', 'auto'],
      ['create_note', 'write', 'user'],
      ['purge', 'destructive', 'user'],
    ]);
    expect(calls.every((c) => c.detail['unattendedAutoApproved'] === false)).toBe(true);
  });

  it('tool policy beats server autoApprove beats the risk default', async () => {
    const server = await makeAnnotatedServer({
      autoApprove: true,
      toolPolicies: { purge: { approval: 'ask' }, hidden_tool: { enabled: false } },
    });
    const h = await makeHarness(server);
    // autoApprove: the write tool runs without a card…
    await h.gateway.mcpToolCall(taskIdentity, server, 'create_note', {});
    expect(h.approvalRequests).toHaveLength(0);
    // …but the per-tool ask takes it back.
    await h.gateway.mcpToolCall(taskIdentity, server, 'purge', {});
    expect(h.approvalRequests.map((r) => r.payload['toolName'])).toEqual(['purge']);
    // A read tool switched to ask asks, and a write tool switched to auto does not.
    h.setServer({
      ...server,
      autoApprove: false,
      toolPolicies: { list_notes: { approval: 'ask' }, create_note: { approval: 'auto' } },
    });
    await h.gateway.mcpToolCall(taskIdentity, server, 'list_notes', {});
    await h.gateway.mcpToolCall(taskIdentity, server, 'create_note', {});
    expect(h.approvalRequests.map((r) => r.payload['toolName'])).toEqual(['purge', 'list_notes']);
    // Disabled at call time (settings changed mid-run): refused.
    h.setServer({ ...server, toolPolicies: { create_note: { enabled: false } } });
    await expect(h.gateway.mcpToolCall(taskIdentity, server, 'create_note', {})).rejects.toMatchObject({
      code: 'MCP_TOOL_NOT_FOUND',
    });
  });

  it('unattended auto-approval of a write tool is recorded in the mcp_tool_call audit', async () => {
    const server = await makeAnnotatedServer();
    const h = await makeHarness(server, 'approved', true);
    const outcome = await h.gateway.mcpToolCall(taskIdentity, server, 'purge', {});
    expect(outcome.approvedBy).toBe('unattended');
    expect(h.approvalRequests[0]!.payload['risk']).toBe('destructive');
    expect(h.audit.find((a) => a.action === 'mcp_tool_call')?.detail).toMatchObject({
      risk: 'destructive',
      approval: 'unattended',
      unattendedAutoApproved: true,
      note: '无人值守自动批准（破坏性）',
    });
  });

  it('W4 exact card: a write tool lists recipient fields in full outside the 400-char argsSummary; read tools do not', async () => {
    const server = await makeAnnotatedServer({
      toolPolicies: { list_notes: { approval: 'ask' }, hidden_tool: { enabled: false } },
    });
    const h = await makeHarness(server);
    // Connected: risks come from the annotations (offline, unknown tools are destructive).
    await h.service.listTools(server);
    const to = Array.from({ length: 40 }, (_, i) => `member${i}@example.com`);
    await h.gateway.mcpToolCall(taskIdentity, server, 'create_note', {
      to,
      message: { chat_id: 'C-42', body: 'x'.repeat(600) },
    });
    const payload = h.approvalRequests[0]!.payload;
    expect(String(payload['argsSummary'])).toContain('（已截断）');
    expect(payload['recipients']).toEqual([
      { key: 'to', value: to.join(', ') },
      { key: 'message.chat_id', value: 'C-42' },
    ]);
    // A read tool switched to ask: its card has no recipients section.
    await h.gateway.mcpToolCall(taskIdentity, server, 'list_notes', { user: 'u1' });
    expect(h.approvalRequests[1]!.payload['risk']).toBe('read');
    expect(h.approvalRequests[1]!.payload['recipients']).toBeUndefined();
  });

  it('a denied write approval maps to APPROVAL_DENIED', async () => {
    const server = await makeAnnotatedServer();
    const h = await makeHarness(server, 'denied');
    await expect(h.gateway.mcpToolCall(taskIdentity, server, 'create_note', {})).rejects.toMatchObject({
      code: 'APPROVAL_DENIED',
    });
  });

  it('read-only surface: only read + auto tools; risk re-resolved at call time (RUN_READ_ONLY)', async () => {
    const server = await makeAnnotatedServer();
    const h = await makeHarness(server);
    const turnTools = await buildMcpTools({
      identity: turnIdentity,
      servers: [server],
      mcp: h.service,
      gateway: h.gateway,
      secrets: makeDeps().secrets,
      logger,
      surface: 'readOnly',
    });
    expect(turnTools.map((t) => t.name).sort()).toEqual([
      'mcp_ann_flip',
      'mcp_ann_get_status',
      'mcp_ann_list_notes',
    ]);
    const listNotes = turnTools.find((t) => t.name === 'mcp_ann_list_notes')!;
    const first = await listNotes.execute({}, identityContext(turnIdentity));
    expect(first.ok).toBe(true);
    expect(first.content).toContain('called:list_notes');

    // A write tool called from a turn (not on its surface, but called anyway) is refused.
    await expect(h.gateway.mcpToolCall(turnIdentity, server, 'create_note', {})).rejects.toMatchObject({
      code: 'RUN_READ_ONLY',
      message: '该工具需要在任务中执行，请用 start_task',
    });
    // Same for a delegate_task sub run (read-only research surface).
    await expect(
      h.gateway.mcpToolCall({ ...turnIdentity, runId: 'run_sub', loopType: 'subagent' }, server, 'purge', {}),
    ).rejects.toMatchObject({ code: 'RUN_READ_ONLY' });

    // The server flips list_notes to readOnlyHint:false (tools/list_changed): the
    // next call re-resolves the risk and the turn refuses it.
    const flip = turnTools.find((t) => t.name === 'mcp_ann_flip')!;
    expect((await flip.execute({}, identityContext(turnIdentity))).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await listNotes.execute({}, identityContext(turnIdentity));
    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('RUN_READ_ONLY');
    expect(second.content).toContain('start_task');
    expect(h.service.riskOf('ann', 'list_notes')).toEqual({ risk: 'destructive', source: 'annotation' });
    expect(h.approvalRequests).toHaveLength(0);

    // A read tool the user switched to ask leaves the read-only surface.
    const asked: McpServer = {
      ...server,
      toolPolicies: { hidden_tool: { enabled: false }, get_status: { approval: 'ask' } },
    };
    h.setServer(asked);
    const again = await buildMcpTools({
      identity: turnIdentity,
      servers: [asked],
      mcp: h.service,
      gateway: h.gateway,
      secrets: makeDeps().secrets,
      logger,
      surface: 'readOnly',
    });
    expect(again.map((t) => t.name)).toEqual(['mcp_ann_flip']);
    await expect(h.gateway.mcpToolCall(turnIdentity, asked, 'get_status', {})).rejects.toMatchObject({
      code: 'RUN_READ_ONLY',
    });
  });
});

// --- W5 review follow-ups: connect dedupe, reconnect budget ------------------

/** Appends one line per process start to SPAWN_LOG, answers initialize after 300 ms. */
const SLOW_SERVER_SCRIPT = `
require('node:fs').appendFileSync(process.env.SPAWN_LOG, 'spawn\\n');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'slow', version: '1.0.0' } } }), 300);
    return;
  }
  if (String(msg.method).startsWith('notifications/')) return;
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'list_things', inputSchema: { type: 'object', properties: {} } },
    ] } });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
});
`;

describe('mcp connection lifecycle (W5 review follow-ups)', () => {
  it('concurrent callers share one in-flight connect (one process spawned)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mcp-slow-'));
    tempDirs.push(dir);
    const script = path.join(dir, 'server.cjs');
    const spawnLog = path.join(dir, 'spawns.log');
    await writeFile(script, SLOW_SERVER_SCRIPT);
    const service = new McpService(makeDeps());
    services.push(service);
    const server = serverOf(script, { env: { SPAWN_LOG: spawnLog } });
    const [a, b, c] = await Promise.all([
      service.listTools(server, { countFailure: false }),
      service.listTools(server),
      service.listTools(server),
    ]);
    expect(a.map((tool) => tool.name)).toEqual(['list_things']);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(spawnLog, 'utf8')).trim().split('\n')).toEqual(['spawn']);
  });

  it('turn / UI connects do not drain the reconnect budget; task connects do', async () => {
    const service = new McpService(makeDeps());
    services.push(service);
    const dead = serverOf('/nonexistent/server.cjs');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.listTools(dead, { countFailure: false })).rejects.toMatchObject({
        code: 'MCP_CONNECT_FAILED',
      });
    }
    // Call-time risk resolution never connects for an offline server: cached
    // annotations only (never listed → destructive), no failure counted.
    expect(await service.resolveRisk(dead, 'list_things')).toEqual({
      risk: 'destructive',
      source: 'default',
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.listTools(dead)).rejects.toMatchObject({ code: 'MCP_CONNECT_FAILED' });
    }
    await expect(service.listTools(dead)).rejects.toMatchObject({ code: 'MCP_SERVER_FAILED' });
    // Once failed, uncounted paths are refused too (no reconnect storm).
    await expect(service.listTools(dead, { countFailure: false })).rejects.toMatchObject({
      code: 'MCP_SERVER_FAILED',
    });
  });
});
