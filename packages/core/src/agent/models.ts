import {
  AppError,
  isVendorId,
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
      const value = deps.secrets.getValue(providerSecretName(providerId));
      if (value === null) return undefined;
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
            resolve: async () => ({
              auth: { apiKey: deps.secrets.getValue(providerSecretName(instance.id)) ?? 'unused' },
            }),
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
          compat: { supportsDeveloperRole: false },
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
    }));
    if (chatModels.length === 0) continue;
    infos.push({
      id: provider.id,
      name: provider.name,
      kind: 'builtin',
      enabled: true,
      models: [...chatModels],
      hasKey: secrets.hasValue(providerSecretName(provider.id)),
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
        hasKey: secrets.hasValue(providerSecretName(instance.id)),
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
      })),
      hasKey: secrets.hasValue(providerSecretName(instance.id)),
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
      hasKey: secrets.hasValue(providerSecretName(vendor.id)),
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
