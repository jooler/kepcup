import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { newUlid } from '@kepcup/shared';
import {
  FrameCodec,
  ReplayWindow,
  RelayProtocolError,
  deriveSessionKeys,
  generateEphemeralX25519,
  pairingAuth,
  parseSessionKeys,
  serializeSessionKeys,
  sessionKeyFingerprint,
  transcriptHash,
  x25519Shared,
} from '../../src/remote/codec.js';

/** D96 §8：codec round-trip / 防重放 / 分片 / 派生（WebCrypto 侧互测向量以本组为准）。 */

const SID = newUlid();
const CODE = randomBytes(16);

function anchorViewerCodecs(mode: 'x25519' | 'psk' = 'x25519') {
  const anchorPair = generateEphemeralX25519();
  const viewerPair = generateEphemeralX25519();
  const transcript = transcriptHash(['request-frame', 'accept-frame']);
  const derive = (shared: Buffer | null) =>
    deriveSessionKeys({
      pskMode: mode,
      pairingCode: CODE,
      transcriptHash: transcript,
      sharedSecret: shared,
    });
  const anchorKeys =
    mode === 'x25519'
      ? derive(x25519Shared(anchorPair.privateKey, viewerPair.rawPublicKey))
      : derive(null);
  const viewerKeys =
    mode === 'x25519'
      ? derive(x25519Shared(viewerPair.privateKey, anchorPair.rawPublicKey))
      : derive(null);
  return {
    anchor: new FrameCodec(anchorKeys, SID, 'anchor'),
    viewer: new FrameCodec(viewerKeys, SID, 'viewer'),
    anchorKeys,
    viewerKeys,
  };
}

describe('key derivation (x25519 + hkdf, psk fallback)', () => {
  it('both sides derive identical directional keys; psk mode needs no keypairs', () => {
    const { anchorKeys, viewerKeys } = anchorViewerCodecs();
    expect(anchorKeys.anchorToViewer.equals(viewerKeys.anchorToViewer)).toBe(true);
    expect(anchorKeys.viewerToAnchor.equals(viewerKeys.viewerToAnchor)).toBe(true);
    expect(anchorKeys.anchorToViewer.equals(anchorKeys.viewerToAnchor)).toBe(false);

    const { anchorKeys: pskAnchor, viewerKeys: pskViewer } = anchorViewerCodecs('psk');
    expect(pskAnchor.anchorToViewer.equals(pskViewer.anchorToViewer)).toBe(true);
    expect(pskAnchor.anchorToViewer.equals(anchorKeys.anchorToViewer)).toBe(false);
  });

  it('different pairing codes never derive the same keys; serialization round-trips', () => {
    const a = deriveSessionKeys({
      pskMode: 'psk',
      pairingCode: CODE,
      transcriptHash: Buffer.alloc(32, 1),
    });
    const b = deriveSessionKeys({
      pskMode: 'psk',
      pairingCode: randomBytes(16),
      transcriptHash: Buffer.alloc(32, 1),
    });
    expect(a.anchorToViewer.equals(b.anchorToViewer)).toBe(false);
    expect(parseSessionKeys(serializeSessionKeys(a))).toEqual(a);
    expect(sessionKeyFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      deriveSessionKeys({
        pskMode: 'psk',
        pairingCode: Buffer.alloc(8),
        transcriptHash: Buffer.alloc(32),
      }),
    ).toThrow();
  });

  it('pairing auth binds the transcript with the pairing code', () => {
    const transcript = transcriptHash(['frame-a', 'frame-b']);
    expect(pairingAuth(CODE, transcript).equals(pairingAuth(CODE, transcript))).toBe(true);
    expect(pairingAuth(CODE, transcript).equals(pairingAuth(randomBytes(16), transcript))).toBe(
      false,
    );
    expect(
      pairingAuth(CODE, transcript).equals(
        pairingAuth(CODE, transcriptHash(['frame-a', 'frame-c'])),
      ),
    ).toBe(false);
  });
});

describe('FrameCodec seal/open', () => {
  it('round-trips rpc payloads in both directions with own counters', () => {
    const { anchor, viewer } = anchorViewerCodecs();
    const downlink = anchor.seal('rpc', { id: 1, result: 'pong' }, { did: 'dev-1234567890abcdef' });
    expect(viewer.open(downlink[0])).toEqual({
      complete: true,
      payload: { id: 1, result: 'pong' },
    });
    const uplink = viewer.seal('event', { name: 'x', payload: [1, 2, 3] });
    expect(anchor.open(uplink[0])).toEqual({
      complete: true,
      payload: { name: 'x', payload: [1, 2, 3] },
    });
    expect(downlink[0]).toMatchObject({ v: 1, sid: SID, type: 'rpc', n: 0 });
    expect(anchor.seal('rpc', {})[0]).toMatchObject({ n: 1 });
  });

  it('rejects tampered ciphertext / AAD (bit-flip → AUTH_FAILED)', () => {
    const { anchor, viewer } = anchorViewerCodecs();
    const [frame] = anchor.seal('rpc', { secret: 'x' });
    const flipped = frame.ct.slice(0, -2) + (frame.ct.endsWith('AA') ? 'BB' : 'AA');
    expect(() => viewer.open({ ...frame, ct: flipped })).toThrow(RelayProtocolError);
    // AAD 篡改：改 envelope 明文字段同样失败。
    expect(() => viewer.open({ ...frame, type: 'event' as never })).toThrow(RelayProtocolError);
  });

  it('rejects replay, regression and bad versions', () => {
    const { anchor, viewer } = anchorViewerCodecs();
    const [frame] = anchor.seal('rpc', { a: 1 });
    expect(viewer.open(frame).complete).toBe(true);
    expect(() => viewer.open(frame)).toThrow(/REPLAY|重复/);
    // 旧计数器窗口外直接拒。
    const stale = { ...anchor.seal('rpc', { b: 2 })[0], n: 0 };
    expect(() => viewer.open(stale)).toThrow(RelayProtocolError);
    // 版本不识别即断开（schema 层拒）。
    expect(() => viewer.open({ ...frame, v: 2 as never })).toThrow(RelayProtocolError);
    expect(() => viewer.open({ v: 1, sid: SID, type: 'rpc', n: 5 })).toThrow(/密文/);
  });

  it('replay window accepts reordering inside 64, rejects anything older', () => {
    const window = new ReplayWindow();
    expect(window.accept(5)).toBe(true);
    expect(window.accept(3)).toBe(true);
    expect(window.accept(5)).toBe(false);
    expect(window.accept(70)).toBe(true);
    expect(window.accept(6)).toBe(false); // 70-64=6 边界外
    expect(window.accept(7)).toBe(true); // 边界内
  });

  it('fragments >128KB and reassembles in order; oversized logical messages rejected', () => {
    const { anchor, viewer } = anchorViewerCodecs();
    const big = { text: 'x'.repeat(300 * 1024) };
    const frames = anchor.seal('rpc', big);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.frag !== undefined)).toBe(true);
    const mids = new Set(frames.map((frame) => frame.frag!.mid));
    expect(mids.size).toBe(1);
    for (const frame of frames.slice(0, -1)) {
      expect(viewer.open(frame)).toEqual({ complete: false });
    }
    expect(viewer.open(frames[frames.length - 1]!)).toEqual({ complete: true, payload: big });
    // 8MB 逻辑上限。
    const tooBig = 'y'.repeat(9 * 1024 * 1024);
    expect(() => anchor.seal('rpc', { text: tooBig })).toThrow(/FRAME_TOO_LARGE|8MB/);
  });

  it('wire envelope stays under the 512KB relay frame cap for threshold-sized chunks', () => {
    const { anchor } = anchorViewerCodecs();
    const frames = anchor.seal('rpc', { text: 'z'.repeat(400 * 1024) });
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(512 * 1024);
    }
  });

  it('outbound IV is direction+counter derived: deterministic per n, distinct across roles', () => {
    // 审查修复：随机 IV 换成方向标签 ‖ 计数器——同密钥下 n 唯一即 IV 唯一，
    // 消除随机 IV 的碰撞面（同密钥长期使用时随机 IV 受 2^32 次约束）。
    const { anchorKeys } = anchorViewerCodecs();
    const a1 = new FrameCodec(anchorKeys, SID, 'anchor');
    const a2 = new FrameCodec(anchorKeys, SID, 'anchor');
    const [f1] = a1.seal('rpc', { k: 1 });
    const [f2] = a2.seal('rpc', { k: 1 });
    expect(f2.ct).toBe(f1.ct); // 同 n 同密钥：IV 确定 → 密文逐字节一致
    const v = new FrameCodec(anchorKeys, SID, 'viewer');
    const [f3] = v.seal('rpc', { k: 1 });
    expect(f3.ct).not.toBe(f1.ct); // 方向标签进 IV
    // 计数续号后 IV 随之变化。
    const [f4] = a1.seal('rpc', { k: 2 });
    expect(f4.ct).not.toBe(f1.ct);
  });
});

describe('审查修复回归（WP6 收口审查）', () => {
  it('x25519 模式缺共享秘密直接抛错（不静默退化为纯 PSK 派生）', () => {
    expect(() =>
      deriveSessionKeys({
        pskMode: 'x25519',
        pairingCode: CODE,
        transcriptHash: transcriptHash(['request', 'accept']),
      }),
    ).toThrow(/ECDH/);
  });

  it('adoptCountersFrom 移植双向计数：出站续号、入站窗口保留', () => {
    const { anchor, anchorKeys } = anchorViewerCodecs();
    // 旧端点出一帧（n=0）并收一帧（viewer → anchor 的 n=0 进窗口）。
    const [sent] = anchor.seal('rpc', { k: 'old' });
    void sent;
    const peer = new FrameCodec(anchorKeys, SID, 'viewer');
    const [up] = peer.seal('hello', { token: 't' });
    anchor.open(up);
    // 端点重建：新 codec 移植后出站续号（n=1）、入站窗口保留（重放 n=0 被拒）。
    const replacement = new FrameCodec(anchorKeys, SID, 'anchor');
    replacement.adoptCountersFrom(anchor);
    expect(replacement.outboundCounter).toBe(1);
    const [next] = replacement.seal('rpc', { k: 'new' });
    expect(next.n).toBe(1);
    expect(() => replacement.open(up)).toThrow(/REPLAY|回退/);
    // 对端（旧窗口最高=0）能解开续号的 n=1 帧：出站移植保证对端水位不失效。
    expect(peer.open(next).payload).toEqual({ k: 'new' });
  });
});
