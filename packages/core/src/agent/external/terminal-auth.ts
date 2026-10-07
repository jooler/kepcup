import path from 'node:path';
import type { AcpAuthMethod } from './acp/client.js';
import type { AgentInvocation } from './installer.js';

/**
 * 登录方式归一与 terminal 登录命令改写（D72 §9.1；todo 附录 A.4 第 2 条）。
 *
 * Agent 在 `initialize.authMethods` 里给出登录方式，形态各家不同：
 * - ACP 标准 terminal 方式（`type:'terminal'`，如 Claude 的
 *   `claude-ai-login`）：`args` / `env` **追加在配置的 Agent 调用之后**；
 * - 只有 `_meta['terminal-auth']`（如 OpenCode：`{command:'opencode',
 *   args:['auth','login']}`）：`command` 可能是裸名，也可能是 Agent 自己的
 *   进程路径（node + 脚本）——宿主一律**改写为目录安装的可执行入口 + 声明的
 *   参数**，绝不按 Agent 给的命令名去 PATH 里找；
 * - 其余为 `agent` 类（Codex `chat-gpt` / `api-key`）：经 ACP `authenticate`
 *   由 Agent 自行完成。
 */

export interface AgentLoginMethod {
  id: string;
  name: string;
  description: string;
  type: 'terminal' | 'agent';
  /** terminal 类：`append` = ACP 标准（追加在 ACP 调用后）；`replace` = `_meta['terminal-auth']`。 */
  terminal?: { mode: 'append' | 'replace'; args: string[]; env: Record<string, string> };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string',
    ),
  );
}

/**
 * Agent 声明的 terminal 登录 env 中不允许覆盖的键（可执行搜索路径、预加载与
 * 解释器注入类变量）：防止 Agent 借登录命令改写启动路径或注入代码。
 */
const LOGIN_ENV_DENY =
  /^(PATH|PATHEXT|HOME|USERPROFILE|SHELL|COMSPEC|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|RUBYOPT|PERL5OPT|LD_.*|DYLD_.*|ELECTRON_.*)$/i;

/** Agent-supplied env minus the denied keys. */
export function sanitizeLoginEnv(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(stringRecord(value)).filter(([key]) => !LOGIN_ENV_DENY.test(key)),
  );
}

/**
 * `_meta['terminal-auth'].args` 可能以 Agent 自己的入口脚本开头（命令是
 * node 时）：去掉开头的绝对路径与 JS 脚本参数——入口由宿主换成已安装的那份。
 */
export function stripEntryArgs(args: readonly string[]): string[] {
  let start = 0;
  while (
    start < args.length &&
    (path.isAbsolute(args[start]!) ||
      path.win32.isAbsolute(args[start]!) ||
      /\.(c|m)?js$/i.test(args[start]!))
  ) {
    start += 1;
  }
  return args.slice(start);
}

/** `initialize.authMethods`（已经 Provider 过滤）→ 归一的登录方式。 */
export function describeAuthMethods(advertised: readonly AcpAuthMethod[]): AgentLoginMethod[] {
  return advertised.map((method) => {
    const base = {
      id: method.id,
      name: method.name,
      description: method.description ?? '',
    };
    if ('type' in method && method.type === 'terminal') {
      return {
        ...base,
        type: 'terminal' as const,
        terminal: {
          mode: 'append' as const,
          args: stringArray(method.args),
          env: sanitizeLoginEnv(method.env),
        },
      };
    }
    const meta = (method._meta ?? null) as Record<string, unknown> | null;
    const terminalAuth = meta?.['terminal-auth'];
    if (terminalAuth !== null && typeof terminalAuth === 'object') {
      const declared = terminalAuth as { args?: unknown; env?: unknown };
      return {
        ...base,
        type: 'terminal' as const,
        terminal: {
          mode: 'replace' as const,
          args: stripEntryArgs(stringArray(declared.args)),
          env: sanitizeLoginEnv(declared.env),
        },
      };
    }
    return { ...base, type: 'agent' as const };
  });
}

/**
 * terminal 登录的实际命令：可执行入口一律取自安装器（已安装路径 / 系统 CLI
 * 的绝对路径），参数按方式拼接，环境变量 = 安装器声明 + 方式声明（后者
 * 优先）。宿主再经白名单环境（`buildAgentEnv`）运行它。
 */
export function terminalLoginCommand(
  invocation: AgentInvocation,
  method: AgentLoginMethod,
): { command: string; args: string[]; env: Record<string, string> } {
  const terminal = method.terminal;
  if (terminal === undefined) throw new Error(`login method ${method.id} is not terminal`);
  const args =
    terminal.mode === 'append'
      ? [...invocation.prefixArgs, ...invocation.args, ...terminal.args]
      : [...invocation.prefixArgs, ...terminal.args];
  return { command: invocation.command, args, env: { ...invocation.env, ...terminal.env } };
}
