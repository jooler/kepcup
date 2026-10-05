import { z } from 'zod';
import { BACKGROUND_DAILY_BUDGET_DEFAULT } from '../constants.js';
import { vendorIdSchema, vendorProviderSchema, type VendorId } from './vendors.js';

/**
 * Domain types for P01 (docs/design/03-bot.md Profile, docs/design/01-conversation.md
 * message model). Schemas validate RPC boundaries and on-disk JSON columns.
 */

// ---------------------------------------------------------------------------
// Bot profile
// ---------------------------------------------------------------------------

export const botIdentitySchema = z.object({
  // min(1) is enforced at create/update time; deleted placeholder rows keep
  // an empty name with a valid (empty) profile.
  name: z.string().max(50),
  avatar: z.string().optional(),
  bio: z.string().max(500).default(''),
});

export const botPersonaSchema = z.object({
  personality: z.string().max(2000).default(''),
  tone: z.string().max(1000).default(''),
  style: z.string().max(1000).default(''),
  values: z.string().max(1000).default(''),
  sample_dialogues: z.string().max(4000).default(''),
});

export const botRoleSchema = z.object({
  expertise: z.string().max(1000).default(''),
  responsibilities: z.string().max(1000).default(''),
});

/** Sandbox network mode for sandboxed commands (docs/design/10-sandbox.md "网络"). */
export const networkPolicySchema = z.enum(['none', 'allowlist', 'open']);
export type NetworkPolicyMode = z.infer<typeof networkPolicySchema>;

export const botRuntimeSchema = z.object({
  /** Main model ref; empty means "use the settings default". */
  model: z.string().default(''),
  /** Light model ref; empty means "use the settings default". */
  light_model: z.string().default(''),
  /** Network mode of sandboxed commands; intranet/metadata/loopback are always denied. */
  network_policy: networkPolicySchema.default('open'),
  /** Domains reachable in `allowlist` mode (ignored by the other modes). */
  network_allowlist: z.array(z.string().max(255)).default([]),
});

/**
 * Proactive-messaging guardrails (P10, docs/design/03-bot.md "Profile").
 * `quiet_hours` is a [start, end] pair of "HH:MM" wall times in the USER's
 * local time zone; a start later than end crosses midnight, and start == end
 * (the conventional "00:00–00:00") means the whole day is quiet. `null` = off.
 * `max_proactive_per_day` null = the MAX_PROACTIVE_PER_DAY default.
 */
export const botBehaviorSchema = z.object({
  proactive: z.boolean().default(true),
  quiet_hours: z.tuple([z.string(), z.string()]).nullable().default(null),
  max_proactive_per_day: z.number().int().min(0).nullable().default(null),
});
export type BotBehavior = z.infer<typeof botBehaviorSchema>;

export const botProfileSchema = z.object({
  identity: botIdentitySchema.default({
    name: '',
    bio: '',
  }),
  persona: botPersonaSchema.prefault({}),
  role: botRoleSchema.prefault({}),
  boundaries: z.array(z.string().max(500)).default([]),
  runtime: botRuntimeSchema.prefault({}),
  behavior: botBehaviorSchema.prefault({}),
});
export type BotProfile = z.infer<typeof botProfileSchema>;

export const botStatusSchema = z.enum(['active', 'deleted']);
export type BotStatus = z.infer<typeof botStatusSchema>;

export const botSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().nullable(),
  bio: z.string(),
  profile: botProfileSchema,
  status: botStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  /**
   * 对话式新建的初始化状态（UI 改版）：'interviewing' 表示该 Bot 正在通过
   * 问答完善自己的 profile（系统提示注入访谈指引、专属 setup 工具可用）；
   * null/缺省 = 正常运行。旧数据行无此列，反序列化为 undefined。
   */
  setupState: z.literal('interviewing').nullable().optional(),
});
export type Bot = z.infer<typeof botSchema>;

/** Public shape other bots may see (design/03-bot.md "名片"). */
export interface BotCard {
  id: string;
  name: string;
  bio: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Model configuration (docs/design/14-models-and-browser.md)
// ---------------------------------------------------------------------------

/** "provider/modelId" reference; custom providers encode the provider id. */
export const modelRefSchema = z.string().min(1);
export type ModelRef = z.infer<typeof modelRefSchema>;

export const customModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextWindow: z.number().int().positive().max(10_000_000).default(128_000),
  /**
   * Input modalities (P11): models that declare "image" receive browser
   * screenshots as image blocks; absent = text-only (the historical default).
   */
  input: z
    .array(z.enum(['text', 'image']))
    .min(1)
    .optional(),
});
export type CustomModel = z.infer<typeof customModelSchema>;

export const customProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  models: z.array(customModelSchema).min(1),
});
export type CustomProvider = z.infer<typeof customProviderSchema>;

export interface ProviderInfo {
  id: string;
  name: string;
  /** Built-in pi provider, custom OpenAI-compatible endpoint, or 国内厂商. */
  kind: 'builtin' | 'custom' | 'vendor';
  /** Vendor providers: which built-in domestic vendor this entry configures. */
  vendor?: VendorId | undefined;
  baseUrl?: string | undefined;
  /** All registered models are chat models（媒体能力在 capabilityModels 配置）. */
  models: Array<{
    id: string;
    name: string;
    contextWindow: number;
  }>;
  /** Whether an API key is stored. Never the key itself. */
  hasKey: boolean;
}

/** Concurrency limits without a container default (reused by the update patch). */
export const providerConcurrencySchema = z
  .object({ default: z.number().int().min(1).max(16).default(4) })
  .catchall(z.number().int().min(1).max(16));

/**
 * Embedding source configuration (P07, docs/design/14-models-and-browser.md
 * "向量模型"): the built-in local model or the vendor config from
 * `capabilityModels.embedding`（设置页「向量模型」section）.
 * `source` '' = not configured yet (retrieval degrades to full-text search).
 */
export const embeddingConfigSchema = z.object({
  source: z.enum(['', 'local', 'provider']).default(''),
  /** Embedding dimension; null until the first successful embed call. */
  dim: z.number().int().positive().nullable().default(null),
});
export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;

/**
 * 按能力配置的非对话模型（docs/design/16-capability-models.md）：厂商从
 * 已适配该能力的厂商中选择，端点差异由厂商适配器承担；每种能力至多一条
 * 生效配置（null = 未配置）。API key 按厂商共享（provider:{vendorId}）。
 */
export const capabilityModelSchema = z.object({
  vendor: vendorIdSchema,
  model: z.string().min(1).max(200),
});
export type CapabilityModel = z.infer<typeof capabilityModelSchema>;

/** `settings.capabilityModels`：除对话外的全部模型能力，各 section 一条。 */
export const capabilityModelsSchema = z.object({
  embedding: capabilityModelSchema.nullable().default(null),
  rerank: capabilityModelSchema.nullable().default(null),
  multimodal: capabilityModelSchema.nullable().default(null),
  asr: capabilityModelSchema.nullable().default(null),
  tts: capabilityModelSchema.nullable().default(null),
  image: capabilityModelSchema.nullable().default(null),
  video: capabilityModelSchema.nullable().default(null),
});
export type CapabilityModels = z.infer<typeof capabilityModelsSchema>;
/** 能力模型配置的 key（不含 chat）。 */
export type CapabilityModelKey = keyof CapabilityModels;

/**
 * 联网检索供应商（docs/design/21-web-search.md，D62）：key 不进 Settings，
 * 按供应商存密钥表（`websearch:{provider}`）；null = 未配置。
 */
export const webSearchProviderSchema = z.enum(['tavily', 'brave', 'bocha']);
export type WebSearchProviderId = z.infer<typeof webSearchProviderSchema>;
export const webSearchConfigSchema = z.object({
  provider: webSearchProviderSchema.nullable().default(null),
});
export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;

/** Unattended-mode state (docs/design/13-permissions.md "无人值守模式"). */
export const unattendedStateSchema = z.object({
  enabled: z.boolean().default(false),
  /** Epoch ms when the mode turns itself off; null = until switched off manually. */
  until: z.number().nullable().default(null),
  enabledAt: z.number().nullable().default(null),
});
export type UnattendedState = z.infer<typeof unattendedStateSchema>;

/**
 * P13 任务 4: per-step completion flags of the first-run wizard. Steps stay
 * navigable in both directions; only these facts persist.
 */
export const onboardingStateSchema = z.object({
  /** The wizard finished (completed or stepped through) — never shown again. */
  completed: z.boolean().default(false),
  /** The model step ended with a saved key (persisted as a user decision). */
  modelConfigured: z.boolean().default(false),
  /** The model step was skipped — the main window keeps prompting. */
  modelSkipped: z.boolean().default(false),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

/** Partial patch for `settings.update`; missing keys keep their stored value. */
export const onboardingStatePatchSchema = z.object({
  completed: z.boolean().optional(),
  modelConfigured: z.boolean().optional(),
  modelSkipped: z.boolean().optional(),
});
export type OnboardingStatePatch = z.infer<typeof onboardingStatePatchSchema>;

export const settingsSchema = z.object({
  customProviders: z.array(customProviderSchema).default([]),
  /** 国内厂商配置（百炼 / 火山方舟），每家至多一条；只登记对话模型。 */
  vendorProviders: z.array(vendorProviderSchema).default([]),
  /** "provider/modelId" or empty (= not configured yet). */
  defaultMainModel: z.string().default(''),
  defaultLightModel: z.string().default(''),
  /**
   * 非对话模型按能力各配一条（厂商 + 模型），见 16-capability-models.md。
   * 向量来源 source='provider' 时使用 capabilityModels.embedding。
   */
  capabilityModels: capabilityModelsSchema.prefault({}),
  /** Per-provider concurrent model-call limit; `default` covers the rest. */
  providerConcurrency: providerConcurrencySchema.prefault({}),
  /** Unattended-mode state (P03); only `unattended.enable/disable` write it. */
  unattended: unattendedStateSchema.prefault({}),
  /** Embedding (vector) source (P07, settings key `embedding` in 03-data-model). */
  embedding: embeddingConfigSchema.prefault({}),
  /** Per-bot daily background-loop token budget (P07; 0 = unlimited). */
  backgroundBudgetTokens: z.number().int().min(0).default(BACKGROUND_DAILY_BUDGET_DEFAULT),
  /**
   * 联网检索供应商（docs/design/21-web-search.md）：web_search 工具按此路由；
   * key 存密钥表 `websearch:{provider}`，null = 未配置（工具返回结构化
   * setup 需求，见 18-inline-setup）。
   */
  webSearch: webSearchConfigSchema.prefault({}),
  /**
   * Launch at login (P13 任务 3): default ON per docs/dev/phases/P13-release.md.
   * The value lives in core's settings row; the main process applies it to the
   * OS (setLoginItemSettings / XDG autostart) whenever it changes and at
   * platform-port bind (`platform.autostart` event).
   */
  launchAtLogin: z.boolean().default(true),
  /**
   * First-run onboarding state (P13 任务 4), stored in the existing settings
   * row — no new migration. `modelSkipped` drives the persistent "no model
   * configured" prompt on the main window (docs/dev/phases/P13-release.md
   * 任务 4: 可跳过，但无法与 Bot 对话，界面持续提示).
   */
  onboarding: onboardingStateSchema.prefault({}),
});
export type Settings = z.infer<typeof settingsSchema>;

// ---------------------------------------------------------------------------
// Conversation / message / draft / attachment
// ---------------------------------------------------------------------------

export const conversationTypeSchema = z.enum(['direct', 'group']);
export type ConversationType = z.infer<typeof conversationTypeSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  type: conversationTypeSchema,
  title: z.string().nullable(),
  /** 群定位（本群主要处理什么事务，docs/design/19 D60）；单聊为空。 */
  description: z.string().nullable().optional(),
  directBotId: z.string().nullable(),
  /** Currently bound project (P04); null = none. */
  projectId: z.string().nullable(),
  readOnly: z.boolean(),
  /**
   * 对话创建流程状态（docs/design/19 D60）：'creating' = 群创建问答进行中
   * （输入禁用、Bot 不被唤醒）；null/缺省 = 正常。旧数据行无此列。
   */
  setupState: z.literal('creating').nullable().optional(),
  summary: z.string().nullable(),
  summaryUptoSeq: z.number(),
  lastSeq: z.number(),
  lastReadSeq: z.number(),
  lastMessageAt: z.number().nullable(),
  createdAt: z.number(),
  /** Present in list output: the direct bot (single chat). */
  bot: botSchema.nullable().optional(),
  unreadCount: z.number().optional(),
  runningBotIds: z.array(z.string()).optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const messageKindSchema = z.enum(['text', 'system_event', 'card']);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const textContentSchema = z.object({
  text: z.string(),
  /**
   * 初始化问询（bot_setup_question）的用户回答：是一条真实用户消息（照常进
   * 上下文、触发响应 run），但 UI 不渲染它的气泡——回答由问题卡片自己的
   * 已答行展示（参考 Grok）。
   */
  setupAnswer: z.boolean().optional(),
});
export const systemEventContentSchema = z.object({
  event: z.string(),
  text: z.string(),
  /** Bot candidates rendered as clickable actions (e.g. group no-claim prompt). */
  botIds: z.array(z.string()).optional(),
  /** The user batch this event refers to (e.g. re-dispatch after a click). */
  batchId: z.string().nullable().optional(),
  /**
   * Setup-interview question candidates (event = bot_setup_question): rendered
   * as clickable answer rows under the question, plus a free-text custom
   * answer input that the UI always provides.
   */
  options: z.array(z.string()).optional(),
  /**
   * Group-creation question step (event = group_setup_question, docs/design/19
   * D60): which form the card renders — 'title' | 'purpose' | 'members' | 'project'.
   */
  step: z.string().optional(),
  /**
   * Bot 内部事务事件（wiki 入库、环境安装、技能导入、调度触发等，见
   * INTERNAL_SYSTEM_EVENTS）：消息照常落库并进入 Bot 的上下文/触发，但不算
   * 对话内容——用户可见读路径（messages.list、message.created 推送）把它
   * 过滤掉。Bot 怎么执行任务、怎么整理自己的知识库是对话外的事务。
   */
  internal: z.boolean().optional(),
});
/**
 * Card message (P03): the payload itself lives in the approvals table; the
 * message row only links to it so collapsed/updated rendering follows the
 * approval state. P04 adds the run-changes card, which links a run instead.
 */
export const cardContentSchema = z.object({
  cardType: z.string(),
  approvalId: z.string().default(''),
  /** Run-changes cards only: the run the changes belong to. */
  runId: z.string().optional(),
});
export type CardContent = z.infer<typeof cardContentSchema>;
export const messageContentSchema = z.union([
  // system_event first: its shape requires `event`, while a system event's
  // {event, text} would also satisfy textContentSchema (which strips `event`).
  systemEventContentSchema,
  textContentSchema,
  cardContentSchema,
]);
export type MessageContent = z.infer<typeof messageContentSchema>;

export const messageStatusSchema = z.enum(['normal', 'recalled', 'edited']);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const attachmentSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  messageId: z.string().nullable(),
  draftId: z.string().nullable(),
  fileName: z.string(),
  mime: z.string(),
  size: z.number(),
  sha256: z.string(),
  relPath: z.string(),
  createdAt: z.number(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number(),
  senderType: z.enum(['user', 'bot', 'system']),
  senderBotId: z.string().nullable(),
  kind: messageKindSchema,
  content: messageContentSchema,
  replyTo: z.string().nullable(),
  mentions: z.array(z.string()).default([]),
  batchId: z.string().nullable(),
  runId: z.string().nullable(),
  status: messageStatusSchema,
  editedAt: z.number().nullable(),
  createdAt: z.number(),
  attachments: z.array(attachmentSchema).default([]),
});
export type Message = z.infer<typeof messageSchema>;

export const draftSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  position: z.number(),
  text: z.string(),
  mentions: z.array(z.string()).default([]),
  replyTo: z.string().nullable(),
  /**
   * 草稿阶段附件（draft_id 预挂，docs/design/20-conversation-media.md）：
   * flush 时随消息转正；UI 在待发送抽屉里展示并允许移除。
   */
  attachments: z.array(attachmentSchema).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Draft = z.infer<typeof draftSchema>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'waiting_lease',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const triggerReasonSchema = z.enum([
  'direct',
  'mention',
  'broadcast',
  'reply',
  'chain',
  'scheduled',
  'event',
  'background',
]);
export type TriggerReason = z.infer<typeof triggerReasonSchema>;

export const loopTypeSchema = z.enum([
  'response',
  'triage',
  'reflection',
  'memory_consolidation',
  'profile_curation',
  'wiki_maintenance',
  'skill_authoring',
  'conversation_summary',
]);
export type LoopType = z.infer<typeof loopTypeSchema>;

export const runStepTypeSchema = z.enum([
  'request',
  'assistant',
  'tool_call',
  'tool_result',
  'steer',
  'progress',
  'system',
]);
export type RunStepType = z.infer<typeof runStepTypeSchema>;

/**
 * 一个 run（或即将发生的调用）所缺失的用户配置（docs/design/18-inline-setup.md）。
 * `main-model`：Bot 未指定模型且全局没有默认主模型；`capability-model`：
 * settings.capabilityModels 中对应能力的配置缺失（或厂商缺 Key）。
 */
export const setupRequirementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main-model') }),
  z.object({
    kind: z.literal('capability-model'),
    capability: z.enum(['embedding', 'rerank', 'multimodal', 'asr', 'tts', 'image', 'video']),
  }),
  /**
   * 联网检索供应商未配置（docs/design/21-web-search.md）：web_search 工具的
   * SETUP_REQUIRED 携带；设置卡内选供应商 + 填 key + 测试后自动续跑。
   */
  z.object({ kind: z.literal('web-search') }),
]);
export type SetupRequirement = z.infer<typeof setupRequirementSchema>;

export const runSchema = z.object({
  id: z.string(),
  botId: z.string().nullable(),
  conversationId: z.string().nullable(),
  loopType: loopTypeSchema,
  status: runStatusSchema,
  triggerReason: triggerReasonSchema.nullable(),
  triggerMessageIds: z.array(z.string()),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  outputMessageIds: z.array(z.string()),
  summary: z.string().nullable(),
  /** Runs whose process records were replayed into this run's context (Loop 续接); [] when none. */
  continuedFromRunIds: z.array(z.string()),
  error: z.string().nullable(),
  /**
   * 结构化的「设置前置需求」（docs/design/18-inline-setup.md）：run 因缺少
   * 用户配置而失败时携带，界面据此在消息列表内嵌对应的设置卡片；正常
   * 失败为 null。
   */
  setup: setupRequirementSchema.nullable().default(null),
  /** Bot-to-bot @ chain this run belongs to (P05); null outside chains. */
  chainId: z.string().nullable(),
  chainDepth: z.number().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
});
export type Run = z.infer<typeof runSchema>;

export const runStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number(),
  type: runStepTypeSchema,
  payload: z.unknown(),
  createdAt: z.number(),
});
export type RunStep = z.infer<typeof runStepSchema>;

// ---------------------------------------------------------------------------
// Jobs / usage
// ---------------------------------------------------------------------------

export const jobTypeSchema = z.enum([
  'conversation_summary',
  'reflection',
  'memory_consolidation',
  'profile_curation',
  'wiki_ingest',
  'wiki_lint',
  'skill_authoring',
  'schedule_fire',
  // P10 (BR-P10-006): an event response trigger parked until quiet hours end.
  // Persistent so a restart never loses the parked delivery.
  'event_delivery',
  // P07: reflection outputs stored for P09 / P08 to consume (never executed here).
  'wiki_suggestion',
  'skill_suggestion',
  // P07: recompute memory_vec for all bots after the embedding source changed.
  'memory_vec_rebuild',
]);
export type JobType = z.infer<typeof jobTypeSchema>;

export const usageEntrySchema = z.object({
  id: z.string(),
  runId: z.string(),
  botId: z.string().nullable(),
  conversationId: z.string().nullable(),
  loopType: loopTypeSchema,
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number().nullable(),
  createdAt: z.number(),
});
export type UsageEntry = z.infer<typeof usageEntrySchema>;

// ---------------------------------------------------------------------------
// Audit log (P02, docs/dev/03-data-model.md "audit_log")
// ---------------------------------------------------------------------------

export const auditEntrySchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  botId: z.string().nullable(),
  conversationId: z.string().nullable(),
  action: z.string(),
  detail: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

// ---------------------------------------------------------------------------
// Permissions (P03, docs/design/13-permissions.md)
// ---------------------------------------------------------------------------

/** Grant / access-approval scope: write implies read. */
export const grantAccessSchema = z.enum(['read', 'write']);
export type GrantAccess = z.infer<typeof grantAccessSchema>;

export const grantDurationSchema = z.enum(['once', 'conversation']);
export type GrantDuration = z.infer<typeof grantDurationSchema>;

/**
 * Approval kinds. P03 implements `access` / `unsandboxed` / `command`; the
 * later ones arrive with their phases and reuse the same card flow.
 */
export const approvalKindSchema = z.enum([
  'access',
  'unsandboxed',
  'command',
  'git_remote',
  'environment',
  'skill_import',
  'skill_preset',
  'profile_change',
]);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

export const approvalStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'cancelled',
  'failed',
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** Payload of an `access` approval (path authorization request). */
export const accessApprovalPayloadSchema = z.object({
  path: z.string(),
  access: grantAccessSchema,
  /** Why the bot needs it (file tools fill a default wording). */
  reason: z.string().default(''),
  /** Sensitive location — the card shows a prominent warning. */
  sensitive: z.boolean().default(false),
});
export type AccessApprovalPayload = z.infer<typeof accessApprovalPayloadSchema>;

/** Payload of `unsandboxed` and `command` approvals. */
export const commandApprovalPayloadSchema = z.object({
  command: z.string(),
  cwd: z.string().default(''),
  reason: z.string().default(''),
  /** Confirm-mode reason (kind = command only). */
  confirmModeReason: z.string().default(''),
});
export type CommandApprovalPayload = z.infer<typeof commandApprovalPayloadSchema>;

/** Payload of a `git_remote` approval (P04, docs/design/10-sandbox.md "git"). */
export const gitRemoteApprovalPayloadSchema = z.object({
  operation: z.enum(['push', 'pull', 'fetch', 'clone', 'remote_add', 'init']),
  /** Extra CLI arguments, one entry per argument (no shell quoting involved). */
  args: z.array(z.string()).default([]),
  /** Working directory for the command (the project path). */
  cwd: z.string().default(''),
  reason: z.string().default(''),
});
export type GitRemoteApprovalPayload = z.infer<typeof gitRemoteApprovalPayloadSchema>;

/** Payload of an `environment` approval (P06, docs/dev/phases/P06-environment.md). */
export const environmentApprovalPayloadSchema = z.object({
  item: z.string(),
  version: z.string().default(''),
  /** Why the bot needs it (from request_environment). */
  reason: z.string().default(''),
  /** Display name from the catalog, e.g. "Python". */
  displayName: z.string().default(''),
  /** Download size in bytes shown on the card (0 = determined at install time). */
  sizeBytes: z.number().int().min(0).default(0),
  /** Official source description, e.g. the release page URL. */
  source: z.string().default(''),
  /** How the item is obtained: download / via uv / system package. */
  obtain: z.enum(['archive', 'uv-python', 'system']).default('archive'),
  /** kind='system' on Linux: the package-manager command the user runs. */
  systemCommand: z.string().default(''),
});
export type EnvironmentApprovalPayload = z.infer<typeof environmentApprovalPayloadSchema>;

/**
 * Payload of a `profile_change` approval (P07, docs/design/03-bot.md "Bot 可以
 * 提出 Profile 修改建议，以消息形式请用户确认"). Each change is a whitelisted
 * dot-path into the bot profile with its new value.
 */
export const profileChangeApprovalPayloadSchema = z.object({
  changes: z.array(z.object({ field: z.string().min(1), value: z.string() })).min(1),
  reason: z.string().default(''),
});
export type ProfileChangeApprovalPayload = z.infer<typeof profileChangeApprovalPayloadSchema>;

export const approvalDecisionSchema = z.object({
  /** Only meaningful for `access` approvals. */
  duration: grantDurationSchema.optional(),
  /** Set when status = 'failed': why the post-approval action errored (P08). */
  error: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalSchema = z.object({
  id: z.string(),
  kind: approvalKindSchema,
  botId: z.string().nullable(),
  conversationId: z.string().nullable(),
  runId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  status: approvalStatusSchema,
  decision: approvalDecisionSchema.nullable(),
  /** Approved automatically by unattended mode. */
  autoApproved: z.boolean(),
  /** Card message in the conversation. */
  messageId: z.string().nullable(),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;

export const grantSchema = z.object({
  id: z.string(),
  botId: z.string(),
  conversationId: z.string(),
  /** realpath of the granted file or directory. */
  path: z.string(),
  access: grantAccessSchema,
  duration: grantDurationSchema,
  /** duration = once binds the grant to this run. */
  runId: z.string().nullable(),
  approvalId: z.string().nullable(),
  createdAt: z.number(),
  revokedAt: z.number().nullable(),
});
export type Grant = z.infer<typeof grantSchema>;

export const allowlistPlatformSchema = z.enum(['posix', 'windows']);
export type AllowlistPlatform = z.infer<typeof allowlistPlatformSchema>;

export const allowlistEntrySchema = z.object({
  id: z.string(),
  platform: allowlistPlatformSchema,
  /** Command prefix, e.g. "cat" or "git status". */
  pattern: z.string(),
  builtin: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.number(),
});
export type AllowlistEntry = z.infer<typeof allowlistEntrySchema>;

// ---------------------------------------------------------------------------
// Projects (P04, docs/design/08-project.md)
// ---------------------------------------------------------------------------

/**
 * Per-project file protection rules (globs relative to the project root).
 * A pattern without `/` matches any depth by file name (`*.pem`); a pattern
 * with `/` is anchored to the project root (`.git/config`).
 */
export const projectProtectRulesSchema = z.object({
  denyRead: z.array(z.string().max(200)).max(100),
  denyWrite: z.array(z.string().max(200)).max(100),
});
export type ProjectProtectRules = z.infer<typeof projectProtectRulesSchema>;

export const projectStatusSchema = z.enum(['available', 'missing']);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z.object({
  id: z.string(),
  /** realpath of the project directory. */
  path: z.string(),
  name: z.string(),
  protectRules: projectProtectRulesSchema,
  /** Inclusive port ranges the sandbox may reach on localhost; null =不限. */
  allowedPorts: z.array(z.tuple([z.number().int(), z.number().int()])).nullable(),
  status: projectStatusSchema,
  createdAt: z.number(),
  lastUsedAt: z.number(),
});
export type Project = z.infer<typeof projectSchema>;

/** One changed file of a checkpointed run (docs/dev/03-data-model.md "run_changes"). */
export const runChangeFileSchema = z.object({
  path: z.string(),
  change: z.enum(['added', 'modified', 'deleted']),
});
export type RunChangeFile = z.infer<typeof runChangeFileSchema>;

export const runChangeSchema = z.object({
  runId: z.string(),
  projectId: z.string(),
  conversationId: z.string().nullable(),
  beforeOid: z.string(),
  afterOid: z.string().nullable(),
  files: z.array(runChangeFileSchema),
  revertedAt: z.number().nullable(),
  createdAt: z.number(),
});
export type RunChange = z.infer<typeof runChangeSchema>;

// ---------------------------------------------------------------------------
// Host environments (P06, docs/dev/03-data-model.md "env_installs")
// ---------------------------------------------------------------------------

export const envInstallStatusSchema = z.enum(['installing', 'installed', 'failed', 'removed']);
export type EnvInstallStatus = z.infer<typeof envInstallStatusSchema>;

/** One row of env_installs plus what the interface needs to render it. */
export const envInstallSchema = z.object({
  id: z.string(),
  item: z.string(),
  version: z.string(),
  /** Path relative to `~/.kepcup/toolchains/`. */
  relPath: z.string(),
  /** Size on disk in bytes; null while installing / unknown. */
  sizeBytes: z.number().nullable(),
  status: envInstallStatusSchema,
  /** Bot that requested it (record only; installs are shared by all bots). */
  requestedBy: z.string().nullable(),
  approvalId: z.string().nullable(),
  installedAt: z.number().nullable(),
  lastUsedAt: z.number().nullable(),
  /** Absolute bin directories injected into PATH while installed. */
  binDirs: z.array(z.string()).default([]),
  /** Doctor verdict for installed rows: null = not yet checked. */
  healthy: z.boolean().nullable().default(null),
});
export type EnvInstall = z.infer<typeof envInstallSchema>;

/** Live detection of a kind='system' item (macOS/Linux git): no install row. */
export const envSystemStatusSchema = z.object({
  item: z.string(),
  /** Detected on this machine (verify command succeeded). */
  available: z.boolean(),
  /** One-line detail, e.g. "git version 2.39.5" or the install hint. */
  detail: z.string(),
});
export type EnvSystemStatus = z.infer<typeof envSystemStatusSchema>;

/** Progress of a running download/install (environment.progress events). */
export const environmentProgressPayloadSchema = z.object({
  installId: z.string(),
  item: z.string(),
  version: z.string(),
  stage: z.enum(['queued', 'downloading', 'verifying', 'extracting', 'checking', 'done', 'failed']),
  receivedBytes: z.number().optional(),
  totalBytes: z.number().optional(),
  /** Localized failure reason (stage = failed). */
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Memory & user profile (P07, docs/design/04-memory.md)
// ---------------------------------------------------------------------------

export const memoryKindSchema = z.enum([
  'fact',
  'preference',
  'commitment',
  'feedback',
  'episode',
  'lesson',
  'self_note',
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryStatusSchema = z.enum(['active', 'superseded', 'retracted', 'void']);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const memorySourceSchema = z.enum(['explicit', 'inferred']);
export const memorySensitivitySchema = z.enum(['normal', 'sensitive']);
export const memoryOriginSchema = z.enum(['private', 'group']);
export type MemorySource = z.infer<typeof memorySourceSchema>;
export type MemorySensitivity = z.infer<typeof memorySensitivitySchema>;
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;

/** Evidence link: the message(s) / run a memory came from (traceable, retractable). */
export const memoryEvidenceSchema = z.object({
  messageId: z.string().nullable(),
  conversationId: z.string().nullable(),
  runId: z.string().nullable(),
});
export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>;

/** One entry of a bot's private memory (memory_items in memory.db). */
export const memoryItemSchema = z.object({
  id: z.string(),
  /** The bot this memory.db belongs to (owner `bot:{id}`; absent in RPC output). */
  botId: z.string(),
  kind: memoryKindSchema,
  content: z.string(),
  subject: z.string().nullable(),
  source: memorySourceSchema,
  evidence: z.array(memoryEvidenceSchema),
  origin: memoryOriginSchema,
  originConversationId: z.string().nullable(),
  confidence: z.number(),
  sensitivity: memorySensitivitySchema,
  /** 用户说“只告诉你”：never enters the shared profile. */
  privateToBot: z.boolean(),
  dueAt: z.number().nullable(),
  validUntil: z.number().nullable(),
  status: memoryStatusSchema,
  supersedes: z.string().nullable(),
  lastUsedAt: z.number().nullable(),
  useCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;

export const profileCategorySchema = z.enum([
  'basic',
  'communication',
  'work',
  'interests',
  'boundaries',
  'recent',
]);
export type ProfileCategory = z.infer<typeof profileCategorySchema>;

/** One shared user-profile entry (profile_items in main.db; only `normal`). */
export const profileItemSchema = z.object({
  id: z.string(),
  category: profileCategorySchema,
  content: z.string(),
  source: memorySourceSchema,
  evidence: z.array(
    z.object({ messageId: z.string().nullable(), conversationId: z.string().nullable() }),
  ),
  contributedBy: z.string().nullable(),
  confidence: z.number(),
  validUntil: z.number().nullable(),
  status: z.enum(['active', 'superseded', 'retracted']),
  supersedes: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ProfileItem = z.infer<typeof profileItemSchema>;

/** The compiled ~400-token profile card injected into every prompt. */
export const profileCardSchema = z.object({
  content: z.string().nullable(),
  compiledAt: z.number().nullable(),
});
export type ProfileCard = z.infer<typeof profileCardSchema>;

/** One pending/applied proposal of the profile curation loop. */
export const profileProposalSchema = z.object({
  id: z.string(),
  botId: z.string().nullable(),
  op: z.enum(['add', 'retract']),
  targetItemId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'applied', 'rejected']),
  result: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number(),
  processedAt: z.number().nullable(),
});
export type ProfileProposal = z.infer<typeof profileProposalSchema>;

// ---------------------------------------------------------------------------
// Skills (P08, docs/design/05-wiki-and-skills.md "Skills：Bot 的工具")
// ---------------------------------------------------------------------------

/** Origin of one installed skill. */
export const skillKindSchema = z.enum(['builtin', 'imported', 'authored']);
export type SkillKind = z.infer<typeof skillKindSchema>;

/** bot_skills status (docs/dev/03-data-model.md). */
export const botSkillStatusSchema = z.enum(['draft', 'active', 'disabled', 'incompatible']);
export type BotSkillStatus = z.infer<typeof botSkillStatusSchema>;

/** Static-scan compatibility verdict (P08 任务 2). */
export const skillCompatibilitySchema = z.enum(['compatible', 'partial', 'incompatible']);
export type SkillCompatibility = z.infer<typeof skillCompatibilitySchema>;

/** One file of an imported skill, classified by extension / shebang. */
export const skillFileSchema = z.object({
  path: z.string(),
  kind: z.enum([
    'skill-doc',
    'script-python',
    'script-node',
    'script-shell',
    'binary',
    'doc',
    'data',
    'other',
  ]),
  executable: z.boolean(),
});
export type SkillFile = z.infer<typeof skillFileSchema>;

/** Permissions declared in the skill frontmatter (undeclared = none). */
export const skillDeclaredPermissionsSchema = z.object({
  network: z.boolean().default(false),
  credentials: z.boolean().default(false),
  /** Raw declaration entries as written in the frontmatter. */
  notes: z.array(z.string()).default([]),
});
export type SkillDeclaredPermissions = z.infer<typeof skillDeclaredPermissionsSchema>;

/** scan_json of a skill (skill_library.scan_json / authoring validation input). */
export const skillScanSchema = z.object({
  name: z.string(),
  /** Description already truncated to SKILL_DESCRIPTION_MAX_CHARS. */
  description: z.string(),
  files: z.array(skillFileSchema),
  declaredPermissions: skillDeclaredPermissionsSchema,
  /** Inferred runtime dependencies: python / node / bash / git / uv … */
  runtimeDeps: z.array(z.string()),
  compatibility: skillCompatibilitySchema,
  /** Why partial / incompatible (localized, shown on the import card). */
  compatibilityReasons: z.array(z.string()),
  risks: z.array(z.string()),
  /**
   * P12: sandbox requirement from the frontmatter (`sandbox: enhanced`).
   * `enhanced` requires the enhanced sandbox backend (Windows: the private
   * WSL2 distro; macOS: Lima; Linux: rootless Podman). `unsandboxed` is never
   * granted here. Null for skills without the declaration (and pre-P12
   * scan_json rows, via the default).
   */
  sandboxDeclaration: z.enum(['enhanced', 'unsandboxed']).nullable().default(null),
});
export type SkillScan = z.infer<typeof skillScanSchema>;

/**
 * Payload of a `skill_preset` approval (docs/design/22-file-skill-routing.md，
 * D63)：模型请求安装应用内置推荐技能。预置是可信应用内容（发布前经同一静态
 * 扫描），卡片为轻授权——确认即安装为公共技能。
 */
export const skillPresetApprovalPayloadSchema = z.object({
  presetId: z.string(),
  /** 技能注册名（SKILL.md frontmatter name）。 */
  name: z.string(),
  displayName: z.string(),
  summary: z.string(),
  version: z.string(),
  missingDeps: z.array(z.string()).default([]),
});
export type SkillPresetApprovalPayload = z.infer<typeof skillPresetApprovalPayloadSchema>;

/** Payload of a `skill_import` approval (P08). */
export const skillImportApprovalPayloadSchema = z.object({
  sourceUrl: z.string(),
  /** Branch / tag as requested; empty = the remote HEAD. */
  ref: z.string().default(''),
  /** Subdirectory of a multi-skill repository; empty = auto-detected. */
  subdirectory: z.string().default(''),
  commitOid: z.string(),
  name: z.string(),
  /** Description truncated to SKILL_DESCRIPTION_MAX_CHARS. */
  description: z.string(),
  /** Full static-scan result. */
  scan: skillScanSchema,
  /** Runtime deps not installed on this machine (request_environment hints). */
  missingDeps: z.array(z.string()).default([]),
});
export type SkillImportApprovalPayload = z.infer<typeof skillImportApprovalPayloadSchema>;

/** One row of skills.list: bot_skills joined with its resolved metadata. */
export const skillEntrySchema = z.object({
  botId: z.string(),
  name: z.string(),
  kind: skillKindSchema,
  /**
   * 作用域：'public' = 公共技能（技能市场安装，一次安装所有 Bot 可发现调用，
   * 数据在 public_skills）；'private' = 该 Bot 私有（bot_skills 行）。同名时
   * 私有遮蔽公共（该 Bot 的列表与提示词只见私有版本）。
   */
  scope: z.enum(['public', 'private']).default('private'),
  status: botSkillStatusSchema,
  statusReason: z.string().nullable(),
  description: z.string(),
  compatibility: skillCompatibilitySchema.nullable(),
  /** skill_library id (imported only). */
  libraryId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  commitOid: z.string().nullable(),
  /** Library directory relative to the data home (imported only). */
  relPath: z.string().nullable(),
  /** Runtime deps still missing on this machine (recomputed for the UI). */
  missingDeps: z.array(z.string()).default([]),
  /**
   * P12: the skill's frontmatter requires the enhanced sandbox. The verdict
   * in `compatibility` already reflects the current backend availability;
   * when enhanced is missing this is true and `enhancedInstallHint` tells the
   * user how to provide it (安装增强沙箱的提示, P12-B 界面消费).
   */
  enhancedRequired: z.boolean().default(false),
  enhancedInstallHint: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SkillEntry = z.infer<typeof skillEntrySchema>;

/**
 * One row of the skill marketplace (preset catalog shipped with the app).
 * Install state is per bot: `installed` + `upToDate` drive the button
 * (添加 / 已添加 / 更新), `foreign` marks a same-name skill from another
 * source that must not be clobbered (button disabled with a hint).
 */
export const skillPresetInfoSchema = z.object({
  /** Catalog id (skills.presets.install input). */
  id: z.string(),
  /** Registry-level name from the SKILL.md frontmatter. */
  skillName: z.string(),
  displayName: z.string(),
  summary: z.string(),
  /** Lucide icon name resolved by the renderer (fallback on unknown). */
  icon: z.string(),
  /** Scenario pack grouping ('starter' …); titles live in the renderer i18n. */
  section: z.string(),
  version: z.string(),
  tryIt: z.string().default(''),
  /** Runtime deps missing on this machine (e.g. python) → 需环境安装 badge. */
  missingDeps: z.array(z.string()).default([]),
  installed: z.boolean(),
  upToDate: z.boolean(),
  foreign: z.boolean(),
});
export type SkillPresetInfo = z.infer<typeof skillPresetInfoSchema>;

/** A skill directory found inside a cloned repository (multi-skill repos). */
export const skillCandidateSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Path inside the repository, empty for the repository root itself. */
  subdirectory: z.string(),
});
export type SkillCandidate = z.infer<typeof skillCandidateSchema>;

/** One commit of an authored skill (skills.history). */
export const skillHistoryEntrySchema = z.object({
  oid: z.string(),
  message: z.string(),
  createdAt: z.number(),
});
export type SkillHistoryEntry = z.infer<typeof skillHistoryEntrySchema>;

// --- wiki (P09) --------------------------------------------------------------

/** One wiki page in the right-panel page tree (wiki.tree). */
export const wikiPageSchema = z.object({
  /** Path relative to the wiki root, e.g. `pages/go-generics.md`. */
  path: z.string(),
  title: z.string(),
});
export type WikiPage = z.infer<typeof wikiPageSchema>;

/** One full-text hit (wiki.search; FTS5 snippet). */
export const wikiSearchHitSchema = z.object({
  path: z.string(),
  title: z.string(),
  snippet: z.string(),
});
export type WikiSearchHit = z.infer<typeof wikiSearchHitSchema>;

/** One commit of a bot wiki (wiki.history; the message is the log record). */
export const wikiHistoryEntrySchema = z.object({
  oid: z.string(),
  message: z.string(),
  createdAt: z.number(),
});
export type WikiHistoryEntry = z.infer<typeof wikiHistoryEntrySchema>;

// --- schedules (P10) -----------------------------------------------------------

export const scheduleKindSchema = z.enum(['once', 'cron']);
export type ScheduleKind = z.infer<typeof scheduleKindSchema>;

export const scheduleStatusSchema = z.enum(['active', 'done', 'cancelled']);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

/** One row of the schedules table (docs/dev/03-data-model.md "schedules"). */
export const scheduleSchema = z.object({
  id: z.string(),
  botId: z.string(),
  conversationId: z.string(),
  kind: scheduleKindSchema,
  /** once: the fire time (UTC ms). */
  runAt: z.number().nullable(),
  /** cron expression (kind = 'cron'). */
  cron: z.string().nullable(),
  /** IANA time zone the cron expression (and quiet hours) evaluate in. */
  timezone: z.string(),
  note: z.string(),
  /** Commitment (memory.db) this task was created for, if any. */
  commitmentId: z.string().nullable(),
  status: scheduleStatusSchema,
  /** The pending occurrence; null once done/cancelled (or while unschedulable). */
  nextFireAt: z.number().nullable(),
  lastFiredAt: z.number().nullable(),
  createdAt: z.number(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/** schedules.list row: the schedule plus what the interface renders alongside. */
export const scheduleEntrySchema = scheduleSchema.extend({
  botName: z.string().nullable(),
  /**
   * Live guard verdict when the task cannot fire right now although active:
   * "该 Bot 已关闭主动消息" / "免打扰时段…" / "今日主动消息已达上限"; null otherwise.
   */
  deferredReason: z.string().nullable(),
});
export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;

/** Per bot / loop type / local day usage aggregate (usage.summary RPC). */
export const usageSummaryEntrySchema = z.object({
  botId: z.string().nullable(),
  loopType: loopTypeSchema,
  /** Local calendar date (YYYY-MM-DD in the user's timezone). */
  date: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
});
export type UsageSummaryEntry = z.infer<typeof usageSummaryEntrySchema>;

export const usageSummaryOutputSchema = z.object({
  entries: z.array(usageSummaryEntrySchema),
});
export type UsageSummaryOutput = z.infer<typeof usageSummaryOutputSchema>;

/** Per-bot daily background budget (budget.get / budget.update RPC). */
export const budgetSchema = z.object({
  /** Max background tokens per bot per local day; 0 = unlimited. */
  tokens: z.number().int().min(0),
});
export type Budget = z.infer<typeof budgetSchema>;

/** Embedding status for the settings page (embedding.status RPC). */
export const embeddingStatusSchema = z.object({
  source: z.enum(['', 'local', 'provider']),
  provider: z.string(),
  model: z.string(),
  /** The embedder can produce vectors right now. */
  ready: z.boolean(),
  /** Vector dimension; null until first successful embed. */
  dim: z.number().int().positive().nullable(),
  /** Why not ready (localized hint; absent when ready). */
  reason: z.string().optional(),
});
export type EmbeddingStatus = z.infer<typeof embeddingStatusSchema>;
export type EnvironmentProgressPayload = z.infer<typeof environmentProgressPayloadSchema>;
