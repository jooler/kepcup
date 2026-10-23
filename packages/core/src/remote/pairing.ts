import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AppError,
  PAIRING_CODE_BYTES,
  PAIRING_TTL_MS,
  REMOTE_TOKEN_BYTES,
  newUlid,
  pairingAcceptTranscript,
  pairingRequestTranscript,
  relayPairingPayloadSchema,
  type PairedDevice,
  type PairingOffer,
  type PendingPairingRequest,
  type RelayEnvelope,
  type RelayPairingPayload,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { EventBus } from '../infra/events.js';
import type { CoreEventsMap } from '../start-types.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { AuditService } from '../domain/audit.js';
import type { SecretsService } from '../domain/secrets.js';
import {
  FrameCodec,
  deriveSessionKeys,
  generateEphemeralX25519,
  pairingAuth,
  parseSessionKeys,
  serializeSessionKeys,
  sessionKeyFingerprint,
  transcriptHash,
  x25519Shared,
  type SessionKeys,
} from './codec.js';

/**
 * 配对管理（D96 §4.4）：配对码生命周期（16B、5 分钟、一次性、仅内存）、确认
 * 流程（ECDH 握手在 `confirmPairing` 内完成）、设备登记 / 撤销、token 哈希校验。
 * 密钥材料入 secrets 表 `remote:{deviceId}`；会话 id（不透明 ULID）同样落 secrets
 * `remote:session`（非机密，但桌面重启后遥控端凭它重连，必须稳定）。
 */

interface DeviceRow {
  device_id: string;
  name: string;
  key_fingerprint: string;
  psk_mode: 'x25519' | 'psk';
  token_hash: string | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

function rowToDevice(row: DeviceRow): PairedDevice {
  return {
    deviceId: row.device_id,
    name: row.name,
    keyFingerprint: row.key_fingerprint,
    pskMode: row.psk_mode,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

/** 配对确认（或拒绝）后需要发回发起端的帧：明文协商帧 + 密文完成帧。 */
export interface PairingOutcomeFrames {
  deviceId: string;
  plaintext: RelayEnvelope[];
  sealed: RelayEnvelope[];
}

/** 一次待确认的配对请求（内存态；过期由 confirmPairing 拒为 gone）。 */
interface PendingRequest extends PendingPairingRequest {
  /** viewer 请求帧里的临时公钥（base64url）。 */
  epub: string;
}

/**
 * PWA 配对 URL（§3.1）：`<origin>/#pair=<relayUrl>,<sessionId>,<pairingSecret>`，
 * origin 从中转地址推导（wss→https / ws→http，同一 Worker 托管静态资产）。
 */
export function pairingQrUrl(relayUrl: string, sessionId: string, secret: string): string {
  const parsed = new URL(relayUrl);
  const origin = `${parsed.protocol === 'wss:' ? 'https' : 'http'}://${parsed.host}`;
  return `${origin}/#pair=${encodeURIComponent(relayUrl)},${sessionId},${secret}`;
}

export class PairingService {
  readonly #db: SqliteDatabase;
  readonly #secrets: SecretsService;
  readonly #clock: Clock;
  readonly #logger: CoreLogger;
  readonly #events: EventBus<CoreEventsMap>;
  readonly #audit: AuditService;
  /** 当前 offer（一次一张；重复 createPairing 作废上一张）。仅内存。 */
  #offer: {
    offerId: string;
    sessionId: string;
    /** 16B 配对码原始字节（不外发，只在二维码与 HMAC 里出现）。 */
    code: Buffer;
    relayUrl: string;
    createdAt: number;
    expiresAt: number;
    /** 成功配对一次即作废（一次性）。 */
    consumed: boolean;
  } | null = null;
  readonly #pending = new Map<string, PendingRequest>();

  constructor(deps: {
    db: SqliteDatabase;
    secrets: SecretsService;
    clock: Clock;
    logger: CoreLogger;
    events: EventBus<CoreEventsMap>;
    audit: AuditService;
  }) {
    this.#db = deps.db;
    this.#secrets = deps.secrets;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#events = deps.events;
    this.#audit = deps.audit;
  }

  /** 桌面会话 id：secrets `remote:session`，缺则生成（一次生成、永久稳定）。 */
  sessionUlid(): string {
    const existing = this.#secrets.getValue('remote:session');
    if (existing !== null && existing.length > 0) return existing;
    const sessionId = newUlid();
    this.#secrets.setValue('remote:session', sessionId);
    return sessionId;
  }

  /** `remote.createPairing`：生成一次性配对码与二维码内容（5 分钟有效）。 */
  createOffer(relayUrl: string): PairingOffer {
    const now = this.#clock.now();
    const sessionId = this.sessionUlid();
    const offer = {
      offerId: newUlid(),
      sessionId,
      code: randomBytes(PAIRING_CODE_BYTES),
      relayUrl,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      consumed: false,
    };
    this.#offer = offer;
    this.#pending.clear();
    return {
      offerId: offer.offerId,
      url: pairingQrUrl(relayUrl, sessionId, offer.code.toString('base64url')),
      sessionId,
      createdAt: offer.createdAt,
      expiresAt: offer.expiresAt,
    };
  }

  currentOffer(): PairingOffer | null {
    const offer = this.#offer;
    if (offer === null) return null;
    return {
      offerId: offer.offerId,
      url: pairingQrUrl(offer.relayUrl, offer.sessionId, offer.code.toString('base64url')),
      sessionId: offer.sessionId,
      createdAt: offer.createdAt,
      expiresAt: offer.expiresAt,
    };
  }

  /** 按需连接用：是否存在未消费、未过期的配对码窗口（手机随时可能扫码进场）。 */
  hasActiveOffer(): boolean {
    const offer = this.#offer;
    return offer !== null && !offer.consumed && this.#clock.now() <= offer.expiresAt;
  }

  /**
   * viewer 的 pairing.request 到达：验配对码 HMAC → 挂起待确认 + 发
   * `remote.pairingRequested` 事件（桌面确认卡）。返回要立刻回给 viewer 的帧
   *（验码失败时为 reject 帧）。
   */
  handleRequest(
    envelope: RelayEnvelope,
    payload: RelayPairingPayload,
  ): { requestId?: string; frames: PairingOutcomeFrames[] } {
    if (!('kind' in payload) || payload.kind !== 'request') {
      return { frames: [] };
    }
    const reject = (reason: 'expired' | 'bad_code' | 'busy'): PairingOutcomeFrames => ({
      deviceId: payload.deviceId,
      plaintext: [
        this.#plainFrame('pairing', { kind: 'reject', reason }, envelope.sid, payload.deviceId),
      ],
      sealed: [],
    });
    const offer = this.#offer;
    const now = this.#clock.now();
    if (offer === null || offer.consumed || now > offer.expiresAt) {
      return { frames: [reject('expired')] };
    }
    const requestPart = pairingRequestTranscript({
      deviceId: payload.deviceId,
      epub: payload.epub,
      pskMode: payload.pskMode,
    });
    const expected = pairingAuth(offer.code, transcriptHash([requestPart]));
    // 常数时间比较（审查修复）：配对码的安全余量不该依赖字符串比较的短路行为。
    const provided = Buffer.from(payload.auth, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      // 附带 offer 上下文：坏码几乎总来自「上一张 offer 的码」（每次开窗换码，
      // 复制的旧链接 / 旧二维码即作废）。码本身不落日志（一次性但仍是 bearer secret）。
      this.#logger.warn(
        { did: payload.deviceId, offerAgeMs: now - offer.createdAt, consumed: offer.consumed },
        'remote pairing: bad code HMAC',
      );
      return { frames: [reject('bad_code')] };
    }
    const requestId = newUlid();
    // 同设备重复请求（手机端 5s 保活重发）：替换旧 pending，确认卡只出一张。
    for (const [existingId, existing] of this.#pending) {
      if (existing.deviceId === payload.deviceId) this.#pending.delete(existingId);
    }
    this.#pending.set(requestId, {
      requestId,
      deviceId: payload.deviceId,
      deviceName: payload.deviceName,
      userAgent: payload.userAgent,
      pskMode: payload.pskMode,
      requestedAt: now,
      epub: payload.epub,
    });
    this.#events.emit('remote.pairingRequested', {
      requestId,
      deviceId: payload.deviceId,
      deviceName: payload.deviceName,
      userAgent: payload.userAgent,
      pskMode: payload.pskMode,
      requestedAt: now,
    });
    return { requestId, frames: [] };
  }

  /**
   * e2e 测试缝（仅 `__KEPCUP_TEST_HOOKS__` 装配，打包产物 DCE 掉）：模拟手机
   * 发来 pairing.request——用当前 offer 的配对码算出正确的 PSK HMAC，走真实的
   * `handleRequest` 路径（挂起待确认 + 发事件）。epub 缺省生成一把真 X25519
   * 公钥，让 `confirmPairing` 的 ECDH 也能真实跑通。
   */
  testInjectPairingRequest(args: {
    deviceId: string;
    deviceName: string;
    userAgent: string;
    pskMode?: 'x25519' | 'psk';
  }): { requestId: string } {
    const offer = this.#offer;
    if (offer === null) throw new AppError('INVALID_STATE', '还没有配对 offer（先 createPairing）');
    const pskMode = args.pskMode ?? 'x25519';
    const epub =
      pskMode === 'x25519' ? generateEphemeralX25519().rawPublicKey.toString('base64url') : '';
    const envelope: RelayEnvelope = {
      v: 1,
      sid: offer.sessionId,
      type: 'pairing',
      did: args.deviceId,
      n: 0,
    };
    const outcome = this.handleRequest(envelope, {
      kind: 'request',
      deviceId: args.deviceId,
      deviceName: args.deviceName,
      userAgent: args.userAgent,
      epub,
      pskMode,
      auth: pairingAuth(
        offer.code,
        transcriptHash([pairingRequestTranscript({ deviceId: args.deviceId, epub, pskMode })]),
      ).toString('base64url'),
    });
    const requestId = outcome.requestId;
    if (requestId === undefined)
      throw new AppError('INVALID_STATE', '注入配对请求被拒（offer 过期或已消耗）');
    return { requestId };
  }

  /**
   * `remote.confirmPairing`：拒绝 → reject 帧；允许 → anchor 临时密钥对 +
   * ECDH + HKDF 派生会话密钥、登记设备、下发 token（done 帧用新密钥加密）。
   */
  confirm(
    requestId: string,
    accept: boolean,
  ): {
    status: 'paired' | 'declined' | 'gone';
    device?: PairedDevice;
    frames: PairingOutcomeFrames[];
  } {
    const request = this.#pending.get(requestId);
    if (request === undefined || this.#clock.now() > request.requestedAt + PAIRING_TTL_MS) {
      this.#pending.delete(requestId);
      return { status: 'gone', frames: [] };
    }
    this.#pending.delete(requestId);
    if (!accept) {
      return {
        status: 'declined',
        frames: [
          {
            deviceId: request.deviceId,
            plaintext: [
              this.#plainFrame(
                'pairing',
                { kind: 'reject', reason: 'declined' },
                this.sessionUlid(),
                request.deviceId,
              ),
            ],
            sealed: [],
          },
        ],
      };
    }

    const offer = this.#offer;
    if (offer === null) return { status: 'gone', frames: [] };
    const sessionId = offer.sessionId;
    const pskMode = request.pskMode;
    // 入口校验（审查修复）：非法 epub 抛干净的 AppError 给确认方，而不是让
    // x25519Shared 抛 Node 裸错误。
    if (pskMode === 'x25519' && Buffer.from(request.epub, 'base64url').length !== 32) {
      throw new AppError('INVALID_INPUT', '配对请求的临时公钥不合法');
    }
    const anchorPair = pskMode === 'x25519' ? generateEphemeralX25519() : null;
    const apub = anchorPair !== null ? anchorPair.rawPublicKey.toString('base64url') : '';
    const acceptPart = pairingAcceptTranscript({ apub, pskMode });
    const requestPart = pairingRequestTranscript({
      deviceId: request.deviceId,
      epub: request.epub,
      pskMode,
    });
    const transcript = [requestPart, acceptPart];
    const shared =
      anchorPair !== null
        ? x25519Shared(anchorPair.privateKey, Buffer.from(request.epub, 'base64url'))
        : null;
    const keys = deriveSessionKeys({
      pskMode,
      pairingCode: offer.code,
      transcriptHash: transcriptHash(transcript),
      sharedSecret: shared,
    });
    const fingerprint = sessionKeyFingerprint(keys);
    const token = randomBytes(REMOTE_TOKEN_BYTES);
    const tokenHash = sha256Hex(token);
    const now = this.#clock.now();

    this.#secrets.setValue(`remote:${request.deviceId}`, serializeSessionKeys(keys));
    this.#db
      .prepare(
        `insert into remote_devices (device_id, name, key_fingerprint, psk_mode, token_hash, created_at, last_seen_at, revoked_at)
         values (?, ?, ?, ?, ?, ?, ?, null)
         on conflict(device_id) do update set
           name = excluded.name,
           key_fingerprint = excluded.key_fingerprint,
           psk_mode = excluded.psk_mode,
           token_hash = excluded.token_hash,
           last_seen_at = excluded.last_seen_at,
           revoked_at = null`,
      )
      .run(request.deviceId, request.deviceName, fingerprint, pskMode, tokenHash, now, now);
    // 一次性配对码：成功配对即作废（含旧 offer 的全部 pending）。
    offer.consumed = true;
    this.#pending.clear();

    const device: PairedDevice = {
      deviceId: request.deviceId,
      name: request.deviceName,
      keyFingerprint: fingerprint,
      pskMode,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
      online: true,
    };
    this.#events.emit('remote.deviceChanged', {
      change: 'paired',
      device: { ...device, online: undefined },
    });
    this.#audit.recordSystem('remote.device_paired', {
      deviceId: request.deviceId,
      name: request.deviceName,
      pskMode,
    });

    const codec = new FrameCodec(keys, sessionId, 'anchor');
    const sealedFrames = codec.seal(
      'pairing',
      {
        kind: 'done',
        token: token.toString('base64url'),
        keyFingerprint: fingerprint,
      },
      { did: request.deviceId },
    );
    return {
      status: 'paired',
      device,
      frames: [
        {
          deviceId: request.deviceId,
          plaintext: [
            this.#plainFrame(
              'pairing',
              { kind: 'accept', apub, pskMode },
              sessionId,
              request.deviceId,
            ),
          ],
          sealed: sealedFrames,
        },
      ],
    };
  }

  /**
   * 重连校验（hello 帧解密成功后）：token 哈希比对 + 未撤销。通过则刷新
   * lastSeen 并返回设备行；失败返回原因（hub 发 kick 后断开）。
   */
  verifyReconnect(
    deviceId: string,
    token: string,
  ): { ok: true; device: PairedDevice } | { ok: false; reason: 'auth_failed' | 'revoked' } {
    const row = this.#deviceRow(deviceId);
    if (row === null) return { ok: false, reason: 'auth_failed' };
    if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
    if (row.token_hash === null || !tokenHashMatches(token, row.token_hash)) {
      return { ok: false, reason: 'auth_failed' };
    }
    const now = this.#clock.now();
    this.#db
      .prepare('update remote_devices set last_seen_at = ? where device_id = ?')
      .run(now, deviceId);
    return { ok: true, device: rowToDevice({ ...row, last_seen_at: now }) };
  }

  /** 设备会话密钥（secrets `remote:{deviceId}`）；撤销 / 不存在返回 null。 */
  deviceKeys(deviceId: string): SessionKeys | null {
    const row = this.#deviceRow(deviceId);
    if (row === null || row.revoked_at !== null) return null;
    const stored = this.#secrets.getValue(`remote:${deviceId}`);
    if (stored === null) return null;
    try {
      return parseSessionKeys(stored);
    } catch {
      return null;
    }
  }

  /** 撤销：作废行（保留审计）、删密钥与 token 哈希；kick 由 hub 发。 */
  revoke(deviceId: string): PairedDevice {
    const row = this.#deviceRow(deviceId);
    if (row === null) throw new AppError('NOT_FOUND', '设备不存在');
    const now = this.#clock.now();
    this.#db
      .prepare('update remote_devices set revoked_at = ?, token_hash = null where device_id = ?')
      .run(now, deviceId);
    this.#secrets.removeValue(`remote:${deviceId}`);
    this.#pending.clear();
    const device: PairedDevice = { ...rowToDevice(row), revokedAt: now };
    this.#events.emit('remote.deviceChanged', { change: 'revoked', device });
    this.#audit.recordSystem('remote.device_revoked', { deviceId, name: row.name });
    return device;
  }

  listDevices(online: (deviceId: string) => boolean): PairedDevice[] {
    const rows = this.#db
      .prepare(
        'select * from remote_devices order by revoked_at is not null, last_seen_at is null, last_seen_at desc',
      )
      .all() as unknown as DeviceRow[];
    return rows.map((row) => ({ ...rowToDevice(row), online: online(row.device_id) }));
  }

  /** `remote.status` 的待确认列表（过期未清的由 confirm 判 gone）。 */
  pendingRequests(): PendingPairingRequest[] {
    const now = this.#clock.now();
    return [...this.#pending.values()]
      .filter((request) => now <= request.requestedAt + PAIRING_TTL_MS)
      .map(({ epub: _epub, ...view }) => view);
  }

  /** 设备行视图（hub 的 offline 事件用）；不存在返回 null。 */
  deviceView(deviceId: string): PairedDevice | null {
    const row = this.#deviceRow(deviceId);
    return row === null ? null : rowToDevice(row);
  }

  #deviceRow(deviceId: string): DeviceRow | null {
    return (
      (this.#db.prepare('select * from remote_devices where device_id = ?').get(deviceId) as
        DeviceRow | undefined) ?? null
    );
  }

  #plainFrame(
    type: 'pairing',
    payload: Extract<RelayPairingPayload, { kind: 'reject' | 'accept' }>,
    sid: string,
    did: string,
  ): RelayEnvelope {
    relayPairingPayloadSchema.parse(payload);
    // 配对协商帧：明文负载走 envelope.data（密钥建立前无密可加密；负载只有
    // 公钥与拒绝原因，配对码只以 HMAC 形态出现）。
    return { v: 1, sid, type, did, n: 0, data: payload };
  }
}

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** token 哈希比对（常数时间；审查修复：原为十六进制字符串等值比较）。 */
function tokenHashMatches(token: string, storedHex: string): boolean {
  const provided = Buffer.from(sha256Hex(Buffer.from(token, 'base64url')), 'hex');
  const stored = Buffer.from(storedHex, 'hex');
  return provided.length === stored.length && timingSafeEqual(provided, stored);
}
