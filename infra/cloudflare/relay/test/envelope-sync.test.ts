/**
 * 守护 relay 侧自包含契约(src/envelope.ts)与 packages/shared 的帧协议不漂移:
 * relay 不 import @kepcup/shared(Worker 独立构建),因此两边的一致性只能靠测试钉住。
 * 根 vitest 已配 @kepcup/shared → packages/shared/src/index.ts 的 alias。
 */

import { describe, expect, it } from 'vitest';
import {
  RELAY_ANCHOR_TTL_MS,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_VIEWERS,
  RELAY_PROTOCOL_VERSION,
  RELAY_RATE_BURST,
  RELAY_RATE_SUSTAINED_PER_SEC,
  RELAY_SESSION_ID_PATTERN,
  REMOTE_DEVICE_ID_PATTERN,
  relayEnvelopeSchema,
  relayFrameTypeSchema,
  relayInfoSchema,
} from '@kepcup/shared';
import {
  RELAY_ANCHOR_TTL_MS as RELAY_TTL,
  RELAY_MAX_FRAME_BYTES as RELAY_FRAME_LIMIT,
  RELAY_MAX_VIEWERS as RELAY_VIEWERS,
  RELAY_PROTOCOL_VERSION as RELAY_VERSION,
  RELAY_RATE_BURST as RELAY_BURST,
  RELAY_RATE_SUSTAINED_PER_SEC as RELAY_SUSTAINED,
  RELAY_SESSION_ID_PATTERN as RELAY_SID,
  RELAY_FRAME_TYPES,
  RELAY_INFO_KINDS,
  REMOTE_DEVICE_ID_PATTERN as RELAY_DID,
  buildInfoFrame,
  type RelayInfo,
  type RelayServerFrameType,
} from '../src/envelope';

// 与 shared 的 RELAY_SESSION_ID_PATTERN 同形的合法 ULID(buildInfoFrame 样本用)
const SID = '01JSCE8XFN2QRSTVWXYZKHJ4M9';

describe('relay 侧契约与 @kepcup/shared 一致', () => {
  it('协议常量逐项相等', () => {
    expect(RELAY_VERSION).toBe(RELAY_PROTOCOL_VERSION);
    expect(RELAY_SID.source).toBe(RELAY_SESSION_ID_PATTERN.source);
    expect(RELAY_DID.source).toBe(REMOTE_DEVICE_ID_PATTERN.source);
    expect(RELAY_FRAME_LIMIT).toBe(RELAY_MAX_FRAME_BYTES);
    expect(RELAY_VIEWERS).toBe(RELAY_MAX_VIEWERS);
    expect(RELAY_TTL).toBe(RELAY_ANCHOR_TTL_MS);
    expect(RELAY_SUSTAINED).toBe(RELAY_RATE_SUSTAINED_PER_SEC);
    expect(RELAY_BURST).toBe(RELAY_RATE_BURST);
  });

  it('帧类型目录与 relayFrameTypeSchema 一致', () => {
    expect([...RELAY_FRAME_TYPES].sort()).toEqual([...relayFrameTypeSchema.options].sort());
  });

  it('info kind 目录与 relayInfoSchema 一致', () => {
    const kinds = relayInfoSchema.options.map((member) => member.shape.kind.value);
    expect([...RELAY_INFO_KINDS].sort()).toEqual([...kinds].sort());
  });

  it('DO 自产帧能被 shared 的 relayEnvelopeSchema 解析(n 恒 0,info 明文)', () => {
    const samples: Array<[RelayServerFrameType, RelayInfo]> = [
      ['pong', { kind: 'pong', ts: 1_761_234_567_890 }],
      ['signal', { kind: 'anchor_offline' }],
      ['signal', { kind: 'anchor_online' }],
      ['signal', { kind: 'session_idle' }],
      ['signal', { kind: 'replaced' }],
      ['signal', { kind: 'viewer_left', did: 'device-aaaaaaaaaaaaaaaa' }],
      ['kick', { kind: 'ratelimit', retryAfterMs: 34 }],
      ['error', { kind: 'bad_frame', message: 'x'.repeat(300) }],
    ];
    for (const [type, info] of samples) {
      const raw = JSON.parse(buildInfoFrame(SID, type, info));
      const parsed = relayEnvelopeSchema.safeParse(raw);
      expect(parsed.success, `${type}/${info.kind}`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.n).toBe(0);
        expect(parsed.data.type).toBe(type);
        expect(parsed.data.info).toEqual(info);
      }
    }
  });

  it('sid 形状样本与两端 pattern 都吻合(测试自身的 ULID 不是拼错的)', () => {
    expect(RELAY_SESSION_ID_PATTERN.test(SID)).toBe(true);
    expect(RELAY_SID.test(SID)).toBe(true);
  });
});
