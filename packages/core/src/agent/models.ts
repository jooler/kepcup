import {
  AppError,
  isVendorId,
  VENDOR_DESCRIPTORS,
  vendorProviderBaseUrl,
  type ProviderInfo,
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
} from '@earendil-works/pi-ai';

/** Any registered model, regardless of its wire API. */
export type AnyModel = Model<Api>;
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { SecretsService } from '../domain/secrets.js';
import type { CoreLogger } from '../infra/logger.js';

/** Secret name holding a provider's API key. */
export function providerSecretName(providerId: string): string {
  return `provider:${providerId}`;
}

/** Custom providers are namespaced to avoid clashing with built-in ids. */
export function customProviderId(id: string): string {
  return `custom:${id}`;
}

/**
 * A provider's effective OpenAI-compatible root: vendor entries use their
 * (possibly overridden) descriptor baseUrl, custom entries their stored one.
 * Null for built-in pi providers (their baseUrl lives inside pi's catalog).
 */
export function providerCompatBaseUrl(settings: Settings, providerId: string): string | null {
  if (isVendorId(providerId)) {
    const entry = settings.vendorProviders.find((v) => v.id === providerId);
    return entry ? vendorProviderBaseUrl(entry) : VENDOR_DESCRIPTORS[providerId].baseUrl;
  }
  const entryId = providerId.startsWith('custom:')
    ? providerId.slice('custom:'.length)
    : providerId;
  const entry = settings.customProviders.find((c) => c.id === entryId);
  return entry?.baseUrl ?? null;
}

export class ModelResolutionError extends AppError {}

/**
 * Builds a pi-ai Models collection from the app settings and the encrypted
 * secrets table. Built-in providers resolve keys through a credential store
 * that decrypts on every request; custom providers get an OpenAI-compatible
 * endpoint with the same behavior.
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
  for (const custom of deps.settings.customProviders) {
    const id = customProviderId(custom.id);
    models.setProvider(
      createProvider({
        id,
        name: custom.name,
        baseUrl: custom.baseUrl,
        auth: {
          apiKey: {
            name: custom.name,
            resolve: async () => ({
              auth: { apiKey: deps.secrets.getValue(providerSecretName(id)) ?? 'unused' },
            }),
          },
        },
        models: custom.models.map((m): Model<'openai-completions'> => ({
          id: m.id,
          name: m.name,
          api: 'openai-completions',
          provider: id,
          baseUrl: custom.baseUrl,
          reasoning: false,
          // P11: models declaring "image" receive browser screenshots.
          input: m.input ?? ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow,
          maxTokens: Math.min(32_000, Math.max(1_024, Math.floor(m.contextWindow / 4))),
          compat: { supportsDeveloperRole: false },
        })),
        api: openAICompletionsApi(),
      }),
    );
  }
  // 国内厂商：对话走各家 OpenAI 兼容根；其余能力（向量/重排/多模态/语音/
  // 图片/视频）不进对话注册表，由 media 网关按 capabilityModels 路由。
  for (const vendor of deps.settings.vendorProviders) {
    const descriptor = VENDOR_DESCRIPTORS[vendor.id];
    if (vendor.models.length === 0) continue;
    const baseUrl = vendorProviderBaseUrl(vendor);
    models.setProvider(
      createProvider({
        id: vendor.id,
        name: descriptor.name,
        baseUrl,
        auth: {
          apiKey: {
            name: descriptor.name,
            resolve: async () => ({
              auth: { apiKey: deps.secrets.getValue(providerSecretName(vendor.id)) ?? 'unused' },
            }),
          },
        },
        models: vendor.models.map((m): Model<'openai-completions'> => ({
          id: m.id,
          name: m.name ?? m.id,
          api: 'openai-completions',
          provider: vendor.id,
          baseUrl,
          reasoning: false,
          input: m.input ?? ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 131_072,
          maxTokens: Math.min(
            32_000,
            Math.max(1_024, Math.floor((m.contextWindow ?? 131_072) / 4)),
          ),
          compat: { supportsDeveloperRole: false },
        })),
        api: openAICompletionsApi(),
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
  for (const provider of models.getProviders()) {
    // 厂商条目统一在循环外按 settings 合成（含非对话能力的模型）。
    if (isVendorId(provider.id)) continue;
    const isCustom = provider.id.startsWith('custom:');
    // pi 1.x 起内置目录含非对话 provider（如 typesafe 分类器，0 个对话模型）：
    // 空模型列表的行对设置页没有意义，跳过。
    const chatModels = provider.getModels().map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: Number(m.contextWindow ?? 0),
    }));
    if (chatModels.length === 0) continue;
    infos.push({
      id: provider.id,
      name: provider.name,
      kind: isCustom ? 'custom' : 'builtin',
      baseUrl: isCustom
        ? settings.customProviders.find((c) => customProviderId(c.id) === provider.id)?.baseUrl
        : undefined,
      models: chatModels,
      hasKey: secrets.hasValue(providerSecretName(provider.id)),
    });
  }
  // 国内厂商始终列出（无论是否已配置条目）：能力模型 section 需要显示
  // 各厂商的 key 状态；模型行只含对话模型（其余能力在 capabilityModels）。
  for (const vendor of settings.vendorProviders) {
    const descriptor = VENDOR_DESCRIPTORS[vendor.id];
    infos.push({
      id: vendor.id,
      name: descriptor.name,
      kind: 'vendor',
      vendor: vendor.id,
      baseUrl: vendorProviderBaseUrl(vendor),
      models: vendor.models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.contextWindow ?? 131_072,
      })),
      hasKey: secrets.hasValue(providerSecretName(vendor.id)),
    });
  }
  for (const vendor of Object.values(VENDOR_DESCRIPTORS)) {
    if (infos.some((info) => info.id === vendor.id)) continue;
    infos.push({
      id: vendor.id,
      name: vendor.name,
      kind: 'vendor',
      vendor: vendor.id,
      baseUrl: vendor.baseUrl,
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
      { maxTokens: 1_024 },
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
