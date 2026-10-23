import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  RELAY_HEARTBEAT_MS,
  RELAY_PROTOCOL_VERSION,
  pairingAcceptTranscript,
  pairingRequestTranscript,
  type RelayEnvelope,
} from '@kepcup/shared';
import {
  FrameCodec,
  deriveSessionKeys,
  generateEphemeralX25519,
  pairingAuth,
  transcriptHash,
  x25519Shared,
  type SessionKeys,
} from '../../../../../../../packages/core/src/remote/codec.js';
import {
  ReplayWindow,
  WebFrameCodec,
  WebRelayProtocolError,
  WsTransport,
  bytesToB64Url,
  deriveSessionKeysWeb,
  parsePairingLink,
  transcriptHashWeb,
  type PairingPhase,
  type WebLinkState,
  type WsSocketLike,
} from './ws-transport';

/**
 * D96 WP5：手机端 WebCrypto 实现与 anchor 侧（core 的 Node 实现）的互测向量与
 * 传输层行为。anchor 侧直接 import core 的 codec（按相对路径取 remote/codec，
 * 不经 @kepcup/core 入口，避免拖入 core 全量）。psk 路径用包装过的 crypto
 * （X25519 generateKey 拒绝）驱动；x25519 路径用 Node 22 WebCrypto 的真 X25519
 * 跑全程（含两侧 ECDH 共享秘密一致）。
 */

/** 重发周期（与实现共用常量语义；实现内定义为私有，这里保持一致数值）。 */
const PAIRING_RESEND_MS = 5_000;

const SID = '01J8Z3V7K2QW5R8TN9XYC4M6AH';
const CODE = randomBytes(16);
const TOKEN = bytesToB64Url(randomBytes(32));
const FINGERPRINT = 'a'.repeat(64);
const CREDENTIALS_KEY = 'kepcup.remote.credentials.v1';

class FakeStorage implements Storage {
  readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

class FakeSocket implements WsSocketLike {
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    private readonly registry: FakeSocketRegistry,
  ) {
    this.registry.sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  receive(envelope: unknown): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  closeFromRemote(): void {
    this.onclose?.();
  }
}

class FakeSocketRegistry {
  readonly sockets: FakeSocket[] = [];

  get last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) throw new Error('no socket created');
    return socket;
  }

  at(index: number): FakeSocket {
    const socket = this.sockets[index];
    if (socket === undefined) throw new Error(`no socket at ${index}`);
    return socket;
  }
}

/**
 * 测试用 crypto 包装：`x25519` 为 false 时 generateKey 遇 X25519 即拒（驱动 psk
 * 回退路径）；同时把 X25519 的 deriveBits 参数归一到 Node 的写法——Node 24 的
 * WebCrypto 把成员名接成 `public`，浏览器按 spec 是 `publicKey`（生产代码按 spec
 * 写，差异只在这个测试垫片里消化）。
 */
class TestCrypto implements Crypto {
  // 原生类字段的初始化作用域看不到构造参数：subtle 必须在构造体里赋值，
  // 闭包改读 this.#x25519（字段初始化器里引用参数会 ReferenceError）。
  readonly subtle: SubtleCrypto;
  readonly #x25519: boolean;

  constructor(x25519: boolean) {
    this.#x25519 = x25519;
    const target = globalThis.crypto.subtle;
    this.subtle = new Proxy(target, {
      get: (target, prop) => {
        if (prop === 'generateKey') {
          return (algorithm: AlgorithmIdentifier, ...rest: unknown[]) => {
            const name =
              typeof algorithm === 'object' && algorithm !== null && 'name' in algorithm
                ? (algorithm as { name: unknown }).name
                : algorithm;
            if (name === 'X25519' && !this.#x25519) {
              return Promise.reject(new Error('X25519 unavailable'));
            }
            return (target.generateKey as (...args: unknown[]) => Promise<CryptoKeyPair>)(
              algorithm,
              ...(rest as []),
            );
          };
        }
        if (prop === 'deriveBits') {
          return (algorithm: Algorithm, ...rest: unknown[]) => {
            const params: Record<string, unknown> = {
              ...(algorithm as unknown as Record<string, unknown>),
            };
            if (params['name'] === 'X25519' && 'publicKey' in params) {
              // Node 的 X25519 deriveBits 参数成员名是 'public'（浏览器按 spec 是 'publicKey'）。
              params['public'] = params['publicKey'];
              delete params['publicKey'];
            }
            return (target.deriveBits as (...args: unknown[]) => Promise<ArrayBuffer>)(
              params as unknown as Algorithm,
              ...(rest as []),
            );
          };
        }
        // Node 的原生 SubtleCrypto 方法校验 this：必须绑回真实实例再交出去。
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    return globalThis.crypto.getRandomValues(array);
  }

  randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
    return globalThis.crypto.randomUUID();
  }
}

/** Node 的 X25519 deriveBits 参数成员名是 'public'（浏览器 spec 是 'publicKey'）。 */
async function nodeX25519DeriveBits(
  crypto: Crypto,
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'X25519', publicKey } as unknown as Algorithm,
        privateKey,
        256,
      ),
    );
  } catch {
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'X25519', public: publicKey } as unknown as Algorithm,
        privateKey,
        256,
      ),
    );
  }
}

/**
 * 让微任务与线程池级的 WebCrypto / transport 异步路径全部落地（真假定时器环境都
 * 可用）。x25519 的 accept→done 之间有约 8 次顺序的 subtle 调用，轮次要给够。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    else await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** 与 core pairing.ts 相同的 anchor 侧握手（accept 明文 + done 密文，两端独立派生）。 */
class FakeAnchor {
  constructor(
    readonly code: Buffer,
    readonly sid: string,
    readonly socket: FakeSocket,
  ) {}

  async acceptAndDone(args: {
    deviceId: string;
    epub: string;
    pskMode: 'x25519' | 'psk';
    token?: string;
    /** true = done 不与 accept 间隔任何微任务（复现 hub 背靠背发送的到达时序）。 */
    backToBack?: boolean;
  }): Promise<SessionKeys> {
    const anchorPair = args.pskMode === 'x25519' ? generateEphemeralX25519() : null;
    const apub = anchorPair !== null ? anchorPair.rawPublicKey.toString('base64url') : '';
    const requestPart = pairingRequestTranscript({
      deviceId: args.deviceId,
      epub: args.epub,
      pskMode: args.pskMode,
    });
    const acceptPart = pairingAcceptTranscript({ apub, pskMode: args.pskMode });
    const shared =
      anchorPair !== null && args.epub.length > 0
        ? x25519Shared(anchorPair.privateKey, Buffer.from(args.epub, 'base64url'))
        : null;
    const keys = deriveSessionKeys({
      pskMode: args.pskMode,
      pairingCode: this.code,
      transcriptHash: transcriptHash([requestPart, acceptPart]),
      sharedSecret: shared,
    });
    this.socket.receive({
      v: RELAY_PROTOCOL_VERSION,
      sid: this.sid,
      type: 'pairing',
      did: args.deviceId,
      n: 0,
      data: { kind: 'accept', apub, pskMode: args.pskMode },
    });
    if (args.backToBack !== true) await settle();
    const doneCodec = new FrameCodec(keys, this.sid, 'anchor');
    const [done] = doneCodec.seal(
      'pairing',
      { kind: 'done', token: args.token ?? TOKEN, keyFingerprint: FINGERPRINT },
      { did: args.deviceId },
    );
    this.socket.receive(done);
    await settle();
    return keys;
  }
}

interface PairedHarness {
  transport: WsTransport;
  registry: FakeSocketRegistry;
  storage: FakeStorage;
  /** anchor 侧端点 codec（core 实现，hello 后新建：封帧计数从 0 起，seal/open 同步）。 */
  endpoint: FrameCodec;
  /** anchor 侧会话密钥（模拟桌面重启后重建 codec 用）。 */
  anchorKeys: SessionKeys;
  deviceId: string;
  linkStates: WebLinkState[];
  pairings: PairingPhase[];
}

/** 走完 request → accept → done → hello 的传输层（默认 psk 路径）。 */
async function pairedTransport(options?: {
  crypto?: Crypto;
  pskMode?: 'x25519' | 'psk';
  /** accept+done 背靠背投递（无间隔）——真实 hub confirm 后的发送时序。 */
  backToBack?: boolean;
}): Promise<PairedHarness> {
  const registry = new FakeSocketRegistry();
  const storage = new FakeStorage();
  const pskMode = options?.pskMode ?? 'psk';
  const crypto = options?.crypto ?? new TestCrypto(pskMode === 'x25519');
  const transport = new WsTransport({
    sessionId: SID,
    socketFactory: (url) => new FakeSocket(url, registry),
    storage,
    crypto,
    userAgent: 'pairing-test-agent',
  });
  const linkStates: WebLinkState[] = [];
  const pairings: PairingPhase[] = [];
  transport.onLinkState((state) => linkStates.push(state));
  transport.onPairing((phase) => pairings.push(phase));
  await transport.startPairing(
    { relayUrl: 'ws://127.0.0.1:8787', sessionId: SID, secret: CODE.toString('base64url') },
    '李的 iPhone',
  );
  expect(registry.last.url).toBe(`ws://127.0.0.1:8787/ws/${SID}?role=viewer`);
  registry.last.open();
  await settle();

  const request = JSON.parse(registry.last.sent[0] as string) as {
    v: number;
    type: string;
    did: string;
    data: {
      kind: string;
      deviceName: string;
      userAgent: string;
      epub: string;
      pskMode: string;
      auth: string;
    };
  };
  expect(request.v).toBe(1);
  expect(request.type).toBe('pairing');
  expect(request.data.kind).toBe('request');
  expect(request.data.deviceName).toBe('李的 iPhone');
  expect(request.data.userAgent).toBe('pairing-test-agent');
  expect(request.data.pskMode).toBe(pskMode);
  // 配对码只以 HMAC 形态上线：auth = HMAC-SHA256(配对码, sha256(transcript))，桌面同式可验。
  const expectedAuth = pairingAuth(
    CODE,
    transcriptHash([
      pairingRequestTranscript({
        deviceId: request.did,
        epub: request.data.epub,
        pskMode: pskMode,
      }),
    ]),
  );
  expect(Buffer.from(request.data.auth, 'base64url').equals(expectedAuth)).toBe(true);

  const anchor = new FakeAnchor(CODE, SID, registry.last);
  const anchorKeys = await anchor.acceptAndDone({
    deviceId: request.did,
    epub: request.data.epub,
    pskMode: pskMode,
    ...(options?.backToBack === true ? { backToBack: true } : {}),
  });
  const endpoint = new FrameCodec(anchorKeys, SID, 'anchor');
  // done 落地 → 凭证入库 + 立即 hello 自举；hello 可被 anchor 端点侧解开。
  expect(storage.getItem(CREDENTIALS_KEY)).not.toBeNull();
  const hello = JSON.parse(registry.last.sent.at(-1) as string) as RelayEnvelope;
  expect(hello.type).toBe('hello');
  expect(hello.did).toBe(request.did);
  expect(endpoint.open(hello)).toEqual({
    complete: true,
    payload: { token: TOKEN, ts: expect.any(Number) },
  });
  expect(transport.linkState).toBe('connected');
  return {
    transport,
    registry,
    storage,
    endpoint,
    anchorKeys,
    deviceId: request.did,
    linkStates,
    pairings,
  };
}

describe('key derivation interop (WebCrypto ↔ Node)', () => {
  it('transcript hash matches core byte-for-byte', async () => {
    const core = transcriptHash(['frame-a', 'frame-b']);
    const web = await transcriptHashWeb(globalThis.crypto, ['frame-a', 'frame-b']);
    expect(Buffer.from(web).equals(core)).toBe(true);
  });

  it('psk mode derives identical directional keys', async () => {
    const transcript = transcriptHash(['req', 'acc']);
    const coreKeys = deriveSessionKeys({
      pskMode: 'psk',
      pairingCode: CODE,
      transcriptHash: transcript,
    });
    const webKeys = await deriveSessionKeysWeb({
      crypto: globalThis.crypto,
      pskMode: 'psk',
      pairingCode: CODE.toString('base64url'),
      transcriptHash: transcript,
    });
    expect(Buffer.from(webKeys.anchorToViewer).equals(coreKeys.anchorToViewer)).toBe(true);
    expect(Buffer.from(webKeys.viewerToAnchor).equals(coreKeys.viewerToAnchor)).toBe(true);
  });

  it('x25519 mode derives identical keys across implementations (real ECDH)', async () => {
    const webPair = (await globalThis.crypto.subtle.generateKey({ name: 'X25519' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const webPubRaw = new Uint8Array(
      await globalThis.crypto.subtle.exportKey('raw', webPair.publicKey),
    );
    const anchorPair = generateEphemeralX25519();
    const webPrivPkcs8 = new Uint8Array(
      await globalThis.crypto.subtle.exportKey('pkcs8', webPair.privateKey),
    );
    const webPriv = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      webPrivPkcs8,
      { name: 'X25519' },
      false,
      ['deriveBits'],
    );
    const anchorPub = await globalThis.crypto.subtle.importKey(
      'raw',
      anchorPair.rawPublicKey,
      { name: 'X25519' },
      false,
      [],
    );
    const transcript = transcriptHash(['req', 'acc']);
    const coreKeys = deriveSessionKeys({
      pskMode: 'x25519',
      pairingCode: CODE,
      transcriptHash: transcript,
      sharedSecret: x25519Shared(anchorPair.privateKey, Buffer.from(webPubRaw)),
    });
    // Node 的 X25519 deriveBits 参数成员名是 'public'（浏览器 spec 是 'publicKey'）。
    const sharedForWeb = await nodeX25519DeriveBits(globalThis.crypto, webPriv, anchorPub);

    const webKeys = await deriveSessionKeysWeb({
      crypto: globalThis.crypto,
      pskMode: 'x25519',
      pairingCode: CODE.toString('base64url'),
      transcriptHash: transcript,
      sharedSecret: sharedForWeb,
    });
    expect(Buffer.from(webKeys.anchorToViewer).equals(coreKeys.anchorToViewer)).toBe(true);
    expect(Buffer.from(webKeys.viewerToAnchor).equals(coreKeys.viewerToAnchor)).toBe(true);
  });
});

describe('WebFrameCodec ↔ core FrameCodec', () => {
  async function codecs(): Promise<{ anchor: FrameCodec; web: WebFrameCodec }> {
    const transcript = transcriptHash(['req', 'acc']);
    const coreKeys = deriveSessionKeys({
      pskMode: 'psk',
      pairingCode: CODE,
      transcriptHash: transcript,
    });
    const webKeys = await deriveSessionKeysWeb({
      crypto: globalThis.crypto,
      pskMode: 'psk',
      pairingCode: CODE.toString('base64url'),
      transcriptHash: transcript,
    });
    return {
      anchor: new FrameCodec(coreKeys, SID, 'anchor'),
      web: await WebFrameCodec.create(globalThis.crypto, webKeys, SID, 'viewer'),
    };
  }

  it('opens anchor-sealed frames; anchor opens viewer-sealed frames', async () => {
    const { anchor, web } = await codecs();
    const [down] = anchor.seal(
      'rpc',
      { t: 's', i: 'r1', r: { pong: true } },
      { did: 'dev-1234567890abcdef' },
    );
    expect(await web.open(down)).toEqual({
      complete: true,
      payload: { t: 's', i: 'r1', r: { pong: true } },
    });
    const [up] = await web.seal(
      'rpc',
      { t: 'q', m: 'test.echo', a: [{ hello: 1 }], i: 'q1' },
      { did: 'dev-1234567890abcdef' },
    );
    expect(anchor.open(up)).toEqual({
      complete: true,
      payload: { t: 'q', m: 'test.echo', a: [{ hello: 1 }], i: 'q1' },
    });
  });

  it('rejects tampered ciphertext and AAD (AUTH_FAILED)', async () => {
    const { anchor, web } = await codecs();
    const [frame] = anchor.seal('rpc', { secret: 'x' });
    const cipher = frame!.ct!;
    const flipped = cipher.slice(0, -2) + (cipher.endsWith('AA') ? 'BB' : 'AA');
    await expect(web.open({ ...frame!, ct: flipped })).rejects.toThrowError(WebRelayProtocolError);
    // AAD 篡改用新帧（上一帧的 n 已被消费，复用会先撞防重放）。
    const [fresh] = anchor.seal('rpc', { secret: 'y' });
    await expect(web.open({ ...fresh!, type: 'event' })).rejects.toThrow(/AUTH_FAILED|解密/);
  });

  it('rejects replayed envelopes (REPLAY)', async () => {
    const { anchor, web } = await codecs();
    const [frame] = anchor.seal('rpc', { a: 1 });
    expect((await web.open(frame)).complete).toBe(true);
    await expect(web.open(frame)).rejects.toThrow(/REPLAY|重复/);
  });

  it('fragments >128KB in both directions and reassembles in order', async () => {
    const { anchor, web } = await codecs();
    const big = { text: 'x'.repeat(300 * 1024) };
    const down = anchor.seal('rpc', big);
    expect(down.length).toBeGreaterThan(1);
    for (const frame of down.slice(0, -1)) {
      expect(await web.open(frame)).toEqual({ complete: false });
    }
    expect(await web.open(down[down.length - 1]!)).toEqual({ complete: true, payload: big });
    const up = await web.seal('rpc', { text: 'y'.repeat(300 * 1024) });
    expect(up.length).toBeGreaterThan(1);
    for (const frame of up.slice(0, -1)) {
      expect(anchor.open(frame)).toEqual({ complete: false });
    }
    expect(anchor.open(up[up.length - 1]!)).toEqual({
      complete: true,
      payload: { text: 'y'.repeat(300 * 1024) },
    });
  });

  it('replay window mirrors core semantics (64-frame sliding window)', () => {
    const window = new ReplayWindow();
    expect(window.accept(5)).toBe(true);
    expect(window.accept(3)).toBe(true);
    expect(window.accept(5)).toBe(false);
    expect(window.accept(70)).toBe(true);
    expect(window.accept(6)).toBe(false);
    expect(window.accept(7)).toBe(true);
  });
});

describe('parsePairingLink', () => {
  it('parses full URLs with encoded relay and bare fragments', () => {
    const link = parsePairingLink(
      `https://remote.kepcup.app/#pair=${encodeURIComponent('wss://remote.kepcup.com')},${SID},abc-DEF123`,
    );
    expect(link).toEqual({
      relayUrl: 'wss://remote.kepcup.com',
      sessionId: SID,
      secret: 'abc-DEF123',
    });
    expect(parsePairingLink(`#pair=ws://127.0.0.1:8787,${SID},secretvalue`)).toEqual({
      relayUrl: 'ws://127.0.0.1:8787',
      sessionId: SID,
      secret: 'secretvalue',
    });
  });

  it('rejects malformed links', () => {
    expect(parsePairingLink('https://x/#pair=ftp://nope,' + SID + ',secret')).toBeNull();
    expect(parsePairingLink('https://x/#pair=wss://r,notaulid,secret')).toBeNull();
    expect(parsePairingLink('https://x/#pair=wss://r,' + SID)).toBeNull();
    expect(parsePairingLink('https://x/#other=1')).toBeNull();
  });
});

describe('WsTransport: pairing state machine', () => {
  it('psk pairing: request HMAC verifiable by anchor, done stores credentials, hello opens on anchor side', async () => {
    const { pairings } = await pairedTransport();
    expect(pairings.map((phase) => phase.kind)).toEqual([
      'joining',
      'awaiting-confirm',
      'connected',
    ]);
  });

  it('x25519 pairing (real WebCrypto ECDH): both sides derive the same session keys', async () => {
    // Node 22 的 WebCrypto 支持 X25519：探测为真 → 走 x25519 模式，epub/apub 非空，
    // done 帧用双侧独立派生的密钥加密——能解开即证明 ECDH 全程一致。
    const harness = await pairedTransport({ pskMode: 'x25519' });
    expect(harness.storage.getItem(CREDENTIALS_KEY)).not.toBeNull();
    expect(harness.transport.pairing).toEqual({ kind: 'connected' });
  });

  it('done arriving back-to-back with accept still completes pairing', async () => {
    // 真机回归钉（2026-10 用户首配实测）：hub confirm 后 accept+done 背靠背发出，
    // accept 的密钥派生是长 WebCrypto 异步链——done 若不排队等它（旧实现读到
    // 尚未就位的 null codec 直接 return），桌面显示配对成功、手机永远停在
    // 「等待确认」。此用例里 done 与 accept 之间没有任何微任务间隔。
    const { transport, storage, pairings } = await pairedTransport({
      pskMode: 'x25519',
      backToBack: true,
    });
    expect(transport.pairing).toEqual({ kind: 'connected' });
    expect(storage.getItem(CREDENTIALS_KEY)).not.toBeNull();
    expect(pairings.map((phase) => phase.kind)).toContain('connected');
  });

  it('awaiting-confirm 期间周期重发 pairing.request；配对完成后停止', async () => {
    // 真机回归钉（2026-10 首扫永远无反馈）：请求若在中转的 hibernation/竞态窗口
    // 被静默丢弃，手机只能永远等待——周期重发幂等自愈（桌面侧同设备去重）。
    vi.useFakeTimers();
    try {
      const registry = new FakeSocketRegistry();
      const transport = new WsTransport({
        sessionId: SID,
        socketFactory: (url) => new FakeSocket(url, registry),
        storage: new FakeStorage(),
        crypto: new TestCrypto(true),
      });
      await transport.startPairing(
        { relayUrl: 'ws://127.0.0.1:8787', sessionId: SID, secret: CODE.toString('base64url') },
        '重发测试机',
      );
      registry.last.open();
      await settle();
      const requestCount = (): number =>
        registry.last.sent.filter(
          (text) => (JSON.parse(text) as { type?: string }).type === 'pairing',
        ).length;
      expect(requestCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(PAIRING_RESEND_MS);
      await settle();
      expect(requestCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(PAIRING_RESEND_MS);
      await settle();
      expect(requestCount()).toBe(3);

      // 走完配对：重发必须停（done 后不再有 pairing 帧上线）。
      const request = JSON.parse(registry.last.sent[0] as string) as {
        did: string;
        data: { epub: string; pskMode: string };
      };
      const anchor = new FakeAnchor(CODE, SID, registry.last);
      await anchor.acceptAndDone({
        deviceId: request.did,
        epub: request.data.epub,
        pskMode: 'x25519',
      });
      expect(transport.pairing).toEqual({ kind: 'connected' });
      const after = requestCount();
      await vi.advanceTimersByTimeAsync(PAIRING_RESEND_MS * 2);
      expect(requestCount()).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('awaiting-confirm 期间收到 anchor_online 立即重发 pairing.request', async () => {
    // 请求发出时 anchor 尚未进场（被中转丢弃的另一半场景）：桌面连上来的
    // anchor_online 信号要触发重发，不等 5s 周期。
    vi.useFakeTimers();
    try {
      const registry = new FakeSocketRegistry();
      const transport = new WsTransport({
        sessionId: SID,
        socketFactory: (url) => new FakeSocket(url, registry),
        storage: new FakeStorage(),
        crypto: new TestCrypto(true),
      });
      await transport.startPairing(
        { relayUrl: 'ws://127.0.0.1:8787', sessionId: SID, secret: CODE.toString('base64url') },
        '信号测试机',
      );
      registry.last.open();
      await settle();
      const requestCount = (): number =>
        registry.last.sent.filter(
          (text) => (JSON.parse(text) as { type?: string }).type === 'pairing',
        ).length;
      expect(requestCount()).toBe(1);
      registry.last.receive({
        v: RELAY_PROTOCOL_VERSION,
        sid: SID,
        type: 'signal',
        n: 0,
        info: { kind: 'anchor_online' },
      });
      await settle();
      expect(requestCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reject frame surfaces the reason and drops the pairing', async () => {
    const registry = new FakeSocketRegistry();
    const transport = new WsTransport({
      sessionId: SID,
      socketFactory: (url) => new FakeSocket(url, registry),
      storage: new FakeStorage(),
      crypto: new TestCrypto(false),
    });
    const pairings: PairingPhase[] = [];
    transport.onPairing((phase) => pairings.push(phase));
    await transport.startPairing(
      { relayUrl: 'ws://127.0.0.1:8787', sessionId: SID, secret: CODE.toString('base64url') },
      '测试机',
    );
    registry.last.open();
    await settle();
    const request = JSON.parse(registry.last.sent[0] as string) as { did: string };
    registry.last.receive({
      v: 1,
      sid: SID,
      type: 'pairing',
      did: request.did,
      n: 0,
      data: { kind: 'reject', reason: 'expired' },
    });
    await settle();
    expect(pairings.at(-1)).toEqual({ kind: 'rejected', reason: 'expired' });
    expect(transport.linkState).toBe('connecting');
    expect(registry.last.closed).toBe(true);
  });
});

describe('WsTransport: connected-phase frames', () => {
  it('event frames become birpc event messages; rpc posts carry rid and open on anchor', async () => {
    const { transport, endpoint, registry, deviceId } = await pairedTransport();
    const received: unknown[] = [];
    transport.onData((data) => received.push(data));
    const [event] = endpoint.seal('event', {
      name: 'run.progress',
      payload: { runId: 'r1', pct: 50 },
    });
    registry.last.receive(event);
    await settle();
    expect(received).toEqual([{ m: 'run.progress', a: [{ runId: 'r1', pct: 50 }], t: 'q' }]);

    transport.post({ t: 'q', m: 'test.echo', a: [{ hello: '桌面' }], i: 'req7' });
    await settle();
    const rpcFrame = JSON.parse(registry.last.sent.at(-1) as string) as RelayEnvelope;
    expect(rpcFrame.type).toBe('rpc');
    expect(rpcFrame.rid).toBe('req7');
    expect(rpcFrame.did).toBe(deviceId);
    expect(endpoint.open(rpcFrame)).toEqual({
      complete: true,
      payload: { t: 'q', m: 'test.echo', a: [{ hello: '桌面' }], i: 'req7' },
    });
  });

  it('drops replayed inbound envelopes without firing onData twice', async () => {
    const { transport, endpoint, registry } = await pairedTransport();
    const received: unknown[] = [];
    transport.onData((data) => received.push(data));
    const [event] = endpoint.seal('event', { name: 'x', payload: 1 });
    registry.last.receive(event);
    await settle();
    registry.last.receive(event); // 同一帧重放
    await settle();
    expect(received).toHaveLength(1);
  });

  it('anchor_offline signal switches to offline; sealed kick revoked clears credentials', async () => {
    const { transport, endpoint, registry, storage, deviceId } = await pairedTransport();
    registry.last.receive({
      v: 1,
      sid: SID,
      type: 'signal',
      n: 0,
      info: { kind: 'anchor_offline' },
    });
    await settle();
    expect(transport.linkState).toBe('offline');

    const [kick] = endpoint.seal('kick', { reason: 'revoked' }, { did: deviceId });
    registry.last.receive(kick);
    await settle();
    expect(transport.pairing).toEqual({ kind: 'kicked', reason: 'revoked' });
    expect(storage.getItem(CREDENTIALS_KEY)).toBeNull();
    expect(transport.hasCredentials()).toBe(false);
  });

  it('reconnect keeps the outbound counter monotonic (hello n continues, anchor window accepts)', async () => {
    const { transport, endpoint, registry } = await pairedTransport();
    const firstHello = JSON.parse(registry.last.sent.at(-1) as string) as RelayEnvelope;
    expect(firstHello.n).toBe(0);
    registry.last.closeFromRemote();
    await settle();
    expect(transport.linkState).toBe('reconnecting');
    transport.reconnect(); // 手动重试：立即重连（不等退避定时器）
    await settle();
    expect(registry.last).not.toBe(registry.at(0));
    registry.last.open();
    await settle();
    const secondHello = JSON.parse(registry.last.sent.at(-1) as string) as RelayEnvelope;
    expect(secondHello.type).toBe('hello');
    expect(secondHello.n).toBe(1);
    // anchor 端点在 viewer 重连间存活（窗口已记 n=0）：继续的计数器必须能被接受。
    expect(endpoint.open(secondHello)).toEqual({
      complete: true,
      payload: { token: TOKEN, ts: expect.any(Number) },
    });
  });

  it('page reload with stored credentials resumes via hello and continues the outbound counter', async () => {
    const first = await pairedTransport();
    // 首会话里 anchor 推过一帧事件（出站计数落盘；入站窗口不再持久化，见模块头）。
    const [event] = first.endpoint.seal('event', { name: 'x', payload: 1 });
    first.registry.last.receive(event);
    await settle();

    // 「刷新页面」：全新 transport，同一份 localStorage。
    const registry = new FakeSocketRegistry();
    const revived = new WsTransport({
      sessionId: SID,
      socketFactory: (url) => new FakeSocket(url, registry),
      storage: first.storage,
      crypto: new TestCrypto(false),
    });
    const received: unknown[] = [];
    revived.onData((data) => received.push(data));
    revived.resume();
    registry.last.open();
    await settle();
    const hello = JSON.parse(registry.last.sent.at(-1) as string) as RelayEnvelope;
    expect(hello.type).toBe('hello');
    // 出站计数器随凭证持久化：恢复后 hello 继续 n=1（清零会被 anchor 移植后的
    // 入站窗口当重放拒掉）。
    expect(hello.n).toBe(1);
    expect(first.endpoint.open(hello).complete).toBe(true);
    // 入站窗口每连接从零重建：anchor 端点存活时出站续号（n=1），照常解开。
    const [next] = first.endpoint.seal('event', { name: 'x', payload: 2 });
    registry.last.receive(next);
    await settle();
    expect(received).toEqual([{ m: 'x', a: [2], t: 'q' }]);
    expect(revived.linkState).toBe('connected');
  });

  it('desktop restart after reload: inbound window rebuilds, frames from zero are accepted', async () => {
    // 审查修复 P0 的回归钉：桌面重启后 anchor 出站计数从 0 重来，viewer 若恢复
    // 刷新前的入站窗口会把新流全部判成 REPLAY（且自愈也跳不出来）——入站窗口
    // 必须每连接从零重建。
    const first = await pairedTransport();
    // 首会话里 anchor 推过多帧（旧实现的持久化窗口会停在高位）。
    for (let i = 0; i < 8; i += 1) {
      const [event] = first.endpoint.seal('event', { name: 'x', payload: i });
      first.registry.last.receive(event);
    }
    await settle();

    // 「刷新页面」后桌面整体重启：全新 transport + 全新 anchor codec（计数归零）。
    const registry = new FakeSocketRegistry();
    const revived = new WsTransport({
      sessionId: SID,
      socketFactory: (url) => new FakeSocket(url, registry),
      storage: first.storage,
      crypto: new TestCrypto(false),
    });
    const received: unknown[] = [];
    revived.onData((data) => received.push(data));
    revived.resume();
    registry.last.open();
    await settle();
    const restartedAnchor = new FrameCodec(first.anchorKeys, SID, 'anchor');
    const [event] = restartedAnchor.seal('event', { name: 'x', payload: 'after-restart' });
    registry.last.receive(event);
    await settle();
    expect(received).toEqual([{ m: 'x', a: ['after-restart'], t: 'q' }]);
  });

  it('sends a ping heartbeat every 30s while connected', async () => {
    vi.useFakeTimers();
    try {
      const { registry } = await pairedTransport();
      const before = registry.last.sent.length;
      await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS);
      const ping = JSON.parse(registry.last.sent.at(-1) as string) as RelayEnvelope;
      expect(registry.last.sent.length).toBeGreaterThan(before);
      expect(ping.type).toBe('ping');
      expect(ping.n).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
