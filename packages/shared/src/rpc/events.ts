import { z } from 'zod';
import {
  approvalSchema,
  botSchema,
  conversationSchema,
  delegationSchema,
  draftSchema,
  envInstallSchema,
  environmentProgressPayloadSchema,
  grantSchema,
  messageSchema,
  projectSchema,
  runSchema,
  taskViewSchema,
  unattendedStateSchema,
  appConnectionStatusSchema,
} from '../domain/types.js';
import { agentStatusPayloadSchema } from '../domain/agent-status.js';
import { appConnectReviewToolSchema } from '../domain/app-connections.js';
import { watchEntrySchema } from '../domain/watches.js';

export const coreStatusSchema = z.enum(['starting', 'ready', 'locked', 'error']);
export type CoreStatus = z.infer<typeof coreStatusSchema>;

export const coreStatusPayloadSchema = z.object({
  status: coreStatusSchema,
  /** Human-readable reason for `locked` / `error`, already localized for display. */
  reason: z.string().optional(),
});
export type CoreStatusPayload = z.infer<typeof coreStatusPayloadSchema>;

// --- P01 events (docs/dev/phases/P01-direct-chat.md "事件") ----------------

export const messageCreatedPayloadSchema = z.object({
  conversationId: z.string(),
  message: messageSchema,
});
export const messageUpdatedPayloadSchema = messageCreatedPayloadSchema;

export const conversationUpdatedPayloadSchema = z.object({
  conversation: conversationSchema,
});
export const conversationDeletedPayloadSchema = z.object({ id: z.string() });

export const draftChangedPayloadSchema = z.object({
  conversationId: z.string(),
  drafts: z.array(draftSchema),
});

export const runStatusPayloadSchema = z.object({ run: runSchema });

export const runProgressPayloadSchema = z.object({
  runId: z.string(),
  conversationId: z.string().nullable(),
  /** Step description for the status line, e.g. "正在读取 3 个文件". */
  text: z.string().optional(),
  /** Tool the loop is calling right now; drives the 「正在调用工具 X」 status. */
  toolName: z.string().optional(),
});

export const botUpdatedPayloadSchema = z.object({ bot: botSchema });
export const botDeletedPayloadSchema = z.object({ id: z.string() });

// --- P03 events (docs/dev/phases/P03-permissions.md "事件") ------------------

export const approvalCreatedPayloadSchema = z.object({
  conversationId: z.string().nullable(),
  approval: approvalSchema,
});
export const approvalResolvedPayloadSchema = approvalCreatedPayloadSchema;

export const grantChangedPayloadSchema = z.object({
  conversationId: z.string(),
  /** Active grants of the conversation after the change. */
  grants: z.array(grantSchema),
});

export const unattendedChangedPayloadSchema = z.object({
  state: unattendedStateSchema,
});

// --- P04 events (docs/dev/phases/P04-project.md) -----------------------------

export const projectUpdatedPayloadSchema = z.object({ project: projectSchema });
export const projectRemovedPayloadSchema = z.object({ id: z.string() });

/**
 * A run started waiting for the write lease. `holder` names the bot+run that
 * currently holds it, so the interface can show "等待 X 完成对项目的修改"
 * with a force-revoke button.
 */
export const leaseWaitingPayloadSchema = z.object({
  runId: z.string(),
  conversationId: z.string().nullable(),
  botId: z.string().nullable(),
  path: z.string(),
  holder: z.object({
    runId: z.string(),
    botId: z.string().nullable(),
    conversationId: z.string().nullable(),
  }),
});

// --- P05 events (docs/dev/phases/P05-group-chat.md "事件") --------------------

/**
 * Group-conversation turn state: triaging (who should answer?), running (the
 * ordered responses), or idle (nothing in flight for the group right now).
 */
export const groupTurnPayloadSchema = z.object({
  conversationId: z.string(),
  /** The user batch driving the current turn; null while triaging. */
  batchId: z.string().nullable(),
  phase: z.enum(['triaging', 'running', 'idle']),
  currentBotId: z.string().nullable(),
  /** Bot ids still queued behind the current one. */
  queue: z.array(z.string()),
  /** User batches waiting to be (re-)dispatched after the current turn. */
  pendingBatches: z.number().int(),
});

/**
 * Events pushed by the core service to port A subscribers (renderer).
 * Handlers are exposed by the renderer as a nested object so that birpc
 * addresses them by their dotted event name (`core.status`).
 */
// --- P06 events (docs/dev/phases/P06-environment.md) --------------------------

export const environmentProgressPayload = environmentProgressPayloadSchema;

/** Snapshot of the env_installs list after any change (install/remove/recheck). */
export const environmentChangedPayloadSchema = z.object({
  installs: z.array(envInstallSchema),
});

// --- P08 events (docs/dev/phases/P08-skills.md) --------------------------------

/**
 * A bot's skill list changed (import approved, enable/disable, authoring…).
 * `botId: ''` = a PUBLIC skill changed (marketplace install / global toggle):
 * every loaded skills panel refreshes, not just one bot's.
 */
export const skillsChangedPayloadSchema = z.object({ botId: z.string() });

/**
 * A schedule of the conversation was created / cancelled / finished (D80):
 * the schedule lists refetch (there was no live refresh before).
 */
export const schedulesChangedPayloadSchema = z.object({
  conversationId: z.string(),
  scheduleId: z.string(),
});

// --- P09 events (docs/dev/phases/P09-wiki.md) ----------------------------------

/**
 * A wiki ingest finished for one bot. Also the mailbox event name
 * (`wiki_ingested`) delivered to the requesting conversation, where the bot
 * tells the user the material has been read (docs 任务 3).
 */
export const wikiIngestedPayloadSchema = z.object({
  botId: z.string(),
  /** Conversation that requested the ingest; null when it had none. */
  conversationId: z.string().nullable(),
  /** Wiki-root-relative raw file that stored the source material. */
  rawPath: z.string().nullable(),
  /** True when the source was already ingested (same content hash) and skipped. */
  skipped: z.boolean(),
});

/**
 * The bot's wiki content changed in any way (BR-P09-012): ingest completion,
 * dedupe skip or lint commit. The renderer refreshes the open Wiki tab on it.
 */
export const wikiChangedPayloadSchema = z.object({ botId: z.string() });

/** MCP server 连接状态（D65）：设置页状态展示与失败告警。 */
export const mcpServerStatusPayloadSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  /** `needs_auth`（D73）：OAuth server 未连接 / 令牌失效 / 需追加权限，不计入失败次数。 */
  status: z.enum(['connecting', 'connected', 'failed', 'closed', 'needs_auth']),
  /** 失败/关闭的补充说明（如进程退出原因）。 */
  detail: z.string().optional(),
});

/**
 * 交互授权流程进度（D73，design 29 §5.6）。`authorizationUrl` 仅在 `awaiting_consent`
 * 下发供用户核对（不含任何令牌）；`OAUTH_CLIENT_REQUIRED` 失败时带 `issuer` 与需用户在其
 * 平台登记的 `redirectUris`。
 */
export const appConnectFlowPayloadSchema = z.object({
  flowId: z.string(),
  phase: z.enum([
    'discovering',
    'awaiting_consent',
    'awaiting_browser',
    'exchanging',
    'reviewing_tools',
    'done',
    'failed',
    'cancelled',
  ]),
  authorizationHost: z.string().optional(),
  authorizationUrl: z.string().optional(),
  /**
   * 连接 id。目录连接在 `reviewing_tools` 前可能由临时行换成既有行（同一账号重复连接时复用旧行），
   * 所以 `reviewing_tools` / `done` 里的值才是最终的连接 id。
   */
  connectionId: z.string().optional(),
  /** `reviewing_tools`：识别出的账号显示名（可能为空）。 */
  accountLabel: z.string().optional(),
  /** `reviewing_tools`：待用户确认的工具清单（名称、标题、描述、风险档）；确认走 `apps.connect.confirmTools`。 */
  tools: z.array(appConnectReviewToolSchema).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      issuer: z.string().optional(),
      redirectUris: z.array(z.string()).optional(),
    })
    .optional(),
});
export type AppConnectFlowPayload = z.infer<typeof appConnectFlowPayloadSchema>;

export const appConnectionStatusPayloadSchema = z.object({
  connectionId: z.string(),
  status: appConnectionStatusSchema,
  /**
   * `tools_changed`（design 29 §8.2）的详情：待复核的工具数——新增（`added`）、定义被改
   * （`changed`）——与本次刷新中下线（被删除）的工具数（`removed`）。
   */
  tools: z
    .object({
      added: z.number().int().min(0),
      changed: z.number().int().min(0),
      removed: z.number().int().min(0),
    })
    .optional(),
});
export type AppConnectionStatusPayload = z.infer<typeof appConnectionStatusPayloadSchema>;

/** 跨 Bot 委派（D71）状态变化：A 侧发出卡 / 结果卡随之重绘。 */
export const delegationUpdatedPayloadSchema = z.object({ delegation: delegationSchema });

/**
 * D75 任务（design 30 §4.3）：任务的任何可见变化——派出、排队原因、开始执行、
 * 注入（含之后降级为未送达）、提问、结算——都推一次完整视图；任务卡与
 * 状态行据此重绘。
 */
export const taskUpdatedPayloadSchema = z.object({ task: taskViewSchema });

/**
 * W3（D78）：用户撤销授权（路径授权 / MCP 停用、移出、改为每次确认）后，受影响
 * 的进行中任务被立即中断；只在 count > 0 时推送，渲染端据此提示「已中断 N 个进行中的任务」。
 */
export const tasksInterruptedPayloadSchema = z.object({
  count: z.number().int().positive(),
  /** W8: `browser_profile_changed` — a bot's browser profile was switched. */
  reason: z.enum(['permission_revoked', 'browser_profile_changed']),
  scope: z.enum(['path', 'mcp', 'browser_profile']),
});

/** W7 确定性监看：监看行任何可见变化（创建、检查结果、提醒、暂停 / 恢复 / 停止、删除）。 */
export const watchUpdatedPayloadSchema = z.object({
  watch: watchEntrySchema,
  /** The watch row is gone (its bot or conversation was deleted). */
  removed: z.boolean().optional(),
});

export const rpcEventSchemas = {
  'core.status': coreStatusPayloadSchema,
  'message.created': messageCreatedPayloadSchema,
  'message.updated': messageUpdatedPayloadSchema,
  'conversation.updated': conversationUpdatedPayloadSchema,
  'conversation.deleted': conversationDeletedPayloadSchema,
  'draft.changed': draftChangedPayloadSchema,
  'run.status': runStatusPayloadSchema,
  'run.progress': runProgressPayloadSchema,
  'bot.updated': botUpdatedPayloadSchema,
  'bot.deleted': botDeletedPayloadSchema,
  'approval.created': approvalCreatedPayloadSchema,
  'approval.resolved': approvalResolvedPayloadSchema,
  'grant.changed': grantChangedPayloadSchema,
  'unattended.changed': unattendedChangedPayloadSchema,
  'project.updated': projectUpdatedPayloadSchema,
  'project.removed': projectRemovedPayloadSchema,
  'lease.waiting': leaseWaitingPayloadSchema,
  'group.turn': groupTurnPayloadSchema,
  'environment.progress': environmentProgressPayload,
  'environment.changed': environmentChangedPayloadSchema,
  'skills.changed': skillsChangedPayloadSchema,
  'schedules.changed': schedulesChangedPayloadSchema,
  wiki_ingested: wikiIngestedPayloadSchema,
  wiki_changed: wikiChangedPayloadSchema,
  'mcp.server_status': mcpServerStatusPayloadSchema,
  'apps.connect_flow': appConnectFlowPayloadSchema,
  'apps.connection_status': appConnectionStatusPayloadSchema,
  'delegation.updated': delegationUpdatedPayloadSchema,
  'task.updated': taskUpdatedPayloadSchema,
  'tasks.interrupted': tasksInterruptedPayloadSchema,
  'watch.updated': watchUpdatedPayloadSchema,
  /** 外部智能体（D72）本机状态变化：安装进度、登录输出、启停。 */
  'agent.status': agentStatusPayloadSchema,
} as const;

export type RpcEventName = keyof typeof rpcEventSchemas;

/** All event names for generic subscription wiring. */
export const RPC_EVENT_NAMES = Object.keys(rpcEventSchemas) as RpcEventName[];
export type RpcEventPayload<E extends RpcEventName> = z.infer<(typeof rpcEventSchemas)[E]>;

/** Nested handler map the renderer registers on its birpc client. */
export type CoreEventHandler = (payload: unknown) => void;
export type RpcEventSchemas = typeof rpcEventSchemas;

// --- Platform events (port B, core -> main process) ---------------------------

/** Request a system notification; the main process skips it while focused. */
export const platformNotifyPayloadSchema = z.object({
  conversationId: z.string().nullable(),
  /** Notification title, e.g. the bot name. */
  title: z.string(),
  body: z.string(),
});
export const platformUnattendedPayloadSchema = z.object({
  active: z.boolean(),
  until: z.number().nullable(),
});

/**
 * Launch-at-login setting changed (P13 任务 3). Emitted when the setting is
 * updated and pushed once when the platform port binds, so the main process
 * can reconcile the OS login item with core's stored setting.
 */
export const platformAutostartPayloadSchema = z.object({ enabled: z.boolean() });

export const platformEventSchemas = {
  'platform.notify': platformNotifyPayloadSchema,
  'platform.unattended': platformUnattendedPayloadSchema,
  'platform.autostart': platformAutostartPayloadSchema,
} as const;
export type PlatformEventName = keyof typeof platformEventSchemas;
export const PLATFORM_EVENT_NAMES = Object.keys(platformEventSchemas) as PlatformEventName[];
export type PlatformEventPayload<E extends PlatformEventName> = z.infer<
  (typeof platformEventSchemas)[E]
>;
export type PlatformEventsMap = {
  [K in PlatformEventName]: PlatformEventPayload<K>;
};
