import path from 'node:path';
import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import { defaultClassifyError, type AgentErrorInfo } from '../errors.js';
import type { AgentProvider, PermissionTierContext } from '../types.js';
import { stripEnvKeys } from './env.js';
import { genericAcpProvider } from './generic-acp.js';
import { switchToMode } from './mode-tier.js';

/**
 * Kimi Code 2.8.1（`kimi acp`）：Kimi CLI Legacy 1.52.0 的继任实现。
 * Legacy 的 `kimi acp` 入口已经只打印弃用提示并退出，因此目录改为 npm 分发的
 * `@moonshot-ai/kimi-code`。本 Provider 覆盖与通用实现的差异：
 *
 * - modes：`default` / `plan` / `auto` / `yolo`；read_only → `plan`，其余 →
 *   `default`，`auto` / `yolo` 永不进入；
 * - 权限：`approve_once` / `approve_always` / `reject`（只选一次性与 reject）；
 * - 私有 `KIMI_CODE_HOME`：隔离 config / sessions / OAuth；「加载我的个人配置」
 *   开启时沿用用户目录；
 * - 会话：ACP 原生支持 load / resume / delete / fork，会话状态按 sessionId
 *   分表，可同进程并行；未声明 steering；
 * - 「会话不存在」：ACP server 抛 40404（部分 SDK 路径表现为 -32602 +
 *   `data.sessionId`），另有 `Session not found:` 文案兜底；
 * - 登录：`kimi login`（设备码）；ACP terminal auth 执行 `kimi acp --login`。
 */

/** 永不进入的模式。 */
export const KIMI_FORBIDDEN_MODES: readonly string[] = ['auto', 'yolo'];

export function kimiModeForTier(tier: AgentPermissionTier): string {
  return tier === 'read_only' ? 'plan' : 'default';
}

async function applyKimiTier(tier: AgentPermissionTier, ctx: PermissionTierContext): Promise<void> {
  await switchToMode('Kimi Code', kimiModeForTier(tier), ctx);
}

function kimiLaunchEnv(ctx: {
  stateDir?: string;
  loadUserConfig?: boolean;
}): Record<string, string> {
  const updateEnv = { KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1' };
  if (ctx.loadUserConfig === true) return updateEnv;
  if (ctx.stateDir === undefined) {
    throw new AppError('AGENT_UNAVAILABLE', 'Kimi Code 缺少私有状态目录，无法隔离个人配置');
  }
  return { ...updateEnv, KIMI_CODE_HOME: path.resolve(ctx.stateDir) };
}

export const kimiProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'kimi',
  launch: ({ entry, target, stateDir, loadUserConfig }) => {
    const configured = stripEnvKeys({ ...(entry.distribution.npx?.env ?? {}), ...target.env }, [
      'KIMI_CODE_HOME',
    ]);
    return {
      command: target.command,
      args: [...target.args],
      env: { ...configured, ...kimiLaunchEnv({ stateDir, loadUserConfig }) },
    };
  },
  instructionMode: 'prompt-prefix',
  applyPermissionTier: applyKimiTier,
  forbiddenModes: KIMI_FORBIDDEN_MODES,
  permissionOptions: { allowOnce: ['approve_once'], rejectOnce: ['reject'] },
  features: {
    steering: false,
    loadSession: true,
    resume: true,
    osSandbox: false,
    httpMcp: true,
    // Requires a real two-session prompt test before enabling concurrency.
    parallelSessions: false,
  },
  agentSideConfigFiles: ['.kimi-code/', 'AGENTS.md', '.agents/'],
  sessionNotFound: (error) => {
    const candidate = (error ?? {}) as {
      code?: unknown;
      message?: unknown;
      data?: unknown;
    };
    if (candidate.code === 40404) return true;
    if (candidate.code === -32602) {
      const data = candidate.data as { sessionId?: unknown } | null | undefined;
      if (data !== null && typeof data === 'object' && typeof data.sessionId === 'string')
        return true;
    }
    return (
      typeof candidate.message === 'string' && candidate.message.includes('Session not found:')
    );
  },
  classifyError: (error: AgentErrorInfo) => defaultClassifyError(error),
};
