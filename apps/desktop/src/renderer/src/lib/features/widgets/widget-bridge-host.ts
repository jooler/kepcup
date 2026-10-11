import { BOT_WIDGET_STORAGE_KEY_MAX_CHARS, type WidgetsUiStorageCall, type WidgetsUiStorageOutput } from '@kepcup/shared';
import { createThrottle, normalizeAppLink } from '../apps-ui/bridge-guard';
import {
  clampWidgetHeight,
  parseWidgetBridgeMessage,
  widgetBridgeMessageId,
  widgetBridgeReply,
  type WidgetBridgeReply,
} from './widget-bridge-guard';

/** 宿主监听 postMessage 的目标（生产 = 全局 window；测试注入假体）。 */
export interface WidgetBridgeListenerTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/**
 * Bot Widget 能力桥宿主（D81 P1，设计 32 §6）：BotWidgetCard 在挂 iframe **之前**创建本类。
 * 只接收来自这一个 iframe 窗口的消息（`event.source === frameWindow` 是唯一来源凭据——组件
 * 在 opaque origin 里，postMessage 只能 `targetOrigin '*'`），过白名单后分派：
 *
 * - `storage.*` → core RPC `widgets.ui.storage`（resourceId 在这里附加，core 反查命名空间）；
 * - `openLink` → 先 renderer 侧 https 规范化，再交给卡片出确认条（用户同意后走
 *   `widgets.ui.openLink`）；一次只挂一条，卡片拒绝后有冷却；
 * - `theme.get` → 建桥时的宿主主题（一次性，不推送变更）；
 * - `setHeight` → 高度夹取 + 100ms 节流后回调卡片（通知，无回执）。
 *
 * 回执契约：每个带可解析 id 的请求**恰好回执一次**——分派抛错、消息被拒收（形状 / 白名单 /
 * 超限 / 不可序列化）都回一条错误回执（`error` 人话 + `code` 机器可读），组件侧垫片的
 * promise 不会挂起；id 都解析不出的消息无法配对，只能丢弃（组件发不出这种消息）。
 */
export interface WidgetBridgeHostOptions {
  /** iframe 的 `contentWindow`（必须已挂到 DOM；WindowProxy 在导航后仍有效）。 */
  frameWindow: Window;
  /** 一次性资源凭据：core 用它反查 widgetId（KV 命名空间）与存活。 */
  resourceId: string;
  /** 建桥时的宿主主题（`theme.get` 的回答）。 */
  theme: 'light' | 'dark';
  /** 转发 `widgets.ui.storage`（卡片负责 schema.parse + 错误透传）。 */
  storage(input: WidgetsUiStorageCall): Promise<WidgetsUiStorageOutput>;
  /** 外链确认（卡片出确认条；resolve = 用户同意且打开成功）。 */
  openLink(url: string): Promise<boolean>;
  onHeight(height: number): void;
  /** 监听目标；缺省全局 window（测试注入假体以便在 node 环境跑协议级用例）。 */
  listenerTarget?: WidgetBridgeListenerTarget | undefined;
}

export class WidgetBridgeHost {
  readonly #frameWindow: Window;
  readonly #options: WidgetBridgeHostOptions;
  readonly #target: WidgetBridgeListenerTarget;
  readonly #listener: (event: MessageEvent) => void;
  #destroyed = false;

  private constructor(options: WidgetBridgeHostOptions) {
    this.#frameWindow = options.frameWindow;
    this.#options = options;
    this.#target = options.listenerTarget ?? window;
    this.#listener = (event) => {
      void this.#handle(event);
    };
  }

  /** 创建桥并开始监听（须在设置 iframe `src` 之前调用）。 */
  static connect(options: WidgetBridgeHostOptions): WidgetBridgeHost {
    const host = new WidgetBridgeHost(options);
    host.#target.addEventListener('message', host.#listener);
    return host;
  }

  /** 拆桥（卡片卸载 / 重载）：移除监听，此后不再收发任何消息。 */
  destroy(): void {
    this.#destroyed = true;
    this.#target.removeEventListener('message', this.#listener);
  }

  async #handle(event: MessageEvent): Promise<void> {
    if (this.#destroyed) return;
    // 唯一来源防线：必须是这个 iframe 自己（子框架再多层也不收）。
    if (event.source !== this.#frameWindow) return;
    const parsed = parseWidgetBridgeMessage(event.data);
    if (!parsed.ok) {
      // 能配对的拒收也回执（格式不支持），组件侧 promise 才不会挂起。
      const id = widgetBridgeMessageId(event.data);
      if (id !== null) this.#reply(id, { error: '不支持的消息格式', code: 'INVALID_INPUT' });
      return;
    }
    const { id, method, payload } = parsed.request;
    if (method === 'setHeight') {
      const clamped = clampWidgetHeight(payload['height']);
      if (clamped !== null) this.#onHeight(clamped);
      return;
    }
    try {
      this.#reply(id, await this.#dispatch(method, payload));
    } catch (error) {
      this.#reply(id, {
        error: error instanceof Error ? error.message : String(error),
        ...errorCodeOf(error),
      });
    }
  }

  /** 组件高频 setHeight（如 rAF 循环）不能让宿主逐帧重排版（同 MCP Apps 的 size-changed）。 */
  readonly #onHeight = createThrottle<number>(100, (height) => this.#options.onHeight(height));

  async #dispatch(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<{ value?: unknown; code?: string } | { error: string; code?: string }> {
    switch (method) {
      case 'storage.get': {
        const out = await this.#options.storage({ op: 'get', ...storageKeyOf(payload) });
        return { value: out.op === 'get' && out.found ? out.value : undefined };
      }
      case 'storage.set':
        await this.#options.storage({ op: 'set', ...storageKeyOf(payload), value: payload['value'] });
        return {};
      case 'storage.delete':
        await this.#options.storage({ op: 'delete', ...storageKeyOf(payload) });
        return {};
      case 'storage.list': {
        const out = await this.#options.storage({ op: 'list' });
        return { value: out.op === 'list' ? out.keys : [] };
      }
      case 'openLink': {
        // Renderer-side https gate next to core's; a malformed URL never reaches the confirm bar.
        const url = normalizeAppLink(payload['url']);
        if (url === null) return { error: '只支持打开 https 链接', code: 'INVALID_INPUT' };
        return { value: await this.#options.openLink(url) };
      }
      case 'theme.get':
        return { value: this.#options.theme };
      default:
        return { error: '不支持的能力', code: 'NOT_IMPLEMENTED' };
    }
  }

  #reply(id: number, reply: { value?: unknown; code?: string } | { error: string; code?: string }): void {
    if (this.#destroyed) return;
    const message: WidgetBridgeReply = widgetBridgeReply(id, reply);
    try {
      // Opaque origin 的组件只能以 '*' 为目标（targetOrigin 无法校验，来源靠 event.source 反向把关）。
      this.#frameWindow.postMessage(message, '*');
    } catch {
      // The frame is gone (closed / reloaded): nothing to answer to.
    }
  }
}

function storageKeyOf(payload: Record<string, unknown>): { key: string } {
  const key = payload['key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw Object.assign(new Error('kepcup.storage 需要一个非空字符串 key'), { code: 'INVALID_INPUT' });
  }
  if (key.length > BOT_WIDGET_STORAGE_KEY_MAX_CHARS) {
    // 与 core 的 schema 同上限；在这里前置拒绝，组件拿到的是可行动的中文说明而不是 zod 泛化文案。
    throw Object.assign(
      new Error(`key 过长（最多 ${BOT_WIDGET_STORAGE_KEY_MAX_CHARS} 字）`),
      { code: 'INVALID_INPUT' },
    );
  }
  return { key };
}

function errorCodeOf(error: unknown): { code?: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { code } : {};
}
