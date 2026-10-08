import { z } from 'zod';
import { agentIdSchema } from './agent-catalog.js';

/**
 * 外部智能体在本机的状态视图（docs/design/28-external-agents-acp.md §2.2，
 * D72）：目录条目（数据）+ 本机安装 / 启用 / 登录态合成，供设置页「智能体」
 * 与 Bot 运行配置的「模型 / 智能体」选择器使用。core `domain/agents.ts`
 * 产出，RPC `agents.*` 与事件 `agent.status` 携带。
 */

/**
 * 状态机：`available`（未启用）→ `installing` → `needs_auth` → `ready`；另有
 * `update_available`（应用升级后目录版本变化）、`incompatible`（本平台无
 * 分发 / 系统 CLI 版本不在范围 / 协议不兼容）、`error`（安装或启动失败）。
 */
export const agentStatusSchema = z.enum([
  'available',
  'installing',
  'needs_auth',
  'ready',
  'update_available',
  'incompatible',
  'error',
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** 本机可用的分发方式（`none` = 本平台无可用分发）。 */
export const agentInstallKindSchema = z.enum(['npx', 'binary', 'system', 'none']);
export type AgentInstallKind = z.infer<typeof agentInstallKindSchema>;

/**
 * 安装确认卡（同环境管理器审批卡的信息：体积、来源、许可、条款提示）。
 * `item` 为环境管理器中的条目名 `agent:{id}`。
 */
export const agentInstallPlanSchema = z.object({
  item: z.string(),
  kind: agentInstallKindSchema,
  version: z.string(),
  /** 约占磁盘（字节）；0 = 未知。 */
  sizeBytes: z.number().int().min(0),
  /** 来源：npm 包名@版本 / 下载地址 / 系统命令。 */
  source: z.string(),
  license: z.string(),
  termsNoticeKey: z.string().nullable(),
  /** 需先由环境管理器准备的前置（如 npx 来源的 `node`）。 */
  prerequisites: z.array(z.string()),
});
export type AgentInstallPlan = z.infer<typeof agentInstallPlanSchema>;

export const agentInstallStageSchema = z.enum([
  'preparing',
  'downloading',
  'verifying',
  'extracting',
  'installing',
  'checking',
]);
export const agentInstallProgressSchema = z.object({
  stage: agentInstallStageSchema,
  receivedBytes: z.number().int().min(0).optional(),
  totalBytes: z.number().int().min(0).optional(),
});
export type AgentInstallProgress = z.infer<typeof agentInstallProgressSchema>;

/** 系统已装官方 CLI 的探测结果（「使用系统已安装的 CLI」）。 */
export const agentSystemCliSchema = z.object({
  found: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  versionRange: z.string().nullable(),
  compatible: z.boolean(),
});
export type AgentSystemCli = z.infer<typeof agentSystemCliSchema>;

/**
 * Agent 声明的登录方式（`initialize.authMethods`，经 Provider 过滤）：
 * `terminal` = 宿主以子进程运行官方登录命令；`agent` = 经 ACP `authenticate`
 * 由 Agent 自行完成（如 Codex 的 ChatGPT 登录）。API key 方式不在此列（见
 * `apiKeyEnv`）。
 */
export const agentAuthMethodViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(['terminal', 'agent']),
});
export type AgentAuthMethodView = z.infer<typeof agentAuthMethodViewSchema>;

/** 进行中 / 最近一次登录（terminal 输出回传给设置页）。 */
export const agentLoginStateSchema = z.object({
  methodId: z.string(),
  running: z.boolean(),
  /** 登录命令的输出（已脱敏、截尾），含厂商给出的授权链接。 */
  output: z.string(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type AgentLoginState = z.infer<typeof agentLoginStateSchema>;

export const agentBotRefSchema = z.object({ id: z.string(), name: z.string() });
export type AgentBotRef = z.infer<typeof agentBotRefSchema>;

export const agentViewSchema = z.object({
  // —— 目录 ——
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  license: z.string(),
  icon: z.string(),
  tier: z.enum(['supported', 'preview']),
  website: z.string().nullable(),
  repository: z.string().nullable(),
  authKinds: z.array(z.string()),
  authNote: z.string(),
  apiKeyEnv: z.string().nullable(),
  termsNoticeKey: z.string().nullable(),
  /** 自带能力 → 原生工具名（能力包默认值与「自带此能力」提示）。 */
  nativeCapabilities: z.record(z.string(), z.array(z.string())),
  // —— 本机 ——
  status: agentStatusSchema,
  /** 状态说明（错误原因、不兼容原因等）；null = 无。 */
  statusDetail: z.string().nullable(),
  enabled: z.boolean(),
  installedVersion: z.string().nullable(),
  source: z.enum(['managed', 'system']),
  loadUserConfig: z.boolean(),
  /** 并发上限（`settings.providerConcurrency['agent:{id}']`，缺省 2）。 */
  concurrency: z.number().int().min(1),
  hasApiKey: z.boolean(),
  install: agentInstallPlanSchema,
  progress: agentInstallProgressSchema.nullable(),
  systemCli: agentSystemCliSchema.nullable(),
  authMethods: z.array(agentAuthMethodViewSchema),
  login: agentLoginStateSchema.nullable(),
  /** 正在使用该 Agent 的 Bot。 */
  usedBy: z.array(agentBotRefSchema),
  /**
   * 正在探测（安装 / 登录 / 换 key 之后重探登录态与选项）：此时的 `ready`
   * 只是登录态未知，对话内设置卡不据此自动续跑。
   */
  probing: z.boolean().default(false),
  /**
   * 不能用于后台任务的原因（审查 S1 / C1：无法关闭原生工具、开启了「加载我的
   * 个人配置」、并发上限不足 2）；null = 可以。
   */
  backgroundBlocker: z.string().nullable().default(null),
});
export type AgentView = z.infer<typeof agentViewSchema>;

/** Agent 会话返回的 config options（类别 `model` / `thought_level`）。 */
export const agentOptionChoiceSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string(),
});
export type AgentOptionChoice = z.infer<typeof agentOptionChoiceSchema>;

export const agentOptionsSchema = z.object({
  models: z.array(agentOptionChoiceSchema),
  efforts: z.array(agentOptionChoiceSchema),
  /** 读取时间（缓存）；null = 尚未读取成功。 */
  fetchedAt: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type AgentOptions = z.infer<typeof agentOptionsSchema>;

export const agentTestResultSchema = z.object({
  ok: z.boolean(),
  /** Agent 对 ping 的回复（截断）。 */
  reply: z.string(),
  elapsedMs: z.number().int().min(0),
  error: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export type AgentTestResult = z.infer<typeof agentTestResultSchema>;

/**
 * 外部 Agent run 因「缺设置」失败的原因（D58 对话内设置卡，design 28 §9.1）：
 * `experimental_off` 实验开关未开；`not_enabled` 未启用；`not_installed` 未安装 /
 * 安装损坏 / 安装中；`auth_required` 未登录；`incompatible` 版本不兼容；
 * `unavailable` 其余可经设置卡重试的不可用（如宿主工具桥未启动）；
 * `sandbox_unavailable` Agent 自身的 OS 沙箱起不来（如 Linux 缺 bubblewrap /
 * socat）——宿主要求沙箱必须生效（不降级为沙箱外执行）；`config_unsafe`
 * Agent 会读取的用户配置放行了需要宿主确认的操作（文件与键见 setup 的
 * `detail`），改配置后重试即可，无需重装。
 */
export const agentSetupReasonSchema = z.enum([
  'experimental_off',
  'not_enabled',
  'not_installed',
  'auth_required',
  'incompatible',
  'unavailable',
  'sandbox_unavailable',
  'config_unsafe',
]);
export type AgentSetupReason = z.infer<typeof agentSetupReasonSchema>;

/**
 * 由本机状态视图判定「发消息前就知道跑不起来」的原因；null = 可以开跑（含
 * `ready` / `update_available`，以及登录态未知——交给 run 的结构化失败兜底）。
 * core 的 run 门禁与渲染端的发送门禁共用这一份判定。
 */
export function agentSetupReasonOf(
  view: Pick<AgentView, 'enabled' | 'status'> | null,
  experimental: boolean,
): AgentSetupReason | null {
  if (!experimental) return 'experimental_off';
  if (view === null) return null;
  if (!view.enabled) return 'not_enabled';
  switch (view.status) {
    case 'installing':
    case 'error':
    case 'available':
      return 'not_installed';
    case 'needs_auth':
      return 'auth_required';
    case 'incompatible':
      return 'incompatible';
    case 'ready':
    case 'update_available':
      return null;
  }
}

/**
 * 外部 Agent run 失败的错误码 → 设置卡原因；null = 普通失败（失败横幅）。
 * `AGENT_UNAVAILABLE` 先看本机状态（未安装等），否则为 `unavailable`。
 */
export function agentSetupReasonForError(
  code: string | undefined,
  stateReason: AgentSetupReason | null,
): AgentSetupReason | null {
  switch (code) {
    case 'AGENT_AUTH_REQUIRED':
      return 'auth_required';
    case 'AGENT_INCOMPATIBLE':
      return 'incompatible';
    case 'AGENT_SANDBOX_UNAVAILABLE':
      return 'sandbox_unavailable';
    case 'AGENT_CONFIG_UNSAFE':
      return 'config_unsafe';
    case 'AGENT_UNAVAILABLE':
      return stateReason ?? 'unavailable';
    default:
      return null;
  }
}

/**
 * API key 类认证的 secrets 键（D25）：`agent:{id}:api-key`。secrets 键不允许
 * `.`，id 以无歧义的转义写入：`_` → `__`、`.` → `_d`（`a.b` → `a_db`，
 * `a_db` → `a__db`）。
 */
export function agentApiKeySecretName(agentId: string): string {
  return `agent:${agentId.replace(/_/g, '__').replace(/\./g, '_d')}:api-key`;
}

// --- RPC 契约（agents.*） ------------------------------------------------------

export const agentIdInputSchema = z.object({ id: agentIdSchema });
export const agentsListOutputSchema = z.object({
  /** 实验开关（关时设置页只显示开关，不显示目录）。 */
  experimental: z.boolean(),
  agents: z.array(agentViewSchema),
});
export const agentOutputSchema = z.object({ agent: agentViewSchema });
export const agentsEnableInputSchema = z.object({
  id: agentIdSchema,
  /** 切换来源：`system` = 使用系统已安装的官方 CLI。缺省沿用当前设置。 */
  source: z.enum(['managed', 'system']).optional(),
});
export const agentsConfirmInputSchema = z.object({
  id: agentIdSchema,
  /** 有 Bot 在用时须二次确认；未确认只返回受影响 Bot。 */
  confirm: z.boolean().optional(),
});
export const agentsAffectingOutputSchema = z.object({
  agent: agentViewSchema,
  affectedBots: z.array(agentBotRefSchema),
  /** false = 有受影响 Bot 且未确认，未执行。 */
  applied: z.boolean(),
});
export const agentsLoginInputSchema = z.object({
  id: agentIdSchema,
  /** terminal / agent 类登录方式 id（来自 `authMethods`）。 */
  methodId: z.string().min(1).max(200).optional(),
  /** API key 类：key 只写不读，存 secrets `agent:{id}:api-key`。 */
  apiKey: z.string().min(1).max(4096).optional(),
  /**
   * 进行中的 terminal 登录：写入登录进程 stdin 的一行（如粘贴厂商页面给出的
   * 授权码）。
   */
  input: z.string().max(4096).optional(),
});
export const agentsLogoutInputSchema = z.object({ id: agentIdSchema });
/** 高级设置（逐 Agent，服务端合并写入，不经 `settings.update` 整表回写）。 */
export const agentsConfigureInputSchema = z.object({
  id: agentIdSchema,
  loadUserConfig: z.boolean().optional(),
  /** 并发上限（`settings.providerConcurrency['agent:{id}']`）。 */
  concurrency: z.number().int().min(1).max(16).optional(),
});
export const agentsTestOutputSchema = z.object({
  agent: agentViewSchema,
  result: agentTestResultSchema,
});
export const agentsOptionsInputSchema = z.object({
  id: agentIdSchema,
  refresh: z.boolean().optional(),
});
export const agentsOptionsOutputSchema = z.object({ options: agentOptionsSchema });

/** 事件 `agent.status`：某个 Agent 的视图变化。 */
export const agentStatusPayloadSchema = z.object({ agent: agentViewSchema });
