import type { WidgetsUiStorageOutput } from '@kepcup/shared';
import { normalizeAppLink } from '../apps-ui/bridge-guard';
import {
  clampWidgetHeight,
  parseWidgetBridgeMessage,
  widgetBridgeReply,
  type WidgetBridgeReply,
} from './widget-bridge-guard';

/**
 * Bot Widget 能力桥宿主（D81 P1，设计 32 §6）：BotWidgetCard 在挂 iframe **之前**创建本类。
 * 只接收来自这一个 iframe 窗口的消息（`event.source === frameWindow` 是唯一来源凭据——组件
 * 在 opaque origin 里，postMessage 只能 `targetOrigin '*'`），过白名单后分派：
 *
 * - `storage.*` → core RPC `widgets.ui.storage`（resourceId 在这里附加，core 反查命名空间）；
 * - `openLink` → 先 renderer 侧 https 规范化，再交给卡片出确认条（用户同意后走
 *   `widgets.ui.openLink`）；一次只挂一条，卡片拒绝后有冷却；
 * - `theme.get` → 建桥时的宿主主题（一次性，不推送变更）；
 * - `setHeight` → 高度夹取后回调卡片（通知，无回执）。
 *
 * 宿主永不 await 组件的后续：每个请求最终恰好回执一次（分派抛错也回错误回执），组件侧
 * 垫片按关联 id 配对。
 */
export interface WidgetBridgeHostOptions {
  /** iframe 的 `contentWindow`（必须已挂到 DOM；WindowProxy 在导航后仍有效）。 */
  frameWindow: Window;
  /** 一次性资源凭据：core 用它反查 widgetId（KV 命名空间）与存活。 */
  resourceId: string;
  /** 建桥时的宿主主题（`theme.get` 的回答）。 */
  theme: 'light' | 'dark';
  /** 转发 `widgets.ui.storage`（卡片负责 schema.parse + 错误透传）。 */
  storage(input: {
    op: 'get' | 'set' | 'delete' | 'list';
    key?: string;
    value?: unknown;
  }): Promise<WidgetsUiStorageOutput>;
  /** 外链确认（卡片出确认条；resolve = 用户同意且打开成功）。 */
  openLink(url: string): Promise<boolean>;
  onHeight(height: number): void;
}

export class WidgetBridgeHost {
  readonly #frameWindow: Window;
  readonly #options: WidgetBridgeHostOptions;
  readonly #listener: (event: MessageEvent) => void;
  #destroyed = false;

  private constructor(options: WidgetBridgeHostOptions) {
    this.#frameWindow = options.frameWindow;
    this.#options = options;
    this.#listener = (event) => {
      void this.#handle(event);
    };
  }

  /** 创建桥并开始监听（须在设置 iframe `src` 之前调用）。 */
  static connect(options: WidgetBridgeHostOptions): WidgetBridgeHost {
    const host = new WidgetBridgeHost(options);
    window.addEventListener('message', host.#listener);
    return host;
  }

  /** 拆桥（卡片卸载 / 重载）：移除监听，此后不再收发任何消息。 */
  destroy(): void {
    this.#destroyed = true;
    window.removeEventListener('message', this.#listener);
  }

  async #handle(event: MessageEvent): Promise<void> {
    if (this.#destroyed) return;
    // 唯一来源防线：必须是这个 iframe 自己（子框架再多层也不收）。
    if (event.source !== this.#frameWindow) return;
    const parsed = parseWidgetBridgeMessage(event.data);
    if (!parsed.ok) return;
    const { id, method, payload } = parsed.request;
    if (method === 'setHeight') {
      const clamped = clampWidgetHeight(payload['height']);
      if (clamped !== null) this.#options.onHeight(clamped);
      return;
    }
    try {
      this.#reply(id, await this.#dispatch(method, payload));
    } catch (error) {
      this.#reply(id, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #dispatch(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<{ value?: unknown } | { error: string }> {
    switch (method) {
      case 'storage.get':
        return { value: this.#storageValue(await this.#options.storage({ op: 'get', ...storageKeyOf(payload) })) };
      case 'storage.set':
        await this.#options.storage({
          op: 'set',
          ...storageKeyOf(payload),
          value: payload['value'],
        });
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
        if (url === null) return { error: '只支持打开 https 链接' };
        return { value: await this.#options.openLink(url) };
      }
      case 'theme.get':
        return { value: this.#options.theme };
      default:
        return { error: '不支持的能力' };
    }
  }

  /** get 命中：原值回给组件；未命中：undefined（垫片 resolve(undefined)）。 */
  #storageValue(out: WidgetsUiStorageOutput): unknown {
    return out.op === 'get' && out.found ? out.value : undefined;
  }

  #reply(id: number, reply: { value?: unknown } | { error: string }): void {
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
    throw new Error('kepcup.storage 需要一个非空字符串 key');
  }
  return { key };
}
