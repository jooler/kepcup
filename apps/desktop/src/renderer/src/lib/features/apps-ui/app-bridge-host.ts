import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { AppUiToolResult } from '@kepcup/shared';
import { createThrottle, guardIncomingMessage, normalizeAppLink } from './bridge-guard';

/**
 * MCP Apps 宿主桥（D73 P3 §7.5）：官方 `@modelcontextprotocol/ext-apps` 的 `AppBridge` 的薄封装——
 * 官方实现负责 `ui/initialize`、通知、请求—响应配对；本类在它外面加三件事：
 *
 * 1. {@link GuardedTransport}：只接收 `event.source === iframe.contentWindow` 的消息（官方
 *    `PostMessageTransport` 已做），再加方法白名单与体积上限（见 `bridge-guard.ts`）；
 * 2. 宿主能力收窄：只通告 `openLinks` / `serverTools` / `logging`；`ui/message`、`ui/update-model-context`
 *    不挂处理器（AppBridge 回 `-32601`），P3 不支持；
 * 3. 界面发起的 `tools/call` 与外链一律回调给组件（组件再走 core RPC `apps.ui.callTool` / 用户确认）。
 *
 * 官方包按需 `import()`（约 500 KB，仅在出现界面卡片时加载）。升级到 ext-apps 2.x（要求 SDK 2.x）时只改
 * 这个文件的 import。
 */

export interface AppBridgeHostOptions {
  /** iframe 的 `contentWindow`（必须已挂到 DOM；WindowProxy 在导航后仍有效）。 */
  frameWindow: Window;
  toolInput: Record<string, unknown>;
  toolResult: AppUiToolResult;
  hostContext: { theme: 'light' | 'dark'; locale: string };
  /** 界面发起的 `tools/call`；组件转 core RPC。抛错 = 向界面返回错误结果。 */
  callTool(name: string, args: Record<string, unknown>): Promise<AppUiToolResult>;
  /** 界面请求打开外链（已校验为 https）；组件征得用户确认，返回是否已打开。 */
  openLink(url: string): Promise<boolean>;
  onHeight(height: number): void;
  onInitialized?(): void;
}

function errorResponse(id: string | number, code: number, message: string): JSONRPCMessage {
  return { jsonrpc: '2.0', id, error: { code, message } } as unknown as JSONRPCMessage;
}

export class AppBridgeHost {
  readonly #bridge: AppBridge;
  #closed = false;

  private constructor(bridge: AppBridge) {
    this.#bridge = bridge;
  }

  /** 创建桥并开始监听（须在设置 iframe `src` 之前调用）。 */
  static async connect(options: AppBridgeHostOptions): Promise<AppBridgeHost> {
    const { AppBridge, PostMessageTransport } =
      await import('@modelcontextprotocol/ext-apps/app-bridge');

    class GuardedTransport implements Transport {
      readonly #inner = new PostMessageTransport(options.frameWindow, options.frameWindow);
      onclose?: () => void;
      onerror?: (error: Error) => void;
      onmessage?: Transport['onmessage'];

      async start(): Promise<void> {
        this.#inner.onclose = () => this.onclose?.();
        this.#inner.onerror = (error) => this.onerror?.(error);
        this.#inner.onmessage = (message, extra) => {
          const verdict = guardIncomingMessage(message);
          if (verdict.ok) {
            this.onmessage?.(message, extra);
            return;
          }
          // Requests get a JSON-RPC error so the app does not hang; everything else is dropped.
          if (verdict.id !== undefined) {
            const code = verdict.reason === 'too-large' ? -32600 : -32601;
            void this.#inner
              .send(errorResponse(verdict.id, code, verdict.reason))
              .catch(() => undefined);
          }
        };
        await this.#inner.start();
      }

      send(message: JSONRPCMessage): Promise<void> {
        return this.#inner.send(message);
      }

      close(): Promise<void> {
        return this.#inner.close();
      }
    }

    const bridge = new AppBridge(
      null,
      { name: 'kepcup', version: '0.0.0' },
      { openLinks: {}, serverTools: {}, logging: {} },
      {
        hostContext: {
          theme: options.hostContext.theme,
          locale: options.hostContext.locale,
          displayMode: 'inline',
          availableDisplayModes: ['inline'],
          platform: 'desktop',
        },
      },
    );
    bridge.oninitialized = () => {
      void (async () => {
        try {
          await bridge.sendToolInput({ arguments: options.toolInput });
          await bridge.sendToolResult({
            content: options.toolResult.content,
            ...(options.toolResult.structuredContent !== undefined
              ? { structuredContent: options.toolResult.structuredContent }
              : {}),
            ...(options.toolResult.isError === true ? { isError: true } : {}),
          });
        } catch {
          // The app went away while we were notifying it.
        }
      })();
      options.onInitialized?.();
    };
    bridge.oncalltool = async (params) => {
      try {
        const result = await options.callTool(params.name, params.arguments ?? {});
        return {
          content: result.content,
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
          ...(result.isError === true ? { isError: true } : {}),
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        };
      }
    };
    bridge.onopenlink = async (params) => {
      const link = normalizeAppLink(params.url);
      if (link === null) return { isError: true };
      return (await options.openLink(link)) ? {} : { isError: true };
    };
    const throttledHeight = createThrottle<number>(100, options.onHeight);
    bridge.onsizechange = (params) => {
      if (typeof params.height === 'number') throttledHeight(params.height);
    };
    await bridge.connect(new GuardedTransport());
    return new AppBridgeHost(bridge);
  }

  /** 通知界面拆除（尽力而为，限时）并断开。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await Promise.race([
        this.#bridge.teardownResource({}),
        new Promise((resolve) => setTimeout(resolve, 300)),
      ]);
    } catch {
      // The frame may already be gone.
    }
    await this.#bridge.close().catch(() => undefined);
  }
}
