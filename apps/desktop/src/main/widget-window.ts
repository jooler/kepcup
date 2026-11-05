import { widgetCardSchema, type WidgetCard } from '@kepcup/shared';

/**
 * 组件「在新窗口打开」（todo/bot-micro-app-platform/widget-window.md §4.2）的**纯逻辑**
 * 部分：渲染入口目标构造、入参校验、窗口注册表。Electron 侧的窗口装配在
 * `widget-window-electron.ts`（本文件不 import electron 运行时——主进程模块的单测
 * 约定：被测模块只 import node/shared，见 widget-preview-policy 等先例）。
 *
 * - **移交语义**：同 messageId 已有窗口 → focus 不重开（不双实例运行同一张卡）；
 *   打开方（WidgetViewer）在调用成功后自行关闭覆盖层。
 * - **数据通路**：payload（`{ messageId, card }`，纯 UI 描述符、不含 HTML/密钥）由主进程
 *   在 `did-finish-load` 后推送；渲染端凭 messageId 再 `widgets.ui.open` 由 core 登记
 *   真实资源。入参经 `widgetCardSchema.parse` 校验，渲染层进不来的垃圾不落窗。
 * - **端口 A**：组件窗口与主窗口同一条握手（每次加载新 pair，core 侧多客户端注册表
 *   接住）；core 重启时 index.ts 对主窗口与全部组件窗口补发端口（`eachWindow`）。
 */

/** 组件窗口默认内容区：immersive 铺满形态的舒适尺寸；最小宽度容忍 inline 420px 形态。 */
export const WIDGET_WINDOW_WIDTH = 960;
export const WIDGET_WINDOW_HEIGHT = 720;
export const WIDGET_WINDOW_MIN_WIDTH = 420;
export const WIDGET_WINDOW_MIN_HEIGHT = 480;

export const WIDGET_WINDOW_QUERY = 'kcWindow';
export const WIDGET_WINDOW_MODE = 'widget';
export const WIDGET_WINDOW_PAYLOAD_CHANNEL = 'widget-window:payload';

/** 渲染入口 URL 的两种落点（dev 走 dev server，prod 走 index.html + query）。 */
export type WidgetWindowTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string; query: Record<string, string> };

export function buildWidgetWindowTarget(input: {
  isPackaged: boolean;
  devRendererUrl?: string;
  rendererIndexPath: string;
}): WidgetWindowTarget {
  if (!input.isPackaged && input.devRendererUrl) {
    const base = input.devRendererUrl.endsWith('/')
      ? input.devRendererUrl
      : `${input.devRendererUrl}/`;
    return { kind: 'url', url: `${base}?${WIDGET_WINDOW_QUERY}=${WIDGET_WINDOW_MODE}` };
  }
  return {
    kind: 'file',
    path: input.rendererIndexPath,
    query: { [WIDGET_WINDOW_QUERY]: WIDGET_WINDOW_MODE },
  };
}

/** `window:openWidget` 的入参校验：主进程不信渲染层送来的对象，按 shared 契约重验。 */
export function parseOpenWidgetInput(raw: unknown): { messageId: string; card: WidgetCard } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as { messageId?: unknown; card?: unknown };
  if (typeof candidate.messageId !== 'string' || candidate.messageId.length === 0) return null;
  const card = widgetCardSchema.safeParse(candidate.card);
  if (!card.success) return null;
  return { messageId: candidate.messageId, card: card.data };
}

export interface WidgetWindowCreateInput {
  target: WidgetWindowTarget;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  preloadPath: string;
  /** 渲染入口加载完成（did-finish-load）：此时推送 payload / 端口 A。窗口引用由装配器回传。 */
  onDidLoad: (win: WidgetWindowLike) => void;
}

/** 注册表触到的窗口面（BrowserWindow 的结构子集；Electron 壳直接传真窗口）。 */
export interface WidgetWindowLike {
  id: number;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  close(): void;
  on(channel: 'closed', listener: () => void): unknown;
  webContents: { send(channel: string, payload: unknown): void };
}

export interface WidgetWindowHostOptions {
  isPackaged: boolean;
  preloadPath: string;
  rendererIndexPath: string;
  devRendererUrl?: string;
  /** 组装窗口（Electron 壳注入；测试用桩记录调用）。 */
  createWindow: (input: WidgetWindowCreateInput) => WidgetWindowLike;
  /**
   * 窗口加载完成（did-finish-load）的宿主侧回调：**端口 A 握手**在 index.ts 走这里
   * （`sendAppPort(win)`——渲染端只被动收 `core-port`，窗口加载必须主动补发），
   * 与载荷推送同拍；缺了它组件窗口永远停在「正在加载组件...」（实测 2026-11-05）。
   */
  onWindowDidLoad?: (win: WidgetWindowLike) => void;
  log?: (message: string, error?: unknown) => void;
}

interface WidgetWindowEntry {
  win: WidgetWindowLike;
  messageId: string;
}

/** 组件窗口注册表：同 messageId 去重、closed 出清、退出/重启广播的统一出口。 */
export class WidgetWindowHost {
  readonly #options: WidgetWindowHostOptions;
  readonly #windows = new Map<number, WidgetWindowEntry>();

  constructor(options: WidgetWindowHostOptions) {
    this.#options = options;
  }

  /** `window:openWidget`：校验 → 去重 → 开窗。返回是否新开了窗口（false = 已有，已 focus）。 */
  open(input: unknown): { opened: boolean } {
    const parsed = parseOpenWidgetInput(input);
    if (parsed === null) {
      this.#log('widget window open rejected: invalid payload');
      return { opened: false };
    }
    for (const entry of this.#windows.values()) {
      if (entry.messageId === parsed.messageId && !entry.win.isDestroyed()) {
        if (entry.win.isMinimized()) entry.win.restore();
        entry.win.focus();
        return { opened: false };
      }
    }
    const target = buildWidgetWindowTarget({
      isPackaged: this.#options.isPackaged,
      devRendererUrl: this.#options.devRendererUrl,
      rendererIndexPath: this.#options.rendererIndexPath,
    });
    const win = this.#options.createWindow({
      target,
      title: parsed.card.title,
      width: WIDGET_WINDOW_WIDTH,
      height: WIDGET_WINDOW_HEIGHT,
      minWidth: WIDGET_WINDOW_MIN_WIDTH,
      minHeight: WIDGET_WINDOW_MIN_HEIGHT,
    preloadPath: this.#options.preloadPath,
    onDidLoad: (loaded) => {
      this.#options.onWindowDidLoad?.(loaded);
      loaded.webContents.send(WIDGET_WINDOW_PAYLOAD_CHANNEL, {
        messageId: parsed.messageId,
        card: parsed.card,
      });
    },
  });
    this.#windows.set(win.id, { win, messageId: parsed.messageId });
    win.on('closed', () => {
      this.#windows.delete(win.id);
    });
    return { opened: true };
  }

  /** 端口 A 握手（did-finish-load / core 重启）与状态广播遍历的出口。 */
  eachWindow(visit: (win: WidgetWindowLike) => void): void {
    for (const entry of [...this.#windows.values()]) {
      if (entry.win.isDestroyed()) {
        this.#windows.delete(entry.win.id);
        continue;
      }
      visit(entry.win);
    }
  }

  /** before-quit：全部关闭（窗口都是普通查看面，无需逐个清理资源——Runtime 卸载即停）。 */
  closeAll(): void {
    for (const entry of [...this.#windows.values()]) {
      if (!entry.win.isDestroyed()) entry.win.close();
    }
    this.#windows.clear();
  }

  #log(message: string, error?: unknown): void {
    if (this.#options.log !== undefined) this.#options.log(message, error);
    else console.warn(`[widget-window] ${message}`);
  }
}
