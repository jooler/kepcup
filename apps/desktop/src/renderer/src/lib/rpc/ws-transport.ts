import {
  RELAY_FRAGMENT_THRESHOLD_BYTES,
  RELAY_HEARTBEAT_MS,
  RELAY_MAX_LOGICAL_BYTES,
  RELAY_PROTOCOL_VERSION,
  RELAY_REPLAY_WINDOW,
  envelopeAadString,
  pairingAcceptTranscript,
  pairingRequestTranscript,
  relayEnvelopeSchema,
  relayEventPayloadSchema,
  relayKickPayloadSchema,
  relayPairingPayloadSchema,
  type PairingKeyMode,
  type RelayEnvelope,
  type RelayFragment,
  type RelayFrameType,
} from '@kepcup/shared';
import type { RpcTransport } from '@kepcup/shared';

/**
 * 远程遥控手机端（D96 WP5，design 46 §4.4/§4.5/§5.5）：手机 PWA 到桌面 core 的
 * RpcTransport。同一份帧协议的 WebCrypto 实现（对齐 packages/core/src/remote/
 * codec.ts 的 Node 实现；AAD / HKDF / transcript 共用 shared 的规范化函数与设计
 * 冻结常量），外加配对状态机（request → accept → done）、重连自举（hello）、
 * 心跳与 anchor 离线信号。
 *
 * 与 anchor 侧的互通关键点（改动任一侧都要两端同步）：
 *  - AES-256-GCM，iv(12B) ‖ ciphertext ‖ tag(16B) 整体 base64url——WebCrypto 的
 *    encrypt 天然输出 ct‖tag，与 Node 的 concat(update, final, tag) 一致；
 *  - AAD = shared `envelopeAadString`（envelope 去 `ct` 的稳定 JSON）；
 *  - HKDF-SHA256，salt = info = 'kepcup-remote-v1'（core codec.ts 的 HKDF_SALT，
 *    设计冻结值，core 未导出只能复制），ikm = ECDH 共享秘密 ∥ HMAC-SHA256(配对码,
 *    transcript-hash)（psk 模式仅后者），输出 64B 拆双向；
 *  - transcript-hash = sha256(逐段拼接，每段后补一个 0x00)（core `transcriptHash`）。
 *
 * 计数器与防重放（§4.5）按方向归属，两端 codec 都是「端点一次一实例」，语义
 * （WP6 审查修复后两端对齐，改动任一侧都要两端同步）：
 *  - viewer 的**出站**计数器随凭证持久化、跨刷新单调递增：hub 在 hello 重建端点
 *    时移植入站窗口（FrameCodec.adoptCountersFrom），清零的出站计数会被当重放拒掉；
 *  - viewer 的**入站**窗口每次新连接从零重建，不恢复持久化快照：hub 重建端点时
 *    出站计数续号（存活端点），而桌面重启 / 重装后入站计数从零重来——恢复旧窗口
 *    会把新流全部误判为重放，且「自愈再自举」也跳不出来（旧实现正是死在这里）。
 *    代价是重连瞬间中转可重放一条旧密文帧，密钥持有校验不受影响；
 *  - 连接中途的 REPLAY（同一条连接里被中转重放的帧）按丢弃处理，连续远低于窗口
 *    的回退帧仍触发自愈（重建 codec + hello）。
 */

// --- 编码工具（base64url / 字节拼接；btoa/atob 在 Node 16+ 与浏览器都有）--------

export function bytesToB64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64UrlToBytes(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function randomBytes(crypto: Crypto, length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(crypto: Crypto, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

// --- 防重放滑动窗口（§4.5；语义对齐 core codec.ts 的 ReplayWindow）----------------

export class ReplayWindow {
  #highest = -1;
  readonly #seen = new Set<number>();

  accept(n: number): boolean {
    if (this.#seen.has(n)) return false;
    if (n <= this.#highest - RELAY_REPLAY_WINDOW) return false;
    if (n > this.#highest) this.#highest = n;
    this.#seen.add(n);
    for (const seen of this.#seen) {
      if (seen <= this.#highest - RELAY_REPLAY_WINDOW) this.#seen.delete(seen);
    }
    return true;
  }

  /** 持久化快照（诊断用；入站窗口不再跨连接恢复，见模块头「计数器」说明）。 */
  snapshot(): { highest: number; seen: number[] } {
    return { highest: this.#highest, seen: [...this.#seen] };
  }
}

/** 协议违规（版本 / 防重放 / 篡改 / 超限）：调用方按 code 决定断开或自愈。 */
export class WebRelayProtocolError extends Error {
  constructor(
    readonly code: 'BAD_FRAME' | 'BAD_SESSION' | 'REPLAY' | 'AUTH_FAILED' | 'FRAME_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'WebRelayProtocolError';
  }
}

// --- 密钥派生（psk 回退 + X25519 ECDH；与 core deriveSessionKeys 逐字节一致）-------

export interface WebSessionKeys {
  pskMode: PairingKeyMode;
  /** anchor → viewer 方向（HKDF 输出前 32B）。 */
  anchorToViewer: Uint8Array;
  /** viewer → anchor 方向（后 32B）。 */
  viewerToAnchor: Uint8Array;
}

/** 与 core codec.ts 的 HKDF_SALT 相同（设计冻结；core 未导出，复制字符串）。 */
const HKDF_SALT = 'kepcup-remote-v1';

/** core `transcriptHash` 的 Web 版：sha256(逐段拼接，每段后补 0x00)。 */
export async function transcriptHashWeb(
  crypto: Crypto,
  parts: readonly string[],
): Promise<Uint8Array> {
  const chunks = parts.map((part) => concatBytes(encoder.encode(part), new Uint8Array([0])));
  return sha256(crypto, concatBytes(...chunks));
}

/**
 * 会话密钥派生（§4.4）。`psk` 模式 = WebCrypto 无 X25519 的回退（无 PFS，握手帧
 * 已标记、桌面设备行留痕）；`x25519` 模式必须带 ECDH 共享秘密。
 */
export async function deriveSessionKeysWeb(args: {
  crypto: Crypto;
  pskMode: PairingKeyMode;
  /** base64url 的 16B 配对码（配对链接第三段）。 */
  pairingCode: string;
  transcriptHash: Uint8Array;
  sharedSecret?: Uint8Array | null;
}): Promise<WebSessionKeys> {
  // 与 core deriveSessionKeys 对齐：x25519 缺共享秘密直接抛错，不静默退化为
  // 纯 PSK 派生（会产出与对端不一致的密钥且设备行仍标 x25519）。
  if (
    args.pskMode === 'x25519' &&
    (args.sharedSecret === undefined || args.sharedSecret === null)
  ) {
    throw new Error('x25519 模式缺少 ECDH 共享秘密');
  }
  const code = b64UrlToBytes(args.pairingCode);
  const codeKey = await args.crypto.subtle.importKey(
    'raw',
    code,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const pskBind = new Uint8Array(
    await args.crypto.subtle.sign('HMAC', codeKey, args.transcriptHash),
  );
  const ikm =
    args.pskMode === 'x25519' && args.sharedSecret !== undefined && args.sharedSecret !== null
      ? concatBytes(args.sharedSecret, pskBind)
      : pskBind;
  const ikmKey = await args.crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const out = new Uint8Array(
    await args.crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode(HKDF_SALT),
        info: encoder.encode(HKDF_SALT),
      },
      ikmKey,
      512,
    ),
  );
  return {
    pskMode: args.pskMode,
    anchorToViewer: out.slice(0, 32),
    viewerToAnchor: out.slice(32, 64),
  };
}

/** X25519 能力探测：generateKey 真跑一次（能力问题是唯一的不确定来源）。 */
export async function detectX25519Support(crypto: Crypto): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

interface EphemeralPair {
  /** 裸公钥 32B（线上 base64url）。 */
  epub: Uint8Array;
  privateKey: CryptoKey;
}

async function generateEphemeralX25519(crypto: Crypto): Promise<EphemeralPair> {
  // deriveKey 用途的 generateKey 返回 CryptoKeyPair（运行时恒真，类型上是并集）。
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const epub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { epub, privateKey: pair.privateKey };
}

async function x25519SharedWeb(
  crypto: Crypto,
  privateKey: CryptoKey,
  otherRawPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const publicKey = await crypto.subtle.importKey(
    'raw',
    otherRawPublicKey,
    { name: 'X25519' },
    false,
    [],
  );
  // WebCrypto 规范：X25519 deriveBits 的参数是 EcdhKeyDeriveParams，属性名是
  // `public`（不是 publicKey）——WP6 真机联调发现写成 publicKey 时浏览器端 ECDH
  // 直接抛「Missing required property」，配对卡死在握手。
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'X25519', public: publicKey } as unknown as Algorithm,
      privateKey,
      256,
    ),
  );
}

// --- 帧编解码（对齐 core codec.ts 的 FrameCodec；seal/open 都是异步的）-------------

const IV_BYTES = 12;
const TAG_BYTES = 16;

export type OpenedFrame = { complete: true; payload: unknown } | { complete: false };

export class WebFrameCodec {
  #sendN = 0;
  readonly #replay = new ReplayWindow();
  /** mid → 已到明文分片；拼完即删（并发上限兜底防泄漏）。 */
  readonly #fragments = new Map<string, { total: number; parts: Map<number, Uint8Array> }>();

  private constructor(
    private readonly crypto: Crypto,
    private readonly keys: WebSessionKeys,
    private readonly sid: string,
    private readonly role: 'anchor' | 'viewer',
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
  ) {}

  /** importKey 是异步的：统一走这里，传输层持有 Promise、按序 await。 */
  static async create(
    crypto: Crypto,
    keys: WebSessionKeys,
    sid: string,
    role: 'anchor' | 'viewer',
  ): Promise<WebFrameCodec> {
    const sendKey = await crypto.subtle.importKey(
      'raw',
      role === 'anchor' ? keys.anchorToViewer : keys.viewerToAnchor,
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const recvKey = await crypto.subtle.importKey(
      'raw',
      role === 'anchor' ? keys.viewerToAnchor : keys.anchorToViewer,
      'AES-GCM',
      false,
      ['decrypt'],
    );
    return new WebFrameCodec(crypto, keys, sid, role, sendKey, recvKey);
  }

  /** 加密并（必要时）分片；n 在调用时刻同步分配，出站顺序由传输层的发送链保证。 */
  async seal(
    type: RelayFrameType,
    payload: unknown,
    options: { did?: string; rid?: string } = {},
  ): Promise<RelayEnvelope[]> {
    const plain = encoder.encode(JSON.stringify(payload));
    if (plain.byteLength > RELAY_MAX_LOGICAL_BYTES) {
      throw new WebRelayProtocolError(
        'FRAME_TOO_LARGE',
        `逻辑消息超 8MB 上限（${plain.byteLength}B）`,
      );
    }
    const chunks: Uint8Array[] =
      plain.byteLength <= RELAY_FRAGMENT_THRESHOLD_BYTES
        ? [plain]
        : chunkBytes(plain, RELAY_FRAGMENT_THRESHOLD_BYTES);
    const mid = bytesToB64Url(randomBytes(this.crypto, 9));
    return Promise.all(
      chunks.map((chunk, i) =>
        this.#sealOne(type, chunk, {
          ...options,
          frag: chunks.length > 1 ? { mid, i, total: chunks.length } : undefined,
        }),
      ),
    );
  }

  async #sealOne(
    type: RelayFrameType,
    plain: Uint8Array,
    options: { did?: string; rid?: string; frag?: RelayFragment },
  ): Promise<RelayEnvelope> {
    const n = this.#sendN++;
    const envelope: RelayEnvelope = {
      v: RELAY_PROTOCOL_VERSION,
      sid: this.sid,
      type,
      ...(options.did !== undefined ? { did: options.did } : {}),
      ...(options.rid !== undefined ? { rid: options.rid } : {}),
      n,
      ...(options.frag !== undefined ? { frag: options.frag } : {}),
    };
    // IV = 方向标签 ‖ 64bit 计数器（与 core codec 同一布局；IV 不进协议，两端各自
    // 生成——同密钥下 n 唯一 → IV 唯一，消除随机 IV 的碰撞面）。
    const iv = new Uint8Array(IV_BYTES);
    iv[0] = this.role === 'anchor' ? 0xa2 : 0x76;
    const ivView = new DataView(iv.buffer);
    ivView.setUint32(4, Math.floor(n / 2 ** 32));
    ivView.setUint32(8, n >>> 0);
    const sealed = new Uint8Array(
      await this.crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: encoder.encode(envelopeAadString(envelope)),
          tagLength: TAG_BYTES * 8,
        },
        this.sendKey,
        plain,
      ),
    );
    return { ...envelope, ct: bytesToB64Url(concatBytes(iv, sealed)) };
  }

  /**
   * 校验 + 解密 + 重组。分片未齐返回 `{ complete: false }`；协议违规抛
   * WebRelayProtocolError（REPLAY 由传输层决定丢弃还是自愈，见模块头）。
   */
  async open(envelope: unknown): Promise<OpenedFrame> {
    const parsed = relayEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      throw new WebRelayProtocolError(
        'BAD_FRAME',
        `帧不合法：${parsed.error.issues[0]?.message ?? ''}`,
      );
    }
    const frame = parsed.data;
    if (frame.sid !== this.sid) {
      throw new WebRelayProtocolError('BAD_SESSION', '帧的会话 id 与本连接不符');
    }
    if (frame.ct === undefined) throw new WebRelayProtocolError('BAD_FRAME', '数据帧缺密文');
    if (!this.#replay.accept(frame.n)) {
      throw new WebRelayProtocolError('REPLAY', `计数器回退 / 重复（n=${frame.n}）`);
    }
    const blob = b64UrlToBytes(frame.ct);
    if (blob.length < IV_BYTES + TAG_BYTES) {
      throw new WebRelayProtocolError('BAD_FRAME', '密文过短');
    }
    const iv = blob.slice(0, IV_BYTES);
    const sealed = blob.slice(IV_BYTES);
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(
        await this.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv,
            additionalData: encoder.encode(envelopeAadString({ ...frame, ct: undefined })),
            tagLength: TAG_BYTES * 8,
          },
          this.recvKey,
          sealed,
        ),
      );
    } catch {
      throw new WebRelayProtocolError('AUTH_FAILED', '帧解密 / 校验失败（篡改或密钥不符）');
    }
    if (frame.frag === undefined) return completeFrame(plain);
    return this.#reassemble(frame.frag, plain);
  }

  #reassemble(frag: RelayFragment, plain: Uint8Array): OpenedFrame {
    if (frag.i >= frag.total) {
      throw new WebRelayProtocolError(
        'BAD_FRAME',
        `分片序号越界（i=${frag.i} total=${frag.total}）`,
      );
    }
    let entry = this.#fragments.get(frag.mid);
    if (entry === undefined) {
      entry = { total: frag.total, parts: new Map() };
      // 并发重组上限：超过先丢最早的一条（极端乱序的兜底，防内存泄漏）。
      if (this.#fragments.size >= 16) {
        const oldest = this.#fragments.keys().next().value;
        if (oldest !== undefined) this.#fragments.delete(oldest);
      }
      this.#fragments.set(frag.mid, entry);
    }
    entry.parts.set(frag.i, plain);
    if (entry.parts.size < frag.total) return { complete: false };
    const parts: Uint8Array[] = [];
    for (let index = 0; index < frag.total; index += 1) {
      const part = entry.parts.get(index);
      if (part === undefined) return { complete: false };
      parts.push(part);
    }
    this.#fragments.delete(frag.mid);
    const joined = concatBytes(...parts);
    if (joined.byteLength > RELAY_MAX_LOGICAL_BYTES) {
      throw new WebRelayProtocolError('FRAME_TOO_LARGE', '重组后逻辑消息超 8MB 上限');
    }
    return completeFrame(joined);
  }

  /** 出站计数器快照 / 恢复（出站随凭证持久化、跨连接单调；入站不跨连接）。 */
  snapshotOutbound(): number {
    return this.#sendN;
  }

  restoreOutbound(n: number): void {
    if (Number.isInteger(n) && n > this.#sendN) this.#sendN = n;
  }

  inboundSnapshot(): { highest: number; seen: number[] } {
    return this.#replay.snapshot();
  }
}

function completeFrame(plain: Uint8Array): OpenedFrame {
  return { complete: true, payload: JSON.parse(decoder.decode(plain)) };
}

function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size));
  }
  return chunks;
}

// --- 配对链接（§3.1：`<origin>/#pair=<relayUrl>,<sessionId>,<pairingSecret>`）------

export interface PairingLink {
  relayUrl: string;
  sessionId: string;
  /** 16B 配对码的 base64url（一次性，5 分钟有效）。 */
  secret: string;
}

const SESSION_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 解析配对链接（容忍整条 URL 或只有 `#pair=…` 片段）；不合法返回 null。 */
export function parsePairingLink(raw: string): PairingLink | null {
  const text = raw.trim();
  const at = text.indexOf('#pair=');
  const marker = at >= 0 ? text.slice(at + 6) : text.startsWith('pair=') ? text.slice(5) : null;
  if (marker === null) return null;
  const parts = marker.split(',');
  if (parts.length !== 3) return null;
  const [relayPart, sessionId, secret] = parts as [string, string, string];
  let relayUrl: string;
  try {
    relayUrl = decodeURIComponent(relayPart);
    const url = new URL(relayUrl);
    if ((url.protocol !== 'wss:' && url.protocol !== 'ws:') || url.hostname.length === 0)
      return null;
  } catch {
    return null;
  }
  if (
    !SESSION_ID_PATTERN.test(sessionId) ||
    secret.length < 8 ||
    !/^[A-Za-z0-9_-]+$/.test(secret)
  ) {
    return null;
  }
  return { relayUrl: relayUrl.replace(/\/+$/, ''), sessionId, secret };
}

// --- 传输层（配对状态机 + 重连自举 + 心跳）----------------------------------------

/** 中转 socket 的最小形状（生产包一层 WebSocket，测试注入 fake）。 */
export interface WsSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type WebLinkState = 'connecting' | 'paired' | 'connected' | 'reconnecting' | 'offline';

/** 配对流程的细粒度阶段（WebShellGate 据此渲染；linkState 是连接层面的粗状态）。 */
export type PairingPhase =
  | { kind: 'idle' }
  | { kind: 'joining' }
  | { kind: 'awaiting-confirm' }
  | { kind: 'rejected'; reason: 'expired' | 'declined' | 'bad_code' | 'busy' | 'error' }
  | { kind: 'kicked'; reason: 'revoked' | 'auth_failed' }
  /** 中转连续不可达（配对码还有效）：停住等用户手动重试，避免无限转圈。 */
  | { kind: 'failed'; reason: 'relay-unreachable' }
  | { kind: 'connected' };

/** localStorage 里的重连凭证（密钥即凭证：设备失窃 = 凭证失窃，撤销即时生效）。 */
interface StoredCredentials {
  deviceId: string;
  relayUrl: string;
  sessionId: string;
  pskMode: PairingKeyMode;
  anchorToViewer: string;
  viewerToAnchor: string;
  token: string;
  keyFingerprint: string;
}

/** 计数器快照（与凭证分开存；只存出站计数——入站窗口每连接重建，见模块头）。 */
interface StoredCounters {
  sessionId: string;
  sendN: number;
}

const CREDENTIALS_KEY = 'kepcup.remote.credentials.v1';
const COUNTERS_KEY = 'kepcup.remote.counters.v1';
const DEVICE_ID_KEY = 'kepcup.remote.deviceId.v1';

/** 重连退避（毫秒）：1s 起步翻倍、上限 15s（桌面 anchor 的 5min 上限对手机 UI 太钝）。 */
const RECONNECT_BACKOFF_BASE_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 15_000;
/** 入站 REPLAY 自愈阈值：连续 N 个远低于窗口的回退帧视为 anchor 重启过（计数归零）。 */
const REPLAY_HEAL_STRIKES = 8;
const REPLAY_HEAL_MARGIN = 32;
/** 配对阶段连续连不上中转的容忍次数：超过即进入 failed 态等手动重试。 */
const PAIRING_CONNECT_STRIKES = 3;

export interface WsTransportOptions {
  /** 初始会话 id；resume / startPairing 会用凭证 / 配对链接里的真实值覆盖。 */
  sessionId: string;
  socketFactory?: (url: string) => WsSocketLike;
  storage?: Storage;
  crypto?: Crypto;
  now?: () => number;
  userAgent?: string;
}

/** accept 负载由 shared 的 relayPairingPayloadSchema 严格校验（psk 模式的空串公钥
 * 在契约内：`{0,64}` 量词允许空串）。 */

interface PendingPairing {
  link: PairingLink;
  deviceName: string;
  pskMode: PairingKeyMode;
  ephemeral: EphemeralPair | null;
  /** 线上 epub（request 与 transcript 两处必须一致；psk 模式为契约允许的空串）。 */
  epub: string;
}

export class WsTransport implements RpcTransport {
  readonly #socketFactory: (url: string) => WsSocketLike;
  readonly #storage: Storage;
  readonly #crypto: Crypto;
  readonly #now: () => number;
  readonly #userAgent: string;
  readonly #linkListeners = new Set<(state: WebLinkState) => void>();
  readonly #pairingListeners = new Set<(phase: PairingPhase) => void>();

  #sid: string;
  #socket: WsSocketLike | null = null;
  #socketOpen = false;
  #codecCreation: Promise<WebFrameCodec> | null = null;
  #codecReady: WebFrameCodec | null = null;
  #credentials: StoredCredentials | null = null;
  #pendingPairing: PendingPairing | null = null;
  #derivedKeys: WebSessionKeys | null = null;
  #linkState: WebLinkState = 'connecting';
  #pairing: PairingPhase = { kind: 'idle' };
  #onDataHandler: ((data: unknown) => void) | null = null;
  /** seal 是异步的：出站帧经此链按 n 序发出。 */
  #sendChain: Promise<void> = Promise.resolve();
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #lastRecvAt = 0;
  #backoffMs = RECONNECT_BACKOFF_BASE_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #replayStrikes = 0;
  /** 配对阶段连续连接失败次数（onopen 归零；超 PAIRING_CONNECT_STRIKES 停住）。 */
  #pairingConnectStrikes = 0;
  /** x25519 探测结果缓存（每个页面生命周期探测一次）。 */
  #x25519Support: Promise<boolean> | null = null;
  /** 配对帧串行链：accept 的密钥派生是长异步链，done 必须等它落地（见 case 'pairing'）。 */
  #pairingChain: Promise<void> = Promise.resolve();

  constructor(options: WsTransportOptions) {
    this.#socketFactory =
      options.socketFactory ?? ((url) => new WebSocket(url) as unknown as WsSocketLike);
    this.#storage = options.storage ?? globalThis.localStorage;
    this.#crypto = options.crypto ?? globalThis.crypto;
    this.#now = options.now ?? Date.now;
    this.#userAgent = options.userAgent ?? globalThis.navigator.userAgent;
    this.#sid = options.sessionId;
    this.#credentials = this.#loadCredentials();
    // 页面回前台（审查修复）：后台节流可能已让心跳判死或退避定时器被冻结，立即
    // 检查重连，不等下一轮定时器。
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (
          this.#socket === null &&
          (this.#credentials !== null || this.#pendingPairing !== null)
        ) {
          this.reconnect();
        }
      });
    }
  }

  // --- 只读观察与订阅（Gate UI / CoreConnection 消费）---------------------------

  get linkState(): WebLinkState {
    return this.#linkState;
  }

  get pairing(): PairingPhase {
    return this.#pairing;
  }

  hasCredentials(): boolean {
    return this.#credentials !== null;
  }

  /** 会话密钥指纹（配对时桌面下发；Gate 连接页展示用，无凭证为空串）。 */
  get keyFingerprint(): string {
    return this.#credentials?.keyFingerprint ?? '';
  }

  onLinkState(handler: (state: WebLinkState) => void): () => void {
    this.#linkListeners.add(handler);
    return () => this.#linkListeners.delete(handler);
  }

  onPairing(handler: (phase: PairingPhase) => void): () => void {
    this.#pairingListeners.add(handler);
    return () => this.#pairingListeners.delete(handler);
  }

  #setLinkState(state: WebLinkState): void {
    this.#linkState = state;
    for (const listener of this.#linkListeners) listener(state);
  }

  #setPairing(phase: PairingPhase): void {
    this.#pairing = phase;
    for (const listener of this.#pairingListeners) listener(phase);
  }

  // --- 对外动作 ------------------------------------------------------------------

  /**
   * 带凭证自举：连中转 + 加密 hello（§4.4「之后每次重连」）。没有凭证则什么都不做
   * （首次配对由 Gate 经 startPairing 驱动）。
   */
  resume(): void {
    if (this.#credentials === null) return;
    this.#sid = this.#credentials.sessionId;
    this.#connect();
  }

  /** 发起配对：解析过的链接 + 用户确认的设备名。替换进行中的配对。 */
  async startPairing(link: PairingLink, deviceName: string): Promise<void> {
    const supportsX25519 = await this.#detectX25519();
    const pskMode: PairingKeyMode = supportsX25519 ? 'x25519' : 'psk';
    const ephemeral = supportsX25519 ? await generateEphemeralX25519(this.#crypto) : null;
    const epub = ephemeral !== null ? bytesToB64Url(ephemeral.epub) : '';
    // 重新配对（含已连接状态换桌面配对）：旧连接 / 旧 codec 一律作废。旧凭证
    // 暂留内存与存储——配对被拒时原会话仍可用（Gate 走 rejected 分支），配对
    // 成功时 done 帧会整体覆盖凭证与计数器。
    this.#pendingPairing = null;
    this.#detachSocket(true);
    this.#pendingPairing = { link, deviceName, pskMode, ephemeral, epub };
    this.#sid = link.sessionId;
    this.#setPairing({ kind: 'joining' });
    this.#setLinkState('connecting');
    this.#resetBackoff();
    this.#cancelReconnectTimer();
    this.#connect();
  }

  /** Gate 的手动重试：连接还开着（anchor 离线等待中）就重新自举，否则立刻重连。 */
  reconnect(): void {
    if (this.#socket !== null && this.#socketOpen) {
      void this.#bootstrapHello();
      return;
    }
    this.#resetBackoff();
    this.#cancelReconnectTimer();
    if (this.#pendingPairing !== null) {
      this.#pairingConnectStrikes = 0;
      this.#setPairing({ kind: 'joining' });
    }
    this.#connect();
  }

  /** 清本地凭证回到配对态（撤销 / 认证失败 / 用户主动重新配对）。 */
  resetPairing(): void {
    this.#credentials = null;
    this.#pendingPairing = null;
    this.#derivedKeys = null;
    this.#storage.removeItem(CREDENTIALS_KEY);
    this.#storage.removeItem(COUNTERS_KEY);
    this.#detachSocket(true);
    this.#setPairing({ kind: 'idle' });
    this.#setLinkState('connecting');
  }

  /** RpcTransport：birpc 请求 → seal('rpc') 上行（rid 透传到 envelope 供观测）。 */
  post(data: unknown): void {
    const source = data as { a?: unknown[]; i?: unknown } | null;
    const rid =
      typeof source?.i === 'string' && source.i.length > 0
        ? (source as { i: string }).i
        : undefined;
    // 纵深防御（源头修复在 shared 的 channel.call：无参方法零参发起）：跨端 JSON
    // 序列化仍可能把 a:[undefined] 变 a:[null]，被无参方法（voidInput）的 zod 校验
    // 拒掉。归一化在浅拷贝上做，不改写 birpc 的原消息对象。
    let payload = data;
    if (
      typeof source === 'object' &&
      source !== null &&
      Array.isArray(source.a) &&
      source.a.length === 1 &&
      (source.a[0] === null || source.a[0] === undefined)
    ) {
      payload = { ...source, a: [] };
    }
    const did = this.#credentials?.deviceId;
    this.#enqueueWithCodec((codec) =>
      codec
        .seal('rpc', payload, {
          ...(did !== undefined ? { did } : {}),
          ...(rid !== undefined ? { rid } : {}),
        })
        .catch(() => null),
    );
  }

  /** RpcTransport：birpc 消息入口（rpc 帧原样；event 帧转 birpc 事件消息）。 */
  onData(handler: (data: unknown) => void): () => void {
    this.#onDataHandler = handler;
    return () => {
      if (this.#onDataHandler === handler) this.#onDataHandler = null;
    };
  }

  /** RpcTransport：页面卸载 / 重绑定时的收尾。 */
  close(): void {
    this.#pendingPairing = null;
    this.#detachSocket(true);
  }

  // --- 连接与自举 ----------------------------------------------------------------

  #connect(): void {
    if (this.#socket !== null) return;
    const source = this.#pendingPairing?.link ?? this.#credentials;
    if (source === null) return;
    const url = `${source.relayUrl.replace(/\/+$/, '')}/ws/${this.#sid}?role=viewer`;
    const socket = this.#socketFactory(url);
    this.#socket = socket;
    this.#socketOpen = false;
    socket.onopen = () => {
      this.#socketOpen = true;
      this.#backoffMs = RECONNECT_BACKOFF_BASE_MS;
      this.#pairingConnectStrikes = 0;
      if (this.#pendingPairing !== null) void this.#sendPairingRequest();
      else void this.#bootstrapHello();
    };
    socket.onmessage = (event) => this.#onSocketMessage(event.data);
    socket.onclose = () => this.#onSocketDown();
    socket.onerror = () => {}; // 关闭回调统一驱动重连，error 不重复触发
  }

  /** 拆掉当前连接（close=false 仅断线重连场景：让 onclose 驱动后续）。 */
  #detachSocket(close: boolean): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#socketOpen = false;
    this.#codecCreation = null;
    this.#codecReady = null;
    this.#stopHeartbeat();
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (close) {
        try {
          socket.close(1000, 'client reset');
        } catch {
          // 已关闭的 socket 再 close 会抛，忽略。
        }
      }
    }
  }

  /** socket 意外断开：配对流程与已配对自举都按退避自动重连。 */
  #onSocketDown(): void {
    this.#socket = null;
    this.#socketOpen = false;
    this.#codecCreation = null;
    this.#codecReady = null;
    this.#stopHeartbeat();
    if (this.#pendingPairing !== null) {
      this.#pairingConnectStrikes += 1;
      this.#setLinkState('connecting');
      if (this.#pairingConnectStrikes >= PAIRING_CONNECT_STRIKES) {
        // 中转不可达：停住等手动重试（配对码 5 分钟内重试依然有效）。
        this.#cancelReconnectTimer();
        this.#setPairing({ kind: 'failed', reason: 'relay-unreachable' });
        return;
      }
      this.#scheduleReconnect();
      return;
    }
    if (this.#credentials === null) return;
    // 自举中（paired）与已连上（connected）断开都进入重连态；offline（anchor 离线、
    // socket 还在）不经这里——socket 真断开时离线等待已无意义，回到重连。
    this.#setLinkState('reconnecting');
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #cancelReconnectTimer(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #resetBackoff(): void {
    this.#backoffMs = RECONNECT_BACKOFF_BASE_MS;
  }

  /** 新建 codec（异步 importKey）：附带头注释里说明的计数器语义。 */
  #ensureCodec(credentials: StoredCredentials): Promise<WebFrameCodec> {
    if (this.#codecCreation === null) {
      this.#codecCreation = WebFrameCodec.create(
        this.#crypto,
        {
          pskMode: credentials.pskMode,
          anchorToViewer: b64UrlToBytes(credentials.anchorToViewer),
          viewerToAnchor: b64UrlToBytes(credentials.viewerToAnchor),
        },
        credentials.sessionId,
        'viewer',
      ).then((codec) => {
        const stored = this.#loadCounters();
        if (stored !== null && stored.sessionId === credentials.sessionId) {
          // 只恢复出站计数（跨连接单调）；入站窗口不恢复，见模块头「计数器」。
          codec.restoreOutbound(stored.sendN);
        }
        this.#codecReady = codec;
        return codec;
      });
    }
    return this.#codecCreation;
  }

  #loadCounters(): StoredCounters | null {
    try {
      const raw = this.#storage.getItem(COUNTERS_KEY);
      if (raw === null) return null;
      return JSON.parse(raw) as StoredCounters;
    } catch {
      return null;
    }
  }

  /**
   * 重连自举（§4.4）：hello{token}，AEAD 解密成功 + 防重放窗口内即证明持有会话密钥，
   * token 由桌面比对哈希。发出即视为已连上（桌面无显式 ack；被拒会收到 kick）。
   */
  async #bootstrapHello(): Promise<void> {
    const credentials = this.#credentials;
    if (credentials === null || this.#socket === null) return;
    this.#sid = credentials.sessionId;
    this.#ensureCodec(credentials);
    const did = credentials.deviceId;
    this.#enqueueWithCodec((codec) =>
      codec.seal('hello', { token: credentials.token, ts: this.#now() }, { did }).catch(() => null),
    );
    this.#setPairing({ kind: 'connected' });
    this.#setLinkState('connected');
    this.#startHeartbeat();
  }

  // --- 配对协议（request → accept → done）----------------------------------------

  async #sendPairingRequest(): Promise<void> {
    const pending = this.#pendingPairing;
    const socket = this.#socket;
    if (pending === null || socket === null) return;
    const deviceId = this.#ensureDeviceId();
    const transcript = pairingRequestTranscript({
      deviceId,
      epub: pending.epub,
      pskMode: pending.pskMode,
    });
    const hash = await transcriptHashWeb(this.#crypto, [transcript]);
    const codeKey = await this.#crypto.subtle.importKey(
      'raw',
      b64UrlToBytes(pending.link.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const auth = bytesToB64Url(
      new Uint8Array(await this.#crypto.subtle.sign('HMAC', codeKey, hash)),
    );
    socket.send(
      JSON.stringify({
        v: RELAY_PROTOCOL_VERSION,
        sid: pending.link.sessionId,
        type: 'pairing',
        did: deviceId,
        n: 0,
        data: {
          kind: 'request',
          deviceId,
          deviceName: pending.deviceName,
          userAgent: this.#userAgent.slice(0, 500),
          epub: pending.epub,
          pskMode: pending.pskMode,
          auth,
        } satisfies RelayPairingRequestPayload,
      }),
    );
    this.#setPairing({ kind: 'awaiting-confirm' });
  }

  /** accept（明文负载）到达：ECDH + HKDF 派生会话密钥，等 done（密文）落地。 */
  async #onPairingAccept(payload: { apub: string; pskMode: PairingKeyMode }): Promise<void> {
    const pending = this.#pendingPairing;
    if (pending === null) return;
    const deviceId = this.#ensureDeviceId();
    const requestPart = pairingRequestTranscript({
      deviceId,
      epub: pending.epub,
      pskMode: pending.pskMode,
    });
    const acceptPart = pairingAcceptTranscript({ apub: payload.apub, pskMode: payload.pskMode });
    const hash = await transcriptHashWeb(this.#crypto, [requestPart, acceptPart]);
    const shared =
      pending.ephemeral !== null && payload.pskMode === 'x25519' && payload.apub.length > 0
        ? await x25519SharedWeb(
            this.#crypto,
            pending.ephemeral.privateKey,
            b64UrlToBytes(payload.apub),
          )
        : null;
    this.#derivedKeys = await deriveSessionKeysWeb({
      crypto: this.#crypto,
      pskMode: payload.pskMode,
      pairingCode: pending.link.secret,
      transcriptHash: hash,
      sharedSecret: shared,
    });
    // 密钥就绪即可建 codec（入站计数器从 0 起——done 是 anchor 配对 codec 的首帧）。
    // done 落地后重建一次：anchor 在 hello 时会换新端点 codec，入站窗口必须重开。
    this.#codecCreation = WebFrameCodec.create(
      this.#crypto,
      this.#derivedKeys,
      pending.link.sessionId,
      'viewer',
    ).then((codec) => {
      this.#codecReady = codec;
      return codec;
    });
  }

  /** done（密文负载）到达：存凭证 + 重建 codec（对齐 anchor 的端点重建）+ 立即自举。 */
  async #onPairingDone(payload: { token: string; keyFingerprint: string }): Promise<void> {
    const pending = this.#pendingPairing;
    const keys = this.#derivedKeys;
    if (pending === null || keys === null) return;
    const credentials: StoredCredentials = {
      deviceId: this.#ensureDeviceId(),
      relayUrl: pending.link.relayUrl,
      sessionId: pending.link.sessionId,
      pskMode: keys.pskMode,
      anchorToViewer: bytesToB64Url(keys.anchorToViewer),
      viewerToAnchor: bytesToB64Url(keys.viewerToAnchor),
      token: payload.token,
      keyFingerprint: payload.keyFingerprint,
    };
    this.#credentials = credentials;
    this.#pendingPairing = null;
    this.#derivedKeys = null;
    try {
      this.#storage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
      this.#storage.removeItem(COUNTERS_KEY);
    } catch {
      // 存不进去（隐私模式 / 配额）：本次会话可用，刷新后需重新配对。
    }
    // 新凭证 = 两侧计数器都从零：丢弃 accept 阶段的 codec，hello 用全新计数。
    this.#codecCreation = null;
    this.#codecReady = null;
    this.#ensureCodec(credentials);
    await this.#bootstrapHello();
  }

  #ensureDeviceId(): string {
    let stored: string | null = null;
    try {
      stored = this.#storage.getItem(DEVICE_ID_KEY);
    } catch {
      // 隐私模式读不到就走生成路径。
    }
    if (stored === null || !/^[A-Za-z0-9_-]{16,64}$/.test(stored)) {
      // 24B 随机的 base64url：32 字符，落在 REMOTE_DEVICE_ID_PATTERN 内。
      const deviceId = bytesToB64Url(randomBytes(this.#crypto, 24));
      try {
        this.#storage.setItem(DEVICE_ID_KEY, deviceId);
      } catch {
        // 存不进去（配额 / 隐私模式）：退化为本次会话的内存 id，刷新后重新配对
        //（审查修复：原先裸抛会让 startPairing 整体失败）。
      }
      return deviceId;
    }
    return stored;
  }

  #loadCredentials(): StoredCredentials | null {
    try {
      const raw = this.#storage.getItem(CREDENTIALS_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
      if (
        typeof parsed.deviceId !== 'string' ||
        typeof parsed.relayUrl !== 'string' ||
        typeof parsed.sessionId !== 'string' ||
        typeof parsed.pskMode !== 'string' ||
        typeof parsed.token !== 'string' ||
        typeof parsed.anchorToViewer !== 'string' ||
        typeof parsed.viewerToAnchor !== 'string'
      ) {
        return null;
      }
      return parsed as StoredCredentials;
    } catch {
      return null;
    }
  }

  // --- 出站队列与心跳 --------------------------------------------------------------

  /** seal 排进发送链：按 n 序写 socket，发完持久化计数器快照。 */
  #enqueueWithCodec(run: (codec: WebFrameCodec) => Promise<RelayEnvelope[] | null>): void {
    this.#sendChain = this.#sendChain
      .then(async () => {
        const creation = this.#codecCreation;
        if (creation === null || this.#socket === null) return;
        const codec = await creation;
        const frames = await run(codec);
        if (frames === null) return;
        for (const frame of frames) this.#socket?.send(JSON.stringify(frame));
        if (this.#credentials !== null) {
          try {
            const snapshot: StoredCounters = {
              sessionId: this.#sid,
              sendN: codec.snapshotOutbound(),
            };
            this.#storage.setItem(COUNTERS_KEY, JSON.stringify(snapshot));
          } catch {
            // 配额满 / 隐私模式：出站计数退化为内存态（刷新后 hello 可能被旧窗口
            // 拒一次，随后的重连自举按新计数通过）。
          }
        }
      })
      .catch(() => {
        // 发送失败由 socket close → 重连路径兜底；这里只保证发送链不断。
      });
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#lastRecvAt = this.#now();
    this.#pingTimer = setInterval(() => {
      const socket = this.#socket;
      if (socket === null) return;
      // 活性：三个心跳周期没收到任何帧（含 pong）就按断链处理，主动重连。
      if (this.#now() - this.#lastRecvAt > RELAY_HEARTBEAT_MS * 3) {
        this.#detachSocket(true);
        this.#onSocketDown();
        return;
      }
      socket.send(
        JSON.stringify({ v: RELAY_PROTOCOL_VERSION, sid: this.#sid, type: 'ping', n: 0 }),
      );
    }, RELAY_HEARTBEAT_MS);
  }

  #stopHeartbeat(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  // --- 入站帧分发 ------------------------------------------------------------------

  #onSocketMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    this.#lastRecvAt = this.#now();
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.#onBadFrame('帧不是 JSON');
      return;
    }
    const parsed = relayEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.#onBadFrame(`帧不合法：${parsed.error.issues[0]?.message ?? ''}`);
      return;
    }
    const frame = parsed.data;
    if (frame.sid !== this.#sid) {
      this.#onBadFrame('帧的会话 id 与本连接不符');
      return;
    }
    switch (frame.type) {
      case 'signal': {
        const kind = frame.info?.kind;
        if (kind === 'anchor_offline') {
          // 桌面离线：socket 保留（DO 等 anchor 回来），UI 切离线态。
          this.#setLinkState('offline');
        } else if (kind === 'anchor_online') {
          // 桌面回来了：端点是新的（计数器从零），重新自举。
          if (this.#credentials !== null) {
            this.#codecCreation = null;
            this.#codecReady = null;
            this.#setLinkState('paired');
            void this.#bootstrapHello();
          }
        } else if (kind === 'replaced') {
          // 同 did 的另一个连接顶掉了我们（多开标签页）：不自动重连，避免互踢循环。
          this.#detachSocket(true);
          this.#setLinkState('reconnecting');
        } else if (kind === 'session_idle' || kind === 'ratelimit') {
          // DO 逐出 / 限流踢出：重连（限流按 DO 告知的等待时间退避）。
          this.#detachSocket(true);
          this.#setLinkState(this.#credentials !== null ? 'reconnecting' : 'connecting');
          this.#backoffMs = Math.max(
            this.#backoffMs,
            kind === 'ratelimit' ? (frame.info?.retryAfterMs ?? 0) : 0,
          );
          this.#scheduleReconnect();
        }
        return;
      }
      case 'pong':
        return; // 活性已由 #lastRecvAt 刷新
      case 'ping':
        return; // 中转自己对 ping 回 pong；anchor 不会 ping viewer
      case 'error': {
        const info = frame.info;
        this.#onBadFrame(info?.kind === 'bad_frame' ? info.message : 'relay error');
        return;
      }
      case 'kick':
        void this.#onKick(frame);
        return;
      case 'pairing':
        // accept→done 竞态钉（真机首配实测）：hub 确认后 accept+done 背靠背发出，
        // accept 的处理是约 8 步顺序 WebCrypto 调用（摘要 → ECDH → HKDF →
        // importKey），跑完才把配对 codec 挂到 #codecCreation；done 若不排队等它，
        // 会读到 null 被静默丢弃——桌面显示配对成功、手机永远停在「等待确认」。
        // 配对帧量级是个位数，串行零成本；accept 半途抛错（ECDH / HKDF）明确转
        // rejected，不许停在 awaiting-confirm 干等。
        this.#pairingChain = this.#pairingChain
          .then(() => this.#onPairingFrame(frame))
          .catch((error: unknown) => {
            console.warn('[kepcup-remote] 配对帧处理失败', error);
            if (this.#pendingPairing !== null) {
              this.#pendingPairing = null;
              this.#derivedKeys = null;
              this.#detachSocket(true);
              this.#setPairing({ kind: 'rejected', reason: 'error' });
              this.#setLinkState('connecting');
            }
          });
        return;
      case 'hello':
        return; // viewer 不该收到 hello
      case 'rpc':
      case 'event':
        void this.#onDataFrame(frame);
        return;
    }
  }

  /** 协议违规：断开重连（不做静默降级，设计 §4.5）。 */
  #onBadFrame(message: string): void {
    console.warn(`[kepcup-remote] 坏帧：${message}`);
    this.#detachSocket(true);
    if (this.#credentials !== null || this.#pendingPairing !== null) {
      this.#setLinkState(this.#credentials !== null ? 'reconnecting' : 'connecting');
      this.#scheduleReconnect();
    }
  }

  async #onKick(frame: RelayEnvelope): Promise<void> {
    if (frame.ct === undefined) {
      // DO 自产的明文 kick（限流）：按告知的等待时长退避重连（审查修复：原先被
      // 无 ct 早退直接忽略，退避提示丢失）。
      const retryAfterMs = frame.info?.kind === 'ratelimit' ? frame.info.retryAfterMs : 0;
      this.#detachSocket(true);
      this.#setLinkState(this.#credentials !== null ? 'reconnecting' : 'connecting');
      this.#backoffMs = Math.max(this.#backoffMs, retryAfterMs);
      this.#scheduleReconnect();
      return;
    }
    const creation = this.#codecCreation;
    if (creation === null) return;
    let reason: 'revoked' | 'auth_failed' | 'anchor_shutdown' | 'replaced';
    try {
      const opened = await creation.then((codec) => codec.open(frame));
      if (!opened.complete) return;
      const kick = relayKickPayloadSchema.safeParse(opened.payload);
      if (!kick.success) return;
      reason = kick.data.reason;
    } catch {
      // 解不开的 kick：按断链重连（密钥不对的话后续 hello 也会被拒）。
      reason = 'anchor_shutdown';
    }
    if (reason === 'revoked' || reason === 'auth_failed') {
      // 撤销 / 认证失败：清凭证回配对态（设计 §4.4），Gate 给出明确文案。
      this.#pendingPairing = null;
      this.#credentials = null;
      this.#storage.removeItem(CREDENTIALS_KEY);
      this.#storage.removeItem(COUNTERS_KEY);
      this.#detachSocket(true);
      this.#setPairing({ kind: 'kicked', reason });
      this.#setLinkState('connecting');
      return;
    }
    // anchor_shutdown / replaced：退避重连即可。
    this.#detachSocket(true);
    this.#setLinkState('reconnecting');
    this.#scheduleReconnect();
  }

  async #onPairingFrame(frame: RelayEnvelope): Promise<void> {
    if (frame.data !== undefined) {
      // accept / reject 明文负载，shared 契约严格校验（psk 的空串公钥在契约内）。
      const payload = relayPairingPayloadSchema.safeParse(frame.data);
      if (payload.success && payload.data.kind === 'accept') {
        await this.#onPairingAccept(payload.data);
        return;
      }
      if (payload.success && payload.data.kind === 'reject') {
        this.#pendingPairing = null;
        this.#derivedKeys = null;
        this.#detachSocket(true);
        this.#setPairing({ kind: 'rejected', reason: payload.data.reason });
        this.#setLinkState('connecting');
      }
      return; // request / done 不会以明文出现
    }
    if (frame.ct === undefined) return;
    const creation = this.#codecCreation;
    if (creation === null) return;
    try {
      const opened = await creation.then((codec) => codec.open(frame));
      if (!opened.complete) return;
      const payload = relayPairingPayloadSchema.safeParse(opened.payload);
      if (payload.success && payload.data.kind === 'done') {
        await this.#onPairingDone(payload.data);
      }
    } catch (error) {
      // done 解不开（配对码错 / 密钥不符）：配对失败，回配对态。
      console.warn('[kepcup-remote] done 帧解密失败', error);
      this.#pendingPairing = null;
      this.#derivedKeys = null;
      this.#detachSocket(true);
      this.#setPairing({ kind: 'rejected', reason: 'bad_code' });
    }
  }

  /** rpc / event 帧：解密后喂 birpc。event 转成 birpc 事件消息 `{m, a, t:'q'}`。 */
  async #onDataFrame(frame: RelayEnvelope): Promise<void> {
    const creation = this.#codecCreation;
    if (creation === null) return;
    try {
      const opened = await creation.then((codec) => codec.open(frame));
      if (!opened.complete) return;
      if (frame.type === 'rpc') {
        this.#onDataHandler?.(opened.payload);
        return;
      }
      const event = relayEventPayloadSchema.safeParse(opened.payload);
      if (!event.success) return;
      this.#onDataHandler?.({ m: event.data.name, a: [event.data.payload], t: 'q' });
    } catch (error) {
      if (error instanceof WebRelayProtocolError && error.code === 'REPLAY') {
        if (this.#countReplayStrike(frame.n)) {
          // 自愈：同一条连接里连续出现远低于窗口的回退帧（对端密钥流重启过）。
          // 重建 codec——入站窗口随新连接重置（模块头「计数器」），出站计数续号。
          console.warn('[kepcup-remote] 入站计数器回退，重建计数状态并重新自举');
          this.#codecCreation = null;
          this.#codecReady = null;
          this.#setLinkState(this.#credentials !== null ? 'paired' : 'connecting');
          if (this.#credentials !== null) this.#ensureCodec(this.#credentials);
          void this.#bootstrapHello();
        }
        return; // 个别回退帧：丢弃，等窗口滑过
      }
      if (error instanceof WebRelayProtocolError && error.code === 'AUTH_FAILED') {
        // 密钥不符（可能桌面侧重置过）：清凭证回配对态。
        this.#pendingPairing = null;
        this.#credentials = null;
        this.#storage.removeItem(CREDENTIALS_KEY);
        this.#storage.removeItem(COUNTERS_KEY);
        this.#detachSocket(true);
        this.#setPairing({ kind: 'kicked', reason: 'auth_failed' });
        this.#setLinkState('connecting');
        return;
      }
      this.#onBadFrame(error instanceof Error ? error.message : String(error));
    }
  }

  #countReplayStrike(n: number): boolean {
    const highest = this.#codecReady?.inboundSnapshot().highest ?? -1;
    if (n > highest - REPLAY_HEAL_MARGIN) {
      this.#replayStrikes = 0;
      return false;
    }
    this.#replayStrikes += 1;
    return this.#replayStrikes >= REPLAY_HEAL_STRIKES;
  }

  #detectX25519(): Promise<boolean> {
    this.#x25519Support ??= detectX25519Support(this.#crypto);
    return this.#x25519Support;
  }
}

/** 配对请求负载的局部形状（sendPairingRequest 的 satisfies 目标）。 */
type RelayPairingRequestPayload = {
  kind: 'request';
  deviceId: string;
  deviceName: string;
  userAgent: string;
  epub: string;
  pskMode: PairingKeyMode;
  auth: string;
};

// --- 页面级单例（web 构建里 Gate 与 CoreConnection 共用同一条链路）------------------

let shared: WsTransport | null = null;

export function getWebTransport(): WsTransport {
  if (shared === null) {
    shared = new WsTransport({ sessionId: '0'.repeat(26) });
  }
  return shared;
}
