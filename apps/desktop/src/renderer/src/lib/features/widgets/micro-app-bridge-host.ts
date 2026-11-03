import {
  MICRO_APP_BRIDGE_HOST_SOURCE,
  MICRO_APP_EVENT_WINDOW_MAX,
  BOT_WIDGET_QUERY_NAME_MAX_CHARS,
  BOT_WIDGET_STORAGE_KEY_MAX_CHARS,
  WIDGET_REPLY_MAX_CHARS,
  microAppCapabilityOf,
  microAppErrorHintOf,
  microAppApiMethodOf,
  type WidgetsUiQueryCall,
  type WidgetsUiQueryOutput,
  type WidgetsUiStorageCall,
  type WidgetsUiStorageOutput,
} from '@kepcup/shared';
import { normalizeAppLink } from '../apps-ui/bridge-guard';
import {
  microAppAckFrame,
  microAppCloseFrame,
  microAppErrorFrame,
  microAppEventFrame,
  microAppBridgeMessageId,
  parseMicroAppBridgeFrame,
  type MicroAppBridgeHostFrame,
} from './micro-app-bridge-guard';
import type { WidgetBridgeListenerTarget } from './widget-bridge-host';

/** 宿主文档当前是否处于用户激活（iframe 内的点击会传播上来）。 */
function hostUserActivation(): boolean {
  if (typeof navigator === 'undefined') return true;
  const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
  return activation === undefined ? true : activation.isActive;
}

/** `app.ready()` 的回执（55 §6.2）：能力协商是唯一依据，不靠错误码试探。 */
export interface MicroAppReadyInfo {
  capabilities: string[];
  grants: {
    mic: 'granted' | 'denied' | 'unavailable';
    net: { mode: 'open' | 'allowlist' | 'none'; domains: string[] };
  };
  theme: 'light' | 'dark';
  displayMode: 'inline' | 'immersive';
  viewport: { width: number; height: number };
  instanceId: string;
}

export interface MicroAppBridgeHostOptions {
  /** iframe 的 `contentWindow`（必须已挂到 DOM；WindowProxy 在导航后仍有效）。 */
  frameWindow: Window;
  /** 一次性资源凭据：core 用它反查 widgetId（KV 命名空间）与存活。 */
  resourceId: string;
  /** 生效版本声明的能力（执行期能力路由的依据，来自版本行而非运行时自述）。 */
  permissions: readonly string[];
  /** 生效版本的网络档位（grants.net 的来源）。 */
  net: { mode: 'open' | 'allowlist' | 'none'; domains: readonly string[] };
  /** 建桥时的宿主主题。 */
  theme: 'light' | 'dark';
  /** 清单的展示模式（P0 只透传；P1 外壳接 requestDisplayMode）。 */
  displayMode: 'inline' | 'immersive';
  /** 视口尺寸（app.ready 返回给微应用）。 */
  viewport: { width: number; height: number };
  /** 转发 `widgets.ui.storage`（卡片负责 schema.parse + 错误透传）。 */
  storage(input: WidgetsUiStorageCall): Promise<WidgetsUiStorageOutput>;
  /** 转发 `widgets.ui.query`。 */
  query(input: WidgetsUiQueryCall): Promise<WidgetsUiQueryOutput>;
  /** 外链确认（卡片出确认条；resolve = 用户同意且打开成功）。 */
  openLink(url: string): Promise<boolean>;
  /** 回传：卡片出确认条；resolve = 用户同意且已作为用户消息发出。 */
  reply(text: string): Promise<boolean>;
  /** `app.setTitle`（外壳标题栏；通知，无回执）。 */
  onTitle(title: string): void;
  /** P1：麦克风授权态（会话授权；撤销时宿主改回传并推 capability.revoked）。 */
  micGrant?: () => 'granted' | 'denied' | 'unavailable';
  /** P1：`ai.*` / `media.*` / `app.requestDisplayMode` / `app.close` 的宿主实现。 */
  aiCall?(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** P1：建一个监听会话（宿主代理采集 + VAD；sink = 事件出口；instanceId = RPC 记账键）。 */
  createListenSession?(
    config: { lang?: string; mode: 'push-to-talk' | 'vad'; silenceMs: number },
    sink: (name: string, data: unknown) => void,
    instanceId: string,
  ): { start(): Promise<void>; stop(): Promise<void>; dispose(): void };
  /** P1：speak / stopSpeaking（TTS 队列，可打断）。 */
  speak?(input: { text: string; voice?: string; rate?: number }): Promise<void>;
  stopSpeaking?(): void;
  /** P1：展示模式请求（经外壳，不直接改窗口）。 */
  onRequestDisplayMode?(mode: 'inline' | 'immersive'): Promise<{ mode: 'inline' | 'immersive' }>;
  /** P1：微应用请求关闭（通知，无回执）。 */
  onClose?(): void;
  /** 回传前核验用户手势（测试注入）。 */
  userActivation?: (() => boolean) | undefined;
  /** 监听目标；缺省全局 window（测试注入假体）。 */
  listenerTarget?: WidgetBridgeListenerTarget | undefined;
}

let instanceCounter = 0;

/**
 * 微应用能力桥宿主 v2（D112，设计 55 §6.3）：只收来自这一个 iframe 窗口的消息，
 * 帧过 `micro-app-bridge-guard`，**分派前按生效版本的 permissions 做能力路由**——
 * 未声明的能力得 `MICRO_APP_CAPABILITY_NOT_DECLARED`（code + hint 同源于 spec）。
 * `app.ready` 返回能力协商快照；事件（主题等）走 `event` 帧（`subId='app'`），带
 * seq，微应用回 `event-ack`；未确认窗口超过上限时宿主发 `close` 帧断开（背压，
 * 55 §6.3）。
 */
export class MicroAppBridgeHost {
  readonly #frameWindow: Window;
  readonly #options: MicroAppBridgeHostOptions;
  readonly #target: WidgetBridgeListenerTarget;
  readonly #listener: (event: MessageEvent) => void;
  #destroyed = false;
  #theme: 'light' | 'dark';
  #displayMode: 'inline' | 'immersive';
  readonly #instanceId = `mai_${Date.now().toString(36)}_${++instanceCounter}`;
  /** 每个事件通道的 seq 与已确认水位（背压窗口）。 */
  readonly #seq = new Map<string, number>();
  readonly #acked = new Map<string, number>();
  /** 在途 call 的取消登记（cancel 帧 / destroy 时拒绝回执）。 */
  readonly #cancelled = new Set<number>();
  /** P1：media.listen 的会话表（channelId → 会话；destroy 即释放麦克风）。 */
  readonly #listenSessions = new Map<string, { start(): Promise<void>; stop(): Promise<void>; dispose(): void }>();

  private constructor(options: MicroAppBridgeHostOptions) {
    this.#frameWindow = options.frameWindow;
    this.#options = options;
    this.#theme = options.theme;
    this.#displayMode = options.displayMode;
    this.#target = options.listenerTarget ?? window;
    this.#listener = (event) => {
      void this.#handle(event);
    };
  }

  /** 创建桥并开始监听（须在设置 iframe `src` 之前调用）。 */
  static connect(options: MicroAppBridgeHostOptions): MicroAppBridgeHost {
    const host = new MicroAppBridgeHost(options);
    host.#target.addEventListener('message', host.#listener);
    return host;
  }

  /** 实例 id（`mai_…`；RPC 记账与流式事件过滤的键）。 */
  get instanceId(): string {
    return this.#instanceId;
  }

  /** 拆桥（卡片卸载 / 重载 / 背压断开）：释放监听会话（麦克风）后通知微应用并移除监听。 */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const session of this.#listenSessions.values()) session.dispose();
    this.#listenSessions.clear();
    this.#post(microAppCloseFrame('bridge closed'));
    this.#target.removeEventListener('message', this.#listener);
  }

  /** 能力撤销（55 §5.3）：停采集并通知微应用 `capability.revoked`。 */
  revokeCapability(capability: string): void {
    if (this.#destroyed) return;
    if (capability === 'media.listen') {
      for (const session of this.#listenSessions.values()) session.dispose();
      this.#listenSessions.clear();
    }
    this.pushAppEvent('capability.revoked', { capability });
  }

  /** P1：core `micro-app.stream` 事件的转发面（delta / done / error → 桥 v2 event 帧）。 */
  forwardStreamEvent(payload: { instanceId: string; streamId: string; kind: string; delta?: string; code?: string }): void {
    if (this.#destroyed || payload.instanceId !== this.#instanceId) return;
    if (payload.kind === 'delta') {
      this.#pushEvent(payload.streamId, 'delta', { delta: payload.delta ?? '' });
    } else if (payload.kind === 'done') {
      this.#pushEvent(payload.streamId, 'done', null);
    } else if (payload.kind === 'error') {
      this.#pushEvent(payload.streamId, 'error', { code: payload.code ?? 'MICRO_APP_AI_UNAVAILABLE' });
    }
  }

  /** 应用切换明暗主题：经 `event` 帧推到 `app` 通道（垫片更新 data-theme 并派发事件）。 */
  setTheme(theme: 'light' | 'dark', options: { force?: boolean } = {}): void {
    if (this.#destroyed || (theme === this.#theme && options.force !== true)) return;
    this.#theme = theme;
    this.#pushEvent('app', 'theme', theme);
  }

  /** 宿主主动推事件（pause / resume / capability.revoked 等，P1/P2 使用）。 */
  pushAppEvent(name: string, data: unknown): void {
    if (this.#destroyed) return;
    this.#pushEvent('app', name, data);
  }

  #pushEvent(subId: string, name: string, data: unknown): void {
    const seq = (this.#seq.get(subId) ?? 0) + 1;
    this.#seq.set(subId, seq);
    this.#post(microAppEventFrame(subId, name, data, seq));
    // 背压：未确认事件超过窗口上限即断开（微应用侧 seq 缺口同样会本地重置）。
    if (seq - (this.#acked.get(subId) ?? 0) > MICRO_APP_EVENT_WINDOW_MAX) {
      this.destroy();
    }
  }

  #post(frame: MicroAppBridgeHostFrame): void {
    try {
      this.#frameWindow.postMessage(frame, '*');
    } catch {
      // iframe 已卸载：下次挂载按新状态 open。
    }
  }

  async #handle(event: MessageEvent): Promise<void> {
    if (this.#destroyed) return;
    if (event.source !== this.#frameWindow) return;
    const parsed = parseMicroAppBridgeFrame(event.data);
    if (!parsed.ok) {
      const id = microAppBridgeMessageId(event.data);
      if (id !== null) {
        this.#post(microAppErrorFrame(id, 'INVALID_INPUT', '不支持的消息格式'));
      }
      return;
    }
    const frame = parsed.frame;
    if (frame.k === 'event-ack') {
      this.#acked.set(frame.subId, Math.max(this.#acked.get(frame.subId) ?? 0, frame.seq));
      return;
    }
    if (frame.k === 'cancel') {
      if (typeof frame.target === 'number') this.#cancelled.add(frame.target);
      return;
    }
    if (frame.k === 'stream') {
      // P0 没有流式能力面；绑定请求得到可行动的错误而不是挂起。
      this.#post(
        microAppErrorFrame(
          frame.id,
          'MICRO_APP_CAPABILITY_NOT_DECLARED',
          '当前没有可绑定的流式能力',
          microAppErrorHintOf('MICRO_APP_CAPABILITY_NOT_DECLARED'),
        ),
      );
      return;
    }
    // call：先能力路由（版本声明），再分派。`app.setTitle` / `app.close` 是通知（无回执）。
    if (frame.method === 'app.setTitle') {
      const title = frame.params['title'];
      if (typeof title === 'string' && title.length > 0) this.#options.onTitle(title.slice(0, 120));
      return;
    }
    if (frame.method === 'app.close') {
      this.#options.onClose?.();
      return;
    }
    const capability = microAppApiMethodOf(frame.method)?.capability;
    if (capability !== undefined && capability !== 'platform' && !this.#options.permissions.includes(capability)) {
      this.#post(
        microAppErrorFrame(
          frame.id,
          'MICRO_APP_CAPABILITY_NOT_DECLARED',
          `这个微应用没有声明能力 ${capability}（${microAppCapabilityOf(capability)?.title ?? capability}）`,
          microAppErrorHintOf('MICRO_APP_CAPABILITY_NOT_DECLARED'),
        ),
      );
      return;
    }
    try {
      const result = await this.#dispatch(frame.method, frame.params);
      if (this.#destroyed || this.#cancelled.has(frame.id)) return;
      this.#cancelled.delete(frame.id);
      this.#post(microAppAckFrame(frame.id, result));
    } catch (error) {
      if (this.#destroyed || this.#cancelled.has(frame.id)) return;
      this.#cancelled.delete(frame.id);
      const code = (error as { code?: unknown }).code;
      this.#post(
        microAppErrorFrame(
          frame.id,
          typeof code === 'string' ? code : 'INTERNAL',
          error instanceof Error ? error.message : String(error),
          microAppErrorHintOf(typeof code === 'string' ? code : ''),
        ),
      );
    }
  }

  async #dispatch(method: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'app.ready':
        return this.#readyInfo();
      case 'app.requestDisplayMode': {
        if (this.#options.onRequestDisplayMode === undefined) {
          throw Object.assign(new Error('当前宿主不支持切换展示模式'), { code: 'NOT_IMPLEMENTED' });
        }
        const mode = payload['mode'] === 'inline' ? 'inline' : 'immersive';
        const result = await this.#options.onRequestDisplayMode(mode);
        this.#displayMode = result.mode;
        this.pushAppEvent('display-mode', { mode: result.mode });
        return result;
      }
      case 'storage.get': {
        const out = await this.#options.storage({ op: 'get', ...storageKeyOf(payload) });
        return out.op === 'get' && out.found ? out.value : undefined;
      }
      case 'storage.set':
        await this.#options.storage({ op: 'set', ...storageKeyOf(payload), value: payload['value'] });
        return undefined;
      case 'storage.delete':
        await this.#options.storage({ op: 'delete', ...storageKeyOf(payload) });
        return undefined;
      case 'storage.list': {
        const out = await this.#options.storage({ op: 'list' });
        return out.op === 'list' ? out.keys : [];
      }
      case 'query': {
        const name = payload['name'];
        if (typeof name !== 'string' || name.length === 0) {
          throw Object.assign(new Error('kepcup.query 需要一个非空字符串查询名'), { code: 'INVALID_INPUT' });
        }
        if (name.length > BOT_WIDGET_QUERY_NAME_MAX_CHARS) {
          throw Object.assign(new Error(`查询名过长（最多 ${BOT_WIDGET_QUERY_NAME_MAX_CHARS} 字）`), {
            code: 'INVALID_INPUT',
          });
        }
        const rawParams = payload['params'] ?? {};
        if (rawParams === null || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
          throw Object.assign(new Error('query 的 params 必须是一个对象'), { code: 'INVALID_INPUT' });
        }
        const opts = payload['opts'];
        if (opts !== undefined && (opts === null || typeof opts !== 'object' || Array.isArray(opts))) {
          throw Object.assign(new Error('query 的 opts 必须是一个对象'), { code: 'INVALID_INPUT' });
        }
        return await this.#options.query({ name, params: rawParams as Record<string, unknown> });
      }
      case 'openLink': {
        const url = normalizeAppLink(payload['url']);
        if (url === null) {
          throw Object.assign(new Error('只支持打开 https 链接'), { code: 'INVALID_INPUT' });
        }
        return await this.#options.openLink(url);
      }
      case 'reply': {
        const text = typeof payload['text'] === 'string' ? payload['text'].trim() : '';
        if (text === '') {
          throw Object.assign(new Error('kepcup.reply 需要一段非空文字'), { code: 'INVALID_INPUT' });
        }
        if (text.length > WIDGET_REPLY_MAX_CHARS) {
          throw Object.assign(new Error(`回传的内容过长（最多 ${WIDGET_REPLY_MAX_CHARS} 字）`), {
            code: 'INVALID_INPUT',
          });
        }
        if (!(this.#options.userActivation ?? hostUserActivation)()) return false;
        return await this.#options.reply(text);
      }
      case 'ai.chat':
      case 'ai.session.create':
      case 'ai.session.send':
      case 'ai.session.history':
      case 'ai.session.reset':
      case 'ai.cancel':
      case 'ai.dispose': {
        if (this.#options.aiCall === undefined) {
          throw Object.assign(new Error('微应用模型模块未就绪'), { code: 'NOT_IMPLEMENTED' });
        }
        return await this.#options.aiCall(method, payload);
      }
      case 'media.listen': {
        // 每次运行会话授权（55 §5.1）：未授权 / 被拒即 MICRO_APP_CAPABILITY_DENIED——
        // 授权检查在实现可用性之前（未授权是常态分支，不该报成「宿主不支持」）。
        const grant = (this.#options.micGrant ?? (() => 'unavailable'))();
        if (grant !== 'granted') {
          const message =
            grant === 'denied'
              ? '你已拒绝这个微应用使用麦克风（可在外壳重新开启）'
              : '麦克风不可用（传感器总闸关闭或没有设备）';
          throw Object.assign(new Error(message), {
            code: 'MICRO_APP_CAPABILITY_DENIED',
            hint: microAppErrorHintOf('MICRO_APP_CAPABILITY_DENIED'),
          });
        }
        if (this.#options.createListenSession === undefined) {
          throw Object.assign(new Error('当前宿主不支持麦克风'), { code: 'NOT_IMPLEMENTED' });
        }
        const rawMode = payload['mode'];
        const mode = rawMode === 'push-to-talk' ? 'push-to-talk' : 'vad';
        const silenceMs = typeof payload['silenceMs'] === 'number' && payload['silenceMs'] >= 200 && payload['silenceMs'] <= 3000
          ? Math.round(payload['silenceMs'])
          : 700;
        const lang = typeof payload['lang'] === 'string' ? payload['lang'] : undefined;
        const channelId = `ch_${this.#instanceId}_${this.#listenSessions.size + 1}`;
        const session = this.#options.createListenSession(
          { lang, mode, silenceMs },
          (name, data) => {
            this.#pushEvent(channelId, name, data);
          },
          this.#instanceId,
        );
        this.#listenSessions.set(channelId, session);
        return { channelId };
      }
      case 'media.listen.start':
      case 'media.listen.stop': {
        const channelId = typeof payload['channelId'] === 'string' ? payload['channelId'] : '';
        const session = this.#listenSessions.get(channelId);
        if (session === undefined) {
          throw Object.assign(new Error('监听会话不存在（已停止或已撤销）'), { code: 'NOT_FOUND' });
        }
        if (method === 'media.listen.start') {
          await session.start();
          return undefined;
        }
        this.#listenSessions.delete(channelId);
        await session.stop();
        return undefined;
      }
      case 'media.speak': {
        if (this.#options.speak === undefined) {
          throw Object.assign(new Error('微应用语音模块未就绪'), { code: 'NOT_IMPLEMENTED' });
        }
        const text = typeof payload['text'] === 'string' ? payload['text'] : '';
        if (text === '') {
          throw Object.assign(new Error('kepcup.media.speak 需要一段非空文字'), { code: 'INVALID_INPUT' });
        }
        await this.#options.speak({
          text,
          ...(typeof payload['voice'] === 'string' ? { voice: payload['voice'] } : {}),
          ...(typeof payload['rate'] === 'number' ? { rate: payload['rate'] } : {}),
        });
        return undefined;
      }
      case 'media.stopSpeaking': {
        this.#options.stopSpeaking?.();
        return undefined;
      }
      default:
        throw Object.assign(new Error('当前运行时不支持这个方法'), { code: 'NOT_IMPLEMENTED' });
    }
  }

  #readyInfo(): MicroAppReadyInfo {
    return {
      // 能力协商：声明的能力里当前宿主真正开放的子集（已实现集合；麦克风按会话授权态收紧）。
      capabilities: this.#options.permissions
        .filter((id) => microAppCapabilityOf(id) !== undefined)
        .filter((id) => id !== 'media.listen' || (this.#options.micGrant ?? (() => 'unavailable'))() === 'granted'),
      grants: {
        mic: (this.#options.micGrant ?? (() => 'unavailable'))(),
        net: {
          mode: this.#options.net.mode,
          domains: [...this.#options.net.domains],
        },
      },
      theme: this.#theme,
      displayMode: this.#displayMode,
      viewport: { ...this.#options.viewport },
      instanceId: this.#instanceId,
    };
  }
}

function storageKeyOf(payload: Record<string, unknown>): { key: string } {
  const key = payload['key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw Object.assign(new Error('kepcup.storage 需要一个非空字符串 key'), { code: 'INVALID_INPUT' });
  }
  if (key.length > BOT_WIDGET_STORAGE_KEY_MAX_CHARS) {
    throw Object.assign(new Error(`key 过长（最多 ${BOT_WIDGET_STORAGE_KEY_MAX_CHARS} 字）`), {
      code: 'INVALID_INPUT',
    });
  }
  return { key };
}

export { MICRO_APP_BRIDGE_HOST_SOURCE };
