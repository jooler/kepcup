import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type McpServer, type Settings, type SecretsService } from '@kepcup/shared';
import { TestClock } from '@kepcup/testkit';
import { McpService, type McpServiceDeps } from '../../src/mcp/service.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

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

function identityContext() {
  return {
    identity,
    signal: new AbortController().signal,
    terminate: () => {},
    progress: () => {},
  };
}
