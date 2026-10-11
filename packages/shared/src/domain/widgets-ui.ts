import { z } from 'zod';
import { MCP_APP_SCHEME, appsUiResourceInputSchema, appsUiResourceOutputSchema } from './apps-ui.js';

/**
 * Bot 自制交互组件（Bot Widgets，D81，设计 32）：Bot 在任务里用 `widget_create` /
 * `widget_update` 交付的单文件 HTML 组件，作为 `cardType: 'bot_widget'` 卡片消息落在对话里，
 * 渲染端在 `sandbox="allow-scripts"` 沙箱 iframe 中加载（复用 MCP Apps 的 `kepcup-app://`
 * 特权协议与登记机制，host 前缀 `widget-`）。
 *
 * 信任模型（设计 32 §2）：widget HTML 是最低信任的内容——卡片与登记的内存资源里**不含运行时
 * 之外的东西**（HTML 只在 core 的库与内存资源里，不进模型上下文），响应头 CSP 固定
 * `connect-src 'none'`（默认禁网，见 `buildAppCspHeader` 空域输出）；用户按版本（sha256）
 * 人工确认后才挂载 iframe。能力（存储 / 查询）由宿主能力桥代为执行（P1 起），生成代码永不
 * 接触 Node / 文件系统 / 网络。
 */

/** 对话里卡片消息的 `cardType`。 */
export const BOT_WIDGET_CARD_TYPE = 'bot_widget';
/** 特权协议沿用 MCP Apps 的 `kepcup-app`（渲染端 CSP 的 `frame-src` 已放行）。 */
export const BOT_WIDGET_SCHEME = MCP_APP_SCHEME;

/** 单个组件 HTML 的体积上限（字节，同 MCP Apps 的资源上限）。 */
export const BOT_WIDGET_HTML_MAX_BYTES = 2 * 1024 * 1024;
/** 标题 / 一句话说明的长度上限。 */
export const BOT_WIDGET_TITLE_MAX_CHARS = 120;
export const BOT_WIDGET_DESCRIPTION_MAX_CHARS = 300;
/** 每个 run 最多发多少张组件卡（防循环刷屏，同 MCP Apps）。 */
export const BOT_WIDGET_CARDS_PER_RUN_MAX = 8;
/** 内存资源的生存期（滑动）与条数上限——与 MCP Apps 同值，独立常量避免语义漂移。 */
export const BOT_WIDGET_RESOURCE_TTL_MS = 30 * 60 * 1000;
export const BOT_WIDGET_RESOURCES_MAX = 64;
/** iframe 高度夹取范围（像素，同 MCP Apps）。 */
export const BOT_WIDGET_HEIGHT_MIN = 100;
export const BOT_WIDGET_HEIGHT_MAX = 800;
/** 用户确认记忆的 localStorage 键（渲染端；值 = sha256 → true 的映射，容量有界）。 */
export const BOT_WIDGET_CONSENT_STORAGE_KEY = 'kepcup.botWidget.consents.v1';
export const BOT_WIDGET_CONSENTS_MAX = 200;

// --- 能力桥（P1，设计 32 §6）---------------------------------------------------

/** KV 单键的键长上限（字符）。 */
export const BOT_WIDGET_STORAGE_KEY_MAX_CHARS = 200;
/** KV 单值 JSON 序列化后的体积上限（字节）。 */
export const BOT_WIDGET_STORAGE_VALUE_MAX_BYTES = 256 * 1024;
/** 每个组件 KV 的总配额（字节）与键数上限（`widget_docs`，命名空间 = widgetId）。 */
export const BOT_WIDGET_STORAGE_QUOTA_BYTES = 1024 * 1024;
export const BOT_WIDGET_STORAGE_KEYS_MAX = 1000;
/** 每张卡每秒最多发起的能力桥调用，与同时在途的上限（同 MCP Apps 语义，独立常量避免语义漂移）。 */
export const BOT_WIDGET_CALLS_PER_SECOND = 5;
export const BOT_WIDGET_CALLS_INFLIGHT_MAX = 3;

// --- 卡片描述符（落库在对话消息里，不含 HTML） --------------------------------

export const widgetScopeSchema = z.enum(['conversation', 'bot']);
export type WidgetScope = z.infer<typeof widgetScopeSchema>;

/** `bot_widget` 卡片的描述符：引用 widgets / widget_versions 行，不携带 HTML。 */
export const widgetCardSchema = z.object({
  widgetId: z.string().min(1),
  /** 卡片钉住的版本（旧卡永远开旧版）。 */
  version: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  scope: widgetScopeSchema,
  /** 该版本 HTML 的 sha256（渲染端按它记忆用户确认）。 */
  sha256: z.string().min(1),
  sizeBytes: z.number().int().min(1),
  /** 产出组件的 Bot；仅展示用。 */
  botId: z.string().nullable(),
  createdAt: z.number(),
});
export type WidgetCard = z.infer<typeof widgetCardSchema>;

// --- RPC -------------------------------------------------------------------

/** `widgets.ui.source`：查看源码（审查态用，不登记资源、不挂 iframe）。 */
export const widgetsUiSourceInputSchema = z.object({ messageId: z.string().min(1) });
export const widgetsUiSourceOutputSchema = z.object({
  widgetId: z.string(),
  version: z.number().int(),
  title: z.string(),
  sha256: z.string(),
  /** 与 create 侧同上限（正常不会触达；本地库损坏时防御性截拒）。 */
  html: z.string().max(BOT_WIDGET_HTML_MAX_BYTES),
});
export type WidgetsUiSourceOutput = z.infer<typeof widgetsUiSourceOutputSchema>;

/** `widgets.ui.open`：卡片挂载，登记内存资源并返回 iframe 地址。 */
export const widgetsUiOpenInputSchema = z.object({ messageId: z.string().min(1) });
export const widgetsUiOpenOutputSchema = z.object({
  /** 一次性不透明资源 id（iframe 路径与后续调用的凭据）。 */
  resourceId: z.string(),
  /** 完整的 iframe 地址 `kepcup-app://widget-{hash}/{resourceId}`。 */
  url: z.string(),
  widgetId: z.string(),
  version: z.number().int(),
  title: z.string(),
  description: z.string(),
  scope: widgetScopeSchema,
  sha256: z.string(),
});
export type WidgetsUiOpenOutput = z.infer<typeof widgetsUiOpenOutputSchema>;

export const widgetsUiCloseInputSchema = z.object({ resourceId: z.string().min(1) });

/**
 * 平台方法 `widgets.ui.resource`（主进程协议处理器 → core）：取登记过的 HTML 与响应头 CSP。
 * 请求/响应形状与 `apps.ui.resource` 相同（主进程按 host 前缀 `widget-` 分流），直接复用其 schema。
 */
export const widgetsUiResourceInputSchema = appsUiResourceInputSchema;
export const widgetsUiResourceOutputSchema = appsUiResourceOutputSchema;

/**
 * `widgets.ui.storage`（能力桥 KV，P1）：命名空间 = widgetId 的 `widget_docs` 键值存储。
 * 渲染端桥收到 widget 的调用后带上 `resourceId`（一次性凭据）转发到这里；core 用它反查
 * 登记资源拿 widgetId——resourceId 过期 / 不存在 = `WIDGET_RESOURCE_EXPIRED`。
 */
const widgetStorageKeySchema = z.string().min(1).max(BOT_WIDGET_STORAGE_KEY_MAX_CHARS);
export const widgetsUiStorageInputSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get'), resourceId: z.string().min(1), key: widgetStorageKeySchema }),
  z.object({
    op: z.literal('set'),
    resourceId: z.string().min(1),
    key: widgetStorageKeySchema,
    /** 任意 JSON 值（undefined 拒绝）；序列化后受单值体积与总配额限制。 */
    value: z.unknown(),
  }),
  z.object({ op: z.literal('delete'), resourceId: z.string().min(1), key: widgetStorageKeySchema }),
  z.object({ op: z.literal('list'), resourceId: z.string().min(1) }),
]);
export type WidgetsUiStorageInput = z.infer<typeof widgetsUiStorageInputSchema>;

export const widgetsUiStorageOutputSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get'), found: z.boolean(), value: z.unknown().optional() }),
  z.object({ op: z.literal('set') }),
  z.object({ op: z.literal('delete') }),
  z.object({ op: z.literal('list'), keys: z.array(z.string()) }),
]);
export type WidgetsUiStorageOutput = z.infer<typeof widgetsUiStorageOutputSchema>;

/**
 * `widgets.ui.openLink`（能力桥外链，P1）：渲染端已出卡内确认条征得用户同意，core 再核一次
 * https-only 与无凭据（写法同 `apps.ui.openLink`），经主进程 `shell.openExternal` 打开。
 */
export const widgetsUiOpenLinkInputSchema = z.object({
  resourceId: z.string().min(1),
  url: z.string().min(1).max(2048),
});
export const widgetsUiOpenLinkOutputSchema = z.object({ ok: z.boolean() });
