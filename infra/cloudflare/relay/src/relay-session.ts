/**
 * RelaySession Durable Object(设计 46 §4.3):每会话一个实例,维护 anchor(≤1)与
 * viewers(≤5)及 `did → socket` 路由表,按帧类型哑转发——只看 envelope 明文头,
 * 不理解密文内容。零持久化:无 durable 写、不记录 IP、不落任何日志存储(设计 §7)。
 *
 * 结构分两段:
 *  - `RelaySessionLogic` 纯类:全部路由 / 生命周期 / 滥用防护逻辑,构造注入 socket
 *    抽象与定时器(设计 §8 建议的 vitest-pool-workers 在本仓的 Electron-as-Node
 *    测试运行时下不可用,因此抽纯类、用 mock socket 驱动,见 README「与设计的偏离」)。
 *  - `RelaySession` DO:只做接线——WebSocket hibernation API(acceptWebSocket +
 *    tags)到 socket 抽象的适配、hibernation 唤醒后的连接重建。
 */

import {
  RELAY_ANCHOR_TTL_MS,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_VIEWERS,
  RELAY_RATE_BURST,
  RELAY_RATE_SUSTAINED_PER_SEC,
  buildInfoFrame,
  parseEnvelope,
  utf8Bytes,
  type RelayEnvelopeView,
  type RelayInfo,
  type RelayServerFrameType,
} from './envelope';

// --- socket / 定时器抽象(测试注入用)----------------------------------------------

/** DO 侧连接的最小抽象:接线层包装 Workers WebSocket,测试用内存 mock。 */
export interface RelaySocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** 一次性定时器抽象:注入以便测试用假时钟驱动 anchor TTL。 */
export interface RelayTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** 默认定时器:isolate 内 setTimeout。hibernation 会丢弃它(零 durable 写的取舍,README 有记录)。 */
export const systemTimer: RelayTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// --- 令牌桶(每连接,§4.3 滥用防护)---------------------------------------------------

/** 惰性补币的令牌桶:容量 = 突发额度,补充速率 = 持续速率。 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private capacity: number,
    private refillPerSec: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  /** 调整容量与补充速率,已有余量按容量比例缩放(anchor 按 1+viewer 数放大)。 */
  rescale(capacity: number, refillPerSec: number): void {
    if (capacity !== this.capacity && this.capacity > 0) {
      this.tokens = Math.min(capacity, (this.tokens * capacity) / this.capacity);
    }
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
  }

  /** 取一个令牌;不足时返回需要等待的毫秒数(随 info.ratelimit 告知对端)。 */
  take(): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const elapsedSec = Math.max(0, now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefillMs = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000) };
  }
}

// --- 纯路由逻辑 ---------------------------------------------------------------------

interface ConnEntry {
  sock: RelaySocket;
  /** viewer 已注册的发送方 did(anchor 恒为 null);did 随首个带 did 的帧登记。 */
  did: string | null;
  bucket: TokenBucket;
}

export interface RelaySessionLogicOptions {
  /** 本 DO 的会话 id(idFromName 的名字);envelope 的 sid 必须与它一致。 */
  sid: string;
  timer?: RelayTimer;
  now?: () => number;
  /** viewer 的 did 登记回调(接线层用它把 did 挂到 socket attachment,跨 hibernation 恢复)。 */
  onDidBound?: (sock: RelaySocket, did: string) => void;
}

/**
 * 会话内路由表与转发状态机。转发规则(设计 §4.3 的表):
 *
 * | 帧类型                      | 来源   | 动作                          |
 * | --------------------------- | ------ | ----------------------------- |
 * | event(带目标 did)         | anchor | 定向给该 viewer(未注册丢弃) |
 * | event(无 did,协议保留)   | anchor | 广播给全部 viewers            |
 * | rpc / pairing / hello       | viewer | 转发给 anchor                 |
 * | rpc / kick / error(带 did) | anchor | 定向给该 viewer(未注册丢弃) |
 * | ping                        | 任一   | 应用层回 pong                 |
 *
 * event 走定向是 WP6 三端联调的修订:E2E 加密按设备(每端点独立会话密钥),一帧
 * 密文只能服务一个端点;DO 盲广播会把 A 的密文转给 B,B 解不开(多端点下甚至
 * 互相污染到「被误踢」)。anchor 对同一事件按端点各封一帧、带 did 定向。
 *
 * DO 自产帧(pong / signal / 服务端 kick / error)走 envelope 的 info 明文字段,
 * `n` 恒 0。成员资格校验在中转之外:join 后合法性由 anchor 在 E2E 帧内校验,
 * 失败由 anchor 发 kick(设计 §4.3)。
 */
export class RelaySessionLogic {
  private readonly sid: string;
  private readonly timer: RelayTimer;
  private readonly clock: () => number;
  private readonly onDidBound?: (sock: RelaySocket, did: string) => void;
  private anchor: ConnEntry | null = null;
  private readonly viewers = new Map<RelaySocket, ConnEntry>();
  private readonly didIndex = new Map<string, RelaySocket>();
  /** anchor 断开后的保活定时器句柄;null = 未在保活窗口内。 */
  private ttlHandle: unknown = null;
  /**
   * 会话从未见过 anchor 的起始时刻(anchor 在场或已断开进保活窗口时为 null):
   * viewer 先于 anchor 加入的会话不能靠 30s ping 无限续住,超时按 session_idle 逐出。
   */
  private noAnchorSince: number | null = null;
  /** anchor 离场期间错过的 viewer_left;anchor 回来时补发(内存态,零持久化)。 */
  private readonly pendingViewerLeft = new Set<string>();

  constructor(options: RelaySessionLogicOptions) {
    this.sid = options.sid;
    this.timer = options.timer ?? systemTimer;
    this.clock = options.now ?? Date.now;
    this.onDidBound = options.onDidBound;
  }

  get hasAnchor(): boolean {
    return this.anchor !== null;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  hasViewerCapacity(): boolean {
    return this.viewers.size < RELAY_MAX_VIEWERS;
  }

  /**
   * anchor 加入(桌面主动外连)。恒 ≤1:第二个连接顶掉旧的——旧连接收
   * `signal replaced` 后关闭;保活窗口内重连则取消逐出并广播 `anchor_online`。
   */
  joinAnchor(sock: RelaySocket): void {
    const previous = this.anchor;
    // 先换人再关旧连接:旧连接的 onClose 里 anchor 已是新连接,不会误广播 offline
    this.anchor = { sock, did: null, bucket: this.newBucket() };
    if (previous) {
      this.sendInfo(previous.sock, 'signal', { kind: 'replaced' });
      previous.sock.close(1000, 'anchor replaced');
    }
    // 首个 anchor 回场也要通知先于 anchor 进场的 viewer(它们可能在等配对,
    // 手机端收到 anchor_online 会重发配对请求);TTL 窗口内重连同样通知。
    if (this.clearTtl() || this.noAnchorSince !== null)
      this.broadcastInfo('signal', { kind: 'anchor_online' });
    // anchor 回场:补发离场期间错过的 viewer_left(桌面据此清掉早退的端点)
    if (this.pendingViewerLeft.size > 0) {
      for (const did of this.pendingViewerLeft) {
        this.sendInfo(sock, 'signal', { kind: 'viewer_left', did });
      }
      this.pendingViewerLeft.clear();
    }
    this.noAnchorSince = null;
  }

  /** viewer 加入(每个遥控端一条连接);超过上限拒绝并直接关闭。 */
  joinViewer(sock: RelaySocket): boolean {
    if (!this.hasViewerCapacity()) {
      sock.close(1013, 'too many viewers');
      return false;
    }
    if (this.anchor === null) this.noAnchorSince ??= this.clock();
    this.viewers.set(sock, { sock, did: null, bucket: this.newBucket() });
    return true;
  }

  /**
   * 显式登记 viewer 的 did(接线层在 hibernation 重建时用 attachment 恢复);
   * 与「首个带 did 的帧注册」走同一条路径(bindDid)。
   */
  registerViewerDid(sock: RelaySocket, did: string): void {
    if (!this.viewers.has(sock)) return;
    this.bindDid(sock, did);
  }

  /** 收到文本帧:尺寸 / 版本 / 形状校验 → 令牌桶 → 按帧类型转发。 */
  onMessage(sock: RelaySocket, data: string): void {
    const entry = this.entryOf(sock);
    if (!entry) return; // 未 join 的连接(接线层保证先 join),忽略
    // 从未等到 anchor 的会话不能靠 ping 无限续住:与 anchor 断开的保活窗口同限,
    // 超时按 session_idle 逐出全部 viewer(审查修复;hibernation 唤醒后此时间戳
    // 丢失,退化为尽力而为)。
    if (
      this.anchor === null &&
      this.noAnchorSince !== null &&
      this.clock() - this.noAnchorSince >= RELAY_ANCHOR_TTL_MS
    ) {
      this.onTtlExpired();
      return;
    }
    if (utf8Bytes(data) > RELAY_MAX_FRAME_BYTES) {
      this.reject(sock, 'error', { kind: 'bad_frame', message: 'frame exceeds size limit' }, 1009);
      return;
    }
    const parsed = parseEnvelope(data);
    if (!parsed.ok) {
      this.reject(sock, 'error', { kind: 'bad_frame', message: parsed.message }, 1008);
      return;
    }
    if (parsed.frame.sid !== this.sid) {
      this.reject(sock, 'error', { kind: 'bad_frame', message: 'sid mismatch' }, 1008);
      return;
    }
    if (this.anchor?.sock === sock) {
      // anchor 的入站预算按在册 viewer 数放大(审查修复):同一事件按端点各封一帧,
      // 5 viewers × 10Hz 合流事件就能打满单连接 30/s 的桶而自我踢除。
      const scale = 1 + this.viewers.size;
      entry.bucket.rescale(RELAY_RATE_BURST * scale, RELAY_RATE_SUSTAINED_PER_SEC * scale);
    }
    const take = entry.bucket.take();
    if (!take.ok) {
      // 令牌桶超限:info.ratelimit 告知等待时长后断开(设计 §4.3)
      this.reject(sock, 'kick', { kind: 'ratelimit', retryAfterMs: take.retryAfterMs }, 1008);
      return;
    }
    const frame = parsed.frame;
    if (frame.type === 'ping') {
      this.sendInfo(sock, 'pong', { kind: 'pong', ts: this.clock() });
      return;
    }
    if (this.anchor?.sock === sock) this.routeFromAnchor(frame, data);
    else this.routeFromViewer(sock, frame, data);
  }

  /** 收到二进制帧:协议只有文本 JSON,直接按坏帧断开(接线层转发到这)。 */
  onBinary(sock: RelaySocket): void {
    if (!this.entryOf(sock)) return;
    this.reject(
      sock,
      'error',
      { kind: 'bad_frame', message: 'binary frames are not allowed' },
      1008,
    );
  }

  /** 连接断开:anchor → 广播 anchor_offline + 保活 TTL;viewer → 摘除路由表。 */
  onClose(sock: RelaySocket): void {
    if (this.anchor?.sock === sock) {
      this.dropAnchor();
      return;
    }
    const entry = this.viewers.get(sock) ?? null;
    const did = entry?.did ?? null;
    this.detach(sock);
    // viewer 断开通知 anchor(WP6 加固):桌面据此清端点,设备列表/托盘不再虚高。
    // did 未登记(没发过带 did 的帧)无从告知,跳过;anchor 离场期间先攒着,
    // anchor 回场时补发(审查修复:原先直接丢弃,桌面端点会永久残留)。
    if (did !== null) {
      if (this.anchor !== null)
        this.sendInfo(this.anchor.sock, 'signal', { kind: 'viewer_left', did });
      else this.pendingViewerLeft.add(did);
    }
  }

  // -- 内部 ------------------------------------------------------------------

  private newBucket(): TokenBucket {
    return new TokenBucket(RELAY_RATE_BURST, RELAY_RATE_SUSTAINED_PER_SEC, this.clock);
  }

  private entryOf(sock: RelaySocket): ConnEntry | null {
    if (this.anchor?.sock === sock) return this.anchor;
    return this.viewers.get(sock) ?? null;
  }

  private routeFromAnchor(frame: RelayEnvelopeView, raw: string): void {
    switch (frame.type) {
      case 'event': {
        // E2E 按设备加密(WP6 修订):带 did 的 event 定向;无 did 的保留广播语义
        if (frame.did !== undefined) {
          const target = this.didIndex.get(frame.did);
          if (!target) return;
          target.send(raw);
          return;
        }
        for (const viewer of this.viewers.keys()) viewer.send(raw);
        return;
      }
      case 'rpc':
      case 'pairing':
      case 'hello':
      case 'kick':
      case 'error': {
        // anchor 定向帧:带目标 did;未注册 did 的帧静默丢弃(不回错误,防探测)
        const target = frame.did === undefined ? undefined : this.didIndex.get(frame.did);
        if (!target) return;
        target.send(raw);
        if (frame.type === 'kick') {
          // kick = 踢除:送达后关闭目标连接,释放 viewer 名额(设计 §4.4 撤销链路)
          this.detach(target);
          target.close(1000, 'kicked');
        }
        return;
      }
      default:
        // pong / signal 是 DO 自产帧,anchor 不得伪造;ping 已在 onMessage 处理
        return;
    }
  }

  private routeFromViewer(sock: RelaySocket, frame: RelayEnvelopeView, raw: string): void {
    switch (frame.type) {
      case 'rpc':
      case 'pairing':
      case 'hello':
        // viewer → anchor 帧带发送方 did:首个带 did 的帧注册进路由表
        if (frame.did !== undefined) this.bindDid(sock, frame.did);
        if (this.anchor) this.anchor.sock.send(raw); // anchor 离线(TTL 窗口内)时无处转发,丢弃
        return;
      default:
        // event / kick / error / signal / pong:viewer 不得伪造 anchor 或 DO 的帧
        return;
    }
  }

  private bindDid(sock: RelaySocket, did: string): void {
    const entry = this.viewers.get(sock);
    if (!entry) return;
    const existing = this.didIndex.get(did);
    if (existing && existing !== sock) {
      // 同 did 新连接顶掉旧连接:旧连接收 signal replaced 后关闭
      this.sendInfo(existing, 'signal', { kind: 'replaced' });
      this.detach(existing);
      existing.close(1000, 'replaced');
    }
    if (entry.did !== null && this.didIndex.get(entry.did) === sock)
      this.didIndex.delete(entry.did);
    entry.did = did;
    this.didIndex.set(did, sock);
    this.onDidBound?.(sock, did);
  }

  /** 从路由表摘除(不发信号);全空时取消保活 TTL 并重置无 anchor 计时。 */
  private detach(sock: RelaySocket): void {
    const entry = this.viewers.get(sock);
    if (entry) {
      if (entry.did !== null && this.didIndex.get(entry.did) === sock) {
        this.didIndex.delete(entry.did);
      }
      this.viewers.delete(sock);
    }
    if (this.viewers.size === 0) {
      // 下一位 viewer 重新起算无 anchor 的等待窗口,不继承上一批的超时。
      this.noAnchorSince = null;
      if (this.anchor === null) this.clearTtl();
    }
  }

  /** 保活 TTL 到期:signal session_idle 后关闭全部连接,会话逐出。 */
  private onTtlExpired(): void {
    this.ttlHandle = null;
    this.broadcastInfo('signal', { kind: 'session_idle' });
    for (const sock of [...this.viewers.keys()]) {
      this.detach(sock);
      sock.close(1000, 'session idle');
    }
  }

  /** 坏帧 / 限流断开的公共路径:先发 info 帧,再摘除、关闭。 */
  private reject(
    sock: RelaySocket,
    type: RelayServerFrameType,
    info: RelayInfo,
    closeCode: number,
  ): void {
    this.sendInfo(sock, type, info);
    // 被拒的是 anchor 时同步清路由表(审查修复):否则在 close 事件到达前,
    // viewer 帧还会发给已关闭的 socket,workerd 对关闭 socket 的 send 会抛。
    if (this.anchor?.sock === sock) this.dropAnchor();
    this.detach(sock);
    sock.close(closeCode, info.kind);
  }

  /** anchor 离场的公共路径(onClose 与 reject 共用):广播 offline + 武装保活 TTL。 */
  private dropAnchor(): void {
    this.anchor = null;
    if (this.viewers.size === 0) return; // 全空即逐出:DO 无 durable 写,重建零成本
    this.broadcastInfo('signal', { kind: 'anchor_offline' });
    this.clearTtl();
    this.ttlHandle = this.timer.set(() => this.onTtlExpired(), RELAY_ANCHOR_TTL_MS);
  }

  private sendInfo(sock: RelaySocket, type: RelayServerFrameType, info: RelayInfo): void {
    sock.send(buildInfoFrame(this.sid, type, info));
  }

  private broadcastInfo(type: RelayServerFrameType, info: RelayInfo): void {
    const raw = buildInfoFrame(this.sid, type, info);
    for (const viewer of this.viewers.keys()) viewer.send(raw);
  }

  /** 取消保活定时器;返回是否确有定时器被取消。 */
  private clearTtl(): boolean {
    if (this.ttlHandle === null) return false;
    this.timer.clear(this.ttlHandle);
    this.ttlHandle = null;
    return true;
  }
}

// --- DO 接线层(hibernation API → socket 抽象)----------------------------------------

/** viewer socket 的 hibernation tag:accept 时 did 未知(tags 事后不可变),先标 pending。 */
const TAG_ANCHOR = 'anchor';
const TAG_VIEWER = 'view:pending';

interface ViewerAttachment {
  did: string;
}

/**
 * RelaySession DO:fetch 完成 WSS 升级并 join;webSocketMessage / webSocketClose
 * 转发纯类。hibernation 只保留 socket 与 tag / attachment,纯类的内存路由表在
 * 唤醒后按需重建(reconcile)。
 */
export class RelaySession {
  private readonly logic: RelaySessionLogic;
  /** WebSocket → socket 适配器;hibernation 重建后按 ws 重新映射。 */
  private readonly adapters = new Map<WebSocket, RelaySocket>();
  /** 反向映射(onDidBound 回调里找回 WebSocket,写 attachment)。 */
  private readonly sockets = new WeakMap<RelaySocket, WebSocket>();

  constructor(private readonly state: DurableObjectState) {
    this.logic = new RelaySessionLogic({
      sid: state.id.name ?? '',
      timer: systemTimer,
      // did 挂到 socket attachment:hibernation 只保留 socket 与 attachment,
      // 唤醒重建时据此恢复路由表(不写 DO storage,零 durable 写不变)
      onDidBound: (sock, did) => this.sockets.get(sock)?.serializeAttachment({ did }),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role');
    if (role !== 'anchor' && role !== 'viewer') {
      return new Response('role must be anchor or viewer', { status: 400 });
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('websocket required', { status: 426 });
    }
    // viewer 满员在升级前拒绝:客户端直接看到 HTTP 429(容量在纯类里,单线程无竞态)
    if (role === 'viewer' && !this.logic.hasViewerCapacity()) {
      return new Response('too many viewers', { status: 429 });
    }
    const [client, server] = new WebSocketPair();
    this.state.acceptWebSocket(server, [role === 'anchor' ? TAG_ANCHOR : TAG_VIEWER]);
    const sock = this.adapt(server);
    if (role === 'anchor') this.logic.joinAnchor(sock);
    else this.logic.joinViewer(sock);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const sock = this.reconcile(ws);
    if (!sock) return;
    if (typeof message === 'string') {
      this.reconcileAll();
      this.logic.onMessage(sock, message);
    } else {
      this.reconcileAll();
      this.logic.onBinary(sock);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.reconcileAll();
    const sock = this.adapters.get(ws);
    if (!sock) return; // hibernation 期间关闭、未重建过的连接:无需清理内存态
    this.adapters.delete(ws);
    this.logic.onClose(sock);
  }

  /**
   * 本 DO 名下全部存活 socket 对账进内存路由表（幂等,已知的直接跳过）。
   *
   * hibernation 对账缺口（真机实测 2026-10:首扫永远无反馈、重扫秒成）:唤醒后
   * 若只 reconcile 发送方,对端还挂在 hibernation 里不在内存路由表——viewer 的
   * 首条配对请求会命中「anchor 不在 → 静默丢弃」,反方向 accept/done 也会因
   * didIndex 空而丢帧。任何入站事件先全量对账;发送到 hibernated socket 是 DO
   * 的正规能力,唤醒即达。
   */
  private reconcileAll(): void {
    for (const ws of this.state.getWebSockets(TAG_ANCHOR)) this.reconcile(ws);
    for (const ws of this.state.getWebSockets(TAG_VIEWER)) this.reconcile(ws);
  }

  /**
   * hibernation 唤醒后的连接重建:内存路由表已丢,按 tag 判定 anchor;viewer 的
   * did 从 attachment 恢复(跨 hibernation 持久挂在 socket 上,不写 DO storage)。
   */
  private reconcile(ws: WebSocket): RelaySocket | undefined {
    const known = this.adapters.get(ws);
    if (known) return known;
    const sock = this.adapt(ws);
    if (this.state.getWebSockets(TAG_ANCHOR).includes(ws)) {
      this.logic.joinAnchor(sock);
      return sock;
    }
    if (!this.logic.joinViewer(sock)) return undefined; // 满员(重建期尽力而为)
    const did = RelaySession.readDid(ws);
    if (did !== undefined) this.logic.registerViewerDid(sock, did);
    return sock;
  }

  /** 读取 socket attachment 里的 did;未登记过(或损坏)时返回 undefined。 */
  private static readDid(ws: WebSocket): string | undefined {
    try {
      const did = (ws.deserializeAttachment() as ViewerAttachment | null)?.did;
      return typeof did === 'string' ? did : undefined;
    } catch {
      return undefined;
    }
  }

  private adapt(ws: WebSocket): RelaySocket {
    const existing = this.adapters.get(ws);
    if (existing) return existing;
    const sock: RelaySocket = {
      send: (text) => ws.send(text),
      close: (code, reason) => ws.close(code, reason),
    };
    this.adapters.set(ws, sock);
    this.sockets.set(sock, ws);
    return sock;
  }
}
