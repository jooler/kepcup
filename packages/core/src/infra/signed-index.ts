import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rmSync } from './fs-rm.js';
import path from 'node:path';
import { selectIndexKey, type IndexPublicKey } from '@kepcup/shared';
import type { Clock } from './clock.js';
import type { CoreLogger } from './logger.js';

/**
 * 签名索引同步的通用机制（D104 P1-1，设计 51 §6.1）：从 `apps/directory-sync.ts` 抽出的
 * 与具体目录无关的部分——Ed25519 验签、防回滚棘轮、原子缓存、定时拉取、状态机。
 * 两条通道各自配置 URL、文件名、schema 与体积上限后各用一份实例：
 *
 * - 连接器目录（`apps/directory-sync.ts`，D73 P3，行为一字不变）；
 * - 插件市场（`plugins/marketplace-sync.ts`，D104 P1-1）。
 *
 * 每日拉取 `{base}/{indexFile}` + `{sigFile}`（ETag / `If-None-Match`，走调用方注入的
 * SSRF 安全 fetch）→ Ed25519 验签 → 校验信封 → 防回滚 → 原子写缓存
 * `{dir}/{indexFile,sigFile,state.json}`。任何一步失败都不影响已采纳的索引：继续使用
 * 上一份已验签缓存，记警告，状态 `degraded`。公钥列表为空 = 同步关闭（`disabled`）。
 *
 * 防回滚：`state.json` 记录最后接受的索引的 `generatedAt`（毫秒）与字节 sha256；新索引
 * 的 `generatedAt` 必须**严格更大**——相等只有在字节完全相同（同一份索引再拉一次）时才算
 * 「未变」，其余相等 / 更旧一律拒绝。`generatedAt` 超前当前时间一天以上的索引同样拒绝
 * （否则一次误签会把棘轮永久卡死）。
 */

/** Ed25519 SPKI DER 前缀（后接 32 字节原始公钥）。 */
export const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SIGNATURE_BYTES = 64;
export const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 20_000;

export type IndexRejectReason =
  | 'too_large'
  | 'invalid_signature_format'
  | 'invalid_json'
  | 'schema_invalid'
  | 'unknown_key'
  | 'revoked_key'
  | 'key_not_valid_at'
  | 'bad_signature';

export type VerifiedIndexResult<T> =
  | { ok: true; index: T; keyId: string; sha256: string }
  | { ok: false; reason: IndexRejectReason; message: string };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function publicKeyObject(raw: string): KeyObject | null {
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
export function shortId(value: string): string {
  return value.length > 64 ? `${value.slice(0, 64)}…` : value;
}

/**
 * 非 `SignedIndexRejection` 失败的状态文案：undici 把连接层失败包成 `TypeError: fetch failed`，
 * 真实原因（连接超时 / DNS / 证书错误等）在 `cause` 链上。沿链取第一条与最外层不同且非空
 * 的消息（shallowest distinct），避免「fetch failed: fetch failed」这种自我重复又无信息的
 * 文案；cause 链上没有更具体的原因时原样返回最外层消息。
 */
export function fetchFailureMessage(error: unknown): string {
  const root = error instanceof Error ? error.message : String(error);
  let current = error instanceof Error ? error : undefined;
  for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
    const cause = current.cause instanceof Error ? current.cause : undefined;
    if (cause === undefined) break;
    if (cause.message.length > 0 && cause.message !== root) return cause.message;
    current = cause;
  }
  return root;
}

export function writeAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** 信封 schema 的最小形状（zod schema 兼容；不引 zod 类型，保持本文件依赖最小）。 */
export interface IndexSchemaLike<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } };
}

export interface SignedIndexLimits {
  maxBytes: number;
  maxSigBytes: number;
}

/**
 * 验签并解析索引（纯函数，不碰文件 / 网络）：体积上限 → 签名格式 → JSON → 信封 schema →
 * 按 `keyId` 选公钥（未知 / 吊销 / 不在有效期内拒绝）→ Ed25519 验签（对 `bytes` 原样）。
 * 防回滚由调用方（需要 `state.json`）做。
 */
export function verifySignedIndex<T extends { generatedAt: number; keyId: string }>(
  bytes: Uint8Array,
  signatureText: string,
  keys: readonly IndexPublicKey[],
  schema: IndexSchemaLike<T>,
  limits: SignedIndexLimits,
): VerifiedIndexResult<T> {
  const fail = (reason: IndexRejectReason, message: string): VerifiedIndexResult<T> => ({
    ok: false,
    reason,
    message,
  });
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxBytes) {
    return fail('too_large', `index size ${bytes.byteLength} is out of range`);
  }
  const sigText = signatureText.trim();
  if (
    sigText.length === 0 ||
    sigText.length > limits.maxSigBytes ||
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
  const parsed = schema.safeParse(json);
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

interface IndexState {
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

function isState(value: unknown): value is IndexState {
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

/** 拉取函数：与 `createSafeFetch()` 的返回值兼容（测试可注入）。 */
export type IndexFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export type SignedIndexSyncState = 'disabled' | 'ok' | 'degraded' | 'stale';

/** `syncState()` 的返回：通用状态视图（各通道在其上映射自己的状态 schema）。 */
export interface SignedIndexStatus {
  state: SignedIndexSyncState;
  /** 最近一次**成功**同步（200 验签通过 / 304 / 内容未变）的时间；从未成功 = null。 */
  lastSync: number | null;
  /** 正在使用的已验签索引的 `generatedAt`（毫秒）；缓存不可用 = null（棘轮仍在）。 */
  generatedAt: number | null;
  keyId: string | null;
  /** 最近一次失败的原因（脱敏文案）；成功后清空。 */
  error: string | null;
  /** 为何关闭（`disabled` 时）：no_keys = 公钥列表为空；setting_off = 设置开关关闭。 */
  disabledReason: 'no_keys' | 'setting_off' | null;
}

export interface SignedIndexIntervals {
  /** 成功后的下次拉取间隔。 */
  sync: number;
  /** 失败后的重试间隔。 */
  retry: number;
  /** 间隔的抖动比例（±）。 */
  jitterRatio: number;
  /** 启动后首次拉取的延迟范围。 */
  initialDelay: { min: number; max: number };
  /** 距上次成功拉取超过此时长 = `stale`。 */
  staleAfter: number;
}

export interface SignedIndexSyncDeps<T> {
  /** 缓存目录。 */
  dir: string;
  /** 编进应用的公钥列表；空 = 同步关闭。 */
  keys: readonly IndexPublicKey[];
  fetch: IndexFetch;
  clock: Clock;
  logger: Pick<CoreLogger, 'warn' | 'info'>;
  /** 索引服务根（只 https）。 */
  baseUrl: string;
  indexFile: string;
  sigFile: string;
  /** 信封 schema（`entries` 等具体内容不在这一层解释）。 */
  schema: IndexSchemaLike<T>;
  limits: SignedIndexLimits;
  /** 设置开关；缺省恒开。关闭时 `sync()` 不联网、`index()` 为 null、状态 `disabled/setting_off`。 */
  enabled?: () => boolean;
  /** 拉取间隔、失败后的重试间隔与首次延迟（测试覆盖）。 */
  intervalMs?: number;
  retryMs?: number;
  initialDelayMs?: number;
  random?: () => number;
  /** 各通道的同步节奏常量。 */
  intervals: SignedIndexIntervals;
}

export class SignedIndexSync<T extends { generatedAt: number; keyId: string }> {
  readonly #deps: SignedIndexSyncDeps<T>;
  readonly #base: string;
  #index: T | null = null;
  #revision = 0;
  #state: IndexState | null = null;
  #usingCache = false;
  /** 最近一次拉取失败的原因（成功后清空）。 */
  #error: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #inflight: Promise<SignedIndexStatus> | null = null;
  #stopped = false;

  constructor(deps: SignedIndexSyncDeps<T>) {
    this.#deps = deps;
    this.#base = deps.baseUrl.replace(/\/+$/, '');
    if (deps.keys.length > 0) this.#loadCache();
  }

  /** 当前已采纳的已验签索引；同步被关闭（设置开关 / 公钥列表为空）时返回 null。 */
  index(): T | null {
    return this.#enabledNow() ? this.#index : null;
  }

  /** 采纳次数计数：每采纳一份新索引（含缓存装载）加一。 */
  revision(): number {
    return this.#revision;
  }

  #enabledNow(): boolean {
    return this.#deps.keys.length > 0 && (this.#deps.enabled?.() ?? true);
  }

  syncState(): SignedIndexStatus {
    const cached = this.#state !== null && this.#usingCache ? this.#state : null;
    const base = {
      lastSync: this.#state?.lastSuccessAt ?? null,
      generatedAt: cached?.generatedAt ?? null,
      keyId: cached?.keyId ?? null,
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
    const stale = last === null || this.#deps.clock.now() - last > this.#deps.intervals.staleAfter;
    return { ...base, state: stale ? 'stale' : 'ok', disabledReason: null };
  }

  /** 立即同步一次（手动 / 定时共用）；并发调用合并。关闭时不联网，直接返回状态。 */
  sync(): Promise<SignedIndexStatus> {
    if (!this.#enabledNow()) return Promise.resolve(this.syncState());
    this.#inflight ??= this.#run().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  /** 启动定时器：首次延迟后拉取，之后按通道节奏（±抖动）。公钥列表为空 = 不启动。 */
  start(): void {
    if (this.#deps.keys.length === 0 || this.#timer !== null) return;
    this.#stopped = false;
    const random = this.#deps.random ?? Math.random;
    const initialDelay = this.#deps.intervals.initialDelay;
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
      void this.sync()
        .catch((error: unknown) => {
          this.#deps.logger.warn({ error: String(error) }, 'signed index sync crashed');
        })
        .finally(() => {
          if (this.#stopped) return;
          // 失败后按重试间隔重来，成功（或关闭）后回到常规间隔。
          const interval =
            this.#error !== null
              ? (this.#deps.retryMs ?? this.#deps.intervals.retry)
              : (this.#deps.intervalMs ?? this.#deps.intervals.sync);
          const jitter = (this.#deps.random ?? Math.random)() * 2 - 1; // [-1, 1)
          this.#schedule(interval * (1 + jitter * this.#deps.intervals.jitterRatio));
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
      const bytes = readFileSync(this.#file(this.#deps.indexFile));
      const sig = readFileSync(this.#file(this.#deps.sigFile), 'utf8');
      const verified = this.#verify(bytes, sig);
      if (!verified.ok) throw new Error(`cached index rejected: ${verified.reason}`);
      let accepted = state;
      if (state.generatedAt > this.#deps.clock.now() + FUTURE_SKEW_MS) {
        // 状态里的 generatedAt 远在未来（损坏 / 篡改）：它会把棘轮永久卡死。缓存索引自己验过签，
        // 棘轮重置为它的 generatedAt。
        this.#deps.logger.warn(
          {},
          'signed index state is future-dated; ratchet reset to the cache',
        );
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
          'signed index cache ignored',
        );
      }
      this.#state = this.#readStateOnly();
      this.#index = null;
      this.#usingCache = false;
    }
  }

  /** 缓存索引不可用时仍保留棘轮（`generatedAt`），防止借机回滚。 */
  #readStateOnly(): IndexState | null {
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

  #adopt(index: T): void {
    this.#index = index;
    this.#usingCache = true;
    this.#revision += 1;
  }

  #verify(bytes: Uint8Array, signatureText: string): VerifiedIndexResult<T> {
    return verifySignedIndex(bytes, signatureText, this.#deps.keys, this.#deps.schema, {
      maxBytes: this.#deps.limits.maxBytes,
      maxSigBytes: this.#deps.limits.maxSigBytes,
    });
  }

  /** 原子写缓存（先索引、再签名、最后状态）；磁盘失败只告警——内存里照常采用已验签的索引。 */
  #persist(bytes: Uint8Array, signatureText: string, state: IndexState): void {
    try {
      mkdirSync(this.#deps.dir, { recursive: true, mode: 0o700 });
      writeAtomic(this.#file(this.#deps.indexFile), bytes);
      writeAtomic(this.#file(this.#deps.sigFile), `${signatureText.trim()}\n`);
      writeAtomic(this.#file('state.json'), `${JSON.stringify(state)}\n`);
    } catch (error) {
      this.#deps.logger.warn({ error: String(error) }, 'signed index cache not saved');
    }
  }

  #saveState(state: IndexState): void {
    try {
      mkdirSync(this.#deps.dir, { recursive: true, mode: 0o700 });
      writeAtomic(this.#file('state.json'), `${JSON.stringify(state)}\n`);
    } catch (error) {
      this.#deps.logger.warn({ error: String(error) }, 'signed index state not saved');
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
      throw new SignedIndexRejection('too_large', 'response too large');
    return { status: response.status, bytes, etag: response.headers.get('etag') };
  }

  async #run(): Promise<SignedIndexStatus> {
    try {
      await this.#pull();
      this.#error = null;
    } catch (error) {
      const message =
        error instanceof SignedIndexRejection
          ? `${error.reason}: ${error.message}`
          : fetchFailureMessage(error);
      this.#error = message.slice(0, 300);
      // 回落：继续用上一份已验签缓存；对调用方可见的只是警告。
      this.#deps.logger.warn(
        { error: this.#error, usingCache: this.#usingCache },
        'signed index sync failed; using the last verified index',
      );
    }
    return this.syncState();
  }

  async #pull(): Promise<void> {
    const now = this.#deps.clock.now();
    const conditional = this.#usingCache && this.#state?.etag != null;
    const indexRes = await this.#fetchBytes(
      `${this.#base}/${this.#deps.indexFile}`,
      this.#deps.limits.maxBytes,
      conditional ? { 'if-none-match': this.#state!.etag as string } : {},
    );
    if (indexRes.status === 304) {
      if (!conditional || this.#state === null) {
        throw new SignedIndexRejection('http', 'unexpected 304 without a cached index');
      }
      this.#state = { ...this.#state, lastSuccessAt: now };
      this.#saveState(this.#state);
      return;
    }
    if (indexRes.status !== 200) {
      throw new SignedIndexRejection('http', `index responded HTTP ${indexRes.status}`);
    }
    const sigRes = await this.#fetchBytes(
      `${this.#base}/${this.#deps.sigFile}`,
      this.#deps.limits.maxSigBytes,
      {},
    );
    if (sigRes.status !== 200) {
      throw new SignedIndexRejection('http', `signature responded HTTP ${sigRes.status}`);
    }
    const signatureText = Buffer.from(sigRes.bytes).toString('utf8');
    const verified = this.#verify(indexRes.bytes, signatureText);
    if (!verified.ok) throw new SignedIndexRejection(verified.reason, verified.message);
    const { index } = verified;

    if (index.generatedAt > now + FUTURE_SKEW_MS) {
      throw new SignedIndexRejection('future_dated', 'index generatedAt is in the future');
    }
    const last = this.#state;
    if (last !== null) {
      if (index.generatedAt < last.generatedAt) {
        throw new SignedIndexRejection('rollback', 'index is older than the last accepted version');
      }
      if (index.generatedAt === last.generatedAt) {
        if (verified.sha256 !== last.sha256) {
          throw new SignedIndexRejection('rollback', 'index replays the last accepted version');
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
    const next: IndexState = {
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
      { keyId: next.keyId, generatedAt: next.generatedAt },
      'signed index accepted',
    );
  }
}

class SignedIndexRejection extends Error {
  constructor(
    readonly reason: IndexRejectReason | 'http' | 'rollback' | 'future_dated',
    message: string,
  ) {
    super(message);
  }
}
