import {
  AppError,
  isVendorId,
  maskApiKey,
  VENDOR_DESCRIPTORS,
  type ModelCapability,
  type ProviderInfo,
  type ProviderInstance,
  type Settings,
} from '@kepcup/shared';
import {
  createModels,
  createProvider,
  type Api,
  type Credential,
  type CredentialStore,
  type Model,
  type Models,
  type ProviderStreams,
} from '@earendil-works/pi-ai';

/** Any registered model, regardless of its wire API. */
export type AnyModel = Model<Api>;
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { SecretsService } from '../domain/secrets.js';
import type { CoreLogger } from '../infra/logger.js';
import { isModelRouteChangedError } from './model-retry.js';

/** 实例线协议 → pi 的 API 实现（ZCode 模板携带 anthropic / responses 端点）。 */
function apiImpl(api: Settings['modelProviders'][number]['api']): ProviderStreams {
  switch (api) {
    case 'anthropic-messages':
      return anthropicMessagesApi();
    case 'openai-responses':
      return openAIResponsesApi();
    default:
      return openAICompletionsApi();
  }
}

/** Secret name holding a provider's API key. */
export function providerSecretName(providerId: string): string {
  return `provider:${providerId}`;
}

/**
 * 同一供应商的追加 Key 槽位：首个 Key 沿用 `provider:<id>`（历史布局），
 * 其余写 `provider:<id>:key:<4 位序号>`。删除后重新编号，保持有序。
 */
const PROVIDER_KEY_SLOT = ':key:';

function providerKeySlotName(providerId: string, slot: number): string {
  return `${providerSecretName(providerId)}${PROVIDER_KEY_SLOT}${String(slot).padStart(4, '0')}`;
}

/** 已存 Key 的 secret 名，按存储顺序（首个在前）。 */
export function providerKeySecretNames(secrets: SecretsService, providerId: string): string[] {
  const base = providerSecretName(providerId);
  const prefix = `${base}${PROVIDER_KEY_SLOT}`;
  const extras = secrets
    .names()
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  return secrets.hasValue(base) ? [base, ...extras] : extras;
}

/** 已存 Key 的单条状态：值 + 标注（别名、启停）。 */
export interface ProviderKeyEntry {
  key: string;
  alias?: string;
  enabled: boolean;
}

/**
 * Key 槽位的落盘格式：`{"key":...,"alias":...,"enabled":false}`（多 Key 功能
 * 引入后的 JSON envelope，含标注）；旧值为纯文本 Key（缺省启用、无别名）。
 * 元数据随 Key 存进同一槽位，删除 / 重编号天然对齐，明文不出加密表。
 */
function parseProviderKeyEntry(value: string): ProviderKeyEntry {
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as { key?: unknown; alias?: unknown; enabled?: unknown };
      if (typeof parsed.key === 'string' && parsed.key.length > 0) {
        return {
          key: parsed.key,
          ...(typeof parsed.alias === 'string' && parsed.alias.length > 0
            ? { alias: parsed.alias }
            : {}),
          enabled: parsed.enabled !== false,
        };
      }
    } catch {
      // 非法 JSON（理论上不会出现）：按旧格式纯 Key 处理。
    }
  }
  return { key: value, enabled: true };
}

function serializeProviderKeyEntry(entry: ProviderKeyEntry): string {
  return JSON.stringify({
    key: entry.key,
    ...(entry.alias !== undefined ? { alias: entry.alias } : {}),
    ...(entry.enabled ? {} : { enabled: false }),
  });
}

/** 按存储顺序读出全部 Key 条目；损坏的条目跳过，不让设置页整体失败。 */
export function readProviderEntries(secrets: SecretsService, providerId: string): ProviderKeyEntry[] {
  const entries: ProviderKeyEntry[] = [];
  for (const name of providerKeySecretNames(secrets, providerId)) {
    try {
      const value = secrets.getValue(name);
      if (value !== null && value.length > 0) {
        const entry = parseProviderKeyEntry(value);
        // envelope 槽位的存储值是整串 JSON，secrets.redact 的精确子串匹配盖不到
        // 内层明文 Key——读出时补登记（旧纯文本值本就是存储值，重复登记无害）。
        secrets.registerRedactValue(entry.key);
        entries.push(entry);
      }
    } catch {
      // 单条解密失败（密钥轮换 / 数据损坏）时其余 Key 仍可用。
    }
  }
  return entries;
}

/** 按存储顺序读出全部 Key 值。 */
export function readProviderKeys(secrets: SecretsService, providerId: string): string[] {
  return readProviderEntries(secrets, providerId).map((entry) => entry.key);
}

function removeProviderKeys(secrets: SecretsService, providerId: string): void {
  for (const name of providerKeySecretNames(secrets, providerId)) secrets.removeValue(name);
}

/** 整体替换 Key 列表（providers.setKey 的语义：单 Key 覆盖，标注一并重置）。 */
export function replaceProviderKeys(
  secrets: SecretsService,
  providerId: string,
  entries: readonly ProviderKeyEntry[],
): void {
  removeProviderKeys(secrets, providerId);
  entries.forEach((entry, index) => {
    secrets.setValue(
      index === 0 ? providerSecretName(providerId) : providerKeySlotName(providerId, index),
      serializeProviderKeyEntry(entry),
    );
  });
}

/** 追加一个 Key；已存在相同值时不重复写入。 */
export function addProviderKey(secrets: SecretsService, providerId: string, key: string): void {
  if (readProviderKeys(secrets, providerId).includes(key)) return;
  const names = providerKeySecretNames(secrets, providerId);
  if (names.length === 0) {
    secrets.setValue(providerSecretName(providerId), serializeProviderKeyEntry({ key, enabled: true }));
    return;
  }
  const prefix = `${providerSecretName(providerId)}${PROVIDER_KEY_SLOT}`;
  const used = new Set(
    names
      .filter((name) => name.startsWith(prefix))
      .map((name) => Number(name.slice(prefix.length))),
  );
  let slot = 1;
  while (used.has(slot)) slot++;
  secrets.setValue(
    providerKeySlotName(providerId, slot),
    serializeProviderKeyEntry({ key, enabled: true }),
  );
}

/** 按下标删除一个 Key 并重新编号（其余条目的标注原样保留）；下标非法时报 INVALID_INPUT。 */
export function removeProviderKeyAt(
  secrets: SecretsService,
  providerId: string,
  index: number,
): void {
  const entries = readProviderEntries(secrets, providerId);
  if (index < 0 || index >= entries.length) {
    throw new AppError('INVALID_INPUT', `API Key #${index} 不存在`);
  }
  entries.splice(index, 1);
  replaceProviderKeys(secrets, providerId, entries);
}

/** 更新单个 Key 的标注（别名 / 启停）；其余条目不动。 */
export function updateProviderKeyMeta(
  secrets: SecretsService,
  providerId: string,
  index: number,
  patch: { alias?: string; enabled?: boolean },
): void {
  const names = providerKeySecretNames(secrets, providerId);
  if (index < 0 || index >= names.length) {
    throw new AppError('INVALID_INPUT', `API Key #${index} 不存在`);
  }
  const current = parseProviderKeyEntry(secrets.getValue(names[index]!) ?? '');
  if (current.key.length === 0) {
    throw new AppError('INVALID_INPUT', `API Key #${index} 不存在`);
  }
  const alias = patch.alias !== undefined ? patch.alias.trim() : current.alias;
  // 单槽位原位更新：别名 / 启停是高频操作，不走「全删重写」，避免进程在
  // 删除与重写之间中断时丢掉该供应商的全部 Key。
  secrets.setValue(
    names[index]!,
    serializeProviderKeyEntry({
      key: current.key,
      ...(alias !== undefined && alias.length > 0 ? { alias } : {}),
      enabled: patch.enabled ?? current.enabled,
    }),
  );
}

/** 进程内轮询游标：每个供应商独立，逐个请求在启用中的 Key 间轮换。 */
const providerKeyCursor = new Map<string, number>();

/** 有已存 Key 但全部停用。这是用户明确的意图（不是「还没配 Key」），调用必须
 * 失败而不是回退：内置厂商会落到环境变量凭据，兼容实例会带着占位 key 发出去，
 * 表现出来的就是「停用的 Key 仍在被使用」。 */
function providerKeysAllDisabled(entries: readonly ProviderKeyEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => !entry.enabled);
}

/** 在已读出的条目里按游标取下一个启用的 Key；没有启用的条目时返回 null。 */
function selectNextKey(
  entries: readonly ProviderKeyEntry[],
  providerId: string,
): string | null {
  const keys = entries.filter((entry) => entry.enabled).map((entry) => entry.key);
  if (keys.length === 0) return null;
  const cursor = providerKeyCursor.get(providerId) ?? 0;
  providerKeyCursor.set(providerId, (cursor + 1) % keys.length);
  return keys[cursor % keys.length] ?? null;
}

/** 取下一次调用应使用的 Key（跳过停用条目）；没有可用 Key 时返回 null。 */
export function nextProviderApiKey(
  secrets: SecretsService,
  providerId: string,
): string | null {
  return selectNextKey(readProviderEntries(secrets, providerId), providerId);
}

/**
 * 每个供应商在本进程内记一次「有哪几条 Key」（只记掩码）。多 Key 轮换时，
 * 429 到底是哪条 Key 的额度、请求是否在两条 Key 之间来回切，看这一行就知道。
 */
const loggedProviderKeys = new Set<string>();

function logProviderKeys(
  logger: CoreLogger,
  providerId: string,
  entries: readonly ProviderKeyEntry[],
): void {
  if (loggedProviderKeys.has(providerId)) return;
  loggedProviderKeys.add(providerId);
  const enabled = entries.filter((entry) => entry.enabled);
  logger.info(
    {
      providerId,
      enabledKeys: enabled.length,
      disabledKeys: entries.length - enabled.length,
      keyMasks: enabled.map((entry) => maskApiKey(entry.key)),
    },
    'provider keys loaded',
  );
}

/**
 * 供应商实例查找（settings.modelProviders）。实例 id 即运行时注册表 id：
 * 内置厂商实例沿用厂商 id（首个）或 `dashscope-2` 之类的派生 id，自定义
 * 实例带 `custom:` 前缀。
 */
export function findProviderInstance(
  settings: Settings,
  providerId: string,
): ProviderInstance | undefined {
  return settings.modelProviders.find((p) => p.id === providerId);
}

/**
 * A provider's effective OpenAI-compatible root: 供应商实例用实例上的
 * baseUrl（内置厂商实例含覆盖值与描述符默认根的合并结果）；vendor id 兜底
 * 描述符默认根（覆盖迁移前遗留的裸厂商引用）；内置 pi 供应商为 null（它
 * 们的 baseUrl 在 pi 的目录里）。
 */
export function providerCompatBaseUrl(settings: Settings, providerId: string): string | null {
  const instance = findProviderInstance(settings, providerId);
  if (instance) return instance.baseUrl ?? null;
  if (isVendorId(providerId)) return VENDOR_DESCRIPTORS[providerId].baseUrl;
  return null;
}

export class ModelResolutionError extends AppError {}

/**
 * Builds a pi-ai Models collection from the app settings and the encrypted
 * secrets table. Built-in providers resolve keys through a credential store
 * that decrypts on every request; 供应商实例里声明了 `chat` 能力的模型注册为
 * OpenAI 兼容端点（专有模型——向量/重排/…——不进对话注册表，由 media 网关
 * 按 capabilityModels 路由）。
 */
export function buildModelRegistry(deps: {
  settings: Settings;
  secrets: SecretsService;
  logger: CoreLogger;
}): Models {
  const credentialStore: CredentialStore = {
    async read(providerId: string): Promise<Credential | undefined> {
      const entries = readProviderEntries(deps.secrets, providerId);
      if (providerKeysAllDisabled(entries)) {
        throw new AppError(
          'PROVIDER_AUTH_FAILED',
          `供应商 ${providerId} 的 API Key 已全部停用（启用至少一个后再试）`,
        );
      }
      const value = entries.length === 0 ? null : selectNextKey(entries, providerId);
      if (value === null) return undefined;
      logProviderKeys(deps.logger, providerId, entries);
      return { type: 'api_key', key: value };
    },
    async list() {
      return deps.secrets
        .names()
        .filter((n) => n.startsWith('provider:'))
        .map((n) => ({ providerId: n.slice('provider:'.length), type: 'api_key' as const }));
    },
    async modify() {
      throw new AppError('INTERNAL', 'Credential writes go through the secrets service');
    },
    async delete() {
      throw new AppError('INTERNAL', 'Credential writes go through the secrets service');
    },
  };

  const models = createModels({ credentials: credentialStore });
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }
  for (const instance of deps.settings.modelProviders) {
    // pi 内置目录实例：注册表已有同名 provider（builtinProviders），不覆盖，
    // 模型清单直接用 pi 目录。
    if (instance.builtinCatalog) continue;
    if (!instance.enabled) continue;
    const chatModels = instance.models.filter((m) => m.capabilities.includes('chat'));
    if (chatModels.length === 0) continue;
    models.setProvider(
      createProvider({
        id: instance.id,
        name: instance.name,
        baseUrl: instance.baseUrl ?? '',
        auth: {
          apiKey: {
            name: instance.name,
            resolve: async ({ credential }) => {
              // credentialStore 已按请求轮换出本次 Key；这里直接沿用，
              // 不再前进游标（否则每个请求会消耗两次轮换）。
              const key =
                credential?.type === 'api_key'
                  ? credential.key
                  : nextProviderApiKey(deps.secrets, instance.id);
              return { auth: { apiKey: key ?? 'unused' } };
            },
          },
        },
        models: chatModels.map((m): Model<'openai-completions'> => ({
          id: m.id,
          name: m.name ?? m.id,
          api: 'openai-completions',
          provider: instance.id,
          baseUrl: instance.baseUrl ?? '',
          reasoning: false,
          // P11: models declaring "image" receive browser screenshots.
          input: m.input ?? ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow,
          maxTokens: Math.min(32_000, Math.max(1_024, Math.floor(m.contextWindow / 4))),
          // 兼容收敛：developer 角色与 OpenAI 专有的 store（蒸馏存储开关）
          // 都不是通用兼容端点的字段——Gemini 等严格校验的实现会因未知字段
          // 整单 400，一律不发（不发 store 对 OpenAI 也无行为差异，缺省即 false）。
          compat: { supportsDeveloperRole: false, supportsStore: false },
        })),
        api: apiImpl(instance.api),
      }),
    );
  }

  return models;
}

/** Splits a "provider/modelId" reference. */
export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const index = ref.indexOf('/');
  if (index <= 0 || index === ref.length - 1) {
    throw new AppError('INVALID_INPUT', `Invalid model reference "${ref}"`);
  }
  return { provider: ref.slice(0, index), modelId: ref.slice(index + 1) };
}

/** Resolves a "provider/modelId" reference against the registry. */
export function resolveModel(models: Models, ref: string): AnyModel {
  const { provider, modelId } = parseModelRef(ref);
  const model = models.getModel(provider, modelId);
  if (!model) {
    throw new AppError('NOT_FOUND', `Unknown model "${ref}"`);
  }
  return model;
}

/** Provider metadata for the settings page (never includes keys). */
export function providerInfoList(
  models: Models,
  settings: Settings,
  secrets: SecretsService,
): ProviderInfo[] {
  const infos: ProviderInfo[] = [];
  const keyInfo = (providerId: string): Pick<ProviderInfo, 'hasKey' | 'keyPreviews'> => {
    const entries = readProviderEntries(secrets, providerId);
    return {
      // 全部停用视为无可用 Key：调用层会跳过，模型下拉 / 能力预检也应视为未配置。
      hasKey: entries.some((entry) => entry.enabled),
      keyPreviews: entries.map((entry) => ({
        mask: maskApiKey(entry.key),
        ...(entry.alias !== undefined ? { alias: entry.alias } : {}),
        enabled: entry.enabled,
      })),
    };
  };
  const instanceIds = new Set(settings.modelProviders.map((p) => p.id));
  for (const provider of models.getProviders()) {
    // 供应商实例在下方按 settings 合成（含专有能力模型）；pi 内置目录里
    // 撞了实例 id 的行跳过（不应发生，防御目录变更）。
    if (instanceIds.has(provider.id)) continue;
    // pi 1.x 起内置目录含非对话 provider（如 typesafe 分类器，0 个对话模型）：
    // 空模型列表的行对设置页没有意义，跳过。
    const chatModels = provider.getModels().map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: Number(m.contextWindow ?? 0),
      capabilities: ['chat'] as ModelCapability[],
      // pi meta 的输入种类（含 'image' = 支持视觉）：渲染层附件直注预检用。
      input: m.input,
    }));
    if (chatModels.length === 0) continue;
    infos.push({
      id: provider.id,
      name: provider.name,
      kind: 'builtin',
      enabled: true,
      models: [...chatModels],
      ...keyInfo(provider.id),
    });
  }
  // 供应商实例：全部模型（含专有能力模型）带能力声明列出，供设置页渲染
  // 模型行与能力槽位候选；停用实例照列（UI 显示状态）。pi 内置目录实例
  // （builtinCatalog）的模型清单取自注册表里的同名 pi provider。
  for (const instance of settings.modelProviders) {
    if (instance.builtinCatalog) {
      const provider = models.getProvider(instance.id);
      const chatModels = provider
        ? provider.getModels().map((m) => ({
            id: m.id,
            name: m.name,
            contextWindow: Number(m.contextWindow ?? 0),
            capabilities: ['chat'] as ModelCapability[],
            input: m.input,
          }))
        : [];
      if (chatModels.length === 0) continue;
      infos.push({
        id: instance.id,
        name: instance.name,
        kind: 'builtin',
        baseUrl: instance.baseUrl,
        enabled: instance.enabled,
        models: chatModels,
        ...keyInfo(instance.id),
      });
      continue;
    }
    infos.push({
      id: instance.id,
      name: instance.name,
      kind: instance.vendor === null ? 'custom' : 'vendor',
      ...(instance.vendor !== null ? { vendor: instance.vendor } : {}),
      baseUrl: instance.baseUrl,
      enabled: instance.enabled,
      models: instance.models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.contextWindow,
        capabilities: [...m.capabilities],
        ...(m.input !== undefined ? { input: m.input } : {}),
      })),
      ...keyInfo(instance.id),
    });
  }
  // 尚未建实例的内置厂商始终列出（模型为空）：能力槽位与对话内设置卡需要
  // 能选到它们（配 Key / 配能力模型时由设置页或适配器补建实例）。
  for (const vendor of Object.values(VENDOR_DESCRIPTORS)) {
    if (infos.some((info) => info.id === vendor.id)) continue;
    infos.push({
      id: vendor.id,
      name: vendor.name,
      kind: 'vendor',
      vendor: vendor.id,
      baseUrl: vendor.baseUrl,
      enabled: true,
      models: [],
      ...keyInfo(vendor.id),
    });
  }
  return infos;
}

/**
 * Minimal provider request used by "测试连接". Throws an AppError whose code
 * distinguishes auth failures from network failures.
 */
export async function testProvider(deps: {
  models: Models;
  model: AnyModel;
  signal?: AbortSignal;
  /**
   * Opaque session id (`providerTestSessionId` in model-session-id.ts). pi-ai
   * sends it to the provider as routing / prompt-cache hints.
   */
  sessionId?: string;
}): Promise<void> {
  let result;
  try {
    result = await deps.models.complete(
      deps.model,
      {
        systemPrompt: 'You are a connection test. Reply with the single word: ok',
        messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
        tools: [],
      },
      { maxTokens: 1_024, ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}) },
    );
  } catch (error) {
    throw mapProviderError(error);
  }
  // Provider errors can arrive as an error stop reason instead of a throw.
  if (result.stopReason === 'error') {
    throw mapProviderError(new Error(result.errorMessage ?? 'provider request failed'));
  }
}

/** Maps pi/provider errors onto the app error codes. */
export function mapProviderError(error: unknown): AppError {
  if (isModelRouteChangedError(error)) {
    return new AppError(
      'PROVIDER_UNAVAILABLE',
      error instanceof Error ? error.message : '模型设置已变更，中止对旧模型的重试',
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes('401') ||
    lower.includes('api key') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key')
  ) {
    return new AppError('PROVIDER_AUTH_FAILED', message);
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return new AppError('PROVIDER_RATE_LIMITED', message);
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('fetch failed') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('aborted') ||
    lower.includes('404')
  ) {
    return new AppError('PROVIDER_UNREACHABLE', message);
  }
  if (
    lower.includes('context length') ||
    lower.includes('too large') ||
    lower.includes('max_tokens')
  ) {
    return new AppError('CONTEXT_TOO_LARGE', message);
  }
  return new AppError('PROVIDER_UNAVAILABLE', message);
}
