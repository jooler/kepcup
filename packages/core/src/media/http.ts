import { AppError } from '@kepcup/shared';

/**
 * 厂商 HTTP 基座：统一 Bearer 鉴权、超时与错误映射。适配器只关心
 * 各自的路径 / 载荷 / 响应形状，网络层错误在此归一为 AppError：
 * 401（以及非配额类 403）→ PROVIDER_AUTH_FAILED，配额 / 欠费 → PROVIDER_QUOTA，
 * 429 → PROVIDER_RATE_LIMITED，网络失败 → PROVIDER_UNREACHABLE，
 * 其余非 2xx → PROVIDER_UNAVAILABLE。
 */

export interface VendorHttpResponse {
  status: number;
  bodyText: string;
  /** 响应体的 base64（音频等二进制结果用；JSON 请求同样可用）。 */
  base64: string;
  json(): unknown;
}

export interface VendorHttpOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON 请求体（自动序列化并带 content-type）。 */
  json?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export class VendorHttpError extends AppError {
  constructor(
    public readonly status: number,
    message: string,
    bodyText = '',
    details?: unknown,
  ) {
    super(errorCodeForStatus(status, bodyText), message, details);
    this.name = 'VendorHttpError';
  }
}

/** 配额 / 欠费类拒绝的关键词（响应体小写匹配）：百炼 AllocationQuota / Arrearage、
 * OpenAI insufficient_quota、OpenRouter 余额不足等常见形态。 */
const QUOTA_MARKERS = [
  'quota',
  'arrears',
  'arrearage',
  '欠费',
  '余额不足',
  '额度不足',
  '额度用尽',
  'insufficient credit',
  'free tier',
] as const;

/** 限流类关键词：`Throttling.RateQuota` 这类带 quota 字样的限流不是配额耗尽。 */
const RATE_LIMIT_MARKERS = [
  'rate limit',
  'throttl',
  'too many requests',
  'requests per',
  'qps',
  'rpm',
] as const;

function bodyIncludesAny(bodyText: string, markers: readonly string[]): boolean {
  const body = bodyText.toLowerCase();
  return markers.some((marker) => body.includes(marker));
}

function errorCodeForStatus(status: number, bodyText: string): string {
  if (status === 401) return 'PROVIDER_AUTH_FAILED';
  // 402 = Payment Required（OpenRouter 等按余额计费的聚合商直接用它表示欠费）。
  if (status === 402) return 'PROVIDER_QUOTA';
  // 403 兼有两种含义：Key 有效但配额 / 欠费（如百炼免费额度用尽），与真权限 /
  // 认证问题。按响应体区分——配额误归认证失败会让能力工具把它当「未配置」
  // 引导用户重配，而配置明明是好的（docs/design/18-inline-setup.md 的引导
  // 前提是「缺的是用户配置」）。
  if (status === 403) {
    return bodyIncludesAny(bodyText, QUOTA_MARKERS) ? 'PROVIDER_QUOTA' : 'PROVIDER_AUTH_FAILED';
  }
  if (status === 429) {
    return bodyIncludesAny(bodyText, RATE_LIMIT_MARKERS) ||
      !bodyIncludesAny(bodyText, QUOTA_MARKERS)
      ? 'PROVIDER_RATE_LIMITED'
      : 'PROVIDER_QUOTA';
  }
  return 'PROVIDER_UNAVAILABLE';
}

/** 尽量取出厂商错误信息（message / error.message / code 常见形态）。 */
export function vendorErrorMessage(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      message?: unknown;
      error?: { message?: unknown; code?: unknown } | string;
      code?: unknown;
      msg?: unknown;
    };
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.error?.message === 'string') return parsed.error.message;
    for (const key of ['message', 'msg'] as const) {
      if (typeof parsed[key] === 'string') return parsed[key] as string;
    }
    if (typeof parsed.code === 'string') return parsed.code;
  } catch {
    // 非 JSON 错误体，原样截断。
  }
  return bodyText.slice(0, 300);
}

/** 去掉根路径末尾斜杠（拼接各端点路径用）。 */
export function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export async function vendorFetch(
  url: string,
  apiKey: string,
  options: VendorHttpOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<VendorHttpResponse> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, ...options.headers };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError('PROVIDER_UNREACHABLE', `厂商接口请求失败：${message}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const bodyText = buffer.toString('utf-8');
  if (!response.ok) {
    throw new VendorHttpError(
      response.status,
      vendorErrorMessage(bodyText) || `HTTP ${response.status}`,
      bodyText,
      {
        url,
        status: response.status,
        body: bodyText.slice(0, 500),
      },
    );
  }
  return {
    status: response.status,
    bodyText,
    base64: buffer.toString('base64'),
    json: () => {
      try {
        return JSON.parse(bodyText) as unknown;
      } catch {
        throw new AppError('PROVIDER_UNAVAILABLE', '厂商接口返回了非 JSON 内容', {
          url,
          body: bodyText.slice(0, 300),
        });
      }
    },
  };
}

/**
 * 下载二进制结果并转 base64。不带鉴权头——厂商返回的结果 URL（如百炼
 * 24h 有效音频地址）多为带签名的存储直链，附加 Authorization 反而会被拒。
 */
export async function fetchBinaryBase64(
  url: string,
  options: { timeoutMs?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError('PROVIDER_UNREACHABLE', `厂商结果下载失败：${message}`);
  }
  if (!response.ok) {
    throw new VendorHttpError(response.status, `结果下载失败：HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer()).toString('base64');
}
