import {
  discoverOAuthServerInfo,
  parseWwwAuthenticate,
  selectResource,
} from '@earendil-works/pi-mcp/oauth';
import type { McpFetch } from '@earendil-works/pi-mcp';
import { AppError, sanitizeScopes } from '@kepcup/shared';
import {
  PRIVATE_ADDRESS_REJECTION_PREFIX,
  connectRejectionText,
} from '../infra/safe-dispatcher.js';
import type { CoreLogger } from '../infra/logger.js';
import { sameSite } from './auth/flow.js';
import { isLoopbackAllowed } from './auth/safe-fetch.js';
import { isSafeDirectoryRemoteUrl } from './directory-merge.js';

/**
 * 本机连接的探测（todo/local-connector-authoring.md §2.3）：对 Bot 给出的 MCP 地址做一次
 * **无登录、无令牌**的 `initialize`，据 401 + `WWW-Authenticate` → 受保护资源元数据 → 授权服务器
 * 元数据判断它能不能走「自动注册 OAuth」。结果就是本机条目内容的**唯一来源**。
 *
 * 网络层只用调用方注入的 `fetch`（`createSafeFetch`：https only、连接时校验解析地址拒绝私网 /
 * 保留地址、响应体上限、只跟随同源重定向——跨主机重定向直接拒绝），不另写 HTTP 客户端。
 * 拒绝一律抛 `LOCAL_CONNECTOR_REJECTED`，message 是给 Bot / 用户看的具体原因（zh-CN）。
 */

const PROBE_TIMEOUT_MS = 8_000;

export interface LocalProbeResult {
  /** 客户端注册方式：授权服务器支持 CIMD 优先，否则 DCR。 */
  registration: 'cimd' | 'dcr';
  /** 授权服务器 issuer。 */
  issuer: string;
  /** 授权服务器主机（含端口），卡片上展示。 */
  issuerHost: string;
  /** 授权服务器与 MCP 服务不同站点（评审 A1）：别家的授权服务器可能被借来给这个地址签发令牌。 */
  issuerCrossSite: boolean;
  /** 将请求的范围：401 挑战的 scope，否则资源元数据的 `scopes_supported`；可空。 */
  scopes: string[];
}

export interface LocalProbeDeps {
  fetch: McpFetch;
  /** 允许明文 / 回环端点的主机（生产恒为空）。 */
  loopbackAllowlist: readonly string[];
  signal?: AbortSignal | undefined;
  /** 探测失败的原始细节只写日志（给 Bot / 用户的原因是固定文案，不回显库的原始报错 / 解析到的 IP）。 */
  logger?: Pick<CoreLogger, 'info'> | undefined;
}

function reject(message: string): AppError {
  return new AppError('LOCAL_CONNECTOR_REJECTED', message);
}

/** 探测过程中遇到的端点（授权 / 令牌 / 注册）：https 公网域名；测试白名单里的回环主机除外。 */
function endpointAllowed(raw: string, loopbackAllowlist: readonly string[]): boolean {
  try {
    if (isLoopbackAllowed(new URL(raw), loopbackAllowlist)) return true;
  } catch {
    return false;
  }
  return isSafeDirectoryRemoteUrl(raw);
}

/** 范围名：按 RFC 6749 scope-token 过滤（非法字符 / 超长 / 重复 / 超个数的丢弃，评审 A3）。 */
function splitScopes(scope: string | undefined): string[] {
  return sanitizeScopes((scope ?? '').split(/\s+/));
}

/** `initialize` 的 200 响应是不是 MCP（JSON-RPC result 带 protocolVersion / serverInfo）。 */
function looksLikeMcpInitialize(text: string): boolean {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) candidates.push(line.slice(5).trim());
  }
  for (const candidate of candidates) {
    try {
      const message = JSON.parse(candidate) as { jsonrpc?: unknown; result?: unknown };
      const result = message.result as
        { protocolVersion?: unknown; serverInfo?: unknown } | undefined;
      if (
        message.jsonrpc === '2.0' &&
        typeof result === 'object' &&
        result !== null &&
        (typeof result.protocolVersion === 'string' || typeof result.serverInfo === 'object')
      ) {
        return true;
      }
    } catch {
      // not JSON: keep looking
    }
  }
  return false;
}

export async function probeLocalConnector(
  mcpUrl: string,
  deps: LocalProbeDeps,
): Promise<LocalProbeResult> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
    ...(deps.signal !== undefined ? [deps.signal] : []),
  ]);
  const fetch: McpFetch = (input, init) =>
    deps.fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    });

  let response: Response;
  try {
    response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'KepCup', version: '0' },
        },
      }),
    });
  } catch (error) {
    throw describeNetworkFailure(error, '无法连接到该地址', deps.logger);
  }

  if (response.status === 200) {
    const mcp = looksLikeMcpInitialize(await response.text().catch(() => ''));
    throw reject(
      mcp
        ? '该 MCP 服务无需登录即可访问：本机连接只支持需要 OAuth 授权的服务（无需认证的 MCP 服务请在「设置 → 开发者模式」里手动添加）'
        : '该地址返回了 200 但不是 MCP 服务端点（initialize 请求没有得到 JSON-RPC 响应），请确认文档里的 MCP 地址',
    );
  }
  void response.body?.cancel().catch(() => undefined);
  if (response.status !== 401) {
    throw reject(
      `该地址对 MCP initialize 请求返回了 HTTP ${response.status}，不像是需要 OAuth 授权的 MCP 端点，请确认文档里的 MCP 地址`,
    );
  }
  const header = response.headers.get('www-authenticate');
  if (header === null || !/^\s*(?:bearer|dpop)\b/i.test(header)) {
    throw reject(
      '该地址返回 401 但没有 Bearer 授权挑战（WWW-Authenticate），不是标准的 OAuth 保护的 MCP 端点',
    );
  }
  const challenge = parseWwwAuthenticate(header);

  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(mcpUrl, {
      ...(challenge.resourceMetadataUrl !== undefined
        ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
        : {}),
      fetch,
    });
  } catch (error) {
    throw describeNetworkFailure(error, '读取授权服务器元数据失败', deps.logger);
  }
  try {
    selectResource(mcpUrl, info.resourceMetadata);
  } catch {
    throw reject('受保护资源元数据声明的资源与 MCP 地址不匹配，已中止');
  }
  const metadata = info.authorizationServerMetadata;
  if (metadata === undefined) {
    throw reject('找不到授权服务器元数据（RFC 8414 / OIDC discovery），无法确定如何授权');
  }
  for (const endpoint of [
    metadata.issuer,
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ]) {
    if (endpoint !== undefined && !endpointAllowed(endpoint, deps.loopbackAllowlist)) {
      throw reject('授权服务器的端点不是公网 https 域名（可能是 IP、内网或明文地址），已拒绝');
    }
  }
  if (metadata.code_challenge_methods_supported?.includes('S256') !== true) {
    throw reject('授权服务器没有声明支持 PKCE S256，已拒绝');
  }
  const cimd = metadata.client_id_metadata_document_supported === true;
  if (!cimd && metadata.registration_endpoint === undefined) {
    throw reject(
      '授权服务器既不支持客户端元数据文档（CIMD）也没有动态注册端点（DCR）：需要预先登记密钥的服务暂不支持本机连接',
    );
  }
  const scopes = splitScopes(challenge.scope ?? info.resourceMetadata?.scopes_supported?.join(' '));
  return {
    registration: cimd ? 'cimd' : 'dcr',
    issuer: metadata.issuer,
    issuerHost: new URL(metadata.issuer).host,
    issuerCrossSite: !sameSite(new URL(mcpUrl).hostname, new URL(metadata.issuer).hostname),
    scopes,
  };
}

/**
 * 网络 / 发现阶段失败 → 给人看的**固定**原因（评审 A6）：不回显库的原始报错，更不回显解析到的
 * 内网 IP（那会让 Bot 把域名当成探测内网的工具）；原始细节只写日志。
 */
function describeNetworkFailure(
  error: unknown,
  prefix: string,
  logger: LocalProbeDeps['logger'],
): AppError {
  if (error instanceof AppError && error.code === 'LOCAL_CONNECTOR_REJECTED') return error;
  const raw = error instanceof Error ? error.message : String(error);
  logger?.info({ detail: raw.slice(0, 300) }, 'local connector probe failed');
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return reject(`${prefix}：请求超时`);
  if (raw.includes(PRIVATE_ADDRESS_REJECTION_PREFIX) || connectRejectionText(error) !== null) {
    return reject(`${prefix}：该域名解析到内网或保留地址，已拒绝`);
  }
  if (raw.includes('跨源重定向'))
    return reject(`${prefix}：对方把请求重定向到了另一个站点，已拒绝（跨源重定向）`);
  if (error instanceof AppError && error.code === 'OAUTH_INSECURE_ENDPOINT') {
    return reject(`${prefix}：连接被安全策略拒绝（必须是公网 https 地址）`);
  }
  return reject(`${prefix}：连接失败或对方没有按预期响应`);
}
