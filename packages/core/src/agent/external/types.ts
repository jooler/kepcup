import type { AgentCatalogEntry, AgentPermissionTier } from '@kepcup/shared';
import type {
  AcpAgentClientLike,
  AcpAgentLike,
  AcpAuthMethod,
  AcpByteChannel,
  AcpMcpServer,
  AcpSessionConfigOption,
  AcpSessionModeState,
  AcpToolCallLike,
} from './acp/client.js';
import type { AgentErrorInfo, AgentErrorKind, AgentErrorPhase } from './errors.js';

/**
 * Provider 架构（docs/design/28-external-agents-acp.md §10，D72）：每个 Agent
 * = 目录条目（数据）+ Provider（行为）。通用 ACP Provider 覆盖协议标准部分，
 * 各家只覆盖差异；新增 Agent = 目录条目 + Provider 模块（无差异时复用
 * `generic-acp`）+ PROVIDERS 登记 + 契约测试。
 */

/** 如何启动一个目录条目（P4 由安装器解析；P1 为 system 来源或测试注入）。 */
export interface LaunchTarget {
  command: string;
  args: string[];
  /** Extra variables on top of the host's whitelisted environment. */
  env: Record<string, string>;
}

export interface LaunchContext {
  entry: AgentCatalogEntry;
  target: LaunchTarget;
  platform: NodeJS.Platform;
  /**
   * 应用数据目录（`~/.kepcup`）：只有 OS 沙箱之外、靠进程级配置隔离数据目录
   * 的 Provider 用（OpenCode 的 `external_directory` 拒绝规则，P5）。缺省 =
   * 默认数据目录。
   */
  dataHome?: string;
  /**
   * 该 Agent 的私有状态目录（`{数据目录}/agents/{id}`，P5）：需要把 Agent 的
   * 全局配置根改到 KepCup 私有位置的 Provider 用（Antigravity `GEMINI_HOME`）。
   */
  stateDir?: string;
}

export interface SessionContext {
  entry: AgentCatalogEntry;
  cwd: string;
  permission: AgentPermissionTier;
  capabilities: readonly string[];
  /** 会话级提示词：仅 `meta-append` 模式下传入（由 Provider 放进 `_meta`）。 */
  sessionPrompt: string | null;
  /** 单次 run 的轮数上限（`RunSpec.limits.maxTurns`）。 */
  maxTurns: number;
  /** 用户开启「加载我的个人配置」（`settings.agents[id].loadUserConfig`）。 */
  loadUserConfig: boolean;
  /**
   * 应用数据目录在 Agent 自身沙箱里的隔离（P3，design 28 §6）：有 OS 沙箱的
   * Provider 据此配置 denyRead / denyWrite（Claude `sandbox.filesystem`）。
   * 探测 / 测试连接会话不带。
   */
  isolation?: AgentIsolation;
}

/** 数据目录隔离（权限桥按 run 计算，见 permission-bridge.ts `isolationFor`）。 */
export interface AgentIsolation {
  /** 应用数据目录（`~/.kepcup`）。 */
  dataHome: string;
  /** 不可读：数据目录。 */
  denyRead: string[];
  /** 数据目录中重新允许读的：本 run 的 workspace（与 cwd）、技能目录。 */
  allowRead: string[];
  /** 不可写：数据目录（cwd 在数据目录内时为其中的敏感子集，含 toolchains/）。 */
  denyWrite: string[];
}

export interface PermissionTierContext {
  sessionId: string;
  modes: AcpSessionModeState | null;
  configOptions: readonly AcpSessionConfigOption[];
  setMode(modeId: string): Promise<void>;
  setConfigOption(configId: string, value: string): Promise<void>;
}

export interface ExtRequestContext {
  agentId: string;
  sessionId: string | null;
  /** Whether that session currently belongs to an in-flight run. */
  hasRun: boolean;
}

export interface AgentProviderFeatures {
  /** `_session/steering`（固定 `idleBehavior:'promptRequired'`，P5）。 */
  steering: boolean;
  loadSession: boolean;
  resume: boolean;
  /** Agent 自带 OS 沙箱（无则 `workspace` 档命令逐条确认，P3）。 */
  osSandbox: boolean;
  /** 支持 http MCP（否则经 stdio→http 转发脚本，P2）。 */
  httpMcp: boolean;
}

/** 一个已启动的 Agent（子进程或进程内假 Agent / 垫片）。 */
export interface AgentProcess {
  channel: AcpByteChannel;
  /**
   * Resolves once the process is gone (crash, kill, normal exit). `error` is
   * set when it never started (e.g. ENOENT).
   */
  exited: Promise<AgentExit>;
  kill(): void;
}

export interface AgentExit {
  code: number | null;
  signal: string | null;
  error?: { code?: string; message: string };
}

export interface AgentProvider {
  id: string;
  /** 进程级配置在此（命令、参数、环境变量）。 */
  launch(ctx: LaunchContext): LaunchTarget;
  instructionMode: 'meta-append' | 'prompt-prefix';
  /** 会话级选项（`session/new` 的 `_meta`、额外 MCP server）。 */
  sessionNew(ctx: SessionContext): {
    _meta?: Record<string, unknown>;
    extraMcpServers?: AcpMcpServer[];
  };
  /**
   * 档位映射（set_mode / set_config_option / 进程配置）；禁止 bypass / yolo /
   * full-access 一类模式（P3 细化）。`generic-acp` 的实现是 no-op（只靠宿主
   * 侧权限请求兜底）——**真实 Agent 的 Provider 进目录前必须实现档位映射**，
   * 尤其 `read_only`。
   */
  applyPermissionTier(tier: AgentPermissionTier, ctx: PermissionTierContext): Promise<void>;
  /**
   * 执行类权限请求是否在 Agent 自身 OS 沙箱内运行（P3）：只有 Provider 能
   * 从请求本身确认「沙箱内」时才返回 true，`workspace` 档据此自动放行；缺省
   * false（宿主看不出的一律当沙箱外，弹卡）。例如 Codex 在 workspace-write
   * 下发来的命令请求都是越出其沙箱的提权，永远 false。
   */
  execSandboxed?(toolCall: AcpToolCallLike): boolean;
  /**
   * 写入类权限请求是否仍在 Agent 自身沙箱的允许范围内（安全审查 H1）：
   * false = 该 Agent 只为沙箱拒绝的写入发请求（Codex workspace-write：越出
   * 沙箱的 move 目标、只读的 `.git/` …），请求里可见路径即便都在 cwd 内也
   * 必须弹卡。缺省视为 true（cwd 内写入按档位放行）。
   */
  writeSandboxed?(toolCall: AcpToolCallLike): boolean;
  /**
   * optionId 白名单：权限请求只在其中选 allow_once / reject_once（按数组
   * 顺序优先）；永不选 allow_always 与切换模式的选项。
   */
  permissionOptions: { allowOnce: string[]; rejectOnce: string[] };
  /** 平台规则里引用宿主 MCP 工具的写法（如 `mcp__kepcup__send_message`）。 */
  toolName(server: string, tool: string): string;
  /**
   * 识别宿主桥工具（权限放行、忽略镜像更新）：返回该调用指向的桥工具名
   * （不带前缀），不是 `serverName` 这台桥的工具则 null。缺省用通用识别
   * （`toolCall.name` 的 `toolName` 写法，或 `rawInput.{server,tool}`）；各家把
   * 结构化名放在不同位置（Claude `_meta.claudeCode.toolName`、Codex
   * `rawInput`），新增 Provider 须实测（P5）。永不看自由文本的 `title`；调用方
   * 还会核对工具属于当前 run 的注入集合。
   */
  bridgeToolFromCall?(toolCall: AcpToolCallLike, serverName: string): string | null;
  features: AgentProviderFeatures;
  /**
   * 该 Agent 额外禁止的模式（叠加在全局 `FORBIDDEN_AGENT_MODES` 之上，P5）：
   * 宿主永不切入，Agent 自行切入则判为偏离（如 Antigravity 的 `auto_edit`
   * 会自动批准工作目录之外的写入）。
   */
  forbiddenModes?: readonly string[];
  /**
   * 全局禁止表里与本 Agent 的同名模式含义不同、经核对是安全的那些（P5）：
   * 全局表按 Codex 的语义禁止 `agent`（AI 审核员代替宿主审批），而 Cursor 的
   * `agent` 是会发权限请求的普通模式。只能豁免全局表中的名字，Provider 自己
   * 的 `forbiddenModes` 优先。
   */
  safeModes?: readonly string[];
  /** 无法关闭、需确认的 project 内 Agent 配置文件（P3）。 */
  agentSideConfigFiles: string[];
  /**
   * 错误分类（todo 附录 A.4 第 1 条）：各家「未登录 / 未安装 / 不兼容」的
   * 表现与出现阶段不同；缺省按 ACP 标准只把 -32000 判为 auth_required。
   */
  classifyError?(error: AgentErrorInfo, phase: AgentErrorPhase): AgentErrorKind;
  /** 过滤 / 排序登录方式（如 Antigravity 去掉 oauth-personal）。 */
  authMethods?(advertised: AcpAuthMethod[]): AcpAuthMethod[];
  /** 厂商扩展请求（如 cursor/ask_question）；未登记的一律立即返回「不支持」。 */
  extRequests?: Readonly<
    Record<
      string,
      (params: Record<string, unknown>, ctx: ExtRequestContext) => Promise<Record<string, unknown>>
    >
  >;
  /**
   * `PromptResponse.usage`（ACP 不稳定字段）的口径（P5）：`session` = 会话
   * 累计（规范字段注释所写，引擎按会话做差）；`turn` = 本次 prompt 的用量
   * （claude-agent-acp 0.86.0 在 turn 激活时清零累计器；codex-acp 2.1.1 报
   * `lastTokenUsage`）。缺省 `session`。
   */
  usageSemantics?: 'turn' | 'session';
  /**
   * 宿主桥工具调用超过多久转入后台（立即应答「仍在执行，结果稍后送达」，
   * 结果作为 follow-up 注入，P5）；缺省 `AGENT_BRIDGE_TOOL_DETACH_MS`，null =
   * 从不转入后台（确认 Agent 的 MCP 客户端不会超时时）。
   */
  bridgeToolDetachMs?: number | null;
  /**
   * 仅 shim 型 Provider（`transport:'shim'`）：把私有协议进程包成进程内 ACP
   * Agent（P5）。`client` 是垫片向宿主发 `session/update`、权限请求等的一侧
   * （ACP SDK 的 AgentSideConnection）。
   */
  connect?(proc: AgentProcess, client: AcpAgentClientLike): AcpAgentLike;
}

/** `provider` 字段 → Provider 模块。 */
export type ProviderRegistry = Readonly<Record<string, AgentProvider>>;
