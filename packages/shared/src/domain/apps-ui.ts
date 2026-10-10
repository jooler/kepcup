import { z } from 'zod';

/**
 * MCP Apps 渲染（D73 P3 §7.5，设计 29 §11.6；spike 结论见 todo/connected-apps.md 附录 B.7）。
 *
 * 数据流：工具结果带 `_meta.ui.resourceUri` → core 在对话里发一张 `cardType: 'mcp_app'` 的卡片消息
 * （内容是下面的 {@link AppUiCard}，**不含** HTML 与令牌）→ 渲染端挂载卡片时 `apps.ui.open` 让 core
 * 经 `resources/read` 取 HTML、登记成内存里的一次性资源 → iframe（`sandbox="allow-scripts"`）指向
 * `kepcup-app://{host}/{resourceId}`，主进程协议处理器向 core 取 HTML 并带上逐应用响应头 CSP。
 */

/** MCP Apps 的 UI 资源 MIME。 */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
/** 对话里卡片消息的 `cardType`。 */
export const MCP_APP_CARD_TYPE = 'mcp_app';
/** 特权协议名（主进程注册；渲染端 CSP 的 `frame-src` 同名）。 */
export const MCP_APP_SCHEME = 'kepcup-app';

/** `ui://` 资源 HTML 的体积上限（字节）。 */
export const MCP_APP_HTML_MAX_BYTES = 2 * 1024 * 1024;
/** 卡片里保存的工具入参 / 结果上限（JSON 字符数；超出则丢弃并标记 truncated）。 */
export const MCP_APP_INPUT_MAX_CHARS = 16 * 1024;
export const MCP_APP_RESULT_MAX_CHARS = 64 * 1024;
/** 界面发起的 `tools/call` 入参 JSON 上限。 */
export const MCP_APP_CALL_ARGS_MAX_CHARS = 64 * 1024;
/** 界面发起的 `tools/call` 结果文本上限（回给界面的，已脱敏）。 */
export const MCP_APP_CALL_RESULT_MAX_CHARS = 256 * 1024;
/** 内存资源的生存期（滑动：每次取用 / 调用刷新）。 */
export const MCP_APP_RESOURCE_TTL_MS = 30 * 60 * 1000;
/** 同时登记的内存资源上限（最旧的先淘汰）。 */
export const MCP_APP_RESOURCES_MAX = 64;
/** 每张卡每秒最多发起的 `tools/call`，以及同时在途的上限。 */
export const MCP_APP_CALLS_PER_SECOND = 5;
export const MCP_APP_CALLS_INFLIGHT_MAX = 3;
/** 用户拒绝某个界面发起的工具调用后，同一张卡对该工具静默的时长（不再弹卡）。 */
export const MCP_APP_DENY_LOCK_MS = 30_000;
/** 每个对话同时在途（可能在等审批）的界面发起调用上限。 */
export const MCP_APP_CONVERSATION_PENDING_MAX = 3;
/** `ui/open-link` 被取消后的冷却（毫秒），防止页面反复弹确认条。 */
export const MCP_APP_LINK_COOLDOWN_MS = 5_000;
/** 界面高度夹取范围（像素）。 */
export const MCP_APP_HEIGHT_MIN = 100;
export const MCP_APP_HEIGHT_MAX = 800;

// --- CSP（来自资源 `_meta.ui.csp`，逐应用生成响应头） --------------------------

/** 资源 `_meta.ui.csp`：均为来源列表；缺省 / 空 = 不允许。 */
export const appUiCspSchema = z.object({
  connectDomains: z.array(z.string()).max(64).optional(),
  resourceDomains: z.array(z.string()).max(64).optional(),
  frameDomains: z.array(z.string()).max(64).optional(),
  baseUriDomains: z.array(z.string()).max(64).optional(),
});
export type AppUiCsp = z.infer<typeof appUiCspSchema>;

/** 清洗后的 CSP：只含通过校验的规范来源（`scheme://host[:port]`），以及被丢弃的原始条目。 */
export interface SanitizedAppCsp {
  connectDomains: string[];
  resourceDomains: string[];
  /** 声明了但 P3 不支持的类别（嵌套 iframe / base URI）：记下以便界面提示，不生效。 */
  unsupported: string[];
  /** 未通过校验的原始条目（不生效）。 */
  rejected: string[];
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isLoopbackName(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

const DEFAULT_PORT: Record<string, string> = { https: '443', wss: '443', http: '80', ws: '80' };

/** `host:port` 键（端口缺省按方案补全）——与 {@link normalizeAppCspSource} 的 `loopbackOrigin` 比较。 */
export function appLoopbackKey(urlLike: string): string | null {
  try {
    const url = new URL(urlLike);
    const scheme = url.protocol.replace(/:$/, '');
    const port = url.port !== '' ? url.port : DEFAULT_PORT[scheme];
    return port === undefined ? null : `${url.hostname}:${port}`;
  } catch {
    return null;
  }
}

/**
 * 把一条声明的来源规范化成 CSP 来源表达式；不接受则返回 null。规则（严格，设计 29 §11.6）：
 * - 只接受 `https:` / `wss:` 与**精确域名**：任何通配（`*.example.com`、`*`、端口 `*`）一律拒绝——
 *   `https://*.github.io` / `*.s3.amazonaws.com` / `*.co.uk` 这类公共后缀下的通配等于放行整个互联网；
 * - IP 字面量与 `localhost` / `*.localhost` 属于回环 / 本机：**只**接受与所属 server 完全相同的
 *   `host:port`（`options.loopbackOrigin`，本机开发 server 才会有），此时 `http:` / `ws:` 也可；
 * - 不带用户名 / 路径 / 查询 / 片段；端口可选（数字）；不接受裸关键字 / 方案（`data:`、`'unsafe-*'`）。
 */
export function normalizeAppCspSource(
  raw: string,
  options: { loopbackOrigin?: string | null },
): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > 253 || /[\s;,'"`<>\\*]/.test(text)) return null;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#@]+)$/i.exec(text);
  if (match === null) return null;
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!.toLowerCase();
  const secure = scheme === 'https' || scheme === 'wss';
  const plain = scheme === 'http' || scheme === 'ws';
  if (!secure && !plain) return null;
  let host: string;
  let port: string;
  const bracket = /^(\[[0-9a-f:]+\])(?::(\d+))?$/.exec(authority);
  if (bracket !== null) {
    host = bracket[1]!;
    port = bracket[2] ?? '';
  } else {
    const split = /^([^:]+)(?::(\d+))?$/.exec(authority);
    if (split === null) return null;
    host = split[1]!;
    port = split[2] ?? '';
  }
  if (port !== '' && (Number(port) < 1 || Number(port) > 65535)) return null;
  const normalized = `${scheme}://${host}${port !== '' ? `:${port}` : ''}`;
  if (isLoopbackName(host) || host.startsWith('[')) {
    // Loopback / local: only the owning (local dev) server's exact host:port.
    const key = `${host}:${port !== '' ? port : DEFAULT_PORT[scheme]}`;
    return options.loopbackOrigin != null && options.loopbackOrigin === key ? normalized : null;
  }
  if (plain) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) return null;
  // IPv4 字面量（全数字标签）不是域名。
  if (labels.every((label) => /^\d+$/.test(label))) return null;
  return normalized;
}

/** 清洗资源声明的 CSP（见 {@link normalizeAppCspSource}）。 */
export function sanitizeAppCsp(
  csp: AppUiCsp | undefined,
  options: { loopbackOrigin?: string | null },
): SanitizedAppCsp {
  const rejected: string[] = [];
  const clean = (list: readonly string[] | undefined): string[] => {
    const out: string[] = [];
    for (const item of list ?? []) {
      const normalized = normalizeAppCspSource(item, options);
      if (normalized === null) rejected.push(String(item).slice(0, 120));
      else if (!out.includes(normalized)) out.push(normalized);
    }
    return out;
  };
  const unsupported: string[] = [];
  if ((csp?.frameDomains?.length ?? 0) > 0) unsupported.push('frameDomains');
  if ((csp?.baseUriDomains?.length ?? 0) > 0) unsupported.push('baseUriDomains');
  return {
    connectDomains: clean(csp?.connectDomains),
    resourceDomains: clean(csp?.resourceDomains),
    unsupported,
    rejected,
  };
}

/**
 * 响应头 CSP（只接受 {@link sanitizeAppCsp} 的输出）。默认全部拒绝：脚本 / 样式只允许内联与
 * 声明的资源域，网络请求只允许声明的连接域，嵌套 iframe、`<base>`、表单提交、对象一律禁止。
 */
export function buildAppCspHeader(
  csp: Pick<SanitizedAppCsp, 'connectDomains' | 'resourceDomains'>,
): string {
  const resources = csp.resourceDomains.join(' ');
  const withRes = (head: string): string => (resources.length > 0 ? `${head} ${resources}` : head);
  return [
    "default-src 'none'",
    // Belt and braces next to the iframe attribute: the document is sandboxed (opaque origin)
    // even if some other host ever embeds it without the attribute.
    'sandbox allow-scripts',
    withRes("script-src 'unsafe-inline'"),
    withRes("style-src 'unsafe-inline'"),
    withRes('img-src data: blob:'),
    withRes('font-src data:'),
    withRes('media-src data: blob:'),
    `connect-src ${csp.connectDomains.length > 0 ? csp.connectDomains.join(' ') : "'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // Only the app's own window (packaged: file://, dev server: localhost) may embed the page.
    'frame-ancestors file: http://localhost:*',
  ].join('; ');
}

// --- 工具元数据（`_meta.ui`） -----------------------------------------------

function uiMetaOf(meta: unknown): Record<string, unknown> | null {
  if (meta === null || typeof meta !== 'object') return null;
  const ui = (meta as Record<string, unknown>)['ui'];
  return ui !== null && typeof ui === 'object' && !Array.isArray(ui)
    ? (ui as Record<string, unknown>)
    : null;
}

/** `_meta.ui.resourceUri`（或旧版的 `_meta["ui/resourceUri"]`）；必须是 `ui://` 方案。 */
export function mcpAppResourceUriOf(meta: unknown): string | null {
  const nested = uiMetaOf(meta)?.['resourceUri'];
  const legacy =
    meta !== null && typeof meta === 'object'
      ? (meta as Record<string, unknown>)['ui/resourceUri']
      : undefined;
  const value = typeof nested === 'string' ? nested : typeof legacy === 'string' ? legacy : null;
  if (value === null || value.length === 0 || value.length > 2048) return null;
  return /^ui:\/\/\S+$/i.test(value) ? value : null;
}

/**
 * 工具是否允许界面（app）调用：`_meta.ui.visibility` **显式**包含 `"app"`。
 * 比规范严——规范缺省为 `["model","app"]`，KepCup 缺省拒绝（设计 29 §11.6；附录 B.7）。
 */
export function isToolVisibleToApp(meta: unknown): boolean {
  const visibility = uiMetaOf(meta)?.['visibility'];
  return Array.isArray(visibility) && visibility.includes('app');
}

// --- 卡片内容（落库在对话消息里，不含 HTML / 令牌） ----------------------------

export const appUiToolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).default([]),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
  /** 文本 / 结构化内容因超过上限被截断或丢弃。 */
  truncated: z.boolean().optional(),
});
export type AppUiToolResult = z.infer<typeof appUiToolResultSchema>;

export const appUiCardSchema = z.object({
  /** McpService 的 server id（目录连接为 `conn_…`；自定义 server 为其配置 id）。 */
  serverId: z.string().min(1),
  /** 应用名（目录条目标题或 server 名），仅用于展示。 */
  appName: z.string(),
  /** 产生卡片的 Bot（界面发起的调用以它的身份走网关审批）。 */
  botId: z.string().nullable(),
  resourceUri: z.string().min(1),
  /** 卡片标题（工具标题 / 名称）。 */
  title: z.string(),
  /** 产生卡片的工具名（原始 MCP 名）。 */
  toolName: z.string().min(1),
  toolInput: z.record(z.string(), z.unknown()).default({}),
  toolResult: appUiToolResultSchema,
  /** 入参因超过上限被丢弃。 */
  inputTruncated: z.boolean().optional(),
});
export type AppUiCard = z.infer<typeof appUiCardSchema>;

// --- RPC -------------------------------------------------------------------

/** `apps.ui.open`：为一张卡片登记资源（core 经 `resources/read` 取 HTML）。 */
export const appsUiOpenInputSchema = z.object({ messageId: z.string().min(1) });
export const appsUiOpenOutputSchema = z.object({
  /** 一次性不透明资源 id（iframe 路径与后续调用的凭据）。 */
  resourceId: z.string(),
  /** 完整的 iframe 地址 `kepcup-app://{host}/{resourceId}`。 */
  url: z.string(),
  title: z.string(),
  appName: z.string(),
  prefersBorder: z.boolean().optional(),
  /** 清洗后实际生效的网络来源（界面展示「此应用可连接…」）。 */
  connectDomains: z.array(z.string()),
  resourceDomains: z.array(z.string()),
  /** 资源声明了但未生效的内容（被拒绝的来源、P3 不支持的类别）。 */
  ignored: z.array(z.string()),
  /** 资源请求了但 P3 一律不授予的浏览器权限（camera / microphone / geolocation / clipboardWrite）。 */
  deniedPermissions: z.array(z.string()),
  toolInput: z.record(z.string(), z.unknown()),
  toolResult: appUiToolResultSchema,
  /** 界面可调用的工具名（`_meta.ui.visibility` 含 `app`）。 */
  appTools: z.array(z.string()),
});
export type AppsUiOpenOutput = z.infer<typeof appsUiOpenOutputSchema>;

export const appsUiCloseInputSchema = z.object({ resourceId: z.string().min(1) });

/** `apps.ui.callTool`：界面发起的 `tools/call`，走与模型调用相同的网关审批。 */
export const appsUiCallToolInputSchema = z.object({
  resourceId: z.string().min(1),
  toolName: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export const appsUiCallToolOutputSchema = appUiToolResultSchema;

/** `apps.ui.openLink`：界面请求打开外链（渲染端已征得用户确认；core 再校验 https）。 */
export const appsUiOpenLinkInputSchema = z.object({
  resourceId: z.string().min(1),
  url: z.string().min(1).max(2048),
});
export const appsUiOpenLinkOutputSchema = z.object({ ok: z.boolean() });

/** 平台方法 `apps.ui.resource`（主进程协议处理器 → core）：取登记过的 HTML 与响应头 CSP。 */
export const appsUiResourceInputSchema = z.object({
  resourceId: z.string().min(1),
  /** 请求 URL 里的 host；必须与登记时一致。 */
  host: z.string().min(1),
});
export const appsUiResourceOutputSchema = z.object({
  html: z.string(),
  csp: z.string(),
});
