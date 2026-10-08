import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import { ACP_AUTH_REQUIRED, type AgentErrorInfo } from '../errors.js';
import type { AgentIsolation, AgentProvider, PermissionTierContext } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';

/**
 * Claude Agent（`@agentclientprotocol/claude-agent-acp`，design 28 §9.2）：只覆盖
 * 与通用实现的差异。
 *
 * - 指令：`meta-append`——会话级提示词进 `session/new._meta.systemPrompt =
 *   {append}`（保留 Claude Code 预设提示词，只追加）；
 * - `_meta.claudeCode.options`：`settingSources: []`（不加载仓库 `.claude/`：其
 *   hooks 在沙箱外执行、allow 规则会绕过权限桥；用户开启「加载我的个人配置」
 *   时只放 `['user']`）、`allowDangerouslySkipPermissions: false`（模式目录里
 *   不出现 bypass）、`maxTurns` = run 上限；注入了 `web` 包也**不**禁用其
 *   WebSearch / WebFetch——按「原生优先」，注入工具只作兜底（§4.2）；
 * - 档位（P3）：read_only / ask → `default`，workspace → `acceptEdits`（cwd 内
 *   编辑自动接受，cwd 外仍发权限请求给宿主）；从不用 `plan`（会抑制 MCP 工具
 *   并可能以 ExitPlanMode 结束 turn）；read_only 另经 `disallowedTools` 禁掉
 *   写入 / 执行类原生工具；永不选 bypass 一类模式；
 * - 原生沙箱（`_meta.claudeCode.options.sandbox`，claude-agent-sdk 0.3.287
 *   `SandboxSettings`：enabled / failIfUnavailable / autoAllowBashIfSandboxed /
 *   allowUnsandboxedCommands / filesystem.{denyRead,allowRead,denyWrite}）：
 *   一律开启、禁止 `dangerouslyDisableSandbox` 逃逸；数据目录不可读（workspace
 *   与技能目录除外）、不可写（含 toolchains/）；所有档位 failIfUnavailable
 *   （沙箱起不来就让 run 失败，不降级）；workspace 档沙箱内命令自动放行，
 *   其余档命令逐条走宿主；
 *   filesystem 规则只约束 Bash，Read / Edit 工具越界由权限请求兜底；
 * - 宿主强制项：适配器把 `_meta.claudeCode.options` 展开后，再以
 *   `allowDangerouslySkipPermissions: allowBypass`（我方传 false 即 false）与
 *   `permissionMode` 覆盖（claude-agent-acp 0.86.0 `acp-agent.js` ~7110–7135）；
 *   我方自己的 options 里强制项也放在最后，日后合入用户自定义项不能覆盖；
 * - 后台精简会话（P6 `oneShot`）：`systemPrompt` 为替换式字符串、`tools: []`
 *   （无原生工具），`settingSources: []` 与沙箱照旧；
 * - 未登录：`session/new` 成功、`session/prompt` 才报 -32000（todo 附录 A.4）；
 * - MCP 工具的结构化名在 `_meta.claudeCode.toolName`（适配器不填 `name`）。
 */

/** 永不进入的模式（Provider 层过滤，UI 不出现）。 */
export const CLAUDE_FORBIDDEN_MODES: readonly string[] = ['bypassPermissions', 'dontAsk', 'auto'];

/** 保留的登录方式（terminal 类，P4 改写为目录安装路径后运行）。 */
const CLAUDE_AUTH_METHODS: readonly string[] = ['claude-ai-login', 'console-login'];

/** 只读档禁用的原生工具（写入 / 执行）。 */
export const CLAUDE_READ_ONLY_DISALLOWED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
];

export function claudeModeForTier(tier: AgentPermissionTier): string {
  return tier === 'workspace' ? 'acceptEdits' : 'default';
}

/**
 * 「沙箱起不来」的错误形态（`failIfUnavailable: true`）。claude-agent-sdk 0.3.287
 * 只说明依赖缺失（如 Linux 的 bubblewrap）或平台不支持时 `query()`「emit an
 * error result and exit」，确切文本在 Claude Code 本体里（本机无源码可查）。
 * 故只认错误 **message** 本身同时提到 sandbox 与具体依赖名（bubblewrap /
 * bwrap / socat / sandbox-exec）——宁可漏判（落回普通失败横幅），不把无关
 * 失败变成会整段重放的设置卡。确切文案待登录 spike 核对后再收紧 / 放宽。
 */
export function isClaudeSandboxUnavailable(error: AgentErrorInfo): boolean {
  const message = error.message;
  return /sandbox/i.test(message) && /\b(bubblewrap|bwrap|socat|sandbox-exec)\b/i.test(message);
}

/** 原生沙箱设置（SDK `Options.sandbox`）；`isolation` 缺省 = 探测会话。 */
export function claudeSandboxSettings(
  tier: AgentPermissionTier,
  isolation?: AgentIsolation,
): Record<string, unknown> {
  return {
    enabled: true,
    // 所有档位：沙箱不可用（如 Linux 缺 bubblewrap / socat、平台不支持）时
    // 整 run 失败，绝不静默降级为沙箱外执行——`execSandboxed` 的「在沙箱
    // 内」判断以此为前提（安全复核第 2 轮）。
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: tier === 'workspace',
    // `dangerouslyDisableSandbox` 被忽略：命令只能在沙箱内运行。
    allowUnsandboxedCommands: false,
    ...(isolation !== undefined
      ? {
          filesystem: {
            denyRead: isolation.denyRead,
            allowRead: isolation.allowRead,
            denyWrite: isolation.denyWrite,
          },
        }
      : {}),
  };
}

export function claudeDisallowedTools(tier: AgentPermissionTier): string[] {
  return tier === 'read_only' ? [...CLAUDE_READ_ONLY_DISALLOWED_TOOLS] : [];
}

/** Switches to the tier's mode via `session/set_mode`; fails closed when absent. */
async function applyClaudeTier(
  tier: AgentPermissionTier,
  ctx: PermissionTierContext,
): Promise<void> {
  const target = claudeModeForTier(tier);
  const available = ctx.modes?.availableModes.map((mode) => mode.id) ?? [];
  if (!available.includes(target)) {
    throw new AppError(
      'AGENT_INCOMPATIBLE',
      `Claude Agent 未提供所需的权限模式「${target}」（可用：${available.join(', ') || '无'}）`,
    );
  }
  if (ctx.modes?.currentModeId !== target) await ctx.setMode(target);
}

function metaToolName(meta: Record<string, unknown> | null | undefined): string | null {
  const claudeCode = meta?.claudeCode as { toolName?: unknown } | undefined;
  return typeof claudeCode?.toolName === 'string' ? claudeCode.toolName : null;
}

/**
 * 进程级环境（P5「run 外输出」）：关闭 Claude Code 的后台任务（Bash
 * `run_in_background`、后台子代理——完成时会触发 run 之外的自主 turn）与
 * 定时任务（Cron 工具；宿主语义「定时用 schedule」）。claude-agent-sdk
 * 0.3.287 内置 CLI 认 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` /
 * `CLAUDE_CODE_DISABLE_CRON`（二进制字符串核对，待登录实测）。
 */
export const CLAUDE_PROCESS_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_DISABLE_CRON: '1',
};

export const claudeProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'claude',
  launch: ({ entry, target }) => ({
    command: target.command,
    args: [...target.args],
    env: { ...(entry.distribution.npx?.env ?? {}), ...target.env, ...CLAUDE_PROCESS_ENV },
  }),
  instructionMode: 'meta-append',
  // claude-agent-acp 0.86.0 resets its per-session accumulator on each turn.
  usageSemantics: 'turn',
  // 后台精简会话：`tools: []` 关掉全部原生工具（宿主桥 MCP 工具不受影响），
  // `settingSources: []` 不加载任何设置（会话级，与进程无关）。
  backgroundNoNativeTools: true,
  sessionNew: ({ sessionPrompt, maxTurns, loadUserConfig, permission, isolation, oneShot }) => {
    const disallowedTools = claudeDisallowedTools(permission);
    const prompt = sessionPrompt !== null && sessionPrompt.trim().length > 0 ? sessionPrompt : null;
    return {
      _meta: {
        // 后台精简会话（P6）：替换式字符串——不带 Claude Code 预设提示词；
        // 否则只追加。
        ...(prompt !== null
          ? { systemPrompt: oneShot === true ? prompt : { append: prompt } }
          : {}),
        claudeCode: {
          options: {
            maxTurns,
            // 后台精简会话不给任何原生工具（宿主 MCP 桥的工具不受影响）。
            ...(oneShot === true ? { tools: [] } : {}),
            ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
            // Host-enforced keys last: nothing merged above may override them.
            sandbox: claudeSandboxSettings(permission, isolation),
            // 后台精简会话一律不加载任何设置（含个人配置）。
            settingSources: loadUserConfig && oneShot !== true ? ['user'] : [],
            allowDangerouslySkipPermissions: false,
          },
        },
      },
    };
  },
  applyPermissionTier: applyClaudeTier,
  // claude-agent-acp 0.86.0 permissions/options/shared.js：allow-once /
  // allow-with-updates（= allow_always，不选）/ reject；ExitPlanMode 的
  // exit-plan-* 会切换模式（不在白名单）。
  permissionOptions: { allowOnce: ['allow-once'], rejectOnce: ['reject'] },
  // 只有沙箱确实强制时才为真：每个会话都带 `sandbox.enabled +
  // failIfUnavailable: true + allowUnsandboxedCommands: false`（沙箱起不来
  // 整 run 失败；dangerouslyDisableSandbox 被忽略），仍按字面拒绝自称沙箱外
  // 的请求（宿主不信未核实的组合）。
  execSandboxed: (toolCall) => {
    const input = toolCall.rawInput as { dangerouslyDisableSandbox?: unknown } | null | undefined;
    return !(
      input !== null &&
      typeof input === 'object' &&
      input.dangerouslyDisableSandbox === true
    );
  },
  bridgeToolFromCall: (toolCall, serverName) => {
    const name =
      (typeof toolCall.name === 'string' && toolCall.name.length > 0 ? toolCall.name : null) ??
      metaToolName(toolCall._meta);
    const prefix = `mcp__${serverName}__`;
    return name !== null && name.startsWith(prefix) && name.length > prefix.length
      ? name.slice(prefix.length)
      : null;
  },
  // parallelSessions（同进程并行会话）：claude-agent-acp 0.86.0 dist/acp-agent.js
  // —— `this.sessions = {}`（:1168）按 sessionId 存会话；每个会话在 session/new
  // 时各自 `query()`（:7273，各拉起一个 Claude Code 子进程）并登记独立记录
  // （:7441：query / input / cancelled / 用量累计器）；`startTurn` 按 sessionId
  // 取会话、把轮次压进该会话自己的 `turnQueue`（:1944、:2011-2013）；
  // `cancelTurns` 只动该会话（:5262-5268）。没有进程级「当前 prompt」。
  features: {
    steering: true,
    loadSession: true,
    resume: true,
    osSandbox: true,
    httpMcp: true,
    parallelSessions: true,
  },
  // settingSources: [] → Claude 不读仓库内的 CLAUDE.md / .claude/：由 <project> 段注入。
  agentSideConfigFiles: [],
  classifyError: (error) =>
    error.code === ACP_AUTH_REQUIRED
      ? 'auth_required'
      : isClaudeSandboxUnavailable(error)
        ? 'sandbox_unavailable'
        : 'other',
  authMethods: (advertised) =>
    advertised.filter((method) => CLAUDE_AUTH_METHODS.includes(method.id)),
};
