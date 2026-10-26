import path from 'node:path';
import {
  PLUGIN_INDEX_BASE_URL,
  PLUGIN_INDEX_MAX_BYTES,
  PLUGIN_INDEX_PUBLIC_KEYS,
  PLUGIN_PACKAGE_MAX_BYTES,
  type ConnectorIndexPublicKey,
  type PluginMarketStatus,
} from '@kepcup/shared';
import { SettingsService } from '../domain/settings.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import { sha256Hex } from '../infra/signed-index.js';
import type { DirectoryFetch } from '../apps/directory-sync.js';
import { MarketplaceSync, type MarketplaceSyncEvents } from './marketplace-sync.js';

/**
 * 根据设置解析出当前生效的市场端点（D104 P1-1，设计 51 §6.1）：官方（`pluginMarketplaceUrl`
 * 为空，用内置公钥列表）或自建（URL + 用户登记的公钥，条目封顶 community）。设置里的
 * url / publicKey 变了就停旧建新（自带独立索引缓存与棘轮 =「清空市场视图重同步」），已装
 * 插件不受影响（行里记着自己的 endpointId）。
 *
 * 信任根跟着走：自建端点必须同时登记公钥，否则市场关闭（`no_custom_key`）；官方公钥列表为
 * 空 = 市场关闭（`no_keys`，生产默认，等待真实密钥）。`endpointId()` 是已装插件行里记的
 * 来源标识：官方 = `PLUGIN_INDEX_BASE_URL`，自建 = 规范化（去尾部斜杠）后的 URL。
 */

const INDEX_FETCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export interface MarketplaceServiceDeps {
  settings: Pick<SettingsService, 'get'>;
  /** `{paths.cacheDir}`：索引导 `{cacheDir}/plugins-market/…`，包下 `{cacheDir}/plugins`。 */
  cacheDir: string;
  clock: Clock;
  logger: CoreLogger;
  events: MarketplaceSyncEvents;
  /** 默认 `PLUGIN_INDEX_PUBLIC_KEYS` / `PLUGIN_INDEX_BASE_URL`（测试可注入）。 */
  official?: { keys: readonly ConnectorIndexPublicKey[]; baseUrl: string };
  fetchFactory: (options: { maxBytes: number; timeoutMs?: number }) => DirectoryFetch;
  timing?: { intervalMs?: number; retryMs?: number; initialDelayMs?: number };
}

interface ResolvedEndpoint {
  endpoint: 'official' | 'custom';
  baseUrl: string;
  keys: readonly ConnectorIndexPublicKey[];
  dir: string;
  disabledReason: 'no_keys' | 'no_custom_key' | null;
}

export class MarketplaceService {
  readonly #deps: MarketplaceServiceDeps;
  readonly #official: { keys: readonly ConnectorIndexPublicKey[]; baseUrl: string };
  #current: MarketplaceSync | null = null;
  #signature: string | null = null;
  #stopped = true;
  readonly #adoptedHandlers = new Set<() => void>();

  constructor(deps: MarketplaceServiceDeps) {
    this.#deps = deps;
    this.#official = deps.official ?? {
      keys: PLUGIN_INDEX_PUBLIC_KEYS,
      baseUrl: PLUGIN_INDEX_BASE_URL,
    };
  }

  /** 注册「采纳新索引」回调（`start.ts` 接注册表的撤销名单）；返回解绑函数。 */
  onAdopted(handler: () => void): () => void {
    this.#adoptedHandlers.add(handler);
    return () => {
      this.#adoptedHandlers.delete(handler);
    };
  }

  /** 当前生效的市场同步；公钥解析不出（官方列表空 / 自建未填公钥）= null。 */
  current(): MarketplaceSync | null {
    this.#resolve();
    return this.#current;
  }

  /** 市场状态；关闭时 `disabled` + 关闭原因。 */
  status(): PluginMarketStatus {
    this.#resolve();
    if (this.#current === null) {
      return {
        state: 'disabled',
        disabledReason: this.#reasonOf(),
        lastSync: null,
        generatedAt: null,
        error: null,
        endpoint: this.isOfficial() ? 'official' : 'custom',
      };
    }
    return this.#current.status();
  }

  /** 已装插件行里记的来源标识（官方即 base URL）。 */
  endpointId(): string {
    const url = this.#settingsUrl();
    return url === '' ? this.#official.baseUrl : url.replace(/\/+$/, '');
  }

  isOfficial(): boolean {
    return this.#settingsUrl() === '';
  }

  start(): void {
    this.#stopped = false;
    this.#resolve();
    this.#current?.start();
  }

  stop(): void {
    this.#stopped = true;
    this.#current?.stop();
  }

  #settingsUrl(): string {
    return this.#deps.settings.get().pluginMarketplaceUrl;
  }

  #reasonOf(): 'no_keys' | 'no_custom_key' | null {
    return this.#settingsUrl() === ''
      ? (this.#official.keys.length === 0 ? 'no_keys' : null)
      : (this.#deps.settings.get().pluginMarketplacePublicKey === '' ? 'no_custom_key' : null);
  }

  /** 每次读 current() / status() 前解析：设置里的 url / publicKey 变了就停旧建新。 */
  #resolve(): void {
    const settings = this.#deps.settings.get();
    const url = settings.pluginMarketplaceUrl;
    const publicKey = settings.pluginMarketplacePublicKey;
    const official = this.#official;
    let resolved: ResolvedEndpoint;
    if (url === '') {
      resolved = {
        endpoint: 'official',
        baseUrl: official.baseUrl,
        keys: official.keys,
        dir: path.join(this.#deps.cacheDir, 'plugins-market', 'official'),
        disabledReason: official.keys.length === 0 ? 'no_keys' : null,
      };
    } else if (publicKey === '') {
      // 自建端点必须自带信任根：没有公钥 = 市场关闭（设计 51 §6.1，Q5）。
      resolved = {
        endpoint: 'custom',
        baseUrl: url,
        keys: [],
        dir: path.join(this.#deps.cacheDir, 'plugins-market', this.#customDirName(url)),
        disabledReason: 'no_custom_key',
      };
    } else {
      resolved = {
        endpoint: 'custom',
        baseUrl: url,
        keys: [{ keyId: 'custom', publicKey, validFrom: 0, revoked: false }],
        dir: path.join(this.#deps.cacheDir, 'plugins-market', this.#customDirName(url)),
        disabledReason: null,
      };
    }
    const signature = `${resolved.endpoint}\u0000${resolved.baseUrl}\u0000${resolved.keys
      .map((key) => `${key.keyId}:${key.publicKey}:${key.revoked === true}`)
      .join('|')}`;
    if (signature === this.#signature) return;
    const previous = this.#current;
    this.#signature = signature;
    previous?.stop();
    // 设置切换 = 清空市场视图重同步（新实例自带独立缓存与棘轮；旧视图先清空）。
    if (previous !== null) {
      this.#deps.events.emit('plugins.marketplace.updated', { generatedAt: null });
    }
    if (resolved.disabledReason !== null) {
      this.#current = null;
      return;
    }
    const sync = new MarketplaceSync({
      dir: resolved.dir,
      packagesDir: path.join(this.#deps.cacheDir, 'plugins'),
      baseUrl: resolved.baseUrl,
      keys: resolved.keys,
      endpoint: resolved.endpoint,
      fetch: this.#deps.fetchFactory({ maxBytes: PLUGIN_INDEX_MAX_BYTES, timeoutMs: INDEX_FETCH_TIMEOUT_MS }),
      downloadFetch: this.#deps.fetchFactory({
        maxBytes: PLUGIN_PACKAGE_MAX_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      }),
      clock: this.#deps.clock,
      logger: this.#deps.logger,
      enabled: () => this.#deps.settings.get().pluginAutoCheckUpdates,
      events: this.#deps.events,
      onAdopted: () => {
        for (const handler of [...this.#adoptedHandlers]) handler();
      },
      ...(this.#deps.timing?.intervalMs !== undefined
        ? { intervalMs: this.#deps.timing.intervalMs }
        : {}),
      ...(this.#deps.timing?.retryMs !== undefined ? { retryMs: this.#deps.timing.retryMs } : {}),
      ...(this.#deps.timing?.initialDelayMs !== undefined
        ? { initialDelayMs: this.#deps.timing.initialDelayMs }
        : {}),
    });
    this.#current = sync;
    if (!this.#stopped) sync.start();
  }

  /** 自建端点的缓存目录名：`custom-{url 的 sha256 前 12}`。 */
  #customDirName(url: string): string {
    return `custom-${sha256Hex(Buffer.from(url)).slice(0, 12)}`;
  }
}
