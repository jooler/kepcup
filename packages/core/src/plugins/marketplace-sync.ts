import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  PLUGIN_INDEX_FILE,
  PLUGIN_INDEX_INITIAL_DELAY_MS,
  PLUGIN_INDEX_MAX_BYTES,
  PLUGIN_INDEX_RETRY_MS,
  PLUGIN_INDEX_SIG_FILE,
  PLUGIN_INDEX_SIG_MAX_BYTES,
  PLUGIN_INDEX_STALE_AFTER_MS,
  PLUGIN_INDEX_SYNC_INTERVAL_MS,
  PLUGIN_INDEX_SYNC_JITTER_RATIO,
  pluginIndexEntrySchema,
  pluginIndexSchema,
  type PluginIndexEntry,
  type PluginIndexRevoked,
  type PluginIndex,
  type PluginMarketStatus,
  type ConnectorIndexPublicKey,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import { SignedIndexSync } from '../infra/signed-index.js';
import { isSafeDirectoryRemoteUrl, compareConnectorVersions } from '../apps/directory-merge.js';
import { satisfiesRange } from '../apps/mcpb/manifest.js';
import type { DirectoryFetch } from '../apps/directory-sync.js';

/**
 * 插件市场索引的客户端（D104 P1-1，设计 51 §6.1）：一条独立的签名索引通道，内部持有
 * `SignedIndexSync<PluginIndex>`（与连接器目录共用验签 / 棘轮 / 缓存机制，节奏常量相同），
 * 上面加了条目层：逐条校验（坏条目单独跳过）、兼容判断、版本挑选、撤销名单、下载缓存。
 *
 * 与 `DirectorySync` 的两点不同（任务书明确要求并测试）：
 * - `enabled` 只控制**定时**拉取（`start()` 的定时循环每次 tick 前问一次）；`sync()` 手动
 *   调用不看它——「自动检查更新」关掉时打开市场页仍会同步。
 * - 采纳新索引后会广播 `plugins.marketplace.updated` 与 `plugins.changed`（渲染端刷新
 *   市场视图与已装列表的 `updateAvailable`）。
 *
 * 包下载缓存在 `{packagesDir}/{sha256}.kepcup`（内容寻址、跨端点共享），索引缓存在
 * `{dir}/{index.json,index.json.sig,state.json}`（每个端点独立，切换端点互不串扰）。
 */

/** 包下载缓存里文件名的后缀。 */
const PACKAGE_SUFFIX = '.kepcup';
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const CLEANUP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface MarketplaceSyncEvents {
  emit(name: 'plugins.marketplace.updated', payload: { generatedAt: number | null }): void;
  emit(name: 'plugins.changed', payload: { ids: string[] }): void;
}

export interface MarketplaceSyncDeps {
  /** 索引缓存目录：`{cacheDir}/plugins-market/{official | custom-<url sha256 前 12>}`。 */
  dir: string;
  /** 包下载缓存目录：`{cacheDir}/plugins`（内容寻址，端点间共享）。 */
  packagesDir: string;
  baseUrl: string;
  keys: readonly ConnectorIndexPublicKey[];
  /** `custom` 端点的条目 tier 一律封顶 `community`（设计 51 §6.1，Q5）。 */
  endpoint: 'official' | 'custom';
  /** 索引 / 签名文件的拉取（SSRF 安全）。 */
  fetch: DirectoryFetch;
  /** 包下载用（体积上限更大）；缺省复用 `fetch`。 */
  downloadFetch?: DirectoryFetch;
  /**
   * 仅测试构建（P1-3 的 `KEPCUP_TEST_PLUGIN_MARKET` e2e 缝）放行的回环包下载主机：
   * 命中列表的 `host:port` 视同安全（`isSafeDirectoryRemoteUrl` 只放行 https 公网）。
   */
  testLoopbackHosts?: readonly string[];
  clock: Clock;
  logger: CoreLogger;
  /** 只控制定时拉取（`start()` 的循环）；`sync()` / `entries()` / `download()` 不看它。 */
  enabled?: () => boolean;
  intervalMs?: number;
  retryMs?: number;
  initialDelayMs?: number;
  random?: () => number;
  events: MarketplaceSyncEvents;
  /** 每次采纳新索引（含切换后首拉）后回调（`start.ts` 接注册表的撤销名单）。 */
  onAdopted?: () => void;
}

/** 兼容性结论：null = 兼容；字符串 = 不兼容的原因。 */
type IncompatibleReason = string | null;

function incompatibleOf(
  entry: PluginIndexEntry,
  appVersion: string,
  platform: NodeJS.Platform,
): IncompatibleReason {
  if (entry.platforms !== undefined && !(entry.platforms as readonly string[]).includes(platform)) {
    return `平台不支持（仅 ${entry.platforms.join(' / ')}）`;
  }
  const range = entry.engines?.kepcup;
  if (range === undefined) return null;
  // 开发 / 测试（x.y.z 核心为 0.0.0）跳过引擎校验（README §4.3 的既有约定）。
  if (/^0\.0\.0(?:[-+]|$)/.test(appVersion)) return null;
  if (!satisfiesRange(appVersion, range)) {
    return `需要 KepCup ${range}`;
  }
  return null;
}

export class MarketplaceSync {
  readonly endpoint: 'official' | 'custom';
  readonly baseUrl: string;
  readonly #deps: MarketplaceSyncDeps;
  readonly #inner: SignedIndexSync<PluginIndex>;
  readonly #downloadFetch: DirectoryFetch;
  /** 解析后的条目缓存（按内部 revision 失效）；坏条目只跳过不报错。 */
  #parsedRevision = -1;
  #parsedEntries: PluginIndexEntry[] = [];
  #lastRevision: number;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  /** 并发下载同一 sha256 合并。 */
  readonly #downloads = new Map<string, Promise<string>>();

  constructor(deps: MarketplaceSyncDeps) {
    this.#deps = deps;
    this.endpoint = deps.endpoint;
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.#downloadFetch = deps.downloadFetch ?? deps.fetch;
    this.#inner = new SignedIndexSync({
      dir: deps.dir,
      keys: deps.keys,
      fetch: deps.fetch,
      clock: deps.clock,
      logger: deps.logger,
      baseUrl: this.baseUrl,
      indexFile: PLUGIN_INDEX_FILE,
      sigFile: PLUGIN_INDEX_SIG_FILE,
      schema: pluginIndexSchema,
      limits: { maxBytes: PLUGIN_INDEX_MAX_BYTES, maxSigBytes: PLUGIN_INDEX_SIG_MAX_BYTES },
      ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
      ...(deps.retryMs !== undefined ? { retryMs: deps.retryMs } : {}),
      ...(deps.initialDelayMs !== undefined ? { initialDelayMs: deps.initialDelayMs } : {}),
      ...(deps.random !== undefined ? { random: deps.random } : {}),
      // enabled 只控制本类的定时循环（见类注释），不传给内层 —— sync() 恒可联网。
      intervals: {
        sync: PLUGIN_INDEX_SYNC_INTERVAL_MS,
        retry: PLUGIN_INDEX_RETRY_MS,
        jitterRatio: PLUGIN_INDEX_SYNC_JITTER_RATIO,
        initialDelay: PLUGIN_INDEX_INITIAL_DELAY_MS,
        staleAfter: PLUGIN_INDEX_STALE_AFTER_MS,
      },
    });
    this.#lastRevision = this.#inner.revision();
  }

  /** 已验签索引里的全部条目（逐条 schema 校验，坏条目 warn 跳过；custom 封顶 community）。 */
  entries(): PluginIndexEntry[] {
    const revision = this.#inner.revision();
    if (revision !== this.#parsedRevision) {
      this.#parsedEntries = this.#parseEntries();
      this.#parsedRevision = revision;
    }
    return this.#parsedEntries;
  }

  #parseEntries(): PluginIndexEntry[] {
    const index = this.#inner.index();
    if (index === null) return [];
    const parsed: PluginIndexEntry[] = [];
    for (const [position, raw] of index.entries.entries()) {
      const result = this.#parseEntry(raw, position);
      if (result === null) continue;
      if (this.endpoint === 'custom' && result.tier !== 'community') {
        parsed.push({ ...result, tier: 'community' });
        continue;
      }
      parsed.push(result);
    }
    return parsed;
  }

  /**
   * 逐条校验。测试缝例外：`KEPCUP_TEST_PLUGIN_MARKET` 的包只走回环 http，而共享的
   * `pluginIndexEntrySchema` 要求 downloadUrl 是 https——仅当条目主机在测试回环白名单里
   * 时，用一个占位 https URL 过 schema，再换回原地址。真正的下载守卫
   * （`#downloadUrlAllowed`）仍会再检查一次；只有测试构建会注入 host 白名单，
   * 普通构建里这个分支恒不生效。
   */
  #parseEntry(raw: unknown, position: number): PluginIndexEntry | null {
    const result = pluginIndexEntrySchema.safeParse(raw);
    if (result.success) return result.data;
    const loopbackUrl = this.#testLoopbackDownloadUrl(raw);
    if (loopbackUrl === null) {
      this.#deps.logger.warn(
        { position, issue: result.error.issues[0]?.message ?? 'invalid' },
        'marketplace index entry skipped',
      );
      return null;
    }
    const relaxed = pluginIndexEntrySchema.safeParse({
      ...(raw as Record<string, unknown>),
      downloadUrl: 'https://test-seam.invalid/package.kepcup',
    });
    if (!relaxed.success) {
      this.#deps.logger.warn(
        { position, issue: relaxed.error.issues[0]?.message ?? 'invalid' },
        'marketplace index entry skipped',
      );
      return null;
    }
    return { ...relaxed.data, downloadUrl: loopbackUrl };
  }

  /** The raw entry's downloadUrl when it is an http URL on a test-seam loopback host. */
  #testLoopbackDownloadUrl(raw: unknown): string | null {
    const hosts = this.#deps.testLoopbackHosts;
    if (hosts === undefined || hosts.length === 0) return null;
    if (raw === null || typeof raw !== 'object') return null;
    const url = (raw as { downloadUrl?: unknown }).downloadUrl;
    if (typeof url !== 'string') return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:') return null;
      return hosts.includes(parsed.host) ? url : null;
    } catch {
      return null;
    }
  }

  /** 已验签索引的撤销名单（schema 已补 `action` / `reason` 默认值）。 */
  revoked(): PluginIndexRevoked[] {
    return this.#inner.index()?.revoked ?? [];
  }

  revision(): number {
    return this.#inner.revision();
  }

  /**
   * 同 id 的候选里取最高 semver 且兼容的一条；给了 `version` 就精确匹配（不兼容也返回，
   * 由调用方报错）。没有兼容候选 = null。
   */
  find(
    id: string,
    options: { version?: string; appVersion: string; platform: NodeJS.Platform },
  ): PluginIndexEntry | null {
    const candidates = this.entries().filter((entry) => entry.id === id);
    if (options.version !== undefined) {
      return candidates.find((entry) => entry.version === options.version) ?? null;
    }
    let best: PluginIndexEntry | null = null;
    for (const entry of candidates) {
      if (incompatibleOf(entry, options.appVersion, options.platform) !== null) continue;
      if (best === null || (compareConnectorVersions(entry.version, best.version) ?? -1) > 0) {
        best = entry;
      }
    }
    return best;
  }

  /** 版本挑选 / 列表展示共用的兼容判断。 */
  incompatibleReason(
    entry: PluginIndexEntry,
    appVersion: string,
    platform: NodeJS.Platform,
  ): string | null {
    return incompatibleOf(entry, appVersion, platform);
  }

  /** 命中撤销名单：`disable` 优先于 `warn`；`version` 缺省 = 该 id 全部版本。 */
  revocationOf(id: string, version: string): 'warn' | 'disable' | null {
    let hit: 'warn' | 'disable' | null = null;
    for (const item of this.revoked()) {
      if (item.id !== id) continue;
      if (item.version !== undefined && item.version !== version) continue;
      if (item.action === 'disable') return 'disable';
      hit = 'warn';
    }
    return hit;
  }

  status(): PluginMarketStatus {
    const state = this.#inner.syncState();
    return {
      state: state.state,
      disabledReason:
        state.state === 'disabled' && state.disabledReason === 'no_keys' ? 'no_keys' : null,
      lastSync: state.lastSync,
      generatedAt: state.generatedAt,
      error: state.error,
      endpoint: this.endpoint,
    };
  }

  /** 立即同步一次（手动 / 定时共用）；返回同步后的状态。 */
  async sync(): Promise<PluginMarketStatus> {
    await this.#inner.sync();
    this.#announceAdoption();
    return this.status();
  }

  /**
   * 启动定时循环（与 `SignedIndexSync` 的定时器分开：每次 tick 前先看 `enabled()`，
   * 关闭时跳过拉取但保持循环，开关翻转无需重启）。同时异步清理过期的包缓存。
   */
  start(): void {
    if (this.#timer !== null) return;
    this.#stopped = false;
    this.#cleanupPackages().catch(() => undefined);
    const initialDelay = PLUGIN_INDEX_INITIAL_DELAY_MS;
    const random = this.#deps.random ?? Math.random;
    const initial =
      this.#deps.initialDelayMs ??
      initialDelay.min + random() * (initialDelay.max - initialDelay.min);
    this.#schedule(initial);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick().finally(() => {
        if (this.#stopped) return;
        const status = this.status();
        const interval =
          status.error !== null
            ? (this.#deps.retryMs ?? PLUGIN_INDEX_RETRY_MS)
            : (this.#deps.intervalMs ?? PLUGIN_INDEX_SYNC_INTERVAL_MS);
        const jitter = (this.#deps.random ?? Math.random)() * 2 - 1;
        this.#schedule(interval * (1 + jitter * PLUGIN_INDEX_SYNC_JITTER_RATIO));
      });
    }, delayMs);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    if (this.#enabledNow()) {
      try {
        await this.sync();
      } catch (error) {
        this.#deps.logger.warn({ error: String(error) }, 'marketplace sync crashed');
      }
    }
  }

  #enabledNow(): boolean {
    return this.#deps.enabled?.() ?? true;
  }

  /** 采纳新索引（revision 前进）后广播一次；缓存装载（构造期）不算。 */
  #announceAdoption(): void {
    const revision = this.#inner.revision();
    if (revision === this.#lastRevision) return;
    this.#lastRevision = revision;
    const generatedAt = this.#inner.index()?.generatedAt ?? null;
    this.#deps.events.emit('plugins.marketplace.updated', { generatedAt });
    // ids 空 = 全量刷新（渲染端对 ids 不做过滤；让「已安装」页重算 updateAvailable）。
    this.#deps.events.emit('plugins.changed', { ids: [] });
    try {
      this.#deps.onAdopted?.();
    } catch (error) {
      this.#deps.logger.warn({ error: String(error) }, 'marketplace onAdopted handler failed');
    }
  }

  // --- 下载 -----------------------------------------------------------------------------

  /** 包下载地址守卫：https 公网，或（仅测试缝）测试市场的回环主机。 */
  #downloadUrlAllowed(url: string): boolean {
    if (isSafeDirectoryRemoteUrl(url)) return true;
    const hosts = this.#deps.testLoopbackHosts;
    if (hosts === undefined || hosts.length === 0) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' && hosts.includes(parsed.host);
    } catch {
      return false;
    }
  }

  /** 下载索引条目指向的包到内容寻址缓存，返回 `.kepcup` 的绝对路径。 */
  download(entry: PluginIndexEntry): Promise<string> {
    if (!this.#downloadUrlAllowed(entry.downloadUrl)) {
      return Promise.reject(
        new AppError('PLUGIN_INVALID', `包下载地址不安全：${entry.downloadUrl}`),
      );
    }
    const inflight = this.#downloads.get(entry.sha256);
    if (inflight !== undefined) return inflight;
    const promise = this.#downloadLocked(entry).finally(() => {
      this.#downloads.delete(entry.sha256);
    });
    this.#downloads.set(entry.sha256, promise);
    return promise;
  }

  async #downloadLocked(entry: PluginIndexEntry): Promise<string> {
    const finalPath = path.join(this.#deps.packagesDir, `${entry.sha256}${PACKAGE_SUFFIX}`);
    const cached = await this.#verifyCachedPackage(finalPath, entry.sha256);
    if (cached) return finalPath;
    await mkdir(this.#deps.packagesDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.#deps.packagesDir, `.tmp-${randomBytes(8).toString('hex')}`);
    try {
      await this.#downloadTo(tmp, entry);
      await rename(tmp, finalPath);
      return finalPath;
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  /** 缓存命中时重新校验 sha256（磁盘内容不可信）；不符 = 删掉重下。 */
  async #verifyCachedPackage(finalPath: string, sha256: string): Promise<boolean> {
    let bytes: Buffer;
    try {
      bytes = await readFile(finalPath);
    } catch {
      return false;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual === sha256) return true;
    this.#deps.logger.warn({ sha256 }, 'marketplace package cache mismatch; re-downloading');
    await rm(finalPath, { force: true });
    return false;
  }

  async #downloadTo(tmp: string, entry: PluginIndexEntry): Promise<void> {
    const response = await this.#downloadFetch(entry.downloadUrl, {
      headers: { accept: 'application/octet-stream, */*' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError('PLUGIN_INVALID', `包下载失败：HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > entry.size) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError('PLUGIN_INVALID', '包体积超过索引声明的大小');
    }
    if (response.body === null) {
      throw new AppError('PLUGIN_INVALID', '包下载失败：响应没有内容');
    }
    const hash = createHash('sha256');
    let size = 0;
    const out = await open(tmp, 'wx', 0o600);
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > entry.size) {
          await reader.cancel().catch(() => undefined);
          throw new AppError('PLUGIN_INVALID', '包体积超过索引声明的大小');
        }
        hash.update(value);
        await out.write(value);
      }
    } catch (error) {
      await out.close();
      throw error;
    }
    await out.close();
    if (size !== entry.size) {
      throw new AppError('PLUGIN_INVALID', `包体积与索引不符（${size} ≠ ${entry.size}）`);
    }
    const actual = hash.digest('hex');
    if (actual !== entry.sha256) {
      throw new AppError('PLUGIN_INVALID', '包内容与索引的 sha256 不符');
    }
  }

  /** 清理超过 7 天未使用的包缓存（失败只 warn）。 */
  async #cleanupPackages(): Promise<void> {
    try {
      const names = await readdir(this.#deps.packagesDir);
      const now = this.#deps.clock.now();
      for (const name of names) {
        // Content-addressed packages and `.tmp-*` residue from a crashed download (the
        // failure path removes its own temp file; only a dead process leaves one behind).
        // mtime-based, so an in-flight download's fresh temp file is never touched.
        if (!name.endsWith(PACKAGE_SUFFIX) && !name.startsWith('.tmp-')) continue;
        try {
          const info = await stat(path.join(this.#deps.packagesDir, name));
          if (now - info.mtimeMs <= CLEANUP_AFTER_MS) continue;
          await rm(path.join(this.#deps.packagesDir, name), { force: true });
        } catch {
          // 单个文件失败不清理其余。
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'marketplace package cleanup failed',
        );
      }
    }
  }
}
