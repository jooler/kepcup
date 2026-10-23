/**
 * RelaySessionLogic 的单元测试:内存 mock socket + 假时钟驱动纯类(设计 46 §8 的
 * vitest-pool-workers 方案在本仓测试运行时下不可用,见 README「与设计的偏离」)。
 * DO 接线层(RelaySession)不在单元覆盖范围,由 WP6 联调(wrangler dev)验证。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  RELAY_ANCHOR_TTL_MS,
  RELAY_MAX_VIEWERS,
  RELAY_RATE_BURST,
  RELAY_RATE_SUSTAINED_PER_SEC,
  type RelayFrameType,
} from '../src/envelope';
import { RelaySessionLogic, systemTimer, type RelayTimer } from '../src/relay-session';
import { IpSessionLimiter, MAX_SESSIONS_PER_IP } from '../src/ip-limiter';

// --- 假时钟 + 定时器 ---------------------------------------------------------------

class FakeClock {
  private nowMs = 0;
  private nextId = 0;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();

  readonly now = (): number => this.nowMs;
  readonly timer: RelayTimer = {
    set: (fn, ms) => {
      this.nextId += 1;
      this.tasks.set(this.nextId, { at: this.nowMs + ms, fn });
      return this.nextId;
    },
    clear: (handle) => {
      this.tasks.delete(handle as number);
    },
  };

  /** 推进时间,按到期顺序执行定时器(执行时把时钟拨到该时刻,令牌桶按真实间隔补币)。 */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, task] of this.tasks) {
        if (task.at <= target && task.at < dueAt) {
          dueAt = task.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const task = this.tasks.get(dueId);
      if (!task) break;
      this.tasks.delete(dueId);
      this.nowMs = task.at;
      task.fn();
    }
    this.nowMs = target;
  }

  /** 尚未到期的定时器个数(断言 TTL 被取消用)。 */
  get pending(): number {
    return this.tasks.size;
  }
}

// --- mock socket -------------------------------------------------------------------

class MockSocket {
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  send(text: string): void {
    this.sent.push(text);
  }

  close(code: number, reason: string): void {
    if (this.closedWith === null) this.closedWith = { code, reason };
  }
}

/** mock socket 收到的帧(DO 自产帧与转发帧的公共视图)。 */
interface SentFrame {
  v: number;
  sid: string;
  type: string;
  n: number;
  did?: string;
  info?: { kind: string; ts?: number; retryAfterMs?: number; message?: string };
}

function sent(sock: MockSocket): SentFrame[] {
  return sock.sent.map((text) => JSON.parse(text) as SentFrame);
}

// --- 帧构造 ------------------------------------------------------------------------

const SID_A = '01JSCE8XFN2QRSTVWXYZKHJ4M9';
const SID_B = '02D9QMG5XAARB3WNT7KZEHYC2V';
const DID_A = 'device-aaaaaaaaaaaa';
const DID_B = 'device-bbbbbbbbbbbb';
const DID_C = 'device-cccccccccccc';
const DID_UNKNOWN = 'device-unregistered-9';

let seq = 0;

function frame(fields: {
  sid?: string;
  type: RelayFrameType;
  did?: string;
  v?: number;
  n?: number;
  extra?: Record<string, unknown>;
}): string {
  const { sid = SID_A, type, did, v = 1, n, extra } = fields;
  return JSON.stringify({
    v,
    sid,
    type,
    ...(did === undefined ? {} : { did }),
    n: n ?? (seq += 1),
    ...(extra ?? {}),
  });
}

// --- fixture -----------------------------------------------------------------------

interface Session {
  logic: RelaySessionLogic;
  clock: FakeClock;
  anchor: MockSocket;
  viewers: MockSocket[];
}

function makeSession(sid = SID_A): Session {
  const clock = new FakeClock();
  const logic = new RelaySessionLogic({ sid, timer: clock.timer, now: clock.now });
  const anchor = new MockSocket();
  logic.joinAnchor(anchor);
  return { logic, clock, anchor, viewers: [] };
}

/** 加一个 viewer;did 直接走接线层同款的显式登记(等价于首帧注册,见 registerViewerDid)。 */
function addViewer(session: Session, did?: string): MockSocket {
  const viewer = new MockSocket();
  expect(session.logic.joinViewer(viewer)).toBe(true);
  if (did !== undefined) session.logic.registerViewerDid(viewer, did);
  session.viewers.push(viewer);
  return viewer;
}

beforeEach(() => {
  seq = 0;
});

// --- 多会话隔离 ----------------------------------------------------------------------

describe('多会话隔离', () => {
  it('两个会话实例互不可路由:广播与定向都出不了自己的实例', () => {
    const a = makeSession(SID_A);
    const b = makeSession(SID_B);
    const viewerA = addViewer(a, DID_A);
    const viewerB = addViewer(b, DID_B);

    // A 的 anchor 广播事件只到 A 的 viewers
    a.logic.onMessage(a.anchor, frame({ type: 'event' }));
    expect(viewerA.sent).toHaveLength(1);
    expect(viewerB.sent).toHaveLength(0);

    // B 的 viewer 帧只到 B 的 anchor
    b.logic.onMessage(viewerB, frame({ sid: SID_B, type: 'rpc', did: DID_B }));
    expect(b.anchor.sent).toHaveLength(1);
    expect(a.anchor.sent).toHaveLength(0);

    // A 的 anchor 拿 B 会话里注册的 did 定向:在 A 的路由表里查不到,丢弃
    a.logic.onMessage(a.anchor, frame({ type: 'rpc', did: DID_B }));
    expect(viewerB.sent).toHaveLength(0);
    expect(b.anchor.sent).toHaveLength(1); // 只有上一步 B 自己的 rpc
  });

  it('帧的 sid 必须与实例一致,否则按坏帧断开', () => {
    const a = makeSession(SID_A);
    const viewer = addViewer(a, DID_A);
    a.logic.onMessage(viewer, frame({ sid: SID_B, type: 'rpc', did: DID_A }));
    const last = sent(viewer).at(-1);
    expect(last?.type).toBe('error');
    expect(last?.info?.kind).toBe('bad_frame');
    expect(viewer.closedWith?.code).toBe(1008);
  });
});

// --- 转发规则(设计 §4.3 的表)---------------------------------------------------------

describe('转发规则', () => {
  it('anchor 的 event(无 did)广播给全部 viewers(原样透传,协议保留语义)', () => {
    const s = makeSession();
    const [va, vb, vc] = [addViewer(s, DID_A), addViewer(s, DID_B), addViewer(s, DID_C)];
    const raw = frame({ type: 'event', extra: { ct: 'Zm9v' } });
    s.logic.onMessage(s.anchor, raw);
    expect(va.sent.at(-1)).toBe(raw);
    expect(vb.sent.at(-1)).toBe(raw);
    expect(vc.sent.at(-1)).toBe(raw);
  });

  it('anchor 的 event(带 did)定向给该 viewer(WP6:E2E 按设备加密,不盲广播)', () => {
    const s = makeSession();
    const [va, vb] = [addViewer(s, DID_A), addViewer(s, DID_B)];
    const raw = frame({ type: 'event', did: DID_B, extra: { ct: 'Zm9v' } });
    s.logic.onMessage(s.anchor, raw);
    expect(va.sent).toHaveLength(0);
    expect(vb.sent.at(-1)).toBe(raw);
    // 未注册 did 的 event 静默丢弃(与其他定向帧一致,防探测)
    const stray = frame({ type: 'event', did: 'nobody-here-aaaaaaaaaa', extra: { ct: 'Zm9v' } });
    s.logic.onMessage(s.anchor, stray);
    expect(va.sent).toHaveLength(0);
    expect(vb.sent).toHaveLength(1);
  });

  it('viewer 断开时 anchor 收 viewer_left 信号(WP6:设备列表不虚高)', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    s.logic.onClose(viewer);
    const last = sent(s.anchor).at(-1);
    expect(last?.type).toBe('signal');
    expect(last?.info).toEqual({ kind: 'viewer_left', did: DID_A });
  });

  it('未登记 did 的 viewer 断开不发 viewer_left(无从告知)', () => {
    const s = makeSession();
    const viewer = addViewer(s);
    s.logic.onClose(viewer);
    expect(s.anchor.sent).toHaveLength(0);
  });

  it('viewer 的 rpc / pairing / hello 转发给 anchor,首个带 did 的帧注册进路由表', () => {
    const s = makeSession();
    const viewer = addViewer(s); // 尚未登记 did
    const rpc = frame({ type: 'rpc', did: DID_A, extra: { rid: 1, ct: 'Zm9v' } });
    s.logic.onMessage(viewer, rpc);
    const pairing = frame({ type: 'pairing', did: DID_A });
    s.logic.onMessage(viewer, pairing);
    const hello = frame({ type: 'hello', did: DID_A });
    s.logic.onMessage(viewer, hello);
    expect(s.anchor.sent).toEqual([rpc, pairing, hello]);

    // did 已登记:anchor 的定向 rpc 能回到这个 viewer
    const reply = frame({ type: 'rpc', did: DID_A, extra: { rid: 1, ct: 'YmFy' } });
    s.logic.onMessage(s.anchor, reply);
    expect(viewer.sent.at(-1)).toBe(reply);
  });

  it('anchor 带 did 的 rpc 定向给该 viewer,其余 viewers 收不到', () => {
    const s = makeSession();
    const va = addViewer(s, DID_A);
    const vb = addViewer(s, DID_B);
    const raw = frame({ type: 'rpc', did: DID_A, extra: { ct: 'YmFy' } });
    s.logic.onMessage(s.anchor, raw);
    expect(va.sent.at(-1)).toBe(raw);
    expect(vb.sent).toHaveLength(0);
  });

  it('未注册 did 的 anchor 定向帧被静默丢弃', () => {
    const s = makeSession();
    const va = addViewer(s, DID_A);
    s.logic.onMessage(s.anchor, frame({ type: 'rpc', did: DID_UNKNOWN }));
    // 不带 did 的 anchor rpc 同样无处投递
    s.logic.onMessage(s.anchor, frame({ type: 'rpc' }));
    expect(va.sent).toHaveLength(0);
    expect(s.anchor.sent).toHaveLength(0); // 也不给 anchor 回错误
  });

  it('kick 定向送达后关闭目标 viewer,其余 viewers 不受影响', () => {
    const s = makeSession();
    const va = addViewer(s, DID_A);
    const vb = addViewer(s, DID_B);
    const raw = frame({ type: 'kick', did: DID_A, extra: { ct: 'cmV2b2tlZA' } });
    s.logic.onMessage(s.anchor, raw);
    expect(va.sent.at(-1)).toBe(raw);
    expect(va.closedWith).toEqual({ code: 1000, reason: 'kicked' });
    expect(vb.closedWith).toBeNull();
    // 被踢的 viewer 已从路由表摘除:再定向它就是丢弃
    s.logic.onMessage(s.anchor, frame({ type: 'rpc', did: DID_A }));
    expect(vb.sent).toHaveLength(0);
  });

  it('ping 由任一端发出都回应用层 pong(应用层心跳,维持 hibernation 活性)', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    s.clock.advance(5_000);
    s.logic.onMessage(s.anchor, frame({ type: 'ping' }));
    const anchorPong = sent(s.anchor).at(-1);
    expect(anchorPong?.type).toBe('pong');
    expect(anchorPong?.info?.kind).toBe('pong');
    expect(anchorPong?.info?.ts).toBe(5_000);
    expect(anchorPong?.n).toBe(0); // DO 自产帧恒 0(设计 §4.5)

    s.logic.onMessage(viewer, frame({ type: 'ping' }));
    const viewerPong = sent(viewer).at(-1);
    expect(viewerPong?.type).toBe('pong');
    expect(viewerPong?.info?.ts).toBe(5_000);
  });

  it('viewer 不得伪造 anchor / DO 的帧:event、kick、error、signal、pong 全部丢弃', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    for (const type of ['event', 'kick', 'error', 'signal', 'pong'] as const) {
      s.logic.onMessage(viewer, frame({ type, did: DID_A }));
    }
    expect(s.anchor.sent).toHaveLength(0);
    expect(s.viewers).toHaveLength(1);
  });

  it('anchor 离线(TTL 窗口内)时 viewer 帧无处转发,安静丢弃', () => {
    const clock = new FakeClock();
    const logic = new RelaySessionLogic({ sid: SID_A, timer: clock.timer, now: clock.now });
    const viewer = new MockSocket();
    expect(logic.joinViewer(viewer)).toBe(true);
    logic.onMessage(viewer, frame({ type: 'rpc', did: DID_A }));
    expect(viewer.closedWith).toBeNull();

    const anchor = new MockSocket();
    logic.joinAnchor(anchor);
    logic.onMessage(viewer, frame({ type: 'rpc', did: DID_A }));
    expect(anchor.sent).toHaveLength(1); // 只有 anchor 上线后的那一帧
  });
});

// --- anchor 生命周期 -----------------------------------------------------------------

describe('anchor 生命周期', () => {
  it('anchor 断开:viewers 收 signal anchor_offline,TTL 到期逐出并关闭全部', () => {
    const s = makeSession();
    const [va, vb] = [addViewer(s, DID_A), addViewer(s, DID_B)];
    s.logic.onClose(s.anchor);
    expect(sent(va).at(-1)).toMatchObject({ type: 'signal', n: 0 });
    expect(sent(va).at(-1)?.info).toEqual({ kind: 'anchor_offline' });
    expect(sent(vb).at(-1)?.info).toEqual({ kind: 'anchor_offline' });
    expect(va.closedWith).toBeNull(); // TTL 内 viewer 保持在连

    s.clock.advance(RELAY_ANCHOR_TTL_MS);
    expect(sent(va).at(-1)?.info).toEqual({ kind: 'session_idle' });
    expect(sent(vb).at(-1)?.info).toEqual({ kind: 'session_idle' });
    expect(va.closedWith).toEqual({ code: 1000, reason: 'session idle' });
    expect(vb.closedWith).toEqual({ code: 1000, reason: 'session idle' });
    expect(s.logic.hasAnchor).toBe(false);
    expect(s.logic.viewerCount).toBe(0);
  });

  it('TTL 内 anchor 重连:viewers 收 anchor_online,TTL 取消', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    s.logic.onClose(s.anchor);
    expect(sent(viewer).at(-1)?.info).toEqual({ kind: 'anchor_offline' });

    const anchor2 = new MockSocket();
    s.logic.joinAnchor(anchor2);
    expect(sent(viewer).at(-1)?.info).toEqual({ kind: 'anchor_online' });
    expect(s.clock.pending).toBe(0); // TTL 已取消
    s.clock.advance(RELAY_ANCHOR_TTL_MS * 2);
    expect(viewer.closedWith).toBeNull(); // 不再逐出

    // 新 anchor 正常广播
    s.logic.onMessage(anchor2, frame({ type: 'event' }));
    expect(viewer.sent.at(-1)).toBeDefined();
  });

  it('第二个 anchor 顶掉旧的:旧连接收 signal replaced 后关闭,viewers 收 anchor_online 重自举', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    const anchor2 = new MockSocket();
    s.logic.joinAnchor(anchor2);
    expect(sent(s.anchor).at(-1)?.info).toEqual({ kind: 'replaced' });
    expect(s.anchor.closedWith).toEqual({ code: 1000, reason: 'anchor replaced' });
    // 替换也广播 anchor_online(审查修复 2026-10):被顶掉的旧 anchor 可能是
    // 僵尸(桌面断链、close 帧没到 DO)——viewer 对面的端点换了,重发 hello 是
    // 幂等自愈;不广播的话 viewer 的 pong 一直正常、请求却发给僵尸全丢,冻死。
    expect(sent(viewer).at(-1)?.info).toEqual({ kind: 'anchor_online' });
    expect(s.logic.hasAnchor).toBe(true);
  });

  it('僵尸 anchor 被替换后真 anchor 回场:viewer 收 anchor_online,后续帧路由到新 anchor(真机回归钉 2026-10)', () => {
    const clock = new FakeClock();
    const logic = new RelaySessionLogic({ sid: SID_A, timer: clock.timer, now: clock.now });
    const zombie = new MockSocket();
    logic.joinAnchor(zombie); // 桌面断链:DO 不会收到 close,僵尸留在路由表
    const viewer = new MockSocket();
    expect(logic.joinViewer(viewer)).toBe(true);
    logic.onMessage(viewer, frame({ type: 'pairing', did: DID_A }));
    expect(sent(zombie)).toHaveLength(1); // 发给了僵尸 = 丢失(hub 侧端点没建起来)

    // 桌面网络恢复,RelayClient 重连:替换僵尸。修复前(noAnchorSince 已空、
    // 无 TTL 可清)永不广播,手机冻死在假活连接上;修复后替换即广播。
    const fresh = new MockSocket();
    logic.joinAnchor(fresh);
    expect(sent(viewer).at(-1)?.info).toEqual({ kind: 'anchor_online' });
    // viewer 重发 hello / 后续帧路由到真 anchor。
    logic.onMessage(viewer, frame({ type: 'pairing', did: DID_A }));
    expect(fresh.sent).toHaveLength(1);
  });

  it('viewers 全部离开后无需保活:TTL 取消,全空即逐出', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    s.logic.onClose(s.anchor);
    expect(s.clock.pending).toBe(1);
    s.logic.onClose(viewer);
    expect(s.clock.pending).toBe(0);
    s.clock.advance(RELAY_ANCHOR_TTL_MS);
    expect(viewer.closedWith).toBeNull(); // 没有迟到 session_idle
  });

  it('anchor 断开时没有 viewer:直接回到空会话,不留定时器', () => {
    const s = makeSession();
    s.logic.onClose(s.anchor);
    expect(s.clock.pending).toBe(0);
    const anchor2 = new MockSocket();
    const viewer = addViewer(s, DID_A); // viewer 先于 anchor 进场(等待期)
    s.logic.joinAnchor(anchor2);
    // 先于 anchor 进场的 viewer 收到 anchor_online(真机回归钉 2026-10:手机在
    // anchor 进场前发的配对请求被丢弃,手机端据此信号重发,不再永远等待)
    expect(sent(viewer).at(-1)?.info).toEqual({ kind: 'anchor_online' });
  });

  it('viewer 先进场并发帧后 anchor 才来:viewer 收 anchor_online,后续帧正常路由', () => {
    const clock = new FakeClock();
    const logic = new RelaySessionLogic({ sid: SID_A, timer: clock.timer, now: clock.now });
    const viewer = new MockSocket();
    expect(logic.joinViewer(viewer)).toBe(true);
    // anchor 不在:viewer 帧无处转发(安静丢弃,原有语义)
    logic.onMessage(viewer, frame({ type: 'pairing', did: DID_A }));
    expect(logic.hasAnchor).toBe(false);

    const anchor = new MockSocket();
    logic.joinAnchor(anchor);
    expect(sent(viewer).at(-1)?.info).toEqual({ kind: 'anchor_online' });
    // anchor 到场后 viewer 的下一帧正常转发
    logic.onMessage(viewer, frame({ type: 'pairing', did: DID_A }));
    expect(anchor.sent).toHaveLength(1);
  });

  it('anchor 离场期间的 viewer_left 暂存,anchor 回场补发(审查修复)', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    s.logic.onClose(s.anchor); // anchor 离场 → 保活窗口
    expect(sent(viewer).at(-1)?.info).toEqual({ kind: 'anchor_offline' });
    s.logic.onClose(viewer); // anchor 不在:viewer_left 只能攒着(原实现直接丢弃)
    const anchor2 = new MockSocket();
    s.logic.joinAnchor(anchor2);
    const lefts = sent(anchor2).filter((f) => f.info?.kind === 'viewer_left');
    expect(lefts).toHaveLength(1);
    expect(lefts[0]?.info).toEqual({ kind: 'viewer_left', did: DID_A });
  });

  it('从未等到 anchor 的会话按同一 TTL 逐出,不能靠 ping 续住(审查修复)', () => {
    const clock = new FakeClock();
    const logic = new RelaySessionLogic({ sid: SID_A, timer: clock.timer, now: clock.now });
    const viewer = new MockSocket();
    expect(logic.joinViewer(viewer)).toBe(true);
    clock.advance(RELAY_ANCHOR_TTL_MS - 1000);
    logic.onMessage(viewer, frame({ type: 'ping', n: 0 })); // ping 续不住
    expect(viewer.closedWith).toBeNull();
    clock.advance(1000);
    logic.onMessage(viewer, frame({ type: 'ping', n: 0 })); // 超时 → 逐出
    expect(sent(viewer).at(-1)?.info).toEqual({ kind: 'session_idle' });
    expect(viewer.closedWith).toEqual({ code: 1000, reason: 'session idle' });
    // 下一位 viewer 重新起算等待窗口(不继承上一批的超时)
    const viewer2 = new MockSocket();
    expect(logic.joinViewer(viewer2)).toBe(true);
    logic.onMessage(viewer2, frame({ type: 'ping', n: 0 }));
    clock.advance(RELAY_ANCHOR_TTL_MS - 1000);
    expect(viewer2.closedWith).toBeNull();
  });

  it('anchor 被坏帧拒绝后路由表不残留死 socket,close 事件不重复处理(审查修复)', () => {
    const s = makeSession();
    const viewer = addViewer(s);
    s.logic.onMessage(s.anchor, frame({ type: 'ping', v: 99, n: 0 })); // 版本不识别 → reject
    expect(s.anchor.closedWith).toEqual({ code: 1008, reason: 'bad_frame' });
    expect(sent(viewer).at(-1)?.info).toEqual({ kind: 'anchor_offline' });
    // 随后 close 事件到达:anchor 已清,不重复广播、不重复武装 TTL
    s.logic.onClose(s.anchor);
    expect(sent(viewer).filter((f) => f.info?.kind === 'anchor_offline')).toHaveLength(1);
    expect(s.clock.pending).toBe(1);
  });
});

// --- viewer 名额与 did 顶替 -------------------------------------------------------------

describe('viewer 名额与 did 顶替', () => {
  it(`viewer 上限 ${RELAY_MAX_VIEWERS}:超限拒绝并直接关闭`, () => {
    const s = makeSession();
    for (let i = 0; i < RELAY_MAX_VIEWERS; i += 1) addViewer(s);
    const extra = new MockSocket();
    expect(s.logic.joinViewer(extra)).toBe(false);
    expect(extra.closedWith).toEqual({ code: 1013, reason: 'too many viewers' });
    expect(extra.sent).toHaveLength(0);
    expect(s.logic.hasViewerCapacity()).toBe(false);
  });

  it('同 did 新连接顶掉旧连接:旧连接收 signal replaced 后关闭', () => {
    const s = makeSession();
    const v1 = addViewer(s, DID_A);
    const v2 = new MockSocket();
    expect(s.logic.joinViewer(v2)).toBe(true);
    // v2 的首个带 did 帧触发顶替
    s.logic.onMessage(v2, frame({ type: 'rpc', did: DID_A }));
    expect(sent(v1).at(-1)?.info).toEqual({ kind: 'replaced' });
    expect(v1.closedWith).toEqual({ code: 1000, reason: 'replaced' });
    // did 现在指向 v2
    const reply = frame({ type: 'rpc', did: DID_A });
    s.logic.onMessage(s.anchor, reply);
    expect(v2.sent.at(-1)).toBe(reply);
    expect(s.logic.viewerCount).toBe(1);
  });
});

// --- 滥用防护 ------------------------------------------------------------------------

describe('滥用防护', () => {
  it(`令牌桶:突发 ${RELAY_RATE_BURST} 帧耗尽后立即超限,持续 ${RELAY_RATE_SUSTAINED_PER_SEC}/s 补充`, () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    // 突发额度一次耗尽(全部成功转发给 anchor)
    for (let i = 0; i < RELAY_RATE_BURST; i += 1) {
      s.logic.onMessage(viewer, frame({ type: 'rpc', did: DID_A }));
    }
    expect(s.anchor.sent).toHaveLength(RELAY_RATE_BURST);
    // 同一毫秒的第 61 帧被拒:kick ratelimit 后断开
    s.logic.onMessage(viewer, frame({ type: 'rpc', did: DID_A }));
    const kick = sent(viewer).at(-1);
    expect(kick?.type).toBe('kick');
    expect(kick?.info?.kind).toBe('ratelimit');
    expect(kick?.info?.retryAfterMs).toBeGreaterThan(0);
    expect(viewer.closedWith?.code).toBe(1008);
    expect(s.logic.viewerCount).toBe(0);
  });

  it('令牌桶补充:1 秒后补 30 个,第 31 个再次被拒', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    for (let i = 0; i < RELAY_RATE_BURST; i += 1) {
      s.logic.onMessage(viewer, frame({ type: 'rpc', did: DID_A }));
    }
    s.clock.advance(1_000);
    for (let i = 0; i < RELAY_RATE_SUSTAINED_PER_SEC; i += 1) {
      s.logic.onMessage(viewer, frame({ type: 'rpc', did: DID_A }));
    }
    expect(s.anchor.sent).toHaveLength(RELAY_RATE_BURST + RELAY_RATE_SUSTAINED_PER_SEC);
    s.logic.onMessage(viewer, frame({ type: 'rpc', did: DID_A }));
    expect(sent(viewer).at(-1)?.info?.kind).toBe('ratelimit');
    expect(viewer.closedWith?.code).toBe(1008);
  });

  it('ping 也消耗令牌(否则 ping 洪水绕过限速)', () => {
    const s = makeSession();
    const viewer = addViewer(s);
    for (let i = 0; i < RELAY_RATE_BURST; i += 1) {
      s.logic.onMessage(viewer, frame({ type: 'ping' }));
    }
    expect(sent(viewer)).toHaveLength(RELAY_RATE_BURST); // 全是 pong
    s.logic.onMessage(viewer, frame({ type: 'ping' }));
    expect(sent(viewer).at(-1)?.info?.kind).toBe('ratelimit');
  });

  it('anchor 的入站预算按 viewer 数放大,定向扇出不会自我踢除(审查修复)', () => {
    const s = makeSession();
    for (let i = 0; i < 5; i += 1) addViewer(s);
    // 5 viewers:anchor 桶容量 = 60 × 6 = 360(同一毫秒、无补币)。
    for (let i = 0; i < RELAY_RATE_BURST * 6; i += 1) {
      s.logic.onMessage(s.anchor, frame({ type: 'event' }));
    }
    expect(s.anchor.closedWith).toBeNull();
    s.logic.onMessage(s.anchor, frame({ type: 'event' }));
    expect(s.anchor.closedWith).toEqual({ code: 1008, reason: 'ratelimit' });
  });

  it('单帧超过 512KB:拒绝并断开(1009)', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    const oversized = frame({
      type: 'rpc',
      did: DID_A,
      extra: { ct: 'A'.repeat(600 * 1024) },
    });
    s.logic.onMessage(viewer, oversized);
    expect(s.anchor.sent).toHaveLength(0);
    expect(sent(viewer).at(-1)?.info).toMatchObject({ kind: 'bad_frame' });
    expect(viewer.closedWith?.code).toBe(1009);
  });

  it('限额内的大帧正常转发', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    const large = frame({
      type: 'rpc',
      did: DID_A,
      extra: { ct: 'A'.repeat(100 * 1024) },
    });
    s.logic.onMessage(viewer, large);
    expect(s.anchor.sent.at(-1)).toBe(large);
    expect(viewer.closedWith).toBeNull();
  });

  it('v 不识别:断开并报错,不做静默降级(设计 §4.5)', () => {
    const s = makeSession();
    const viewer = addViewer(s, DID_A);
    s.logic.onMessage(viewer, frame({ type: 'rpc', did: DID_A, v: 2 }));
    const err = sent(viewer).at(-1);
    expect(err?.type).toBe('error');
    expect(err?.info?.kind).toBe('bad_frame');
    expect(err?.info?.message).toMatch(/unsupported protocol version/);
    expect(viewer.closedWith?.code).toBe(1008);
  });

  it('坏帧(unparseable / 未知类型 / 非法 did / 非法 n)都断开', () => {
    const cases: Array<{ label: string; raw: string }> = [
      { label: '非 JSON', raw: 'not json' },
      { label: 'JSON 数组', raw: '[1,2]' },
      {
        label: '未知帧类型',
        raw: frame({ type: 'rpc', did: DID_A }).replace('"rpc"', '"nope"'),
      },
      { label: '非法 did', raw: frame({ type: 'rpc', did: 'short' }) },
      { label: '负数 n', raw: frame({ type: 'rpc', did: DID_A, n: -1 }) },
      { label: '非整数 n', raw: frame({ type: 'rpc', did: DID_A, n: 1.5 }) },
    ];
    for (const { label, raw } of cases) {
      const s = makeSession();
      const viewer = addViewer(s);
      s.logic.onMessage(viewer, raw);
      expect(viewer.closedWith?.code, label).toBe(1008);
      expect(sent(viewer).at(-1)?.info?.kind, label).toBe('bad_frame');
    }
  });

  it('二进制帧:协议只有文本 JSON,按坏帧断开', () => {
    const s = makeSession();
    const viewer = addViewer(s);
    s.logic.onBinary(viewer);
    expect(sent(viewer).at(-1)?.info?.kind).toBe('bad_frame');
    expect(viewer.closedWith?.code).toBe(1008);
  });
});

// --- Worker 侧 per-IP 名额 -------------------------------------------------------------

describe('IpSessionLimiter(每 isolate 内存 Map)', () => {
  it(`单 IP 并发会话上限 ${MAX_SESSIONS_PER_IP},名额按 TTL 过期释放`, () => {
    const clock = new FakeClock();
    const limiter = new IpSessionLimiter(MAX_SESSIONS_PER_IP, RELAY_ANCHOR_TTL_MS, clock.now);
    for (let i = 0; i < MAX_SESSIONS_PER_IP; i += 1) {
      expect(limiter.acquire('203.0.113.7', `sid${i}`)).toBe(true);
    }
    expect(limiter.acquire('203.0.113.7', 'sid-new')).toBe(false);
    expect(limiter.active('203.0.113.7')).toBe(MAX_SESSIONS_PER_IP);

    // 名额按会话最长寿命过期(Worker 观察不到关闭,见 src/worker.ts 注释)
    clock.advance(RELAY_ANCHOR_TTL_MS + 1);
    expect(limiter.active('203.0.113.7')).toBe(0);
    expect(limiter.acquire('203.0.113.7', 'sid-next')).toBe(true);
  });

  it('同一会话的重连幂等续期,不占新名额(WP6 联调修复:重连风暴不锁死用户)', () => {
    const clock = new FakeClock();
    const limiter = new IpSessionLimiter(3, RELAY_ANCHOR_TTL_MS, clock.now);
    expect(limiter.acquire('203.0.113.7', 'sid-a')).toBe(true);
    // 同 sid 反复重连(断线闪断 / 页面刷新):续期且不新增名额
    for (let i = 0; i < 20; i += 1) {
      expect(limiter.acquire('203.0.113.7', 'sid-a')).toBe(true);
    }
    expect(limiter.active('203.0.113.7')).toBe(1);
    // 续期刷新过期时刻:TTL 边界上一直活跃的会话不中途释放
    clock.advance(RELAY_ANCHOR_TTL_MS - 1000);
    limiter.acquire('203.0.113.7', 'sid-a');
    clock.advance(1000);
    expect(limiter.active('203.0.113.7')).toBe(1);
  });

  it('不同 IP 互不影响;未知 IP 为 0', () => {
    const clock = new FakeClock();
    const limiter = new IpSessionLimiter(2, RELAY_ANCHOR_TTL_MS, clock.now);
    expect(limiter.acquire('198.51.100.1', 'a')).toBe(true);
    expect(limiter.acquire('198.51.100.1', 'b')).toBe(true);
    expect(limiter.acquire('198.51.100.1', 'c')).toBe(false);
    expect(limiter.acquire('198.51.100.2', 'a')).toBe(true);
    expect(limiter.active('198.51.100.9')).toBe(0);
  });
});

// --- 默认定时器存在(接线层用)----------------------------------------------------------

describe('systemTimer', () => {
  it('提供 set/clear(真实 setTimeout 的薄包装)', () => {
    expect(typeof systemTimer.set).toBe('function');
    expect(typeof systemTimer.clear).toBe('function');
  });
});
