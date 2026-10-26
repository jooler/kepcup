import {
  CONNECTOR_DIRECTORY_BASE_URL,
  CONNECTOR_INDEX_FILE,
  CONNECTOR_INDEX_INITIAL_DELAY_MS,
  CONNECTOR_INDEX_MAX_BYTES,
  CONNECTOR_INDEX_SIG_FILE,
  CONNECTOR_INDEX_SIG_MAX_BYTES,
  CONNECTOR_INDEX_STALE_AFTER_MS,
  CONNECTOR_INDEX_SYNC_INTERVAL_MS,
  CONNECTOR_INDEX_SYNC_JITTER_RATIO,
  CONNECTOR_INDEX_RETRY_MS,
  connectorCatalogEntrySchema,
  connectorIndexSchema,
  type AppsDirectoryStatus,
  type ConnectorIndex,
  type ConnectorIndexPublicKey,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import {
  SignedIndexSync,
  verifySignedIndex as verifyGenericSignedIndex,
  sha256Hex,
  type IndexFetch,
  type IndexRejectReason,
  type SignedIndexStatus,
  type VerifiedIndexResult,
} from '../infra/signed-index.js';

/** 拉取函数（与 `createSafeFetch()` 的返回值兼容；通用版在 `infra/signed-index.ts`）。 */
export type DirectoryFetch = IndexFetch;
export type { IndexRejectReason, VerifiedIndexResult };

/**
 * 签名目录索引的客户端（D73 P3 §7.1，设计 29 §11.4 / §15.2）。
 *
 * 每日拉取 `{base}/index.json` + `index.json.sig`（ETag / `If-None-Match`，走 SSRF 安全的
 * fetch：只 https、响应体设上限）→ Ed25519 验签 → 校验信封 → 防回滚 → 原子写缓存
 * `{cacheDir}/directory/{index.json,index.json.sig,state.json}` → 条目交给 `ConnectorCatalog`
 * 与打包快照合并（规则见 `directory-merge.ts`）。
 *
 * 任何一步失败都**不影响已有目录**：继续使用上一份已验签的缓存（没有则只用打包快照），
 * 记警告，状态 `degraded`。公钥列表为空（生产默认，等待用户生成密钥，U5）= 同步关闭
 * （`disabled`），只用快照，不联网。
 *
 * 验签 / 棘轮 / 缓存 / 定时 / 状态机的通用实现在 `infra/signed-index.ts`（D104 P1-1 抽出，
 * 与插件市场共用）；这里只保留目录通道的配置（URL、文件名、schema、体积上限、节奏常量）
 * 与条目层的映射（`entries()`、`remoteEntries` 计数、设置开关翻转算一次变化）。
 */

export { sha256Hex };

/** 验签并解析连接器目录索引（原三参签名；泛化版见 `infra/signed-index.ts`）。 */
export function verifySignedIndex(
  bytes: Uint8Array,
  signatureText: string,
  keys: readonly ConnectorIndexPublicKey[],
): VerifiedIndexResult<ConnectorIndex> {
  return verifyGenericSignedIndex(bytes, signatureText, keys, connectorIndexSchema, {
    maxBytes: CONNECTOR_INDEX_MAX_BYTES,
    maxSigBytes: CONNECTOR_INDEX_SIG_MAX_BYTES,
  });
}

export interface DirectorySyncDeps {
  /** 缓存目录（`{paths.cacheDir}/directory`）。 */
  dir: string;
  /** 编进应用的公钥列表；空 = 同步关闭。 */
  keys: readonly ConnectorIndexPublicKey[];
  fetch: DirectoryFetch;
  clock: Clock;
  logger: Pick<CoreLogger, 'warn' | 'info'>;
  /** 设置开关（`settings.apps.directorySync`）；缺省恒开。 */
  enabled?: () => boolean;
  /** 目录服务根；缺省 {@link CONNECTOR_DIRECTORY_BASE_URL}（只有测试钩子会覆盖）。 */
  baseUrl?: string;
  /** 拉取间隔、失败后的重试间隔与首次延迟（测试覆盖）。 */
  intervalMs?: number;
  retryMs?: number;
  initialDelayMs?: number;
  random?: () => number;
}

export class DirectorySync {
  readonly #inner: SignedIndexSync<ConnectorIndex>;
  readonly #deps: DirectorySyncDeps;
  #lastEnabled: boolean;

  constructor(deps: DirectorySyncDeps) {
    this.#deps = deps;
    this.#inner = new SignedIndexSync<ConnectorIndex>({
      dir: deps.dir,
      keys: deps.keys,
      fetch: deps.fetch,
      clock: deps.clock,
      logger: deps.logger,
      baseUrl: (deps.baseUrl ?? CONNECTOR_DIRECTORY_BASE_URL).replace(/\/+$/, ''),
      indexFile: CONNECTOR_INDEX_FILE,
      sigFile: CONNECTOR_INDEX_SIG_FILE,
      schema: connectorIndexSchema,
      limits: { maxBytes: CONNECTOR_INDEX_MAX_BYTES, maxSigBytes: CONNECTOR_INDEX_SIG_MAX_BYTES },
      ...(deps.enabled !== undefined ? { enabled: deps.enabled } : {}),
      ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
      ...(deps.retryMs !== undefined ? { retryMs: deps.retryMs } : {}),
      ...(deps.initialDelayMs !== undefined ? { initialDelayMs: deps.initialDelayMs } : {}),
      ...(deps.random !== undefined ? { random: deps.random } : {}),
      intervals: {
        sync: CONNECTOR_INDEX_SYNC_INTERVAL_MS,
        retry: CONNECTOR_INDEX_RETRY_MS,
        jitterRatio: CONNECTOR_INDEX_SYNC_JITTER_RATIO,
        initialDelay: CONNECTOR_INDEX_INITIAL_DELAY_MS,
        staleAfter: CONNECTOR_INDEX_STALE_AFTER_MS,
      },
    });
    this.#lastEnabled = this.#enabledNow();
  }

  /**
   * 已验签索引的原始条目（未逐条校验；`ConnectorCatalog` 合并时校验）。同步被关闭（设置开关 /
   * 公钥列表为空）时返回空：关闭同步 = 只用打包快照，缓存里的远端条目也不再生效。
   */
  entries(): readonly unknown[] {
    return this.#inner.index()?.entries ?? [];
  }

  /**
   * 条目变化计数（`ConnectorCatalog` 据此重新合并）。开关状态的翻转也算一次变化——调用方每次
   * 读目录都会问一次，所以运行时切换设置立即生效。
   */
  revision(): number {
    const enabled = this.#enabledNow();
    let revision = this.#inner.revision();
    if (enabled !== this.#lastEnabled) {
      this.#lastEnabled = enabled;
      revision += 1;
    }
    return revision;
  }

  #enabledNow(): boolean {
    return this.#deps.keys.length > 0 && (this.#deps.enabled?.() ?? true);
  }

  status(): AppsDirectoryStatus {
    const state: SignedIndexStatus = this.#inner.syncState();
    return {
      state: state.state,
      lastSync: state.lastSync,
      version: state.generatedAt,
      keyId: state.keyId,
      remoteEntries: this.entries().filter(
        (entry) => connectorCatalogEntrySchema.safeParse(entry).success,
      ).length,
      error: state.error,
      disabledReason: state.disabledReason,
    };
  }

  /** 立即同步一次（手动 / 定时共用）；并发调用合并。关闭时不联网，直接返回状态。 */
  sync(): Promise<AppsDirectoryStatus> {
    if (!this.#enabledNow()) return Promise.resolve(this.status());
    return this.#inner.sync().then(() => this.status());
  }

  /** 启动定时器：首次延迟后拉取，之后每日（±抖动）。公钥列表为空 = 不启动。 */
  start(): void {
    this.#inner.start();
  }

  stop(): void {
    this.#inner.stop();
  }
}
