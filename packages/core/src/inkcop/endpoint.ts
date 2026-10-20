import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * InkCop ↔ KepCup Agent Bridge：endpoint.json 发现（契约 §2 / v0.3）。
 * 路径约定在用户目录固定位置，与 KepCup `userData` 无关。
 * `version`：1 = v0.1；≥2 = 含 GET /v1/agents；≥3 = 用户密钥 + 可选局域网。
 */

/** endpoint.version 达到此值即表示 /v1/agents 可用。 */
export const INKCOP_AGENTS_API_MIN_VERSION = 2;

export function inkcopAgentsApiAvailable(endpoint: { version: number }): boolean {
  return endpoint.version >= INKCOP_AGENTS_API_MIN_VERSION;
}

export const inkcopEndpointSchema = z.object({
  version: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(32),
  pid: z.number().int().positive().optional(),
  baseUrl: z.string().url().optional(),
  startedAt: z.string().optional(),
  listenHost: z.string().optional(),
});
export type InkcopEndpoint = z.infer<typeof inkcopEndpointSchema>;

/** macOS / Linux / Windows 上的 endpoint.json 绝对路径。 */
export function inkcopEndpointPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'inkcop-local-bridge', 'endpoint.json');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'inkcop-local-bridge', 'endpoint.json');
  }
  return path.join(homedir(), '.local', 'share', 'inkcop-local-bridge', 'endpoint.json');
}

export type ReadEndpointResult =
  | { ok: true; endpoint: InkcopEndpoint; path: string }
  | { ok: false; reason: 'missing' | 'invalid'; path: string; detail?: string };

/** 读并校验 endpoint.json；文件不存在或内容非法时返回 ok:false。 */
export function readInkcopEndpoint(
  filePath: string = inkcopEndpointPath(),
): ReadEndpointResult {
  if (!existsSync(filePath)) return { ok: false, reason: 'missing', path: filePath };
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    const parsed = inkcopEndpointSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: 'invalid', path: filePath, detail: parsed.error.message };
    }
    return { ok: true, endpoint: parsed.data, path: filePath };
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid',
      path: filePath,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 解析请求 baseUrl：优先 endpoint.baseUrl，否则拼 loopback。 */
export function inkcopBaseUrl(endpoint: InkcopEndpoint): string {
  if (endpoint.baseUrl !== undefined && endpoint.baseUrl.length > 0) {
    return endpoint.baseUrl.replace(/\/$/, '');
  }
  return `http://127.0.0.1:${endpoint.port}`;
}

/** 设置 / 调用方可覆盖的鉴权与地址（契约 v0.3）。 */
export interface InkcopAuthOverrides {
  /** Bearer API 密钥；空则回落 endpoint.token。 */
  apiKey?: string;
  /** 服务地址覆盖（局域网/跨机）；空则用 endpoint / loopback。 */
  baseUrl?: string;
}

export interface ResolvedInkcopTarget {
  baseUrl: string;
  apiKey: string;
  endpoint: InkcopEndpoint | null;
  /** endpoint.version；无 endpoint 时为 0（仍可试调 /v1/agents）。 */
  version: number;
}

export type ResolveInkcopTargetResult =
  | { ok: true; target: ResolvedInkcopTarget }
  | { ok: false; reason: 'no_base_url' | 'no_api_key'; path?: string };

/**
 * 解析通讯目标：baseUrl = settings.baseUrl || endpoint.baseUrl；
 * apiKey = settings.apiKey || endpoint.token。无密钥时不可发请求。
 */
export function resolveInkcopTarget(
  overrides: InkcopAuthOverrides = {},
  options: { endpointPath?: string; endpoint?: InkcopEndpoint | null } = {},
): ResolveInkcopTargetResult {
  let endpoint: InkcopEndpoint | null;
  let pathHint: string | undefined;
  if (options.endpoint !== undefined) {
    endpoint = options.endpoint;
    pathHint = '(injected)';
  } else {
    const read = readInkcopEndpoint(options.endpointPath ?? inkcopEndpointPath());
    endpoint = read.ok ? read.endpoint : null;
    pathHint = read.path;
  }

  const overrideBase = (overrides.baseUrl ?? '').trim().replace(/\/$/, '');
  const overrideKey = (overrides.apiKey ?? '').trim();
  const baseUrl =
    overrideBase.length > 0 ? overrideBase : endpoint !== null ? inkcopBaseUrl(endpoint) : '';
  const apiKey = overrideKey.length > 0 ? overrideKey : (endpoint?.token ?? '');

  if (baseUrl.length === 0) {
    return { ok: false, reason: 'no_base_url', path: pathHint };
  }
  if (apiKey.length === 0) {
    return { ok: false, reason: 'no_api_key', path: pathHint };
  }
  return {
    ok: true,
    target: {
      baseUrl,
      apiKey,
      endpoint,
      version: endpoint?.version ?? 0,
    },
  };
}
