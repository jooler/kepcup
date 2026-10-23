import {
  AppError,
  DEFAULT_RELAY_URL,
  RPC_EVENT_NAMES,
  relayEndpointSchema,
  relayHelloPayloadSchema,
  relayPairingPayloadSchema,
  type PairedDevice,
  type PairingOffer,
  type RelayEnvelope,
  type RemoteAnchorState,
  type RemoteStatusOutput,
  type RpcEventName,
  type RpcMethodSpec,
  type RpcTransport,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { EventBus } from '../infra/events.js';
import type { CoreEventsMap } from '../start-types.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { AuditService } from '../domain/audit.js';
import type { SecretsService } from '../domain/secrets.js';
import type { SettingsService } from '../domain/settings.js';
import { createRpcServer, type RpcServerHandle } from '../rpc/server.js';
import { withRemoteSource } from './audit.js';
import { FrameCodec, RelayProtocolError, type SessionKeys } from './codec.js';
import { PairingService, type PairingOutcomeFrames } from './pairing.js';
import { RelayClient, type RelayClientOptions } from './relay-client.js';

/**
 * 收发中枢（D96 §4.2）：端点注册表（`remote:{deviceId}`），每个在线遥控端点
 * 实例化一个 `createRpcServer`，绑定与本机 renderer **同一份 handlers**
 *（`services.appMethods`）——功能对等由此免费获得。事件总线订阅 → `event` 帧
 * 广播；`run.progress` 等高频事件合流 ≤10Hz（保留最新）；rpc 响应帧带目标
 * `did` 定向。本机 renderer 的直连路径（MessagePort）零改动。
 */

/** 合流的高频事件（§4.2：同类 ≤10Hz、保留最新；key 再按 runId 细分）。 */
const COALESCED_EVENTS = new Set<RpcEventName>(['run.progress']);
/** 合流冲刷周期（10Hz）。 */
const COALESCE_FLUSH_MS = 100;
/**
 * viewer_left 的清端点宽限期：手机切网时新连接的 hello 可能早于旧 socket 迟到的
 * close，宽限内任何该 did 的入站帧都会取消清理，避免误杀活端点。
 */
const VIEWER_LEFT_GRACE_MS = 5_000;
/** 仅本机可调的方法（测试缝）：不暴露给远程端点的方法表。 */
const LOCAL_ONLY_METHODS = new Set(['remote.testInjectPairing']);

interface Endpoint {
  deviceId: string;
  codec: FrameCodec;
  server: RpcServerHandle;
  onData: ((data: unknown) => void) | null;
  transport: RpcTransport;
}

/** RelayClient 的结构子集（DI 接缝：测试注入假中转客户端）。 */
export interface RelayClientLike {
  readonly state: RemoteAnchorState;
  readonly url: string;
  connect(): void;
  send(envelope: RelayEnvelope): void;
  sendAll(envelopes: readonly RelayEnvelope[]): void;
  close(): void;
}

export interface RemoteHubDeps {
  db: SqliteDatabase;
  secrets: SecretsService;
  settings: SettingsService;
  events: EventBus<CoreEventsMap>;
  audit: AuditService;
  clock: Clock;
  logger: CoreLogger;
  /** 与本机 renderer 同一份 handlers（bindAppMethods 产物）；getter 保证拿到最终版。 */
  appMethods: () => Record<string, RpcMethodSpec>;
  /**
   * 端点建立（hello 校验通过）时推当前状态快照（core.status / platform.autostart）。
   * 与本地通道绑定时 pushStatusTo 的契约对齐：App 的启动门槛等的是 core.status，
   * 而事件扇出只在「变化」时发生——core 早已 ready 的情况下手机永远等不到首帧，
   * 会卡在「核心服务启动中」。
   */
  pushInitialEventsTo: (server: RpcServerHandle) => void;
  /** 测试注入：不真连 WSS。 */
  relayClientFactory?: (options: RelayClientOptions) => RelayClientLike;
}

export class RemoteHub {
  readonly #deps: RemoteHubDeps;
  readonly pairing: PairingService;
  #relay: RelayClientLike | null = null;
  #anchorState: RemoteAnchorState = 'off';
  #anchorReason: string | undefined;
  readonly #endpoints = new Map<string, Endpoint>();
  /** 合流缓冲：`${event}:${runId}` → 最新 payload（保留最新，定时冲刷）。 */
  readonly #coalesced = new Map<string, { name: RpcEventName; payload: unknown }>();
  #coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  /** viewer_left 宽限期定时器：did → timer。入站帧或实际清理时移除。 */
  readonly #pendingLeftCleanup = new Map<string, ReturnType<typeof setTimeout>>();
  #unsubscribers: Array<() => void> = [];
  #closed = false;

  constructor(deps: RemoteHubDeps) {
    this.#deps = deps;
    this.pairing = new PairingService({
      db: deps.db,
      secrets: deps.secrets,
      clock: deps.clock,
      logger: deps.logger,
      events: deps.events,
      audit: deps.audit,
    });
  }

  /** 启动 / 重配（start.ts 在 ready 后调用；设置变化后也调用）。 */
  start(): void {
    this.#unsubscribers.push(
      this.#deps.events.on('settings.changed', () => {
        void this.syncConfig();
      }),
    );
    for (const name of RPC_EVENT_NAMES) {
      this.#unsubscribers.push(
        this.#deps.events.on(name, (payload) => {
          this.#fanOut(name, payload);
        }),
      );
    }
    void this.syncConfig();
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    this.#relay?.close();
    this.#relay = null;
    for (const timer of this.#pendingLeftCleanup.values()) clearTimeout(timer);
    this.#pendingLeftCleanup.clear();
    for (const endpoint of this.#endpoints.values()) this.#dropEndpoint(endpoint.deviceId);
    if (this.#coalesceTimer !== null) {
      clearTimeout(this.#coalesceTimer);
      this.#coalesceTimer = null;
    }
  }

  /** 读设置里的开关与中转地址，建立 / 断开 anchor 连接。 */
  async syncConfig(): Promise<void> {
    if (this.#closed) return;
    const settings = this.#deps.settings.get();
    if (!settings.remoteEnabled) {
      this.#relay?.close();
      this.#relay = null;
      for (const endpoint of this.#endpoints.values()) this.#dropEndpoint(endpoint.deviceId);
      this.#setAnchorState('off');
      return;
    }
    // 存储值不合法时回退默认并留痕（审查修复：原先 .catch 静默吞掉，配置坏了
    // 只会表现为「连的不是我以为的地址」）。
    const parsedUrl = relayEndpointSchema.safeParse(settings.remoteRelayUrl);
    if (!parsedUrl.success) {
      this.#deps.logger.warn(
        { stored: settings.remoteRelayUrl, fallback: DEFAULT_RELAY_URL },
        'remote: 存储的中转地址不合法，回退默认值',
      );
    }
    const relayUrl = parsedUrl.success ? parsedUrl.data : DEFAULT_RELAY_URL;
    const sessionId = this.pairing.sessionUlid();
    if (this.#relay !== null) {
      // 地址没变就不折腾；变了先断（close 会回 off，connect 走 connecting→online）。
      if (this.#relay.url.startsWith(`${relayUrl.replace(/\/+$/, '')}/`)) return;
      this.#relay.close();
      this.#relay = null;
    }
    const relay =
      this.#deps.relayClientFactory !== undefined
        ? this.#deps.relayClientFactory({
            relayUrl,
            sessionId,
            clock: this.#deps.clock,
            logger: this.#deps.logger,
            onStateChange: (state, reason) => this.#setAnchorState(state, reason),
            onFrame: (envelope) => this.#onRelayFrame(envelope),
          })
        : new RelayClient({
            relayUrl,
            sessionId,
            clock: this.#deps.clock,
            logger: this.#deps.logger,
            onStateChange: (state, reason) => this.#setAnchorState(state, reason),
            onFrame: (envelope) => this.#onRelayFrame(envelope),
          });
    this.#relay = relay;
    relay.connect();
  }

  // --- remote.* RPC handlers（bindings.ts 委托到这里）--------------------------

  status(): RemoteStatusOutput {
    const settings = this.#deps.settings.get();
    const onlineDeviceIds = [...this.#endpoints.keys()];
    return {
      enabled: settings.remoteEnabled,
      relayUrl: settings.remoteRelayUrl,
      anchor: this.#anchorState,
      ...(this.#anchorReason !== undefined ? { anchorReason: this.#anchorReason } : {}),
      sessionId: settings.remoteEnabled ? this.pairing.sessionUlid() : null,
      onlineDeviceIds,
      pendingPairing: this.pairing.pendingRequests(),
    };
  }

  createPairing(): PairingOffer {
    const settings = this.#deps.settings.get();
    if (!settings.remoteEnabled) {
      throw new AppError('INVALID_STATE', '远程遥控未开启（先打开总开关）');
    }
    return this.pairing.createOffer(settings.remoteRelayUrl);
  }

  confirmPairing(
    requestId: string,
    accept: boolean,
  ): { status: 'paired'; device: PairedDevice } | { status: 'declined' } | { status: 'gone' } {
    const outcome = this.pairing.confirm(requestId, accept);
    for (const frames of outcome.frames) this.#sendOutcome(frames);
    if (outcome.status === 'paired' && outcome.device !== undefined) {
      return { status: 'paired', device: outcome.device };
    }
    if (outcome.status === 'declined') return { status: 'declined' };
    return { status: 'gone' };
  }

  revokeDevice(deviceId: string): PairedDevice {
    const device = this.pairing.revoke(deviceId);
    const endpoint = this.#endpoints.get(deviceId);
    if (endpoint !== undefined) {
      // 先发密文 kick（设备侧知道原因并自行断开），再清端点。
      this.#sendTo(endpoint, 'kick', { reason: 'revoked' } satisfies { reason: 'revoked' });
      this.#dropEndpoint(deviceId);
    }
    this.#publishAnchorState();
    return device;
  }

  devices(): { devices: PairedDevice[] } {
    return { devices: this.pairing.listDevices((deviceId) => this.#endpoints.has(deviceId)) };
  }

  configGet(): { enabled: boolean; relayUrl: string } {
    const settings = this.#deps.settings.get();
    return { enabled: settings.remoteEnabled, relayUrl: settings.remoteRelayUrl };
  }

  configSet(patch: { enabled?: boolean; relayUrl?: string }): {
    enabled: boolean;
    relayUrl: string;
  } {
    const settings = this.#deps.settings.update({
      ...(patch.enabled !== undefined ? { remoteEnabled: patch.enabled } : {}),
      ...(patch.relayUrl !== undefined ? { remoteRelayUrl: patch.relayUrl } : {}),
    });
    void this.syncConfig();
    return { enabled: settings.remoteEnabled, relayUrl: settings.remoteRelayUrl };
  }

  // --- 中转帧入口（RelayClient.onFrame）---------------------------------------

  #onRelayFrame(envelope: RelayEnvelope): void {
    if (this.#closed || this.#relay === null) return;
    if (envelope.type === 'signal') {
      // viewer_left（WP6 加固，DO → anchor 定向）：设备断开，宽限后清端点——
      // 设备列表 / 托盘的在线状态不再虚高；宽限内的任何入站帧（重连的旧 socket
      // 迟到 close）会取消清理，见 #scheduleLeftCleanup。
      const info = envelope.info;
      if (info?.kind === 'viewer_left' && typeof info.did === 'string') {
        this.#scheduleLeftCleanup(info.did);
        return;
      }
      this.#deps.logger.debug({ info: info?.kind }, 'relay signal (anchor side)');
      return;
    }
    if (envelope.type === 'error') {
      this.#deps.logger.warn({ info: envelope.info?.kind }, 'relay error frame');
      return;
    }
    const did = envelope.did;
    if (did === undefined) return;
    if (envelope.type === 'pairing') {
      const payload = relayPairingPayloadSchema.safeParse(envelope.data);
      if (!payload.success) return;
      const outcome = this.pairing.handleRequest(envelope, payload.data);
      for (const frames of outcome.frames) this.#sendOutcome(frames);
      return;
    }
    if (envelope.type === 'rpc' || envelope.type === 'hello' || envelope.type === 'event') {
      this.#deliverEncrypted(envelope, did);
      return;
    }
    // kick / pong / ping 不应到达 anchor（DO 处理或发给 viewer）。
  }

  /** 解密并投递 viewer → anchor 的密文帧（hello / rpc / event 回流）。 */
  #deliverEncrypted(envelope: RelayEnvelope, did: string): void {
    let endpoint = this.#endpoints.get(did);
    let replaced: Endpoint | null = null;
    if (endpoint !== undefined && envelope.type === 'hello') {
      // 重连自举（§4.4）：viewer 换 socket 后 hello 重来。先验证密钥仍在（撤销 →
      // kick），再重建端点并移植旧 codec 的双向计数（WP6 审查修复 P0/P1：出站
      // 续号——viewer 持久化的入站水位不会被打回归零的计数判成重放；入站窗口
      // 保留——同一条捕获的 hello 无法被不可信中转重放）。旧端点保持到 hello
      // 校验通过才关闭：重放与撤销都不会打断在途 RPC。viewer 密钥流整体重启
      // （桌面重启 / 重装，无旧 codec 可移植）由 viewer 侧入站窗口每连接重建兜底。
      const keys = this.pairing.deviceKeys(did);
      if (keys === null) {
        // 配对被撤销 / 密钥已清：踢掉旧端点。
        this.#sendTo(endpoint, 'kick', { reason: 'auth_failed' });
        this.#dropEndpoint(did);
        return;
      }
      replaced = endpoint;
      endpoint = this.#createEndpoint(did, keys);
      endpoint.codec.adoptCountersFrom(replaced.codec);
    } else if (endpoint === undefined) {
      if (envelope.type !== 'hello') return; // 未自举先说话：忽略
      const keys = this.pairing.deviceKeys(did);
      if (keys === null) {
        // 未配对 / 已撤销的设备发来密文帧 → 无从解密，忽略（DO 侧它仍在会话里，
        // 若其行为异常会触发限流；设备侧拿不到任何明文）。
        this.#deps.logger.warn({ did }, 'remote: frame from unknown device ignored');
        return;
      }
      endpoint = this.#createEndpoint(did, keys);
    }
    let opened: { complete: boolean; payload?: unknown };
    try {
      opened = endpoint.codec.open(envelope);
    } catch (error) {
      if (error instanceof RelayProtocolError) {
        this.#deps.logger.warn({ did, code: error.code }, 'remote frame rejected');
        if (error.code === 'AUTH_FAILED') {
          this.#sendTo(endpoint, 'kick', { reason: 'auth_failed' });
          this.#dropEndpoint(did);
        }
        this.#closeReplaced(replaced);
        return;
      }
      throw error;
    }
    // 该设备有能通过校验的新帧即视为活着：取消 viewer_left 的待清理（重连竞态
    // 保护）。放在解密成功之后（审查修复）：中转伪造的带 did 垃圾帧不应为僵尸
    // 端点无限续命。
    const pendingCleanup = this.#pendingLeftCleanup.get(did);
    if (pendingCleanup !== undefined) {
      clearTimeout(pendingCleanup);
      this.#pendingLeftCleanup.delete(did);
    }
    if (!opened.complete) {
      this.#closeReplaced(replaced);
      return;
    }
    if (envelope.type === 'hello') {
      const hello = relayHelloPayloadSchema.safeParse(opened.payload);
      if (!hello.success) {
        this.#closeReplaced(replaced);
        return;
      }
      const verdict = this.pairing.verifyReconnect(did, hello.data.token);
      if (!verdict.ok) {
        this.#sendTo(endpoint, 'kick', { reason: verdict.reason });
        this.#dropEndpoint(did);
        this.#closeReplaced(replaced);
        return;
      }
      this.#closeReplaced(replaced);
      // 状态快照先行（本地通道绑定同款契约）：App 等 core.status 才开始加载数据。
      this.#deps.pushInitialEventsTo(endpoint.server);
      this.#deps.events.emit('remote.deviceChanged', {
        change: 'online',
        device: { ...verdict.device, online: true },
      });
      this.#publishAnchorState();
      return;
    }
    this.#closeReplaced(replaced);
    // rpc / event 回流：直接喂该端点的 birpc server。
    endpoint.onData?.(opened.payload);
  }

  /** hello 重自举收尾：关闭被替换的旧端点（已关闭的 birpc 再关会抛，吞掉）。 */
  #closeReplaced(replaced: Endpoint | null): void {
    if (replaced === null) return;
    try {
      replaced.server.close();
    } catch {
      // 关闭中的 birpc 再关会抛，忽略。
    }
  }

  // --- 端点生命周期 ------------------------------------------------------------

  #createEndpoint(deviceId: string, keys: SessionKeys): Endpoint {
    const sid = this.pairing.sessionUlid();
    const codec = new FrameCodec(keys, sid, 'anchor');
    const endpoint: Endpoint = {
      deviceId,
      codec,
      server: null as never,
      onData: null,
      transport: {
        post: (data) => {
          // birpc v4：请求 `{t:'q', i:<nanoid>}` / 响应 `{t:'s', i}`；rid 透传到
          // envelope 供观测（中转不读）。
          const raw = data as { i?: unknown };
          const rid = typeof raw.i === 'string' && raw.i.length > 0 ? raw.i : undefined;
          this.#sendTo(endpoint, 'rpc', data, rid);
        },
        onData: (handler) => {
          endpoint.onData = handler;
          return () => {
            if (endpoint.onData === handler) endpoint.onData = null;
          };
        },
        close: () => this.#dropEndpoint(deviceId),
      },
    };
    // 同一份 handlers，包一层远程来源标记（审计带 remote:{deviceId}，§5.3）。
    // 测试缝只注册本机（审查修复）：远程端点的方法表里不该出现 remote.testInjectPairing。
    const methods: Record<string, RpcMethodSpec> = {};
    for (const [name, spec] of Object.entries(this.#deps.appMethods())) {
      if (LOCAL_ONLY_METHODS.has(name)) continue;
      methods[name] = {
        ...spec,
        handle: (input) => withRemoteSource(deviceId, () => spec.handle(input)),
      };
    }
    endpoint.server = createRpcServer({
      transport: endpoint.transport,
      methods,
      onError: (method, error) => {
        this.#deps.logger.warn({ did: deviceId, method, code: error.code }, 'remote rpc failed');
      },
    });
    this.#endpoints.set(deviceId, endpoint);
    return endpoint;
  }

  #dropEndpoint(deviceId: string): void {
    const endpoint = this.#endpoints.get(deviceId);
    if (endpoint === undefined) return;
    this.#endpoints.delete(deviceId);
    try {
      endpoint.server.close();
    } catch {
      // 关闭中的 birpc 再关会抛，忽略。
    }
    const device = this.pairing.deviceView(deviceId);
    if (device !== null) {
      this.#deps.events.emit('remote.deviceChanged', {
        change: 'offline',
        device: { ...device, online: false },
      });
    }
    this.#publishAnchorState();
  }

  // --- 出站帧 ------------------------------------------------------------------

  #sendTo(endpoint: Endpoint, type: 'rpc' | 'kick', payload: unknown, rid?: string): void {
    if (this.#relay === null || this.#relay.state !== 'online') return;
    let frames: RelayEnvelope[];
    try {
      frames = endpoint.codec.seal(type, payload, {
        did: endpoint.deviceId,
        ...(rid !== undefined ? { rid } : {}),
      });
    } catch (error) {
      this.#deps.logger.warn(
        { did: endpoint.deviceId, error: String(error) },
        'remote seal failed',
      );
      return;
    }
    this.#relay.sendAll(frames);
  }

  #sendOutcome(frames: PairingOutcomeFrames): void {
    if (this.#relay === null || this.#relay.state !== 'online') {
      // 设备已登记但 accept/done 送不出去：遥控端会停在等待态。必须留痕——桌面
      // 提示「配对成功」与手机实际状态在这里分叉，日志是唯一线索。
      this.#deps.logger.warn(
        { did: frames.deviceId, relay: this.#relay?.state ?? 'none' },
        'remote: 配对回执帧未送达（中转不在线）',
      );
      return;
    }
    this.#relay.sendAll(frames.plaintext);
    if (frames.sealed.length > 0) {
      // done 帧按目标设备新密钥直接发（不经过端点表——端点在 hello 后才建立）。
      this.#relay.sendAll(frames.sealed);
    }
  }

  // --- 事件扇出与合流（§4.2）---------------------------------------------------

  #fanOut(name: RpcEventName, payload: unknown): void {
    if (this.#endpoints.size === 0 || this.#relay === null || this.#relay.state !== 'online') {
      return;
    }
    if (!COALESCED_EVENTS.has(name)) {
      this.#broadcast(name, payload);
      return;
    }
    const discriminator =
      typeof payload === 'object' && payload !== null && 'runId' in payload
        ? String((payload as { runId: unknown }).runId)
        : '';
    this.#coalesced.set(`${name}:${discriminator}`, { name, payload });
    if (this.#coalesceTimer === null) {
      this.#coalesceTimer = setTimeout(() => {
        this.#coalesceTimer = null;
        this.#flushCoalesced();
      }, COALESCE_FLUSH_MS);
    }
  }

  #flushCoalesced(): void {
    const pending = [...this.#coalesced.values()];
    this.#coalesced.clear();
    for (const { name, payload } of pending) this.#broadcast(name, payload);
  }

  /** viewer_left 后的宽限清理：到点仍无该 did 的入站帧才真正清端点。 */
  #scheduleLeftCleanup(deviceId: string): void {
    if (this.#closed || !this.#endpoints.has(deviceId)) return;
    const existing = this.#pendingLeftCleanup.get(deviceId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#pendingLeftCleanup.delete(deviceId);
      if (this.#endpoints.has(deviceId)) this.#dropEndpoint(deviceId);
    }, VIEWER_LEFT_GRACE_MS);
    this.#pendingLeftCleanup.set(deviceId, timer);
  }

  #broadcast(name: RpcEventName, payload: unknown): void {
    if (this.#relay === null || this.#relay.state !== 'online') return;
    for (const endpoint of this.#endpoints.values()) {
      // E2E 按设备加密（WP6 修订）：每个端点独立封帧并带目标 did，DO 侧按 did
      // 定向——密文广播给「错的」设备只会解密失败，还会污染对端入站流。
      try {
        const frames = endpoint.codec.seal('event', { name, payload }, { did: endpoint.deviceId });
        this.#relay.sendAll(frames);
      } catch (error) {
        // 单端点封帧失败（如超 8MB 事件）只丢该端点的这一条（审查修复：原先未
        // 捕获，会被 EventBus 的 emit 吞掉，所有遥控端静默丢事件、零日志）。
        this.#deps.logger.warn(
          { did: endpoint.deviceId, event: name, error: String(error) },
          'remote event seal failed',
        );
      }
    }
  }

  // --- 状态发布 ----------------------------------------------------------------

  #setAnchorState(state: RemoteAnchorState, reason?: string): void {
    this.#anchorState = state;
    this.#anchorReason = reason;
    this.#publishAnchorState();
  }

  #publishAnchorState(): void {
    const payload = {
      state: this.#anchorState,
      ...(this.#anchorReason !== undefined ? { reason: this.#anchorReason } : {}),
      onlineDevices: this.#endpoints.size,
    };
    this.#deps.events.emit('remote.anchorState', payload);
    // 托盘（端口 B）：同一时刻的多带 enabled 的副本（platformEventSchemas）。
    this.#deps.events.emit('platform.remoteState', {
      ...payload,
      enabled: this.#deps.settings.get().remoteEnabled,
    });
  }

  /** 测试 / 诊断：当前端点表。 */
  endpointIds(): string[] {
    return [...this.#endpoints.keys()];
  }
}
