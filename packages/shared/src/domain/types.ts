import { z } from 'zod';
import { vendorIdSchema, vendorProviderSchema, type VendorId } from './vendors.js';
import { agentPermissionTierSchema, agentVersionSchema } from './agent-catalog.js';
import { agentSetupReasonSchema } from './agent-status.js';
import { appUiCardSchema } from './apps-ui.js';
import { widgetCardSchema } from './widgets-ui.js';
import { presentCardSchema } from './present.js';
import { askUserFieldSchema, askUserModeSchema } from './ask-user.js';
import { mailProviderSchema } from './mail.js';
import {
  settingCardContentSchema,
  settingCardResolvedSchema,
  settingValuesSchema,
} from '../settings-catalog/cards.js';

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
   * 该 Bot 授权使用的连接应用（D73，docs/design/29-connected-apps.md §6）：目录连接的
   * `connectionId` 列表。**同一 Connector 至多一个连接**（工具名不含账号）；默认空 = 不授权
   * 任何连接。校验在 core 的 bots 领域层（连接存在且属于目录应用），Profile JSON，无迁移。
   */
  app_connection_ids: z.array(z.string()).default([]),
  /**
   * 浏览器资料（W8，docs/design/14-models-and-browser.md）：'' = 私有（默认，
   * partition `persist:bot-{botId}`）；否则为共享资料 id（settings.browserProfiles，
   * partition `persist:shared-{id}`）。Profile JSON，无迁移；指向已删除资料时按私有处理。
   */
  browser_profile: z.string().default('').catch(''),
  /**
   * Legacy（契约 v0.4 起废弃）：曾用 `inkcop-local` 把整轮用户消息 divert 到本机桥。
   * 现恒应为空；关联智能体只走 `inkcop_agent_keys` + `call_inkcop_agent` 工具移交。
   * 读出/写入时 core 会清空残留的 `inkcop-local`。未知值按 ''。
   */
  message_transport: z.enum(['', 'inkcop-local']).default('').catch(''),
  /**
   * InkCop 同机协作：本 Bot 可调用的 InkCop 智能体 key 列表（多选）。
   * 空 = 未关联；非空且扩展中心已启协作时注册 `call_inkcop_agent`（非整轮 divert）。
   */
  inkcop_agent_keys: z.array(z.string().min(1)).default([]).catch([]),
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

/**
 * 画像还是空壳：除了名字（和头像）之外，简介、性格、职责、边界都没写。
 * 项目组里随手建的 Bot 会是这种状态，单聊里要主动问定位，项目组里则按指令慢慢补。
 */
export function isSparseBotProfile(profile: BotProfile): boolean {
  const texts = [
    profile.identity.bio,
    profile.persona.personality,
    profile.persona.tone,
    profile.persona.style,
    profile.persona.values,
    profile.persona.sample_dialogues,
    profile.role.expertise,
    profile.role.responsibilities,
    ...profile.boundaries,
  ];
  return texts.every((text) => text.trim().length === 0);
}

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
  /** D92 T1a: true on the project lead's card inside a project conversation. */
  isLead?: boolean;
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

/** One choice of the bot model dropdown: `{provider}/{model}` ref + display label. */
export interface ChatModelOption {
  ref: string;
  label: string;
}

/**
 * 对话模型的可选项（仅已配置 key 的厂商；无 key 的模型永远不会应答）：Bot 详情的模型
 * 下拉与 D88 移交的可用模型列表同源，都从 `providers.list` 的结果按此推出。
 */
export function chatModelOptions(providers: readonly ProviderInfo[]): ChatModelOption[] {
  const options: ChatModelOption[] = [];
  for (const provider of providers) {
    if (!provider.hasKey) continue;
    for (const model of provider.models) {
      options.push({
        ref: `${provider.id}/${model.id}`,
        label: `${provider.name} · ${model.name}`,
      });
    }
  }
  return options;
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

/**
 * MCP server 认证方式（D73，design 29 §12）：`none` 无认证；`headers` 静态 header
 * （含 `secret:header:` 占位）；`oauth` 走 MCP Authorization（仅 `transport:'http'`）。
 * 缺省值由同级 `headers` 推断，见 `mcpServerSchema` 的对象级 preprocess。
 */
export const mcpServerAuthSchema = z.enum(['none', 'headers', 'oauth']);
export type McpServerAuth = z.infer<typeof mcpServerAuthSchema>;

export const mcpServerSourceSchema = z.object({
  kind: z.literal('mcpb'),
  // Same patterns as the MCPB manifest: these become a directory name under toolchains/mcpb
  // (and get `rm -r`-ed on uninstall), so no separators / dot-dot can ever get in.
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type McpServerSource = z.infer<typeof mcpServerSourceSchema>;

/**
 * MCP server id 的字符集（D91 后续）：字母 / 数字开头，其后字母、数字、`.` `_` `-`，共 1–64 个字符。
 * id 会拼进工具名（`mcp_{id}_{tool}`）、能力 id（`mcp:{id}`）、系统提示的 `<capabilities>` 目录行、
 * `custom:{id}` 连接 id 与 secrets 键，所以在参数校验层就拒绝带 `<` `>`、空白、引号等的值。
 * 生成的 id（`mcp_{时间}` / `mcpb_{hex}` / 预置清单的 `[a-z0-9-]` id）都满足。
 */
export const MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MCP_SERVER_ID_MESSAGE =
  'MCP 服务器 ID 只能包含字母、数字、点、下划线和连字符，以字母或数字开头，最长 64 个字符';

const mcpServerObjectSchema = z.object({
  id: z.string().regex(MCP_SERVER_ID_PATTERN, MCP_SERVER_ID_MESSAGE),
  name: z.string().min(1).max(100),
  /**
   * 用途说明（D91，design 40 §2.3）：用户在扩展中心填的一句话，进系统提示的 `<capabilities>` 目录行
   * （经 oneLine 清洗）。只进提示词，不参与任何权限判断；缺省时目录行写固定的缺省文案。
   */
  description: z.string().max(200).optional(),
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
  /**
   * 认证方式（D73）。缺省 / 非法值按同级 `headers` 推断（有 headers → `headers`，
   * 否则 `none`），所以存量数据无需迁移；`oauth` 仅允许 `transport === 'http'`。
   */
  auth: mcpServerAuthSchema,
  /**
   * 信任分级（设计 29 §11.3）：`developer` = 本机手动添加的未审核来源（如 MCPB 包安装），
   * 所有工具默认每次确认（`destructive` 之外可逐工具放宽）。缺省 = 沿用 W5 默认。
   */
  tier: z.literal('developer').optional(),
  /**
   * 来源（D73 P2 §6.5）：由 MCPB 本地包安装生成的 stdio server 记录包名 / 版本 / 包文件 sha256，
   * 供设置页标注、卸载（清理 `toolchains/mcpb/{name}@{version}/`）与完整性复核使用。
   */
  // A malformed (hand-edited) source is dropped rather than failing the whole settings parse.
  source: mcpServerSourceSchema.optional().catch(undefined),
});

/**
 * 字段级 `.catch()` 看不到兄弟字段，所以 `auth` 的缺省推断放在对象级 preprocess：
 * 输入里没有合法的 `auth` 时，按 `headers` 是否非空推断。
 */
export const mcpServerSchema = z
  .preprocess((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
    const value = raw as Record<string, unknown>;
    if (mcpServerAuthSchema.safeParse(value.auth).success) return raw;
    const headers = value.headers;
    const hasHeaders =
      typeof headers === 'object' &&
      headers !== null &&
      !Array.isArray(headers) &&
      Object.keys(headers).length > 0;
    return { ...value, auth: hasHeaders ? 'headers' : 'none' };
  }, mcpServerObjectSchema)
  .superRefine((server, ctx) => {
    if (server.auth === 'oauth' && server.transport !== 'http') {
      ctx.addIssue({
        code: 'custom',
        path: ['auth'],
        message: 'OAuth is only supported for the http (Streamable HTTP) transport',
      });
    }
  });
export type McpServer = z.infer<typeof mcpServerSchema>;

// --- 连接应用（D73，docs/design/29-connected-apps.md） -------------------------

/** 连接状态机（design 29 §6）。 */
export const appConnectionStatusSchema = z.enum([
  'not_connected',
  'connecting',
  'connected',
  'expired',
  'needs_scope',
  'tools_changed',
  'error',
  'disabled',
]);
export type AppConnectionStatus = z.infer<typeof appConnectionStatusSchema>;

/**
 * 一个应用连接（`app_connections` 一行的对外视图）。**不含任何令牌字段**：令牌
 * 只在 Token Vault / secrets 里，永不出现在 RPC 返回中。
 * 自定义 MCP server 的连接 `id` 与 `connectorId` 同为 `custom:{serverId}`。
 */
export const appConnectionSchema = z.object({
  id: z.string(),
  connectorId: z.string(),
  connectorVer: z.string().nullable(),
  /** 账号显示名（可改）。 */
  label: z.string(),
  /** 账号稳定标识（id_token sub 等），用于去重。 */
  accountSub: z.string().nullable(),
  /** stdio 自定义 server 为 null。 */
  serverUrl: z.string().nullable(),
  /** 授权服务器 issuer。 */
  issuer: z.string().nullable(),
  /** 已授予的 scope（库内以空格分隔存储）。 */
  scopes: z.array(z.string()),
  /** access token 到期时间（epoch ms；非机密元数据）。 */
  tokenExpiresAt: z.number().nullable(),
  status: appConnectionStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().nullable(),
});
export type AppConnection = z.infer<typeof appConnectionSchema>;

/** 连接目标：自定义 MCP server，或目录里的 Connector（P1 起）。 */
export const appConnectTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('custom'), serverId: z.string().min(1) }),
  z.object({ kind: z.literal('catalog'), connectorId: z.string().min(1) }),
]);
export type AppConnectTarget = z.infer<typeof appConnectTargetSchema>;

/** 需要（重新）连接的原因（`setup` 需求与 `AppAuthRequiredError` 共用）。 */
export const appAuthReasonSchema = z.enum(['not_connected', 'expired', 'scope']);
export type AppAuthReason = z.infer<typeof appAuthReasonSchema>;

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
    /**
     * 该智能体的默认模型（设置页「智能体」）。Bot 选择它时自动带上；Bot 自己的
     * `runtime.agent.model` 为空时也回退到这里。'' = 用智能体自己的默认。
     */
    model: z.string().default('').catch(''),
  })
  .catch({ enabled: false, source: 'managed', loadUserConfig: false, model: '' });
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
    /** 默认模型（'' = 智能体自己的默认）。 */
    model: z.string().max(500).optional(),
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
     * 只有外部 Agent 时项目组只在被 @ / 回复时响应（不跑路由判断）。默认开
     * （审查 C2）：路由判断经 Agent 只在用户明确关掉此项后运行。
     */
    projectMentionOnly: z.boolean().default(true).catch(true),
  })
  .catch({ agentEnabled: true, agentSkillAuthoring: false, projectMentionOnly: true });
export type BackgroundTasksSettings = z.infer<typeof backgroundTasksSettingsSchema>;

/**
 * 连接应用（D73）的 core 自有设置（不在 `settings.update` 入参里，渲染端改不了）：
 * `toolLockBaselineDone` = 存量 MCP server 的工具锁定基线已建立（只作用一次，见
 * `core/apps/tool-lock.ts`）。读取容错：损坏的值按未完成处理。
 */
export const appsSettingsSchema = z
  .object({
    toolLockBaselineDone: z.boolean().default(false).catch(false),
    /** 开发者模式（遗留字段）：自定义 MCP / 本机连接已不再门禁；保留写接口以免旧客户端报错。 */
    developerMode: z.boolean().default(false).catch(false),
    /**
     * 污点外发控制（D73 P2，design 29 §8.3）：Bot 读取过连接应用数据后，24 小时内所有外发
     * 通道降级为逐次确认（`egress`）。默认开；设置「高级」里可关。只经 `settings.update` 的
     * `apps.taintGuard` 写。
     */
    taintGuard: z.boolean().default(true).catch(true),
    /**
     * 目录同步（D73 P3 §7.1）：每日拉取签名目录索引并与打包快照合并。默认开；关闭 = 只用
     * 打包快照。只经 `settings.update` 的 `apps.directorySync` 写。
     */
    directorySync: z.boolean().default(true).catch(true),
    /**
     * 本机连接（todo/local-connector-authoring.md）：slug → `LocalConnectorRecord`（core 自有，
     * 只经 `apps.localConnectors.*` 写；`settings.update` 不接受）。值读取时由 core 逐条校验
     * （`domain/local-connectors.ts`），所以这里不收紧类型：一条坏记录只丢弃它自己。
     */
    localConnectors: z.record(z.string(), z.unknown()).default({}).catch({}),
  })
  .catch({
    toolLockBaselineDone: false,
    developerMode: false,
    taintGuard: true,
    directorySync: true,
    localConnectors: {},
  });
export type AppsSettings = z.infer<typeof appsSettingsSchema>;

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

/**
 * InkCop 同机协作（契约 v0.3）：扩展中心「本机应用协作」启停 + API 密钥 + 可选服务地址。
 * 开启后任意 Bot 详情可关联 InkCop 智能体；不预置系统 Bot。
 * `systemBotId` 仅兼容旧配置，读写忽略。
 */
export const inkcopLocalCollabSettingsSchema = z
  .object({
    enabled: z.boolean().default(false).catch(false),
    /** @deprecated 不再使用；保留以免旧 settings 解析失败。 */
    systemBotId: z.string().default('').catch(''),
    /** v0.3：Bearer API 密钥；空则同机探测时回落 endpoint.token。 */
    apiKey: z.string().default('').catch(''),
    /** v0.3：可选服务 baseUrl（局域网/跨机）；空则用 endpoint / 127.0.0.1。 */
    baseUrl: z.string().default('').catch(''),
  })
  .catch({ enabled: false, systemBotId: '', apiKey: '', baseUrl: '' });
export type InkcopLocalCollabSettings = z.infer<typeof inkcopLocalCollabSettingsSchema>;

export const settingsSchema = z.object({
  customProviders: z.array(customProviderSchema).default([]),
  /** 国内厂商配置（百炼 / 火山方舟），每家至多一条；只登记对话模型。 */
  vendorProviders: z.array(vendorProviderSchema).default([]),
  /** "provider/modelId" or empty (= not configured yet). */
  defaultMainModel: z.string().default(''),
  defaultLightModel: z.string().default(''),
  /**
   * D87 P3c「组件审查模型」：组件制作 loop 的独立审查（REVIEW）用哪个内置模型（"provider/modelId"）；
   * '' = 跟随 Bot 主模型。评估者与生成者用不同模型能减少同源盲区。
   */
  widgetReviewModel: z.string().default(''),
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
   * 侧栏「工作台」入口（D90）：默认关闭；设置 → 通用 或定时任务增多时的引导可打开。
   * 关闭时不显示入口与其分隔线。
   */
  workbenchEnabled: z.boolean().default(false),
  /**
   * 用户在「定时任务增多 → 启用工作台？」引导里点了「暂不启用」并确认「知道了」后为 true，
   * 之后不再弹出任一层引导。
   */
  workbenchNudgeDismissed: z.boolean().default(false),
  /**
   * InkCop 同机协作（v0.3）：扩展中心启停 + apiKey + 可选 baseUrl。
   */
  inkcopLocalCollab: inkcopLocalCollabSettingsSchema.prefault({}),
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
   * 自己的 Agent（不换用别家，审查 S2）；无所属 Bot 的任务（画像整理、项目组
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
  /** 连接应用（D73）的 core 自有状态，如工具锁定基线标记。 */
  apps: appsSettingsSchema.prefault({}),
});
export type Settings = z.infer<typeof settingsSchema>;

// ---------------------------------------------------------------------------
// Conversation / message / attachment
// ---------------------------------------------------------------------------

export const conversationTypeSchema = z.enum(['direct', 'project']);
export type ConversationType = z.infer<typeof conversationTypeSchema>;

/**
 * 列表视图里每个项目组最多带几个成员头像预览（`Conversation.memberPreviews`，按入群
 * 顺序取前 N 个）。头像堆叠（ProjectAvatarStack）在 40px 内画不下更多，渲染端
 * 自行拼预览时也应按这个上限截断。
 */
export const PROJECT_MEMBER_PREVIEW_MAX = 9;

export const conversationSchema = z.object({
  id: z.string(),
  type: conversationTypeSchema,
  title: z.string().nullable(),
  /** 项目目标（该项目主要处理什么事务）；单聊恒为空。 */
  goal: z.string().nullable().optional(),
  directBotId: z.string().nullable(),
  /** 项目负责人；project 恒非空，direct 恒为空。 */
  leadBotId: z.string().nullable().optional(),
  /** Currently bound workdir (P04); null = none. */
  workdirId: z.string().nullable(),
  readOnly: z.boolean(),
  /**
   * 归档时间：从对话列表「移除」= 置归档标记（数据、消息、wiki 全留）。
   * 非空 = 该会话不在对话列表里，但仍在通讯录里，可恢复。
   */
  archivedAt: z.number().nullable().optional(),
  summary: z.string().nullable(),
  summaryUptoSeq: z.number(),
  lastSeq: z.number(),
  lastReadSeq: z.number(),
  lastMessageAt: z.number().nullable(),
  createdAt: z.number(),
  /** Present in list output: the direct bot (single chat). */
  bot: botSchema.nullable().optional(),
  /**
   * 项目成员的头像预览（侧栏与顶部药丸堆叠用）。单聊缺省；
   * 只在列表/详情视图上补，不入库；至多 {@link PROJECT_MEMBER_PREVIEW_MAX} 个。
   */
  memberPreviews: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        avatar: z.string().nullable(),
      }),
    )
    .optional(),
  unreadCount: z.number().optional(),
  runningBotIds: z.array(z.string()).optional(),
  /**
   * Present in list output: 该会话最后一条可预览消息的单行文本——文本消息取
   * 原文，卡片消息整理成「icon + 标题 + 摘要」（左栏预览的数据源）；渲染端
   * 按会话打开/消息事件继续维护同一字段。
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
  origin: z.enum(['delegation', 'task', 'widget', 'workbench']).optional(),
  /**
   * origin = 'workbench'（D90）时：工作台代用户派发事项的可见消息，对应的事项与
   * 执行记录。界面渲染成派发卡；记忆反思不把 source='butler' 的派发当用户原话。
   */
  todoId: z.string().optional(),
  todoRunId: z.string().optional(),
  /**
   * origin = 'workbench' 且为 true：这不是派发，而是对「已派发、仍在途」事项的文字更新通知（标题 / 说明变了）。
   * `todoRunId` 是那次在途派发；界面渲染成「事项更新」卡。它不开启新的交付追踪，也不会让执行记录因这一轮失败 / 静默而被结算。
   */
  todoUpdate: z.boolean().optional(),
  /**
   * origin = 'workbench' 且触发这次派发的操作是管家做的（actor = 'butler'）时为 true：派发卡可标「管家代你安排」，
   * 记忆反思不把这条文字当作用户原话（D90 §4.4）。
   */
  viaButler: z.boolean().optional(),
  /**
   * origin = 'workbench' 且事项内容由管家起草或改写过（source = 'butler'）时为 true：说明里可能混入管家读到的
   * 外部内容，执行者上下文按不可信数据包裹（与 viaButler 取并集）；不代表这次派发是管家操作的。
   */
  butlerDrafted: z.boolean().optional(),
  /** origin = 'widget'（D87 P4 L3）时发出它的组件与版本：用户经组件回传、确认后发出的消息。 */
  widgetId: z.string().optional(),
  widgetVersion: z.number().int().optional(),
  /** origin = 'delegation' 时对应的委派行。 */
  delegationId: z.string().optional(),
  /** origin = 'delegation' 时代为转交的 Bot（A）的 id：UI 标签与上下文渲染用。 */
  delegatedBy: z.string().optional(),
  /** origin = 'task' 时发出该消息的任务（run id）。 */
  taskId: z.string().optional(),
  /**
   * origin = 'task' 且为任务自动投送的中间说明（D54 / D75 §6.1）：界面可见，
   * 不进 Bot / 任务的模型上下文（滚动摘要、最近窗口、消息工具、`<tasks>`）。
   * `forward_task_result` 与任务主动 `send_message` 不带此标记。
   */
  interim: z.boolean().optional(),
  /**
   * 定时触发的对话轮发出的消息（D80）：来源定时任务与其标题快照，气泡下方
   * 显示「⏰ 标题」，点开定时任务列表。
   */
  scheduleId: z.string().optional(),
  scheduleTitle: z.string().optional(),
  /**
   * 工作台事项派发引出的对话轮回复（D90 §4.5）：不带 `origin`，但带
   * `todoId` / `todoRunId` 与标题快照，气泡下方显示「📋 标题」，点开工作台该事项。
   */
  todoTitle: z.string().optional(),
});
export const systemEventContentSchema = z.object({
  event: z.string(),
  text: z.string(),
  /**
   * 协作暂停卡（event = episode_paused，D92 T1a）：指向被熔断暂停的回合，
   * 界面上的「继续 / 停止」据此调用 episodes.resume / episodes.stop。
   */
  episodeId: z.string().optional(),
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
   * 任务提问卡（D75 §2.4.6，event = task_question）：用户的回答（点选的选项，
   * 或对话轮经 inject_task 转交的自由文本）；未答时缺省。
   */
  answer: z.string().optional(),
  /** 任务提问卡的模式（D87 P4 L2）：缺省 = single（存量卡）。 */
  questionMode: askUserModeSchema.optional(),
  /** 表单模式的字段（D87 P4 L2）。 */
  questionFields: z.array(askUserFieldSchema).optional(),
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
   * 去某个已有项目组，或由管家转交（delegate，需用户点「交给它处理」确认）。
   */
  route: z
    .object({
      kind: z.enum(['bot', 'project', 'delegate']),
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
      /** Null for a workbench todo assigned to a project (its dispatch @-mentions the lead). */
      botId: z.string().nullable(),
      title: z.string(),
      note: z.string(),
      kind: z.enum(['once', 'cron']),
      runAt: z.number().nullable(),
      cron: z.string().nullable(),
      timezone: z.string(),
      origin: z.enum(['tool', 'offer', 'proposal', 'commitment', 'workbench']),
      /** origin = 'workbench' (D90): the todo the receipt card belongs to. */
      todoId: z.string().optional(),
      status: z.enum(['active', 'done', 'cancelled']),
      /**
       * D88：这条定时任务已移交给另一个 Bot（在对方那边重建，这里随之取消）。卡片显示
       * 「已移交给 {name}」。
       */
      handedOverTo: z.object({ botId: z.string(), name: z.string() }).optional(),
    })
    .optional(),
  /**
   * Bot 资产移交（D88，event = bot_handover 写在接手方 B 的私聊、bot_handed_over 写在
   * 移交方 A 的私聊）：本次移交 / 共享 / 复制的条目（一行一项，宿主生成）与发起方写的交接要点
   * （仅 B 侧；模型输出，上下文里包 `<untrusted>`）。
   */
  handover: z
    .object({
      handoverId: z.string(),
      fromBotId: z.string(),
      fromBotName: z.string(),
      toBotId: z.string(),
      toBotName: z.string(),
      /** 移交（move）与职责改写的条目：此后归接手方。 */
      items: z.array(z.string()),
      /** 共享 / 复制的条目：接手方也有了，移交方仍保留。 */
      kept: z.array(z.string()).default([]),
      note: z.string().default(''),
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
  /**
   * 对话内设置卡（event = setting_card，todo/conversational-app-setup.md §6.1）：Bot 用
   * settings_change 出的卡（含 direct 档的回执卡）；`state` 随用户操作 / 过期 / 被新卡顶替回写，
   * 写回方式同 schedule_offer。
   */
  setting: settingCardContentSchema.optional(),
  /**
   * 设置卡落定后唤醒 Bot 的一次性内部事件（event = setting_card_resolved，§6.2）的结构化部分；
   * 消息本身带 `internal: true`。
   */
  settingResolved: settingCardResolvedSchema.optional(),
});
export type SystemEventContent = z.infer<typeof systemEventContentSchema>;
export type ScheduleReceiptSnapshot = NonNullable<SystemEventContent['schedule']>;
export type ScheduleOfferContent = NonNullable<SystemEventContent['offer']>;
export type HandoverEventContent = NonNullable<SystemEventContent['handover']>;
/**
 * Card message (P03): the payload itself lives in the approvals table; the
 * message row only links to it so collapsed/updated rendering follows the
 * approval state. P04 adds the run-changes card, which links a run instead.
 */
export const cardContentSchema = z.object({
  cardType: z.string(),
  approvalId: z.string().default(''),
  /**
   * Mid-turn permission cards only: an in-session folded record hint (the
   * message itself is in-memory only — see `isApprovalRecordCard`).
   */
  record: z.boolean().optional(),
  /** Run-changes cards only: the run the changes belong to. */
  runId: z.string().optional(),
  /** Delegation cards only (D71, cardType delegation_sent / delegation_result). */
  delegationId: z.string().optional(),
  /**
   * Watch cards only (W7, cardType `watch`): the watch, which moment the card
   * marks (created / alert), the alert sequence, the idempotency key
   * (`watch:{id}:{seq}:{hash}`) and the alert's page-diff summary (web content:
   * untrusted when shown to a bot). Pauses are not cards: see `app.notice`.
   */
  watchId: z.string().optional(),
  watchEvent: z.enum(['created', 'alert']).optional(),
  watchSeq: z.number().int().optional(),
  watchKey: z.string().optional(),
  watchSummary: z.string().optional(),
  /**
   * Mail cards only (D84, cardType `mail`): which account, the IMAP UID and a
   * short summary of the arrived mail. The body stays out of the card; the bot
   * reads it with mail_read. Connection / pause states are not cards: see
   * `app.notice`.
   */
  mailAccountId: z.string().optional(),
  mailEvent: z.enum(['arrived']).optional(),
  mailUid: z.number().int().optional(),
  mailKey: z.string().optional(),
  mailFrom: z.string().optional(),
  mailSubject: z.string().optional(),
  mailDate: z.string().optional(),
  mailSummary: z.string().optional(),
  /** MCP Apps cards only (D73 P3, cardType `mcp_app`): the descriptor; no HTML, no tokens. */
  appUi: appUiCardSchema.optional(),
  /** Bot 自制交互组件卡片（D81，cardType `bot_widget`）：描述符；不含 HTML。 */
  widget: widgetCardSchema.optional(),
  /**
   * 声明式展示卡（D87 P4 L1，cardType `present`）：kind + 标题 + 数据（Bot 自己给的结构化数据，
   * 不是代码；渲染端再按 kind 校验一次）。
   */
  present: presentCardSchema.optional(),
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
 * `continuesTaskId` / `capabilities`（D91）用于 brief。
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
  /** brief 条目：D91 任务声明的外部能力 id（任务卡 / 简报可见；落库在 runs.task_capabilities）。 */
  capabilities: z.array(z.string()).optional(),
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

/**
 * 消息 `mentions` 数组里的 token 约定：Bot 提及用裸 bot id，项目组提及带前缀
 * （项目组不是响应者，只作引用展示——`members.has` 查不到该 token，调度层天然
 * 忽略；AI 文本渲染时经它补「（项目组）」图例）。本地文件/文件夹提及也用前缀
 * token 携带绝对路径：消息正文里是路径，`mentions` 里是结构化引用，不上传文件
 * 字节（AI 需要时用自己的文件工具按路径读取）。
 */
export const PROJECT_MENTION_PREFIX = 'project:';
export const FILE_MENTION_PREFIX = 'file:';
export const FOLDER_MENTION_PREFIX = 'folder:';

export type LocalPathMentionKind = 'file' | 'folder';
export type MentionTokenKind = 'bot' | 'project' | LocalPathMentionKind;

export function projectMentionToken(conversationId: string): string {
  return `${PROJECT_MENTION_PREFIX}${conversationId}`;
}

export function fileMentionToken(path: string): string {
  return `${FILE_MENTION_PREFIX}${path}`;
}

export function folderMentionToken(path: string): string {
  return `${FOLDER_MENTION_PREFIX}${path}`;
}

/** 本地路径提及的反解；不是文件/文件夹 token 时返回 null。 */
export function parseLocalPathMentionToken(
  token: string,
): { kind: LocalPathMentionKind; path: string } | null {
  if (token.startsWith(FILE_MENTION_PREFIX)) {
    return { kind: 'file', path: token.slice(FILE_MENTION_PREFIX.length) };
  }
  if (token.startsWith(FOLDER_MENTION_PREFIX)) {
    return { kind: 'folder', path: token.slice(FOLDER_MENTION_PREFIX.length) };
  }
  return null;
}

export function parseMentionToken(token: string): { kind: MentionTokenKind; id: string } {
  if (token.startsWith(PROJECT_MENTION_PREFIX)) {
    return { kind: 'project', id: token.slice(PROJECT_MENTION_PREFIX.length) };
  }
  const local = parseLocalPathMentionToken(token);
  if (local !== null) return { kind: local.kind, id: local.path };
  return { kind: 'bot', id: token };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const triggerReasonSchema = z.enum([
  'direct',
  'mention',
  'reply',
  /** 项目组里另一个 Bot @ 了你（Bot 可见 @ 的触发，D92 T1a 协作回合）。 */
  'bot_mention',
  /** 上一位回话者 P 续接（D92 T1a 路由）：宿主判断消息在延续 P 的对话 / 工作。 */
  'continuation',
  /** 负责人网关那次轻量调用对应的 triage 类 run 的 trigger_reason（不是投递原因）。 */
  'routing_gate',
  /** 静默路由的首个目标（负责人网关转给成员），必答。 */
  'routed',
  /** 同一次路由的其余目标，可 skip_reply。 */
  'routed_also',
  /** 负责人兜底（网关 self，或路由产生的整轮无回复），必答。 */
  'lead_fallback',
  'scheduled',
  'event',
  'background',
  /** 跨 Bot 委派（D71）：A 代用户转交给 B 的任务。 */
  'delegation',
  /** 任务结算唤醒对话轮（D75 §3.2）：触发批是任务的终态条目。 */
  'task',
  /** 确定性监看（W7，D79）：监看条件边沿触发，触发批是内部事件 watch_alert。 */
  'watch',
  /** 邮件通道（D84）：新信唤醒，触发批是内部事件 mail_alert。 */
  'mail',
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
   * D87 组件制作 loop（docs/design/32-bot-widgets.md §11）：widget_craft 的每个阶段一条
   * 嵌套子 run（parent_run_id = 发起的任务 run），不产生对话消息。
   */
  'widget_authoring',
  /**
   * D75（docs/design/30-supervisor-and-tasks.md）：对话轮（沟通与调度，只读，
   * 秒级，替代原 'response'）与任务（执行，可并行）。
   */
  'turn',
  'task',
  /** 记忆向量化 / 重排的媒体调用（无 run 上下文时的归属，每次调用一行、token 常为 0）。 */
  'memory',
  /** 语音输入转写（用户前台行为）。 */
  'voice_input',
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
 * 本机连接确认卡（`confirm-local-connector` 设置需求的载荷）：全部字段由 core 的探测结果生成，
 * 展示名 / 描述 / 分类 / 文档链接是 Bot 提供但经清洗的文本。`mcpHost` 是卡片上要醒目显示的域名。
 */
export const localConnectorCardSchema = z.object({
  proposalId: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  /** 完整 MCP 地址（探测的就是这个地址）。 */
  mcpUrl: z.string(),
  /** MCP 域名（含端口）：卡片上大字显示。 */
  mcpHost: z.string(),
  /** 文档链接：仅展示，从不自动打开 / 抓取。 */
  docUrl: z.string().optional(),
  authKind: z.literal('oauth'),
  /** 客户端注册方式：`cimd`（KepCup 的 CIMD 文档）或 `dcr`（动态注册）。 */
  registration: z.enum(['cimd', 'dcr']),
  /** 授权服务器域名（含端口）：与 MCP 域名不同站时授权前还会再核对一次完整 URL。 */
  issuerHost: z.string(),
  /**
   * 授权服务器与 MCP 服务**不同站点**（评审 A1）：可能是别家真实的授权服务器被借来给这个地址签发令牌。
   * 界面必须醒目警告并要求勾选确认；`apps.localConnectors.confirm` 须带 `acknowledgeCrossSiteIssuer: true`。
   */
  issuerCrossSite: z.boolean().default(false),
  /** 探测到的将请求的范围（空 = 按服务端提示）。 */
  scopes: z.array(z.string()),
  tier: z.literal('developer'),
  /** core 生成的风险说明（未审核、每次确认、数据只在本机……）。 */
  warnings: z.array(z.string()),
  /** 提案过期时间（毫秒时间戳）；过期后 `confirm` 被拒。 */
  expiresAt: z.number(),
});
export type LocalConnectorCard = z.infer<typeof localConnectorCardSchema>;

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
  /**
   * 需要（重新）连接某个应用（D73，design 29 §5.6）：MCP 工具调用遇到
   * `AppAuthRequiredError` / 模型调用 `app_request_connection` 时携带；设置卡引导
   * 用户走 `apps.connect`，完成后经 `runs.retry` 续跑。P0 只产生 `custom` 目标。
   */
  z.object({
    kind: z.literal('connect-app'),
    target: appConnectTargetSchema,
    connectionId: z.string().optional(),
    /** 需追加的 scope（`reason: 'scope'`）。 */
    scopes: z.array(z.string()).optional(),
    reason: appAuthReasonSchema,
  }),
  /**
   * Bot 提议添加一个本机连接（todo/local-connector-authoring.md）：`app_propose_local_connector`
   * 经 core 探测通过后携带。`card` 的全部字段由 core 的探测结果生成（不是 Bot 原文）；用户在
   * 卡片上点「添加」→ `apps.localConnectors.confirm({ proposalId })`，「取消」→ `…reject`。
   */
  z.object({
    kind: z.literal('confirm-local-connector'),
    proposalId: z.string(),
    card: localConnectorCardSchema,
  }),
  /**
   * 需要添加邮箱并交给当前 Bot（D84 + design 18）：模型调用 `mail_request_setup`
   * 时携带；设置卡内嵌与扩展中心同构的添加表单，测连保存后绑定当前 Bot，再经
   * `runs.retry` 续跑。与「把已有邮箱从另一个 Bot 移交过来」（propose_handover）不同。
   */
  z.object({
    kind: z.literal('mail-account'),
    /** 可选的厂商预填（qq / gmail / …）；用户仍可改选。 */
    provider: mailProviderSchema.optional(),
    /** 给用户看的简短原因。 */
    reason: z.string().optional(),
  }),
  /**
   * 通用设置项（todo/conversational-app-setup.md §6.2）：任务里 `settings_change` 带
   * `required: true` 且需要用户处理时携带；`SetupRequiredCard` 复用 `SettingCard` 按目录条目
   * 分发，完成后经 `runs.retry` 续跑。以后加设置项不再改这个契约（原有 7 个 kind 到 P2 再收拢）。
   */
  z.object({
    kind: z.literal('setting'),
    /** 设置目录条目 id（`SETTING_ITEMS`）。 */
    itemId: z.string(),
    /** Bot 给的非敏感预填值（宿主按 `effectiveMode.acceptValues` 过滤后才写入）。 */
    prefill: settingValuesSchema.optional(),
    /**
     * 出卡时条目的当前值（脱敏快照，与消息流卡片的 `before` 同义）：失败续跑卡的组件靠它定位目标
     * （哪条连接工具、哪个 MCP 服务），并作为条目级 CAS 的 `expected`。user-only 不带 prefill 时也有。
     */
    before: settingValuesSchema.optional(),
    /** 给用户看的一句话原因。 */
    reason: z.string(),
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
  /**
   * 任务最近一条过程状态（单一状态通知，覆盖写）。成功交付后清空；
   * 取消 / 失败 / 中断保留。非任务 run 为 null。
   */
  lastProgress: z.string().nullable().optional(),
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
  /**
   * 用户关掉了这条失败的横幅或设置卡（error_json.dismissed）。执行记录保留，
   * 刷新后不再恢复提示；缺省表示未关闭。
   */
  failureDismissed: z.boolean().optional(),
  /**
   * 协作回合（episode）绑定（D92 T1a）：本 run 属于哪个回合、在该回合的
   * 第几跳（发起 @ 的根 run 为 0，每次 Bot 发起的触发 +1）；回合外的 run 为 null。
   */
  episodeId: z.string().nullable(),
  episodeHop: z.number().nullable(),
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
  taskCwd: z.string().nullable().default(null),
  /**
   * D91：任务声明要挂的外部能力 id（`start_task.capabilities`，如 `app:github` / `mcp:{serverId}`）；
   * 非任务 run 与宿主自己派的任务（未声明）为 null。
   */
  taskCapabilities: z.array(z.string()).nullable().default(null),
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

// ---------------------------------------------------------------------------
// Episodes (D92 T1a collaboration rounds)
// ---------------------------------------------------------------------------

export const episodeStatusSchema = z.enum(['active', 'paused', 'stopped']);
export type EpisodeStatus = z.infer<typeof episodeStatusSchema>;

/**
 * 协作回合（episode，D92 T1a）：一条用户消息批引出的全部 run 的因果树。
 * `hops` 是本回合已放行的 Bot 发起触发数；熔断（总数 / 同对往还超限）后
 * 回合进入 `paused`，未投递的触发记在 `pending_json`，等用户继续或停止。
 */
export const episodeSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  status: episodeStatusSchema,
  /** Bot 发起的触发总数（放行计数，熔断清零后重新累计）。 */
  hops: z.number(),
  pausedAt: z.number().nullable(),
  /** 熔断时未投递的触发条数（resume 时按序投递）。 */
  pendingCount: z.number(),
  createdAt: z.number(),
});
export type Episode = z.infer<typeof episodeSchema>;

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
  // D84：新信唤醒（去重键 mail:{accountId}:{uid}:{botId}）。卡片和对话轮由作业投递。
  'mail_alert',
  // D88 P2：Bot 资产移交的后台阶段（Wiki 页、组件复制；去重键 handover_copy:{handoverId}）。
  'handover_copy',
  // D92 T1b WP10：删除项目 wiki 来源（异步托管动作；去重键
  // wiki_remove_source:{ownerKey}:{sourceId}）。不调用任何模型。
  'wiki_remove_source',
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
 * 审批时长（D73 P1，design 29 §8.1）：`bot` = 对该 Bot 总是允许。只用于
 * `ApprovalDecision.duration` 与 `mcp_tool` / `egress` 的 `payload.durations`；`grants` 表与
 * `agent_tool` 仍用 `grantDurationSchema`（不要直接扩展它）。P0 只定义并导出，
 * 尚未接入审批流程。`command` 仅 `egress` 出现（污点外发，D73 P2 后续）：本对话内
 * **完全相同的命令**（bash 通道）不再逐次确认。
 */
export const approvalDurationSchema = z.enum(['once', 'conversation', 'bot', 'command']);
export type ApprovalDuration = z.infer<typeof approvalDurationSchema>;

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
  /** 管家提议（D70）：组队 / 建 Bot / 建项目组，用户确认后确定性创建。 */
  'butler_proposal',
  /**
   * 外部智能体的工具权限请求（D72 P3，design 28 §6）：ACP
   * `session/request_permission` 经权限桥分级后需要用户确认的部分；子类型
   * `config` 是 workdir 内 Agent 侧配置文件的首次运行确认。
   */
  'agent_tool',
  /**
   * 污点期间的外发确认（D73 P2，design 29 §8.3）：Bot 读取过连接应用数据后，web_fetch /
   * web_search / 浏览器 / 应用与自定义 MCP 写工具 / 沙箱 bash / git 远程 / ACP 网络请求
   * 的逐次确认。时长缺省只有 `once`；`payload.durations` 可再提供 `conversation`
   * （本对话污点窗口内不再确认）与 `command`（仅 bash，相同命令不再确认）。
   */
  'egress',
  /** 邮件发送（D84）：完整收件人与正文，用户确认后才 SMTP 发出。 */
  'mail_send',
  /**
   * Bot 资产移交（D88，docs/design/37）：A 的邮箱 / 应用 / MCP / 模型 / 定时任务与职责交给
   * B（已有或新建），用户逐项勾选后确认，core 确定性执行。
   */
  'bot_handover',
]);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

/**
 * Mid-turn permission popups. The dock above the composer is their only
 * user-facing surface while a decision waits; afterwards (an automatic
 * decision, or an egress / taint-flagged card) the user keeps a one-line
 * folded record **in the current session only**: the message is delivered
 * in memory and never persisted, so it does not reappear after the user
 * switches conversations or restarts the app, and the bot's context never
 * contains it.
 * Skill import, environment install, presets, mail, proposals, profile
 * changes, and handover stay in the transcript — their folded record is the
 * failure / progress surface.
 */
export const EPHEMERAL_APPROVAL_CARD_TYPES = [
  'access',
  'unsandboxed',
  'command',
  'git_remote',
  'mcp_tool',
  'agent_tool',
  'egress',
] as const satisfies readonly ApprovalKind[];

export function isEphemeralApprovalCardType(cardType: string): boolean {
  return (EPHEMERAL_APPROVAL_CARD_TYPES as readonly string[]).includes(cardType);
}

/**
 * Whether a mid-turn permission card stays as a one-line folded record (card
 * content `record: true`, set by the approvals service when the card is
 * created): cards decided automatically (unattended mode — they never reach
 * the dock) and egress / taint-flagged cards (the D73 trail). The record is
 * an in-session hint only: while its approval is pending the popup lives in
 * the dock; after the decision the renderer shows the folded line from the
 * in-memory message. Nothing is persisted and the bot's context excludes it.
 */
export function isApprovalRecordCard(content: { cardType?: unknown; record?: unknown }): boolean {
  return (
    typeof content.cardType === 'string' &&
    isEphemeralApprovalCardType(content.cardType) &&
    content.record === true
  );
}

/** Ephemeral permission card that is not kept as a record: hidden from the transcript. */
export function isHiddenApprovalCard(content: { cardType?: unknown; record?: unknown }): boolean {
  return (
    typeof content.cardType === 'string' &&
    isEphemeralApprovalCardType(content.cardType) &&
    content.record !== true
  );
}

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
  /** D73 P2: raised while the (bot, conversation) is tainted by connected-app data (design 29 §8.3). */
  tainted: z.boolean().optional(),
});
export type CommandApprovalPayload = z.infer<typeof commandApprovalPayloadSchema>;

/** Payload of a `git_remote` approval (P04, docs/design/10-sandbox.md "git"). */
export const gitRemoteApprovalPayloadSchema = z.object({
  operation: z.enum(['push', 'pull', 'fetch', 'clone', 'remote_add', 'init']),
  /** Extra CLI arguments, one entry per argument (no shell quoting involved). */
  args: z.array(z.string()).default([]),
  /** Working directory for the command (the workdir path). */
  cwd: z.string().default(''),
  reason: z.string().default(''),
  /** D73 P2: raised while the (bot, conversation) is tainted by connected-app data (design 29 §8.3). */
  tainted: z.boolean().optional(),
  taintedSince: z.number().optional(),
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
   * 连接应用上下文（D73，design 29 §8.1）：目录连接的工具调用才有。卡片显示
   * 「以 {accountLabel} 身份在 {serverName} 执行 {toolName}」。
   */
  connectionId: z.string().optional(),
  connectorSlug: z.string().optional(),
  accountLabel: z.string().optional(),
  /**
   * 卡片可选的授权时长（缺省 = 只有「仅这一次」）：写入档 `['once','conversation','bot']`，
   * 破坏性档 `['once']`。`decide()` 据此限定 `ApprovalDecision.duration`（`bot` 只有这里
   * 列出才被接受）。
   */
  durations: z.array(approvalDurationSchema).optional(),
  /** 完整参数（脱敏后的 JSON 文本；破坏性档的应用工具与污点期间的外发卡片展示，不截断到摘要长度）。 */
  argsFull: z.string().optional(),
  /** D73 P2：污点期间（读取过应用数据）的外发调用——卡片附加提示、展示完整参数。 */
  tainted: z.boolean().optional(),
  taintedSince: z.number().optional(),
  /**
   * W4 精确卡片：写入 / 破坏性工具参数里的收件人类字段（to / cc / bcc /
   * recipient(s) / channel / email / phone / user / chat_id …，可在嵌套对象里），
   * 值**完整**列出、不参与 argsSummary 的 400 字截断（已脱敏）。`key` 是参数路径。
   */
  recipients: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});
export type McpToolApprovalPayload = z.infer<typeof mcpToolApprovalPayloadSchema>;

/**
 * Payload of an `egress` approval（D73 P2，design 29 §8.3）：污点期间的外发通道确认。
 * `target` 是外发内容全文（URL / 查询词 / 命令 / 工具参数），卡片完整展示，不做摘要截断
 * （只在 `EGRESS_TARGET_MAX_CHARS` 的硬上限处截断）。`summary` 是一行说明（通道 + 工具名等）。
 */
export const egressChannelSchema = z.enum([
  'web_fetch',
  'web_search',
  'browser',
  'app_tool',
  'mcp_tool',
  'bash',
  'git_remote',
  /** 网页监看（`watch_create`）：创建时立即、之后每个间隔都用 Bot 的浏览器资料访问该 URL。 */
  'watch',
]);
export type EgressChannel = z.infer<typeof egressChannelSchema>;

export const egressApprovalPayloadSchema = z.object({
  channel: egressChannelSchema,
  target: z.string(),
  summary: z.string(),
  /** 污点开始时间（毫秒时间戳；卡片显示「自 … 起」）。 */
  taintedSince: z.number().optional(),
  /**
   * 卡片提供的时长选项（缺省 = 只有「仅这一次」）：`conversation` = 本对话的污点窗口内
   * 所有外发不再确认；`command` = 仅 bash 通道，本对话内完全相同的命令不再确认。
   * 有效期都不超过批准时刻的污点窗口（应用数据再次读取后需重新确认）。
   */
  durations: z.array(approvalDurationSchema).optional(),
});
export type EgressApprovalPayload = z.infer<typeof egressApprovalPayloadSchema>;

/**
 * Payload of an `agent_tool` approval（D72，design 28 §6）：外部智能体原生工具
 * 的权限请求（读 / 写 / 执行 / 其他），或子类型 `config`（workdir 内 Agent
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
  /** 子类型 config：workdir 路径（记住到对话时按它匹配）。 */
  workdirPath: z.string().optional(),
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
  /**
   * D88：新 Bot 的对话模型（`runtime.model`）。'' = 跟随设置默认；否则是可用模型列表
   * （与 Bot 详情模型下拉同源，`chatModelOptions`）里的 ref。
   */
  model: z.string().default(''),
});
export type ButlerProposedBot = z.infer<typeof butlerProposedBotSchema>;

/**
 * Payload of a `butler_proposal` approval (D70, docs/design/27): one kind for
 * the three proposal shapes — `bots` (PROPOSE_BOTS_MIN..MAX bots), `bot`
 * (exactly one) and `project` (title / goal / lead bot / existing member bots;
 * D92 T1a WP4: the card carries the lead and the user may change it via
 * `approvals.decide` with `leadBotId`).
 */
export const butlerProposalPayloadSchema = z.discriminatedUnion('proposalType', [
  z.object({
    proposalType: z.literal('bots'),
    bots: z.array(butlerProposedBotSchema),
    note: z.string().default(''),
  }),
  z.object({
    proposalType: z.literal('bot'),
    bots: z.array(butlerProposedBotSchema),
    note: z.string().default(''),
  }),
  z.object({
    proposalType: z.literal('project'),
    title: z.string(),
    goal: z.string().default(''),
    /** The proposed lead; the user's decision may override it (must stay a member). */
    leadBotId: z.string(),
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
  /**
   * Only meaningful for `access` approvals, path-type `agent_tool` ones (D72),
   * `mcp_tool` ones that offered `payload.durations` (D73；`bot` = 对该 Bot 总是允许，
   * 仅 `mcp_tool` 可能出现) and `egress` ones that offered `payload.durations`
   * (`conversation` / `command`，见 `egressApprovalPayloadSchema`)。
   */
  duration: approvalDurationSchema.optional(),
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
  /**
   * `bot_handover` only (D88): item keys the user kept (`payload.items[].key`, plus the
   * reserved `resp:to` / `resp:from` for the responsibilities rewrite). Absent = everything
   * selectable on the card.
   */
  handoverSelection: z.array(z.string()).optional(),
  /**
   * `butler_proposal` with `proposalType: 'project'` only (D92 T1a WP4): the lead the user
   * picked on the card, overriding `payload.leadBotId` (always a payload member).
   */
  leadBotId: z.string().optional(),
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
// Workdirs (P04, docs/design/08-workdir.md)
// ---------------------------------------------------------------------------

/**
 * Per-workdir file protection rules (globs relative to the workdir root).
 * A pattern without `/` matches any depth by file name (`*.pem`); a pattern
 * with `/` is anchored to the workdir root (`.git/config`).
 */
export const workdirProtectRulesSchema = z.object({
  denyRead: z.array(z.string().max(200)).max(100),
  denyWrite: z.array(z.string().max(200)).max(100),
});
export type WorkdirProtectRules = z.infer<typeof workdirProtectRulesSchema>;

export const workdirStatusSchema = z.enum(['available', 'missing']);
export type WorkdirStatus = z.infer<typeof workdirStatusSchema>;

export const workdirSchema = z.object({
  id: z.string(),
  /** realpath of the workdir directory. */
  path: z.string(),
  name: z.string(),
  protectRules: workdirProtectRulesSchema,
  /** Inclusive port ranges the sandbox may reach on localhost; null =不限. */
  allowedPorts: z.array(z.tuple([z.number().int(), z.number().int()])).nullable(),
  status: workdirStatusSchema,
  createdAt: z.number(),
  lastUsedAt: z.number(),
});
export type Workdir = z.infer<typeof workdirSchema>;

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
  workdirId: z.string(),
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
export const memoryOriginSchema = z.enum(['private', 'project']);
export type MemorySource = z.infer<typeof memorySourceSchema>;
export type MemorySensitivity = z.infer<typeof memorySensitivitySchema>;
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;

/**
 * Evidence link: the message(s) / run a memory came from (traceable, retractable).
 * D88 P1 provenance shape: an entry copied from another bot by a handover carries
 * `{handoverId, fromBotId, fromItemId}` (message / conversation / run null) — it is a copy,
 * not something the user said to this bot.
 */
export const memoryEvidenceSchema = z.object({
  messageId: z.string().nullable(),
  conversationId: z.string().nullable(),
  runId: z.string().nullable(),
  handoverId: z.string().optional(),
  fromBotId: z.string().optional(),
  fromItemId: z.string().optional(),
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
export const scheduleOriginSchema = z.enum([
  'tool',
  'offer',
  'proposal',
  'commitment',
  /** D90 工作台事项的排期：到点由 TodoService 派发，不走主动消息护栏。 */
  'workbench',
]);
export type ScheduleOrigin = z.infer<typeof scheduleOriginSchema>;

/** One row of the schedules table (docs/dev/03-data-model.md "schedules"). */
export const scheduleSchema = z.object({
  id: z.string(),
  /**
   * Null only for a workbench todo assigned to a project
   * (D90); every other origin keeps it set (service-level check).
   */
  botId: z.string().nullable(),
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
  /** Workbench todo (D90) this schedule belongs to; null for every other origin. */
  todoId: z.string().nullable(),
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

// --- workbench (D90, docs/design/39-workbench.md) --------------------------------

/** draft → scheduled → in_progress → delivered → done; any open state → cancelled. */
export const todoStatusSchema = z.enum([
  'draft',
  'scheduled',
  'in_progress',
  'delivered',
  'done',
  'cancelled',
]);
export type TodoStatus = z.infer<typeof todoStatusSchema>;

/**
 * Provenance of a todo / memo: the user, or the butler through its tools. For a todo it means
 * "the content was drafted or rewritten by the butler" — created by it, or its title / notes
 * changed by it later — so the executor treats the text as untrusted (`butlerDrafted`).
 */
export const todoSourceSchema = z.enum(['user', 'butler']);
export type TodoSource = z.infer<typeof todoSourceSchema>;

/**
 * Executor of a todo. `bot` = that bot's direct chat; `project` = that project
 * conversation (`leadBotId` = optional override of the lead bot the dispatch
 * message @-mentions; null = the project's own lead — D92 T1a WP4). No
 * assignee at all = unassigned draft (the todo's `assignee` is null).
 */
export const todoAssigneeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bot'), botId: z.string().min(1) }),
  z.object({
    kind: z.literal('project'),
    projectId: z.string().min(1),
    leadBotId: z.string().min(1).nullable(),
  }),
]);
export type TodoAssignee = z.infer<typeof todoAssigneeSchema>;

/** One row of the todos table (docs/dev/03-data-model.md "todos"). */
export const todoSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  assignee: todoAssigneeSchema.nullable(),
  status: todoStatusSchema,
  /** Content provenance (see TodoSource): 'butler' = created by the butler, or its title / notes rewritten by it. */
  source: todoSourceSchema,
  /** Memo this todo was converted from (no FK: memo purge does not touch it). */
  memoId: z.string().nullable(),
  /** Why the todo fell back to draft ("项目里无人回应" / "负责 Bot 已删除"…); display only. */
  blockedReason: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** done / cancelled time. */
  closedAt: z.number().nullable(),
});
export type Todo = z.infer<typeof todoSchema>;

export const todoRunStatusSchema = z.enum(['dispatched', 'delivered', 'unclaimed', 'failed']);
export type TodoRunStatus = z.infer<typeof todoRunStatusSchema>;

/** One dispatch of a todo (one row per fire; a one-off todo normally has one). */
export const todoRunSchema = z.object({
  id: z.string(),
  todoId: z.string(),
  /** The conversation the todo was dispatched into (no FK: readable after it is deleted). */
  conversationId: z.string(),
  /** The visible dispatch message. */
  messageId: z.string().nullable(),
  status: todoRunStatusSchema,
  /** The executor's reply that settled the run as delivered. */
  resultMessageId: z.string().nullable(),
  dispatchedAt: z.number(),
  settledAt: z.number().nullable(),
});
export type TodoRun = z.infer<typeof todoRunSchema>;

/** todos.list / get row: the todo plus what the workbench renders alongside. */
export const todoEntrySchema = todoSchema.extend({
  /** Bot name (bot assignee) or project title (project assignee); null when unassigned / gone. */
  assigneeName: z.string().nullable(),
  /** Name of the lead bot actually in effect (the assignee override, else the project lead). */
  leadBotName: z.string().nullable(),
  /** The active schedule of the todo (time lives only there); null = not scheduled. */
  schedule: z
    .object({
      id: z.string(),
      kind: scheduleKindSchema,
      runAt: z.number().nullable(),
      cron: z.string().nullable(),
      timezone: z.string(),
      nextFireAt: z.number().nullable(),
    })
    .nullable(),
  lastRun: todoRunSchema.nullable(),
});
export type TodoEntry = z.infer<typeof todoEntrySchema>;

/** A flash note (main.db memos). Not bound to any conversation or bot context. */
export const memoSchema = z.object({
  id: z.string(),
  body: z.string(),
  pinned: z.boolean(),
  source: todoSourceSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  /**
   * List sort key: creation time, only refreshed when the pin state changes.
   * Editing the body moves `updatedAt` but not `sortAt`, so the card keeps its
   * place in the workbench list.
   */
  sortAt: z.number(),
  /** Non-null = in 最近删除 (purged after MEMO_TRASH_RETENTION_MS). */
  deletedAt: z.number().nullable(),
});
export type Memo = z.infer<typeof memoSchema>;

/** Per bot / loop type / local day usage aggregate (usage.summary RPC). */
export const usageSummaryEntrySchema = z.object({
  botId: z.string().nullable(),
  loopType: loopTypeSchema,
  /** Local calendar date (YYYY-MM-DD in the user's timezone). */
  date: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
  /** 账本行数（= 调用次数；媒体调用一行一次，token 可能为 0）。 */
  calls: z.number().int().optional(),
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
 * Changes a write task left behind (cancel card, §4.3 / §5.2): a workdir task
 * has a checkpoint (summary + whole-run revert through `workdirs.revert` with
 * the task id); a workspace task has none — only the files its file tools
 * wrote are listed, and the card says plainly there is no revert.
 */
export const taskChangesSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workdir'),
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
  /** Where it works: the bound workdir or the bot's workspace. */
  cwdKind: z.enum(['workdir', 'workspace']).nullable(),
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
  /**
   * Latest task status line (single, overwritten). Cleared when the task
   * completes successfully; kept on cancel / fail / interrupt.
   */
  lastProgress: z.string().nullable(),
  changes: taskChangesSchema.nullable(),
  /** Structured setup a failed task needs (D58 §7.5: complete it, then retry). */
  setup: setupRequirementSchema.nullable(),
  /** The task this one continues (`continues_task_id` / a retry). */
  continuesTaskId: z.string().nullable(),
  /** The task that retried / continued this one, if any. */
  continuedByTaskId: z.string().nullable(),
  /** D91：任务声明挂载的外部能力 id（`start_task.capabilities`）；缺省 = 未声明。 */
  capabilities: z.array(z.string()).optional(),
  /** 机器可读的中断原因（Run.errorReason），如 `permission_revoked`（W3）。 */
  errorReason: z.string().nullable().optional(),
  /**
   * W3（D78）：中断的任务沿续接链有外部副作用台账行（已完成 / 结果未知），重试
   * 须先在「检查后重试」面板核实（runs.retry reviewed:true）。与 core 的重试闸门同一判定。
   */
  reviewRequired: z.boolean().optional(),
});
export type TaskView = z.infer<typeof taskViewSchema>;
