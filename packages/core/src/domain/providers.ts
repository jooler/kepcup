import {
  AppError,
  isVendorId,
  VENDOR_DESCRIPTORS,
  type CapabilityModelKey,
  type ModelCapability,
  type ProviderInfo,
} from '@kepcup/shared';
import {
  buildModelRegistry,
  providerInfoList,
  providerSecretName,
  resolveModel,
  testProvider,
} from '../agent/models.js';
import type { MediaService } from '../media/service.js';
import type { SettingsService } from './settings.js';
import type { SecretsService } from './secrets.js';
import type { CoreLogger } from '../infra/logger.js';

/** Provider management behind the `providers.*` RPC methods. */
export class ProvidersService {
  readonly #settings: SettingsService;
  readonly #secrets: SecretsService;
  readonly #logger: CoreLogger;
  /** 按能力测试的路由（image/tts/asr/video/embedding 的最小真实探测）。 */
  readonly #media: MediaService | null;

  constructor(deps: {
    settings: SettingsService;
    secrets: SecretsService;
    logger: CoreLogger;
    media?: MediaService;
  }) {
    this.#settings = deps.settings;
    this.#secrets = deps.secrets;
    this.#logger = deps.logger;
    this.#media = deps.media ?? null;
  }

  list(): ProviderInfo[] {
    const models = buildModelRegistry({
      settings: this.#settings.get(),
      secrets: this.#secrets,
      logger: this.#logger,
    });
    return providerInfoList(models, this.#settings.get(), this.#secrets);
  }

  setKey(provider: string, key: string): void {
    this.#assertProviderExists(provider);
    this.#secrets.setValue(providerSecretName(provider), key);
  }

  removeKey(provider: string): void {
    this.#assertProviderExists(provider);
    this.#secrets.removeValue(providerSecretName(provider));
  }

  /**
   * Minimal live request; throws PROVIDER_AUTH_FAILED / PROVIDER_UNREACHABLE.
   * capability 缺省 = 对话探测（历史行为）；其他能力路由到 media 网关
   * 的对应接口探测。
   *
   * 国内厂商的缺省测试按配置路由：厂商登记了对话模型 → 对话探测；未登记
   * 但能力配置（capabilityModels）引用了它 → 按该能力探测（校验 key）。
   * 这样「更换 Key」弹框的不带 capability 测试不会误报 Unknown provider。
   */
  async test(provider: string, modelId?: string, capability?: ModelCapability): Promise<void> {
    if (capability === undefined && isVendorId(provider)) {
      const settings = this.#settings.get();
      const entry = settings.vendorProviders.find((v) => v.id === provider);
      const entryModel =
        entry !== undefined && entry.models.length > 0
          ? (modelId !== undefined
            ? entry.models.find((m) => m.id === modelId)
            : undefined) ?? entry.models[0]
          : undefined;
      if (entryModel === undefined) {
        // 无对话模型：落到能力配置引用的第一种能力。
        const capabilityKey = (
          ['embedding', 'rerank', 'multimodal', 'asr', 'tts', 'image', 'video'] as const
        ).find((key) => settings.capabilityModels[key]?.vendor === provider);
        const config = capabilityKey !== undefined ? settings.capabilityModels[capabilityKey] : null;
        if (config === null) {
          throw new AppError(
            'NOT_FOUND',
            `厂商 ${VENDOR_DESCRIPTORS[provider].name} 尚未配置对话或能力模型`,
          );
        }
        capability = capabilityKey;
        modelId ??= config.model;
      } else {
        capability = 'chat';
        modelId ??= entryModel.id;
      }
    }
    if (capability !== undefined && capability !== 'chat') {
      if (this.#media === null) {
        throw new AppError('INTERNAL', 'media 网关未装配');
      }
      const model =
        modelId ??
        this.#settings.get().capabilityModels[capability as CapabilityModelKey]?.model ??
        null;
      if (model === null) {
        throw new AppError('NOT_FOUND', `未指定模型，且未配置「${capability}」能力模型`);
      }
      await this.#media.testCapability(capability, { vendor: provider, model });
      return;
    }
    const models = buildModelRegistry({
      settings: this.#settings.get(),
      secrets: this.#secrets,
      logger: this.#logger,
    });
    const info = models.getProvider(provider);
    if (!info) {
      if (isVendorId(provider)) {
        throw new AppError(
          'NOT_FOUND',
          `厂商 ${VENDOR_DESCRIPTORS[provider].name} 未登记「chat」能力的模型`,
        );
      }
      throw new AppError('NOT_FOUND', `Unknown provider "${provider}"`);
    }
    const modelPool = models.getModels(provider);
    const target = modelId ?? modelPool[0]?.id;
    if (!target) throw new AppError('NOT_FOUND', `Provider "${provider}" has no models`);
    const model = resolveModel(models, `${provider}/${target}`);
    await testProvider({ models, model });
  }

  #assertProviderExists(provider: string): void {
    // 内置 pi 厂商与国内厂商（dashscope 等）始终接受（key 可先于模型配置）。
    if (!provider.startsWith('custom:') && provider !== 'unknown') {
      return;
    }
    const settings = this.#settings.get();
    if (provider.startsWith('custom:')) {
      const id = provider.slice('custom:'.length);
      if (!settings.customProviders.some((c) => c.id === id)) {
        throw new AppError('NOT_FOUND', `Unknown provider "${provider}"`);
      }
    }
  }
}
