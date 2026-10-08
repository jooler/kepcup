import path from 'node:path';
import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import { defaultBridgeToolFromCall } from '../acp/client.js';
import type { AgentProvider, PermissionTierContext } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';
import { switchToMode } from './mode-tier.js';

/**
 * Cursor（原生 `cursor-agent acp`，2026.10.01，design 28 §9.2）：只覆盖与通用实现
 * 的差异。依据：离线探测（todo 附录 A.2）+ 归档内 JS bundle（`dist-package/
 * 6136.index.js` 的 `acp/interaction-handlers/*`，离线阅读，未运行）。
 *
 * - 指令：`prompt-prefix`（无 ACP 提示词字段）；
 * - 档位（session modes：agent / plan / ask，同时以 `mode` config option 暴露）：
 *   read_only → `ask`（「Q&A mode - no edits or command execution」），ask /
 *   workspace → `agent`；不用 `plan`（会走 `cursor/create_plan`）。全局禁止表里
 *   的 `agent` 指 Codex 的 AI 审核员模式，Cursor 的 `agent` 是普通模式（写入 /
 *   命令 / MCP 发 allow-once / allow-always / reject-once 权限请求）→ `safeModes`；
 * - 自身沙箱（Linux Landlock + seccomp / macOS Seatbelt）在 ACP 模式下是否生效
 *   未核实 → `osSandbox:false`（`workspace` 档命令逐条确认）；
 * - 阻塞式扩展请求必须应答，否则整个工具调用挂起：
 *   - `cursor/ask_question`（应答 `{outcome:{outcome:'answered'|'skipped'|…}}`）：
 *     KepCup 不在 run 中途向用户提问（问题卡留待后续），应答 `skipped` + 原因
 *     「用户当前不在线，请根据已有信息自行决定」——Cursor 把它作为被拒的工具
 *     结果交给模型继续；
 *   - `cursor/create_plan`（应答 `accepted` / `rejected` / 其他=取消）：选
 *     `rejected` + 原因（请把计划写进回复并在当前权限下继续）。不自动 `accepted`：
 *     那等于替用户声明「已审阅并同意计划」，而 KepCup 并没有给用户看过；拒绝不
 *     授予也不收回任何权限，后续写入 / 命令仍逐条走权限请求；
 *   - 其余 `cursor/*` 请求（task / update_todos / generate_image …）由宿主立即回
 *     -32601，Cursor 自有回退；
 * - MCP 工具的 `tool_call` 带 `rawInput:{providerIdentifier, toolName, args}`（宿主
 *   桥镜像据此识别）；MCP 的**权限请求**只有自由文本 title、无结构化名 → 桥工具
 *   的审批请求无法自动放行（按普通请求处理），待登录实测；
 * - 无 `session/resume`，只有 `loadSession` → 会话复用只用 load（P5 其他部分）；
 * - 未登录：`session/new` 即报 -32000。
 */

/** `cursor/ask_question` 的应答原因（Cursor 原样交给模型）。 */
export const CURSOR_ASK_QUESTION_REASON =
  '用户当前不在线，无法回答提问：请根据已有信息自行决定并继续；确需用户决定的事项请写进最终回复。';

/** `cursor/create_plan` 的应答原因。 */
export const CURSOR_CREATE_PLAN_REASON =
  'KepCup 不提供计划审阅：请把计划写进回复，并在当前权限下直接执行（写入与命令仍会逐条请求确认）。';

export function cursorModeForTier(tier: AgentPermissionTier): string {
  return tier === 'read_only' ? 'ask' : 'agent';
}

async function applyCursorTier(
  tier: AgentPermissionTier,
  ctx: PermissionTierContext,
): Promise<void> {
  await switchToMode('Cursor', cursorModeForTier(tier), ctx);
}

/**
 * 未开启「加载我的个人配置」时的私有配置目录（`CURSOR_CONFIG_DIR`，审查 M2）：
 * 用户的 `~/.cursor/cli-config.json` 里的命令 allowlist 会让命令不经权限请求
 * 直接执行。登录凭据在 `auth.json`（Linux `$XDG_CONFIG_HOME/cursor`、macOS
 * `~/.cursor`、Windows `%APPDATA%/Cursor`），路径不随 `CURSOR_CONFIG_DIR`
 * 变化（bundle `getAuthFilePath`），登录不受影响——待登录实测。project 的
 * `.cursor/cli.json` 按 Agent **进程** cwd 向上查找（git 根 → process.cwd），
 * 进程 cwd 是 KepCup 私有目录（审查 M1）。
 */
export function cursorConfigDir(stateDir: string): string {
  return path.join(stateDir, 'cursor-config');
}

export const cursorProvider: AgentProvider = {
  ...genericAcpProvider,
  launch: ({ entry, target, stateDir, loadUserConfig }) => {
    if (loadUserConfig !== true && stateDir === undefined) {
      throw new AppError('AGENT_UNAVAILABLE', 'Cursor 缺少私有状态目录，无法隔离个人配置');
    }
    return {
      command: target.command,
      args: [...target.args],
      env: {
        ...(entry.distribution.npx?.env ?? {}),
        ...target.env,
        // Host-enforced last.
        ...(loadUserConfig !== true ? { CURSOR_CONFIG_DIR: cursorConfigDir(stateDir!) } : {}),
      },
    };
  },
  id: 'cursor',
  instructionMode: 'prompt-prefix',
  applyPermissionTier: applyCursorTier,
  safeModes: ['agent'],
  permissionOptions: { allowOnce: ['allow-once'], rejectOnce: ['reject-once'] },
  execSandboxed: () => false,
  bridgeToolFromCall: (toolCall, serverName) => {
    // Mirror updates of MCP calls: rawInput {providerIdentifier, toolName, args}
    // (only on calls of no specific kind, like the generic rawInput shape).
    const kind = toolCall.kind ?? null;
    const input = toolCall.rawInput as
      { providerIdentifier?: unknown; toolName?: unknown } | null | undefined;
    if (
      (kind === null || kind === 'other') &&
      input !== null &&
      typeof input === 'object' &&
      input.providerIdentifier === serverName &&
      typeof input.toolName === 'string' &&
      input.toolName.length > 0
    ) {
      return input.toolName;
    }
    return defaultBridgeToolFromCall(toolCall, serverName, (server, tool) =>
      genericAcpProvider.toolName(server, tool),
    );
  },
  // parallelSessions：cursor agent-cli 2026.10.01 随包 JS（dist-package/
  // 6136.index.js，模块 ./src/acp/cursor-acp-agent.ts / agent-session.ts）——
  // `this.sessions = new Map`，`prompt` 按 sessionId 取该会话的 AgentSession 再
  // `handlePrompt`；`newSession` 为每个会话各建 agentStore、执行资源
  // （session-resources.ts）与 AgentSession；在途 prompt 的取消句柄
  // `pendingPromptCancel` 在 AgentSession 上。Agent 类本身没有「当前 prompt」
  // 字段（只有 connection / sessions / sharedServices 等）。但它闭源、随包 JS
  // 经压缩且无兼容承诺，sharedServices 在会话间共享——按「未真机实测即保守」
  // 取 false（并发钳为 1、不参与后台），真机确认后再放开。
  features: {
    steering: false,
    loadSession: true,
    resume: false,
    osSandbox: false,
    httpMcp: true,
    parallelSessions: false,
  },
  // project 内 Cursor 会读的配置：.cursor/（rules、cli.json 权限、mcp.json、
  // hooks）、AGENTS.md、CLAUDE.md。
  agentSideConfigFiles: ['.cursor/', 'AGENTS.md', 'CLAUDE.md'],
  extRequests: {
    'cursor/ask_question': async () => ({
      outcome: { outcome: 'skipped', reason: CURSOR_ASK_QUESTION_REASON },
    }),
    'cursor/create_plan': async () => ({
      outcome: { outcome: 'rejected', reason: CURSOR_CREATE_PLAN_REASON },
    }),
  },
};
