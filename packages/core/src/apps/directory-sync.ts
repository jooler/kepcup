import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
  selectIndexKey,
  type AppsDirectoryStatus,
  type ConnectorIndex,
  type ConnectorIndexPublicKey,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';

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
 * 防回滚：`state.json` 记录最后接受的索引的 `generatedAt`（毫秒）与字节 sha256；新索引
 * 的 `generatedAt` 必须**严格更大**——相等只有在字节完全相同（同一份索引再拉一次）时才算
 * 「未变」，其余相等 / 更旧一律拒绝。`generatedAt` 超前当前时间一天以上的索引同样拒绝
 * （否则一次误签会把棘轮永久卡死）。
 */

/** Ed25519 SPKI DER 前缀（后接 32 字节原始公钥）。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SIGNATURE_BYTES = 64;
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export type IndexRejectReason =
  | 'too_large'
  | 'invalid_signature_format'
  | 'invalid_json'
  | 'schema_invalid'
  | 'unknown_key'
  | 'revoked_key'
  | 'key_not_valid_at'
  | 'bad_signature';

export type VerifiedIndexResult =
  | { ok: true; index: ConnectorIndex; keyId: string; sha256: string }
  | { ok: false; reason: IndexRejectReason; message: string };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function publicKeyObject(raw: string): KeyObject | null {
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/** 日志 / 状态里引用不可信的 keyId 前先裁剪。 */
function shortId(value: string): string {
  return value.length > 64 ? `${value.slice(0, 64)}…` : value;
}

/**
 * 验签并解析索引（纯函数，不碰文件 / 网络）：体积上限 → 签名格式 → JSON → 信封 schema →
 * 按 `keyId` 选公钥（未知 / 吊销 / 不在有效期内拒绝）→ Ed25519 验签（对 `bytes` 原样）。
 * 防回滚由调用方（需要 `state.json`）做。
 */
export function verifySignedIndex(
  bytes: Uint8Array,
  signatureText: string,
  keys: readonly ConnectorIndexPublicKey[],
): VerifiedIndexResult {
  const fail = (reason: IndexRejectReason, message: string): VerifiedIndexResult => ({
    ok: false,
    reason,
    message,
  });
  if (bytes.byteLength === 0 || bytes.byteLength > CONNECTOR_INDEX_MAX_BYTES) {
    return fail('too_large', `index size ${bytes.byteLength} is out of range`);
  }
  const sigText = signatureText.trim();
  if (
    sigText.length === 0 ||
    sigText.length > CONNECTOR_INDEX_SIG_MAX_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(sigText)
  ) {
    return fail('invalid_signature_format', 'signature is not base64');
  }
  const signature = Buffer.from(sigText, 'base64');
  if (signature.length !== SIGNATURE_BYTES) {
    return fail('invalid_signature_format', `signature must be ${SIGNATURE_BYTES} bytes`);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return fail('invalid_json', 'index is not valid JSON');
  }
  const parsed = connectorIndexSchema.safeParse(json);
  if (!parsed.success) {
    return fail(
      'schema_invalid',
      `index failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  const index = parsed.data;
  const selection = selectIndexKey(keys, index.keyId, index.generatedAt);
  if (!selection.ok) {
    return fail(selection.reason, `${selection.reason} (${shortId(index.keyId)})`);
  }
  const key = publicKeyObject(selection.key.publicKey);
  if (key === null) return fail('unknown_key', `key ${shortId(index.keyId)} is malformed`);
  let valid: boolean;
  try {
    valid = cryptoVerify(null, bytes, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return fail('bad_signature', 'signature does not match the index');
  return { ok: true, index, keyId: index.keyId, sha256: sha256Hex(bytes) };
}

// --- 缓存文件 ---------------------------------------------------------------------------

interface DirectoryState {
  version: 1;
  /** 最后接受的索引的 `generatedAt`（毫秒）：防回滚的棘轮。 */
  generatedAt: number;
  keyId: string;
  /** 该索引字节的 sha256。 */
  sha256: string;
  etag: string | null;
  /** 最近一次成功检查（200 验签通过 / 304 / 内容未变）的时间。 */
  lastSuccessAt: number;
}

function isState(value: unknown): value is DirectoryState {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['version'] === 1 &&
    typeof v['generatedAt'] === 'number' &&
    Number.isFinite(v['generatedAt']) &&
    typeof v['keyId'] === 'string' &&
    typeof v['sha256'] === 'string' &&
    (v['etag'] === null || typeof v['etag'] === 'string') &&
    typeof v['lastSuccessAt'] === 'number'
  );
}

function writeAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** 拉取函数：与 `createSafeFetch()` 的返回值兼容（测试可注入）。 */
export type DirectoryFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

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
  readonly #deps: DirectorySyncDeps;
  readonly #base: string;
  #entries: readonly unknown[] = [];
  #revision = 0;
  #state: DirectoryState | null = null;
  #usingCache = false;
  #lastEnabled: boolean;
  /** 最近一次拉取失败的原因（成功后清空）。 */
  #error: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #inflight: Promise<AppsDirectoryStatus> | null = null;
  #stopped = false;

  constructor(deps: DirectorySyncDeps) {
    this.#deps = deps;
    this.#base = (deps.baseUrl ?? CONNECTOR_DIRECTORY_BASE_URL).replace(/\/+$/, '');
    this.#lastEnabled = this.#enabledNow();
    if (deps.keys.length > 0) this.#loadCache();
  }

  /**
   * 已验签索引的原始条目（未逐条校验；`ConnectorCatalog` 合并时校验）。同步被关闭（设置开关 /
   * 公钥列表为空）时返回空：关闭同步 = 只用打包快照，缓存里的远端条目也不再生效。
   */
  entries(): readonly unknown[] {
    return this.#enabledNow() ? this.#entries : [];
  }

  /**
   * 条目变化计数（`ConnectorCatalog` 据此重新合并）。开关状态的翻转也算一次变化——调用方每次
   * 读目录都会问一次，所以运行时切换设置立即生效。
   */
  revision(): number {
    const enabled = this.#enabledNow();
    if (enabled !== this.#lastEnabled) {
      this.#lastEnabled = enabled;
      this.#revision += 1;
    }
    return this.#revision;
  }

  #enabledNow(): boolean {
    return this.#deps.keys.length > 0 && (this.#deps.enabled?.() ?? true);
  }

  status(): AppsDirectoryStatus {
    const state = this.#state !== null && this.#usingCache ? this.#state : null;
    const base = {
      lastSync: this.#state?.lastSuccessAt ?? null,
      version: state?.generatedAt ?? null,
      keyId: state?.keyId ?? null,
      remoteEntries: this.entries().filter(
        (entry) => connectorCatalogEntrySchema.safeParse(entry).success,
      ).length,
      error: this.#error,
    };
    if (this.#deps.keys.length === 0) {
      return { ...base, state: 'disabled', disabledReason: 'no_keys', error: null };
    }
    if (!(this.#deps.enabled?.() ?? true)) {
      return { ...base, state: 'disabled', disabledReason: 'setting_off', error: null };
    }
    if (this.#error !== null) return { ...base, state: 'degraded', disabledReason: null };
    const last = this.#state?.lastSuccessAt ?? null;
    const stale = last === null || this.#deps.clock.now() - last > CONNECTOR_INDEX_STALE_AFTER_MS;
    return { ...base, state: stale ? 'stale' : 'ok', disabledReason: null };
  }

  /** 立即同步一次（手动 / 定时共用）；并发调用合并。关闭时不联网，直接返回状态。 */
  sync(): Promise<AppsDirectoryStatus> {
    if (!this.#enabledNow()) return Promise.resolve(this.status());
    this.#inflight ??= this.#run().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  /** 启动定时器：首次延迟后拉取，之后每日（±抖动）。公钥列表为空 = 不启动。 */
  start(): void {
    if (this.#deps.keys.length === 0 || this.#timer !== null) return;
    this.#stopped = false;
    const random = this.#deps.random ?? Math.random;
    const initial =
      this.#deps.initialDelayMs ??
      CONNECTOR_INDEX_INITIAL_DELAY_MS.min +
        random() * (CONNECTOR_INDEX_INITIAL_DELAY_MS.max - CONNECTOR_INDEX_INITIAL_DELAY_MS.min);
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
      void this.sync()
        .catch((error: unknown) => {
          this.#deps.logger.warn({ error: String(error) }, 'directory sync crashed');
        })
        .finally(() => {
          if (this.#stopped) return;
          // 失败后约 1 小时重试，成功（或关闭）后回到每日。
          const interval =
            this.#error !== null
              ? (this.#deps.retryMs ?? CONNECTOR_INDEX_RETRY_MS)
              : (this.#deps.intervalMs ?? CONNECTOR_INDEX_SYNC_INTERVAL_MS);
          const jitter = (this.#deps.random ?? Math.random)() * 2 - 1; // [-1, 1)
          this.#schedule(interval * (1 + jitter * CONNECTOR_INDEX_SYNC_JITTER_RATIO));
        });
    }, delayMs);
    this.#timer.unref?.();
  }

  // --- 缓存 -----------------------------------------------------------------------------

  #file(name: string): string {
    return path.join(this.#deps.dir, name);
  }

  /** 启动时装载缓存：重新验签（磁盘内容不可信）并核对棘轮；任何不一致 = 忽略缓存。 */
  #loadCache(): void {
    try {
      const state: unknown = JSON.parse(readFileSync(this.#file('state.json'), 'utf8'));
      if (!isState(state)) throw new Error('state.json malformed');
      const bytes = readFileSync(this.#file(CONNECTOR_INDEX_FILE));
      const sig = readFileSync(this.#file(CONNECTOR_INDEX_SIG_FILE), 'utf8');
      const verified = verifySignedIndex(bytes, sig, this.#deps.keys);
      if (!verified.ok) throw new Error(`cached index rejected: ${verified.reason}`);
      let accepted = state;
      if (state.generatedAt > this.#deps.clock.now() + FUTURE_SKEW_MS) {
        // 状态里的 generatedAt 远在未来（损坏 / 篡改）：它会把棘轮永久卡死。缓存索引自己验过签，
        // 棘轮重置为它的 generatedAt。
        this.#deps.logger.warn({}, 'directory state is future-dated; ratchet reset to the cache');
        accepted = { ...state, generatedAt: verified.index.generatedAt, sha256: verified.sha256 };
      }
      if (
        verified.sha256 !== accepted.sha256 ||
        verified.index.generatedAt !== accepted.generatedAt
      ) {
        throw new Error('cached index does not match state.json');
      }
      this.#state = accepted;
      this.#adopt(verified.index);
    } catch (error) {
      // 没有缓存是常态（首次运行）；损坏 / 被改动才告警。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'directory cache ignored',
        );
      }
      this.#state = this.#readStateOnly();
      this.#entries = [];
      this.#usingCache = false;
    }
  }

  /** 缓存索引不可用时仍保留棘轮（`generatedAt`），防止借机回滚。 */
  #readStateOnly(): DirectoryState | null {
    try {
      const state: unknown = JSON.parse(readFileSync(this.#file('state.json'), 'utf8'));
      // 远在未来的状态视为损坏（否则一个坏文件让同步永远被「回滚」拒绝）。
      return isState(state) && state.generatedAt <= this.#deps.clock.now() + FUTURE_SKEW_MS
        ? state
        : null;
    } catch {
      return null;
    }
  }

  #adopt(index: ConnectorIndex): void {
    this.#entries = index.entries;
    this.#usingCache = true;
    this.#revision += 1;
  }

  /** 原子写缓存（先索引、再签名、最后状态）；磁盘失败只告警——内存里照常采用已验签的索引。 */
  #persist(bytes: Uint8Array, signatureText: string, state: DirectoryState): void {
    try {
      mkdirSync(this.#deps.dir, { recursive: true, mode: 0o700 });
      writeAtomic(this.#file(CONNECTOR_INDEX_FILE), bytes);
      writeAtomic(this.#file(CONNECTOR_INDEX_SIG_FILE), `${signatureText.trim()}\n`);
      writeAtomic(this.#file('state.json'), `${JSON.stringify(state)}\n`);
    } catch (error) {
      this.#deps.logger.warn({ error: String(error) }, 'directory cache not saved');
    }
  }

  #saveState(state: DirectoryState): void {
    try {
      mkdirSync(this.#deps.dir, { recursive: true, mode: 0o700 });
      writeAtomic(this.#file('state.json'), `${JSON.stringify(state)}\n`);
    } catch (error) {
      this.#deps.logger.warn({ error: String(error) }, 'directory state not saved');
    }
  }

  // --- 拉取 -----------------------------------------------------------------------------

  async #fetchBytes(
    url: string,
    maxBytes: number,
    headers: Record<string, string>,
  ): Promise<{ status: number; bytes: Uint8Array; etag: string | null }> {
    const response = await this.#deps.fetch(url, {
      headers: { accept: '*/*', ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new DirectoryRejection('too_large', 'response too large');
    return { status: response.status, bytes, etag: response.headers.get('etag') };
  }

  async #run(): Promise<AppsDirectoryStatus> {
    try {
      await this.#pull();
      this.#error = null;
    } catch (error) {
      const message =
        error instanceof DirectoryRejection
          ? `${error.reason}: ${error.message}`
          : `fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      this.#error = message.slice(0, 300);
      // 回落：继续用上一份已验签缓存（没有则打包快照）；对目录方可见的只是警告。
      this.#deps.logger.warn(
        { error: this.#error, usingCache: this.#usingCache },
        'directory sync failed; using the last verified index or the bundled snapshot',
      );
    }
    return this.status();
  }

  async #pull(): Promise<void> {
    const now = this.#deps.clock.now();
    const conditional = this.#usingCache && this.#state?.etag != null;
    const indexRes = await this.#fetchBytes(
      `${this.#base}/${CONNECTOR_INDEX_FILE}`,
      CONNECTOR_INDEX_MAX_BYTES,
      conditional ? { 'if-none-match': this.#state!.etag as string } : {},
    );
    if (indexRes.status === 304) {
      if (!conditional || this.#state === null) {
        throw new DirectoryRejection('http', 'unexpected 304 without a cached index');
      }
      this.#state = { ...this.#state, lastSuccessAt: now };
      this.#saveState(this.#state);
      return;
    }
    if (indexRes.status !== 200) {
      throw new DirectoryRejection('http', `index responded HTTP ${indexRes.status}`);
    }
    const sigRes = await this.#fetchBytes(
      `${this.#base}/${CONNECTOR_INDEX_SIG_FILE}`,
      CONNECTOR_INDEX_SIG_MAX_BYTES,
      {},
    );
    if (sigRes.status !== 200) {
      throw new DirectoryRejection('http', `signature responded HTTP ${sigRes.status}`);
    }
    const signatureText = Buffer.from(sigRes.bytes).toString('utf8');
    const verified = verifySignedIndex(indexRes.bytes, signatureText, this.#deps.keys);
    if (!verified.ok) throw new DirectoryRejection(verified.reason, verified.message);
    const { index } = verified;

    if (index.generatedAt > now + FUTURE_SKEW_MS) {
      throw new DirectoryRejection('future_dated', 'index generatedAt is in the future');
    }
    const last = this.#state;
    if (last !== null) {
      if (index.generatedAt < last.generatedAt) {
        throw new DirectoryRejection('rollback', 'index is older than the last accepted version');
      }
      if (index.generatedAt === last.generatedAt) {
        if (verified.sha256 !== last.sha256) {
          throw new DirectoryRejection('rollback', 'index replays the last accepted version');
        }
        // 同一份索引再拉一次（服务端没发 ETag / 缓存被清）：未变，按成功处理。
        if (!this.#usingCache) {
          this.#persist(indexRes.bytes, signatureText, {
            ...last,
            etag: indexRes.etag,
            lastSuccessAt: now,
          });
          this.#state = { ...last, etag: indexRes.etag, lastSuccessAt: now };
          this.#adopt(index);
        } else {
          this.#state = { ...last, etag: indexRes.etag ?? last.etag, lastSuccessAt: now };
          this.#saveState(this.#state);
        }
        return;
      }
    }
    const next: DirectoryState = {
      version: 1,
      generatedAt: index.generatedAt,
      keyId: verified.keyId,
      sha256: verified.sha256,
      etag: indexRes.etag,
      lastSuccessAt: now,
    };
    this.#persist(indexRes.bytes, signatureText, next);
    this.#state = next;
    this.#adopt(index);
    this.#deps.logger.info(
      { keyId: next.keyId, generatedAt: next.generatedAt, entries: index.entries.length },
      'directory index accepted',
    );
  }
}

class DirectoryRejection extends Error {
  constructor(
    readonly reason: IndexRejectReason | 'http' | 'rollback' | 'future_dated',
    message: string,
  ) {
    super(message);
  }
}
