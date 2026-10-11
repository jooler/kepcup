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

// --- 命名只读查询模板（P2，设计 32 §6）----------------------------------------

/** 每个版本最多登记的查询模板数。 */
export const BOT_WIDGET_QUERIES_MAX = 20;
/** 查询模板名的长度上限（字符集约束见 `widgetQueryDefSchema`）。 */
export const BOT_WIDGET_QUERY_NAME_MAX_CHARS = 64;
/** 单条查询模板 SQL 的体积上限（字节；zod 侧按 UTF-16 粗检，字节精检在 core）。 */
export const BOT_WIDGET_QUERY_SQL_MAX_BYTES = 64 * 1024;
/** 查询运行时单次返回的行数上限（超出即停止迭代并标记 truncated）。 */
export const BOT_WIDGET_QUERY_ROWS_MAX = 200;
/**
 * 查询回执的累计字节上限（行 JSON 逐行累计，超限截断并标记 truncated）：行数上限
 * 约束不了行宽——200 行 × 宽文本列可达数十 MB，渲染进程与 postMessage 都不该收
 * 这个量级。值与桥消息的入站上限（WIDGET_BRIDGE_MESSAGE_MAX_CHARS，1MB）对齐。
 */
export const BOT_WIDGET_QUERY_RESULT_MAX_BYTES = 1024 * 1024;

/**
 * 命名只读查询模板定义（`widget_create` / `widget_update` 的 `queries` 条目）。
 * 模板随版本登记（版本 = HTML + 查询的完整快照，只增不改）：SQL 在交付时被用户
 * 人工预审（审查态「查看源码」可见全文），运行时组件只能按名字调用，输入只有
 * 参数、没有 SQL——这是 query 免审批的唯一理由（运行时 raw SQL 透传永久不做）。
 */
export const widgetQueryDefSchema = z.object({
  /** 组件内 `kepcup.query(name, params)` 的名字。 */
  name: z
    .string()
    .min(1)
    .max(BOT_WIDGET_QUERY_NAME_MAX_CHARS)
    .regex(/^[A-Za-z0-9_-]+$/, '查询名只能含字母、数字、- 和 _'),
  /** 单条只读 SQL（SELECT / WITH…SELECT），`:name` 占位参数；多语句与非只读在 core 拒绝。 */
  sql: z.string().min(1).max(BOT_WIDGET_QUERY_SQL_MAX_BYTES),
});
export type WidgetQueryDef = z.infer<typeof widgetQueryDefSchema>;

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
  /**
   * 该版本登记的查询模板摘要（sha256，无模板为空串）：确认记忆的指纹含它——
   * HTML 不变、仅查询变化的新版本同样视为新代码要求重新确认。
   */
  queriesSha256: z.string().default(''),
  /** 该版本登记的查询模板数（审查态提示用）。 */
  queriesCount: z.number().int().min(0).default(0),
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
  /** 该版本登记的查询模板全文（按名字序）——SQL 随版本人工预审的落点。 */
  queries: z.array(widgetQueryDefSchema),
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

type WithoutResourceId<T> = T extends unknown ? Omit<T, 'resourceId'> : never;
/** 渲染端桥转发一次 KV 调用的形状（`WidgetsUiStorageInput` 去掉宿主附加的 resourceId）。 */
export type WidgetsUiStorageCall = WithoutResourceId<WidgetsUiStorageInput>;

/**
 * `widgets.ui.openLink`（能力桥外链，P1）：渲染端已出卡内确认条征得用户同意，core 再核一次
 * https-only 与无凭据（写法同 `apps.ui.openLink`），经主进程 `shell.openExternal` 打开。
 */
export const widgetsUiOpenLinkInputSchema = z.object({
  resourceId: z.string().min(1),
  url: z.string().min(1).max(2048),
});
export const widgetsUiOpenLinkOutputSchema = z.object({ ok: z.boolean() });

/**
 * `widgets.ui.query`（能力桥结构化查询，P2）：按名字调用本组件**当前卡片版本**登记的
 * 只读查询模板。core 用 resourceId 反查登记资源拿 widgetId + version（版本钉住：
 * 旧卡永远用旧模板），取该版本的模板执行；参数只有 JSON 标量（boolean 归一为 1/0）。
 * 行数超过 `BOT_WIDGET_QUERY_ROWS_MAX` 截断并标记 `truncated`（超时无法真中断：
 * better-sqlite3 同步执行，见设计 32 §6 与 service 注释）。
 */
export const widgetsUiQueryInputSchema = z.object({
  resourceId: z.string().min(1),
  name: z.string().min(1).max(BOT_WIDGET_QUERY_NAME_MAX_CHARS),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type WidgetsUiQueryInput = z.infer<typeof widgetsUiQueryInputSchema>;

export const widgetsUiQueryOutputSchema = z.object({
  /** 行是「列名 → 值」的对象；值已归一为 JSON 安全类型（BLOB → base64 字符串）。 */
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
});
export type WidgetsUiQueryOutput = z.infer<typeof widgetsUiQueryOutputSchema>;

/** 渲染端桥转发一次查询调用的形状（`WidgetsUiQueryInput` 去掉宿主附加的 resourceId）。 */
export type WidgetsUiQueryCall = Omit<WidgetsUiQueryInput, 'resourceId'>;

// --- 管理入口（P2，设计 32 §3：scope='bot' 组件的列表 / 删除 / 跨对话引用）------

/** `widgets.list`：Bot 详情「组件」Tab 的列表（该 Bot 的全部组件，含会话级）。 */
export const widgetsListInputSchema = z.object({ botId: z.string().min(1) });
export const widgetsListItemSchema = z.object({
  widgetId: z.string(),
  title: z.string(),
  description: z.string(),
  scope: widgetScopeSchema,
  /** 会话级组件的归属对话；scope='bot' 为 null。 */
  conversationId: z.string().nullable(),
  version: z.number().int(),
  versionCount: z.number().int(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  queriesCount: z.number().int(),
  updatedAt: z.number(),
});
export const widgetsListOutputSchema = z.object({
  widgets: z.array(widgetsListItemSchema),
});
export type WidgetsListItem = z.infer<typeof widgetsListItemSchema>;

/** `widgets.delete`：管理 Tab 删除组件（versions / docs / queries 随行级联，旧卡优雅报错）。 */
export const widgetsDeleteInputSchema = z.object({
  botId: z.string().min(1),
  widgetId: z.string().min(1),
});
export const widgetsDeleteOutputSchema = z.object({ ok: z.boolean() });

/**
 * `widgets.publish`：把 Bot 级组件的最新版本发卡到指定对话（跨对话引用）。与工具
 * `widget_publish` 同一服务方法；卡片走既有审查态流程（钉最新版本）。
 */
export const widgetsPublishInputSchema = z.object({
  botId: z.string().min(1),
  widgetId: z.string().min(1),
  conversationId: z.string().min(1),
});
export const widgetsPublishOutputSchema = z.object({
  ok: z.boolean(),
  /** ok=false 时的人话说明；ok=true 时与工具返回一致。 */
  message: z.string().optional(),
  cardMessageId: z.string().optional(),
});
