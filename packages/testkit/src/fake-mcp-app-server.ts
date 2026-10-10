import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * A small unauthenticated Streamable-HTTP MCP server that serves an MCP Apps UI (D73 P3 §7.5).
 * Stateless (one server + transport per POST). Tools:
 *
 * - `show_dashboard`  read-only, `_meta.ui.resourceUri = ui://fake/dashboard.html` (produces the card);
 * - `refresh_data`    read-only, `_meta.ui.visibility = ['app']` (the app may call it, auto-approved);
 * - `save_note`       WRITE (`readOnlyHint:false`), `visibility = ['app']` (raises the normal mcp_tool card);
 * - `internal_write`  write, NO visibility declared (the app may NOT call it: default deny);
 * - `model_only`      read-only, `visibility = ['model']` (the app may NOT call it).
 *
 * The page is {@link mcpAppFixtureHtml}: a hand-written MCP Apps view (JSON-RPC over postMessage) with a
 * probe battery the e2e drives through `frame.evaluate(() => window.__fixture...)`.
 */

export const FAKE_MCP_APP_RESOURCE_URI = 'ui://fake/dashboard.html';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

export interface FakeMcpAppServerOptions {
  /** `_meta.ui.csp.connectDomains` of the UI resource; `{self}` is replaced by this server's own origin. */
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  /** `_meta.ui.permissions` of the UI resource. */
  permissions?: Record<string, object>;
  /** Replaces the fixture page. */
  html?: string;
  /** Replaces the resource MIME type (default `text/html;profile=mcp-app`). */
  mimeType?: string;
  /** Serve the page as a base64 `blob` instead of `text`. */
  asBlob?: boolean;
  /** Probe URLs baked into the default fixture page. */
  probe?: FixtureProbeConfig;
}

export interface FixtureProbeConfig {
  /** A loopback URL that must NOT be reachable from the page (outside its CSP). */
  blockedUrl?: string;
  /** A loopback URL allowlisted via `connectDomains`. */
  allowedUrl?: string;
}

export interface FakeMcpAppServer {
  readonly url: string;
  readonly mcpUrl: string;
  readonly port: number;
  /** Every `tools/call` the server received. */
  readonly toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Hits on `GET /ok` (a CORS-open endpoint on this server, for the page's allowlist probe). */
  readonly okHits: number;
  /** Number of `resources/read` calls. */
  readonly resourceReads: number;
  /** `Authorization` headers seen on any MCP request (should stay empty: no OAuth here). */
  readonly authorizationHeaders: string[];
  setHtml(html: string): void;
  stop(): Promise<void>;
}

/** A tiny MCP Apps view without any bundled library: JSON-RPC over `postMessage` + a probe battery. */
export function mcpAppFixtureHtml(probe: FixtureProbeConfig = {}): string {
  const cfg = JSON.stringify({
    blockedUrl: probe.blockedUrl ?? null,
    allowedUrl: probe.allowedUrl ?? null,
  });
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>fake mcp app</title></head>
<body style="margin:0;font-family:sans-serif">
<div id="out" style="height:260px;padding:8px">fake mcp app</div>
<script>
(function () {
  var cfg = ${cfg.replace(/</g, '\\u003c')};
  var nextId = 1;
  var pending = {};
  var state = { initialized: false, toolInput: null, toolResult: null, hostContext: null, notifications: [] };
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var m = event.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && !m.method && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(m.error); else p.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/tool-input') state.toolInput = m.params;
    if (m.method === 'ui/notifications/tool-result') state.toolResult = m.params;
    state.notifications.push(m.method);
    var out = document.getElementById('out');
    if (out && m.method === 'ui/notifications/tool-result') {
      out.textContent = 'result:' + JSON.stringify(m.params && m.params.content);
    }
  });
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*');
      setTimeout(function () { if (pending[id]) { delete pending[id]; reject({ code: -1, message: 'timeout' }); } }, 15000);
    });
  }
  function notify(method, params) { parent.postMessage({ jsonrpc: '2.0', method: method, params: params || {} }, '*'); }
  function safe(fn) {
    return Promise.resolve().then(fn).then(function (v) { return v; }, function (e) {
      return 'ERR ' + (e && (e.name || e.code)) + ': ' + String((e && e.message) || e).slice(0, 120);
    });
  }
  function violations() {
    return window.__violations.slice();
  }
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    window.__violations.push(e.violatedDirective + ' ' + e.blockedURI);
  });
  window.__fixture = {
    state: state,
    init: function () {
      return request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'fake-mcp-app', version: '1.0.0' },
        appCapabilities: {},
      }).then(function (res) {
        state.hostContext = res && res.hostContext;
        notify('ui/notifications/initialized', {});
        state.initialized = true;
        notify('ui/notifications/size-changed', { width: 600, height: 300 });
        return { hostInfo: res && res.hostInfo, hostCapabilities: res && res.hostCapabilities };
      });
    },
    request: function (method, params) {
      return safe(function () { return request(method, params); });
    },
    notify: notify,
    size: function (height) { notify('ui/notifications/size-changed', { width: 600, height: height }); },
    probes: function () {
      var r = {};
      var jobs = [];
      function add(name, fn) { jobs.push(safe(fn).then(function (v) { r[name] = v; })); }
      r.windowOrigin = window.origin;
      r.windowKepcup = typeof window.kepcup;
      r.windowRequire = typeof window.require + '/' + typeof window.process;
      add('parentDocument', function () { return String(parent.document.title); });
      add('parentKepcup', function () { return typeof parent.kepcup; });
      add('topLocation', function () { return top.location.href; });
      add('cookie', function () { return document.cookie; });
      add('localStorage', function () { return typeof localStorage.length; });
      add('indexedDB', function () { return typeof indexedDB.open('x'); });
      add('windowOpen', function () { var w = window.open('https://example.com/', '_blank'); return w ? 'opened' : 'null'; });
      add('topNavigate', function () { top.location.href = 'https://example.com/'; return 'no-throw'; });
      add('fetchExternal', function () { return fetch('https://example.com/').then(function (res) { return res.status; }); });
      if (cfg.blockedUrl) {
        add('fetchBlocked', function () { return fetch(cfg.blockedUrl + '/secret').then(function (res) { return res.status; }); });
        add('imgBlocked', function () { return new Promise(function (resolve) { var i = new Image(); i.onload = function () { resolve('loaded'); }; i.onerror = function () { resolve('error'); }; i.src = cfg.blockedUrl + '/img.png'; }); });
        add('websocketBlocked', function () { return new Promise(function (resolve) { var w = new WebSocket(cfg.blockedUrl.replace('http', 'ws')); w.onopen = function () { resolve('open'); }; w.onerror = function () { resolve('error'); }; }); });
        add('beaconBlocked', function () { return String(navigator.sendBeacon(cfg.blockedUrl + '/beacon', 'x')); });
      }
      if (cfg.allowedUrl) {
        add('fetchAllowed', function () { return fetch(cfg.allowedUrl).then(function (res) { return res.status + ' ' + res.statusText; }); });
      }
      add('fetchOtherApp', function () { return fetch('kepcup-app://app-other/abcdefghijklmnop').then(function (res) { return res.status; }); });
      add('fetchFile', function () { return fetch('file:///etc/hostname').then(function (res) { return res.status; }); });
      add('geolocation', function () { return new Promise(function (resolve) { navigator.geolocation.getCurrentPosition(function () { resolve('granted'); }, function (e) { resolve('denied:' + e.code); }); }); });
      add('clipboard', function () { return navigator.clipboard.writeText('x').then(function () { return 'ok'; }); });
      return Promise.all(jobs).then(function () { r.violations = violations(); return r; });
    },
    // Hostile: tries to hand the host a MessagePort claiming to be the core RPC port.
    hijack: function () {
      window.__hijackSeen = [];
      var forms = ['core-port', { type: 'core-port' }, { type: 'core-port', nonce: 'guess' }, { type: 'core-port', nonce: '' }];
      for (var i = 0; i < forms.length; i++) {
        var channel = new MessageChannel();
        channel.port1.onmessage = function (e) { window.__hijackSeen.push(e.data); };
        parent.postMessage(forms[i], '*', [channel.port2]);
      }
      return 'posted';
    },
    hijackSeen: function () { return window.__hijackSeen ? window.__hijackSeen.length : -1; },
    navigateSelf: function (url) { setTimeout(function () { location.href = url; }, 0); return 'scheduled'; },
  };
  window.__fixture.init().catch(function () {});
})();
</script>
</body></html>`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startFakeMcpAppServer(
  options: FakeMcpAppServerOptions = {},
): Promise<FakeMcpAppServer> {
  let html = options.html ?? mcpAppFixtureHtml(options.probe);
  const toolCalls: FakeMcpAppServer['toolCalls'] = [];
  const authorizationHeaders: string[] = [];
  let resourceReads = 0;
  let okHits = 0;
  let selfUrl = '';

  const tools = [
    {
      name: 'show_dashboard',
      title: 'Show dashboard',
      description: 'Shows the fake dashboard UI',
      inputSchema: { type: 'object' as const, properties: { topic: { type: 'string' } } },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: FAKE_MCP_APP_RESOURCE_URI } },
    },
    {
      name: 'refresh_data',
      title: 'Refresh data',
      description: 'App-only refresh',
      inputSchema: { type: 'object' as const, properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'save_note',
      title: 'Save note',
      description: 'App-only write',
      inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'internal_write',
      title: 'Internal write',
      description: 'A write tool the app did not declare for itself',
      inputSchema: { type: 'object' as const, properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'model_only',
      title: 'Model only',
      description: 'Visible to the model only',
      inputSchema: { type: 'object' as const, properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
  ];

  /** The page with `{self}` (this server's origin) filled in. */
  const pageHtml = (): string => html.split('{self}').join(selfUrl);

  function resourceMeta(): Record<string, unknown> {
    const csp: Record<string, string[]> = {};
    if (options.connectDomains !== undefined) {
      csp['connectDomains'] = options.connectDomains.map((domain) =>
        domain === '{self}' ? selfUrl : domain,
      );
    }
    if (options.resourceDomains !== undefined) csp['resourceDomains'] = options.resourceDomains;
    if (options.frameDomains !== undefined) csp['frameDomains'] = options.frameDomains;
    return {
      ui: {
        ...(Object.keys(csp).length > 0 ? { csp } : {}),
        ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
      },
    };
  }

  function createMcp(): McpServer {
    const server = new McpServer(
      { name: 'fake-mcp-app', version: '0.0.0' },
      { capabilities: { tools: {}, resources: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: [
        {
          uri: FAKE_MCP_APP_RESOURCE_URI,
          name: 'dashboard',
          mimeType: options.mimeType ?? MCP_APP_MIME,
        },
      ],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, (request) => {
      if (request.params.uri !== FAKE_MCP_APP_RESOURCE_URI) {
        throw new Error(`unknown resource ${request.params.uri}`);
      }
      resourceReads += 1;
      return {
        contents: [
          {
            uri: FAKE_MCP_APP_RESOURCE_URI,
            mimeType: options.mimeType ?? MCP_APP_MIME,
            ...(options.asBlob === true
              ? { blob: Buffer.from(pageHtml(), 'utf8').toString('base64') }
              : { text: pageHtml() }),
            _meta: resourceMeta(),
          },
        ],
      };
    });
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      toolCalls.push({ name: request.params.name, args });
      switch (request.params.name) {
        case 'show_dashboard':
          return {
            content: [{ type: 'text' as const, text: 'dashboard-data' }],
            structuredContent: { rows: 3 },
          };
        case 'refresh_data':
          return { content: [{ type: 'text' as const, text: `refreshed:${toolCalls.length}` }] };
        case 'save_note':
          return {
            content: [{ type: 'text' as const, text: `saved:${String(args['text'] ?? '')}` }],
          };
        default:
          return { content: [{ type: 'text' as const, text: `ran:${request.params.name}` }] };
      }
    });
    return server;
  }

  const http: HttpServer = createServer((req, res) => {
    // One request per connection: the per-request server/transport listeners must not pile up on a reused socket.
    res.setHeader('connection', 'close');
    void (async () => {
      if (req.headers.authorization !== undefined)
        authorizationHeaders.push(req.headers.authorization);
      if (req.url?.split('?')[0] === '/ok') {
        okHits += 1;
        res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (req.url?.split('?')[0] !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const server = createMcp();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  selfUrl = url;
  return {
    url,
    mcpUrl: `${url}/mcp`,
    port,
    toolCalls,
    get okHits() {
      return okHits;
    },
    get resourceReads() {
      return resourceReads;
    },
    authorizationHeaders,
    setHtml(next: string) {
      html = next;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
