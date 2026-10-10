import {
  AppError,
  MCP_APP_HTML_MAX_BYTES,
  appUiCspSchema,
  buildAppCspHeader,
  sanitizeAppCsp,
  type AppUiCsp,
} from '@kepcup/shared';

/** `resources/read` 的内容项（文本或 base64 二进制）。 */
interface ResourceContent {
  uri?: unknown;
  mimeType?: unknown;
  text?: unknown;
  blob?: unknown;
  _meta?: unknown;
}

export interface ParsedUiResource {
  html: string;
  /** 完整的响应头 CSP（清洗后）。 */
  csp: string;
  connectDomains: string[];
  resourceDomains: string[];
  /** 声明了但未生效的内容，供界面提示（被拒绝的来源、不支持的类别）。 */
  ignored: string[];
  /** 资源请求了、P3 一律不授予的浏览器权限。 */
  deniedPermissions: string[];
  prefersBorder?: boolean | undefined;
}

/** MIME 比较：忽略大小写与空白，只认 `text/html;profile=mcp-app`（允许多余参数）。 */
export function isMcpAppMime(mime: unknown): boolean {
  if (typeof mime !== 'string') return false;
  const parts = mime
    .toLowerCase()
    .split(';')
    .map((part) => part.trim());
  return parts[0] === 'text/html' && parts.slice(1).includes('profile=mcp-app');
}

const PERMISSION_KEYS = ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const;

/**
 * 校验并解析 `resources/read` 的结果（纯函数）：取与请求 URI 对应的内容项（缺省取第一项）→ 检查
 * MIME（`text/html;profile=mcp-app`）→ 取出 HTML（文本，或 base64 解码）→ 体积 ≤ 2 MB → 读取
 * 内容项 `_meta.ui` 的 `csp` / `permissions` / `prefersBorder`，CSP 清洗后生成响应头。
 *
 * @param loopbackOrigin 该应用所属 server 自己是本机开发 server 时它的 `host:port`；回环来源只接受与它完全相同的一个。
 */
export function parseUiResource(
  result: { contents?: unknown },
  uri: string,
  options: { loopbackOrigin?: string | null },
): ParsedUiResource {
  const contents = Array.isArray(result.contents) ? (result.contents as ResourceContent[]) : [];
  const item = contents.find((entry) => entry?.uri === uri) ?? contents[0];
  if (item === undefined || item === null || typeof item !== 'object') {
    throw new AppError('APP_UI_INVALID', '应用的界面资源为空');
  }
  if (!isMcpAppMime(item.mimeType)) {
    throw new AppError(
      'APP_UI_INVALID',
      `应用的界面资源类型不受支持（需要 text/html;profile=mcp-app，实际为 ${typeof item.mimeType === 'string' ? item.mimeType.slice(0, 80) : '未声明'}）`,
    );
  }
  let html: string;
  if (typeof item.text === 'string') {
    if (Buffer.byteLength(item.text, 'utf8') > MCP_APP_HTML_MAX_BYTES) {
      throw new AppError('APP_UI_INVALID', '应用的界面资源超过 2 MB 上限');
    }
    html = item.text;
  } else if (typeof item.blob === 'string') {
    // base64 长度先粗查，避免解码巨大字符串。
    if (item.blob.length > Math.ceil((MCP_APP_HTML_MAX_BYTES * 4) / 3) + 8) {
      throw new AppError('APP_UI_INVALID', '应用的界面资源超过 2 MB 上限');
    }
    const bytes = Buffer.from(item.blob, 'base64');
    if (bytes.byteLength > MCP_APP_HTML_MAX_BYTES) {
      throw new AppError('APP_UI_INVALID', '应用的界面资源超过 2 MB 上限');
    }
    html = bytes.toString('utf8');
  } else {
    throw new AppError('APP_UI_INVALID', '应用的界面资源没有内容');
  }
  if (html.trim().length === 0) throw new AppError('APP_UI_INVALID', '应用的界面资源没有内容');

  const meta =
    item._meta !== null && typeof item._meta === 'object'
      ? (item._meta as Record<string, unknown>)
      : {};
  const ui =
    meta['ui'] !== null && typeof meta['ui'] === 'object' && !Array.isArray(meta['ui'])
      ? (meta['ui'] as Record<string, unknown>)
      : {};
  const parsedCsp = appUiCspSchema.safeParse(ui['csp']);
  const declared: AppUiCsp | undefined = parsedCsp.success ? parsedCsp.data : undefined;
  const cleaned = sanitizeAppCsp(declared, options);
  const ignored = [
    ...cleaned.rejected.map((entry) => `来源被拒绝：${entry}`),
    ...cleaned.unsupported.map((key) => `不支持的声明：${key}`),
    ...(ui['csp'] !== undefined && !parsedCsp.success ? ['csp 声明格式无效，按默认拒绝处理'] : []),
  ];
  const permissions =
    ui['permissions'] !== null && typeof ui['permissions'] === 'object'
      ? (ui['permissions'] as Record<string, unknown>)
      : {};
  const deniedPermissions = PERMISSION_KEYS.filter((key) => permissions[key] !== undefined);
  return {
    html,
    csp: buildAppCspHeader(cleaned),
    connectDomains: cleaned.connectDomains,
    resourceDomains: cleaned.resourceDomains,
    ignored,
    deniedPermissions: [...deniedPermissions],
    ...(typeof ui['prefersBorder'] === 'boolean' ? { prefersBorder: ui['prefersBorder'] } : {}),
  };
}
