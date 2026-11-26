import path from 'node:path';
import { AppError } from '@kepcup/shared';
import { defaultClassifyError, type AgentErrorInfo } from '../errors.js';
import type { AgentProvider } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';

/**
 * goose 1.61.1（官方 lean `goose-acp` binary，无子命令）：覆盖与通用实现的差异。
 *
 * - 进程级 `GOOSE_MODE=approve`：goose 默认是 `auto`（工具不经确认直接执行），
 *   一律改为 approve，由宿主权限桥逐条裁决；`auto` / `smart_approve` / `yolo`
 *   永不进入；
 * - 私有 `GOOSE_PATH_ROOT`：隔离系统 / 用户 config、extensions 与插件；「加载
 *   我的个人配置」开启时沿用用户目录；
 * - 权限：`allow_once` / `allow_always` / `reject_once` / `reject_always`
 *   （只选一次性与 reject）；
 * - MCP permission request 不带稳定的结构化工具名，宿主桥工具在登录 spike
 *   前按普通请求处理（fail closed），不做自动放行；
 * - 其余能力按最保守值（steering / load / resume / 并行会话未核实）。
 */

export const GOOSE_FORBIDDEN_MODES: readonly string[] = ['auto', 'smart_approve', 'yolo'];

function gooseLaunchEnv(ctx: {
  stateDir?: string;
  loadUserConfig?: boolean;
}): Record<string, string> {
  if (ctx.loadUserConfig !== true && ctx.stateDir === undefined) {
    throw new AppError('AGENT_UNAVAILABLE', 'goose 缺少私有状态目录，无法隔离个人配置');
  }
  return {
    GOOSE_MODE: 'approve',
    ...(ctx.loadUserConfig !== true ? { GOOSE_PATH_ROOT: path.resolve(ctx.stateDir!) } : {}),
  };
}

export const gooseProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'goose',
  launch: ({ entry, target, stateDir, loadUserConfig }) => ({
    command: target.command,
    args: [...target.args],
    env: {
      ...(entry.distribution.npx?.env ?? {}),
      ...target.env,
      ...gooseLaunchEnv({ stateDir, loadUserConfig }),
    },
  }),
  instructionMode: 'prompt-prefix',
  forbiddenModes: GOOSE_FORBIDDEN_MODES,
  permissionOptions: {
    allowOnce: ['allow_once'],
    rejectOnce: ['reject_once', 'reject_always'],
  },
  execSandboxed: () => false,
  features: {
    steering: false,
    loadSession: false,
    resume: false,
    osSandbox: false,
    httpMcp: true,
    parallelSessions: false,
  },
  agentSideConfigFiles: ['.goose/', '.agents/', 'AGENTS.md'],
  classifyError: (error: AgentErrorInfo) => defaultClassifyError(error),
};
