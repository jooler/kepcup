import { describe, expect, it } from 'vitest';
import {
  APP_RPC_METHODS,
  DEFAULT_RELAY_URL,
  DESKTOP_ONLY_CAPABILITIES,
  PAIRING_TTL_MS,
  RELAY_FRAGMENT_THRESHOLD_BYTES,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_LOGICAL_BYTES,
  RELAY_MAX_VIEWERS,
  RELAY_PROTOCOL_VERSION,
  RELAY_REPLAY_WINDOW,
  endpointCapabilityIdSchema,
  endpointHasCapability,
  pairedDeviceSchema,
  pairingOfferSchema,
  relayEndpointSchema,
  relayEnvelopeSchema,
  relayEventPayloadSchema,
  relayFragmentSchema,
  relayInfoSchema,
  relayPairingPayloadSchema,
  rpcEventSchemas,
  rpcMethodSchemas,
} from '../../src/index.js';
import { conversationSchema, messageSchema, textContentSchema } from '../../src/domain/types.js';
import {
  messagesListInputSchema,
  messagesListOutputSchema,
  projectsCreateInputSchema,
} from '../../src/rpc/methods.js';

/** D96 远程遥控：帧协议、配对契约、方法 / 事件目录与端点能力集。 */

const SID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'; // 合法 ULID
const DID = 'dev-ABCDEFGHIJKLMNOPQRSTUV'; // 16+ URL 安全字符

function envelope(overrides: Partial<Parameters<typeof relayEnvelopeSchema.parse>[0]> = {}) {
  return {
    v: RELAY_PROTOCOL_VERSION,
    sid: SID,
    type: 'rpc' as const,
    n: 0,
    ...overrides,
  };
}

describe('relay endpoint & pairing contracts', () => {
  it('relay endpoint accepts ws/wss only', () => {
    expect(relayEndpointSchema.parse('wss://remote.kepcup.com')).toBe('wss://remote.kepcup.com');
    expect(relayEndpointSchema.parse('ws://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787');
    for (const bad of ['https://remote.kepcup.com', 'remote.kepcup.com', '', 'wss://', 'ftp://x']) {
      expect(relayEndpointSchema.safeParse(bad).success).toBe(false);
    }
    expect(DEFAULT_RELAY_URL).toBe('wss://remote.kepcup.com');
  });

  it('paired device round-trips; bad fingerprints and device ids rejected', () => {
    const device = pairedDeviceSchema.parse({
      deviceId: DID,
      name: '李的 iPhone',
      keyFingerprint: 'a'.repeat(64),
      pskMode: 'x25519',
      createdAt: 1,
      lastSeenAt: null,
      revokedAt: null,
    });
    expect(device.online).toBeUndefined();
    expect(pairedDeviceSchema.parse({ ...device, online: true }).online).toBe(true);
    expect(pairedDeviceSchema.safeParse({ ...device, pskMode: 'ecdh' }).success).toBe(false);
    expect(pairedDeviceSchema.safeParse({ ...device, keyFingerprint: 'zz' }).success).toBe(false);
    expect(pairedDeviceSchema.safeParse({ ...device, deviceId: 'short' }).success).toBe(false);
  });

  it('pairing offer carries the QR url and a 5-minute window', () => {
    const offer = pairingOfferSchema.parse({
      offerId: 'off_1',
      url: 'https://remote.kepcup.com/#pair=d3NzOi8vcmVtb3RlLmtlcGN1cC5jb20sMDFBUlozuG5FQSxkZWJ1Zw',
      sessionId: SID,
      createdAt: 1000,
      expiresAt: 1000 + PAIRING_TTL_MS,
    });
    expect(offer.expiresAt - offer.createdAt).toBe(PAIRING_TTL_MS);
    expect(pairingOfferSchema.safeParse({ ...offer, sessionId: 'not-ulid' }).success).toBe(false);
  });
});

describe('relay frame envelope', () => {
  it('minimal envelope round-trips; version is pinned', () => {
    const frame = relayEnvelopeSchema.parse(envelope({ ct: 'aGVsbG8' }));
    expect(frame.type).toBe('rpc');
    expect(frame.v).toBe(1);
    // 版本不识别即断开（§4.5）：schema 层就不接受。
    expect(relayEnvelopeSchema.safeParse(envelope({ v: 2 as never })).success).toBe(false);
    // sid 必须是 ULID。
    expect(relayEnvelopeSchema.safeParse(envelope({ sid: 'xxx' })).success).toBe(false);
    // 密文与明文控制负载可共存（转发侧互不关心）。
    expect(
      relayEnvelopeSchema.parse(
        envelope({ type: 'kick', info: { kind: 'ratelimit', retryAfterMs: 5 } }),
      ).info,
    ).toEqual({ kind: 'ratelimit', retryAfterMs: 5 });
  });

  it('did is optional and validated when present (routing target / sender)', () => {
    expect(relayEnvelopeSchema.parse(envelope({ did: DID })).did).toBe(DID);
    expect(relayEnvelopeSchema.safeParse(envelope({ did: 'x' })).success).toBe(false);
    // 广播帧不带 did。
    const broadcast = relayEnvelopeSchema.parse(envelope({ type: 'event' }));
    expect(broadcast.did).toBeUndefined();
  });

  it('fragment headers need mid/i/total with total >= 2', () => {
    const frag = { mid: 'mid-12345678', i: 0, total: 3 };
    expect(relayFragmentSchema.parse(frag)).toEqual(frag);
    for (const bad of [
      { mid: 'm', i: 0, total: 3 },
      { mid: 'mid-12345678', i: -1, total: 3 },
      { mid: 'mid-12345678', i: 0, total: 1 },
    ]) {
      expect(relayFragmentSchema.safeParse(bad).success).toBe(false);
    }
    // 512KB 单帧 / 128KB 分片阈值 / 8MB 逻辑上限 / 64 窗口 / 5 viewers 的组合自洽。
    expect(RELAY_MAX_FRAME_BYTES).toBeGreaterThan(RELAY_FRAGMENT_THRESHOLD_BYTES);
    expect(RELAY_MAX_LOGICAL_BYTES).toBeGreaterThan(RELAY_MAX_FRAME_BYTES);
    expect(RELAY_REPLAY_WINDOW).toBe(64);
    expect(RELAY_MAX_VIEWERS).toBe(5);
  });

  it('relay-generated info payloads never carry key material', () => {
    const kinds = relayInfoSchema.options.map((option) => option.shape.kind.value);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'pong',
        'anchor_offline',
        'anchor_online',
        'session_idle',
        'ratelimit',
        'bad_frame',
        'replaced',
      ]),
    );
    // 结构上就不存在 token / 密文字段：全部负载只有 kind + ts/retryAfterMs/message。
    expect(relayInfoSchema.safeParse({ kind: 'pong', ts: 1 }).success).toBe(true);
    expect(relayInfoSchema.safeParse({ kind: 'anchor_offline' }).success).toBe(true);
    // 未知字段被剥离（默认 strip）：密钥 / token 不可能搭车通过 info 负载。
    expect(relayInfoSchema.parse({ kind: 'anchor_offline', token: 'zzz' })).toEqual({
      kind: 'anchor_offline',
    });
  });
});

describe('pairing / event payload plaintext structures', () => {
  it('pairing request → reject → accept → done all validate', () => {
    const request = relayPairingPayloadSchema.parse({
      kind: 'request',
      deviceId: DID,
      deviceName: '李的 iPhone',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      epub: 'cHVia2V5',
      pskMode: 'x25519',
      auth: 'YXV0aA',
    });
    expect(request.kind).toBe('request');
    expect(relayPairingPayloadSchema.parse({ kind: 'reject', reason: 'expired' }).kind).toBe(
      'reject',
    );
    expect(
      relayPairingPayloadSchema.parse({ kind: 'accept', apub: 'YXB1Yg', pskMode: 'x25519' }).kind,
    ).toBe('accept');
    // done 帧（密文内容）带 token 与密钥指纹。
    expect(
      relayPairingPayloadSchema.parse({
        kind: 'done',
        token: 'dG9rZW4',
        keyFingerprint: 'b'.repeat(64),
      }).kind,
    ).toBe('done');
    expect(relayPairingPayloadSchema.safeParse({ kind: 'reject', reason: 'nope' }).success).toBe(
      false,
    );
    // psk 模式：epub / apub 为空串（无 X25519 的回退端），不得被 schema 丢弃。
    expect(
      relayPairingPayloadSchema.parse({
        kind: 'request',
        deviceId: DID,
        deviceName: 'psk 设备',
        userAgent: 'UA',
        epub: '',
        pskMode: 'psk',
        auth: 'YXV0aA',
      }).pskMode,
    ).toBe('psk');
    expect(relayPairingPayloadSchema.parse({ kind: 'accept', apub: '', pskMode: 'psk' }).kind).toBe(
      'accept',
    );
  });

  it('event payload wraps the core event bus push', () => {
    const push = relayEventPayloadSchema.parse({
      name: 'message.created',
      payload: { conversationId: 'conv_1', message: { id: 'msg_1' } },
    });
    expect(push.name).toBe('message.created');
    expect(relayEventPayloadSchema.safeParse({ payload: {} }).success).toBe(false);
  });
});

describe('remote rpc methods & events registry', () => {
  it('all remote.* methods are registered as app methods with zod io', () => {
    const names = [
      'remote.status',
      'remote.createPairing',
      'remote.confirmPairing',
      'remote.revokeDevice',
      'remote.devices',
      'remote.config.get',
      'remote.config.set',
    ];
    for (const name of names) {
      expect(APP_RPC_METHODS).toContain(name);
      expect(rpcMethodSchemas[name as keyof typeof rpcMethodSchemas]).toBeDefined();
    }
    // 端点对等（§1.2）：remote.* 不进 PLATFORM_RPC_METHODS，两端点同目录。
  });

  it('remote events carry anchor state, device changes and pairing requests', () => {
    const anchor = rpcEventSchemas['remote.anchorState'].parse({
      state: 'online',
      onlineDevices: 2,
    });
    expect(anchor.state).toBe('online');
    expect(
      rpcEventSchemas['remote.anchorState'].safeParse({ state: 'sleeping', onlineDevices: 0 })
        .success,
    ).toBe(false);
    const changed = rpcEventSchemas['remote.deviceChanged'].parse({
      change: 'paired',
      device: {
        deviceId: DID,
        name: '李的 iPhone',
        keyFingerprint: 'a'.repeat(64),
        pskMode: 'psk',
        createdAt: 1,
        lastSeenAt: 1,
        revokedAt: null,
      },
    });
    expect(changed.change).toBe('paired');
    const requested = rpcEventSchemas['remote.pairingRequested'].parse({
      requestId: 'req_1',
      deviceId: DID,
      deviceName: '李的 iPhone',
      userAgent: 'UA',
      pskMode: 'x25519',
      requestedAt: 1,
    });
    expect(requested.requestId).toBe('req_1');
  });
});

describe('endpoint capabilities', () => {
  it('desktop has everything; remote lacks exactly the desktop-only set', () => {
    for (const id of endpointCapabilityIdSchema.options) {
      expect(endpointHasCapability('desktop', id)).toBe(true);
      const expected = !DESKTOP_ONLY_CAPABILITIES.includes(id);
      expect(endpointHasCapability('remote', id)).toBe(expected);
    }
    // P0 的关键项：本地文件选择与系统打开在远程端点不可用（§3.2 显示为不可用）。
    expect(endpointHasCapability('remote', 'local-file-dialog')).toBe(false);
    expect(endpointHasCapability('remote', 'open-external')).toBe(false);
    expect(DESKTOP_ONLY_CAPABILITIES).toContain('sandbox-wizard');
  });
});

// --- 62.11 principal seams (team-server T1): additive contract fields ---------

describe('principal seams on shared contracts (62.11 T1)', () => {
  const baseConversation = {
    id: 'conv_1',
    title: null,
    directBotId: null,
    workdirId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 0,
  };
  const baseMessage = {
    id: 'msg_1',
    conversationId: 'conv_1',
    seq: 1,
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: { text: 'hello' },
    replyTo: null,
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 0,
  };

  it('conversation type gains dm with owner / peer principal view fields', () => {
    const dm = conversationSchema.parse({
      ...baseConversation,
      type: 'dm',
      peerPrincipalIds: ['mbr_alice', 'mbr_bob'],
    });
    expect(dm.type).toBe('dm');
    expect(dm.peerPrincipalIds).toEqual(['mbr_alice', 'mbr_bob']);
    expect(dm.ownerPrincipalId).toBeUndefined();
    const direct = conversationSchema.parse({
      ...baseConversation,
      type: 'direct',
      directBotId: 'bot_a',
      ownerPrincipalId: 'mbr_alice',
    });
    expect(direct.ownerPrincipalId).toBe('mbr_alice');
    // Absent on legacy payloads (single-user installs keep their shape).
    const legacy = conversationSchema.parse({ ...baseConversation, type: 'direct' });
    expect(legacy.ownerPrincipalId).toBeUndefined();
    expect(legacy.peerPrincipalIds).toBeUndefined();
  });

  it('messages gain optional sending-principal fields and updatedAt', () => {
    const sent = messageSchema.parse({
      ...baseMessage,
      senderPrincipalId: 'mbr_alice',
      senderName: 'Alice',
      updatedAt: 1_700_000_000_000,
    });
    expect(sent.senderPrincipalId).toBe('mbr_alice');
    expect(sent.senderName).toBe('Alice');
    expect(sent.updatedAt).toBe(1_700_000_000_000);
    // Nullable on rows never touched by the trigger / without a principal.
    const legacy = messageSchema.parse(baseMessage);
    expect(legacy.senderPrincipalId).toBeUndefined();
    expect(legacy.senderName).toBeUndefined();
    expect(legacy.updatedAt).toBeUndefined();
    const nulled = messageSchema.parse({
      ...baseMessage,
      senderPrincipalId: null,
      senderName: null,
      updatedAt: null,
    });
    expect(nulled.senderPrincipalId).toBeNull();
  });

  it('textContent gains origin avatar with the avatar bot name', () => {
    const avatar = textContentSchema.parse({
      text: 'on my way',
      origin: 'avatar',
      avatar: { botName: 'Aster' },
    });
    expect(avatar.origin).toBe('avatar');
    expect(avatar.avatar).toEqual({ botName: 'Aster' });
    // Legacy origins keep parsing; the avatar field is absent by default.
    const voice = textContentSchema.parse({ text: 'hi', origin: 'voice' });
    expect(voice.avatar).toBeUndefined();
    // `avatar` stays optional even for origin='avatar' — the schema is
    // permissive; the team layer enforces the single-run-end rule (T10).
    const bareAvatar = textContentSchema.parse({ text: 'hi', origin: 'avatar' });
    expect(bareAvatar.avatar).toBeUndefined();
    expect(
      textContentSchema.safeParse({ text: 'hi', origin: 'nope', avatar: { botName: 'Aster' } })
        .success,
    ).toBe(false);
  });

  it('messages.list gains afterSeq / changedSince (mutually exclusive) and an optional cursor', () => {
    expect(messagesListInputSchema.parse({ conversationId: 'conv_1' })).toEqual({
      conversationId: 'conv_1',
      limit: 60,
    });
    expect(messagesListInputSchema.parse({ conversationId: 'conv_1', afterSeq: 5 }).afterSeq).toBe(
      5,
    );
    expect(
      messagesListInputSchema.parse({ conversationId: 'conv_1', changedSince: 1_700_000_000_000 })
        .changedSince,
    ).toBe(1_700_000_000_000);
    // beforeSeq alone keeps working (existing pagination).
    expect(messagesListInputSchema.parse({ conversationId: 'conv_1', beforeSeq: 9 }).beforeSeq).toBe(
      9,
    );
    // Any two (or three) of the cursors together are rejected.
    expect(() =>
      messagesListInputSchema.parse({ conversationId: 'conv_1', beforeSeq: 9, afterSeq: 5 }),
    ).toThrow();
    expect(() =>
      messagesListInputSchema.parse({
        conversationId: 'conv_1',
        afterSeq: 5,
        changedSince: 1_700_000_000_000,
      }),
    ).toThrow();
    expect(() =>
      messagesListInputSchema.parse({
        conversationId: 'conv_1',
        beforeSeq: 9,
        afterSeq: 5,
        changedSince: 1_700_000_000_000,
      }),
    ).toThrow();
    // Output: cursor is optional and absent on legacy payloads.
    expect(messagesListOutputSchema.parse({ messages: [] }).cursor).toBeUndefined();
    expect(messagesListOutputSchema.parse({ messages: [], cursor: 1_700_000_000_001 }).cursor).toBe(
      1_700_000_000_001,
    );
  });

  it('projects.create accepts principalIds and relaxes the bot-member floor to 1', () => {
    const withPrincipals = {
      title: '项目组',
      leadBotId: 'bot_a',
      memberBotIds: ['bot_a'],
      principalIds: ['mbr_alice'],
    };
    expect(projectsCreateInputSchema.parse(withPrincipals)).toEqual(withPrincipals);
    // Without principals (or with an empty list) the floor stays 2 bots.
    expect(() =>
      projectsCreateInputSchema.parse({
        title: '项目组',
        leadBotId: 'bot_a',
        memberBotIds: ['bot_a'],
      }),
    ).toThrow();
    expect(() =>
      projectsCreateInputSchema.parse({
        title: '项目组',
        leadBotId: 'bot_a',
        memberBotIds: ['bot_a'],
        principalIds: [],
      }),
    ).toThrow();
    // The lead ∈ members check is unchanged.
    expect(() =>
      projectsCreateInputSchema.parse({
        title: '项目组',
        leadBotId: 'bot_a',
        memberBotIds: ['bot_b'],
        principalIds: ['mbr_alice'],
      }),
    ).toThrow(/负责人必须是项目成员/);
  });
});
