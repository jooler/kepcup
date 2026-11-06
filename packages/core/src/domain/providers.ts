import {
  AppError,
  isVendorId,
  VENDOR_DESCRIPTORS,
  type CapabilityModelKey,
  type ModelCapability,
  type ProviderInfo,
} from '@kepcup/shared';
import {
  addProviderKey,
  buildModelRegistry,
  findProviderInstance,
  providerInfoList,
  removeProviderKeyAt,
  replaceProviderKeys,
  resolveModel,
  testProvider,
} from '../agent/models.js';
import { providerTestSessionId } from '../agent/model-session-id.js';
import type { MediaService } from '../media/service.js';
import type { SettingsService } from './settings.js';
import type { SecretsService } from './secrets.js';
import type { CoreLogger } from '../infra/logger.js';

/** 无对话模型的实例做连通性测试时，按能力配置的引用顺序探测第一种能力。 */
const CAPABILITY_PROBE_ORDER = [
  'embedding',
  'rerank',
  'multimodal',
  'asr',
  'tts',
  'image',
  'video',
] as const;

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
    replaceProviderKeys(this.#secrets, provider, [key]);
  }

  /** 追加一个 Key（同一供应商多 Key 轮询）；setKey 仍是整体替换。 */
  addKey(provider: string, key: string): void {
    this.#assertProviderExists(provider);
    addProviderKey(this.#secrets, provider, key);
  }

  removeKeyAt(provider: string, index: number): void {
    this.#assertProviderExists(provider);
    removeProviderKeyAt(this.#secrets, provider, index);
  }

  removeKey(provider: string): void {
    this.#assertProviderExists(provider);
    replaceProviderKeys(this.#secrets, provider, []);
  }

  /**
   * Minimal live request; throws PROVIDER_AUTH_FAILED / PROVIDER_UNREACHABLE.
   * capability 缺省 = 对话探测（历史行为）；其他能力路由到 media 网关
   * 的对应接口探测。
   *
   * 供应商实例的缺省测试按配置路由：实例登记了对话模型 → 对话探测；未登记
   * 但能力配置（capabilityModels）引用了它 → 按该能力探测（校验 key）。这样
   * 「更换 Key」弹框的不带 capability 测试不会误报 Unknown provider。
   */
  async test(
    provider: string,
    modelId?: string,
    capability?: ModelCapability,
    keyOverride?: string,
  ): Promise<void> {
    const settings = this.#settings.get();
    const instance = findProviderInstance(settings, provider);
    const chatModels = instance?.models.filter((m) => m.capabilities.includes('chat'));

    if (capability === undefined && chatModels !== undefined && chatModels.length === 0) {
      // 无对话模型：落到能力配置引用的第一种能力。
      const capabilityKey = CAPABILITY_PROBE_ORDER.find(
        (key) => settings.capabilityModels[key]?.provider === provider,
      );
      const config = capabilityKey !== undefined ? settings.capabilityModels[capabilityKey] : null;
      if (config === null) {
        throw new AppError('NOT_FOUND', `供应商 ${instance?.name ?? provider} 尚未配置对话或能力模型`);
      }
      capability = capabilityKey;
      modelId ??= config.model;
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
      await this.#media.testCapability(capability, { provider, model }, { keyOverride });
      return;
    }
    const models = buildModelRegistry({
      settings: this.#settings.get(),
      secrets: this.#secrets,
      logger: this.#logger,
    });
    const info = models.getProvider(provider);
    if (!info) {
      if (instance !== undefined) {
        throw new AppError('NOT_FOUND', `供应商 ${instance.name} 未登记「chat」能力的模型`);
      }
      if (isVendorId(provider)) {
        throw new AppError(
          'NOT_FOUND',
          `厂商 ${VENDOR_DESCRIPTORS[provider].name} 尚未添加（设置-模型里添加后登记对话模型）`,
        );
      }
      throw new AppError('NOT_FOUND', `Unknown provider "${provider}"`);
    }
    const modelPool = models.getModels(provider);
    const target = modelId ?? modelPool[0]?.id;
    if (!target) throw new AppError('NOT_FOUND', `Provider "${provider}" has no models`);
    const model = resolveModel(models, `${provider}/${target}`);
    await testProvider({
      models,
      model,
      sessionId: providerTestSessionId(() => this.#secrets.modelSessionKey(), provider),
    });
  }

  #assertProviderExists(provider: string): void {
    // 内置 pi 厂商与未建实例的国内厂商始终接受（key 可先于实例存在）；
    // 自定义实例必须已存在。'unknown' 是历史占位，保持接受。
    if (!provider.startsWith('custom:') || provider === 'unknown') {
      return;
    }
    if (findProviderInstance(this.#settings.get(), provider)) return;
    throw new AppError('NOT_FOUND', `Unknown provider "${provider}"`);
  }
}
