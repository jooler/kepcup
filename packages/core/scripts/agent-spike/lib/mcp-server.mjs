// 最小 Streamable HTTP MCP server（仅 127.0.0.1）：JSON 响应、无 SSE、无会话状态。
// 记录每次请求（脱敏前的原始 Authorization 仅用于比对，不入日志）。
import http from 'node:http';
import crypto from 'node:crypto';

export const DEFAULT_TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the given text. Used by the KepCup spike to verify MCP injection.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: ({ text }) => `echo: ${text}`,
  },
];

export const NATIVE_FIRST_TOOLS = [
  {
    name: 'web_search',
    description: '[补充能力] 联网搜索。仅当你自身没有联网搜索 / 网页抓取工具时才使用本工具。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: ({ query }) => `SPIKE-STUB web_search result for "${query}": Node.js 24.x is the Active LTS line (stub data).`,
  },
];

export async function startMcpServer({ tools = DEFAULT_TOOLS, name = 'kepcup-spike' } = {}) {
  const token = crypto.randomBytes(18).toString('hex');
  const expectedAuth = `Bearer ${token}`;
  const log = [];
  const toolCalls = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const entry = {
        at: new Date().toISOString(),
        httpMethod: req.method,
        path: req.url,
        authHeaderPresent: req.headers.authorization !== undefined,
        authHeaderMatches: req.headers.authorization === expectedAuth,
        userAgent: req.headers['user-agent'],
        accept: req.headers.accept,
        mcpProtocolVersion: req.headers['mcp-protocol-version'],
        mcpSessionId: req.headers['mcp-session-id'],
        rpc: [],
      };
      log.push(entry);

      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }

      let msg;
      try { msg = JSON.parse(bodyText); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        return;
      }
      const batch = Array.isArray(msg);
      const responses = [];
      for (const m of batch ? msg : [msg]) {
        entry.rpc.push({ method: m.method, id: m.id, params: m.method === 'tools/call' ? m.params : undefined });
        const r = handle(m);
        if (r) responses.push(r);
      }
      if (!responses.length) { res.writeHead(202).end(); return; }
      const headers = { 'content-type': 'application/json' };
      if ((batch ? msg : [msg]).some((m) => m.method === 'initialize')) headers['mcp-session-id'] = crypto.randomUUID();
      res.writeHead(200, headers);
      res.end(JSON.stringify(batch ? responses : responses[0]));
    });
  });

  function handle(m) {
    if (m.id === undefined) return null; // 通知
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    switch (m.method) {
      case 'initialize':
        return ok({
          protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version: '0' },
        });
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: tools.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === m.params?.name);
        toolCalls.push({ at: new Date().toISOString(), name: m.params?.name, arguments: m.params?.arguments });
        if (!tool) return fail(-32602, `unknown tool ${m.params?.name}`);
        return ok({ content: [{ type: 'text', text: tool.handler(m.params?.arguments ?? {}) }] });
      }
      default: return fail(-32601, `method not found: ${m.method}`);
    }
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    url, token, name, port,
    /** ACP session/new 的 mcpServers 项 */
    acpServer: { type: 'http', name, url, headers: [{ name: 'Authorization', value: expectedAuth }] },
    log, toolCalls,
    summary() {
      const methods = log.flatMap((e) => e.rpc.map((r) => r.method));
      return {
        httpRequests: log.length,
        rpcMethods: [...new Set(methods)],
        toolsListed: methods.includes('tools/list'),
        toolCalls: [...toolCalls],
        everAuthorized: log.some((e) => e.authHeaderMatches),
        everUnauthorized: log.some((e) => !e.authHeaderMatches),
        authHeaderPresentOnAll: log.length > 0 && log.every((e) => e.authHeaderPresent),
        userAgents: [...new Set(log.map((e) => e.userAgent).filter(Boolean))],
        protocolVersions: [...new Set(log.map((e) => e.mcpProtocolVersion).filter(Boolean))],
        nonPostRequests: log.filter((e) => e.httpMethod !== 'POST').map((e) => `${e.httpMethod} ${e.path}`),
      };
    },
    reset() { log.length = 0; toolCalls.length = 0; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
