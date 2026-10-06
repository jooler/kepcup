import { z } from 'zod';
import {
  allowlistEntrySchema,
  approvalSchema,
  attachmentSchema,
  botProfileSchema,
  botSchema,
  delegationSchema,
  budgetSchema,
  conversationSchema,
  customProviderSchema,
  capabilityModelsSchema,
  draftSchema,
  embeddingStatusSchema,
  envInstallSchema,
  envSystemStatusSchema,
  grantSchema,
  memoryItemSchema,
  messageSchema,
  onboardingStatePatchSchema,
  profileCardSchema,
  profileItemSchema,
  projectProtectRulesSchema,
  projectSchema,
  runChangeSchema,
  providerConcurrencySchema,
  runSchema,
  runStepSchema,
  scheduleEntrySchema,
  settingsSchema,
  skillCandidateSchema,
  mcpServerSchema,
  webSearchProviderSchema,
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
import { modelCapabilitySchema, vendorProviderSchema } from '../domain/vendors.js';
import type { BrowserNetworkContext } from '../browser/net-rules.js';

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
  customProviders: z.array(customProviderSchema).optional(),
  vendorProviders: z.array(vendorProviderSchema).optional(),
  defaultMainModel: z.string().optional(),
  defaultLightModel: z.string().optional(),
  /** 能力模型配置（整体覆盖 patch；UI 传完整 capabilityModels）。 */
  capabilityModels: capabilityModelsSchema.optional(),
  providerConcurrency: providerConcurrencySchema.optional(),
  /** P13 任务 3: launch at login (main process applies it to the OS). */
  launchAtLogin: z.boolean().optional(),
  /** P13 任务 4: first-run wizard completion flags (partial patch). */
  onboarding: onboardingStatePatchSchema.optional(),
  /** MCP server 列表（D65）：整体覆盖 patch；密钥走 mcp.setSecret，UI 写占位符。 */
  mcpServers: z.array(mcpServerSchema).optional(),
});

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
});

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
  })
  .refine((input) => input.interview || input.profile.identity.name.trim().length > 0, {
    path: ['profile', 'identity', 'name'],
    message: 'Bot name must not be empty',
  });
export const botsUpdateInputSchema = z.object({
  id: z.string().min(1),
  profile: namedProfile,
});
/**
 * Upload an avatar image for a bot. The renderer sends the (already
 * downscaled) bytes; core writes the file under `bots/{id}/avatar/` and
 * points `identity.avatar` at it (`upload:{fileName}`).
 */
export const botsAvatarUploadInputSchema = z.object({
  id: z.string().min(1),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  bytesBase64: z.string().min(1),
});
export const botsAvatarUploadOutputSchema = botGetOutputSchema;
/** Read back an uploaded avatar (file name comes from `bot.avatar`). */
export const botsAvatarDataInputSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
});
export const botsAvatarDataOutputSchema = z.object({ mime: z.string(), base64: z.string() });
export const botsDeletionPreviewOutputSchema = z.object({
  conversations: z.number().int(),
  messages: z.number().int(),
  memoryItems: z.number().int(),
  wikiPages: z.number().int(),
  skills: z.number().int(),
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
 * 访谈目录卡作答（docs/design/19 D59）：path 非空 = 选择目录（绑定 project），
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
export const conversationsOpenDirectInputSchema = z.object({ botId: z.string().min(1) });
export const conversationsOpenDirectOutputSchema = z.object({
  conversation: conversationSchema,
  created: z.boolean(),
});
export const conversationsDeleteInputSchema = z.object({ id: z.string().min(1) });
export const conversationsMarkReadInputSchema = z.object({
  conversationId: z.string().min(1),
  seq: z.number().int(),
});
export const conversationGetInputSchema = z.object({ id: z.string().min(1) });
export const conversationGetOutputSchema = z.object({
  conversation: conversationSchema.nullable(),
});

// --- groups (P05) -----------------------------------------------------------

export const groupsCreateInputSchema = z.object({
  title: z.string().min(1).max(100),
  memberBotIds: z.array(z.string().min(1)).min(2),
});
export const groupsCreateOutputSchema = z.object({ conversation: conversationSchema });
/**
 * 对话内群创建（docs/design/19 D60）：start 创建创建中的群并下发第一问；
 * answer 按 step 推进（title/purpose 文本、members 成员列表、project 目录或
 * 跳过），全程零模型调用；cancel 级联删除该对话。
 */
export const groupsSetupStartInputSchema = z.void();
export const groupsSetupStartOutputSchema = z.object({ conversation: conversationSchema });
export const groupsSetupAnswerInputSchema = z.discriminatedUnion('step', [
  z.object({
    conversationId: z.string().min(1),
    step: z.literal('title'),
    text: z.string().min(1).max(100),
  }),
  z.object({
    conversationId: z.string().min(1),
    step: z.literal('purpose'),
    text: z.string().min(1).max(500),
  }),
  z.object({
    conversationId: z.string().min(1),
    step: z.literal('members'),
    botIds: z.array(z.string().min(1)).min(2),
  }),
  z.object({
    conversationId: z.string().min(1),
    step: z.literal('project'),
    path: z.string().min(1).nullable(),
  }),
]);
export const groupsSetupAnswerOutputSchema = z.object({
  conversation: conversationSchema,
  /** true = 最后一步已作答，群创建完成。 */
  done: z.boolean(),
});
export const groupsSetupCancelInputSchema = z.object({ conversationId: z.string().min(1) });
export const conversationIdInputSchema = z.object({ conversationId: z.string().min(1) });
export const groupsRenameInputSchema = z.object({
  conversationId: z.string().min(1),
  title: z.string().min(1).max(100),
});
export const groupsRenameOutputSchema = z.object({ conversation: conversationSchema });
export const groupsAddMembersInputSchema = z.object({
  conversationId: z.string().min(1),
  botIds: z.array(z.string().min(1)).min(1),
});
export const groupsRemoveMemberInputSchema = z.object({
  conversationId: z.string().min(1),
  botId: z.string().min(1),
});
export const groupMemberSchema = z.object({ bot: botSchema, joinedAt: z.number() });
export type GroupMember = z.infer<typeof groupMemberSchema>;
export const conversationsMembersInputSchema = z.object({ conversationId: z.string().min(1) });
export const conversationsMembersOutputSchema = z.object({
  members: z.array(groupMemberSchema),
});
/**
 * Clicking a bot in the "no Bot claimed this" system message re-dispatches the
 * original batch as if the user had @-ed that bot.
 */
export const groupsRedistributeInputSchema = z.object({
  conversationId: z.string().min(1),
  batchId: z.string().min(1),
  botId: z.string().min(1),
});

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

// --- drafts ---------------------------------------------------------------

export const draftsListInputSchema = z.object({ conversationId: z.string().min(1) });
export const draftsListOutputSchema = z.object({ drafts: z.array(draftSchema) });
// Patch-shaped input: plain optionals (no defaults) so a partial update never
// erases stored values (see settingsUpdateInputSchema note above).
export const draftsAddInputSchema = z.object({
  conversationId: z.string().min(1),
  /** 空文本 + 纯附件允许（docs/design/20-conversation-media.md）；渲染层保证非空组合。 */
  text: z.string().max(100_000),
  mentions: z.array(z.string().min(1)).optional(),
  replyTo: z.string().min(1).nullable().optional(),
  /**
   * 随草稿发送的附件（attachments.upload 先行上传）：core 校验归属后把
   * draft_id 预挂到本草稿，flush 时随消息转正。
   */
  attachmentIds: z.array(z.string().min(1)).optional(),
});
export const draftsUpdateInputSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(100_000),
});
export const draftsReorderInputSchema = z.object({
  conversationId: z.string().min(1),
  /** Draft ids in their new order. */
  ids: z.array(z.string()).min(1),
});
export const draftsRemoveInputSchema = z.object({ id: z.string().min(1) });
export const draftsFlushInputSchema = z.object({ conversationId: z.string().min(1) });
/** 立即发送队列中的单条草稿（UI 逐条「立即」按钮）。 */
export const draftsFlushOneInputSchema = z.object({ id: z.string().min(1) });
export const draftsFlushOutputSchema = z.object({
  messages: z.array(messageSchema),
  runId: z.string().nullable(),
});

// --- attachments ----------------------------------------------------------

export const attachmentsUploadInputSchema = z.object({
  conversationId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  bytesBase64: z.string().min(1).max(40_000_000),
  draftId: z.string().min(1).optional(),
});
export const attachmentsUploadOutputSchema = z.object({ attachment: attachmentSchema });
export const attachmentsGetInputSchema = z.object({ id: z.string().min(1) });
export const attachmentsGetOutputSchema = z.object({
  attachment: attachmentSchema,
  dataBase64: z.string(),
});
/** 移除草稿阶段的附件（已随消息发出的附件不可移除）。 */
export const attachmentsDetachInputSchema = z.object({ id: z.string().min(1) });
export const attachmentsDetachOutputSchema = z.object({ ok: z.literal(true) });

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
export const runsStepsOutputSchema = z.object({ steps: z.array(runStepSchema) });
export const runsListInputSchema = z.object({
  conversationId: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
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
  /** Access approvals only: 仅这一次 / 本对话内一直允许. */
  duration: z.enum(['once', 'conversation']).optional(),
  /**
   * `butler_proposal` only (D70): indexes into payload.bots the user kept;
   * an empty selection with approve=true counts as a denial.
   */
  selection: z.array(z.number().int().nonnegative()).optional(),
});
export const approvalsDecideOutputSchema = z.object({ approval: approvalSchema });

// --- cross-bot delegation (D71) -------------------------------------------------

export const delegationIdInputSchema = z.object({ id: z.string().min(1) });
export const delegationGetOutputSchema = z.object({ delegation: delegationSchema.nullable() });

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
});
export const unattendedSummaryOutputSchema = z.object({
  items: z.array(unattendedSummaryItemSchema),
});

// --- projects (P04) ---------------------------------------------------------

export const projectsListOutputSchema = z.object({ projects: z.array(projectSchema) });
export const projectsGetInputSchema = z.object({ id: z.string().min(1) });
export const projectsGetOutputSchema = z.object({ project: projectSchema.nullable() });
export const projectsSelectInputSchema = z.object({
  conversationId: z.string().min(1),
  /** realpath of the picked directory; core re-realpaths and validates. */
  path: z.string().min(1),
});
export const projectsSelectOutputSchema = z.object({ project: projectSchema });
export const projectsUnbindInputSchema = z.object({ conversationId: z.string().min(1) });
export const projectsUpdateInputSchema = z.object({
  id: z.string().min(1),
  // 名称不可改：项目名固定为所选文件夹的名字（bind 时取 basename）。
  protectRules: projectProtectRulesSchema.optional(),
  allowedPorts: z
    .array(z.tuple([z.number().int().min(1).max(65535), z.number().int().min(1).max(65535)]))
    .nullable()
    .optional(),
});
export const projectsRemoveInputSchema = z.object({ id: z.string().min(1) });
export const projectsDiffInputSchema = z.object({ runId: z.string().min(1) });
export const projectsDiffOutputSchema = z.object({
  change: runChangeSchema.nullable(),
  /** Unified diff (before → after); empty when nothing changed or reverted. */
  diffText: z.string(),
});
export const projectsRevertInputSchema = z.object({
  runId: z.string().min(1),
  /** Confirmed after a previous call reported conflicts. */
  force: z.boolean().optional(),
});
export const projectsRevertOutputSchema = z.object({
  ok: z.boolean(),
  /** Files changed after the after-snapshot; revert refused while non-empty and force is not set. */
  conflicts: z.array(z.string()),
  reverted: z.array(z.string()),
});
export const projectsRevokeLeaseInputSchema = z.object({ conversationId: z.string().min(1) });
export const projectsRevokeLeaseOutputSchema = z.object({ revoked: z.boolean() });

// --- environment (P06) -------------------------------------------------------

export const environmentListOutputSchema = z.object({
  installs: z.array(envInstallSchema),
  /** Live detection of kind='system' items on this machine (macOS/Linux git). */
  system: z.array(envSystemStatusSchema),
});
export const environmentInstallIdInputSchema = z.object({ id: z.string().min(1) });
export const environmentReinstallOutputSchema = z.object({ install: envInstallSchema.nullable() });

// --- memory & user profile (P07) ---------------------------------------------

export const memoryListInputSchema = z.object({ botId: z.string().min(1) });
export const memoryListOutputSchema = z.object({ items: z.array(memoryItemSchema) });
export const memoryUpdateInputSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  content: z.string().min(1).max(10_000).optional(),
  /**
   * 任务书任务 13 的界面动作「标记只属于该 Bot」需要独立于内容的写入通道
   * （content 与 privateToBot 允许只改其一，均为显式 optional）。
   */
  privateToBot: z.boolean().optional(),
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

// --- usage & budget (P07) ------------------------------------------------------

export const usageSummaryInputSchema = z.object({
  /** Local-day window ending today; default 7. */
  days: z.number().int().min(1).max(90).optional(),
});
export const budgetGetOutputSchema = budgetSchema;
export const budgetUpdateInputSchema = budgetSchema;

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

// --- wiki (P09) ---------------------------------------------------------------

export const wikiBotIdInputSchema = z.object({ botId: z.string().min(1) });
export const wikiTreeOutputSchema = z.object({ pages: z.array(wikiPageSchema) });
export type WikiTreeOutput = z.infer<typeof wikiTreeOutputSchema>;
/** Paths are wiki-root relative; `index.md` plus everything under `pages/`. */
export const wikiPageInputSchema = z.object({
  botId: z.string().min(1),
  path: z.string().min(1).max(500),
});
export const wikiPageOutputSchema = z.object({
  path: z.string(),
  title: z.string(),
  content: z.string(),
});
export type WikiPageOutput = z.infer<typeof wikiPageOutputSchema>;
export const wikiSearchInputSchema = z.object({
  botId: z.string().min(1),
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).optional(),
});
export const wikiSearchOutputSchema = z.object({ hits: z.array(wikiSearchHitSchema) });
export type WikiSearchOutput = z.infer<typeof wikiSearchOutputSchema>;
export const wikiHistoryOutputSchema = z.object({ history: z.array(wikiHistoryEntrySchema) });
export type WikiHistoryOutput = z.infer<typeof wikiHistoryOutputSchema>;
export const wikiRollbackInputSchema = z.object({
  botId: z.string().min(1),
  commitOid: z.string().min(1),
});
export const wikiRollbackOutputSchema = z.object({ ok: z.literal(true) });
/** Same input shape as wiki.page: `{ botId, path }`, path strictly under pages/.
 * Standalone schema (not an alias): the two methods' contracts must evolve
 * independently. */
export const wikiDeletePageInputSchema = z.object({
  botId: z.string().min(1),
  path: z.string().min(1).max(500),
});
export const wikiDeletePageOutputSchema = z.object({ ok: z.literal(true) });

// --- schedules (P10) -------------------------------------------------------------

/** Omitted conversationId = every schedule (settings-page overview). */
export const schedulesListInputSchema = z.object({
  conversationId: z.string().min(1).optional(),
});
export const schedulesListOutputSchema = z.object({ schedules: z.array(scheduleEntrySchema) });
export const schedulesCancelInputSchema = z.object({ id: z.string().min(1) });
export const schedulesCancelOutputSchema = z.object({ ok: z.literal(true) });

// --- browser (P11) ----------------------------------------------------------------
// Served by the MAIN process on port B; the core's browser tools are the
// client (docs/dev/02-architecture.md 端口 B: 核心服务请求平台能力).

/** Loopback (127.0.0.1/localhost) is reachable only with a bound project. */
export const browserNetworkContextSchema: z.ZodType<BrowserNetworkContext> = z.object({
  allowLoopback: z.boolean(),
});

export const browserEnsurePageInputSchema = z.object({
  botId: z.string().min(1),
  conversationId: z.string().min(1),
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
  text: z.string(),
  textTruncated: z.boolean(),
});
export type BrowserSnapshotOutput = z.infer<typeof browserSnapshotOutputSchema>;

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

  'providers.list': { input: voidInput, output: providersListOutputSchema },
  'providers.setKey': { input: providersSetKeyInputSchema, output: okOutput },
  'providers.removeKey': { input: providerNameInputSchema, output: okOutput },
  'providers.test': { input: providersTestInputSchema, output: okOutput },
  /** MCP（D65）：设置页连接测试——连接 server 并列出工具名（不落缓存）。 */
  'mcp.test': { input: mcpTestInputSchema, output: mcpTestOutputSchema },
  'mcp.setSecret': { input: mcpSetSecretInputSchema, output: okOutput },
  'mcp.removeSecret': { input: mcpRemoveSecretInputSchema, output: okOutput },
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
  'bots.delete': { input: botIdInputSchema, output: okOutput },
  'bots.deletionPreview': { input: botIdInputSchema, output: botsDeletionPreviewOutputSchema },
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
  'conversations.get': { input: conversationGetInputSchema, output: conversationGetOutputSchema },
  'conversations.openDirect': {
    input: conversationsOpenDirectInputSchema,
    output: conversationsOpenDirectOutputSchema,
  },
  'conversations.delete': { input: conversationsDeleteInputSchema, output: okOutput },
  'conversations.markRead': { input: conversationsMarkReadInputSchema, output: okOutput },
  'conversations.members': {
    input: conversationsMembersInputSchema,
    output: conversationsMembersOutputSchema,
  },

  'groups.create': { input: groupsCreateInputSchema, output: groupsCreateOutputSchema },
  /** 对话内群创建（19/D60）：start 建创建中的群并下发第一问，answer 推进四步。 */
  'groups.setup.start': {
    input: groupsSetupStartInputSchema,
    output: groupsSetupStartOutputSchema,
  },
  'groups.setup.answer': {
    input: groupsSetupAnswerInputSchema,
    output: groupsSetupAnswerOutputSchema,
  },
  'groups.setup.cancel': { input: groupsSetupCancelInputSchema, output: okOutput },
  'groups.rename': { input: groupsRenameInputSchema, output: groupsRenameOutputSchema },
  'groups.addMembers': {
    input: groupsAddMembersInputSchema,
    output: conversationsMembersOutputSchema,
  },
  'groups.removeMember': { input: groupsRemoveMemberInputSchema, output: okOutput },
  'groups.redistribute': { input: groupsRedistributeInputSchema, output: okOutput },

  'messages.list': { input: messagesListInputSchema, output: messagesListOutputSchema },
  'messages.edit': { input: messagesEditInputSchema, output: messagesListOutputSchema },

  'drafts.list': { input: draftsListInputSchema, output: draftsListOutputSchema },
  'drafts.add': { input: draftsAddInputSchema, output: draftsListOutputSchema },
  'drafts.update': { input: draftsUpdateInputSchema, output: draftsListOutputSchema },
  'drafts.reorder': { input: draftsReorderInputSchema, output: draftsListOutputSchema },
  'drafts.remove': { input: draftsRemoveInputSchema, output: draftsListOutputSchema },
  'drafts.flush': { input: draftsFlushInputSchema, output: draftsFlushOutputSchema },
  'drafts.flushOne': { input: draftsFlushOneInputSchema, output: draftsFlushOutputSchema },

  'attachments.upload': {
    input: attachmentsUploadInputSchema,
    output: attachmentsUploadOutputSchema,
  },
  'attachments.get': { input: attachmentsGetInputSchema, output: attachmentsGetOutputSchema },
  'attachments.detach': {
    input: attachmentsDetachInputSchema,
    output: attachmentsDetachOutputSchema,
  },

  'runs.cancel': { input: runIdInputSchema, output: runsCancelOutputSchema },
  'runs.retry': { input: runIdInputSchema, output: runsRetryOutputSchema },
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
  'delegations.cancel': { input: delegationIdInputSchema, output: delegationGetOutputSchema },
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

  'projects.list': { input: voidInput, output: projectsListOutputSchema },
  'projects.get': { input: projectsGetInputSchema, output: projectsGetOutputSchema },
  'projects.select': { input: projectsSelectInputSchema, output: projectsSelectOutputSchema },
  'projects.unbind': { input: projectsUnbindInputSchema, output: okOutput },
  'projects.update': { input: projectsUpdateInputSchema, output: projectsGetOutputSchema },
  'projects.remove': { input: projectsRemoveInputSchema, output: okOutput },
  'projects.diff': { input: projectsDiffInputSchema, output: projectsDiffOutputSchema },
  'projects.revert': { input: projectsRevertInputSchema, output: projectsRevertOutputSchema },
  'projects.revokeLease': {
    input: projectsRevokeLeaseInputSchema,
    output: projectsRevokeLeaseOutputSchema,
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

  'memory.list': { input: memoryListInputSchema, output: memoryListOutputSchema },
  'memory.update': { input: memoryUpdateInputSchema, output: memoryListOutputSchema },
  'memory.retract': { input: memoryRetractInputSchema, output: memoryListOutputSchema },

  'profile.list': { input: voidInput, output: profileListOutputSchema },
  'profile.update': { input: profileUpdateInputSchema, output: profileListOutputSchema },
  'profile.retract': { input: profileRetractInputSchema, output: profileListOutputSchema },
  'profile.card': { input: voidInput, output: profileCardOutputSchema },

  'usage.summary': { input: usageSummaryInputSchema, output: usageSummaryOutputSchema },
  'budget.get': { input: voidInput, output: budgetGetOutputSchema },
  'budget.update': { input: budgetUpdateInputSchema, output: budgetGetOutputSchema },

  'embedding.status': { input: voidInput, output: embeddingStatusOutputSchema },
  'embedding.configure': {
    input: embeddingConfigureInputSchema,
    output: embeddingStatusOutputSchema,
  },

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

  'wiki.tree': { input: wikiBotIdInputSchema, output: wikiTreeOutputSchema },
  'wiki.page': { input: wikiPageInputSchema, output: wikiPageOutputSchema },
  'wiki.search': { input: wikiSearchInputSchema, output: wikiSearchOutputSchema },
  'wiki.history': { input: wikiBotIdInputSchema, output: wikiHistoryOutputSchema },
  'wiki.rollback': { input: wikiRollbackInputSchema, output: wikiRollbackOutputSchema },
  'wiki.deletePage': { input: wikiDeletePageInputSchema, output: wikiDeletePageOutputSchema },

  'schedules.list': { input: schedulesListInputSchema, output: schedulesListOutputSchema },
  'schedules.cancel': { input: schedulesCancelInputSchema, output: schedulesCancelOutputSchema },

  // P11: served by the main process (browser-host) on port B — see the
  // PlatformRpcMethods / BrowserRpcMethods types below.
  'browser.ensurePage': {
    input: browserEnsurePageInputSchema,
    output: browserEnsurePageOutputSchema,
  },
  'browser.navigate': { input: browserNavigateInputSchema, output: browserNavigateOutputSchema },
  'browser.snapshot': { input: browserPairInputSchema, output: browserSnapshotOutputSchema },
  'browser.click': { input: browserClickInputSchema, output: okOutput },
  'browser.type': { input: browserTypeInputSchema, output: okOutput },
  'browser.press': { input: browserPressInputSchema, output: okOutput },
  'browser.scroll': { input: browserScrollInputSchema, output: okOutput },
  'browser.screenshot': { input: browserPairInputSchema, output: browserScreenshotOutputSchema },
  'browser.back': { input: browserPairInputSchema, output: okOutput },
  'browser.close': { input: browserCloseInputSchema, output: okOutput },
  'browser.setNetworkContext': {
    input: browserSetNetworkContextInputSchema,
    output: okOutput,
  },
  'browser.clearBotData': { input: browserClearBotDataInputSchema, output: okOutput },
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
};

/** The 12 browser methods the MAIN process serves on port B (P11). */
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
] as const satisfies readonly RpcMethodName[];

const APP_METHODS = [
  'system.ping',
  'system.info',
  'diagnostics.get',
  'settings.get',
  'settings.update',
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
  'butler.ensure',
  'butler.acceptRoute',
  'bots.interview.start',
  'bots.interview.answer',
  'bots.interview.answerPath',
  'conversations.list',
  'conversations.get',
  'conversations.openDirect',
  'conversations.delete',
  'conversations.markRead',
  'conversations.members',
  'groups.create',
  'groups.setup.start',
  'groups.setup.answer',
  'groups.setup.cancel',
  'groups.rename',
  'groups.addMembers',
  'groups.removeMember',
  'groups.redistribute',
  'messages.list',
  'messages.edit',
  'drafts.list',
  'drafts.add',
  'drafts.update',
  'drafts.reorder',
  'drafts.remove',
  'drafts.flush',
  'attachments.upload',
  'attachments.get',
  'attachments.detach',
  'runs.cancel',
  'runs.retry',
  'runs.steps',
  'runs.list',
  'sandbox.status',
  'sandbox.wslStatus',
  'sandbox.wslPrepare',
  'sandbox.wslSkip',
  'approvals.list',
  'approvals.decide',
  'delegations.get',
  'delegations.cancel',
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
  'projects.list',
  'projects.get',
  'projects.select',
  'projects.unbind',
  'projects.update',
  'projects.remove',
  'projects.diff',
  'projects.revert',
  'projects.revokeLease',
  'environment.list',
  'environment.remove',
  'environment.recheck',
  'environment.reinstall',
  'memory.list',
  'memory.update',
  'memory.retract',
  'profile.list',
  'profile.update',
  'profile.retract',
  'profile.card',
  'usage.summary',
  'budget.get',
  'budget.update',
  'embedding.status',
  'embedding.configure',
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
  'schedules.list',
  'schedules.cancel',
] as const satisfies readonly RpcMethodName[];

export const APP_RPC_METHODS: readonly RpcMethodName[] = APP_METHODS;
export const PLATFORM_RPC_METHODS: readonly RpcMethodName[] = [
  'system.shutdown',
  'unattended.disable',
  'power.resume',
  'power.suspend',
  'update.activeRuns',
  'update.cancelActive',
];
