import type { FetchedProviderModel, ProviderApi } from '@kepcup/shared';
import { mapProviderError } from '../agent/models.js';

/**
 * 供应商「获取模型」的列表拉取（设置页）：按线协议适配列表端点与认证头，
 * 响应做宽容解析（各家 /models 的字段口径不一）。纯函数 + 可注入 fetch，
 * HTTP 编排与错误归类都在这里，ProvidersService 只负责 Key 解析。
 */

/** 单次拉取的条目上限：中转站可能返回数百个模型，防止弹框失控。 */
const MAX_FETCHED_MODELS = 500;

/** 与 shared `fetchedProviderModelSchema` 的字段上限一致；解析期钳制，避免单条坏条目让整个 RPC 的输出校验失败。 */
const MAX_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 200;

/** Anthropic 官方 /v1/models 要求的版本头（@anthropic-ai/sdk 同款）。 */
const ANTHROPIC_VERSION = '2023-06-01';

/** 列表端点：OpenAI 兼容根已含 /v1（如 dashscope compatible-mode），Anthropic 根在 pi 里由 SDK 追加 /v1/messages。 */
export function buildModelsUrl(baseUrl: string, api: ProviderApi): string {
  const root = baseUrl.replace(/\/+$/, '');
  return api === 'anthropic-messages' ? `${root}/v1/models` : `${root}/models`;
}

/** 认证头：OpenAI 风格 Bearer；Anthropic 风格 x-api-key。无 Key 时省略（本地服务可匿名）。 */
export function buildModelsHeaders(api: ProviderApi, key: string | null): Record<string, string> {
  if (api === 'anthropic-messages') {
    return {
      ...(key !== null && key.length > 0 ? { 'x-api-key': key } : {}),
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }
  return key !== null && key.length > 0 ? { Authorization: `Bearer ${key}` } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 上下文提示字段（LM Studio / OpenRouter 等的口径），取第一个正数并夹到 schema 上限。 */
function parseContextHint(row: Record<string, unknown>): number | null {
  for (const field of ['context_length', 'max_context_length', 'context_window']) {
    const value = row[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.min(10_000_000, Math.max(1, Math.round(value)));
    }
  }
  return null;
}

/**
 * 宽容解析 /models 响应：`{ data: [...] }`（OpenAI / Anthropic 官方）或裸数组；
 * 条目缺 id 跳过、按 id 去重、截断到上限。非列表形状抛错（上层归类为
 * UNREACHABLE，提示检查 baseUrl 与数据风格）。
 */
export function parseModelsResponse(body: unknown): FetchedProviderModel[] {
  const rows = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.data)
      ? body.data
      : null;
  if (rows === null) {
    throw new Error('响应不是模型列表 JSON，请检查 Base URL 与数据风格是否匹配');
  }
  const seen = new Set<string>();
  const models: FetchedProviderModel[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (id.length === 0 || id.length > MAX_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    const rawName =
      typeof row.display_name === 'string' && row.display_name.length > 0
        ? row.display_name
        : typeof row.name === 'string' && row.name.length > 0
          ? row.name
          : undefined;
    const name = rawName === undefined ? undefined : rawName.slice(0, MAX_NAME_LENGTH);
    const contextWindow = parseContextHint(row);
    models.push({
      id,
      ...(name !== undefined ? { name } : {}),
      ...(contextWindow !== null ? { contextWindow } : {}),
    });
    if (models.length >= MAX_FETCHED_MODELS) break;
  }
  return models;
}

/** 拉取可用模型列表；网络 / 状态码 / 解析错误统一经 mapProviderError 归类。 */
export async function fetchProviderModels(deps: {
  baseUrl: string;
  api: ProviderApi;
  /** 已解析的 Key；null = 匿名探测（本地服务）。 */
  key: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<FetchedProviderModel[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(buildModelsUrl(deps.baseUrl, deps.api), {
      method: 'GET',
      headers: buildModelsHeaders(deps.api, deps.key),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw mapProviderError(error);
  }
  if (!response.ok) {
    const snippet = (await response.text().catch(() => '')).slice(0, 200);
    throw mapProviderError(
      new Error(`HTTP ${response.status} ${response.statusText} ${snippet}`.trim()),
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw mapProviderError(
      new Error('模型列表响应不是 JSON，请检查 Base URL 与数据风格是否匹配'),
    );
  }
  try {
    return parseModelsResponse(body);
  } catch (error) {
    throw mapProviderError(error);
  }
}
