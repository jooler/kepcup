import { describe, expect, it } from 'vitest';
import {
  McpAuthRequiredError,
  McpClient,
  StreamableHttpTransport,
  type AuthProvider,
  type McpFetch,
} from '@earendil-works/pi-mcp';
import { AppAuthRequiredError } from '../../src/apps/auth/errors.js';

/**
 * D73 §4.7 验证问题的锁定测试（pi-mcp@1.0.2 的真实 `StreamableHttpTransport` +
 * `McpClient`，只替换 fetch）：
 *
 * ① `token()` / `onUnauthorized()` 抛出的错误**原样（同一个实例）**穿出传输层，
 *    经 `client.connect` / `listTools` / `callTool` 到达调用方——`McpService` 无需解包
 *    （仍保留对 `cause` 链的防御）。
 * ② GET 事件流收到 401 时，错误只走 `client.onError`，**不**触发 `onClose`、不使连接失败
 *    （连接保持 connected，POST 请求照常）。因此不必对 OAuth 连接关闭 GET 流。
 */

const SERVER_URL = 'http://mcp.test/mcp';

interface StubOptions {
  /** 返回 401 的请求（method + rpc method）。 */
  unauthorized?: (method: string, rpcMethod: string | undefined) => boolean;
  /** 初始化后的 GET 流：401 / 405（无 GET 流）。 */
  get?: 401 | 405;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function stubFetch(options: StubOptions = {}): { fetch: McpFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: McpFetch = async (_input, init) => {
    const method = init?.method ?? 'GET';
    let rpc: { id?: number; method?: string } = {};
    if (method === 'POST' && typeof init?.body === 'string') {
      rpc = JSON.parse(init.body) as { id?: number; method?: string };
    }
    calls.push(`${method} ${rpc.method ?? ''}`.trim());
    if (method === 'GET') {
      return options.get === 401
        ? new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } })
        : new Response('', { status: 405 });
    }
    if (method === 'DELETE') return new Response('', { status: 200 });
    if (options.unauthorized?.(method, rpc.method) === true) {
      return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } });
    }
    if (rpc.method === 'initialize') {
      return json(
        200,
        {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'stub', version: '1' },
          },
        },
        { 'mcp-session-id': 's1' },
      );
    }
    if (rpc.method?.startsWith('notifications/') === true) return new Response('', { status: 202 });
    if (rpc.method === 'tools/list') {
      return json(200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] },
      });
    }
    if (rpc.method === 'tools/call') {
      return json(200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { content: [{ type: 'text', text: 'ok' }] },
      });
    }
    return json(200, { jsonrpc: '2.0', id: rpc.id, result: {} });
  };
  return { fetch, calls };
}

function authError(reason: 'expired' | 'scope' | 'not_connected' = 'expired'): AppAuthRequiredError {
  return new AppAuthRequiredError({ connectionId: 'custom:s', reason });
}

function transportFor(fetch: McpFetch, authProvider: AuthProvider): StreamableHttpTransport {
  return new StreamableHttpTransport({ url: SERVER_URL, fetch, authProvider });
}

describe('① auth errors surface unwrapped through the pi-mcp transport', () => {
  it('onUnauthorized throw during connect → client.connect rejects with the same instance', async () => {
    const error = authError('expired');
    const { fetch } = stubFetch({ unauthorized: () => true });
    const client = new McpClient({ name: 't', version: '0' });
    await expect(
      client.connect(
        transportFor(fetch, {
          token: async () => 'tok',
          onUnauthorized: async () => {
            throw error;
          },
        }),
      ),
    ).rejects.toBe(error);
  });

  it('token() throw during connect → the same instance', async () => {
    const error = authError('not_connected');
    const { fetch } = stubFetch();
    const client = new McpClient({ name: 't', version: '0' });
    await expect(
      client.connect(
        transportFor(fetch, {
          token: async () => {
            throw error;
          },
        }),
      ),
    ).rejects.toBe(error);
  });

  it('onUnauthorized throw on listTools / callTool of an established connection → the same instance', async () => {
    const list = authError('expired');
    const call = authError('scope');
    let phase: 'list' | 'call' | 'ok' = 'ok';
    const { fetch } = stubFetch({
      get: 405,
      unauthorized: (_method, rpcMethod) =>
        (phase === 'list' && rpcMethod === 'tools/list') ||
        (phase === 'call' && rpcMethod === 'tools/call'),
    });
    const client = new McpClient({ name: 't', version: '0' });
    await client.connect(
      transportFor(fetch, {
        token: async () => 'tok',
        onUnauthorized: async () => {
          throw phase === 'list' ? list : call;
        },
      }),
    );
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['echo']);

    phase = 'list';
    await expect(client.listTools()).rejects.toBe(list);
    phase = 'call';
    await expect(client.callTool('echo', {})).rejects.toBe(call);
    // The connection itself is untouched by an auth failure.
    phase = 'ok';
    expect((await client.callTool('echo', {})).content).toHaveLength(1);
    await client.close();
  });

  it('a 401 that survives the provider’s retry surfaces as McpAuthRequiredError (status 401)', async () => {
    const { fetch } = stubFetch({ unauthorized: () => true });
    const client = new McpClient({ name: 't', version: '0' });
    await expect(
      client.connect(
        transportFor(fetch, { token: async () => 'tok', onUnauthorized: async () => undefined }),
      ),
    ).rejects.toBeInstanceOf(McpAuthRequiredError);
  });
});

describe('② a 401 on the GET event stream is not a connection failure', () => {
  it('goes to client.onError only: no onClose, connection stays usable', async () => {
    const error = authError('expired');
    const { fetch, calls } = stubFetch({ get: 401 });
    const client = new McpClient({ name: 't', version: '0' });
    const errors: Error[] = [];
    let closed = 0;
    client.onError((cause) => errors.push(cause));
    client.onClose(() => {
      closed += 1;
    });
    await client.connect(
      transportFor(fetch, {
        token: async () => 'tok',
        onUnauthorized: async () => {
          throw error;
        },
      }),
    );
    // The GET stream opens fire-and-forget after notifications/initialized.
    const deadline = Date.now() + 2_000;
    while (errors.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(calls).toContain('GET');
    expect(errors).toEqual([error]);
    expect(errors[0]).toBe(error);
    expect(closed).toBe(0);
    expect(client.connectionState).toBe('connected');
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['echo']);
    await client.close();
  });
});
