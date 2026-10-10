import { z } from 'zod';
import { sha256Hex } from '../policy/sha256.js';
import { connectorCatalogEntrySchema, connectorMetaOf } from './connector-catalog.js';

/**
 * 本机连接（docs/design/29-connected-apps.md §17，todo/local-connector-authoring.md）：Bot 读
 * 厂商文档、经 core 探测后生成的**只存在于本机**的连接条目。
 *
 * 条目内容只来自 core 的探测结果（MCP 地址 / 认证方式 / 范围）；Bot 只能提供经过清洗的展示名、
 * 描述、分类和文档链接。条目存 `settings.apps.localConnectors`（设置 JSON，无迁移），形状是
 * {@link localConnectorRecordSchema}；读取时逐条校验，坏条目只丢弃该条。
 */

/** 本机条目的发行门禁值：不在任何放行清单里，也不经门禁过滤（走独立来源）。 */
export const LOCAL_CONNECTOR_GATE = 'local';
/** 本机条目没有打包图标：占位文件名（满足图标 schema，core 不会去读它）。 */
export const LOCAL_CONNECTOR_ICON = 'local.svg';
/** 本机条目的 Registry 命名空间前缀；打包 / 远端目录条目不得占用。 */
export const LOCAL_CONNECTOR_NAME_PREFIX = 'local.kepcup/';
/** 条目版本：本机条目不演进，固定值。 */
export const LOCAL_CONNECTOR_VERSION = '1.0.0';
/** 本机条目数量上限（防止 Bot 反复提案堆积）。 */
export const LOCAL_CONNECTORS_MAX = 20;
/** 提案存活时间（内存，一次性 id）。 */
export const LOCAL_CONNECTOR_PROPOSAL_TTL_MS = 30 * 60_000;
export const LOCAL_CONNECTOR_URL_MAX = 500;
export const LOCAL_CONNECTOR_TITLE_MAX = 60;
export const LOCAL_CONNECTOR_DESCRIPTION_MAX = 200;
export const LOCAL_CONNECTOR_DOC_URL_MAX = 500;

/** 本机条目的 slug：`l` + 对 MCP 地址 origin 取的 sha256 前 12 位十六进制（`[a-z0-9]{2,16}`）。 */
export const LOCAL_CONNECTOR_SLUG_PATTERN = /^l[0-9a-f]{12}$/;

/** MCP 地址的 origin（小写主机，默认端口省略）；非法地址返回 null。 */
export function localConnectorOrigin(mcpUrl: string): string | null {
  try {
    const url = new URL(mcpUrl);
    return url.origin === 'null' ? null : url.origin;
  } catch {
    return null;
  }
}

export function localConnectorSlug(origin: string): string {
  return `l${sha256Hex(origin).slice(0, 12)}`;
}

export function localConnectorName(slug: string): string {
  return `${LOCAL_CONNECTOR_NAME_PREFIX}${slug}`;
}

/**
 * MCP 地址是否可以成为本机条目的端点：https、无用户信息 / 查询 / 片段（查询里夹带的密钥不属于
 * 「自动注册」认证）、主机是带点的域名（不是 IP 字面量、`localhost`、`*.local` 等内网后缀）。
 * 解析到私网地址由连接时的 SSRF 守卫（`infra/safe-dispatcher`）拒绝。
 */
export function isSafeLocalConnectorUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > LOCAL_CONNECTOR_URL_MAX) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#')) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host.startsWith('[') || host.includes(':')) return false; // IPv6 literal
  if (/^[0-9.]+$/.test(host)) return false; // IPv4 literal (the URL parser normalizes odd forms)
  if (host === 'localhost' || !host.includes('.')) return false;
  if (/\.(?:localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return false;
  return true;
}

/** 文档链接（仅展示，从不自动打开 / 抓取）：https、无用户信息、不超长。 */
export function isSafeDocUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > LOCAL_CONNECTOR_DOC_URL_MAX) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

// 控制字符、双向覆盖 / 隔离、零宽字符：展示文本里一律剔除（防界面欺骗与提示词夹带）。
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 控制字符
  [0x7f, 0x9f], // DEL + C1 控制字符
  [0x200b, 0x200f], // 零宽 / 方向标记
  [0x2028, 0x2029], // 行 / 段分隔符
  [0x202a, 0x202e], // 双向嵌入 / 覆盖
  [0x2060, 0x2064], // 词连接符等不可见字符
  [0x2066, 0x2069], // 双向隔离
  [0xfeff, 0xfeff], // BOM / 零宽不换行空格
];

function isUnsafeCodePoint(code: number): boolean {
  return UNSAFE_RANGES.some(([from, to]) => code >= from && code <= to);
}

/**
 * 清洗 Bot 提供的展示文本：剔除控制 / 双向 / 零宽字符，空白折叠为单个空格，去首尾空白，
 * 按码点截断到 `max`。结果可能为空串。
 */
export function sanitizeLocalConnectorText(text: string, max: number): string {
  const cleaned = Array.from(text, (ch) => (isUnsafeCodePoint(ch.codePointAt(0) ?? 0) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(cleaned);
  return points.length <= max ? cleaned : points.slice(0, max).join('').trimEnd();
}

function hasUnsafeText(text: string): boolean {
  for (const ch of text) if (isUnsafeCodePoint(ch.codePointAt(0) ?? 0)) return true;
  return false;
}

export interface LocalConnectorSchemaOptions {
  /**
   * 允许明文 / 回环主机的白名单（`hostname` 或 `host:port`）。生产恒为空；仅 NODE_ENV=test 的
   * 构建里由测试钩子注入（用本机假服务器代替公网 https 端点）。
   */
  allowInsecureHosts?: readonly string[] | undefined;
}

/**
 * 本机条目记录：完整的目录条目 + 添加时间 + 文档链接。强制：`tier: developer`、自动注册的
 * OAuth、唯一一个 `streamable-http` 远端（https 域名）、`releaseGate: local`、无 `toolPolicy`
 * / `whoami` / 随附技能 / 界面、slug = 对 origin 的派生值、name 在本机命名空间下。
 * 与打包 / 远端条目的 slug / name 冲突由 core 在添加与装载目录时检查（需要目录内容）。
 */
export function createLocalConnectorRecordSchema(options: LocalConnectorSchemaOptions = {}) {
  const insecure = options.allowInsecureHosts ?? [];
  const urlAllowed = (raw: string): boolean => {
    if (isSafeLocalConnectorUrl(raw)) return true;
    if (insecure.length === 0) return false;
    try {
      const url = new URL(raw);
      return insecure.some((entry) => entry === url.host || entry === url.hostname);
    } catch {
      return false;
    }
  };
  return z
    .object({
      entry: connectorCatalogEntrySchema,
      addedAt: z.number().int().nonnegative(),
      sourceDocUrl: z.string().refine(isSafeDocUrl, { message: 'invalid doc url' }).optional(),
    })
    .superRefine((record, ctx) => {
      const { entry } = record;
      const meta = connectorMetaOf(entry);
      const fail = (message: string, path: Array<string | number> = ['entry']): void => {
        ctx.addIssue({ code: 'custom', message, path });
      };
      if (meta.tier !== 'developer') fail('tier must be "developer"');
      if (meta.auth.kind !== 'oauth') fail('auth.kind must be "oauth"');
      if (meta.auth.registration !== 'auto' || meta.auth.clientRef !== null) {
        fail('auth.registration must be "auto" without a clientRef');
      }
      if (meta.releaseGate !== LOCAL_CONNECTOR_GATE) fail('releaseGate must be "local"');
      if (Object.keys(meta.toolPolicy).length > 0) fail('toolPolicy must be empty');
      if (meta.whoami !== undefined) fail('whoami must not be set');
      if (meta.skills.length > 0) fail('skills must be empty');
      if (meta.ui) fail('ui must be false');
      if (meta.icon !== LOCAL_CONNECTOR_ICON) fail('icon must be the local placeholder');
      if (entry.packages.length > 0) fail('packages must be empty');
      const remote = entry.remotes[0];
      if (entry.remotes.length !== 1 || remote === undefined || remote.type !== 'streamable-http') {
        fail('exactly one streamable-http remote is required');
        return;
      }
      if (!urlAllowed(remote.url)) fail('remote url must be an https domain URL');
      const origin = localConnectorOrigin(remote.url);
      if (origin === null || meta.slug !== localConnectorSlug(origin)) {
        fail('slug must be derived from the MCP origin');
      }
      if (entry.name !== localConnectorName(meta.slug)) fail('name must be in the local namespace');
      if (entry.version !== LOCAL_CONNECTOR_VERSION) fail('unexpected version');
      if (hasUnsafeText(entry.title) || hasUnsafeText(entry.description)) {
        fail('title / description contain control characters');
      }
    });
}

export const localConnectorRecordSchema = createLocalConnectorRecordSchema();
export type LocalConnectorRecord = z.infer<typeof localConnectorRecordSchema>;

// --- RPC（apps.localConnectors.*） ---------------------------------------------

/** `apps.localConnectors.list` 的一行：本机条目 + 已连接账号。不含任何令牌。 */
export const localConnectorViewSchema = z.object({
  /** 目录 slug（`l…`）：`apps.connect({ target: { kind: 'catalog', connectorId } })` 用它。 */
  connectorId: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  mcpUrl: z.string(),
  mcpHost: z.string(),
  addedAt: z.number(),
  sourceDocUrl: z.string().optional(),
  connectedAccounts: z.number().int().min(0),
  connectionIds: z.array(z.string()),
});
export type LocalConnectorView = z.infer<typeof localConnectorViewSchema>;

export const appsLocalConnectorsListOutputSchema = z.object({
  connectors: z.array(localConnectorViewSchema),
});
export const appsLocalConnectorsConfirmInputSchema = z.object({
  proposalId: z.string().min(1),
});
export const appsLocalConnectorsConfirmOutputSchema = z.object({
  connectorId: z.string(),
  title: z.string(),
});
export const appsLocalConnectorsRejectInputSchema = appsLocalConnectorsConfirmInputSchema;
export const appsLocalConnectorsRemoveInputSchema = z.object({
  connectorId: z.string().min(1),
});

/** `apps.catalog_changed` 事件：本机条目被添加 / 删除，界面据此重拉 `apps.catalog.list`。 */
export const appCatalogChangedPayloadSchema = z.object({
  connectorId: z.string(),
  change: z.enum(['added', 'removed']),
});
export type AppCatalogChangedPayload = z.infer<typeof appCatalogChangedPayloadSchema>;
