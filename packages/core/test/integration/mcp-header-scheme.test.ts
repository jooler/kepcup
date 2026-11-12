import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer, PluginManifest, SecretsService, Settings } from '@kepcup/shared';
import { TestClock } from '@kepcup/testkit';
import { McpService, type McpServiceDeps } from '../../src/mcp/service.js';
import { createManifestHeaderNormalizer } from '../../src/mcp/header-scheme.js';

/**
 * 发送侧凭据方案的端到端验证（真实 http 传输 + 真实 MCP JSON-RPC 往返）：
 * 腾讯文档 MCP 硬要求 `Authorization: Bearer <token>`，而用户只粘裸 token。
 * 这里断言「插件清单声明了 `scheme: 'bearer'` 的 header 在请求里带前缀」，
 * 并确认同 server 的其他 header、手填的通用 MCP server 完全不受影响。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const PLUGIN_ID = 'app.kepcup/mcp-tencent-docs';

function manifestWith(headers: Array<{ name: string; key?: string; scheme?: 'bearer' }>): PluginManifest {
  return {
    format_version: 1,
    id: PLUGIN_ID,
    name: '腾讯文档',
    version: '1.0.3',
    description: '',
    author: { name: 'KepCup' },
    usage: '',
    engines: { kepcup: '>=0.5.11' },
    instances: ['mcp'],
    contributions: {
      skills: [],
      connectors: [],
      mail: [],
      im: [],
      mcp: [
        {
          kind: 'http',
          id: 'docs',
          url: 'https://docs.qq.com/openapi/mcp',
          auth: 'headers',
          headers,
        },
      ],
    },
    config: { fields: [] },
  } as unknown as PluginManifest;
}

const BEARER_MANIFEST = manifestWith([
  { name: 'Authorization', key: 'token', scheme: 'bearer' },
  { name: 'X-Api-Key', key: 'apiKey' },
]);

interface Captured {
  headers: IncomingHttpHeaders;
}

const servers: Server[] = [];
const services: McpService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.closeAll().catch(() => {});
  for (const server of servers.splice(0)) server.close();
});

/** 最小 streamable-http MCP server：记录每次请求头，initialize / tools/list 正常应答。 */
async function startFakeMcpHttpServer(): Promise<{ url: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    captured.push({ headers: req.headers });
    if (req.method === 'GET') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => {
      let message: { id?: unknown; method?: string } = {};
      try {
        message = JSON.parse(body) as typeof message;
      } catch {
        // 非 JSON：按协议错误处理。
      }
      const method = message.method ?? '';
      if (method.startsWith('notifications/')) {
        res.writeHead(202).end();
        return;
      }
      const result =
        method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake-tencent-docs', version: '1.0.0' },
            }
          : method === 'tools/list'
            ? { tools: [{ name: 'search_doc', inputSchema: { type: 'object', properties: {} } }] }
            : {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp`, captured };
}

function makeService(stored: Record<string, string>): McpService {
  const secrets = {
    getValue: (name: string) => stored[name] ?? null,
    hasValue: (name: string) => name in stored,
    redact: (text: string) => text,
  } as unknown as SecretsService;
  const deps: McpServiceDeps = {
    settings: { get: () => ({ mcpServers: [] }) as Settings },
    secrets,
    logger,
    clock: new TestClock(1_000),
    statusSink: { emit: () => {} },
  };
  const service = new McpService(deps);
  service.attachHeaderNormalizer(
    createManifestHeaderNormalizer({ manifestOf: async () => BEARER_MANIFEST }),
  );
  services.push(service);
  return service;
}

function instanceServerOf(url: string): McpServer {
  return {
    id: 'plg_tencent',
    name: '腾讯文档',
    transport: 'http',
    url,
    enabled: true,
    autoApprove: false,
    auth: 'headers',
    headers: {
      Authorization: 'secret:header:Authorization',
      'X-Api-Key': 'secret:header:X-Api-Key',
    },
    source: { kind: 'instance', pluginId: PLUGIN_ID, instanceId: 'pli_1' },
  } as McpServer;
}

describe('mcp 发送侧 Bearer 归一化（真实 http 传输）', () => {
  it('保存的裸 token 在请求头里自动补 `Bearer `；其他 header 原样发送', async () => {
    const fake = await startFakeMcpHttpServer();
    const service = makeService({
      'mcp:plg_tencent:header:Authorization': 'tok_abc123',
      'mcp:plg_tencent:header:X-Api-Key': 'Bearer keep-me',
    });

    const tools = await service.listTools(instanceServerOf(fake.url));
    expect(tools.map((tool) => tool.name)).toEqual(['search_doc']);

    const initialize = fake.captured[0]!;
    expect(initialize.headers.authorization).toBe('Bearer tok_abc123');
    // 同一 server 里没声明方案的 header 不被这条规则改写。
    expect(initialize.headers['x-api-key']).toBe('Bearer keep-me');
  });

  it('旧记录里已带前缀（大小写 / 空白变体）也只发一个 `Bearer `', async () => {
    const fake = await startFakeMcpHttpServer();
    const service = makeService({
      'mcp:plg_tencent:header:Authorization': '  BEARER   tok_legacy ',
      'mcp:plg_tencent:header:X-Api-Key': 'key-1',
    });

    await service.listTools(instanceServerOf(fake.url));
    expect(fake.captured[0]!.headers.authorization).toBe('Bearer tok_legacy');
  });

  it('手填的通用 MCP server（非插件实例）完全不加前缀', async () => {
    const fake = await startFakeMcpHttpServer();
    const service = makeService({ 'mcp:mcp_manual:header:Authorization': 'tok_raw' });
    const manual = {
      id: 'mcp_manual',
      name: '手填',
      transport: 'http',
      url: fake.url,
      enabled: true,
      autoApprove: false,
      auth: 'headers',
      headers: { Authorization: 'secret:header:Authorization' },
    } as McpServer;

    await service.listTools(manual);
    expect(fake.captured[0]!.headers.authorization).toBe('tok_raw');
  });
});
