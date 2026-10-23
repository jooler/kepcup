import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  pairingAcceptTranscript,
  pairingRequestTranscript,
  type PairedDevice,
  type RelayEnvelope,
  type RemoteAnchorState,
  type RpcMethodSpec,
} from '@kepcup/shared';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { createEventBus } from '../../src/infra/events.js';
import { SettingsService } from '../../src/domain/settings.js';
import { SecretsService } from '../../src/domain/secrets.js';
import { AuditService } from '../../src/domain/audit.js';
import { RemoteHub, RELAY_IDLE_LINGER_MS, type RelayClientLike } from '../../src/remote/hub.js';
import type { RelayClientOptions } from '../../src/remote/relay-client.js';
import {
  FrameCodec,
  deriveSessionKeys,
  generateEphemeralX25519,
  pairingAuth,
  transcriptHash,
  x25519Shared,
  type SessionKeys,
} from '../../src/remote/codec.js';
import type { CoreEventsMap } from '../../src/start-types.js';

/**
 * D96 §8：Hub 路由（event 广播 vs rpc 定向 vs 合流）与配对状态机（一次性 /
 * 拒绝 / 撤销 / 重连校验）。用假中转客户端（捕获 anchor 出站帧、注入入站帧）
 * + 真 codec 的假 viewer 走完整 E2E 链——手机侧 WebCrypto 按同一契约实现。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'remote-hub-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  child: () => fakeLogger,
} as never;

/** 假中转客户端：不开 WSS，收 anchor 出站帧、按测试指令注入入站帧。 */
class FakeRelayClient implements RelayClientLike {
  static readonly instances: FakeRelayClient[] = [];
  readonly options: RelayClientOptions;
  state: RemoteAnchorState = 'off';

  constructor(options: RelayClientOptions) {
    this.options = options;
    FakeRelayClient.instances.push(this);
  }

  get url(): string {
    return `${this.options.relayUrl.replace(/\/+$/, '')}/ws/${this.options.sessionId}?role=anchor`;
  }

  connect(): void {
    this.state = 'connecting';
    this.options.onStateChange('connecting');
    this.state = 'online';
    this.options.onStateChange('online');
  }

  send(envelope: RelayEnvelope): void {
    if (this.state !== 'online') return;
    this.options.logger.debug({ type: envelope.type }, 'anchor → relay');
    sentFrames.push(envelope);
  }

  sendAll(envelopes: readonly RelayEnvelope[]): void {
    for (const envelope of envelopes) this.send(envelope);
  }

  close(): void {
    this.state = 'off';
    this.options.onStateChange('off');
  }

  reopen(): void {}

  /** 测试：注入一帧 viewer → anchor。 */
  inject(envelope: RelayEnvelope): void {
    this.options.onFrame(envelope);
  }
}

/** anchor → 中转 的全部出站帧（最近一次 makeHub 起）。 */
let sentFrames: RelayEnvelope[] = [];

interface HubRig {
  hub: RemoteHub;
  db: SqliteDatabase;
  audit: AuditService;
  /** 当前 anchor 连接（enableRemote 之后可用）。 */
  readonly relay: FakeRelayClient;
  emit: (name: keyof CoreEventsMap, payload: never) => void;
}

function makeHub(appMethods: Record<string, RpcMethodSpec> = {}): HubRig {
  const home = path.join(dir, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advance: (ms: number) => void (now += ms) };
  const events = createEventBus<CoreEventsMap>();
  const settings = new SettingsService(db, clock);
  const secrets = new SecretsService({
    db,
    masterKey: Buffer.alloc(32, 3),
    clock,
    logger: fakeLogger,
  });
  const audit = new AuditService({ db, clock });
  sentFrames = [];
  FakeRelayClient.instances.length = 0;

  const hub = new RemoteHub({
    db,
    secrets,
    settings,
    events,
    audit,
    clock,
    logger: fakeLogger,
    appMethods: () => appMethods,
    pushInitialEventsTo: (server) => {
      server.pushEvent('core.status', { status: 'ready' });
    },
    relayClientFactory: (options) => new FakeRelayClient(options),
  });
  hub.start();
  return {
    hub,
    db,
    audit,
    // 开关默认关：relay 实例在第一次 enableRemote / syncConfig 时创建。
    get relay() {
      const client = FakeRelayClient.instances[0];
      if (client === undefined) throw new Error('relay not connected yet (enableRemote first)');
      return client;
    },
    emit: (name, payload) => events.emit(name, payload),
  };
}

function enableRemote(rig: HubRig, relayUrl = 'wss://remote.kepcup.com'): void {
  rig.hub.configSet({ enabled: true, relayUrl });
}

/** 假 viewer：按 PWA 契约构造 / 解析帧（真 codec，role=viewer）。 */
class FakeViewer {
  readonly did = 'dev-' + randomBytes(10).toString('hex');
  readonly deviceName = '李的 iPhone';
  readonly viewerPair = generateEphemeralX25519();
  codec: FrameCodec | null = null;
  keys: SessionKeys | null = null;
  token: string | null = null;

  get epub(): string {
    return this.viewerPair.rawPublicKey.toString('base64url');
  }

  requestAuth(code: Buffer): string {
    return pairingAuth(
      code,
      transcriptHash([
        pairingRequestTranscript({
          deviceId: this.did,
          epub: this.epub,
          pskMode: 'x25519',
        }),
      ]),
    ).toString('base64url');
  }

  deriveFromAccept(
    code: Buffer,
    sid: string,
    accept: { apub: string; pskMode: 'x25519' | 'psk' },
  ): void {
    const shared = x25519Shared(this.viewerPair.privateKey, Buffer.from(accept.apub, 'base64url'));
    this.keys = deriveSessionKeys({
      pskMode: accept.pskMode,
      pairingCode: code,
      transcriptHash: transcriptHash([
        pairingRequestTranscript({ deviceId: this.did, epub: this.epub, pskMode: accept.pskMode }),
        pairingAcceptTranscript({ apub: accept.apub, pskMode: accept.pskMode }),
      ]),
      sharedSecret: shared,
    });
    this.codec = new FrameCodec(this.keys, sid, 'viewer');
  }

  seal(type: RelayEnvelope['type'], payload: unknown): RelayEnvelope {
    return this.codec!.seal(type, payload, { did: this.did });
  }

  open(frame: RelayEnvelope): unknown {
    return this.codec!.open(frame).payload;
  }

  /** 走完配对（真 hub），返回设备行。 */
  pairThrough(rig: HubRig): { offer: ReturnType<RemoteHub['createPairing']>; code: Buffer } {
    const offer = rig.hub.createPairing();
    const code = Buffer.from(offer.url.split(',')[2]!, 'base64url');
    rig.relay.inject({
      v: 1,
      sid: offer.sessionId,
      type: 'pairing',
      did: this.did,
      n: 0,
      data: {
        kind: 'request',
        deviceId: this.did,
        deviceName: this.deviceName,
        userAgent: 'Mozilla/5.0 (iPhone)',
        epub: this.epub,
        pskMode: 'x25519',
        auth: this.requestAuth(code),
      },
    });
    const pending = rig.hub.status().pendingPairing[0]!;
    rig.hub.confirmPairing(pending.requestId, true);
    const accept = sentFrames
      .map((frame) => frame.data)
      .find((data) => (data as { kind?: string } | undefined)?.kind === 'accept') as {
      apub: string;
      pskMode: 'x25519' | 'psk';
    };
    this.deriveFromAccept(code, offer.sessionId, accept);
    const doneFrame = sentFrames.find(
      (frame) => frame.type === 'pairing' && frame.ct !== undefined,
    )!;
    const done = this.open(doneFrame) as { token: string; keyFingerprint: string };
    this.token = done.token;
    return { offer, code };
  }

  helloThrough(rig: HubRig): void {
    rig.relay.inject(this.seal('hello', { token: this.token, ts: 1 })[0]!);
  }
}

describe('remote hub: config & status', () => {
  it('disabled by default: no connection; enable alone stays idle (on-demand relay)', () => {
    // 按需连接（运营成本，2026-10 修订）：开关只是权限门槛，不再一开就常驻连接
    //（原实现 24/7 与中转空转）。出配对码（连接手机开窗）才算「有用」。
    const rig = makeHub();
    expect(rig.hub.status()).toMatchObject({ enabled: false, anchor: 'off', sessionId: null });
    expect(FakeRelayClient.instances).toHaveLength(0);

    enableRemote(rig);
    const status = rig.hub.status();
    expect(status.enabled).toBe(true);
    expect(status.anchor).toBe('idle');
    expect(status.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(FakeRelayClient.instances).toHaveLength(0);

    const offer = rig.hub.createPairing();
    expect(rig.hub.status().anchor).toBe('online');
    expect(rig.relay.url).toBe(`wss://remote.kepcup.com/ws/${offer.sessionId}?role=anchor`);
  });

  it('按需连接：配对确认后进驻留窗；无设备跟进则窗口结束断开', async () => {
    vi.useFakeTimers();
    try {
      const rig = makeHub();
      enableRemote(rig);
      const viewer = new FakeViewer();
      viewer.pairThrough(rig);
      expect(rig.relay.state).toBe('online');
      // confirm 后码已消耗、hello 未到：驻留窗覆盖 done → hello 自举间隙，
      // 到点仍无设备上线即断开（不无限续期）。
      await vi.advanceTimersByTimeAsync(RELAY_IDLE_LINGER_MS + 1_000);
      expect(rig.hub.status().anchor).toBe('idle');
      expect(rig.relay.state).toBe('off');
    } finally {
      vi.useRealTimers();
    }
  });

  it('按需连接：设备离开后驻留窗内保持连接，窗口结束断开', async () => {
    vi.useFakeTimers();
    try {
      const rig = makeHub();
      enableRemote(rig);
      const viewer = new FakeViewer();
      viewer.pairThrough(rig);
      viewer.helloThrough(rig);
      expect(rig.hub.status().onlineDeviceIds).toEqual([viewer.did]);
      rig.relay.inject({
        v: 1,
        sid: rig.hub.status().sessionId!,
        type: 'signal',
        n: 0,
        info: { kind: 'viewer_left', did: viewer.did },
      });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(rig.hub.status().onlineDeviceIds).toEqual([]); // viewer_left 宽限过完
      expect(rig.relay.state).toBe('online'); // 驻留窗内连接仍在（PWA 刷新能直接回来）
      await vi.advanceTimersByTimeAsync(RELAY_IDLE_LINGER_MS);
      expect(rig.hub.status().anchor).toBe('idle');
      expect(rig.relay.state).toBe('off');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sessionId is stable across config resyncs (persisted in secrets)', () => {
    const rig = makeHub();
    enableRemote(rig);
    const first = rig.hub.status().sessionId;
    void rig.hub.syncConfig();
    expect(rig.hub.status().sessionId).toBe(first);
  });

  it('disabling drops the relay connection and every endpoint', () => {
    const rig = makeHub();
    enableRemote(rig);
    rig.hub.configSet({ enabled: false });
    expect(rig.hub.status()).toMatchObject({ enabled: false, anchor: 'off' });
  });
});

describe('remote hub: pairing state machine', () => {
  it('full pairing round-trip: request → confirm → accept + sealed done with token', () => {
    const rig = makeHub();
    enableRemote(rig);
    const viewer = new FakeViewer();
    const { offer } = viewer.pairThrough(rig);

    expect(offer.url).toContain('#pair=');
    expect(offer.url).toContain(offer.sessionId);
    const device = rig.hub.devices().devices[0]!;
    expect(device).toMatchObject({
      deviceId: viewer.did,
      name: viewer.deviceName,
      pskMode: 'x25519',
      revokedAt: null,
      online: false,
    });
    expect(device.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // 密钥材料落 secrets（不落 remote_devices 表）。
    const secretRow = rig.db
      .prepare('select name from secrets where name = ?')
      .get(`remote:${viewer.did}`);
    expect(secretRow).toBeDefined();
    // 配对码一次性：offer 消耗后同一码的新请求被拒。
    const replay = new FakeViewer();
    replay.did = viewer.did;
    rig.relay.inject({
      v: 1,
      sid: offer.sessionId,
      type: 'pairing',
      did: viewer.did,
      n: 1,
      data: {
        kind: 'request',
        deviceId: viewer.did,
        deviceName: 'another',
        userAgent: 'UA',
        epub: viewer.epub,
        pskMode: 'x25519',
        auth: viewer.requestAuth(Buffer.from(offer.url.split(',')[2]!, 'base64url')),
      },
    });
    expect(rig.hub.status().pendingPairing).toHaveLength(0);
  });

  it('bad pairing-code HMAC → rejected with bad_code, no pending entry', () => {
    const rig = makeHub();
    enableRemote(rig);
    const offer = rig.hub.createPairing();
    const viewer = new FakeViewer();
    rig.relay.inject({
      v: 1,
      sid: offer.sessionId,
      type: 'pairing',
      did: viewer.did,
      n: 0,
      data: {
        kind: 'request',
        deviceId: viewer.did,
        deviceName: viewer.deviceName,
        userAgent: 'UA',
        epub: viewer.epub,
        pskMode: 'x25519',
        auth: viewer.requestAuth(randomBytes(16)),
      },
    });
    expect(rig.hub.status().pendingPairing).toHaveLength(0);
    const reject = sentFrames.find(
      (frame) => (frame.data as { kind?: string } | undefined)?.kind === 'reject',
    );
    expect(reject?.data).toMatchObject({ kind: 'reject', reason: 'bad_code' });
  });

  it('同设备重复请求替换旧 pending（手机端保活重发不重复出卡）', () => {
    // 真机回归钉（2026-10）：手机端等待确认期间每 5s 重发 pairing.request（自愈
    // 中转丢帧），桌面侧必须同设备去重——确认卡永远只出一张，且确认走标准路径。
    const rig = makeHub();
    enableRemote(rig);
    const viewer = new FakeViewer();
    const offer = rig.hub.createPairing();
    const code = Buffer.from(offer.url.split(',')[2]!, 'base64url');
    const injectRequest = (): void =>
      rig.relay.inject({
        v: 1,
        sid: offer.sessionId,
        type: 'pairing',
        did: viewer.did,
        n: 0,
        data: {
          kind: 'request',
          deviceId: viewer.did,
          deviceName: viewer.deviceName,
          userAgent: 'Mozilla/5.0 (iPhone)',
          epub: viewer.epub,
          pskMode: 'x25519',
          auth: viewer.requestAuth(code),
        },
      });
    injectRequest();
    injectRequest();
    injectRequest();
    expect(rig.hub.status().pendingPairing).toHaveLength(1);
    rig.hub.confirmPairing(rig.hub.status().pendingPairing[0]!.requestId, true);
    expect(rig.hub.devices().devices[0]).toMatchObject({ deviceId: viewer.did });
  });

  it('decline → reject frame; unknown request id → gone', () => {
    const rig = makeHub();
    enableRemote(rig);
    const viewer = new FakeViewer();
    const { offer } = viewer.pairThrough(rig);
    // pairThrough 已消耗 offer；再出一张码走拒绝路径。
    void offer;
    const second = new FakeViewer();
    const offer2 = rig.hub.createPairing();
    const code = Buffer.from(offer2.url.split(',')[2]!, 'base64url');
    rig.relay.inject({
      v: 1,
      sid: offer2.sessionId,
      type: 'pairing',
      did: second.did,
      n: 0,
      data: {
        kind: 'request',
        deviceId: second.did,
        deviceName: second.deviceName,
        userAgent: 'UA',
        epub: second.epub,
        pskMode: 'x25519',
        auth: second.requestAuth(code),
      },
    });
    const requestId = rig.hub.status().pendingPairing[0]!.requestId;
    expect(rig.hub.confirmPairing(requestId, false).status).toBe('declined');
    const reject = sentFrames
      .map((frame) => frame.data)
      .find((data) => (data as { kind?: string } | undefined)?.kind === 'reject') as {
      reason: string;
    };
    expect(reject.reason).toBe('declined');
    expect(rig.hub.confirmPairing('req_nonexistent', true).status).toBe('gone');
  });
});

describe('remote hub: reconnect & routing', () => {
  function makeRigWithEcho(): { rig: HubRig; viewer: FakeViewer } {
    const rig = makeHub({
      'test.echo': {
        input: z.any(),
        output: z.any(),
        handle: async (input) => ({ pong: true, input }),
      } as unknown as RpcMethodSpec,
    });
    enableRemote(rig);
    const viewer = new FakeViewer();
    viewer.pairThrough(rig);
    return { rig, viewer };
  }

  it('hello with valid token brings the device online (deviceChanged event)', () => {
    const { rig, viewer } = makeRigWithEcho();
    const seen: string[] = [];
    // 事件经由 hub 扇出总线；online 事件在内部 emit，这里用 status 断言 + 事件探针。
    viewer.helloThrough(rig);
    expect(rig.hub.status().onlineDeviceIds).toEqual([viewer.did]);
    expect(rig.hub.devices().devices[0]).toMatchObject({ deviceId: viewer.did, online: true });
    void seen;
  });

  it('hello 建立端点时推送 core.status 快照（手机 App 启动门槛依赖它）', () => {
    // 真机回归钉（2026-10 用户实测）：手机配对成功后永远停在「核心服务启动中」——
    // App 等 core.status 事件才开始加载，而扇出只在状态「变化」时发生，core 早已
    // ready 的情况下远程端点永远等不到首帧。本地通道绑定时推快照（pushStatusTo），
    // 远程端点必须同款契约。
    const { rig, viewer } = makeRigWithEcho();
    // 真手机 done 落地即重建 codec（入站窗口从零开，ws-transport #onPairingDone）；
    // fixture 不同步重建的话，endpoint 的 n=0 首帧会被 done 的旧窗口判成重放。
    viewer.codec = new FrameCodec(viewer.keys!, rig.hub.status().sessionId!, 'viewer');
    viewer.helloThrough(rig);
    const pushed = sentFrames
      .filter((frame) => frame.type === 'rpc')
      .map((frame) => viewer.open(frame) as { m?: string; a?: unknown[] })
      .find((payload) => payload.m === 'core.status');
    expect(pushed?.a?.[0]).toEqual({ status: 'ready' });
  });

  it('hello from an unknown device is ignored (no endpoint, no leak)', () => {
    const { rig, viewer } = makeRigWithEcho();
    const rogue = new FakeViewer();
    rogue.codec = viewer.codec;
    // rogue 的 did 没有设备行：无从解密，忽略。
    rig.relay.inject({
      ...rogue.seal('hello', { token: 'x', ts: 1 })[0]!,
      did: rogue.did,
    });
    expect(rig.hub.status().onlineDeviceIds).toEqual([]);
  });

  it('reconnect with continued counters re-boots the endpoint (counters adopted)', async () => {
    const { rig, viewer } = makeRigWithEcho();
    viewer.helloThrough(rig);
    expect(rig.hub.status().onlineDeviceIds).toEqual([viewer.did]);
    // 先跑一轮 rpc：anchor 出站计数 +1（响应 n=0），viewer 入站窗口 highest=0。
    let before = sentFrames.length;
    rig.relay.inject(viewer.seal('rpc', { t: 'q', m: 'test.echo', a: [0], i: 'r0' })[0]!);
    await vi.waitFor(() => expect(sentFrames.length).toBeGreaterThan(before));
    // viewer 页面刷新：新 codec + 出站计数续号（真 viewer 的 restoreOutbound 语义）。
    const fresh = new FrameCodec(viewer.keys!, rig.hub.status().sessionId!, 'viewer');
    fresh.restoreOutbound(viewer.codec!.outboundCounter);
    rig.relay.inject(fresh.seal('hello', { token: viewer.token, ts: 2 }, { did: viewer.did })[0]!);
    // 续号的 hello 不被旧窗口判成 REPLAY：端点重建后照常在线。
    expect(rig.hub.status().onlineDeviceIds).toEqual([viewer.did]);
    // 重建后 RPC 仍可用，且 anchor 出站计数被移植（续号不归零）——响应能被刷新前
    // 的旧 viewer codec 解开（审查修复 P0 的回归钉：归零实现下这条会 REPLAY）。
    before = sentFrames.length;
    rig.relay.inject(
      fresh.seal('rpc', { t: 'q', m: 'test.echo', a: [1], i: 'r1' }, { did: viewer.did })[0]!,
    );
    await vi.waitFor(() => expect(sentFrames.length).toBeGreaterThan(before));
    const echo = sentFrames.find((frame) => frame.type === 'rpc' && frame.rid === 'r1')!;
    expect(viewer.open(echo).r).toMatchObject({ pong: true, input: 1 });
  });

  it('a replayed captured hello is rejected by the adopted window (no re-bootstrap)', async () => {
    const { rig, viewer } = makeRigWithEcho();
    const hello = viewer.seal('hello', { token: viewer.token, ts: 1 })[0]!;
    rig.relay.inject(hello);
    expect(rig.hub.status().onlineDeviceIds).toEqual([viewer.did]);
    // 中转重放同一条捕获的 hello（同 n）：被移植后的入站窗口判 REPLAY，静默忽略
    //（审查修复 P1：原实现重建端点会清空窗口，同一条 hello 可无限重放）。
    rig.relay.inject(hello);
    rig.relay.inject(hello);
    expect(rig.hub.status().onlineDeviceIds).toEqual([viewer.did]);
    // 端点未被重置打断：后续 rpc（计数继续）照常可用。
    const before = sentFrames.length;
    rig.relay.inject(viewer.seal('rpc', { t: 'q', m: 'test.echo', a: [2], i: 'r2' })[0]!);
    await vi.waitFor(() => expect(sentFrames.length).toBeGreaterThan(before));
    const echo = sentFrames.find((frame) => frame.type === 'rpc' && frame.rid === 'r2')!;
    expect(viewer.open(echo).r).toMatchObject({ pong: true, input: 2 });
  });

  it('rpc round-trip: directed response carries did + rid', async () => {
    const { rig, viewer } = makeRigWithEcho();
    viewer.helloThrough(rig);
    const before = sentFrames.length;
    // birpc v4 线格式：请求 {t:'q', m, a:[input], i}；响应 {t:'s', i, r}。
    rig.relay.inject(
      viewer.seal('rpc', { t: 'q', m: 'test.echo', a: [{ hello: '桌面' }], i: 'req7' })[0]!,
    );
    await vi.waitFor(() => {
      expect(sentFrames.length).toBeGreaterThan(before);
    });
    const response = sentFrames.slice(before).find((frame) => frame.type === 'rpc');
    expect(response?.did).toBe(viewer.did);
    expect(response?.rid).toBe('req7');
    const payload = viewer.open(response!) as { t: string; i: string; r?: unknown };
    expect(payload.t).toBe('s');
    expect(payload.i).toBe('req7');
    expect(payload.r).toMatchObject({ pong: true, input: { hello: '桌面' } });
  });

  it('plain events broadcast; run.progress coalesced to ≤10Hz keeping the latest', async () => {
    vi.useFakeTimers();
    try {
      const { rig, viewer } = makeRigWithEcho();
      viewer.helloThrough(rig);
      const before = sentFrames.length;
      rig.emit('message.created', { conversationId: 'conv_1', message: { id: 'm1' } } as never);
      expect(
        sentFrames.slice(before).some((frame) => frame.type === 'event' && frame.ct !== undefined),
      ).toBe(true);

      const progressFrom = sentFrames.length;
      for (let i = 0; i < 20; i++) {
        rig.emit('run.progress', {
          runId: 'run_1',
          conversationId: 'c',
          text: `第${i}步`,
        } as never);
      }
      expect(sentFrames.length).toBe(progressFrom); // 合流窗口内不外发
      await vi.advanceTimersByTimeAsync(120);
      const frames = sentFrames.slice(progressFrom).filter((frame) => frame.type === 'event');
      expect(frames).toHaveLength(1);
      const opened = viewer.open(frames[0]!) as { name: string; payload: { text: string } };
      expect(opened.name).toBe('run.progress');
      expect(opened.payload.text).toBe('第19步');
    } finally {
      vi.useRealTimers();
    }
  });

  it('viewer_left signal drops the endpoint after grace; inbound frame cancels it', async () => {
    vi.useFakeTimers();
    try {
      // (a) 宽限期内到点的 viewer_left：清端点，设备回到离线
      const { rig, viewer } = makeRigWithEcho();
      viewer.helloThrough(rig);
      expect(rig.hub.status().onlineDeviceIds).toEqual([viewer.did]);
      rig.relay.inject({
        v: 1,
        sid: rig.hub.status().sessionId!,
        type: 'signal',
        n: 0,
        info: { kind: 'viewer_left', did: viewer.did },
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(rig.hub.status().onlineDeviceIds).toEqual([viewer.did]); // 宽限内还在线
      await vi.advanceTimersByTimeAsync(2_000);
      expect(rig.hub.status().onlineDeviceIds).toEqual([]); // 宽限过完，端点已清
      expect(rig.hub.devices().devices[0]).toMatchObject({ deviceId: viewer.did, online: false });

      // (b) 宽限期内该 did 来了新帧（重连竞态）：取消清理
      const { rig: rig2, viewer: viewer2 } = makeRigWithEcho();
      viewer2.helloThrough(rig2);
      rig2.relay.inject({
        v: 1,
        sid: rig2.hub.status().sessionId!,
        type: 'signal',
        n: 0,
        info: { kind: 'viewer_left', did: viewer2.did },
      });
      // 迟到的旧 socket close 之后，同 did 的 hello（新连接）先到——计数续号
      //（真 viewer 的重连语义，见上方 adopted 用例）。
      const fresh = new FrameCodec(viewer2.keys!, rig2.hub.status().sessionId!, 'viewer');
      fresh.restoreOutbound(viewer2.codec!.outboundCounter);
      rig2.relay.inject(
        fresh.seal('hello', { token: viewer2.token, ts: 2 }, { did: viewer2.did })[0]!,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rig2.hub.status().onlineDeviceIds).toEqual([viewer2.did]); // 未被误杀
    } finally {
      vi.useRealTimers();
    }
  });

  it('revoke kicks the endpoint and clears token hash + key; reconnect refused', () => {
    const { rig, viewer } = makeRigWithEcho();
    viewer.helloThrough(rig);
    const device: PairedDevice = rig.hub.revokeDevice(viewer.did);
    expect(device.revokedAt).not.toBeNull();
    expect(rig.hub.status().onlineDeviceIds).toEqual([]);
    expect(sentFrames.some((frame) => frame.type === 'kick' && frame.did === viewer.did)).toBe(
      true,
    );
    const row = rig.db.prepare('select token_hash, revoked_at from remote_devices').get() as {
      token_hash: string | null;
      revoked_at: number | null;
    };
    expect(row.token_hash).toBeNull();
    expect(row.revoked_at).not.toBeNull();
    // 撤销后 hello：密钥已删，无从解密 → 端点不上线。
    viewer.helloThrough(rig);
    expect(rig.hub.status().onlineDeviceIds).toEqual([]);
  });

  it('remote-originated audit rows carry source remote:{deviceId}', async () => {
    let rigRef: HubRig | null = null;
    const rig = makeHub({
      'test.audited': {
        input: z.void(),
        output: z.any(),
        // 远程端点触发一个写审计的方法：经 withRemoteSource 包装后，
        // AuditService.record 的 detail 自动带 source（§5.3）。
        handle: async () => {
          rigRef!.audit.record(
            { runId: 'run_test', botId: null, conversationId: null, loopType: 'task' },
            'test.remote_action',
            { detail: 'x' },
          );
          return { ok: true };
        },
      } as unknown as RpcMethodSpec,
    });
    rigRef = rig;
    enableRemote(rig);
    const viewer = new FakeViewer();
    viewer.pairThrough(rig);
    viewer.helloThrough(rig);
    rig.relay.inject(viewer.seal('rpc', { t: 'q', m: 'test.audited', a: [], i: 'req3' })[0]!);
    await vi.waitFor(() => {
      const row = rig.db
        .prepare("select detail_json from audit_log where action = 'test.remote_action'")
        .get() as { detail_json: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.detail_json)).toMatchObject({ source: `remote:${viewer.did}` });
    });
  });
});
