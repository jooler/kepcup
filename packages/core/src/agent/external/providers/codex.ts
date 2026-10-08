import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import { ACP_AUTH_REQUIRED } from '../errors.js';
import type { AgentProvider, PermissionTierContext } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';

/**
 * Codex（`@agentclientprotocol/codex-acp`，design 28 §9.2）：只覆盖与通用实现的
 * 差异。
 *
 * - 指令：`prompt-prefix`（会话首个 prompt 的前置段）；进程级 `CODEX_CONFIG`
 *   只在启动时读一次、所有会话共用，**只**放审批 / 沙箱全局项，不承载人设；
 *   `INITIAL_AGENT_MODE=read-only` 让新会话在档位生效前处于最严模式；
 * - 档位（P3，codex-acp 2.1.1 `AgentMode`：每个模式自带 approval_policy
 *   on-request，可按会话 `session/set_mode`）：read_only / ask → `read-only`
 *   （任何写入都先发权限请求，宿主按档位拒绝或弹卡）、workspace →
 *   `workspace-write`（cwd 内写入由 Codex 沙箱放行）；**永不** `agent`（auto
 *   review：AI 审核员代替宿主审批）与 `agent-full-access`；workspace-write 下
 *   发来的命令请求都是越出沙箱的提权 → 宿主一律弹卡（`execSandboxed` 恒 false）；
 *   Codex 沙箱的读不受限（全盘可读），这是让渡项；
 * - 无法关闭的 project 配置：`AGENTS.md`、`.codex/`（P3 首次运行前弹框确认；
 *   `<project>` 段不重复注入 AGENTS.md）；
 * - 未登录：`session/new` 即报 -32000（todo 附录 A.4）；
 * - MCP 仅 http；MCP 工具的 `tool_call` 不带 `name`，结构化名取自适配器构造的
 *   `rawInput: {server, tool, arguments}`（待登录后 spike 实测确认；MCP 审批
 *   请求是否也带它是 P0 登录 spike 的必验项）；
 * - MCP 工具超时：codex-acp 2.1.1 把 ACP 的 http server 只译成
 *   `{url, http_headers}`（`createMcpSeverConfig`），且会话配置的 `mcp_servers`
 *   整体覆盖 `CODEX_CONFIG` 里的同名键——无法为桥设 `tool_timeout_sec`，沿用
 *   Codex 默认（约 60 s）。等待用户审批的工具（install_skill /
 *   request_environment / git_remote）与 generate_video 会超时 → P5 由桥在
 *   `AGENT_BRIDGE_TOOL_DETACH_MS`（45 s）时先应答「已转入后台」、结果在 prompt
 *   结束后以 follow-up prompt 送回同一 run（engine.ts）。按会话随机的桥名也避开了 Codex
 *   「与已配置 MCP 同名则丢弃」的去重（`shouldDeduplicateMcpConflicts`）。
 */

/** 永不进入的模式。 */
export const CODEX_FORBIDDEN_MODES: readonly string[] = ['agent-full-access', 'agent'];

/** 进程级全局项（审批 / 沙箱）；会话档位随后经 set_mode 收紧或放宽。 */
export const CODEX_PROCESS_CONFIG = { approval_policy: 'on-request', sandbox_mode: 'read-only' };

export function codexModeForTier(tier: AgentPermissionTier): string {
  return tier === 'workspace' ? 'workspace-write' : 'read-only';
}

async function applyCodexTier(
  tier: AgentPermissionTier,
  ctx: PermissionTierContext,
): Promise<void> {
  const target = codexModeForTier(tier);
  const modes = ctx.modes?.availableModes.map((mode) => mode.id) ?? [];
  if (modes.includes(target)) {
    if (ctx.modes?.currentModeId !== target) await ctx.setMode(target);
    return;
  }
  // Same preset exposed as the `mode` config option.
  const option = ctx.configOptions.find((candidate) => candidate.category === 'mode');
  // Select options come flat or grouped.
  const entries =
    option !== undefined && option.type === 'select'
      ? (option.options as ReadonlyArray<{ value?: string; options?: Array<{ value: string }> }>)
      : [];
  const values = entries.flatMap((entry) =>
    entry.value !== undefined ? [entry.value] : (entry.options ?? []).map((inner) => inner.value),
  );
  if (option !== undefined && values.includes(target)) {
    if (option.currentValue !== target) await ctx.setConfigOption(option.id, target);
    return;
  }
  throw new AppError(
    'AGENT_INCOMPATIBLE',
    `Codex 未提供所需的权限模式「${target}」（可用：${[...modes, ...values].join(', ') || '无'}）`,
  );
}

export const codexProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'codex',
  launch: ({ entry, target }) => ({
    command: target.command,
    args: [...target.args],
    env: {
      ...(entry.distribution.npx?.env ?? {}),
      ...target.env,
      CODEX_CONFIG: JSON.stringify(CODEX_PROCESS_CONFIG),
      INITIAL_AGENT_MODE: 'read-only',
    },
  }),
  instructionMode: 'prompt-prefix',
  // codex-acp 2.1.1 reports `lastTokenUsage` (the turn's own usage).
  usageSemantics: 'turn',
  applyPermissionTier: applyCodexTier,
  // codex-acp 2.1.1 `ApprovalOptionId`：allow_once；拒绝优先 decline（模型可
  // 继续），其次 reject_permissions / cancel；allow_for_session /
  // allow_permissions_* / *_amendment 一概不选。
  permissionOptions: {
    allowOnce: ['allow_once'],
    rejectOnce: ['decline', 'reject_permissions', 'cancel'],
  },
  execSandboxed: () => false,
  // FileChangeReporter.permission 只带 changes 的原路径；workspace-write 下
  // Codex 只为沙箱拒绝的写入发请求 → 一律弹卡（安全审查 H1）。
  writeSandboxed: () => false,
  bridgeToolFromCall: (toolCall, serverName) => {
    const prefix = `mcp__${serverName}__`;
    if (typeof toolCall.name === 'string' && toolCall.name.startsWith(prefix)) {
      return toolCall.name.length > prefix.length ? toolCall.name.slice(prefix.length) : null;
    }
    // MCP items: the adapter builds rawInput {server, tool, arguments}.
    const input = toolCall.rawInput as { server?: unknown; tool?: unknown } | null | undefined;
    return input !== null &&
      typeof input === 'object' &&
      input.server === serverName &&
      typeof input.tool === 'string' &&
      input.tool.length > 0 &&
      'arguments' in input
      ? input.tool
      : null;
  },
  // parallelSessions：codex-acp 2.1.1 dist/index.js —— 会话状态全部按 sessionId
  // 分表（:37377-37380 `sessions` / `pendingTurnStarts` / `activePrompts`）；
  // `prompt` 取本会话状态并 `trackActivePrompt(sessionId)`（:39527-39543，
  // :39339 每个 prompt 自己的 AbortController）；事件按会话串行分发
  // （`subscribeToSessionEvents` / `enqueueSessionNotification`，:34297-34330）；
  // 换 Provider 前等待**所有**会话的进行中 prompt（:38084-38087）——设计上即
  // 多会话并发（同一 codex app-server 进程的多个 thread）。
  features: {
    steering: true,
    loadSession: true,
    resume: true,
    osSandbox: true,
    httpMcp: true,
    parallelSessions: true,
  },
  agentSideConfigFiles: ['AGENTS.md', '.codex/'],
  classifyError: (error) => (error.code === ACP_AUTH_REQUIRED ? 'auth_required' : 'other'),
};
