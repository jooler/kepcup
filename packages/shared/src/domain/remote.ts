import { z } from 'zod';

/**
 * 远程遥控（D96，docs/design/46-remote-control.md §4.4–§4.5、§5.1）。
 *
 * 契约分四段，两端（桌面 core 与手机 PWA）共用：
 *  1. 配置与设备行：中转地址、已配对设备、配对 offer、anchor 状态机。
 *  2. 帧协议：envelope（明文路由头，中转可见）+ 各类型 payload 的明文结构
 *     （E2E 密文解开后）。加解密本身在 core `remote/codec.ts` 与手机端
 *     WebCrypto 各自实现，本文件只定形状。
 *  3. 协议常量：分片阈值、防重放窗口、限速参数——中转（DO）与两端引用同一份，
 *     测试据此断言。
 *  4. 端点能力：desktop-only 项标记（renderer 据此裁剪 UI，见 host-capabilities.ts）。
 *
 * 硬约束（设计 §4.3）：中转只看 envelope，不触碰密文内容；它自产的帧
 * （pong / anchor_offline / 限流拒绝）走 envelope.info 明文负载，永不携带密钥。
 */

// --- 协议常量（§4.5 / §4.3）---------------------------------------------------

/** 帧协议版本；`v` 不识别即断开连接，不做静默降级。 */
export const RELAY_PROTOCOL_VERSION = 1;

/** 会话 id：不透明 ULID（48bit 时间戳 + 80bit 随机段，随机部分不可猜），DO 按它天然隔离多用户。 */
export const RELAY_SESSION_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 端点设备 id：配对时由手机生成并登记（`did`），审计里记 `remote:{did}`。 */
export const REMOTE_DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** 单帧（envelope + 密文）上限；超过由 DO 拒绝（§4.3 滥用防护）。 */
export const RELAY_MAX_FRAME_BYTES = 512 * 1024;

/** 逻辑消息超过该字节数即按 `frag` 分片（§4.5）。 */
export const RELAY_FRAGMENT_THRESHOLD_BYTES = 128 * 1024;

/** 单条逻辑消息（全部分片重组后）上限（§4.5）。 */
export const RELAY_MAX_LOGICAL_BYTES = 8 * 1024 * 1024;

/** 防重放滑动窗口大小：每方向单调计数器 `n`，回退 / 重复即拒（§4.5）。 */
export const RELAY_REPLAY_WINDOW = 64;

/** 每会话 viewer 上限（§4.3）；anchor 恒 ≤1。 */
export const RELAY_MAX_VIEWERS = 5;

/** anchor 断开后 DO 保活时长；全空即逐出（§4.3 生命周期）。 */
export const RELAY_ANCHOR_TTL_MS = 10 * 60 * 1000;

/** DO 内每连接令牌桶：持续速率（msg/s）与突发额度（§4.3）。 */
export const RELAY_RATE_SUSTAINED_PER_SEC = 30;
export const RELAY_RATE_BURST = 60;

/** 配对码：16 字节随机，一次性、仅桌面内存（§4.4）。 */
export const PAIRING_CODE_BYTES = 16;
/** 配对码有效期（5 分钟）。 */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/** 重连 token：随机 32B，桌面只存哈希（§4.4）。 */
export const REMOTE_TOKEN_BYTES = 32;

/** anchor 应用层心跳间隔（30s，维持 DO hibernation 活性）。 */
export const RELAY_HEARTBEAT_MS = 30 * 1000;

/** 默认公共中转（设计 §1.7；设置里可改、可自建替代）。 */
export const DEFAULT_RELAY_URL = 'wss://remote.kepcup.com';

// --- 基础形状 -----------------------------------------------------------------

const sessionIdSchema = z.string().regex(RELAY_SESSION_ID_PATTERN);
export const remoteDeviceIdSchema = z.string().regex(REMOTE_DEVICE_ID_PATTERN);
export type RemoteDeviceId = z.infer<typeof remoteDeviceIdSchema>;

/** base64url（无填充）：密文、公钥、token、HMAC 的线上编码。 */
const b64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** sha256 hex：密钥指纹 / token 哈希。 */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * 中转地址配置（设置项）。只接受 ws/wss（本地联调 `ws://127.0.0.1:8787` 与
 * 线上 `wss://…` 同形），PWA 静态资产由 Worker 同源托管。
 */
export const relayEndpointSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'wss:' || url.protocol === 'ws:') && url.hostname.length > 0;
    } catch {
      return false;
    }
  }, '中转地址必须是 ws:// 或 wss:// URL');
export type RelayEndpoint = z.infer<typeof relayEndpointSchema>;

/**
 * 密钥派生模式（§4.4）：`x25519` = X25519 ECDH + HKDF（PFS）；
 * `psk` = WebCrypto 无 X25519 的端回退 HKDF(配对码) 直派（无 PFS，安全降级，
 * 握手帧标记、设备行留痕）。
 */
export const pairingKeyModeSchema = z.enum(['x25519', 'psk']);
export type PairingKeyMode = z.infer<typeof pairingKeyModeSchema>;

/**
 * 已配对设备行（main.db `remote_devices`；密钥材料不入本表——入 secrets 表
 * `remote:{deviceId}`）。`online` / `pskMode` 为视图富化字段，DB 不存。
 */
export const pairedDeviceSchema = z.object({
  deviceId: remoteDeviceIdSchema,
  /** 手机侧上报、用户可编辑的设备名（如「李的 iPhone」）。 */
  name: z.string().min(1).max(60),
  /** 会话密钥指纹（sha256 hex），设备管理展示用。 */
  keyFingerprint: sha256HexSchema,
  pskMode: pairingKeyModeSchema,
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
  revokedAt: z.number().int().nonnegative().nullable(),
  /** 视图富化：当前是否在线（`remote.devices` 输出）。 */
  online: z.boolean().optional(),
});
export type PairedDevice = z.infer<typeof pairedDeviceSchema>;

/**
 * anchor（桌面 ↔ 中转 1:1 外连）连接状态机（§5.1）。`idle` = 开关已开但按需连接
 * 策略下当前不连中转（无未过期配对码、无设备在线、也不在驻留窗内）——原实现
 * 开关一开就常驻连接（24/7 空转），现只在「有用」时连接以降低中转驻留成本。
 */
export const remoteAnchorStateSchema = z.enum(['off', 'idle', 'connecting', 'online', 'error']);
export type RemoteAnchorState = z.infer<typeof remoteAnchorStateSchema>;

/**
 * 配对 offer（`remote.createPairing` 产物）：`url` 即二维码内容
 * （`https://…/#pair=<relayUrl>,<sessionId>,<pairingSecret>`，URL 安全
 * base64，设计 §3.1）。配对码只存在于桌面内存，随二维码带出（QR 视为带外信道）。
 */
export const pairingOfferSchema = z.object({
  offerId: z.string().min(1),
  /** 二维码内容：扫码打开 PWA 并自动进入配对确认。 */
  url: z.string().min(1),
  sessionId: sessionIdSchema,
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type PairingOffer = z.infer<typeof pairingOfferSchema>;

/**
 * 等待桌面确认的配对请求（pairing 帧到达后挂起，用户点「允许 / 拒绝」前可查）。
 */
export const pendingPairingRequestSchema = z.object({
  requestId: z.string().min(1),
  deviceId: remoteDeviceIdSchema,
  deviceName: z.string().min(1).max(60),
  /** 手机浏览器 / 型号摘要（确认卡展示）。 */
  userAgent: z.string().max(500),
  pskMode: pairingKeyModeSchema,
  requestedAt: z.number().int().nonnegative(),
});
export type PendingPairingRequest = z.infer<typeof pendingPairingRequestSchema>;

// --- 帧协议（§4.5）-------------------------------------------------------------
//
// envelope 是唯一明文：中转按 `type` 执行转发策略（带 did 的 event 定向 / 无 did
// 广播（协议保留）/ rpc 定向 / 控制帧点对点），不理解内容。数据帧 payload 一律
// AES-256-GCM 密文（`ct`，密钥按方向区分，AAD = envelope 去密文）；中转自产的
// 控制负载走 `info` 明文，永不含密钥。`ping` 为空 payload 帧。

export const relayFrameTypeSchema = z.enum([
  /** 配对协商（密钥建立前 PSK 认证的明文负载；`done` 帧转密文）。viewer → anchor。 */
  'pairing',
  /** 重连自举（密文：token + 密钥持有证明）。viewer → anchor。 */
  'hello',
  /** RPC 帧（密文）：请求 viewer → anchor；响应 anchor → 目标 viewer（带 did）。 */
  'rpc',
  /** 事件扇出（密文，WP6 修订：按端点各封一帧、带目标 did 定向；DO 侧无 did 才广播）。 */
  'event',
  /** 踢除（anchor 发可密文；DO 限流踢为 info 明文）。定向。 */
  'kick',
  /** 应用层心跳，空 payload。任一方向。 */
  'ping',
  /** DO 对 ping 的回执（自产，info.ts）。 */
  'pong',
  /** 错误（anchor 发或 DO 自产）。定向。 */
  'error',
  /** DO 自产会话信号（anchor_offline / anchor_online / session_idle…）。广播。 */
  'signal',
]);
export type RelayFrameType = z.infer<typeof relayFrameTypeSchema>;

/** 分片头：逻辑消息 > 128KB 时按 `frag` 切开，端侧重组（§4.5）。 */
export const relayFragmentSchema = z.object({
  /** 逻辑消息 id（同消息各分片一致，发送方随机）。 */
  mid: z.string().min(8).max(64),
  /** 分片序号，0 起。 */
  i: z.number().int().nonnegative(),
  /** 总分片数（≥2；每个分片都带，便于早失败）。 */
  total: z.number().int().min(2).max(512),
});
export type RelayFragment = z.infer<typeof relayFragmentSchema>;

/** 中转自产的控制负载（明文；与 E2E 密文无关，永不含密钥 / token）。 */
export const relayInfoSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pong'), ts: z.number() }),
  /** anchor 断开：viewers 收到后显示离线态，等待桌面重连。 */
  z.object({ kind: z.literal('anchor_offline') }),
  /** anchor 重连成功（TTL 内）：viewers 可重新自举。 */
  z.object({ kind: z.literal('anchor_online') }),
  /** DO 保活 TTL 到期、会话逐出。 */
  z.object({ kind: z.literal('session_idle') }),
  /** 令牌桶超限，连接被关。 */
  z.object({ kind: z.literal('ratelimit'), retryAfterMs: z.number().int().nonnegative() }),
  /** 帧不合法（超限 / 无法解析 / 版本不识别）→ 断开连接。 */
  z.object({ kind: z.literal('bad_frame'), message: z.string().max(300) }),
  /** 同 did 新连接顶掉旧连接。 */
  z.object({ kind: z.literal('replaced') }),
  /**
   * viewer 断开（DO → anchor 定向，WP6 联调加固）：桌面据此清端点，设备列表 /
   * 托盘的在线状态不再虚高。带 5s 宽限期语义由 anchor 侧实现（旧 socket 迟到的
   * close 不能误杀已重连的新端点）。
   */
  z.object({ kind: z.literal('viewer_left'), did: remoteDeviceIdSchema }),
]);
export type RelayInfo = z.infer<typeof relayInfoSchema>;

/**
 * envelope（明文路由头，最小化）。`did` 语义按方向区分：viewer → anchor 帧
 * 带发送方 did；anchor 定向帧（rpc 响应 / kick / error / pairing 应答）带目标
 * did；event 帧同样带目标 did（E2E 按设备加密，一帧密文只能服务一个端点，WP6
 * 联调修订：DO 侧对带 did 的 event 走定向、无 did 才广播）。DO 自产帧
 * （pong / signal）不带 did，viewer_left 例外（带 did 指明谁离开）。`n` 为本方向单调计数器
 *（密文帧防重放用；明文帧与 DO 自产帧恒 0）。AAD = envelope 序列化后去掉
 * `ct`。`data` 仅用于配对协商帧（request / reject / accept：密钥建立前无密可
 * 加密，负载本身只有公钥与 PSK HMAC，不含任何机密）；密钥建立后的 `done` 帧
 * 起一律走 `ct`。
 */
export const relayEnvelopeSchema = z.object({
  v: z.literal(RELAY_PROTOCOL_VERSION),
  sid: sessionIdSchema,
  type: relayFrameTypeSchema,
  did: remoteDeviceIdSchema.optional(),
  /** birpc 请求 id（rpc 帧透传，`t:'q'` 的 `i`；中转不读，仅关联观测）。 */
  rid: z.string().min(1).max(64).optional(),
  n: z.number().int().nonnegative(),
  frag: relayFragmentSchema.optional(),
  /** E2E 密文（base64url：iv ‖ ciphertext ‖ tag）。 */
  ct: b64UrlSchema.optional(),
  /** 配对协商帧的明文负载（relayPairingPayloadSchema 的 request/reject/accept）。 */
  data: z.unknown().optional(),
  /** 中转自产控制负载（仅 pong / signal / 服务端 kick / error 帧）。 */
  info: relayInfoSchema.optional(),
});
export type RelayEnvelope = z.infer<typeof relayEnvelopeSchema>;

// --- payload 明文结构（E2E 密文解开后 / 配对协商明文负载）-----------------------

/**
 * pairing 帧负载（配对协商，§4.4 时序）。`request` / `reject` / `accept` 为
 * 明文负载（密钥尚未建立，PSK HMAC 认证）；`done` 用新派生密钥加密（token
 * 绝不出现在明文里）。transcript = 双方已交换的 pairing 帧（envelope 去密文
 * + 负载）的规范化拼接，HMAC(配对码, transcript-hash) 防拼接重放。
 */
export const relayPairingPayloadSchema = z.discriminatedUnion('kind', [
  /** 手机 → 桌面：配对请求。 */
  z.object({
    kind: z.literal('request'),
    deviceId: remoteDeviceIdSchema,
    deviceName: z.string().min(1).max(60),
    userAgent: z.string().max(500),
    /** X25519 临时公钥（32B）；`psk` 模式为**空串**（b64 允许空，见下）。 */
    epub: z.string().regex(/^[A-Za-z0-9_-]{0,64}$/),
    pskMode: pairingKeyModeSchema,
    /** HMAC-SHA256(配对码, sha256(transcript))。 */
    auth: b64UrlSchema.max(64),
  }),
  /** 桌面 → 手机：拒绝（过期 / 用户拒绝 / 配对码错 / 忙）。 */
  z.object({
    kind: z.literal('reject'),
    reason: z.enum(['expired', 'declined', 'bad_code', 'busy', 'error']),
    message: z.string().max(300).optional(),
  }),
  /** 桌面 → 手机：用户允许，桌面临时公钥；双方各自 ECDH + HKDF 派生会话密钥。 */
  z.object({
    kind: z.literal('accept'),
    /** X25519 临时公钥（32B）；`psk` 模式为**空串**（b64 允许空，见下）。 */
    apub: z.string().regex(/^[A-Za-z0-9_-]{0,64}$/),
    pskMode: pairingKeyModeSchema,
  }),
  /** 桌面 → 手机（密文，新会话密钥）：完成，下发重连 token。 */
  z.object({
    kind: z.literal('done'),
    /** 重连凭证（32B base64url；桌面只存哈希）。 */
    token: b64UrlSchema,
    /** 会话密钥指纹（设备管理展示）。 */
    keyFingerprint: sha256HexSchema,
  }),
]);
export type RelayPairingPayload = z.infer<typeof relayPairingPayloadSchema>;

/**
 * hello 帧负载（密文）：重连自举。AEAD 解密成功 + 防重放窗口内即证明持有
 * 会话密钥；`token` 与桌面存的哈希比对防冒用（§4.4「重连凭证」）。
 */
export const relayHelloPayloadSchema = z.object({
  token: b64UrlSchema,
  /** 客户端时间戳（诊断用；新鲜性由计数器 `n` 保证）。 */
  ts: z.number(),
});
export type RelayHelloPayload = z.infer<typeof relayHelloPayloadSchema>;

/** rpc 帧负载：birpc 消息原样透传（codec 不解析，由两端 RPC 层处理）。 */
export const relayRpcPayloadSchema = z.unknown();

/** event 帧负载：core 事件总线的一条推送（name → rpc/events.ts 的目录）。 */
export const relayEventPayloadSchema = z.object({
  name: z.string().min(1),
  payload: z.unknown(),
});
export type RelayEventPayload = z.infer<typeof relayEventPayloadSchema>;

/** kick 帧负载（密文，anchor → 目标 viewer；DO 限流踢走 info.ratelimit）。 */
export const relayKickPayloadSchema = z.object({
  reason: z.enum(['revoked', 'anchor_shutdown', 'replaced', 'auth_failed']),
});
export type RelayKickPayload = z.infer<typeof relayKickPayloadSchema>;

/** error 帧负载（anchor 侧密文；DO 侧走 info.bad_frame）。 */
export const relayErrorPayloadSchema = z.object({
  code: z.string().min(1).max(60),
  message: z.string().max(500),
});
export type RelayErrorPayload = z.infer<typeof relayErrorPayloadSchema>;

/**
 * 配对 transcript 的规范化部件（§4.4）：两端按同一字符串算 HMAC / HKDF 输入。
 * 数组 JSON 逐字节稳定（键名无关），不要改成对象（键序会漂）。
 */
export function pairingRequestTranscript(request: {
  deviceId: string;
  epub: string;
  pskMode: PairingKeyMode;
}): string {
  return JSON.stringify(['pairing-request', request.deviceId, request.epub, request.pskMode]);
}

export function pairingAcceptTranscript(accept: { apub: string; pskMode: PairingKeyMode }): string {
  return JSON.stringify(['pairing-accept', accept.apub, accept.pskMode]);
}

/** AAD 规范化序列化（§4.5「AAD = envelope 去密文」）：envelope 去掉 `ct` 后按键名
 * ASCII 升序的稳定 JSON.stringify（嵌套对象同样排序，数组保序）。Node 与浏览器的
 * JSON.stringify 行为一致，两端共用本函数即可保证 AAD 逐字节相同——不要在各自
 * 实现里手搓序列化。
 */
export function envelopeAadString(envelope: RelayEnvelope): string {
  return JSON.stringify(stableValue(omitCiphertext(envelope)));
}

function omitCiphertext(value: Record<string, unknown>): Record<string, unknown> {
  const { ct: _ct, ...rest } = value;
  return rest;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, v] of entries) out[key] = stableValue(v);
    return out;
  }
  return value;
}
