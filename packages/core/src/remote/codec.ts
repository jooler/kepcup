import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import {
  AppError,
  PAIRING_CODE_BYTES,
  RELAY_FRAGMENT_THRESHOLD_BYTES,
  RELAY_MAX_LOGICAL_BYTES,
  RELAY_PROTOCOL_VERSION,
  RELAY_REPLAY_WINDOW,
  envelopeAadString,
  relayEnvelopeSchema,
  type PairingKeyMode,
  type RelayEnvelope,
  type RelayFrameType,
} from '@kepcup/shared';

/**
 * 远程遥控 E2E 编解码（D96，design 46 §4.5）：帧加解密（AES-256-GCM，AAD = envelope
 * 去密文）、双向计数器防重放（滑动窗口）、>128KB 分片 / 重组、8MB 逻辑上限、版本
 * 不匹配断开。Node `crypto` 实现；手机端 WebCrypto 实现与之共用 shared 的
 * `envelopeAadString`（序列化逐字节一致）与 HKDF 参数（见 `deriveSessionKeys`），
 * WP5 落地后两端互测向量对齐（`remote-codec.test.ts` 固化本侧向量）。
 */

/** HKDF salt / info：两端一致，写进设计即冻结（改动即换会话密钥）。 */
const HKDF_SALT = 'kepcup-remote-v1';

/** 双向会话密钥（hex/base64 不落盘；存 secrets 表时序列化为 JSON）。 */
export interface SessionKeys {
  pskMode: PairingKeyMode;
  /** anchor → viewer 方向（HKDF 输出前 32B）。 */
  anchorToViewer: Buffer;
  /** viewer → anchor 方向（后 32B）。 */
  viewerToAnchor: Buffer;
}

/** X25519 裸公钥（32B）与 Node DER（44B，固定 12B 前缀）互转。 */
const X25519_DER_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function x25519RawFromDer(der: Buffer): Buffer {
  if (!der.subarray(0, 12).equals(X25519_DER_PREFIX) || der.length !== 44) {
    throw new AppError('INTERNAL', 'unexpected X25519 DER public key');
  }
  return der.subarray(12);
}

export function x25519DerFromRaw(raw: Buffer): Buffer {
  return Buffer.concat([X25519_DER_PREFIX, raw]);
}

export interface EphemeralKeyPair {
  /** 裸公钥 32B（线上 base64url）。 */
  rawPublicKey: Buffer;
  privateKey: Buffer;
}

export function generateEphemeralX25519(): EphemeralKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    rawPublicKey: x25519RawFromDer(publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

/** X25519 共享秘密（32B）；任一侧密钥不合法抛 INTERNAL。 */
export function x25519Shared(privateKeyDer: Buffer, otherRawPublicKey: Buffer): Buffer {
  const priv = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  // Node 24+（及 Electron 之外的纯 Node）要求 publicKey 为 KeyObject；传
  // `{ key, format, type }` 会 ERR_INVALID_ARG_VALUE。createPublicKey 两端都通。
  const pub = createPublicKey({
    key: x25519DerFromRaw(otherRawPublicKey),
    format: 'der',
    type: 'spki',
  });
  return diffieHellman({ privateKey: priv, publicKey: pub });
}

/**
 * 会话密钥派生（§4.4）：ikm = X25519 共享秘密（psk 模式为空）∥
 * HMAC-SHA256(配对码, transcript)；HKDF-SHA256 输出 64B 拆双向。
 * `psk` 模式 = WebCrypto 无 X25519 的端回退（无 PFS，设备行留痕）。
 */
export function deriveSessionKeys(args: {
  pskMode: PairingKeyMode;
  pairingCode: Uint8Array;
  transcriptHash: Uint8Array;
  /** x25519 模式的 ECDH 共享秘密；psk 模式忽略。 */
  sharedSecret?: Uint8Array | null;
}): SessionKeys {
  if (args.pairingCode.length !== PAIRING_CODE_BYTES) {
    throw new AppError('INTERNAL', '配对码长度不对（16B）');
  }
  // x25519 模式缺共享秘密直接抛错（审查修复）：静默退化为纯 PSK 派生会产出与
  // 对端不一致的密钥，且设备行仍标 x25519，问题被掩盖到「永远解不开帧」。
  if (
    args.pskMode === 'x25519' &&
    (args.sharedSecret === undefined || args.sharedSecret === null)
  ) {
    throw new AppError('INTERNAL', 'x25519 模式缺少 ECDH 共享秘密');
  }
  const pskBind = createHmac('sha256', args.pairingCode).update(args.transcriptHash).digest();
  const ikm =
    args.pskMode === 'x25519'
      ? Buffer.concat([Buffer.from(args.sharedSecret as Uint8Array), pskBind])
      : pskBind;
  const out = Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, HKDF_SALT, 64));
  return {
    pskMode: args.pskMode,
    anchorToViewer: out.subarray(0, 32),
    viewerToAnchor: out.subarray(32, 64),
  };
}

/** 会话密钥指纹（设备管理展示；sha256(双向密钥) hex）。 */
export function sessionKeyFingerprint(keys: SessionKeys): string {
  return createHash('sha256')
    .update(Buffer.concat([keys.anchorToViewer, keys.viewerToAnchor]))
    .digest('hex');
}

/** secrets 表 `remote:{deviceId}` 的序列化形态。 */
export function serializeSessionKeys(keys: SessionKeys): string {
  return JSON.stringify({
    pskMode: keys.pskMode,
    anchorToViewer: keys.anchorToViewer.toString('base64'),
    viewerToAnchor: keys.viewerToAnchor.toString('base64'),
  });
}

export function parseSessionKeys(value: string): SessionKeys {
  const raw = JSON.parse(value) as {
    pskMode: PairingKeyMode;
    anchorToViewer: string;
    viewerToAnchor: string;
  };
  const anchorToViewer = Buffer.from(raw.anchorToViewer, 'base64');
  const viewerToAnchor = Buffer.from(raw.viewerToAnchor, 'base64');
  if (anchorToViewer.length !== 32 || viewerToAnchor.length !== 32) {
    throw new AppError('INTERNAL', '会话密钥材料损坏');
  }
  return { pskMode: raw.pskMode, anchorToViewer, viewerToAnchor };
}

/** 协议错误：调用方断开连接（版本不匹配 / 防重放 / 篡改 / 超限，§4.5）。 */
export class RelayProtocolError extends AppError {
  constructor(
    code: string,
    message: string,
    readonly fatal: boolean = true,
  ) {
    super(code, message);
  }
}

/** 防重放滑动窗口（§4.5）：本方向单调计数器 `n`，回退 / 重复即拒。 */
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

  /** 移植另一窗口的状态（端点重建，见 FrameCodec.adoptCountersFrom）。 */
  adopt(other: ReplayWindow): void {
    this.#highest = other.#highest;
    this.#seen.clear();
    for (const seen of other.#seen) this.#seen.add(seen);
  }
}

/** 解开（密文）帧后的产物：完整逻辑消息或分片暂存中。 */
export type OpenedFrame = { complete: true; payload: unknown } | { complete: false };

const IV_BYTES = 12;

/** 并发重组的 mid 数上限（与手机端 WebFrameCodec 一致，防半成品分片占内存）。 */
const MAX_PENDING_FRAGMENTS = 16;

/**
 * 单连接编解码器：一个遥控端点一个实例（anchor 侧）或 PWA 一个实例（viewer 侧）。
 * 发送方向按 `role` 选密钥；接收方向用另一把。分片各自独立加密（AAD 含 frag 头，
 * 无法拼接调包），端侧按 `mid` 重组。
 */
export class FrameCodec {
  readonly #keys: SessionKeys;
  readonly #sid: string;
  readonly #role: 'anchor' | 'viewer';
  #sendN = 0;
  readonly #replay = new ReplayWindow();
  /** mid → 已到明文分片；超上限或拼完即删。 */
  readonly #fragments = new Map<string, { total: number; parts: Map<number, Buffer> }>();

  constructor(keys: SessionKeys, sid: string, role: 'anchor' | 'viewer') {
    this.#keys = keys;
    this.#sid = sid;
    this.#role = role;
  }

  /** 出站计数器当前值（跨连接续号 / 测试断言用）。 */
  get outboundCounter(): number {
    return this.#sendN;
  }

  /** 恢复出站计数器（只增不减；viewer 侧重连时续号用，语义见 ws-transport 模块头）。 */
  restoreOutbound(n: number): void {
    if (Number.isInteger(n) && n > this.#sendN) this.#sendN = n;
  }

  /**
   * 端点重建时移植旧 codec 的双向计数状态（WP6 审查修复 P0/P1）：出站续号——
   * viewer 持久化的入站水位不会被打回归零的计数判成重放；入站防重放窗口保留——
   * 同一条捕获的 hello 无法被不可信中转重放（hello 自证密钥持有，但没有新鲜性，
   * 窗口是它唯一的重放防线）。viewer 密钥流整体重启（桌面重启 / 重装，无旧
   * codec 可移植）由 viewer 侧「入站窗口每连接重建」兜底。
   */
  adoptCountersFrom(previous: FrameCodec): void {
    this.#sendN = previous.#sendN;
    this.#replay.adopt(previous.#replay);
  }

  /** 加密并（必要时）分片；返回按序发出的 envelope。 */
  seal(
    type: RelayFrameType,
    payload: unknown,
    options: { did?: string; rid?: string } = {},
  ): RelayEnvelope[] {
    const plain = Buffer.from(JSON.stringify(payload), 'utf8');
    if (plain.length > RELAY_MAX_LOGICAL_BYTES) {
      throw new RelayProtocolError('FRAME_TOO_LARGE', `逻辑消息超 8MB 上限（${plain.length}B）`);
    }
    const chunks: Buffer[] =
      plain.length <= RELAY_FRAGMENT_THRESHOLD_BYTES
        ? [plain]
        : chunkBuffer(plain, RELAY_FRAGMENT_THRESHOLD_BYTES);
    const mid = randomBytes(9).toString('base64url');
    return chunks.map((chunk, i) =>
      this.#sealOne(type, chunk, {
        ...options,
        frag: chunks.length > 1 ? { mid, i, total: chunks.length } : undefined,
      }),
    );
  }

  #sealOne(
    type: RelayFrameType,
    plain: Buffer,
    options: { did?: string; rid?: string; frag?: RelayEnvelope['frag'] },
  ): RelayEnvelope {
    const n = this.#sendN++;
    const envelope: RelayEnvelope = {
      v: RELAY_PROTOCOL_VERSION,
      sid: this.#sid,
      type,
      ...(options.did !== undefined ? { did: options.did } : {}),
      ...(options.rid !== undefined ? { rid: options.rid } : {}),
      n,
      ...(options.frag !== undefined ? { frag: options.frag } : {}),
    };
    const aad = Buffer.from(envelopeAadString(envelope), 'utf8');
    const iv = this.#outboundIv(n);
    const cipher = createCipheriv('aes-256-gcm', this.#outboundKey(), iv);
    cipher.setAAD(aad);
    const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return { ...envelope, ct: Buffer.concat([iv, sealed]).toString('base64url') };
  }

  /**
   * 校验 + 解密 + 重组。分片未齐返回 `{ complete: false }`；协议违规（版本 /
   * 防重放 / 篡改 / 超限）抛 RelayProtocolError，调用方断开连接。
   */
  open(envelope: unknown): OpenedFrame {
    const parsed = relayEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      throw new RelayProtocolError(
        'BAD_FRAME',
        `帧不合法：${parsed.error.issues[0]?.message ?? ''}`,
      );
    }
    const frame = parsed.data;
    if (frame.sid !== this.#sid) {
      throw new RelayProtocolError('BAD_SESSION', '帧的会话 id 与本连接不符');
    }
    if (frame.ct === undefined) {
      throw new RelayProtocolError('BAD_FRAME', '数据帧缺密文');
    }
    if (!this.#replay.accept(frame.n)) {
      throw new RelayProtocolError('REPLAY', `计数器回退 / 重复（n=${frame.n}）`);
    }
    const blob = Buffer.from(frame.ct, 'base64url');
    if (blob.length < IV_BYTES + 16) {
      throw new RelayProtocolError('BAD_FRAME', '密文过短');
    }
    const iv = blob.subarray(0, IV_BYTES);
    const sealed = blob.subarray(IV_BYTES);
    const aad = Buffer.from(
      envelopeAadString({ ...frame, ct: undefined } as RelayEnvelope),
      'utf8',
    );
    let plain: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#inboundKey(), iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      plain = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final(),
      ]);
    } catch {
      throw new RelayProtocolError('AUTH_FAILED', '帧解密 / 校验失败（篡改或密钥不符）');
    }

    if (frame.frag === undefined) {
      return { complete: true, payload: JSON.parse(plain.toString('utf8')) };
    }
    const { mid, i, total } = frame.frag;
    if (i >= total) {
      throw new RelayProtocolError('BAD_FRAME', `分片序号越界（i=${i} total=${total}）`);
    }
    let entry = this.#fragments.get(mid);
    if (entry === undefined) {
      // 并发重组上限：超过先丢最早的一条（对齐手机端；半成品等不到其余分片会
      // 由发送方超时收场，不升级为断连）。
      if (this.#fragments.size >= MAX_PENDING_FRAGMENTS) {
        const oldest = this.#fragments.keys().next().value;
        if (oldest !== undefined) this.#fragments.delete(oldest);
      }
      entry = { total, parts: new Map() };
      this.#fragments.set(mid, entry);
    }
    entry.parts.set(i, plain);
    if (entry.parts.size < total) return { complete: false };
    const ordered = [...Array(total).keys()]
      .map((index) => entry!.parts.get(index))
      .filter((part): part is Buffer => part !== undefined);
    this.#fragments.delete(mid);
    if (ordered.length !== total) return { complete: false };
    const joined = Buffer.concat(ordered);
    if (joined.length > RELAY_MAX_LOGICAL_BYTES) {
      throw new RelayProtocolError('FRAME_TOO_LARGE', '重组后逻辑消息超 8MB 上限');
    }
    return { complete: true, payload: JSON.parse(joined.toString('utf8')) };
  }

  #outboundKey(): Buffer {
    return this.#role === 'anchor' ? this.#keys.anchorToViewer : this.#keys.viewerToAnchor;
  }

  #inboundKey(): Buffer {
    return this.#role === 'anchor' ? this.#keys.viewerToAnchor : this.#keys.anchorToViewer;
  }

  /**
   * 出站 IV = 方向标签 ‖ 64bit 计数器（审查修复）：同密钥下 `n` 唯一 → IV 唯一，
   * 消除随机 IV 的碰撞面（NIST 对同一密钥的 GCM 随机 IV 有 2^32 次约束，而会话
   * 密钥跨重连长期使用）。IV 不进协议（AAD 与对端推导都不含它），两端可各自选型；
   * 手机端 WebFrameCodec 用同一布局便于对照。
   */
  #outboundIv(n: number): Buffer {
    const iv = Buffer.alloc(IV_BYTES);
    iv[0] = this.#role === 'anchor' ? 0xa2 : 0x76;
    iv.writeUInt32BE(Math.floor(n / 2 ** 32), 4);
    iv.writeUInt32BE(n >>> 0, 8);
    return iv;
  }
}

function chunkBuffer(buffer: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, offset + size));
  }
  return chunks;
}

/** 配对 transcript 哈希：规范化拼接（请求帧 → 应答帧），两端一致（§4.4）。 */
export function transcriptHash(parts: readonly string[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(Buffer.from(part, 'utf8')).update(Buffer.from([0]));
  return hash.digest();
}

/** 配对码 HMAC（viewer 请求帧里的 auth 字段；桌面同式验证）。 */
export function pairingAuth(pairingCode: Uint8Array, transcript: Buffer): Buffer {
  return createHmac('sha256', pairingCode).update(transcript).digest();
}
