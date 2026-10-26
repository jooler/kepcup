import { z } from 'zod';
import { agentCatalogEntrySchema } from '../domain/agent-catalog.js';
import { askUserValuesSchema } from '../domain/ask-user.js';
import { PROJECT_TITLE_MAX } from '../domain/project-title.js';
import {
  widgetPreviewRunInputSchema,
  widgetPreviewRunOutputSchema,
} from '../domain/widget-craft.js';
import {
  mailAccountCreateInputSchema,
  mailAccountGetOutputSchema,
  mailAccountIdInputSchema,
  mailAccountSetBotsInputSchema,
  mailAccountTestInputSchema,
  mailAccountTestOutputSchema,
  mailAccountUpdateInputSchema,
  mailAccountsListOutputSchema,
  mailBindingResumeInputSchema,
  mailBotSetAccountsInputSchema,
} from '../domain/mail.js';
import {
  appsSkillsInstallInputSchema,
  appsSkillsInstallOutputSchema,
  appsSkillsOffersInputSchema,
  appsSkillsOffersOutputSchema,
} from '../domain/app-skills.js';
import { appsDirectoryStatusSchema } from '../domain/directory-index.js';
import { handoverViewSchema } from '../domain/handover.js';
import {
  settingCardStateSchema,
  settingTargetSchema,
  settingValuesSchema,
} from '../settings-catalog/cards.js';
import {
  appsLocalConnectorsConfirmInputSchema,
  appsLocalConnectorsConfirmOutputSchema,
  appsLocalConnectorsListOutputSchema,
  appsLocalConnectorsRejectInputSchema,
  appsLocalConnectorsRemoveInputSchema,
} from '../domain/local-connectors.js';
import {
  filePreviewResourceInputSchema,
  filePreviewResourceOutputSchema,
  filePreviewSessionInputSchema,
  filePreviewSessionOutputSchema,
} from '../domain/file-preview.js';
import {
  appsUiCallToolInputSchema,
  appsUiCallToolOutputSchema,
  appsUiCloseInputSchema,
  appsUiOpenInputSchema,
  appsUiOpenLinkInputSchema,
  appsUiOpenLinkOutputSchema,
  appsUiOpenOutputSchema,
  appsUiResourceInputSchema,
  appsUiResourceOutputSchema,
} from '../domain/apps-ui.js';
import {
  widgetsDeleteInputSchema,
  widgetsDeleteOutputSchema,
  widgetsListInputSchema,
  widgetsListOutputSchema,
  widgetsPublishInputSchema,
  widgetsPublishOutputSchema,
  widgetsUiCloseInputSchema,
  widgetsUiOpenInputSchema,
  widgetsUiOpenLinkInputSchema,
  widgetsUiOpenLinkOutputSchema,
  widgetsUiOpenOutputSchema,
  widgetsUiPosterInputSchema,
  widgetsUiPosterOutputSchema,
  widgetsUiQueryInputSchema,
  widgetsUiQueryOutputSchema,
  widgetsUiReplyInputSchema,
  widgetsUiReplyOutputSchema,
  widgetsUiResourceInputSchema,
  widgetsUiResourceOutputSchema,
  widgetsUiSourceInputSchema,
  widgetsUiSourceOutputSchema,
  widgetsUiStorageInputSchema,
  widgetsUiStorageOutputSchema,
} from '../domain/widgets-ui.js';
import {
  mcpbInspectInputSchema,
  mcpbInspectOutputSchema,
  mcpbInstallInputSchema,
  mcpbInstallOutputSchema,
} from '../domain/mcpb.js';
import {
  botsTemplateExportInputSchema,
  botsTemplateExportOutputSchema,
  botsTemplateImportInputSchema,
  botsTemplateImportOutputSchema,
  botsTemplateInspectInputSchema,
  botsTemplateInspectOutputSchema,
  botsTemplatePreviewInputSchema,
  botsTemplatePreviewOutputSchema,
} from '../domain/bot-template.js';
import {
  oauthClientsListOutputSchema,
  oauthClientsRemoveInputSchema,
  oauthClientsSetInputSchema,
} from '../domain/oauth-clients.js';
import {
  appCatalogEntrySchema,
  appToolGrantViewSchema,
  appToolViewSchema,
  appToolsPendingSchema,
} from '../domain/app-connections.js';
import {
  agentIdInputSchema,
  agentOutputSchema,
  agentsAffectingOutputSchema,
  agentsConfigureInputSchema,
  agentsConfirmInputSchema,
  agentsEffortsInputSchema,
  agentsEffortsOutputSchema,
  agentsEnableInputSchema,
  agentsListOutputSchema,
  agentsLoginInputSchema,
  agentsLogoutInputSchema,
  agentsOptionsInputSchema,
  agentsOptionsOutputSchema,
  agentsTestOutputSchema,
} from '../domain/agent-status.js';
import {
  agentSettingInputSchema,
  allowlistEntrySchema,
  appAuthReasonSchema,
  appConnectionSchema,
  appConnectTargetSchema,
  approvalDurationSchema,
  approvalSchema,
  attachmentSchema,
  botProfileSchema,
  botSchema,
  delegationSchema,
  taskViewSchema,
  toolEffectSchema,
  effectStatusSchema,
  conversationSchema,
  customProviderSchema,
  capabilityModelsSchema,
  embeddingStatusSchema,
  envInstallSchema,
  envSystemStatusSchema,
  episodeSchema,
  grantSchema,
  memoryItemSchema,
  messageSchema,
  onboardingStatePatchSchema,
  profileCardSchema,
  profileItemSchema,
  workdirProtectRulesSchema,
  workdirSchema,
  runChangeSchema,
  providerConcurrencySchema,
  runSchema,
  runStepSchema,
  memoSchema,
  scheduleEntrySchema,
  scheduleSchema,
  settingsSchema,
  taskLoopSettingsInputSchema,
  appLanguageSchema,
  todoAssigneeSchema,
  todoEntrySchema,
  todoRunSchema,
  todoStatusSchema,
  browserProfileSchema,
  skillCandidateSchema,
  mcpServerSchema,
  mcpToolPolicySchema,
  mcpToolRiskSchema,
  mcpToolRiskSourceSchema,
  webSearchProviderSchema,
  webSearchConfigSchema,
  skillEntrySchema,
  skillHistoryEntrySchema,
  skillPresetInfoSchema,
  unattendedStateSchema,
  usageSummaryOutputSchema,
  wikiHistoryEntrySchema,
  wikiPageSchema,
  wikiSearchHitSchema,
  type ProviderInfo,
} from '../domain/types.js';
import { wikiOwnerSchema } from '../domain/wiki.js';
import { boardCardSchema, boardColumnSchema, boardSummarySchema } from '../domain/board.js';
import {
  pairingOfferSchema,
  pairedDeviceSchema,
  pendingPairingRequestSchema,
  relayEndpointSchema,
  remoteAnchorStateSchema,
  remoteDeviceIdSchema,
  type PairingOffer,
} from '../domain/remote.js';
import { modelCapabilitySchema, vendorProviderSchema } from '../domain/vendors.js';
import { agentIdSchema } from '../domain/agent-catalog.js';
import type { BrowserNetworkContext } from '../browser/net-rules.js';
import {
  BROWSER_PROFILE_NAME_MAX_CHARS,
  MEMO_BODY_MAX_CHARS,
  PROJECT_GOAL_MAX_CHARS,
  TODO_NOTES_MAX_CHARS,
  TODO_TITLE_MAX_CHARS,
  WATCH_SELECTOR_MAX_CHARS,
} from '../constants.js';
import { watchEntrySchema } from '../domain/watches.js';
import {
  STICKIE_TEXT_MAX_CHARS,
  stickiePositionSchema,
  stickieScopeSchema,
  stickieSchema,
} from '../domain/stickies.js';
import {
  shareConsumeInputSchema,
  shareConsumeOutputSchema,
  shareFailedDiscardInputSchema,
  shareFailedListOutputSchema,
  shareFailedRetryInputSchema,
  shareFailedRetryOutputSchema,
  shareTargetsSchema,
  type ShareConsumeInput,
  type ShareConsumeOutput,
  type ShareTargets,
} from '../domain/share.js';

/** Every RPC method: `domain.action`. Wire name is the dotted key. */
export const systemPingOutputSchema = z.object({
  pong: z.literal(true),
  ts: z.number(),
});
export type SystemPingOutput = z.infer<typeof systemPingOutputSchema>;

export const systemInfoOutputSchema = z.object({
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  nodeVersion: z.string(),
  dataDir: z.string(),
  coreStatus: z.enum(['starting', 'ready', 'locked', 'error']),
});
export type SystemInfoOutput = z.infer<typeof systemInfoOutputSchema>;

export const systemShutdownOutputSchema = z.object({ ok: z.literal(true) });

// --- diagnostics (P13 任务 6, 设置页「诊断」) --------------------------------
// One aggregated, read-only snapshot per refresh. Everything the task book
// lists: core status, databases (open state + migration version), keystore,
// sandbox, toolchain (P06 doctor rows), disk usage, logs directory. The path
// of the logs directory is returned so the renderer can hand it to the main
// process ("在文件管理器中打开" is a main-process capability).

export const diagnosticsDatabaseRowSchema = z.object({
  name: z.string(),
  open: z.boolean(),
  /** `PRAGMA user_version` of the open database. */
  version: z.number().int().optional(),
  /** Highest migration file version next to the compiled module. */
  targetVersion: z.number().int().optional(),
  bytes: z.number().int().optional(),
  /** Human-readable extra (per-bot memory库 count, failure detail…). */
  detail: z.string().optional(),
});
export type DiagnosticsDatabaseRow = z.infer<typeof diagnosticsDatabaseRowSchema>;

export const diagnosticsToolRowSchema = z.object({
  /** Row id: catalog item id or `system:{item}` for live-detected entries. */
  id: z.string(),
  kind: z.string(),
  healthy: z.boolean(),
  detail: z.string(),
});
export type DiagnosticsToolRow = z.infer<typeof diagnosticsToolRowSchema>;

export const diagnosticsOutputSchema = z.object({
  core: z.object({
    status: z.enum(['starting', 'ready', 'locked', 'error']),
    statusReason: z.string().optional(),
    nodeVersion: z.string(),
    platform: z.string(),
    arch: z.string(),
    /** Utility-process uptime in seconds (the core service's lifetime). */
    uptimeSec: z.number().int(),
  }),
  dataDir: z.string(),
  dataDirBytes: z.number().int(),
  /**
   * BR-P13-006: the walk hit the entry budget — `dataDirBytes` is a LOWER
   * bound (the UI says so explicitly instead of dropping the flag).
   */
  dataDirTruncated: z.boolean().optional(),
  logsDir: z.string(),
  logsBytes: z.number().int(),
  /** Same lower-bound flag as dataDirTruncated, for the logs directory. */
  logsTruncated: z.boolean().optional(),
  keystore: z.object({
    kind: z.string(),
    ok: z.boolean(),
    reason: z.string().optional(),
  }),
  databases: z.array(diagnosticsDatabaseRowSchema),
  sandbox: z.object({
    backend: z.string(),
    available: z.boolean(),
    reason: z.string().optional(),
    enhancedBackend: z.string().nullable(),
    enhancedAvailable: z.boolean().nullable(),
  }),
  toolchain: z.array(diagnosticsToolRowSchema),
});
export type DiagnosticsOutput = z.infer<typeof diagnosticsOutputSchema>;
export type SystemShutdownOutput = z.infer<typeof systemShutdownOutputSchema>;

// --- update gate (P13 任务 2, port B platform methods) ----------------------
// The main process owns electron-updater; the core only answers "is anything
// executing?" and cancels on explicit user confirmation. Never forced.

export const updateActiveRunInfoSchema = z.object({
  id: z.string(),
  botId: z.string().nullable(),
  conversationId: z.string().nullable(),
  loopType: z.string(),
  status: z.string(),
});
export type UpdateActiveRunInfo = z.infer<typeof updateActiveRunInfoSchema>;

export const updateActiveRunsOutputSchema = z.object({ runs: z.array(updateActiveRunInfoSchema) });
export type UpdateActiveRunsOutput = z.infer<typeof updateActiveRunsOutputSchema>;

export const updateCancelActiveInputSchema = z.object({
  /** Audit/human-readable cause, e.g. "user confirmed update install". */
  reason: z.string().min(1).max(500),
});
export const updateCancelActiveOutputSchema = z.object({
  cancelled: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), reason: z.string() })),
});
export type UpdateCancelActiveOutput = z.infer<typeof updateCancelActiveOutputSchema>;

const voidInput = z.void();
export const okOutputSchema = z.object({ ok: z.literal(true) });
const okOutput = okOutputSchema;
export const conversationsMarkReadOutputSchema = okOutputSchema;
export const conversationsDeleteOutputSchema = okOutputSchema;

// --- settings -------------------------------------------------------------

export const settingsGetOutputSchema = settingsSchema;
// Plain optionals instead of settingsSchema.partial(): zod would apply the
// inner defaults for missing keys and a partial update would erase stored
// custom providers / model defaults.
export const settingsUpdateInputSchema = z.object({
  appLanguage: appLanguageSchema.optional(),
  customProviders: z.array(customProviderSchema).optional(),
  vendorProviders: z.array(vendorProviderSchema).optional(),
  defaultMainModel: z.string().optional(),
  defaultLightModel: z.string().optional(),
  /** D87 P3c 组件审查模型；'' = 跟随 Bot 主模型。 */
  widgetReviewModel: z.string().optional(),
  /** 能力模型配置（整体覆盖 patch；UI 传完整 capabilityModels）。 */
  capabilityModels: capabilityModelsSchema.optional(),
  providerConcurrency: providerConcurrencySchema.optional(),
  /** P13 任务 3: launch at login (main process applies it to the OS). */
  launchAtLogin: z.boolean().optional(),
  /** 侧栏工作台入口开关（D90）。 */
  workbenchEnabled: z.boolean().optional(),
  /** 工作台引导已永久关闭。 */
  workbenchNudgeDismissed: z.boolean().optional(),
  /** D93 任务 Loop：空转检测与软预算。 */
  taskLoop: taskLoopSettingsInputSchema.optional(),
  /** InkCop 同机协作（v0.3）：部分 patch；systemBotId 仅兼容旧配置。 */
  inkcopLocalCollab: z
    .object({
      enabled: z.boolean().optional(),
      systemBotId: z.string().optional(),
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
    })
    .optional(),
  /** P13 任务 4: first-run wizard completion flags (partial patch). */
  onboarding: onboardingStatePatchSchema.optional(),
  /** MCP server 列表（D65）：整体覆盖 patch；密钥走 mcp.setSecret，UI 写占位符。 */
  mcpServers: z.array(mcpServerSchema).optional(),
  /** 联网检索供应商（docs/design/21-web-search.md）：整体覆盖 patch；key 走 websearch.setKey。 */
  webSearch: webSearchConfigSchema.optional(),
  /** 外部智能体启用状态（D72）：整体覆盖 patch。 */
  agents: z.record(agentIdSchema, agentSettingInputSchema).optional(),
  /** 实验开关（D72）：部分 patch，与已存值合并。 */
  experimental: z.object({ externalAgents: z.boolean().optional() }).optional(),
  /** 连接应用设置（D73 P2）：部分 patch；只开放 `developerMode`（其余字段 core 自有）。 */
  apps: z
    .object({
      developerMode: z.boolean().optional(),
      taintGuard: z.boolean().optional(),
      directorySync: z.boolean().optional(),
    })
    .optional(),
  /** 后台 loop 选用的 Agent（P6）；'' = 自动。 */
  backgroundAgentId: z.string().optional(),
  /** 后台任务开关（P6）：部分 patch，与已存值合并。 */
  backgroundTasks: z
    .object({
      agentEnabled: z.boolean().optional(),
      agentSkillAuthoring: z.boolean().optional(),
      projectMentionOnly: z.boolean().optional(),
    })
    .optional(),
  /** 新建 Bot 的默认外部 Agent（onboarding 订阅分支）；'' 清除。 */
  defaultAgentId: z.string().optional(),
  /** D96 远程遥控：总开关与中转地址（部分 patch；条目 `remote.enabled` / `remote.relay`）。 */
  remoteEnabled: z.boolean().optional(),
  remoteRelayUrl: relayEndpointSchema.optional(),
  /** 用户个人资料（Profile）：显示名与头像引用（条目 `profile.user-name` / `profile.user-avatar`）。 */
  userProfileName: z.string().optional(),
  userProfileAvatar: z.string().optional(),
  /**
   * D89 审查修复：这份补丁是从哪一版设置快照改出来的（只需带补丁里的顶层键）。给了就由 core 按
   * 键三方合并（`mergeThreeWay`）：表单没改的字段保留最新值（Bot 直改、设置卡、别处保存的不被
   * 过期表单覆盖），按 id 寻址的数组按条合并；两边都改了同一字段以这次保存为准。不给 = 整体覆盖
   * （老行为）。
   */
  base: z.record(z.string(), z.unknown()).optional(),
});

// --- 设置目录（todo/conversational-app-setup.md §4.1 / §6）---------------------

/**
 * 卡片 / 设置页按目录条目保存（条目级 CAS）：core 在设置写锁内「读 → 只比对并改本条目的
 * 字段 → 写回」，不发整对象，撤销或过期卡不会覆盖兄弟字段的并发修改。来自渲染层（用户亲手
 * 填写），`values` 可以含敏感字段（如 Key），core 按条目适配器分发到 secrets，永不回显。
 */
export const settingsItemsApplyInputSchema = z.object({
  itemId: z.string().min(1),
  values: settingValuesSchema,
  /**
   * 期望的当前值（卡片出卡时的 `before`）：与 core 读到的本条目非敏感字段逐键比对，不一致即
   * `conflict`、不写入。null = 不比对（设置页直接保存、渲染层条目）。
   */
  expected: settingValuesSchema.nullable(),
  /** 作用对象（bot / group / workdir 条目必填对应 id）。 */
  target: settingTargetSchema.optional(),
  /** 从设置卡应用时带卡片消息 id：成功后卡片标 applied 并唤醒 Bot（§6.2）。 */
  messageId: z.string().min(1).optional(),
});
export const settingsItemsApplyOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    itemId: z.string(),
    /** 写入前的非敏感字段值（回执 / 撤销用）；渲染层条目为 null。 */
    before: settingValuesSchema.nullable(),
    /** 写入后的非敏感字段值（敏感字段不回显）。 */
    values: settingValuesSchema,
  }),
  z.object({
    status: z.literal('conflict'),
    itemId: z.string(),
    /** 当前的非敏感字段值：卡片据此刷新「当前 → 建议」对比后再让用户确认。 */
    current: settingValuesSchema.nullable(),
  }),
]);
export type SettingsItemsApplyOutput = z.infer<typeof settingsItemsApplyOutputSchema>;

/** 设置卡动作（同 D80 提议卡）：卡片的消息 id。 */
export const settingsCardInputSchema = z.object({ messageId: z.string().min(1) });
/**
 * 「我已设置好」的输入。`auto`：打开对话时渲染层对待处理卡片的自动核对（用户没点任何东西）——
 * 只在条目相对出卡时确实变过才结卡，否则原样 pending，不唤醒 Bot（同一张卡有限频）。
 */
export const settingsCardsCompleteInputSchema = settingsCardInputSchema.extend({
  auto: z.boolean().optional(),
});
/** 「不用了」：卡片标 dismissed，唤醒 Bot 一次（§6.2）；已落定的卡原样返回其状态。 */
export const settingsCardsDismissOutputSchema = z.object({ state: settingCardStateSchema });
/**
 * 「我已设置好」（link 卡 / 渲染层条目，§6.1）：core 能用适配器核对的核对一次——
 * `verified`：true 核对通过、false 核对未通过（卡片保持 pending 并提示）、null 无法核对
 * （渲染层 / 只读条目，按用户所说标 applied）。
 */
export const settingsCardsCompleteOutputSchema = z.object({
  state: settingCardStateSchema,
  verified: z.boolean().nullable(),
});
/**
 * 回执卡「撤销」（§5.3）：用卡上保存的旧值经同一套 CAS 写回；当前值已不是新值 → conflict、
 * 不覆盖。撤销成功卡片标 reverted，不唤醒 Bot。
 */
export const settingsCardsUndoOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('reverted'), values: settingValuesSchema }),
  z.object({ status: z.literal('conflict'), current: settingValuesSchema.nullable() }),
]);
export type SettingsCardsUndoOutput = z.infer<typeof settingsCardsUndoOutputSchema>;

// --- MCP（D65）--------------------------------------------------------------

export const mcpTestInputSchema = z.object({
  server: mcpServerSchema,
  /**
   * 草稿态密钥覆盖（设置页表单「保存前测试」）：键为 env / header 变量名，
   * 仅本次连接测试生效，不落 secrets 表；同名占位符优先取这里的值。
   */
  secretValues: z
    .object({
      env: z.record(z.string(), z.string()).optional(),
      header: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});
export const mcpTestOutputSchema = z.object({
  tools: z.array(z.string()),
  /** 未能解析的占位符密钥名（secret:env:x / secret:header:y）。 */
  missingSecrets: z.array(z.string()).default([]),
  /** D73：OAuth server 未连接 / 授权失效 / 需追加权限时 `tools` 为空，并带原因与可读说明。 */
  needsAuth: appAuthReasonSchema.optional(),
  message: z.string().optional(),
  /**
   * D73 P1：测试时看到的每个工具的定义哈希（工具名 → sha256）。保存后传给
   * `apps.tools.approveAfterTest`，只批准「测试时看到的那份定义」（测试与保存之间被改动的
   * 定义仍然锁定）。
   */
  toolHashes: z.record(z.string(), z.string()).optional(),
});

/** D73：显式删除自定义 server，并清理其 `mcp:{id}:*` 密钥、令牌与连接行。 */
export const mcpRemoveServerInputSchema = z.object({ serverId: z.string().min(1) });

// --- 连接应用（D73，docs/design/29-connected-apps.md） -----------------------

const appFlowIdInputSchema = z.object({ flowId: z.string().min(1) });
/** `apps.connect`：P0 只接受 `custom` 目标；同一目标并发调用返回同一 flowId。 */
export const appsConnectInputSchema = z.object({
  target: appConnectTargetSchema,
  /** 追加授权时的完整 scope 集合（旧 ∪ 新）；缺省按服务端 / 目录默认。 */
  scopes: z.array(z.string()).optional(),
  /**
   * 连接完成后由 core 把连接 id 写进该 Bot 的 `app_connection_ids`（P1；不由渲染端改 Profile）。
   * 仅 `catalog` 目标有意义。与进行中的同目标流程去重时并入其 Bot 集合（完成时每个 Bot 都授权）。
   */
  grantBotId: z.string().optional(),
  /**
   * 重新授权一个已有的目录连接（过期 / 权限追加）：令牌换到该行上而不是新建账号。仅 `catalog`
   * 目标；`connectorId` 必须与该连接一致。
   */
  connectionId: z.string().min(1).optional(),
});
export const appsConnectOutputSchema = z.object({ flowId: z.string() });
export const appsConnectContinueInputSchema = appFlowIdInputSchema;
export const appsConnectCancelInputSchema = appFlowIdInputSchema;
/** 首连工具复核通过（`reviewing_tools` 阶段）：批准全部待复核工具 → connected。拒绝 = `apps.connect.cancel`。 */
export const appsConnectConfirmToolsInputSchema = appFlowIdInputSchema.extend({
  /**
   * 社区应用（D73 P3 §7.2）：用户已勾选「我了解风险」。目录条目分级为 `community` 的流程
   * 缺它（或为 false）时 core 拒绝确认；其他分级忽略。
   */
  acknowledgeCommunity: z.boolean().optional(),
});
export const appsConnectionsListInputSchema = z
  .object({
    /** 默认不返回 `custom:` 行（自定义 server 的占位连接）。 */
    includeCustom: z.boolean().optional(),
  })
  .default({});
export const appsConnectionsListOutputSchema = z.object({
  connections: z.array(appConnectionSchema),
});
export const appsDisconnectInputSchema = z.object({ connectionId: z.string().min(1) });

// --- 连接应用 P2：BYO / 预注册 OAuth 客户端、开发者模式（§6.4 / §6.6） -------
export const appsOauthClientsListOutputSchema = oauthClientsListOutputSchema;
export const appsOauthClientsSetInputSchema = oauthClientsSetInputSchema;
export const appsOauthClientsRemoveInputSchema = oauthClientsRemoveInputSchema;

/**
 * 开发者模式的「授权流程事件日志」一行：来自 `apps.connect_flow` 的脱敏副本，永不含令牌 /
 * code / state；授权地址只保留 host + path。
 */
export const appFlowLogEntrySchema = z.object({
  at: z.number(),
  flowId: z.string(),
  phase: z.string(),
  authorizationHost: z.string().optional(),
  /** 仅 `scheme://host/path`，不含 query / fragment。 */
  authorizationUrl: z.string().optional(),
  /** 本次所用客户端的来源（`client_selected` 条目）。 */
  clientSource: z.enum(['preregistered', 'manual', 'cimd', 'dcr']).optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  issuer: z.string().optional(),
});
export type AppFlowLogEntry = z.infer<typeof appFlowLogEntrySchema>;
export const appsFlowLogInputSchema = z.object({ serverId: z.string().min(1) });
export const appsFlowLogOutputSchema = z.object({ entries: z.array(appFlowLogEntrySchema) });

/** 原始工具定义（含 annotations / inputSchema，原样 JSON）。 */
export const mcpRawToolsInputSchema = z.object({ serverId: z.string().min(1) });
export const mcpRawToolsOutputSchema = z.object({
  tools: z.array(z.record(z.string(), z.unknown())),
});
export const mcpRefreshToolsInputSchema = mcpRawToolsInputSchema;
export const mcpRefreshToolsOutputSchema = mcpRawToolsOutputSchema;

// --- 连接应用 P1：目录 / 连接管理 / 工具复核 / 持续授权 ---------------------
export const appsCatalogListOutputSchema = z.object({ entries: z.array(appCatalogEntrySchema) });
/** 目录同步状态（D73 P3 §7.1）：`apps.directory.status` / 手动同步 `apps.directory.sync` 共用。 */
export const appsDirectoryStatusOutputSchema = appsDirectoryStatusSchema;
export const appsConnectionsUpdateInputSchema = z.object({
  connectionId: z.string().min(1),
  /** 账号显示名。 */
  label: z.string().trim().min(1).max(100).optional(),
  /** true = 停用（保留授权，不再暴露给 Bot）；false = 启用。 */
  disabled: z.boolean().optional(),
});
export const appsConnectionsUpdateOutputSchema = z.object({ connection: appConnectionSchema });
export const appsConnectionIdInputSchema = z.object({ connectionId: z.string().min(1) });
/** 目录连接的逐工具策略（存 `app_connection_tools.user_policy`）；自定义 server 继续用 `settings.mcpServers[].toolPolicies`。 */
export const appsConnectionsSetToolPolicyInputSchema = z.object({
  connectionId: z.string().min(1),
  toolName: z.string().min(1),
  /** 空对象 = 清除，回到风险档默认。 */
  policy: mcpToolPolicySchema,
});
export const appsConnectionsToolsOutputSchema = z.object({
  tools: z.array(appToolViewSchema),
  /** 待复核（新增 / 定义变化）的工具数。 */
  pending: appToolsPendingSchema,
});
export const appsConnectionsReviewToolsInputSchema = z.object({
  connectionId: z.string().min(1),
  /** 复核通过的工具名；其余保持锁定。 */
  accept: z.array(z.string().min(1)).max(500),
});
export const appsConnectionsReviewToolsOutputSchema = z.object({
  approved: z.array(z.string()),
  tools: z.array(appToolViewSchema),
  pending: appToolsPendingSchema,
});
export const appsConnectionsGrantsOutputSchema = z.object({
  grants: z.array(appToolGrantViewSchema),
});
export const appsGrantsRevokeInputSchema = z.object({ grantId: z.string().min(1) });
/** D73 P2：Bot 详情的污点外发汇总——无人值守下自动批准的外发（审计 `egress_tainted`）。 */
export const appsEgressSummaryInputSchema = z.object({ botId: z.string().min(1) });
/** 关闭「污点外发」汇总 = 删除该 Bot 的 `egress_tainted` 审计记录；返回删除条数。 */
export const appsEgressClearInputSchema = z.object({ botId: z.string().min(1) });
export const appsEgressClearOutputSchema = z.object({ deleted: z.number().int().min(0) });
export const appsEgressSummaryOutputSchema = z.object({
  /** 放行的次数（审计 `approved !== false`）。 */
  total: z.number().int().min(0),
  /** 被无人值守底线拒绝的次数（`approved: false`）。 */
  refused: z.number().int().min(0),
  recent: z.array(
    z.object({
      at: z.number(),
      conversationId: z.string().nullable(),
      channel: z.string(),
      target: z.string(),
      approved: z.boolean(),
    }),
  ),
});
/** 自定义 server「测试 → 保存」：保存后批准测试时看到的工具定义（见 `mcp.test` 的 `toolHashes`）。 */
export const appsToolsApproveAfterTestInputSchema = z.object({
  serverId: z.string().min(1),
  toolHashes: z.record(z.string(), z.string()),
});
export const appsToolsApproveAfterTestOutputSchema = z.object({
  approved: z.array(z.string()),
  pending: appToolsPendingSchema,
});
/** 手填客户端：issuer 只有在失败的流程里才知道，所以以 flowId 定位；只写不读回。 */
export const appsSetClientCredentialsInputSchema = z.object({
  flowId: z.string().min(1),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().max(2048).optional(),
});

/** 主进程服务的外部打开：只允许 https，或主机为回环地址的 http（main 侧再校验）。 */
export const shellOpenExternalInputSchema = z.object({ url: z.string().min(1).max(8192) });
export const shellOpenExternalOutputSchema = z.object({ ok: z.boolean() });
export type ShellOpenExternalInput = z.infer<typeof shellOpenExternalInputSchema>;
export type ShellOpenExternalOutput = z.infer<typeof shellOpenExternalOutputSchema>;

/**
 * W5：设置页逐工具策略用的工具风险档。core 按已保存的 server 配置连接并列出
 * 工具（应用级未启用的 server 用一次性连接，不落缓存）；toolPolicies 里有、
 * 但工具列表里已没有的工具以 missing:true 返回（设置页标灰，配置保留）。
 */
export const mcpToolRisksInputSchema = z.object({ serverId: z.string().min(1) });
export const mcpToolRisksOutputSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().default(''),
      risk: mcpToolRiskSchema,
      source: mcpToolRiskSourceSchema,
      missing: z.boolean().default(false),
    }),
  ),
  /** 连接失败时的原因（tools 仍含 missing 的已配置工具）。 */
  error: z.string().optional(),
});
export type McpToolRisksOutput = z.infer<typeof mcpToolRisksOutputSchema>;

/** MCP 密钥（D65）：只写不读——渲染层传明文值，core 落 secrets 表字段级加密。 */
export const mcpSecretKindSchema = z.enum(['env', 'header']);
export const mcpSetSecretInputSchema = z.object({
  serverId: z.string().min(1),
  kind: mcpSecretKindSchema,
  name: z.string().min(1).max(200),
  value: z.string().max(20_000),
});
export const mcpRemoveSecretInputSchema = z.object({
  serverId: z.string().min(1),
  kind: mcpSecretKindSchema,
  name: z.string().min(1).max(200),
});

// --- providers ------------------------------------------------------------

export const providersListOutputSchema = z.object({
  providers: z.custom<ProviderInfo[]>((v) => Array.isArray(v)),
});
export const providerNameInputSchema = z.object({ provider: z.string().min(1) });
export const providersSetKeyInputSchema = providerNameInputSchema.extend({
  key: z.string().min(1).max(4096),
});
export const providersTestInputSchema = providerNameInputSchema.extend({
  /** Optional model id override; defaults to the provider's first model. */
  model: z.string().min(1).optional(),
  /**
   * 按能力测试（国内厂商与自定义接口的媒体能力各异）：缺省 = 对话探测；
   * 指定后路由到对应接口的最小真实调用（图片/语音为一次最小生成，视频为
   * 提交任务后立即取消，向量为一次单词 embed）。
   */
  capability: modelCapabilitySchema.optional(),
  /**
   * 未保存先测（与 websearch.test 同一取向）：填写了 Key 就用入参直接探测、
   * 不落库；缺省用已存 key。只对能力探测生效（对话探测仍用已存配置）。
   */
  keyOverride: z.string().min(1).max(4096).optional(),
});

// --- media（统一媒体调用：按厂商自动路由） ------------------------------------
// 一组厂商无关的调用入口：入参的 model 是**裸模型 id**（省略时用
// settings.capabilityModels 里对应能力的配置），core 的 media 网关解析出
// 厂商后路由到各自的适配器（见 packages/core/src/media/ 与
// docs/design/16-capability-models.md）。新增厂商 = 增加描述符
// （shared/domain/vendors.ts）+ 适配器（core/media/adapters/）。

export const mediaGenerateImageInputSchema = z.object({
  /** 省略时用 capabilityModels.image 的模型。 */
  model: z.string().min(1).optional(),
  prompt: z.string().min(1).max(8000),
  /** 参考图（URL 或 data URI）：传入即图片编辑 / 图生图（部分模型支持）。 */
  images: z.array(z.string().min(1).max(2_000_000)).max(3).optional(),
  n: z.number().int().min(1).max(4).optional(),
  /** "宽x高"（如 1024x1024）；厂商各自转换（百炼原生为 "1024*1024"）。 */
  size: z.string().min(3).max(32).optional(),
  negativePrompt: z.string().max(2000).optional(),
});
export const mediaImageSchema = z.object({
  url: z.string().optional(),
  b64: z.string().optional(),
  mimeType: z.string().optional(),
});
export const mediaGenerateImageOutputSchema = z.object({
  images: z.array(mediaImageSchema),
});

export const mediaSynthesizeSpeechInputSchema = z.object({
  /** 省略时用 capabilityModels.tts 的模型。 */
  model: z.string().min(1).optional(),
  text: z.string().min(1).max(50_000),
  /** 音色（厂商各自命名，如百炼 longxiaochun / cosyvoice 代际音色）。 */
  voice: z.string().max(200).optional(),
  format: z.enum(['mp3', 'wav', 'opus']).optional(),
  speed: z.number().min(0.25).max(4).optional(),
});
export const mediaSynthesizeSpeechOutputSchema = z.object({
  audioBase64: z.string(),
  mimeType: z.string(),
});

export const mediaTranscribeSpeechInputSchema = z.object({
  /** 省略时用 capabilityModels.asr 的模型。 */
  model: z.string().min(1).optional(),
  audioBase64: z.string().min(1).max(20_000_000),
  audioMime: z.string().min(3).max(100),
  language: z.string().max(20).optional(),
});
export const mediaTranscribeSpeechOutputSchema = z.object({ text: z.string() });

export const mediaGenerateVideoInputSchema = z.object({
  /** 省略时用 capabilityModels.video 的模型。 */
  model: z.string().min(1).optional(),
  prompt: z.string().min(1).max(20_000),
  /** 首帧等参考图（图生视频）。 */
  images: z.array(z.string().min(1).max(2_000_000)).max(3).optional(),
  /** 厂商各自取值（百炼/火山 "720P"/"1080p" 等）。 */
  resolution: z.string().max(32).optional(),
  ratio: z.string().max(16).optional(),
  /** 画幅 "宽x高"。 */
  size: z.string().max(32).optional(),
  duration: z.number().int().min(1).max(60).optional(),
});
export const mediaGenerateVideoOutputSchema = z.object({
  provider: z.string(),
  taskId: z.string(),
});
export const mediaVideoStatusInputSchema = z.object({
  provider: z.string().min(1),
  taskId: z.string().min(1),
});
export const mediaVideoStatusOutputSchema = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  videoUrl: z.string().optional(),
  error: z.string().optional(),
});

export const mediaRerankInputSchema = z.object({
  /** 省略时用 capabilityModels.rerank 的模型。 */
  model: z.string().min(1).optional(),
  query: z.string().min(1).max(20_000),
  documents: z.array(z.string().max(100_000)).min(1).max(200),
  /** 只返回前 N 条；缺省全部返回。 */
  topN: z.number().int().min(1).max(200).optional(),
});
export const mediaRerankOutputSchema = z.object({
  results: z.array(
    z.object({
      /** 输入文档下标。 */
      index: z.number().int().min(0),
      /** 相关性得分（各家口径不同，仅在同一次请求内可比）。 */
      score: z.number(),
    }),
  ),
});

export const mediaUnderstandImageInputSchema = z.object({
  /** 省略时用 capabilityModels.multimodal 的模型。 */
  model: z.string().min(1).optional(),
  /** 图片（URL 或 data URI）。 */
  images: z.array(z.string().min(1).max(2_000_000)).min(1).max(3),
  prompt: z.string().min(1).max(8000),
});
export const mediaUnderstandImageOutputSchema = z.object({ text: z.string() });

// --- inkcop local bridge (v0.4) -------------------------------------------

export const inkcopAgentSchema = z.object({
  key: z.string().min(1),
  name: z.string(),
  kind: z.enum(['main', 'app']),
  /** 契约 v0.4：能力说明；主智能体 = 主对话角色定义。 */
  description: z.string().optional(),
});
export type InkcopAgent = z.infer<typeof inkcopAgentSchema>;

export const inkcopHealthOutputSchema = z.object({
  online: z.boolean(),
  version: z.number().optional(),
  app: z.string().optional(),
  tip: z.string().optional(),
  /** v0.3：401 / 未配置密钥。 */
  authError: z.boolean().optional(),
  /** 同机 endpoint.json 探测到的 token，供 UI 预填。 */
  discoveredApiKey: z.string().optional(),
  /** 同机 endpoint.json 的 baseUrl（或拼出的 loopback）。 */
  discoveredBaseUrl: z.string().optional(),
});
export const inkcopListAgentsOutputSchema = z.object({
  online: z.boolean(),
  agents: z.array(inkcopAgentSchema),
  tip: z.string().optional(),
  authError: z.boolean().optional(),
});

// --- bots -----------------------------------------------------------------

export const botsListOutputSchema = z.object({ bots: z.array(botSchema) });
export const botIdInputSchema = z.object({ id: z.string().min(1) });
export const botGetOutputSchema = z.object({ bot: botSchema.nullable() });
const namedProfile = botProfileSchema.refine((profile) => profile.identity.name.trim().length > 0, {
  path: ['identity', 'name'],
  message: 'Bot name must not be empty',
});
export const botsCreateInputSchema = z
  .object({
    profile: botProfileSchema,
    /**
     * 对话式创建（UI 改版，参考 Grok Bot）：profile 可为空壳（名字占位），
     * 创建后进入 setup interview——Bot 主动提问、经 setup 工具完善自己的
     * profile，完成后自行结束（setup_state 清空）。默认 false 走原路径。
     */
    interview: z.boolean().default(false),
    /**
     * 不套用 onboarding 默认外部 Agent（InkCop 同机桥绑定等：消息不经 ACP）。
     */
    skipDefaultAgent: z.boolean().default(false),
  })
  .refine((input) => input.interview || input.profile.identity.name.trim().length > 0, {
    path: ['profile', 'identity', 'name'],
    message: 'Bot name must not be empty',
  });
export const botsUpdateInputSchema = z.object({
  id: z.string().min(1),
  profile: namedProfile,
  /**
   * D89 审查修复：表单是从哪一版 Profile 改出来的。给了就由 core 与最新 Profile 三方合并——表单没
   * 碰的字段（如 Bot 刚直改的模型）不被过期表单覆盖；不给 = 整份覆盖（老行为）。
   */
  base: z.record(z.string(), z.unknown()).optional(),
});
/**
 * Upload an avatar image for a bot. The renderer sends the (already
 * downscaled) bytes; core writes the file under `bots/{id}/avatar/` and
 * points `identity.avatar` at it (`upload:{fileName}`). SVG stays vector, so
 * it is uploaded as-is rather than rasterized.
 */
export const botsAvatarUploadInputSchema = z.object({
  id: z.string().min(1),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
  bytesBase64: z.string().min(1),
});
export const botsAvatarUploadOutputSchema = botGetOutputSchema;
/** Read back an uploaded avatar (file name comes from `bot.avatar`). */
export const botsAvatarDataInputSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
});
export const botsAvatarDataOutputSchema = z.object({ mime: z.string(), base64: z.string() });
/**
 * Upload the user's own avatar (Profile settings). Core writes the file under
 * `user/avatar/`, keeps only the latest upload, points
 * `settings.userProfileAvatar` at it (`upload:{fileName}`) and publishes
 * `settings.changed`. The renderer sends already cropped square bytes.
 */
export const userAvatarUploadInputSchema = z.object({
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  bytesBase64: z.string().min(1),
});
export const userAvatarUploadOutputSchema = z.object({ avatar: z.string() });
/** Read back the user avatar (file name comes from `settings.userProfileAvatar`). */
export const userAvatarDataInputSchema = z.object({ file: z.string().min(1) });
export const userAvatarDataOutputSchema = z.object({ mime: z.string(), base64: z.string() });
export const botsDeletionPreviewOutputSchema = z.object({
  conversations: z.number().int(),
  messages: z.number().int(),
  memoryItems: z.number().int(),
  wikiPages: z.number().int(),
  skills: z.number().int(),
  /** Projects this bot leads (D92 T1a): the lead must be replaced first. */
  ledProjects: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
});
export const interviewStartOutputSchema = z.object({
  conversationId: z.string().min(1),
});
/**
 * 管家（D70）：确保唯一管家存在并打开其私聊。`interview`（新用户引导）让
 * 新建的管家进入组队访谈；存量用户的管家不访谈。幂等。
 */
export const butlerEnsureInputSchema = z.object({ interview: z.boolean().optional() });
/** 路由卡「交给它处理」（D70 §2.4）：以用户消息让管家去委派。 */
export const butlerAcceptRouteInputSchema = z.object({ messageId: z.string().min(1) });
export const butlerAcceptRouteOutputSchema = z.object({ message: messageSchema });
export const butlerEnsureOutputSchema = z.object({
  bot: botSchema,
  conversationId: z.string().min(1),
  created: z.boolean(),
});
/** 初始化问询的用户回答：不走草稿，直接落为带 setupAnswer 标记的用户消息。 */
export const interviewAnswerInputSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1),
});
export const interviewAnswerOutputSchema = z.object({
  message: messageSchema,
});
/**
 * 访谈目录卡作答（docs/design/19 D59）：path 非空 = 选择目录（绑定 workdir），
 * null = 暂不设置。作答后缓冲的用户消息才一起投递给 Bot（首个响应 run）。
 */
export const interviewAnswerPathInputSchema = z.object({
  conversationId: z.string().min(1),
  path: z.string().min(1).nullable(),
});
export const interviewAnswerPathOutputSchema = z.object({
  message: messageSchema,
});

// --- conversations --------------------------------------------------------

export const conversationsListOutputSchema = z.object({
  conversations: z.array(conversationSchema),
});
/**
 * 通讯录名册：所有会话（含已从对话列表移除的归档会话），带 Bot / 成员头像预览。
 * 对话列表用 `conversations.list`（不含归档）；通讯录用这一份。
 */
export const conversationsAllOutputSchema = z.object({
  conversations: z.array(conversationSchema),
});
export const conversationsOpenDirectInputSchema = z.object({ botId: z.string().min(1) });
export const conversationsOpenDirectOutputSchema = z.object({
  conversation: conversationSchema,
  created: z.boolean(),
});
export const conversationsDeleteInputSchema = z.object({ id: z.string().min(1) });
export const conversationsArchiveInputSchema = z.object({ id: z.string().min(1) });
export const conversationsArchiveOutputSchema = z.object({ conversation: conversationSchema });
export const conversationsMarkReadInputSchema = z.object({
  conversationId: z.string().min(1),
  seq: z.number().int(),
});
export const conversationGetInputSchema = z.object({ id: z.string().min(1) });
export const conversationGetOutputSchema = z.object({
  conversation: conversationSchema.nullable(),
});

// --- projects (P05 groups → D92 T1a project teams) ---------------------------

export const projectsCreateInputSchema = z
  .object({
    title: z.string().min(1).max(PROJECT_TITLE_MAX),
    goal: z.string().max(PROJECT_GOAL_MAX_CHARS).optional(),
    leadBotId: z.string().min(1),
    memberBotIds: z.array(z.string().min(1)).min(2),
  })
  .superRefine((input, ctx) => {
    if (!input.memberBotIds.includes(input.leadBotId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leadBotId'],
        message: '负责人必须是项目成员',
      });
    }
  });
export const projectsCreateOutputSchema = z.object({ conversation: conversationSchema });
export const projectsSetLeadInputSchema = z.object({
  conversationId: z.string().min(1),
  botId: z.string().min(1),
});
export const projectsSetLeadOutputSchema = z.object({ conversation: conversationSchema });
export const projectsUpdateInputSchema = z
  .object({
    conversationId: z.string().min(1),
    title: z.string().min(1).max(PROJECT_TITLE_MAX).optional(),
    goal: z.string().max(PROJECT_GOAL_MAX_CHARS).nullable().optional(),
  })
  .refine((input) => input.title !== undefined || input.goal !== undefined, {
    message: '至少修改一项（title 或 goal）',
  });
export const projectsUpdateOutputSchema = z.object({ conversation: conversationSchema });
export const conversationIdInputSchema = z.object({ conversationId: z.string().min(1) });
export const projectsAddMembersInputSchema = z.object({
  conversationId: z.string().min(1),
  botIds: z.array(z.string().min(1)).min(1),
});
export const projectsRemoveMemberInputSchema = z.object({
  conversationId: z.string().min(1),
  botId: z.string().min(1),
});
export const projectMemberSchema = z.object({ bot: botSchema, joinedAt: z.number() });
export type ProjectMember = z.infer<typeof projectMemberSchema>;
export const conversationsMembersInputSchema = z.object({ conversationId: z.string().min(1) });
export const conversationsMembersOutputSchema = z.object({
  members: z.array(projectMemberSchema),
});

// --- episodes (D92 T1a collaboration rounds) ----------------------------------

export const episodesGetInputSchema = z.object({ id: z.string().min(1) });
export const episodesGetOutputSchema = z.object({ episode: episodeSchema });
export const episodesResumeInputSchema = episodesGetInputSchema;
export const episodesResumeOutputSchema = episodesGetOutputSchema;
export const episodesStopInputSchema = episodesGetInputSchema;
export const episodesStopOutputSchema = episodesGetOutputSchema;

// --- messages -------------------------------------------------------------

export const messagesListInputSchema = z.object({
  conversationId: z.string().min(1),
  /** Load messages with seq < beforeSeq (pagination); omitted = latest page. */
  beforeSeq: z.number().int().optional(),
  limit: z.number().int().min(1).max(200).default(60),
});
export const messagesListOutputSchema = z.object({ messages: z.array(messageSchema) });
export const messagesEditInputSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(100_000),
});

/**
 * 发送一条用户消息（直发，无待发送队列）：单次发送 = 一条消息 = 一个批次
 * （batchId core 侧生成）。空文本 + 纯附件允许（docs/design/20-conversation-media.md）；
 * 渲染层保证非空组合。
 */
export const messagesSendInputSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().max(100_000),
  mentions: z.array(z.string().min(1)).optional(),
  replyTo: z.string().min(1).nullable().optional(),
  /** 随消息发送的附件（attachments.upload 先行上传）：core 校验归属后挂到本消息。 */
  attachmentIds: z.array(z.string().min(1)).optional(),
});
export const messagesSendOutputSchema = z.object({
  message: messageSchema,
  runId: z.string().nullable(),
});

// --- attachments ----------------------------------------------------------

export const attachmentsUploadInputSchema = z.object({
  conversationId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  bytesBase64: z.string().min(1).max(40_000_000),
});
export const attachmentsUploadOutputSchema = z.object({ attachment: attachmentSchema });
export const attachmentsGetInputSchema = z.object({ id: z.string().min(1) });
export const attachmentsGetOutputSchema = z.object({
  attachment: attachmentSchema,
  dataBase64: z.string(),
});
/**
 * 批量查附件状态（输入框草稿水合 / 发送失败判因；不读字节）：pending = 仍可发送，
 * sent = 已随消息发出，missing = 不存在 / 不属于该对话 / 文件已被回收。
 */
export const attachmentsStatusInputSchema = z.object({
  conversationId: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1).max(100),
});
export const attachmentsStatusOutputSchema = z.object({
  statuses: z.array(z.object({ id: z.string(), state: z.enum(['pending', 'sent', 'missing']) })),
});
/** 移除未发送的附件（输入框里已上传、尚未随消息发出的 chip）。 */
export const attachmentsDetachInputSchema = z.object({ id: z.string().min(1) });
export const attachmentsDetachOutputSchema = z.object({ ok: z.literal(true) });

// --- bot file artifacts ---------------------------------------------------
/**
 * 读取 Bot 刚写入的本地文件用于覆盖层预览。`conversationId` 把可读范围限定在
 * 该对话消息里出现过的文件（`hasArtifactPath`），避免渲染层拿这个 RPC 当
 * 任意路径读取器。
 */
export const filesPreviewInputSchema = z.object({
  conversationId: z.string().min(1),
  path: z.string().min(1),
});
export const filesPreviewOutputSchema = z.object({
  path: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  dataBase64: z.string(),
});

// --- 目录预览协议（kepcup-file，「完整 WebApp 档」） -----------------------------
// `files.previewSession` 是 app 方法（renderer → core）；`files.previewResource` 是平台
// 方法（主进程协议处理器 → core，PlatformRpcMethods）。schema 见 domain/file-preview.ts。

// --- web search（联网检索供应商，docs/design/21-web-search.md） ----------------

export const webSearchTestInputSchema = z.object({
  provider: webSearchProviderSchema,
  /** 未保存时先用入参 key 测试（不落库）；缺省读已存的 `websearch:{provider}`。 */
  key: z.string().min(1).max(500).optional(),
});
export const webSearchTestOutputSchema = z.object({
  ok: z.boolean(),
  /** 成功时的结果条数与耗时；失败时给可直接展示的错误说明。 */
  resultCount: z.number().int().min(0).optional(),
  elapsedMs: z.number().int().min(0).optional(),
  error: z.string().max(500).nullable(),
});
export const webSearchSetKeyInputSchema = z.object({
  provider: webSearchProviderSchema,
  key: z.string().min(1).max(500),
});
export const webSearchRemoveKeyInputSchema = z.object({ provider: webSearchProviderSchema });

// --- runs -----------------------------------------------------------------

export const runIdInputSchema = z.object({ runId: z.string().min(1) });
export const runsCancelOutputSchema = z.object({ run: runSchema.nullable() });
export const runsRetryOutputSchema = z.object({ run: runSchema.nullable() });
/**
 * 「缺设置」卡片被用户关闭（未完成配置）：一次性通知 run 所属的 Bot（internal
 * event，触发对话轮给新的反馈）。notified=false = 无可通知（run 不存在、无
 * setup、main-model 缺失、非失败状态或已通知过）。
 */
export const runsSetupDismissedOutputSchema = z.object({ notified: z.boolean() });
/**
 * 用户关闭失败横幅（或由此收起的设置卡）：把该失败标成已读。run 行保留
 * （步骤、重试来源都还在），刷新后不再恢复横幅。run 不存在时 run 为 null。
 */
export const runsDismissFailureOutputSchema = z.object({ run: runSchema.nullable() });
/**
 * W3（D78）：`reviewed` = 用户已在「检查后重试」面板核实中断前的外部操作。
 * 中断任务有外部副作用台账行时不带它会得到 REVIEW_REQUIRED；其他调用方不传。
 */
export const runsRetryInputSchema = runIdInputSchema.extend({ reviewed: z.boolean().optional() });
export const runsStepsOutputSchema = z.object({ steps: z.array(runStepSchema) });
export const runsListInputSchema = z.object({
  conversationId: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
  /**
   * D75 审查 L3: every active run of the conversation instead (no limit) —
   * the status line must see all in-flight tasks, not only the latest runs.
   */
  active: z.boolean().optional(),
});
export const runsListOutputSchema = z.object({ runs: z.array(runSchema) });

// --- sandbox (P02) ----------------------------------------------------------

export const sandboxStatusInputSchema = z.object({
  /** Re-run the availability probe instead of returning the cached result. */
  probe: z.boolean().optional(),
});
export type SandboxStatusInput = z.infer<typeof sandboxStatusInputSchema>;
export const sandboxStatusOutputSchema = z.object({
  platform: z.string(),
  /**
   * Default backend kind (docs/dev/02-architecture.md "沙箱"): 'srt' on
   * macOS/Linux, 'wsl' on Windows (private WSL2 distro), 'none' when every
   * command would be refused.
   */
  backend: z.enum(['srt', 'wsl', 'lima', 'podman', 'none']),
  available: z.boolean(),
  /** Localized reason when unavailable. */
  reason: z.string().optional(),
  /** Localized repair hint (e.g. a sudo command to run). */
  fixHint: z.string().optional(),
  /**
   * P12 enhanced level (macOS: lima, Linux: podman, Windows: null — the WSL
   * distro serves as both levels). Null while unknown (probe pending).
   */
  enhanced: z
    .object({
      backend: z.enum(['lima', 'podman', 'wsl']),
      available: z.boolean(),
      reason: z.string().optional(),
      fixHint: z.string().optional(),
    })
    .nullable()
    .optional(),
});
export type SandboxStatusOutput = z.infer<typeof sandboxStatusOutputSchema>;

/**
 * P12-B Windows 沙箱准备向导 (docs/dev/phases/P12-windows-and-enhanced-sandbox.md
 * 任务 7). `applicable` is false on non-Windows hosts (and only true elsewhere
 * through the e2e fixture seam) — the wizard then shows the platform's
 * enhanced-sandbox entry instead of the Windows flow. The phase enum mirrors
 * the core WslSetup state machine; `install`/`distro` are the structured
 * probe verdicts (wsl parse.ts), `reason`/`fixHint` its localized output.
 */
export const sandboxWslStatusOutputSchema = z.object({
  applicable: z.boolean(),
  phase: z.enum([
    'idle',
    'enabling',
    'awaiting_reboot',
    'importing',
    'configuring',
    'ready',
    'failed',
    'policy_disabled',
  ]),
  /** User skipped preparation — the per-command confirm mode keeps running. */
  skipped: z.boolean(),
  install: z.enum(['ok', 'policy_disabled', 'needs_enable', 'not_installed']),
  distro: z.enum(['absent', 'wsl1', 'registered']),
  reason: z.string().optional(),
  fixHint: z.string().optional(),
});
export type SandboxWslStatusOutput = z.infer<typeof sandboxWslStatusOutputSchema>;
export const sandboxWslSkipOutputSchema = z.object({ skipped: z.boolean() });
export type SandboxWslSkipOutput = z.infer<typeof sandboxWslSkipOutputSchema>;

// --- approvals (P03) --------------------------------------------------------

export const approvalsListInputSchema = z.object({
  conversationId: z.string().min(1).optional(),
});
export const approvalsListOutputSchema = z.object({ approvals: z.array(approvalSchema) });
export const approvalsDecideInputSchema = z.object({
  id: z.string().min(1),
  approve: z.boolean(),
  /**
   * Access approvals: 仅这一次 / 本对话内一直允许；`mcp_tool`（D73）卡片按
   * `payload.durations` 另可选 `bot`（对该 Bot 总是允许）。core 对不在可选范围内的值降为 `once`。
   */
  duration: approvalDurationSchema.optional(),
  /**
   * `butler_proposal` only (D70): indexes into payload.bots the user kept;
   * an empty selection with approve=true counts as a denial.
   */
  selection: z.array(z.number().int().nonnegative()).optional(),
  /**
   * W4：渲染端显示的审批内容的 `payloadHash`（approval 输出里的同名字段）。
   * 与服务端不符 → APPROVAL_STALE（可选：旧调用方不传）。
   */
  payloadHash: z.string().min(1).optional(),
  /** `butler_proposal` only (D80): kept routines as `"{botIndex}:{routineIndex}"`. */
  routineSelection: z.array(z.string().regex(/^\d+:\d+$/)).optional(),
  /**
   * `bot_handover` only (D88): item keys the user kept (`resp:to` / `resp:from` for the
   * responsibilities rewrite); keys outside the card are rejected. Nothing kept and no new
   * bot = a denial.
   */
  handoverSelection: z.array(z.string().min(1)).optional(),
  /**
   * `butler_proposal` with `proposalType: 'project'` only (D92 T1a WP4): the lead the user
   * picked on the card; must be one of the payload's `memberBotIds`.
   */
  leadBotId: z.string().min(1).optional(),
});
export const approvalsDecideOutputSchema = z.object({ approval: approvalSchema });

// --- bot asset handover (D88) -----------------------------------------------------

export const handoversGetInputSchema = z.object({ approvalId: z.string().min(1) });
export const handoversGetOutputSchema = z.object({ handover: handoverViewSchema.nullable() });

// --- cross-bot delegation (D71) -------------------------------------------------

export const delegationIdInputSchema = z.object({ id: z.string().min(1) });
export const delegationGetOutputSchema = z.object({ delegation: delegationSchema.nullable() });

// --- tasks (D75 W3, design 30 §4.3 / §2.4.6) --------------------------------

export const taskIdInputSchema = z.object({ taskId: z.string().min(1) });
export const taskGetOutputSchema = z.object({ task: taskViewSchema.nullable() });
/**
 * W2 外部副作用台账：任务（沿续接链 continuedFromRunIds 回溯，含各 run 的
 * SubAgent 子 run）的 tool_effects 行，按创建时间排序（W3 检查后重试面板）。
 */
export const effectsListOutputSchema = z.object({ effects: z.array(toolEffectSchema) });
/** Non-terminal tasks of a conversation (status line seed on conversation open). */
export const tasksActiveInputSchema = z.object({ conversationId: z.string().min(1) });
export const tasksActiveOutputSchema = z.object({ tasks: z.array(taskViewSchema) });
/** The user picked an option on a task question card: injected straight into the task. */
export const tasksAnswerInputSchema = z.object({
  messageId: z.string().min(1),
  /** 单选：点选的候选；多选 / 表单：卡片上显示的一行（core 以 `values` 为准重新生成）。 */
  answer: z.string().min(1).max(4000),
  /** D87 P4 L2：多选 = 选中的候选列表；表单 = 字段名 → 文本。单选不带。 */
  values: askUserValuesSchema.optional(),
});

// --- grants (P03) -----------------------------------------------------------

export const grantsListInputSchema = z.object({ conversationId: z.string().min(1) });
export const grantsListOutputSchema = z.object({ grants: z.array(grantSchema) });
export const grantIdInputSchema = z.object({ id: z.string().min(1) });

// --- command allowlist (P03) -------------------------------------------------

export const allowlistListOutputSchema = z.object({ entries: z.array(allowlistEntrySchema) });
export const allowlistAddInputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .max(200)
    .regex(/^\S.*\S$|^\S$/, '条目不能有首尾空白'),
});
export const allowlistUpdateInputSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});

// --- unattended mode (P03) ---------------------------------------------------

export const unattendedGetOutputSchema = unattendedStateSchema;
export const unattendedEnableInputSchema = z.object({
  /** Hours until auto-off; null/omitted = manual off. */
  hours: z.number().int().min(1).max(168).nullable().optional(),
  /** Must be true — the enable dialog requires the explicit risk check. */
  acknowledgeRisk: z.literal(true),
});
export const unattendedSummaryInputSchema = z.object({
  /** Only include auto-approvals created after this epoch ms. */
  since: z.number().int().optional(),
});
export const unattendedSummaryItemSchema = z.object({
  approvalId: z.string(),
  kind: z.string(),
  conversationId: z.string().nullable(),
  botId: z.string().nullable(),
  /** One-line description of the auto-approved operation. */
  detail: z.string(),
  createdAt: z.number(),
  /** W4：自动批准的外部调用的台账结局（旧审批 / 非外部调用没有）。 */
  effectStatus: effectStatusSchema.optional(),
});
export const unattendedSummaryOutputSchema = z.object({
  items: z.array(unattendedSummaryItemSchema),
});

// --- workdirs (P04) ---------------------------------------------------------

export const workdirsListOutputSchema = z.object({ workdirs: z.array(workdirSchema) });
export const workdirsGetInputSchema = z.object({ id: z.string().min(1) });
export const workdirsGetOutputSchema = z.object({ workdir: workdirSchema.nullable() });
export const workdirsSelectInputSchema = z.object({
  conversationId: z.string().min(1),
  /** realpath of the picked directory; core re-realpaths and validates. */
  path: z.string().min(1),
});
export const workdirsSelectOutputSchema = z.object({ workdir: workdirSchema });
export const workdirsUnbindInputSchema = z.object({ conversationId: z.string().min(1) });
export const workdirsUpdateInputSchema = z.object({
  id: z.string().min(1),
  // 名称不可改：工作目录名固定为所选文件夹的名字（bind 时取 basename）。
  protectRules: workdirProtectRulesSchema.optional(),
  allowedPorts: z
    .array(z.tuple([z.number().int().min(1).max(65535), z.number().int().min(1).max(65535)]))
    .nullable()
    .optional(),
});
export const workdirsRemoveInputSchema = z.object({ id: z.string().min(1) });
export const workdirsDiffInputSchema = z.object({ runId: z.string().min(1) });
export const workdirsDiffOutputSchema = z.object({
  change: runChangeSchema.nullable(),
  /** Unified diff (before → after); empty when nothing changed or reverted. */
  diffText: z.string(),
});
export const workdirsRevertInputSchema = z.object({
  runId: z.string().min(1),
  /** Confirmed after a previous call reported conflicts. */
  force: z.boolean().optional(),
});
export const workdirsRevertOutputSchema = z.object({
  ok: z.boolean(),
  /** Files changed after the after-snapshot; revert refused while non-empty and force is not set. */
  conflicts: z.array(z.string()),
  reverted: z.array(z.string()),
});
export const workdirsRevokeLeaseInputSchema = z.object({ conversationId: z.string().min(1) });
export const workdirsRevokeLeaseOutputSchema = z.object({ revoked: z.boolean() });

// --- environment (P06) -------------------------------------------------------

export const environmentListOutputSchema = z.object({
  installs: z.array(envInstallSchema),
  /** Live detection of kind='system' items on this machine (macOS/Linux git). */
  system: z.array(envSystemStatusSchema),
});
export const environmentInstallIdInputSchema = z.object({ id: z.string().min(1) });
export const environmentReinstallOutputSchema = z.object({ install: envInstallSchema.nullable() });

// --- external agents (D72, docs/design/28-external-agents-acp.md §2.2) ------

/** 生效目录（按发行门禁过滤后的原始条目）。 */
export const agentsCatalogOutputSchema = z.object({ entries: z.array(agentCatalogEntrySchema) });

// --- memory & user profile (P07) ---------------------------------------------

export const memoryListInputSchema = z.object({ botId: z.string().min(1) });
export const memoryListOutputSchema = z.object({ items: z.array(memoryItemSchema) });
export const memoryUpdateInputSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  content: z.string().min(1).max(10_000).optional(),
});
export const memoryRetractInputSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
});

export const profileListOutputSchema = z.object({ items: z.array(profileItemSchema) });
export const profileUpdateInputSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1).max(10_000).optional(),
  category: profileItemSchema.shape.category.optional(),
});
export const profileRetractInputSchema = z.object({ id: z.string().min(1) });
export const profileCardOutputSchema = z.object({ card: profileCardSchema });

// --- usage (P07) ------------------------------------------------------

export const usageSummaryInputSchema = z.object({
  /** Local-day window ending today; default 7. */
  days: z.number().int().min(1).max(90).optional(),
});

// --- embedding (P07) -----------------------------------------------------------

export const embeddingStatusOutputSchema = embeddingStatusSchema;
/** provider 来源使用「向量模型」section 的配置（capabilityModels.embedding）。 */
export const embeddingConfigureInputSchema = z.object({
  source: z.enum(['local', 'provider']),
});

// --- skills (P08) -------------------------------------------------------------

export const skillsListInputSchema = z.object({ botId: z.string().min(1) });
export const skillsListOutputSchema = z.object({ skills: z.array(skillEntrySchema) });
/**
 * Import request. `status='candidates'` means the repository contains several
 * skills and the caller must re-send with one of the listed subdirectories;
 * `status='submitted'` means the approval card is up (scan results included).
 */
export const skillsImportInputSchema = z.object({
  botId: z.string().min(1),
  /** Conversation receiving the approval card; default = the bot's direct chat. */
  conversationId: z.string().min(1).optional(),
  sourceUrl: z.string().min(1).max(2000),
  ref: z.string().max(200).optional(),
  subdirectory: z.string().max(500).optional(),
});
export const skillsImportOutputSchema = z.union([
  z.object({ status: z.literal('submitted'), approvalId: z.string() }),
  z.object({ status: z.literal('candidates'), candidates: z.array(skillCandidateSchema) }),
]);
export type SkillsImportOutput = z.infer<typeof skillsImportOutputSchema>;
export const skillsSetNameInputSchema = z.object({
  botId: z.string().min(1),
  name: z.string().min(1),
});
export const skillNameInputSchema = z.object({
  botId: z.string().min(1),
  name: z.string().min(1),
});
export const skillsHistoryOutputSchema = z.object({ history: z.array(skillHistoryEntrySchema) });
export const skillsRollbackInputSchema = z.object({
  botId: z.string().min(1),
  name: z.string().min(1),
  commitOid: z.string().min(1),
});
export const skillsReadOutputSchema = z.object({
  name: z.string(),
  /** SKILL.md content (raw markdown including frontmatter). */
  content: z.string(),
  /** Absolute directory of the skill on this machine. */
  dirPath: z.string(),
});

/** Skill marketplace (app-shipped preset catalog). Catalog and install state
 * are GLOBAL: presets install as public skills (public_skills), visible to
 * every bot; no per-bot targeting. */
export const skillsPresetsListInputSchema = z.void();
export const skillsPresetsListOutputSchema = z.object({ presets: z.array(skillPresetInfoSchema) });
export type SkillsPresetsListOutput = z.infer<typeof skillsPresetsListOutputSchema>;
export const skillsPresetsInstallInputSchema = z.object({
  presetId: z.string().min(1),
});
export const skillsPresetsInstallOutputSchema = z.object({
  presets: z.array(skillPresetInfoSchema),
});
/** 用户确认「技能目录已被删除」后清理其 DB 记录（见 skills.missing 事件）。 */
export const skillsPurgeMissingInputSchema = z.object({ name: z.string().min(1) });
export const skillsPurgeMissingOutputSchema = z.object({
  /** 清掉的库版本数（0 = 目录其实还在，什么都没删）。 */
  purged: z.number().int().nonnegative(),
});

// --- wiki (P09; owner-generalized in D92 T1b WP9 — breaking, no compat) --------

export const wikiOwnerInputSchema = z.object({ owner: wikiOwnerSchema });
export type WikiOwnerInput = z.infer<typeof wikiOwnerInputSchema>;
export const wikiTreeOutputSchema = z.object({ pages: z.array(wikiPageSchema) });
export type WikiTreeOutput = z.infer<typeof wikiTreeOutputSchema>;
/** Paths are wiki-root relative; `index.md` plus everything under `pages/`. */
export const wikiPageInputSchema = z.object({
  owner: wikiOwnerSchema,
  path: z.string().min(1).max(500),
});
export const wikiPageOutputSchema = z.object({
  path: z.string(),
  title: z.string(),
  content: z.string(),
});
export type WikiPageOutput = z.infer<typeof wikiPageOutputSchema>;
export const wikiSearchInputSchema = z.object({
  owner: wikiOwnerSchema,
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).optional(),
});
export const wikiSearchOutputSchema = z.object({ hits: z.array(wikiSearchHitSchema) });
export type WikiSearchOutput = z.infer<typeof wikiSearchOutputSchema>;
export const wikiHistoryOutputSchema = z.object({ history: z.array(wikiHistoryEntrySchema) });
export type WikiHistoryOutput = z.infer<typeof wikiHistoryOutputSchema>;
/** 某一次提交的 Wiki 快照（只读）：页面列表 / 单页全文按 commitOid 从 git 对象读。 */
export const wikiCommitInputSchema = z.object({
  owner: wikiOwnerSchema,
  commitOid: z.string().min(1),
});
export type WikiCommitInput = z.infer<typeof wikiCommitInputSchema>;
export const wikiCommitTreeOutputSchema = z.object({ pages: z.array(wikiPageSchema) });
export type WikiCommitTreeOutput = z.infer<typeof wikiCommitTreeOutputSchema>;
export const wikiCommitPageInputSchema = z.object({
  owner: wikiOwnerSchema,
  commitOid: z.string().min(1),
  path: z.string().min(1).max(500),
});
export type WikiCommitPageInput = z.infer<typeof wikiCommitPageInputSchema>;
export const wikiCommitPageOutputSchema = wikiPageOutputSchema;
export type WikiCommitPageOutput = z.infer<typeof wikiCommitPageOutputSchema>;
export const wikiRollbackInputSchema = z.object({
  owner: wikiOwnerSchema,
  commitOid: z.string().min(1),
});
export const wikiRollbackOutputSchema = z.object({ ok: z.literal(true) });
/** Same input shape as wiki.page: `{ owner, path }`, path strictly under pages/.
 * Standalone schema (not an alias): the two methods' contracts must evolve
 * independently. */
export const wikiDeletePageInputSchema = z.object({
  owner: wikiOwnerSchema,
  path: z.string().min(1).max(500),
});
export const wikiDeletePageOutputSchema = z.object({ ok: z.literal(true) });

// --- wiki sources (D92 T1b WP10; project wikis only — bot wikis have no ledger) ---

/** The submitter of one source: the user, or a bot with its current name. */
export const wikiSourceCreatorViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('bot'), id: z.string().min(1), name: z.string().nullable() }),
]);
export type WikiSourceCreatorView = z.infer<typeof wikiSourceCreatorViewSchema>;
/** `name` is the bot's current name; null when deleted (the UI shows the id). */
export const wikiSourceViewSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  bytes: z.number().int().nonnegative(),
  kind: z.enum(['text', 'html']),
  createdBy: wikiSourceCreatorViewSchema,
  sources: z.array(
    z.object({
      type: z.enum(['attachment', 'file', 'url', 'text']),
      ref: z.string(),
      at: z.number(),
    }),
  ),
  createdAt: z.number(),
});
export type WikiSourceView = z.infer<typeof wikiSourceViewSchema>;
export const wikiSourcesOutputSchema = z.object({ sources: z.array(wikiSourceViewSchema) });
export type WikiSourcesOutput = z.infer<typeof wikiSourcesOutputSchema>;
/** `ref` is the URL, or the pasted body (≤ WIKI_TEXT_SOURCE_MAX_CHARS). */
export const wikiAddSourceInputSchema = z.object({
  owner: wikiOwnerSchema,
  sourceType: z.enum(['url', 'text']),
  ref: z.string(),
  note: z.string().max(2000).optional(),
});
export const wikiAddSourceOutputSchema = z.object({ ok: z.literal(true) });
export const wikiDeleteSourceInputSchema = z.object({
  owner: wikiOwnerSchema,
  sourceId: z.string().min(1),
});
export const wikiDeleteSourceOutputSchema = z.object({ ok: z.literal(true) });

// --- schedules (P10) -------------------------------------------------------------

/** Omitted conversationId = every schedule (settings-page overview). */
export const schedulesListInputSchema = z.object({
  conversationId: z.string().min(1).optional(),
});
export const schedulesListOutputSchema = z.object({ schedules: z.array(scheduleEntrySchema) });
export const schedulesCancelInputSchema = z.object({ id: z.string().min(1) });
export const schedulesCancelOutputSchema = z.object({ ok: z.literal(true) });
/** Offer-card actions (D80): the card message id. */
export const schedulesOfferInputSchema = z.object({ messageId: z.string().min(1) });
export const schedulesAcceptOfferOutputSchema = z.object({ schedule: scheduleSchema });
export const schedulesDeclineOfferOutputSchema = z.object({ ok: z.literal(true) });

// --- workbench (D90, docs/design/39-workbench.md §4.6) -------------------------------

/**
 * `when` of todos.create / todos.update: `'now'` = dispatch immediately; an ISO 8601
 * instant = one-off; anything else is parsed as cron (same semantics as `createFromWhen`).
 * `null` = clear the schedule; omitted = unchanged (on create: not scheduled).
 */
const todoWhenSchema = z.string().min(1).nullable();
const todoTitleSchema = z.string().min(1).max(TODO_TITLE_MAX_CHARS);
const todoNotesSchema = z.string().max(TODO_NOTES_MAX_CHARS);

export const todosListInputSchema = z.object({
  statuses: z.array(todoStatusSchema).optional(),
  query: z.string().optional(),
  /** Include done / cancelled todos closed longer ago than TODO_CLOSED_VISIBLE_MS. */
  includeClosed: z.boolean().optional(),
});
export const todosListOutputSchema = z.object({ todos: z.array(todoEntrySchema) });
export const todosIdInputSchema = z.object({ id: z.string().min(1) });
export const todosGetOutputSchema = z.object({
  todo: todoEntrySchema,
  runs: z.array(todoRunSchema),
});
export const todosCreateInputSchema = z.object({
  title: todoTitleSchema,
  notes: todoNotesSchema.optional(),
  assignee: todoAssigneeSchema.nullable().optional(),
  when: todoWhenSchema.optional(),
  /** The memo this todo is converted from. */
  memoId: z.string().min(1).optional(),
});
export const todosUpdateInputSchema = z.object({
  id: z.string().min(1),
  title: todoTitleSchema.optional(),
  notes: todoNotesSchema.optional(),
  /** null = clear the assignee (also clears the schedule; back to draft). */
  assignee: todoAssigneeSchema.nullable().optional(),
  when: todoWhenSchema.optional(),
});
/** `warnings`: pre-dispatch hints rendered in place ("该 Bot 未配置模型" / "项目组已只读"). */
export const todosWriteOutputSchema = z.object({
  todo: todoEntrySchema,
  warnings: z.array(z.string()),
  /**
   * `todos.update`：标题 / 说明变了，且事项有在途的派发，已排队「事项更新」通知
   * （短时间内的连续修改合成一条，稍后发出；暂时没有可通知的对象时会重试）。界面据此提示「将通知执行者」。
   */
  notified: z.boolean().optional(),
});
export const todosTransitionOutputSchema = z.object({ todo: todoEntrySchema });

// --- project board (D103, docs/design/50-project-board.md §10) -------------------
// `board.cards.reject` is P1 backlog and is intentionally absent.

const boardIdSchema = z.string().min(1);

export const boardGetInputSchema = z.object({
  projectId: boardIdSchema,
  /** Localized default column titles. Omitted or empty → no seeding. */
  seedTitles: z.array(z.string()).optional(),
});
export const boardGetOutputSchema = z.object({
  columns: z.array(boardColumnSchema),
  cards: z.array(boardCardSchema),
});

export const boardSummaryInputSchema = z.object({ projectId: boardIdSchema });
export const boardSummaryOutputSchema = boardSummarySchema;

export const boardColumnsCreateInputSchema = z.object({
  projectId: boardIdSchema,
  title: z.string(),
  /** Insert before this column. Null or omitted = append. */
  beforeColumnId: boardIdSchema.nullable().optional(),
});
export const boardColumnOutputSchema = z.object({ column: boardColumnSchema });

export const boardColumnsUpdateInputSchema = z.object({
  columnId: boardIdSchema,
  title: z.string(),
});

export const boardColumnsMoveInputSchema = z.object({
  columnId: boardIdSchema,
  /** Null = move to the end. */
  beforeColumnId: boardIdSchema.nullable(),
});
export const boardColumnsOutputSchema = z.object({ columns: z.array(boardColumnSchema) });

export const boardColumnsDeleteInputSchema = z.object({
  columnId: boardIdSchema,
  /** Required when the column still has cards. */
  deleteCards: z.boolean().optional(),
});
export const boardEmptyOutputSchema = z.object({});

export const boardCardsCreateInputSchema = z.object({
  projectId: boardIdSchema,
  columnId: boardIdSchema,
  text: z.string(),
  /**
   * Insert before this card. Omitted = top of the column (the create default).
   * Null = append.
   */
  beforeCardId: boardIdSchema.nullable().optional(),
});
export const boardCardOutputSchema = z.object({ card: boardCardSchema });

export const boardCardIdInputSchema = z.object({ cardId: boardIdSchema });

export const boardCardsUpdateInputSchema = z.object({
  cardId: boardIdSchema,
  text: z.string(),
});

export const boardCardsMoveInputSchema = z.object({
  cardId: boardIdSchema,
  columnId: boardIdSchema,
  /** Null = end of the target column. */
  beforeCardId: boardIdSchema.nullable(),
});
export const boardCardsMoveOutputSchema = z.object({
  card: boardCardSchema,
  renumbered: z.array(boardCardSchema).optional(),
});

export const boardCardsAssignInputSchema = z.object({
  cardId: boardIdSchema,
  /** Null clears the assignee. */
  botId: boardIdSchema.nullable(),
});
export const boardCardWarningsOutputSchema = z.object({
  card: boardCardSchema,
  warnings: z.array(z.string()),
});

export const boardCardsScheduleInputSchema = z.object({
  cardId: boardIdSchema,
  /** 'now' | ISO 8601 | cron | null (clear). */
  when: z.string().min(1).nullable(),
});

export const boardCardsConversationOutputSchema = z.object({
  conversationId: z.string(),
});

export const memosListInputSchema = z.object({
  query: z.string().optional(),
  /** true = 最近删除 (soft-deleted memos); default = live memos. */
  trashed: z.boolean().optional(),
});
export const memosListOutputSchema = z.object({ memos: z.array(memoSchema) });
export const memosIdInputSchema = z.object({ id: z.string().min(1) });
export const memosCreateInputSchema = z.object({
  body: z.string().min(1).max(MEMO_BODY_MAX_CHARS),
});
export const memosUpdateInputSchema = z.object({
  id: z.string().min(1),
  body: z.string().min(1).max(MEMO_BODY_MAX_CHARS).optional(),
  pinned: z.boolean().optional(),
});
export const memosMemoOutputSchema = z.object({ memo: memoSchema });

// --- watches (W7) -------------------------------------------------------------------
export const watchesListInputSchema = z.object({
  conversationId: z.string().min(1).optional(),
});
export const watchesListOutputSchema = z.object({ watches: z.array(watchEntrySchema) });
export const watchIdInputSchema = z.object({ id: z.string().min(1) });
export const watchGetOutputSchema = z.object({ watch: watchEntrySchema.nullable() });
export const watchMutateOutputSchema = z.object({ watch: watchEntrySchema });

// --- stickies（辅助阅读便签，main.db stickies） ------------------------------
export const stickiesListInputSchema = z.object({});
export const stickiesListOutputSchema = z.object({ stickies: z.array(stickieSchema) });
export const stickiesCreateInputSchema = z.object({
  /** 渲染层乐观上屏时已生成的 id（stc_）；缺省时由 core 生成。 */
  id: z.string().min(1).optional(),
  conversationId: z.string().min(1),
  text: z.string().trim().min(1).max(STICKIE_TEXT_MAX_CHARS),
  scope: stickieScopeSchema,
  position: stickiePositionSchema.nullable(),
  z: z.number().int(),
});
export const stickiesCreateOutputSchema = z.object({ stickie: stickieSchema });
export const stickiesUpdateInputSchema = z.object({
  id: z.string().min(1),
  position: stickiePositionSchema.nullable().optional(),
  scope: stickieScopeSchema.optional(),
  z: z.number().int().optional(),
});
export const stickiesUpdateOutputSchema = z.object({ stickie: stickieSchema });
export const stickiesDeleteInputSchema = z.object({ id: z.string().min(1) });
export const stickiesDeleteOutputSchema = okOutputSchema;

// --- share（D94，macOS Share Extension 分享接收） ------------------------------
// 平台方法（port B，主进程调 core）：share.targets / share.consume。
// App 方法（port A，渲染层调 core）：share.failed.list / retry / discard。
export const shareTargetsOutputSchema = shareTargetsSchema;
export const shareFailedListInputSchema = z.object({});

// --- browser (P11) ----------------------------------------------------------------
// Served by the MAIN process on port B; the core's browser tools are the
// client (docs/dev/02-architecture.md 端口 B: 核心服务请求平台能力).

/** Loopback (127.0.0.1/localhost) is reachable only with a bound workdir. */
export const browserNetworkContextSchema: z.ZodType<BrowserNetworkContext> = z.object({
  allowLoopback: z.boolean(),
});

/**
 * W8 浏览器资料键：`bot:{botId}`（私有，partition `persist:bot-{botId}`）或
 * `shared:{profileId}`（共享，`persist:shared-{profileId}`）。core 按 Bot 的生效资料
 * 算出，宿主据此派生 partition；字符集限制在可直接作目录名的范围。
 */
export const browserProfileKeySchema = z.string().regex(/^(bot|shared):[A-Za-z0-9_-]{1,64}$/);

export const browserEnsurePageInputSchema = z.object({
  botId: z.string().min(1),
  conversationId: z.string().min(1),
  /** W8: which browser profile (partition) the page lives in. */
  profileKey: browserProfileKeySchema,
  /** Network rules for this page; re-sent on every call (idempotent refresh). */
  networkContext: browserNetworkContextSchema,
  /** Download target (the conversation workspace's downloads/), created lazily. */
  downloadsDir: z.string().min(1),
});
export const browserEnsurePageOutputSchema = z.object({ ok: z.literal(true) });

export const browserPairInputSchema = z.object({
  botId: z.string().min(1),
  conversationId: z.string().min(1),
});

export const browserNavigateInputSchema = browserPairInputSchema.extend({
  url: z.string().min(1).max(8192),
});
export const browserNavigateOutputSchema = z.object({
  ok: z.literal(true),
  title: z.string(),
  url: z.string(),
});

export const browserSnapshotElementSchema = z.object({
  ref: z.string(),
  role: z.string(),
  name: z.string(),
});
export type BrowserSnapshotElement = z.infer<typeof browserSnapshotElementSchema>;

export const browserSnapshotOutputSchema = z.object({
  title: z.string(),
  url: z.string(),
  elements: z.array(browserSnapshotElementSchema),
  /** True when the element list was capped (caller appends a note). */
  elementsTruncated: z.boolean(),
  /** W1: interactive elements beyond the cap (not listed); absent from older hosts. */
  elementsOmitted: z.number().int().nonnegative().optional(),
  /**
   * W1: sha256 of the listed elements' AX value + checked / expanded /
   * selected / pressed state (never the values themselves) — state the
   * snapshot text does not show, folded into the no-progress page hash.
   */
  stateDigest: z.string().max(128).optional(),
  text: z.string(),
  textTruncated: z.boolean(),
});
export type BrowserSnapshotOutput = z.infer<typeof browserSnapshotOutputSchema>;

/**
 * W1 浏览器动作三态结局：not_started（派发前失败，可安全重试）/ completed（CDP
 * 派发成功，不要重放）/ uncertain（派发后出错，先快照核实）。宿主成功返回时恒为
 * completed；另外两种由 core 工具层按错误的 `details.phase` 映射。
 */
export const browserActionOutcomeSchema = z.enum(['not_started', 'completed', 'uncertain']);
export type BrowserActionOutcome = z.infer<typeof browserActionOutcomeSchema>;
/** W1: browser-host tags thrown AppErrors with `details.phase` (before / after dispatch). */
export type BrowserActionPhase = 'pre' | 'post';
/** click / type / press / scroll / back result (W1; older hosts answer `{ ok: true }`). */
export const browserActionOutputSchema = z.object({
  ok: z.literal(true),
  outcome: browserActionOutcomeSchema.optional(),
  /** The page navigated (cross-document or same-document) while the action ran. */
  navigated: z.boolean().optional(),
  /** browser.type only: the target was `<input type=password>` (forced sensitive). */
  passwordField: z.boolean().optional(),
});
export type BrowserActionOutput = z.infer<typeof browserActionOutputSchema>;

export const browserClickInputSchema = browserPairInputSchema.extend({
  ref: z.string().min(1).max(16),
});
export const browserTypeInputSchema = browserPairInputSchema.extend({
  ref: z.string().min(1).max(16),
  text: z.string().max(10_000),
});
export const browserPressInputSchema = browserPairInputSchema.extend({
  key: z.string().min(1).max(32),
});
export const browserScrollInputSchema = browserPairInputSchema.extend({
  direction: z.enum(['up', 'down']),
  amount: z.number().int().min(1).max(10_000),
});
export const browserScreenshotOutputSchema = z.object({
  dataBase64: z.string(),
  mimeType: z.literal('image/png'),
  width: z.number().int(),
  height: z.number().int(),
});
export type BrowserScreenshotOutput = z.infer<typeof browserScreenshotOutputSchema>;

/** `permanent: true` tombstones the pair (deletion cascade, not tool close). */
export const browserCloseInputSchema = browserPairInputSchema.extend({
  permanent: z.boolean().optional(),
});

export const browserSetNetworkContextInputSchema = browserPairInputSchema.extend({
  networkContext: browserNetworkContextSchema,
});

export const browserClearBotDataInputSchema = z.object({ botId: z.string().min(1) });

/** W8: closes every page of a bot (its browser profile changed; not a tombstone). */
export const browserCloseBotPagesInputSchema = z.object({ botId: z.string().min(1) });
/**
 * W8: wipes a shared profile's storage. `remove: true` (the profile is deleted)
 * also tombstones it and removes `Partitions/shared-{id}`; without it (清除数据)
 * the entry stays usable and only the stored data is cleared.
 */
export const browserClearProfileDataInputSchema = z.object({
  profileId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  remove: z.boolean().optional(),
});

/**
 * W8 自动接管：用户把页面控制权交还给 Bot（工具条按钮 / 关闭查看窗口 / 空闲超时）。
 * 主进程调 core（端口 B），core 向用过浏览器的进行中任务注入「先 browser_snapshot」。
 */
export const browserControlReturnedInputSchema = z.object({
  botId: z.string().min(1),
  conversationId: z.string().min(1),
  reason: z.enum(['button', 'viewer_closed', 'idle']),
});
export const browserControlReturnedOutputSchema = z.object({
  /** Tasks that received the handback notice. */
  injected: z.number().int().nonnegative(),
});

/**
 * W7 确定性监看：后台页取正文（键 `botId|watch:{watchId}`，不显示、用 Bot 的
 * 生效浏览器资料、受网络规则约束、取完即关）。`selector` 给定时 `text` 只取该
 * 元素的文本；`extraSelectors`（数字条件的元素）逐个返回，找不到为 null。
 */
export const browserFetchTextInputSchema = z.object({
  botId: z.string().min(1),
  watchId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  profileKey: browserProfileKeySchema,
  networkContext: browserNetworkContextSchema,
  url: z.string().min(1).max(2048),
  selector: z.string().min(1).max(WATCH_SELECTOR_MAX_CHARS).optional(),
  extraSelectors: z.array(z.string().min(1).max(WATCH_SELECTOR_MAX_CHARS)).max(4).optional(),
});
export const browserFetchTextOutputSchema = z.object({
  ok: z.literal(true),
  title: z.string(),
  /** Final URL after redirects. */
  url: z.string(),
  text: z.string(),
  /** The page text was cut at WATCH_FETCH_TEXT_MAX_CHARS. */
  truncated: z.boolean().optional(),
  extraTexts: z.array(z.string().nullable()).optional(),
});
export type BrowserFetchTextOutput = z.infer<typeof browserFetchTextOutputSchema>;

// --- browser profiles (W8) ---------------------------------------------------------

/** A shared browser profile with the bots currently using it. */
export const browserProfileEntrySchema = browserProfileSchema.extend({
  botIds: z.array(z.string()),
});
export type BrowserProfileEntry = z.infer<typeof browserProfileEntrySchema>;
export const browserProfilesListOutputSchema = z.object({
  profiles: z.array(browserProfileEntrySchema),
});
export const browserProfilesCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(BROWSER_PROFILE_NAME_MAX_CHARS),
});
export const browserProfilesCreateOutputSchema = z.object({
  profile: browserProfileEntrySchema,
  profiles: z.array(browserProfileEntrySchema),
});
export const browserProfilesRenameInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(BROWSER_PROFILE_NAME_MAX_CHARS),
});
export const browserProfileIdInputSchema = z.object({ id: z.string().min(1) });
export const browserProfilesMutateOutputSchema = z.object({
  profiles: z.array(browserProfileEntrySchema),
  /** delete only: bots moved back to their private profile. */
  movedBotIds: z.array(z.string()).optional(),
  /** Running tasks interrupted by the switch (delete only). */
  interrupted: z.number().int().nonnegative().optional(),
});

// --- 远程遥控（D96，docs/design/46-remote-control.md §5.2）----------------------

/** `remote.status`：总开关、anchor 状态机、在线设备与待确认配对请求。 */
export const remoteStatusOutputSchema = z.object({
  enabled: z.boolean(),
  relayUrl: relayEndpointSchema,
  anchor: remoteAnchorStateSchema,
  /** `error` / `connecting` 时的可读原因（本机 UI 托盘 / 状态页共用）。 */
  anchorReason: z.string().optional(),
  /** 开关开启时 core 生成的会话 id（配对二维码的一部分）。 */
  sessionId: z.string().nullable(),
  onlineDeviceIds: z.array(remoteDeviceIdSchema),
  /** 等桌面确认的配对请求（确认卡轮询 / `remote.pairingRequested` 事件后拉取）。 */
  pendingPairing: z.array(pendingPairingRequestSchema),
});
export type RemoteStatusOutput = z.infer<typeof remoteStatusOutputSchema>;

/** `remote.createPairing`：生成一次性配对码与二维码内容（产物见 pairingOfferSchema）。 */
export const remoteCreatePairingOutputSchema = pairingOfferSchema;
export type RemoteCreatePairingOutput = PairingOffer;

/** `remote.confirmPairing`：桌面确认卡「允许 / 拒绝」。 */
export const remoteConfirmPairingInputSchema = z.object({
  requestId: z.string().min(1),
  accept: z.boolean(),
});
export const remoteConfirmPairingOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('paired'), device: pairedDeviceSchema }),
  /** 用户点了拒绝（手机侧收到 pairing.reject）。 */
  z.object({ status: z.literal('declined') }),
  /** 请求已不在（过期 / 重复确认 / 手机已断开）。 */
  z.object({ status: z.literal('gone') }),
]);
export type RemoteConfirmPairingOutput = z.infer<typeof remoteConfirmPairingOutputSchema>;

/** `remote.revokeDevice`：撤销即 kick + 删密钥与 token 哈希 + 审计。 */
export const remoteRevokeDeviceInputSchema = z.object({ deviceId: remoteDeviceIdSchema });
export const remoteRevokeDeviceOutputSchema = z.object({ device: pairedDeviceSchema });

export const remoteDevicesOutputSchema = z.object({ devices: z.array(pairedDeviceSchema) });

export const remoteConfigGetOutputSchema = z.object({
  enabled: z.boolean(),
  relayUrl: relayEndpointSchema,
});
export type RemoteConfig = z.infer<typeof remoteConfigGetOutputSchema>;
export const remoteConfigSetInputSchema = z.object({
  enabled: z.boolean().optional(),
  relayUrl: relayEndpointSchema.optional(),
});
export const remoteConfigSetOutputSchema = remoteConfigGetOutputSchema;

/**
 * Method registry keyed by wire name. Port A (renderer <-> core) and port B
 * (main <-> core) share this registry; each server binds only its subset.
 */
export const rpcMethodSchemas = {
  'system.ping': { input: voidInput, output: systemPingOutputSchema },
  'system.info': { input: voidInput, output: systemInfoOutputSchema },
  'diagnostics.get': { input: voidInput, output: diagnosticsOutputSchema },
  'system.shutdown': { input: voidInput, output: systemShutdownOutputSchema },
  // P13 任务 2: served by core on port B for the main process's update gate.
  'update.activeRuns': { input: voidInput, output: updateActiveRunsOutputSchema },
  'update.cancelActive': {
    input: updateCancelActiveInputSchema,
    output: updateCancelActiveOutputSchema,
  },
  /** Port-B powerMonitor bridge (P10); see PlatformRpcMethods. */
  'power.resume': { input: voidInput, output: okOutput },
  'power.suspend': { input: voidInput, output: okOutput },

  'settings.get': { input: voidInput, output: settingsGetOutputSchema },
  'settings.update': { input: settingsUpdateInputSchema, output: settingsGetOutputSchema },
  'inkcop.health': { input: z.object({}).default({}), output: inkcopHealthOutputSchema },
  'inkcop.listAgents': { input: z.object({}).default({}), output: inkcopListAgentsOutputSchema },
  'settings.items.apply': {
    input: settingsItemsApplyInputSchema,
    output: settingsItemsApplyOutputSchema,
  },
  'settings.cards.dismiss': {
    input: settingsCardInputSchema,
    output: settingsCardsDismissOutputSchema,
  },
  'settings.cards.complete': {
    input: settingsCardsCompleteInputSchema,
    output: settingsCardsCompleteOutputSchema,
  },
  /** 重新打开对话时对 pending 的 link 卡核对一次（P2，design 38 §4.3）：核对通过才标 applied 并唤醒；核对不了保持 pending。 */
  'settings.cards.recheck': {
    input: settingsCardInputSchema,
    output: settingsCardsCompleteOutputSchema,
  },
  'settings.cards.undo': { input: settingsCardInputSchema, output: settingsCardsUndoOutputSchema },

  'providers.list': { input: voidInput, output: providersListOutputSchema },
  'providers.setKey': { input: providersSetKeyInputSchema, output: okOutput },
  'providers.removeKey': { input: providerNameInputSchema, output: okOutput },
  'providers.test': { input: providersTestInputSchema, output: okOutput },
  /** MCP（D65）：设置页连接测试——连接 server 并列出工具名（不落缓存）。 */
  'mcp.test': { input: mcpTestInputSchema, output: mcpTestOutputSchema },
  'mcp.setSecret': { input: mcpSetSecretInputSchema, output: okOutput },
  'mcp.removeSecret': { input: mcpRemoveSecretInputSchema, output: okOutput },
  /** W5：设置页逐工具策略——列出工具名、风险档与判定来源。 */
  'mcp.toolRisks': { input: mcpToolRisksInputSchema, output: mcpToolRisksOutputSchema },
  /** D73：显式删除自定义 server 并清理密钥 / 令牌 / 连接行。 */
  'mcp.removeServer': { input: mcpRemoveServerInputSchema, output: okOutput },
  /** D73 P2 §6.5 MCPB 本地包：读取包摘要 / 启动命令预览；确认后安装并建 stdio server。 */
  'mcpb.inspect': { input: mcpbInspectInputSchema, output: mcpbInspectOutputSchema },
  'mcpb.install': { input: mcpbInstallInputSchema, output: mcpbInstallOutputSchema },
  /** D73 连接应用：交互授权流程（结果经 apps.connect_flow 事件）。 */
  'apps.connect': { input: appsConnectInputSchema, output: appsConnectOutputSchema },
  'apps.connect.continue': { input: appsConnectContinueInputSchema, output: okOutput },
  'apps.connect.cancel': { input: appsConnectCancelInputSchema, output: okOutput },
  'apps.connect.confirmTools': { input: appsConnectConfirmToolsInputSchema, output: okOutput },
  'apps.catalog.list': { input: voidInput, output: appsCatalogListOutputSchema },
  /**
   * 本机连接（todo/local-connector-authoring.md）：列出 / 确认 Bot 的提案 / 拒绝提案 / 删除条目。
   * 不再受开发者模式门禁；`remove` 任何时候都能用（先断开全部连接再删条目）。
   */
  'apps.localConnectors.list': { input: voidInput, output: appsLocalConnectorsListOutputSchema },
  'apps.localConnectors.confirm': {
    input: appsLocalConnectorsConfirmInputSchema,
    output: appsLocalConnectorsConfirmOutputSchema,
  },
  'apps.localConnectors.reject': { input: appsLocalConnectorsRejectInputSchema, output: okOutput },
  'apps.localConnectors.remove': { input: appsLocalConnectorsRemoveInputSchema, output: okOutput },
  /** D73 P3 §7.6 随附技能：某连接下各被授权 Bot 还缺的技能 / 发起安装（走 skill_import 审批）。 */
  'apps.skills.offers': {
    input: appsSkillsOffersInputSchema,
    output: appsSkillsOffersOutputSchema,
  },
  'apps.skills.install': {
    input: appsSkillsInstallInputSchema,
    output: appsSkillsInstallOutputSchema,
  },
  /** D73 P3 §7.1 签名目录索引：同步状态 / 手动立即同步（关闭时不联网，直接返回状态）。 */
  'apps.directory.status': { input: voidInput, output: appsDirectoryStatusOutputSchema },
  'apps.directory.sync': { input: voidInput, output: appsDirectoryStatusOutputSchema },
  'apps.connections.update': {
    input: appsConnectionsUpdateInputSchema,
    output: appsConnectionsUpdateOutputSchema,
  },
  'apps.connections.setToolPolicy': {
    input: appsConnectionsSetToolPolicyInputSchema,
    output: okOutput,
  },
  'apps.connections.tools': {
    input: appsConnectionIdInputSchema,
    output: appsConnectionsToolsOutputSchema,
  },
  'apps.connections.reviewTools': {
    input: appsConnectionsReviewToolsInputSchema,
    output: appsConnectionsReviewToolsOutputSchema,
  },
  'apps.connections.grants': {
    input: appsConnectionIdInputSchema,
    output: appsConnectionsGrantsOutputSchema,
  },
  'apps.grants.revoke': { input: appsGrantsRevokeInputSchema, output: okOutput },
  'apps.egressSummary': {
    input: appsEgressSummaryInputSchema,
    output: appsEgressSummaryOutputSchema,
  },
  'apps.egressClear': {
    input: appsEgressClearInputSchema,
    output: appsEgressClearOutputSchema,
  },
  'apps.tools.approveAfterTest': {
    input: appsToolsApproveAfterTestInputSchema,
    output: appsToolsApproveAfterTestOutputSchema,
  },
  'apps.connections.list': {
    input: appsConnectionsListInputSchema,
    output: appsConnectionsListOutputSchema,
  },
  'apps.disconnect': { input: appsDisconnectInputSchema, output: okOutput },
  'apps.setClientCredentials': {
    input: appsSetClientCredentialsInputSchema,
    output: okOutput,
  },
  /** D73 P2：BYO 客户端（按 issuer；secret 只写不读）。 */
  'apps.oauthClients.list': { input: voidInput, output: appsOauthClientsListOutputSchema },
  'apps.oauthClients.set': { input: appsOauthClientsSetInputSchema, output: okOutput },
  'apps.oauthClients.remove': { input: appsOauthClientsRemoveInputSchema, output: okOutput },
  /** D73 P2 开发者模式：授权事件日志 / 原始工具定义 / 手动刷新工具。 */
  'apps.flowLog': { input: appsFlowLogInputSchema, output: appsFlowLogOutputSchema },
  // D73 P3 §7.5 MCP Apps rendering: register a card's UI resource, UI-initiated tool calls,
  // external links. `apps.ui.resource` is served on port B (the main process' protocol handler).
  'apps.ui.open': { input: appsUiOpenInputSchema, output: appsUiOpenOutputSchema },
  'apps.ui.close': { input: appsUiCloseInputSchema, output: okOutput },
  'apps.ui.callTool': { input: appsUiCallToolInputSchema, output: appsUiCallToolOutputSchema },
  'apps.ui.openLink': { input: appsUiOpenLinkInputSchema, output: appsUiOpenLinkOutputSchema },
  'apps.ui.resource': { input: appsUiResourceInputSchema, output: appsUiResourceOutputSchema },
  // D81 Bot Widgets（docs/design/32-bot-widgets.md）：卡片挂载 / 审查 / 能力桥与管理入口。
  // `widgets.ui.resource` 是平台方法（port B，主进程按 host 前缀 `widget-` 分流）。
  'widgets.ui.open': { input: widgetsUiOpenInputSchema, output: widgetsUiOpenOutputSchema },
  'widgets.ui.close': { input: widgetsUiCloseInputSchema, output: okOutput },
  'widgets.ui.source': { input: widgetsUiSourceInputSchema, output: widgetsUiSourceOutputSchema },
  'widgets.ui.poster': { input: widgetsUiPosterInputSchema, output: widgetsUiPosterOutputSchema },
  'widgets.ui.storage': { input: widgetsUiStorageInputSchema, output: widgetsUiStorageOutputSchema },
  'widgets.ui.openLink': {
    input: widgetsUiOpenLinkInputSchema,
    output: widgetsUiOpenLinkOutputSchema,
  },
  'widgets.ui.reply': { input: widgetsUiReplyInputSchema, output: widgetsUiReplyOutputSchema },
  'widgets.ui.query': { input: widgetsUiQueryInputSchema, output: widgetsUiQueryOutputSchema },
  'widgets.ui.resource': {
    input: widgetsUiResourceInputSchema,
    output: widgetsUiResourceOutputSchema,
  },
  'widgets.list': { input: widgetsListInputSchema, output: widgetsListOutputSchema },
  'widgets.delete': { input: widgetsDeleteInputSchema, output: widgetsDeleteOutputSchema },
  'widgets.publish': { input: widgetsPublishInputSchema, output: widgetsPublishOutputSchema },
  'mcp.rawTools': { input: mcpRawToolsInputSchema, output: mcpRawToolsOutputSchema },
  'mcp.refreshTools': { input: mcpRefreshToolsInputSchema, output: mcpRefreshToolsOutputSchema },
  'websearch.test': { input: webSearchTestInputSchema, output: webSearchTestOutputSchema },
  'websearch.setKey': { input: webSearchSetKeyInputSchema, output: okOutput },
  'websearch.removeKey': { input: webSearchRemoveKeyInputSchema, output: okOutput },

  // 统一媒体调用：方法内按 model 引用的厂商自动路由（media/gateway）。
  'media.generateImage': {
    input: mediaGenerateImageInputSchema,
    output: mediaGenerateImageOutputSchema,
  },
  'media.synthesizeSpeech': {
    input: mediaSynthesizeSpeechInputSchema,
    output: mediaSynthesizeSpeechOutputSchema,
  },
  'media.transcribeSpeech': {
    input: mediaTranscribeSpeechInputSchema,
    output: mediaTranscribeSpeechOutputSchema,
  },
  'media.generateVideo': {
    input: mediaGenerateVideoInputSchema,
    output: mediaGenerateVideoOutputSchema,
  },
  'media.videoStatus': {
    input: mediaVideoStatusInputSchema,
    output: mediaVideoStatusOutputSchema,
  },
  'media.rerank': {
    input: mediaRerankInputSchema,
    output: mediaRerankOutputSchema,
  },
  'media.understandImage': {
    input: mediaUnderstandImageInputSchema,
    output: mediaUnderstandImageOutputSchema,
  },

  'bots.list': { input: voidInput, output: botsListOutputSchema },
  'bots.get': { input: botIdInputSchema, output: botGetOutputSchema },
  'bots.create': { input: botsCreateInputSchema, output: botGetOutputSchema },
  'bots.update': { input: botsUpdateInputSchema, output: botGetOutputSchema },
  'bots.avatar.upload': {
    input: botsAvatarUploadInputSchema,
    output: botsAvatarUploadOutputSchema,
  },
  'bots.avatar.data': { input: botsAvatarDataInputSchema, output: botsAvatarDataOutputSchema },
  'user.avatar.upload': {
    input: userAvatarUploadInputSchema,
    output: userAvatarUploadOutputSchema,
  },
  'user.avatar.data': { input: userAvatarDataInputSchema, output: userAvatarDataOutputSchema },
  'bots.delete': { input: botIdInputSchema, output: okOutput },
  'bots.deletionPreview': { input: botIdInputSchema, output: botsDeletionPreviewOutputSchema },
  /** 模板导出/导入（docs/design/48-bot-template-export.md）：导出前摘要。 */
  'bots.templatePreview': {
    input: botsTemplatePreviewInputSchema,
    output: botsTemplatePreviewOutputSchema,
  },
  'bots.templateExport': {
    input: botsTemplateExportInputSchema,
    output: botsTemplateExportOutputSchema,
  },
  'bots.templateInspect': {
    input: botsTemplateInspectInputSchema,
    output: botsTemplateInspectOutputSchema,
  },
  'bots.templateImport': {
    input: botsTemplateImportInputSchema,
    output: botsTemplateImportOutputSchema,
  },
  /** 管家（D70）：确保唯一管家存在并打开其私聊（幂等）。 */
  'butler.ensure': { input: butlerEnsureInputSchema, output: butlerEnsureOutputSchema },
  'butler.acceptRoute': {
    input: butlerAcceptRouteInputSchema,
    output: butlerAcceptRouteOutputSchema,
  },
  /** 对话式创建第二步：打开直聊、投递 setup 起始事件并触发 Bot 首次提问。 */
  'bots.interview.start': { input: botIdInputSchema, output: interviewStartOutputSchema },
  /** 初始化问询的用户回答（不走草稿，落 setupAnswer 标记消息并触发响应 run）。 */
  'bots.interview.answer': {
    input: interviewAnswerInputSchema,
    output: interviewAnswerOutputSchema,
  },
  /** 访谈目录卡作答（选择工作目录或暂不设置）；作答后缓冲消息才投递（19/D59）。 */
  'bots.interview.answerPath': {
    input: interviewAnswerPathInputSchema,
    output: interviewAnswerPathOutputSchema,
  },

  'conversations.list': { input: voidInput, output: conversationsListOutputSchema },
  /** 通讯录名册：所有会话（含已归档的）。 */
  'conversations.all': { input: voidInput, output: conversationsAllOutputSchema },
  'conversations.get': { input: conversationGetInputSchema, output: conversationGetOutputSchema },
  'conversations.openDirect': {
    input: conversationsOpenDirectInputSchema,
    output: conversationsOpenDirectOutputSchema,
  },
  'conversations.delete': { input: conversationsDeleteInputSchema, output: okOutput },
  /** 从对话列表移除（归档）：数据全留，会话仍在通讯录里，可恢复。 */
  'conversations.archive': {
    input: conversationsArchiveInputSchema,
    output: conversationsArchiveOutputSchema,
  },
  /** 恢复已归档的会话（回到对话列表）。 */
  'conversations.unarchive': {
    input: conversationsArchiveInputSchema,
    output: conversationsArchiveOutputSchema,
  },
  'conversations.markRead': { input: conversationsMarkReadInputSchema, output: okOutput },
  'conversations.members': {
    input: conversationsMembersInputSchema,
    output: conversationsMembersOutputSchema,
  },

  'projects.create': { input: projectsCreateInputSchema, output: projectsCreateOutputSchema },
  'projects.setLead': {
    input: projectsSetLeadInputSchema,
    output: projectsSetLeadOutputSchema,
  },
  'projects.update': {
    input: projectsUpdateInputSchema,
    output: projectsUpdateOutputSchema,
  },
  'projects.addMembers': {
    input: projectsAddMembersInputSchema,
    output: conversationsMembersOutputSchema,
  },
  'projects.removeMember': { input: projectsRemoveMemberInputSchema, output: okOutput },
  'episodes.get': { input: episodesGetInputSchema, output: episodesGetOutputSchema },
  'episodes.resume': { input: episodesResumeInputSchema, output: episodesResumeOutputSchema },
  'episodes.stop': { input: episodesStopInputSchema, output: episodesStopOutputSchema },

  'messages.list': { input: messagesListInputSchema, output: messagesListOutputSchema },
  'messages.edit': { input: messagesEditInputSchema, output: messagesListOutputSchema },

  'messages.send': { input: messagesSendInputSchema, output: messagesSendOutputSchema },

  'attachments.upload': {
    input: attachmentsUploadInputSchema,
    output: attachmentsUploadOutputSchema,
  },
  'attachments.get': { input: attachmentsGetInputSchema, output: attachmentsGetOutputSchema },
  'attachments.status': {
    input: attachmentsStatusInputSchema,
    output: attachmentsStatusOutputSchema,
  },
  'attachments.detach': {
    input: attachmentsDetachInputSchema,
    output: attachmentsDetachOutputSchema,
  },

  'files.preview': { input: filesPreviewInputSchema, output: filesPreviewOutputSchema },
  'files.previewSession': {
    input: filePreviewSessionInputSchema,
    output: filePreviewSessionOutputSchema,
  },
  'files.previewResource': {
    input: filePreviewResourceInputSchema,
    output: filePreviewResourceOutputSchema,
  },

  'runs.cancel': { input: runIdInputSchema, output: runsCancelOutputSchema },
  'runs.retry': { input: runsRetryInputSchema, output: runsRetryOutputSchema },
  'runs.setupDismissed': { input: runIdInputSchema, output: runsSetupDismissedOutputSchema },
  'runs.dismissFailure': { input: runIdInputSchema, output: runsDismissFailureOutputSchema },
  'runs.steps': { input: runIdInputSchema, output: runsStepsOutputSchema },
  'runs.list': { input: runsListInputSchema, output: runsListOutputSchema },

  'sandbox.status': { input: sandboxStatusInputSchema, output: sandboxStatusOutputSchema },
  'sandbox.wslStatus': { input: voidInput, output: sandboxWslStatusOutputSchema },
  'sandbox.wslPrepare': { input: voidInput, output: sandboxWslStatusOutputSchema },
  'sandbox.wslSkip': { input: voidInput, output: sandboxWslSkipOutputSchema },

  'approvals.list': { input: approvalsListInputSchema, output: approvalsListOutputSchema },
  'approvals.decide': { input: approvalsDecideInputSchema, output: approvalsDecideOutputSchema },
  /** 跨 Bot 委派（D71）：A 侧卡片按 id 读委派行 / 用户在发出卡上取消。 */
  'delegations.get': { input: delegationIdInputSchema, output: delegationGetOutputSchema },
  'handovers.get': { input: handoversGetInputSchema, output: handoversGetOutputSchema },
  'delegations.cancel': { input: delegationIdInputSchema, output: delegationGetOutputSchema },
  'tasks.get': { input: taskIdInputSchema, output: taskGetOutputSchema },
  'tasks.active': { input: tasksActiveInputSchema, output: tasksActiveOutputSchema },
  'tasks.answer': { input: tasksAnswerInputSchema, output: okOutput },
  'effects.list': { input: taskIdInputSchema, output: effectsListOutputSchema },
  'grants.list': { input: grantsListInputSchema, output: grantsListOutputSchema },
  'grants.revoke': { input: grantIdInputSchema, output: okOutput },

  'allowlist.list': { input: voidInput, output: allowlistListOutputSchema },
  'allowlist.add': { input: allowlistAddInputSchema, output: allowlistListOutputSchema },
  'allowlist.update': { input: allowlistUpdateInputSchema, output: allowlistListOutputSchema },
  'allowlist.reset': { input: voidInput, output: allowlistListOutputSchema },

  'unattended.get': { input: voidInput, output: unattendedGetOutputSchema },
  'unattended.enable': { input: unattendedEnableInputSchema, output: unattendedGetOutputSchema },
  'unattended.disable': { input: voidInput, output: unattendedGetOutputSchema },
  'unattended.summary': {
    input: unattendedSummaryInputSchema,
    output: unattendedSummaryOutputSchema,
  },

  'workdirs.list': { input: voidInput, output: workdirsListOutputSchema },
  'workdirs.get': { input: workdirsGetInputSchema, output: workdirsGetOutputSchema },
  'workdirs.select': { input: workdirsSelectInputSchema, output: workdirsSelectOutputSchema },
  'workdirs.unbind': { input: workdirsUnbindInputSchema, output: okOutput },
  'workdirs.update': { input: workdirsUpdateInputSchema, output: workdirsGetOutputSchema },
  'workdirs.remove': { input: workdirsRemoveInputSchema, output: okOutput },
  'workdirs.diff': { input: workdirsDiffInputSchema, output: workdirsDiffOutputSchema },
  'workdirs.revert': { input: workdirsRevertInputSchema, output: workdirsRevertOutputSchema },
  'workdirs.revokeLease': {
    input: workdirsRevokeLeaseInputSchema,
    output: workdirsRevokeLeaseOutputSchema,
  },

  'environment.list': { input: voidInput, output: environmentListOutputSchema },
  'environment.remove': { input: environmentInstallIdInputSchema, output: okOutput },
  /** Re-runs the health check and returns the refreshed list. */
  'environment.recheck': { input: voidInput, output: environmentListOutputSchema },
  /** Settings-page reinstall of a failed/removed install (user-initiated). */
  'environment.reinstall': {
    input: environmentInstallIdInputSchema,
    output: environmentReinstallOutputSchema,
  },

  /**
   * 外部智能体（D72）。enable / login 的安装与登录在后台进行，进度与结果经
   * `agent.status` 事件推送（RPC 超时 60 s 内立即返回当前视图）。
   */
  'agents.catalog': { input: voidInput, output: agentsCatalogOutputSchema },
  'agents.list': { input: voidInput, output: agentsListOutputSchema },
  'agents.enable': { input: agentsEnableInputSchema, output: agentOutputSchema },
  'agents.disable': { input: agentsConfirmInputSchema, output: agentsAffectingOutputSchema },
  'agents.uninstall': { input: agentsConfirmInputSchema, output: agentsAffectingOutputSchema },
  'agents.login': { input: agentsLoginInputSchema, output: agentOutputSchema },
  'agents.logout': { input: agentsLogoutInputSchema, output: agentOutputSchema },
  'agents.test': { input: agentIdInputSchema, output: agentsTestOutputSchema },
  'agents.options': { input: agentsOptionsInputSchema, output: agentsOptionsOutputSchema },
  'agents.efforts': { input: agentsEffortsInputSchema, output: agentsEffortsOutputSchema },
  'agents.configure': { input: agentsConfigureInputSchema, output: agentOutputSchema },

  'memory.list': { input: memoryListInputSchema, output: memoryListOutputSchema },
  'memory.update': { input: memoryUpdateInputSchema, output: memoryListOutputSchema },
  'memory.retract': { input: memoryRetractInputSchema, output: memoryListOutputSchema },

  'profile.list': { input: voidInput, output: profileListOutputSchema },
  'profile.update': { input: profileUpdateInputSchema, output: profileListOutputSchema },
  'profile.retract': { input: profileRetractInputSchema, output: profileListOutputSchema },
  'profile.card': { input: voidInput, output: profileCardOutputSchema },

  'usage.summary': { input: usageSummaryInputSchema, output: usageSummaryOutputSchema },

  'embedding.status': { input: voidInput, output: embeddingStatusOutputSchema },
  'embedding.configure': {
    input: embeddingConfigureInputSchema,
    output: embeddingStatusOutputSchema,
  },
  /** 设置页「向量来源」的手动下载（用户点击即同意，出参同 reinstall）。 */
  'embedding.download': { input: voidInput, output: environmentReinstallOutputSchema },

  'skills.list': { input: skillsListInputSchema, output: skillsListOutputSchema },
  'skills.import': { input: skillsImportInputSchema, output: skillsImportOutputSchema },
  'skills.enable': { input: skillsSetNameInputSchema, output: skillsListOutputSchema },
  'skills.disable': { input: skillsSetNameInputSchema, output: skillsListOutputSchema },
  'skills.uninstall': { input: skillsSetNameInputSchema, output: skillsListOutputSchema },
  'skills.history': { input: skillsSetNameInputSchema, output: skillsHistoryOutputSchema },
  'skills.rollback': { input: skillsRollbackInputSchema, output: skillsListOutputSchema },
  'skills.read': { input: skillNameInputSchema, output: skillsReadOutputSchema },
  'skills.presets.list': {
    input: skillsPresetsListInputSchema,
    output: skillsPresetsListOutputSchema,
  },
  'skills.presets.install': {
    input: skillsPresetsInstallInputSchema,
    output: skillsPresetsInstallOutputSchema,
  },
  'skills.purgeMissing': {
    input: skillsPurgeMissingInputSchema,
    output: skillsPurgeMissingOutputSchema,
  },

  'wiki.tree': { input: wikiOwnerInputSchema, output: wikiTreeOutputSchema },
  'wiki.page': { input: wikiPageInputSchema, output: wikiPageOutputSchema },
  'wiki.search': { input: wikiSearchInputSchema, output: wikiSearchOutputSchema },
  'wiki.history': { input: wikiOwnerInputSchema, output: wikiHistoryOutputSchema },
  'wiki.commitTree': { input: wikiCommitInputSchema, output: wikiCommitTreeOutputSchema },
  'wiki.commitPage': { input: wikiCommitPageInputSchema, output: wikiCommitPageOutputSchema },
  'wiki.rollback': { input: wikiRollbackInputSchema, output: wikiRollbackOutputSchema },
  'wiki.deletePage': { input: wikiDeletePageInputSchema, output: wikiDeletePageOutputSchema },
  'wiki.sources': { input: wikiOwnerInputSchema, output: wikiSourcesOutputSchema },
  'wiki.addSource': { input: wikiAddSourceInputSchema, output: wikiAddSourceOutputSchema },
  'wiki.deleteSource': { input: wikiDeleteSourceInputSchema, output: wikiDeleteSourceOutputSchema },

  'schedules.list': { input: schedulesListInputSchema, output: schedulesListOutputSchema },
  'schedules.cancel': { input: schedulesCancelInputSchema, output: schedulesCancelOutputSchema },
  'schedules.acceptOffer': {
    input: schedulesOfferInputSchema,
    output: schedulesAcceptOfferOutputSchema,
  },
  'schedules.declineOffer': {
    input: schedulesOfferInputSchema,
    output: schedulesDeclineOfferOutputSchema,
  },

  // D90 工作台：事项（派给 Bot / 项目组，到点由宿主代发）与备忘。
  'todos.list': { input: todosListInputSchema, output: todosListOutputSchema },
  'todos.get': { input: todosIdInputSchema, output: todosGetOutputSchema },
  'todos.create': { input: todosCreateInputSchema, output: todosWriteOutputSchema },
  'todos.update': { input: todosUpdateInputSchema, output: todosWriteOutputSchema },
  'todos.start': { input: todosIdInputSchema, output: todosTransitionOutputSchema },
  'todos.complete': { input: todosIdInputSchema, output: todosTransitionOutputSchema },
  'todos.cancel': { input: todosIdInputSchema, output: todosTransitionOutputSchema },
  'todos.reopen': { input: todosIdInputSchema, output: todosTransitionOutputSchema },
  'board.get': { input: boardGetInputSchema, output: boardGetOutputSchema },
  'board.summary': { input: boardSummaryInputSchema, output: boardSummaryOutputSchema },
  'board.columns.create': {
    input: boardColumnsCreateInputSchema,
    output: boardColumnOutputSchema,
  },
  'board.columns.update': {
    input: boardColumnsUpdateInputSchema,
    output: boardColumnOutputSchema,
  },
  'board.columns.move': {
    input: boardColumnsMoveInputSchema,
    output: boardColumnsOutputSchema,
  },
  'board.columns.delete': {
    input: boardColumnsDeleteInputSchema,
    output: boardEmptyOutputSchema,
  },
  'board.cards.create': { input: boardCardsCreateInputSchema, output: boardCardOutputSchema },
  'board.cards.update': { input: boardCardsUpdateInputSchema, output: boardCardOutputSchema },
  'board.cards.move': { input: boardCardsMoveInputSchema, output: boardCardsMoveOutputSchema },
  'board.cards.assign': {
    input: boardCardsAssignInputSchema,
    output: boardCardWarningsOutputSchema,
  },
  'board.cards.schedule': {
    input: boardCardsScheduleInputSchema,
    output: boardCardWarningsOutputSchema,
  },
  'board.cards.start': { input: boardCardIdInputSchema, output: boardCardOutputSchema },
  'board.cards.complete': { input: boardCardIdInputSchema, output: boardCardOutputSchema },
  'board.cards.cancel': { input: boardCardIdInputSchema, output: boardCardOutputSchema },
  'board.cards.reopen': { input: boardCardIdInputSchema, output: boardCardOutputSchema },
  'board.cards.delete': { input: boardCardIdInputSchema, output: boardEmptyOutputSchema },
  'board.cards.conversation': {
    input: boardCardIdInputSchema,
    output: boardCardsConversationOutputSchema,
  },
  'memos.list': { input: memosListInputSchema, output: memosListOutputSchema },
  'memos.create': { input: memosCreateInputSchema, output: memosMemoOutputSchema },
  'memos.update': { input: memosUpdateInputSchema, output: memosMemoOutputSchema },
  'memos.delete': { input: memosIdInputSchema, output: memosMemoOutputSchema },
  'memos.restore': { input: memosIdInputSchema, output: memosMemoOutputSchema },

  // W7 确定性监看：右侧面板列表与对话内监看卡。
  'watches.list': { input: watchesListInputSchema, output: watchesListOutputSchema },
  'watches.get': { input: watchIdInputSchema, output: watchGetOutputSchema },
  'watches.pause': { input: watchIdInputSchema, output: watchMutateOutputSchema },
  'watches.resume': { input: watchIdInputSchema, output: watchMutateOutputSchema },
  'watches.stop': { input: watchIdInputSchema, output: watchMutateOutputSchema },
  'stickies.list': { input: stickiesListInputSchema, output: stickiesListOutputSchema },
  'stickies.create': { input: stickiesCreateInputSchema, output: stickiesCreateOutputSchema },
  'stickies.update': { input: stickiesUpdateInputSchema, output: stickiesUpdateOutputSchema },
  'stickies.delete': { input: stickiesDeleteInputSchema, output: stickiesDeleteOutputSchema },
  // D94: share.targets / share.consume are platform methods (port B, main → core);
  // share.failed.* are app methods (port A, renderer → core).
  'share.targets': { input: voidInput, output: shareTargetsOutputSchema },
  'share.consume': { input: shareConsumeInputSchema, output: shareConsumeOutputSchema },
  'share.failed.list': { input: shareFailedListInputSchema, output: shareFailedListOutputSchema },
  'share.failed.retry': {
    input: shareFailedRetryInputSchema,
    output: shareFailedRetryOutputSchema,
  },
  'share.failed.discard': { input: shareFailedDiscardInputSchema, output: okOutput },

  // D96 远程遥控：全部 app 方法（本机与远程端点功能对等，同一 handlers）。
  'remote.status': { input: voidInput, output: remoteStatusOutputSchema },
  'remote.createPairing': { input: voidInput, output: remoteCreatePairingOutputSchema },
  'remote.confirmPairing': {
    input: remoteConfirmPairingInputSchema,
    output: remoteConfirmPairingOutputSchema,
  },
  'remote.revokeDevice': {
    input: remoteRevokeDeviceInputSchema,
    output: remoteRevokeDeviceOutputSchema,
  },
  'remote.devices': { input: voidInput, output: remoteDevicesOutputSchema },
  'remote.config.get': { input: voidInput, output: remoteConfigGetOutputSchema },
  'remote.config.set': { input: remoteConfigSetInputSchema, output: remoteConfigSetOutputSchema },

  'mail.accounts.list': { input: voidInput, output: mailAccountsListOutputSchema },
  'mail.accounts.get': { input: mailAccountIdInputSchema, output: mailAccountGetOutputSchema },
  'mail.accounts.test': { input: mailAccountTestInputSchema, output: mailAccountTestOutputSchema },
  'mail.accounts.create': {
    input: mailAccountCreateInputSchema,
    output: mailAccountGetOutputSchema,
  },
  'mail.accounts.update': {
    input: mailAccountUpdateInputSchema,
    output: mailAccountGetOutputSchema,
  },
  'mail.accounts.delete': { input: mailAccountIdInputSchema, output: okOutput },
  'mail.accounts.setBots': {
    input: mailAccountSetBotsInputSchema,
    output: mailAccountGetOutputSchema,
  },
  'mail.bots.setAccounts': { input: mailBotSetAccountsInputSchema, output: okOutput },
  'mail.accounts.pause': { input: mailAccountIdInputSchema, output: mailAccountGetOutputSchema },
  'mail.accounts.resume': { input: mailAccountIdInputSchema, output: mailAccountGetOutputSchema },
  'mail.bindings.resume': {
    input: mailBindingResumeInputSchema,
    output: mailAccountGetOutputSchema,
  },

  // P11: served by the main process (browser-host) on port B — see the
  // PlatformRpcMethods / BrowserRpcMethods types below.
  'browser.ensurePage': {
    input: browserEnsurePageInputSchema,
    output: browserEnsurePageOutputSchema,
  },
  'browser.navigate': { input: browserNavigateInputSchema, output: browserNavigateOutputSchema },
  'browser.snapshot': { input: browserPairInputSchema, output: browserSnapshotOutputSchema },
  'browser.click': { input: browserClickInputSchema, output: browserActionOutputSchema },
  'browser.type': { input: browserTypeInputSchema, output: browserActionOutputSchema },
  'browser.press': { input: browserPressInputSchema, output: browserActionOutputSchema },
  'browser.scroll': { input: browserScrollInputSchema, output: browserActionOutputSchema },
  'browser.screenshot': { input: browserPairInputSchema, output: browserScreenshotOutputSchema },
  'browser.back': { input: browserPairInputSchema, output: browserActionOutputSchema },
  'browser.close': { input: browserCloseInputSchema, output: okOutput },
  'browser.setNetworkContext': {
    input: browserSetNetworkContextInputSchema,
    output: okOutput,
  },
  'browser.clearBotData': { input: browserClearBotDataInputSchema, output: okOutput },
  'browser.closeBotPages': { input: browserCloseBotPagesInputSchema, output: okOutput },
  'browser.clearProfileData': { input: browserClearProfileDataInputSchema, output: okOutput },
  // W7: the watch checker's background page (fetch the text, close the page).
  'browser.fetchText': { input: browserFetchTextInputSchema, output: browserFetchTextOutputSchema },
  // W8: served by the core on port B (the main process reports a handback).
  'browser.controlReturned': {
    input: browserControlReturnedInputSchema,
    output: browserControlReturnedOutputSchema,
  },

  // W8 共享浏览器资料（renderer → core）。
  'browserProfiles.list': { input: voidInput, output: browserProfilesListOutputSchema },
  'browserProfiles.create': {
    input: browserProfilesCreateInputSchema,
    output: browserProfilesCreateOutputSchema,
  },
  'browserProfiles.rename': {
    input: browserProfilesRenameInputSchema,
    output: browserProfilesMutateOutputSchema,
  },
  'browserProfiles.delete': {
    input: browserProfileIdInputSchema,
    output: browserProfilesMutateOutputSchema,
  },
  'browserProfiles.clear': {
    input: browserProfileIdInputSchema,
    output: browserProfilesMutateOutputSchema,
  },
  // D73: served by the main process on port B (like browser.*); core calls it to
  // open the system browser for OAuth consent. Not in APP_METHODS.
  'shell.openExternal': {
    input: shellOpenExternalInputSchema,
    output: shellOpenExternalOutputSchema,
  },
  // D87 P3b: served by the main process on port B; core's widget authoring loop runs a
  // widget in the hidden preview window (S2). Not in APP_METHODS.
  'widgetPreview.run': {
    input: widgetPreviewRunInputSchema,
    output: widgetPreviewRunOutputSchema,
  },
} as const;

export type RpcMethodName = keyof typeof rpcMethodSchemas;

/** Methods served by the core service on port A (renderer). */
export type AppRpcMethods = {
  [K in RpcMethodName]: (input: unknown) => Promise<unknown>;
};

/** Methods served by the core service on port B (main process). */
export type PlatformRpcMethods = {
  'system.shutdown': () => Promise<SystemShutdownOutput>;
  /** powerMonitor bridge (P10): the main process forwards sleep/wake events. */
  'power.resume': () => Promise<{ ok: true }>;
  'power.suspend': () => Promise<{ ok: true }>;
  /** P13 任务 2: in-flight executions for the update gate (never empty = wait). */
  'update.activeRuns': () => Promise<UpdateActiveRunsOutput>;
  /** P13 任务 2: user-confirmed interrupt of all active runs before updating. */
  'update.cancelActive': (input: { reason: string }) => Promise<UpdateCancelActiveOutput>;
  /** W8: the user handed a bot page back (viewer toolbar / close / idle). */
  'browser.controlReturned': (input: {
    botId: string;
    conversationId: string;
    reason: 'button' | 'viewer_closed' | 'idle';
  }) => Promise<{ injected: number }>;
  /** D73 P3 §7.5: the protocol handler fetches a registered MCP App page (HTML + CSP header). */
  'apps.ui.resource': (input: { resourceId: string; host: string }) => Promise<{
    html: string;
    csp: string;
  }>;
  /** D81: the same protocol handler fetches a bot-widget page (host prefix `widget-`). */
  'widgets.ui.resource': (input: { resourceId: string; host: string }) => Promise<{
    html: string;
    csp: string;
  }>;
  /** kepcup-file 协议处理器按会话 token 取目录内文件（完整 WebApp 档，docs/design/47）。 */
  'files.previewResource': (input: { token: string; rel: string }) => Promise<{
    mime: string;
    dataBase64: string;
  }>;
  /**
   * D94 §5.5: 分享目标快照（Bot / 项目组），主进程写进 App Group 供
   * Share Extension 读取。
   */
  'share.targets': () => Promise<ShareTargets>;
  /**
   * D94 §5.5: 消费一个分享批次（主进程把 App Group inbox 移进 core inbox
   * 后调用；只接受 core inbox 前缀下的路径）。
   */
  'share.consume': (input: ShareConsumeInput) => Promise<ShareConsumeOutput>;
};

/** The browser methods the MAIN process serves on port B (P11; W8 adds two). */
export const BROWSER_RPC_METHODS = [
  'browser.ensurePage',
  'browser.navigate',
  'browser.snapshot',
  'browser.click',
  'browser.type',
  'browser.press',
  'browser.scroll',
  'browser.screenshot',
  'browser.back',
  'browser.close',
  'browser.setNetworkContext',
  'browser.clearBotData',
  'browser.closeBotPages',
  'browser.clearProfileData',
  'browser.fetchText',
] as const satisfies readonly RpcMethodName[];

/** Methods the MAIN process serves on port B for core's use (D73): system-shell integration. */
export const SHELL_RPC_METHODS = ['shell.openExternal'] as const satisfies readonly RpcMethodName[];

/** Methods the MAIN process serves on port B for core's use (D87): widget preview (S2). */
export const WIDGET_PREVIEW_RPC_METHODS = [
  'widgetPreview.run',
] as const satisfies readonly RpcMethodName[];

const APP_METHODS = [
  'system.ping',
  'system.info',
  'diagnostics.get',
  'settings.get',
  'settings.update',
  'inkcop.health',
  'inkcop.listAgents',
  'settings.items.apply',
  'settings.cards.dismiss',
  'settings.cards.complete',
  'settings.cards.recheck',
  'settings.cards.undo',
  'providers.list',
  'providers.setKey',
  'providers.removeKey',
  'providers.test',
  'media.generateImage',
  'media.synthesizeSpeech',
  'media.transcribeSpeech',
  'media.generateVideo',
  'media.videoStatus',
  'media.rerank',
  'media.understandImage',
  'mcp.test',
  'mcp.setSecret',
  'mcp.removeSecret',
  'mcp.toolRisks',
  'mcp.removeServer',
  'mcpb.inspect',
  'mcpb.install',
  'apps.connect',
  'apps.connect.continue',
  'apps.connect.cancel',
  'apps.connect.confirmTools',
  'apps.catalog.list',
  'apps.localConnectors.list',
  'apps.localConnectors.confirm',
  'apps.localConnectors.reject',
  'apps.localConnectors.remove',
  'apps.skills.offers',
  'apps.skills.install',
  'apps.directory.status',
  'apps.directory.sync',
  'apps.connections.update',
  'apps.connections.setToolPolicy',
  'apps.connections.tools',
  'apps.connections.reviewTools',
  'apps.connections.grants',
  'apps.grants.revoke',
  'apps.egressSummary',
  'apps.egressClear',
  'apps.tools.approveAfterTest',
  'apps.connections.list',
  'apps.disconnect',
  'apps.setClientCredentials',
  'apps.oauthClients.list',
  'apps.oauthClients.set',
  'apps.oauthClients.remove',
  'apps.flowLog',
  'apps.ui.open',
  'apps.ui.close',
  'apps.ui.callTool',
  'apps.ui.openLink',
  // D81 Bot Widgets：卡片挂载 / 审查 / 能力桥与管理入口（widgets.ui.resource 在 port B）。
  'widgets.ui.open',
  'widgets.ui.close',
  'widgets.ui.source',
  'widgets.ui.poster',
  'widgets.ui.storage',
  'widgets.ui.openLink',
  'widgets.ui.reply',
  'widgets.ui.query',
  'widgets.list',
  'widgets.delete',
  'widgets.publish',
  'mcp.rawTools',
  'mcp.refreshTools',
  'websearch.test',
  'websearch.setKey',
  'websearch.removeKey',
  'bots.list',
  'bots.get',
  'bots.create',
  'bots.update',
  'bots.avatar.upload',
  'bots.avatar.data',
  'bots.delete',
  'bots.deletionPreview',
  'bots.templatePreview',
  'bots.templateExport',
  'bots.templateInspect',
  'bots.templateImport',
  'butler.ensure',
  'butler.acceptRoute',
  'bots.interview.start',
  'bots.interview.answer',
  'bots.interview.answerPath',
  'conversations.list',
  'conversations.all',
  'conversations.get',
  'conversations.openDirect',
  'conversations.delete',
  'conversations.archive',
  'conversations.unarchive',
  'conversations.markRead',
  'conversations.members',
  'projects.create',
  'projects.setLead',
  'projects.update',
  'projects.addMembers',
  'projects.removeMember',
  'messages.list',
  'messages.edit',
  'messages.send',
  'attachments.upload',
  'attachments.get',
  'attachments.status',
  'attachments.detach',
  'files.preview',
  'files.previewSession',
  'runs.cancel',
  'runs.retry',
  'runs.setupDismissed',
  'runs.dismissFailure',
  'runs.steps',
  'runs.list',
  'sandbox.status',
  'sandbox.wslStatus',
  'sandbox.wslPrepare',
  'sandbox.wslSkip',
  'approvals.list',
  'approvals.decide',
  'delegations.get',
  'handovers.get',
  'delegations.cancel',
  'tasks.get',
  'tasks.active',
  'tasks.answer',
  'effects.list',
  'grants.list',
  'grants.revoke',
  'allowlist.list',
  'allowlist.add',
  'allowlist.update',
  'allowlist.reset',
  'unattended.get',
  'unattended.enable',
  'unattended.disable',
  'unattended.summary',
  'workdirs.list',
  'workdirs.get',
  'workdirs.select',
  'workdirs.unbind',
  'workdirs.update',
  'workdirs.remove',
  'workdirs.diff',
  'workdirs.revert',
  'workdirs.revokeLease',
  'environment.list',
  'environment.remove',
  'environment.recheck',
  'environment.reinstall',
  'agents.catalog',
  'agents.list',
  'agents.enable',
  'agents.disable',
  'agents.uninstall',
  'agents.login',
  'agents.logout',
  'agents.test',
  'agents.options',
  'agents.efforts',
  'agents.configure',
  'memory.list',
  'memory.update',
  'memory.retract',
  'profile.list',
  'profile.update',
  'profile.retract',
  'profile.card',
  'usage.summary',
  'embedding.status',
  'embedding.configure',
  'embedding.download',
  'skills.list',
  'skills.import',
  'skills.enable',
  'skills.disable',
  'skills.uninstall',
  'skills.history',
  'skills.rollback',
  'skills.read',
  'skills.presets.list',
  'skills.presets.install',
  'wiki.tree',
  'wiki.page',
  'wiki.search',
  'wiki.history',
  'wiki.rollback',
  'wiki.deletePage',
  'wiki.sources',
  'wiki.addSource',
  'wiki.deleteSource',
  'schedules.list',
  'schedules.cancel',
  'todos.list',
  'todos.get',
  'todos.create',
  'todos.update',
  'todos.start',
  'todos.complete',
  'todos.cancel',
  'todos.reopen',
  'board.get',
  'board.summary',
  'board.columns.create',
  'board.columns.update',
  'board.columns.move',
  'board.columns.delete',
  'board.cards.create',
  'board.cards.update',
  'board.cards.move',
  'board.cards.assign',
  'board.cards.schedule',
  'board.cards.start',
  'board.cards.complete',
  'board.cards.cancel',
  'board.cards.reopen',
  'board.cards.delete',
  'board.cards.conversation',
  'memos.list',
  'memos.create',
  'memos.update',
  'memos.delete',
  'memos.restore',
  'watches.list',
  'watches.get',
  'watches.pause',
  'watches.resume',
  'watches.stop',
  'stickies.list',
  'stickies.create',
  'stickies.update',
  'stickies.delete',
  'mail.accounts.list',
  'mail.accounts.get',
  'mail.accounts.test',
  'mail.accounts.create',
  'mail.accounts.update',
  'mail.accounts.delete',
  'mail.accounts.setBots',
  'mail.bots.setAccounts',
  'mail.accounts.pause',
  'mail.accounts.resume',
  'mail.bindings.resume',
  'browserProfiles.list',
  'browserProfiles.create',
  'browserProfiles.rename',
  'browserProfiles.delete',
  'browserProfiles.clear',
  'schedules.acceptOffer',
  'schedules.declineOffer',
  'share.failed.list',
  'share.failed.retry',
  'share.failed.discard',
  'remote.status',
  'remote.createPairing',
  'remote.confirmPairing',
  'remote.revokeDevice',
  'remote.devices',
  'remote.config.get',
  'remote.config.set',
] as const satisfies readonly RpcMethodName[];

export const APP_RPC_METHODS: readonly RpcMethodName[] = APP_METHODS;
export const PLATFORM_RPC_METHODS: readonly RpcMethodName[] = [
  'system.shutdown',
  'unattended.disable',
  'power.resume',
  'power.suspend',
  'update.activeRuns',
  'update.cancelActive',
  'browser.controlReturned',
  'apps.ui.resource',
  'widgets.ui.resource',
  'files.previewResource',
  'share.targets',
  'share.consume',
  // D96 远程遥控：托盘读状态 / 切开关 / 发起配对（主进程 → core，端口 B）。
  'remote.status',
  'remote.createPairing',
  'remote.config.set',
];
