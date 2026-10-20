import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * InkCop ↔ KepCup 同机 Connection 桥：endpoint.json 发现（契约 v0.1 §2）。
 * 路径约定在用户目录固定位置，与 KepCup `userData` 无关。
 */

export const inkcopEndpointSchema = z.object({
  version: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(32),
  pid: z.number().int().positive().optional(),
  baseUrl: z.string().url().optional(),
  startedAt: z.string().optional(),
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
