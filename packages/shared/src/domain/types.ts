import { z } from 'zod';
import { BACKGROUND_DAILY_BUDGET_DEFAULT } from '../constants.js';
import { vendorIdSchema, vendorProviderSchema, type VendorId } from './vendors.js';
import { agentPermissionTierSchema, agentVersionSchema } from './agent-catalog.js';
import { agentSetupReasonSchema } from './agent-status.js';

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
  /**
   * 该 Bot 启用的 MCP server 子集（docs/design/23-mcp-and-subagent.md，D65）：
   * 「应用级 enabled ∩ Bot 选中」才暴露给该 Bot，默认空 = 不启用任何 server。
   */
  mcp_server_ids: z.array(z.string()).default([]),
  /**
   * 浏览器资料（W8，docs/design/14-models-and-browser.md）：'' = 私有（默认，
   * partition `persist:bot-{botId}`）；否则为共享资料 id（settings.browserProfiles，
   * partition `persist:shared-{id}`）。Profile JSON，无迁移；指向已删除资料时按私有处理。
   */
  browser_profile: z.string().default('').catch(''),
  /**
   * 外部智能体引擎（D72，docs/design/28-external-agents-acp.md §3）：`id` 为
   * 空 = 内置 pi 引擎（其余字段忽略）；非空 = 由目录中该 Agent 驱动。D75
   * （docs/design/30-supervisor-and-tasks.md §8.1）起语义为「Bot 的**任务**
   * 引擎」：任务在该 Agent 上执行（每任务一个会话），对话轮固定内置引擎。
   * `model` / `effort` 为空 = Agent 默认；`capabilities` 为 null = 跟随能力包
   * 默认值（host-capabilities.ts `defaultCapabilities`）。Profile JSON，无迁移。
   */
  // Stored profiles must never fail to parse over this block (rowToBot would
  // fall back to an empty profile): every field tolerates unknown values.
  agent: z
    .object({
      id: z.string().default('').catch(''),
      model: z.string().default('').catch(''),
      effort: z.string().default('').catch(''),
      permission: agentPermissionTierSchema.default('workspace').catch('workspace'),
      capabilities: z.array(z.string()).nullable().default(null).catch(null),
    })
    .prefault({})
    .catch({ id: '', model: '', effort: '', permission: 'workspace', capabilities: null }),
});
export type BotAgentRuntime = z.infer<typeof botRuntimeSchema>['agent'];

/** `runtime.agent` 的默认值（内置引擎），供构造完整 Profile 的调用方复用。 */
export const BUILTIN_AGENT_RUNTIME: BotAgentRuntime = {
  id: '',
  model: '',
  effort: '',
  permission: 'workspace',
  capabilities: null,
};

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

/**
 * 系统角色（D70，docs/design/27-butler-and-delegation.md）：目前只有管家
 * 'butler'。DB 列 bots.system_role；与 Profile 内 role.{expertise,
 * responsibilities} 人设字段无关，禁止混用。
 */
export const botSystemRoleSchema = z.enum(['butler']);
export type BotSystemRole = z.infer<typeof botSystemRoleSchema>;

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
  /** 系统角色（D70）：'butler' = 管家（唯一、置顶、不可删）；null/缺省 = 普通 Bot。 */
  systemRole: botSystemRoleSchema.nullable().optional(),
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

/**
 * MCP server 配置（docs/design/23-mcp-and-subagent.md，D65）：存 settings 单行
 * JSON（对齐 webSearch 先例，无需迁移）。敏感值（stdio env、http headers 中的
 * key/token）只存 secrets 表（键 `mcp:{serverId}:env|header:{name}`），本结构
 * 中 env/headers 的值字段写占位符 `secret:<name>`。
 */
/**
 * http = Streamable HTTP（现行规范，端点一般为 /mcp）；sse = 旧版
 * 「HTTP with SSE」握手（GET /sse 开流 + POST messages），大量本地服务仍只支持它。
 */
export const mcpServerTransportSchema = z.enum(['stdio', 'http', 'sse']);
export type McpServerTransport = z.infer<typeof mcpServerTransportSchema>;

export const MCP_SECRET_ENV_PREFIX = 'secret:env:';
export const MCP_SECRET_HEADER_PREFIX = 'secret:header:';

/**
 * MCP 工具风险档（W5，D65 修订；D73 连接应用复用同一分级器，见
 * packages/core/src/mcp/risk.ts）。
 */
export const mcpToolRiskSchema = z.enum(['read', 'write', 'destructive']);
export type McpToolRisk = z.infer<typeof mcpToolRiskSchema>;
/** 风险判定来源：server 注解 / 按工具名推断（含名字一票否决）/ 缺省取严。 */
export const mcpToolRiskSourceSchema = z.enum(['annotation', 'name', 'default']);
export type McpToolRiskSource = z.infer<typeof mcpToolRiskSourceSchema>;
/** 逐工具审批策略：auto = 免审批，ask = 每次确认。 */
export const mcpToolApprovalModeSchema = z.enum(['auto', 'ask']);
export type McpToolApprovalMode = z.infer<typeof mcpToolApprovalModeSchema>;
export const mcpToolPolicySchema = z.object({
  approval: mcpToolApprovalModeSchema.optional(),
  /** 默认 true；false = 不暴露给模型（任务与对话轮都不注册）。 */
  enabled: z.boolean().optional(),
});
export type McpToolPolicy = z.infer<typeof mcpToolPolicySchema>;

export const mcpServerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  transport: mcpServerTransportSchema,
  /** stdio：可执行命令（如 npx / node / python）。 */
  command: z.string().max(2000).optional(),
  /** stdio：命令参数；值可为 `secret:env:<name>` 占位，实际值从 secrets 取。 */
  args: z.array(z.string().max(2000)).optional(),
  /** stdio：环境变量；值可为 `secret:env:<name>` 占位，实际值从 secrets 取。 */
  env: z.record(z.string(), z.string()).optional(),
  /** http / sse：端点 URL（Streamable HTTP 一般 /mcp；SSE 一般 /sse）。 */
  url: z.string().url().optional(),
  /** http：随请求发送的 header；值可为 `secret:header:<name>` 占位。 */
  headers: z.record(z.string(), z.string()).optional(),
  /** 应用级启用开关；关 = 所有 Bot 均不可见（连接与工具注册都跳过）。 */
  enabled: z.boolean().default(false),
  /**
   * 免审批开关（默认关）：开启后该 server 的工具调用不再弹审批卡（W5：等价于
   * 所有工具 approval:'auto'，逐工具 toolPolicies 的 'ask' 可再收回）。
   */
  autoApprove: z.boolean().default(false),
  /**
   * 逐工具策略（W5，D65 修订）：键为 MCP 原始工具名。approval 覆盖默认
   * （默认：只读→auto，写入 / 破坏性→ask；server autoApprove→auto）；
   * enabled:false 则不暴露给模型。按名字存：刷新工具列表后保留，工具消失时
   * 配置保留（设置页标灰）。
   */
  toolPolicies: z.record(z.string(), mcpToolPolicySchema).optional(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

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

/**
 * 本机已启用的外部智能体（D72，§2.2）：键为目录 id。安装与登录态在 P4 落地；
 * P1 只用 `enabled` 判定可用。
 *
 * 存储形态对未知 / 损坏的值一律容错（`.catch`）：settings 单行解析失败会让
 * 整个核心服务起不来（domain/settings.ts），而这些字段会随版本演进。RPC 入参
 * 另用严格的 `agentSettingInputSchema`。
 */
export const agentSettingSchema = z
  .object({
    enabled: z.boolean().default(false).catch(false),
    /**
     * 已安装的目录版本（应用升级后目录版本变化 → update_available）。只由
     * core（AgentsService）写入；非 semver 的值视为未安装。
     */
    installedVersion: agentVersionSchema.optional().catch(undefined),
    /** managed = 应用私有安装；system = 使用用户已装的官方 CLI。 */
    source: z.enum(['managed', 'system']).default('managed').catch('managed'),
    /** 「加载我的个人配置」（默认关，§5）。 */
    loadUserConfig: z.boolean().default(false).catch(false),
  })
  .catch({ enabled: false, source: 'managed', loadUserConfig: false });
export type AgentSetting = z.infer<typeof agentSettingSchema>;

/**
 * `settings.update` 的 agents 值：按 id 与已存值**合并**（不整表覆盖），
 * 只接受用户可直接改的开关；`installedVersion` / `source` 只由 core 的
 * `agents.*`（安装、探测系统 CLI）写入。
 */
export const agentSettingInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    loadUserConfig: z.boolean().optional(),
  })
  .strict();

/** 实验开关（D72 以「实验」开关发布）。 */
export const experimentalSettingsSchema = z
  .object({
    /** 外部智能体引擎：关时 RPC 拒绝把 Bot 设为外部 Agent，目录不可见。 */
    externalAgents: z.boolean().default(false).catch(false),
  })
  .catch({ externalAgents: false });
export type ExperimentalSettings = z.infer<typeof experimentalSettingsSchema>;

/**
 * 后台任务（D72 P6，design 28 §8）：只配了外部 Agent、没有内置模型时，后台
 * loop 是否改用外部 Agent 以及降配项。有内置模型时这些开关不起作用。
 */
export const backgroundTasksSettingsSchema = z
  .object({
    /** 无内置模型时后台任务改用外部 Agent（关 = 跳过，同 P4 兜底）。 */
    agentEnabled: z.boolean().default(true).catch(true),
    /** 只有外部 Agent 时也运行技能生成（最耗额度，默认关）。 */
    agentSkillAuthoring: z.boolean().default(false).catch(false),
    /**
     * 只有外部 Agent 时群聊只在被 @ / 回复时响应（不跑群聊判断）。默认开
     * （审查 C2）：群聊判断经 Agent 只在用户明确关掉此项后运行。
     */
    groupMentionOnly: z.boolean().default(true).catch(true),
  })
  .catch({ agentEnabled: true, agentSkillAuthoring: false, groupMentionOnly: true });
export type BackgroundTasksSettings = z.infer<typeof backgroundTasksSettingsSchema>;

/**
 * 共享浏览器资料（W8）：用户显式建立、多个 Bot 挂同一份 Electron partition
 * （cookie / localStorage / IndexedDB），共用登录状态。只经 `browserProfiles.*` 写入。
 */
export const browserProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
});
export type BrowserProfile = z.infer<typeof browserProfileSchema>;

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
   * MCP server 列表（docs/design/23-mcp-and-subagent.md D65）：整体覆盖 patch；
   * 密钥在 secrets 表，设置 UI 写占位符。默认空 = 未配置任何 server。
   */
  mcpServers: z.array(mcpServerSchema).default([]),
  /** 共享浏览器资料（W8）：只经 `browserProfiles.*` 写入，settings.update 不接受。 */
  browserProfiles: z.array(browserProfileSchema).default([]).catch([]),
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
  /**
   * 外部智能体（D72）：目录 id → 本机启用状态。并发不另设字段，沿用
   * `providerConcurrency['agent:{id}']`（catchall）。
   */
  agents: z.record(z.string(), agentSettingSchema).default({}).catch({}),
  /** 用户自定义 Agent 条目（预留，本期 UI 不开放、运行时不读取）。 */
  // 预留字段的存储形态宽松（条目 schema 由读取方按 agentCatalogEntrySchema
  // 逐条 safeParse），避免未来格式变化让 settings 整体解析失败。
  customAgents: z.array(z.unknown()).default([]).catch([]),
  experimental: experimentalSettingsSchema.prefault({}),
  /**
   * 无内置模型时后台 loop 选用的 Agent（P6）；缺省 / '' = 自动：只用该 Bot
   * 自己的 Agent（不换用别家，审查 S2）；无所属 Bot 的任务（画像整理、群聊
   * 摘要）只在这里明确指定了 Agent 时运行。
   */
  backgroundAgentId: z.string().optional().catch(undefined),
  /** 后台任务（P6）：改用外部 Agent 的开关与降配项。 */
  backgroundTasks: backgroundTasksSettingsSchema.prefault({}),
  /**
   * 新建 Bot 的默认外部 Agent（D72 P4，onboarding「我有订阅」分支写入）：没有
   * 默认主模型时，新建的 Bot（含管家）若未指定模型 / Agent，即以它驱动；
   * '' = 不设。
   */
  defaultAgentId: z.string().default('').catch(''),
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
  /**
   * Present in list output: 该会话最后一条可预览文本消息的原文（左栏单行
   * 预览的数据源）；渲染端按会话打开/消息事件继续维护同一字段。
   */
  lastMessageText: z.string().optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;

// Defined ahead of the Runs section: taskEventContentSchema (below) uses it.
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

/**
 * `task_event`（D75，docs/design/30-supervisor-and-tasks.md §2.4）：Bot 与其
 * 任务之间的私有往返条目（交代 / 追加 / 取消 / 提问 / 结果 / 失败），
 * `owner_bot_id` 归属该 Bot，用户不可见。
 */
export const messageKindSchema = z.enum(['text', 'system_event', 'card', 'task_event']);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const textContentSchema = z.object({
  text: z.string(),
  /**
   * 初始化问询（bot_setup_question）的用户回答：是一条真实用户消息（照常进
   * 上下文、触发响应 run），但 UI 不渲染它的气泡——回答由问题卡片自己的
   * 已答行展示（参考 Grok）。
   */
  setupAnswer: z.boolean().optional(),
  /**
   * 跨 Bot 委派（D71）：A 代用户转交给 B 的「用户代发」消息。照常是一条
   * user 消息（进上下文、触发 B 的响应 run），UI 打「由 A 代你发出」标签；
   * 记忆反思不把它当作用户本人的话。
   */
  /**
   * `task`（D75 §2.4.2）：任务发出的可见中间说明（进度），渲染为「你（任务
   * t_x）」；`taskId` 指向任务 run。
   */
  origin: z.enum(['delegation', 'task']).optional(),
  /** origin = 'delegation' 时对应的委派行。 */
  delegationId: z.string().optional(),
  /** origin = 'delegation' 时代为转交的 Bot（A）的 id：UI 标签与上下文渲染用。 */
  delegatedBy: z.string().optional(),
  /** origin = 'task' 时发出该消息的任务（run id）。 */
  taskId: z.string().optional(),
  /**
   * 定时触发的对话轮发出的消息（D80）：来源定时任务与其标题快照，气泡下方
   * 显示「⏰ 标题」，点开定时任务列表。
   */
  scheduleId: z.string().optional(),
  scheduleTitle: z.string().optional(),
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
   * 任务提问卡（D75 §2.4.6，event = task_question）：用户的回答（点选的选项，
   * 或对话轮经 inject_task 转交的自由文本）；未答时缺省。
   */
  answer: z.string().optional(),
  /**
   * 任务提问卡（event = task_question）：提问任务所属的 Bot。上下文渲染据此把
   * 问题标成「某 Bot 的任务提问」而不是系统消息（问题文字来自任务的模型输出，
   * 不可信，D75 审查 H1）。
   */
  taskBotId: z.string().optional(),
  /**
   * Bot 内部事务事件（wiki 入库、环境安装、技能导入、调度触发等，见
   * INTERNAL_SYSTEM_EVENTS）：消息照常落库并进入 Bot 的上下文/触发，但不算
   * 对话内容——用户可见读路径（messages.list、message.created 推送）把它
   * 过滤掉。Bot 怎么执行任务、怎么整理自己的知识库是对话外的事务。
   */
  internal: z.boolean().optional(),
  /**
   * 管家路由卡（D70，event = route_suggestion）：建议去哪——直聊某个 Bot、
   * 去某个已有群，或由管家转交（delegate，需用户点「交给它处理」确认）。
   */
  route: z
    .object({
      kind: z.enum(['bot', 'group', 'delegate']),
      botId: z.string().optional(),
      conversationId: z.string().optional(),
      /** delegate 时要转交的事（用户确认后管家据此委派）。 */
      task: z.string().optional(),
    })
    .optional(),
  /**
   * 定时任务回执卡（D80，event = schedule_created）：创建时的快照；`status`
   * 随取消 / 完成回写。
   */
  schedule: z
    .object({
      id: z.string(),
      botId: z.string(),
      title: z.string(),
      note: z.string(),
      kind: z.enum(['once', 'cron']),
      runAt: z.number().nullable(),
      cron: z.string().nullable(),
      timezone: z.string(),
      origin: z.enum(['tool', 'offer', 'proposal', 'commitment']),
      status: z.enum(['active', 'done', 'cancelled']),
    })
    .optional(),
  /**
   * 定时提议卡（D80，event = schedule_offer）：Bot 用 offer_schedule 提出的
   * 具体时间；用户点「设置」后宿主确定性创建（scheduleId），点「不用了」记为
   * declined；同一 Bot 的新提议把旧的待定提议标为 superseded。
   */
  offer: z
    .object({
      botId: z.string(),
      title: z.string(),
      note: z.string(),
      when: z.string(),
      timezone: z.string().nullable(),
      question: z.string(),
      status: z.enum(['pending', 'accepted', 'declined', 'superseded', 'expired']),
      scheduleId: z.string().optional(),
      decidedAt: z.number().optional(),
    })
    .optional(),
});
export type SystemEventContent = z.infer<typeof systemEventContentSchema>;
export type ScheduleReceiptSnapshot = NonNullable<SystemEventContent['schedule']>;
export type ScheduleOfferContent = NonNullable<SystemEventContent['offer']>;
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
  /** Delegation cards only (D71, cardType delegation_sent / delegation_result). */
  delegationId: z.string().optional(),
  /**
   * Watch cards only (W7, cardType `watch`): the watch, which moment the card
   * marks (created / alert / paused), the alert sequence, the idempotency key
   * (`watch:{id}:{seq}:{hash}` / `watch-error:{id}:{streak}:paused`) and the
   * alert's page-diff summary (web content: untrusted when shown to a bot).
   */
  watchId: z.string().optional(),
  watchEvent: z.enum(['created', 'alert', 'paused']).optional(),
  watchSeq: z.number().int().optional(),
  watchKey: z.string().optional(),
  watchSummary: z.string().optional(),
  /**
   * Paused cards only: why (`failures` / `too_frequent`) and, for failures,
   * the streak length at the time — the card keeps reading right after a
   * resume reset the live counter.
   */
  watchPauseReason: z.enum(['failures', 'too_frequent']).optional(),
  watchFailures: z.number().int().optional(),
});
export type CardContent = z.infer<typeof cardContentSchema>;

/** task_event 条目的阶段（D75 §2.4.1）；result / failure 是终态条目，每任务至多一条。 */
export const taskEventPhaseSchema = z.enum([
  'brief',
  'inject',
  'cancel',
  'question',
  'result',
  'failure',
]);
export type TaskEventPhase = z.infer<typeof taskEventPhaseSchema>;
/** 终态 phase：受 messages_task_terminal 唯一索引约束（§3.2 幂等写入）。 */
export const TERMINAL_TASK_EVENT_PHASES: ReadonlySet<TaskEventPhase> = new Set([
  'result',
  'failure',
]);

/**
 * task_event 内容（D75 §2.4.1）。`sourceMessageIds` 指向用户原消息（简报 /
 * 追加带原文兜底）；`status` / `error` 用于 failure；`delivery` 用于 inject；
 * `questionMessageId` 用于 question（对应的可见问题卡）；`title` / `writes` /
 * `continuesTaskId` 用于 brief。
 */
export const taskEventContentSchema = z.object({
  taskId: z.string(),
  phase: taskEventPhaseSchema,
  text: z.string(),
  sourceMessageIds: z.array(z.string()).optional(),
  status: runStatusSchema.optional(),
  error: z.string().optional(),
  /** failure 条目：机器可读原因（W3 `permission_revoked`），恢复时随状态补回 runs。 */
  errorReason: z.string().optional(),
  delivery: z.enum(['delivered', 'queued']).optional(),
  questionMessageId: z.string().optional(),
  title: z.string().optional(),
  writes: z.boolean().optional(),
  continuesTaskId: z.string().optional(),
  /**
   * Terminal entries (result / failure): how many times the host handed the
   * entry to the bot (D75 审查 M4, capped by TASK_REDELIVER_MAX_ATTEMPTS).
   */
  deliveries: z.number().int().optional(),
});
export type TaskEventContent = z.infer<typeof taskEventContentSchema>;

export const messageContentSchema = z.union([
  // system_event first: its shape requires `event`, while a system event's
  // {event, text} would also satisfy textContentSchema (which strips `event`).
  systemEventContentSchema,
  // task_event before text for the same reason: {taskId, phase, text} would
  // satisfy textContentSchema and lose taskId/phase. A text message with
  // origin 'task' carries taskId but never phase, so it does not match here.
  taskEventContentSchema,
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
  /**
   * 私有条目的归属 Bot（D75 §2.4.2）：null = 对话共享（全部既有行）；非空 =
   * 仅该 Bot 可见（目前只用于 task_event）。
   */
  ownerBotId: z.string().nullable().default(null),
  /** task_event 所属任务（run id）；其余为 null。 */
  taskId: z.string().nullable().default(null),
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

export const triggerReasonSchema = z.enum([
  'direct',
  'mention',
  'broadcast',
  'reply',
  'chain',
  'scheduled',
  'event',
  'background',
  /** 跨 Bot 委派（D71）：A 代用户转交给 B 的任务。 */
  'delegation',
  /** 任务结算唤醒对话轮（D75 §3.2）：触发批是任务的终态条目。 */
  'task',
  /** 确定性监看（W7，D79）：监看条件边沿触发，触发批是内部事件 watch_alert。 */
  'watch',
]);
export type TriggerReason = z.infer<typeof triggerReasonSchema>;

export const loopTypeSchema = z.enum([
  'triage',
  'reflection',
  'memory_consolidation',
  'profile_curation',
  'wiki_maintenance',
  'skill_authoring',
  'conversation_summary',
  /** 宿主 SubAgent（D66）：delegate_task 委派的嵌套子 run，不产生对话消息。 */
  'subagent',
  /**
   * D75（docs/design/30-supervisor-and-tasks.md）：对话轮（沟通与调度，只读，
   * 秒级，替代原 'response'）与任务（执行，可并行）。
   */
  'turn',
  'task',
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
  /**
   * 外部智能体不可用（D72，design 28 §9.1）：未开实验开关 / 未启用 / 未安装 /
   * 未登录 / 版本不兼容 / 宿主工具桥未启动。设置卡复用设置页 Agent 卡片，
   * 完成后自动重试原 run。
   */
  z.object({
    kind: z.literal('agent'),
    agentId: z.string(),
    reason: agentSetupReasonSchema,
    /** 原因的具体说明（`config_unsafe`：要改的文件与键）。 */
    detail: z.string().optional(),
  }),
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
  /**
   * 机器可读的失败 / 中断原因（error_json.reason）：W3 的 `permission_revoked`
   * （用户撤销授权 → 运行中的任务被中断）、W8 的 `browser_profile_changed`（Bot
   * 的浏览器资料被切换 → 用过浏览器的运行中任务被中断）；其余为 null / 缺省。
   */
  errorReason: z.string().nullable().optional(),
  /** Bot-to-bot @ chain this run belongs to (P05); null outside chains. */
  chainId: z.string().nullable(),
  chainDepth: z.number().nullable(),
  /**
   * Delegating parent run of a SubAgent sub run（D66/D67 ownership，
   * docs/design/24-durable-execution.md journal「subagent: child_run_id +
   * ownership」）；非子 run 为 null。后台子 run 据此在父 run 结束后仍可追溯归属。
   */
  parentRunId: z.string().nullable(),
  /** 执行引擎（D72）：`builtin` | `agent:{id}`。 */
  engine: z.string().default('builtin'),
  /** 外部 Agent 侧的会话 id（ACP `sessionId`）；内置引擎为 null。 */
  agentSessionId: z.string().nullable().default(null),
  /** 任务字段（D75 §3.4，loop_type = 'task'）；非任务 run 为 null。 */
  taskTitle: z.string().nullable().default(null),
  /** 写任务（租约与网关裁决）；非任务为 null。 */
  taskWrites: z.boolean().nullable().default(null),
  /** 解析后的任务工作目录。 */
  taskWorkdir: z.string().nullable().default(null),
  /** 派出该任务的对话轮。 */
  originRunId: z.string().nullable().default(null),
  /** 任务结果被对话轮消费的时间（§3.2）；未消费为 null。 */
  resultConsumedAt: z.number().nullable().default(null),
  /** 任务在 running 下等待用户输入（§2.4.6）。 */
  awaitingInput: z.boolean().default(false),
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

/**
 * 外部副作用台账（W2 / D78，D67 durable journal 的第一步；runs.db
 * `tool_effects`）。状态：`intended`（预留：W4 审批前登记）→ `executing`（执行前
 * 写入）→ `completed` / `failed` / `uncertain`（派发后出错、抛异常、执行中崩溃
 * 被恢复改写）/ `denied`（审批被拒）。只记 effect class 为 external 的调用。
 */
export const effectStatusSchema = z.enum([
  'intended',
  'executing',
  'completed',
  'failed',
  'uncertain',
  'denied',
]);
export type EffectStatus = z.infer<typeof effectStatusSchema>;

/** 工具可选回执（工具结果的 `effect.receipt`；已脱敏）。 */
export const effectReceiptSchema = z.object({
  url: z.string().optional(),
  externalId: z.string().optional(),
  note: z.string().optional(),
});
export type EffectReceipt = z.infer<typeof effectReceiptSchema>;

export const toolEffectSchema = z.object({
  id: z.string(),
  runId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  /** `runId:tool:sha256(stableJson(args))[:16]:occurrence`（键序无关）。 */
  effectKey: z.string(),
  /** sha256(已脱敏的 stableJson(args))，hex。 */
  argsHash: z.string(),
  /** 给人看的「做了什么」：已脱敏、≤200 字。 */
  summary: z.string(),
  /** 本次调用期间最近一次审批（main.approvals.id，跨库无外键）。 */
  approvalId: z.string().nullable(),
  status: effectStatusSchema,
  receipt: effectReceiptSchema.nullable(),
  createdAt: z.number(),
  settledAt: z.number().nullable(),
});
export type ToolEffect = z.infer<typeof toolEffectSchema>;

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
  // D71: a cross-bot delegation parked until the target bot's quiet hours end.
  'delegation_delivery',
  // W7 (D79): a watch alert (dedupe key watch:{id}:{seq}:{hash}) — the card +
  // the bot's wake are posted by the job, so a crash after the edge was
  // committed never loses the alert.
  'watch_alert',
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
  /** MCP 工具调用审批（D65）：server 名 + 工具名 + 参数摘要。 */
  'mcp_tool',
  /** 管家提议（D70）：组队 / 建 Bot / 建群，用户确认后确定性创建。 */
  'butler_proposal',
  /**
   * 外部智能体的工具权限请求（D72 P3，design 28 §6）：ACP
   * `session/request_permission` 经权限桥分级后需要用户确认的部分；子类型
   * `config` 是 project 内 Agent 侧配置文件的首次运行确认。
   */
  'agent_tool',
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
  /**
   * How the item is obtained: download / via uv / system package / npm
   * package (外部智能体 `agent:{id}` 条目的 npx 分发，D72).
   */
  obtain: z.enum(['archive', 'uv-python', 'system', 'npm']).default('archive'),
  /** kind='system' on Linux: the package-manager command the user runs. */
  systemCommand: z.string().default(''),
  /** 外部智能体条目（D72）：许可证（目录 `license`）。 */
  license: z.string().default(''),
  /** 外部智能体条目（D72）：条款提示文案 key（目录 `terms.noticeKey`）。 */
  termsNoticeKey: z.string().default(''),
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

/**
 * Payload of an `mcp_tool` approval（D65）：参数摘要做截断 + 脱敏，完整参数
 * 只进 run_steps 的 tool_call 记录（同样脱敏）。
 */
export const mcpToolApprovalPayloadSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  toolName: z.string(),
  /** 参数摘要（JSON 文本，截断后）。 */
  argsSummary: z.string().default(''),
  /** 调用时解析出的风险档（W5；旧行没有）。卡片据此显示徽标。 */
  risk: mcpToolRiskSchema.optional(),
  /**
   * W4 精确卡片：写入 / 破坏性工具参数里的收件人类字段（to / cc / bcc /
   * recipient(s) / channel / email / phone / user / chat_id …，可在嵌套对象里），
   * 值**完整**列出、不参与 argsSummary 的 400 字截断（已脱敏）。`key` 是参数路径。
   */
  recipients: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});
export type McpToolApprovalPayload = z.infer<typeof mcpToolApprovalPayloadSchema>;

/**
 * Payload of an `agent_tool` approval（D72，design 28 §6）：外部智能体原生工具
 * 的权限请求（读 / 写 / 执行 / 其他），或子类型 `config`（project 内 Agent
 * 侧配置文件的首次运行确认）。`locations` 是已解析的绝对路径；`command` 是
 * 命令原文；`options` 是 Agent 提供的选项（只做展示与审计，宿主只按 Provider
 * 白名单选 allow_once / reject_once）。`durations` 为空或只含 `once` 时卡片
 * 只有「仅这一次」（命令类），路径类可选「本对话内」（记为 access 授权）。
 */
export const agentToolKindSchema = z.enum(['read', 'write', 'execute', 'other', 'config']);
export type AgentToolKind = z.infer<typeof agentToolKindSchema>;

export const agentToolApprovalPayloadSchema = z.object({
  agentId: z.string(),
  /** 目录中的显示名（如「Claude Agent」）。 */
  agentName: z.string().default(''),
  /** Agent 给出的工具标题（自由文本，只展示）。 */
  title: z.string().default(''),
  kind: agentToolKindSchema,
  /** ACP 原始 `toolCall.kind`（read / edit / execute / fetch …）。 */
  toolKind: z.string().default(''),
  /** 读写类：访问方式（授权按它记录）。 */
  access: z.enum(['read', 'write']).optional(),
  locations: z.array(z.string()).default([]),
  command: z.string().optional(),
  cwd: z.string().default(''),
  options: z
    .array(z.object({ optionId: z.string(), name: z.string(), kind: z.string() }))
    .default([]),
  durations: z.array(grantDurationSchema).default(['once']),
  /** 为什么需要确认（越界、每次确认档、无 OS 沙箱……）。 */
  reason: z.string().default(''),
  /** 涉及敏感位置（卡片醒目警示）。 */
  sensitive: z.boolean().default(false),
  /**
   * 数据目录中允许触及的目录（当前 workspace、技能目录）：无人值守底线据此
   * 排除，其余数据目录路径 / 命令一律拒绝。
   */
  exemptDirs: z.array(z.string()).default([]),
  /** 子类型 config：project 路径（记住到对话时按它匹配）。 */
  projectPath: z.string().optional(),
  /** 子类型 config：配置文件内容哈希（内容变化即重新确认）。 */
  configHash: z.string().optional(),
  /**
   * 写入的真实目标可能与显示的路径不同（Codex 只为越出其沙箱的写入发请求，
   * move 目标等可能未出现在请求里）：卡片醒目警示，无人值守一律拒绝。
   */
  targetUncertain: z.boolean().optional(),
});
export type AgentToolApprovalPayload = z.infer<typeof agentToolApprovalPayloadSchema>;

/** One routine of a proposed bot (D80, todo/schedule-nudges.md §3.7). */
export const butlerProposedRoutineSchema = z.object({
  title: z.string(),
  when: z.string(),
  timezone: z.string().nullable().default(null),
  note: z.string(),
});
export type ButlerProposedRoutine = z.infer<typeof butlerProposedRoutineSchema>;

/** One bot a butler proposal suggests (D70); maps onto Profile fields on creation. */
export const butlerProposedBotSchema = z.object({
  name: z.string(),
  bio: z.string().default(''),
  expertise: z.string().default(''),
  responsibilities: z.string().default(''),
  /** Why the user needs it (shown on the card). */
  reason: z.string().default(''),
  /**
   * 例行事项（D80）：确认后建到新 Bot 私聊里的定时任务。`when` 同 schedule
   * 工具（ISO 8601 一次性 / cron 周期）。
   */
  routines: z.array(butlerProposedRoutineSchema).default([]),
});
export type ButlerProposedBot = z.infer<typeof butlerProposedBotSchema>;

/**
 * Payload of a `butler_proposal` approval (D70, docs/design/27): one kind for
 * the three proposal shapes — `team` (BUTLER_TEAM_SIZE_MIN..MAX bots), `bot`
 * (exactly one) and `group` (title / description / existing member bots).
 */
export const butlerProposalPayloadSchema = z.discriminatedUnion('proposalType', [
  z.object({
    proposalType: z.literal('team'),
    bots: z.array(butlerProposedBotSchema),
    note: z.string().default(''),
  }),
  z.object({
    proposalType: z.literal('bot'),
    bots: z.array(butlerProposedBotSchema),
    note: z.string().default(''),
  }),
  z.object({
    proposalType: z.literal('group'),
    title: z.string(),
    description: z.string().default(''),
    memberBotIds: z.array(z.string()),
    reason: z.string().default(''),
  }),
]);
export type ButlerProposalPayload = z.infer<typeof butlerProposalPayloadSchema>;

/**
 * W4（D78）审批回执：审批所属外部调用的台账行（runs.db `tool_effects`，按
 * approval_id 跨库查）的状态 / 回执 / 落定时间。
 */
export const approvalEffectSchema = z.object({
  status: effectStatusSchema,
  receipt: effectReceiptSchema.optional(),
  settledAt: z.number().optional(),
});
export type ApprovalEffect = z.infer<typeof approvalEffectSchema>;

/**
 * W4 去重门：同一任务链里同样的操作上次结果未知（`uncertain`），或非 MCP 的
 * 操作（git_remote、沙箱外命令…）已经执行过（`completed`）时，新卡的 payload
 * 带 `priorEffect`；渲染端在卡片顶部提示「上次同样的操作结果未知，请先确认是否
 * 已生效」/「本任务中已执行过相同操作（回执…），请确认是否需要再次执行」。
 */
export const approvalPriorEffectSchema = z.object({
  status: effectStatusSchema,
  summary: z.string(),
  createdAt: z.number(),
  receipt: effectReceiptSchema.optional(),
});
export type ApprovalPriorEffect = z.infer<typeof approvalPriorEffectSchema>;

export const approvalDecisionSchema = z.object({
  /** Only meaningful for `access` approvals and path-type `agent_tool` ones (D72). */
  duration: grantDurationSchema.optional(),
  /**
   * `butler_proposal` only (D70): indexes into payload.bots the user kept
   * (unchecked items are dropped before creation). Absent = all items.
   */
  selection: z.array(z.number().int().nonnegative()).optional(),
  /**
   * `butler_proposal` only (D80): routines the user kept, as
   * `"{botIndex}:{routineIndex}"`. Absent = every routine of the kept bots.
   */
  routineSelection: z.array(z.string().regex(/^\d+:\d+$/)).optional(),
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
  /**
   * W4：sha256(stableJson(payload))，读取时计算、不落库。渲染端决定时回传它
   * 渲染的值（`approvals.decide.payloadHash`），不符 → APPROVAL_STALE。
   */
  payloadHash: z.string().optional(),
  /** W4：本审批所属工具调用的台账结局（回执）；旧审批 / 非外部调用没有。 */
  effect: approvalEffectSchema.optional(),
});
export type Approval = z.infer<typeof approvalSchema>;

// ---------------------------------------------------------------------------
// Cross-bot delegation (D71, docs/design/27-butler-and-delegation.md)
// ---------------------------------------------------------------------------

/**
 * A2A-style lifecycle: `submitted` (row written, not yet delivered to B —
 * waiting for B's mailbox to be idle / quiet hours to end) → `working`
 * (the proxied user message landed in B's chat — appended in the same main.db
 * transaction that flips the status; the run id is backfilled right after
 * delivery, so a `working` row without one means "crashed mid-delivery:
 * recovery re-delivers the existing message") → terminal.
 */
export const delegationStatusSchema = z.enum([
  'submitted',
  'working',
  /**
   * W6 (DEV-012 方案二): B's delegated turn ended having started tasks
   * (`origin_run_id`); the delegation waits for them (`taskIds`, followed
   * along their continuation chain) and its result is their results.
   */
  'awaiting_tasks',
  'completed',
  'failed',
  'cancelled',
]);
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;

/**
 * What A expects back (W6): `request` — a result (B's turn reply, or the
 * results of the tasks that turn started); `question` — B's turn reply;
 * `fyi` — nothing (settled on delivery, no result card / follow-up).
 */
export const delegationIntentSchema = z.enum(['request', 'question', 'fyi']);
export type DelegationIntent = z.infer<typeof delegationIntentSchema>;

export const delegationSchema = z.object({
  id: z.string(),
  fromBotId: z.string(),
  toBotId: z.string(),
  fromConversationId: z.string(),
  /** B's direct conversation; resolved at delivery time. */
  toConversationId: z.string().nullable(),
  taskText: z.string(),
  status: delegationStatusSchema,
  depth: z.number(),
  /** A's run that called delegate_to_bot. */
  fromRunId: z.string().nullable(),
  /** A-side "已委托" card message. */
  sentMessageId: z.string().nullable(),
  /** B-side proxied user message ("查看原文" anchor of the task). */
  toMessageId: z.string().nullable(),
  /** B's response run (set at delivery). */
  runId: z.string().nullable(),
  /** B's final reply, truncated to DELEGATION_RESULT_MAX_CHARS. */
  resultExcerpt: z.string().nullable(),
  /** B's final reply message ("查看原文" link target). */
  resultMessageId: z.string().nullable(),
  /** A-side result card message. */
  resultCardId: z.string().nullable(),
  errorText: z.string().nullable(),
  /** W6: what A expects back (rows before 0021: 'request'). */
  intent: delegationIntentSchema,
  /** W6: the tasks the delegation follows (`awaiting_tasks`; latest link of each chain). */
  taskIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Delegation = z.infer<typeof delegationSchema>;

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
  /**
   * A run with several lease windows (D75 审查批 E: a force revoke closes
   * one): the snapshot before the run first changed this file / after it
   * last did. Absent = the record's own beforeOid / afterOid (one window).
   */
  beforeOid: z.string().optional(),
  afterOid: z.string().optional(),
  /** Someone else changed the file between two of the run's windows (revert = conflict). */
  interleaved: z.boolean().optional(),
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

/**
 * Where a schedule came from (D80, todo/schedule-nudges.md §3.1): `tool` = the
 * bot called `schedule`; `offer` = the user clicked 设置 on an offer card;
 * `proposal` = a routine of a butler team / bot proposal; `commitment` = the
 * commitment linkage (P10 任务 6).
 */
export const scheduleOriginSchema = z.enum(['tool', 'offer', 'proposal', 'commitment']);
export type ScheduleOrigin = z.infer<typeof scheduleOriginSchema>;

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
  /** User-facing short name (D80); '' on pre-D80 rows (display falls back to the note). */
  title: z.string(),
  origin: scheduleOriginSchema,
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
  /**
   * D72 P5「订阅 / 外部 Agent」：外部智能体（`agent:{id}`）的用量单列——
   * 费用为空、token 常缺失，按轮数计（`turns` = 账本行数 = 模型轮数或
   * 带用量的 prompt 数）。内置模型的条目不带这两个字段。
   */
  agentId: z.string().optional(),
  turns: z.number().int().optional(),
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

// --- D75 W3: task card view (docs/design/30-supervisor-and-tasks.md §4.3 / §6.3) ---

/** Task state as the user sees it: `queued` rows are `submitted` (§3.1). */
export const taskStateSchema = z.enum([
  'submitted',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type TaskStateView = z.infer<typeof taskStateSchema>;

/**
 * Changes a write task left behind (cancel card, §4.3 / §5.2): a project task
 * has a checkpoint (summary + whole-run revert through `projects.revert` with
 * the task id); a workspace task has none — only the files its file tools
 * wrote are listed, and the card says plainly there is no revert.
 */
export const taskChangesSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('project'),
    added: z.number().int(),
    modified: z.number().int(),
    deleted: z.number().int(),
    reverted: z.boolean(),
  }),
  z.object({
    kind: z.literal('workspace'),
    /** Workspace-relative paths written by the task's file tools (capped). */
    files: z.array(z.string()),
    /** Files beyond the cap. */
    more: z.number().int(),
  }),
]);
export type TaskChanges = z.infer<typeof taskChangesSchema>;

/** One `inject_task` line of the card (§4.3), incl. later delivered → queued downgrades. */
export const taskInjectViewSchema = z.object({
  messageId: z.string(),
  text: z.string(),
  delivery: z.enum(['delivered', 'queued']),
  at: z.number(),
});

/** Projection of a task run for its card and the status line (`task.updated`, `tasks.get`). */
export const taskViewSchema = z.object({
  taskId: z.string(),
  botId: z.string().nullable(),
  conversationId: z.string().nullable(),
  title: z.string(),
  state: taskStateSchema,
  status: runStatusSchema,
  writes: z.boolean(),
  /** Where it works: the bound project or the bot's workspace. */
  workdirKind: z.enum(['project', 'workspace']).nullable(),
  /** Why a submitted task waits (等写入租约 / 等并发额度 / 等智能体并发额度 …). */
  queueReason: z.string().nullable(),
  awaitingInput: z.boolean(),
  /** The visible question card the task waits on (§2.4.6), if any. */
  questionMessageId: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
  /** The cancel entry's reason (cancel_task / the user), null when not cancelled that way. */
  cancelReason: z.string().nullable(),
  injects: z.array(taskInjectViewSchema),
  /** Latest visible progress line (clipped). */
  lastProgress: z.string().nullable(),
  changes: taskChangesSchema.nullable(),
  /** Structured setup a failed task needs (D58 §7.5: complete it, then retry). */
  setup: setupRequirementSchema.nullable(),
  /** The task this one continues (`continues_task_id` / a retry). */
  continuesTaskId: z.string().nullable(),
  /** The task that retried / continued this one, if any. */
  continuedByTaskId: z.string().nullable(),
  /** 机器可读的中断原因（Run.errorReason），如 `permission_revoked`（W3）。 */
  errorReason: z.string().nullable().optional(),
  /**
   * W3（D78）：中断的任务沿续接链有外部副作用台账行（已完成 / 结果未知），重试
   * 须先在「检查后重试」面板核实（runs.retry reviewed:true）。与 core 的重试闸门同一判定。
   */
  reviewRequired: z.boolean().optional(),
});
export type TaskView = z.infer<typeof taskViewSchema>;
