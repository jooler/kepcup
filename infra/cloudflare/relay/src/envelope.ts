/**
 * 中转侧的 envelope 视图(设计 46 §4.5):自包含、不 import @kepcup/shared——
 * 与 infra/cloudflare/registry 的自包含取向一致,Worker 可独立构建 / 类型检查。
 *
 * ⚠️ 本文件的常量 / 帧类型 / info kinds 是 packages/shared/src/domain/remote.ts
 * 同名契约的**手工副本**,两边必须保持同步:test/envelope-sync.test.ts 逐项断言,
 * 漂移会先红测试。中转只读明文路由头(v / sid / type / did / n),不理解密文;
 * rid / frag / ct 原样透传,不解析、不校验。DO 自产帧的负载走 `info` 明文字段,
 * `n` 恒 0,永不携带密钥或 token(设计 §7)。
 */

// --- 协议常量(与 shared 的 RELAY_* 一致)----------------------------------------

/** 帧协议版本;`v` 不识别即断开连接,不做静默降级(设计 §4.5)。 */
export const RELAY_PROTOCOL_VERSION = 1;

/** 会话 id:不透明 ULID(48bit 时间戳 + 80bit 随机段,随机部分不可猜),DO 按
 * idFromName(sid) 天然隔离多用户。 */
export const RELAY_SESSION_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 端点设备 id:viewer 首个带 did 的帧注册进路由表(anchor 定向帧用它寻址)。 */
export const REMOTE_DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** 单帧(envelope 序列化后)上限;超过由 DO 拒绝并断开(§4.3 滥用防护)。 */
export const RELAY_MAX_FRAME_BYTES = 512 * 1024;

/** 每会话 viewer 上限(§4.3);anchor 恒 ≤1。 */
export const RELAY_MAX_VIEWERS = 5;

/** anchor 断开后 DO 保活时长;到期 signal session_idle 并关闭全部(§4.3 生命周期)。 */
export const RELAY_ANCHOR_TTL_MS = 10 * 60 * 1000;

/** DO 内每连接令牌桶:持续速率(msg/s)与突发额度(§4.3)。 */
export const RELAY_RATE_SUSTAINED_PER_SEC = 30;
export const RELAY_RATE_BURST = 60;

// --- 帧类型与 info 负载 ------------------------------------------------------------

/** 帧类型全集(与 shared relayFrameTypeSchema 的 enum 一致)。 */
export const RELAY_FRAME_TYPES = [
  'pairing',
  'hello',
  'rpc',
  'event',
  'kick',
  'ping',
  'pong',
  'error',
  'signal',
] as const;
export type RelayFrameType = (typeof RELAY_FRAME_TYPES)[number];

/**
 * DO 自产帧会用的 envelope type(是 RELAY_FRAME_TYPES 的子集):
 * pong ← info.pong;signal ← anchor_offline / anchor_online / session_idle / replaced;
 * kick ← ratelimit;error ← bad_frame。搭配关系见 shared relayInfoSchema 的注释。
 */
export type RelayServerFrameType = Extract<RelayFrameType, 'pong' | 'signal' | 'kick' | 'error'>;

/** DO 自产控制负载(明文;与 shared relayInfoSchema 的 discriminatedUnion 一致,永不含密钥)。 */
export type RelayInfo =
  | { kind: 'pong'; ts: number }
  | { kind: 'anchor_offline' }
  | { kind: 'anchor_online' }
  | { kind: 'session_idle' }
  | { kind: 'ratelimit'; retryAfterMs: number }
  | { kind: 'bad_frame'; message: string }
  | { kind: 'replaced' }
  | { kind: 'viewer_left'; did: string };

/** info.kind 全集(envelope-sync 测试据此与 shared 对齐)。 */
export const RELAY_INFO_KINDS = [
  'pong',
  'anchor_offline',
  'anchor_online',
  'session_idle',
  'ratelimit',
  'bad_frame',
  'replaced',
  'viewer_left',
] as const;
export type RelayInfoKind = (typeof RELAY_INFO_KINDS)[number];

/** 中转需要读的 envelope 字段(明文路由头);其余字段(ct/rid/frag/info)原样透传。 */
export interface RelayEnvelopeView {
  v: number;
  sid: string;
  type: RelayFrameType;
  did?: string;
  n: number;
}

export type EnvelopeParseResult =
  | { ok: true; frame: RelayEnvelopeView }
  | { ok: false; reason: 'unparseable' | 'bad_version' | 'bad_shape'; message: string };

/**
 * 解析并校验 envelope 的路由头。只做中转转发所需的最小检查:
 * JSON 对象、`v` 必须等于当前协议版本(不识别即断开)、sid / did / n 的形状。
 * sid 是否匹配本会话由 RelaySessionLogic 比对(它知道自己的 sid)。
 */
export function parseEnvelope(raw: string): EnvelopeParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'unparseable', message: 'frame is not valid JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'bad_shape', message: 'frame must be a JSON object' };
  }
  const frame = value as Record<string, unknown>;
  // 版本协商(§4.5):v 不识别即断开连接并报错,不做静默降级
  if (frame.v !== RELAY_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: 'bad_version',
      message: `unsupported protocol version ${String(frame.v)} (expected ${RELAY_PROTOCOL_VERSION})`,
    };
  }
  if (typeof frame.sid !== 'string' || !RELAY_SESSION_ID_PATTERN.test(frame.sid)) {
    return { ok: false, reason: 'bad_shape', message: 'invalid sid' };
  }
  if (
    typeof frame.type !== 'string' ||
    !(RELAY_FRAME_TYPES as readonly string[]).includes(frame.type)
  ) {
    return { ok: false, reason: 'bad_shape', message: `unknown frame type ${String(frame.type)}` };
  }
  if (frame.did !== undefined) {
    if (typeof frame.did !== 'string' || !REMOTE_DEVICE_ID_PATTERN.test(frame.did)) {
      return { ok: false, reason: 'bad_shape', message: 'invalid did' };
    }
  }
  if (typeof frame.n !== 'number' || !Number.isInteger(frame.n) || frame.n < 0) {
    return { ok: false, reason: 'bad_shape', message: 'invalid counter n' };
  }
  return {
    ok: true,
    frame: {
      v: RELAY_PROTOCOL_VERSION,
      sid: frame.sid,
      type: frame.type as RelayFrameType,
      ...(frame.did === undefined ? {} : { did: frame.did }),
      n: frame.n,
    },
  };
}

/** 构造 DO 自产帧(pong / signal / 服务端 kick / error):info 明文负载,`n` 恒 0。 */
export function buildInfoFrame(sid: string, type: RelayServerFrameType, info: RelayInfo): string {
  return JSON.stringify({ v: RELAY_PROTOCOL_VERSION, sid, type, n: 0, info });
}

/** 模块级复用(审查修复:原先每帧 new 一次 TextEncoder)。 */
const textEncoder = new TextEncoder();

/** 字符串的 UTF-8 字节数(单帧上限按字节计,不是按字符计)。 */
export function utf8Bytes(text: string): number {
  return textEncoder.encode(text).length;
}
