import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import type { AgentProvider, PermissionTierContext } from '../types.js';
import { stripEnvKeys } from './env.js';
import { genericAcpProvider } from './generic-acp.js';
import { switchToMode } from './mode-tier.js';

/**
 * GitHub Copilot CLI 1.0.116 ACP differences, verified from the packaged
 * runtime. `agent` is its ordinary interactive mode, not Codex's AI reviewer;
 * `autopilot` is autonomous and must never be selected by the host.
 */

export const COPILOT_FORBIDDEN_MODES: readonly string[] = ['autopilot'];

export function copilotModeForTier(tier: AgentPermissionTier): string {
  return tier === 'read_only' ? 'plan' : 'agent';
}

async function applyCopilotTier(
  tier: AgentPermissionTier,
  ctx: PermissionTierContext,
): Promise<void> {
  await switchToMode('GitHub Copilot', copilotModeForTier(tier), ctx);
}

function copilotLaunchEnv(ctx: {
  stateDir?: string;
  loadUserConfig?: boolean;
}): Record<string, string> {
  if (ctx.loadUserConfig !== true && ctx.stateDir === undefined) {
    throw new AppError('AGENT_UNAVAILABLE', 'GitHub Copilot 缺少私有状态目录，无法隔离个人配置');
  }
  return {
    COPILOT_AUTO_UPDATE: 'false',
    ...(ctx.loadUserConfig !== true ? { COPILOT_HOME: ctx.stateDir! } : {}),
    COPILOT_DISABLE_LOGIN_SHELL_ENV: '1',
  };
}

export const copilotProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'copilot',
  launch: ({ entry, target, stateDir, loadUserConfig }) => {
    const configured = stripEnvKeys({ ...(entry.distribution.npx?.env ?? {}), ...target.env }, [
      'COPILOT_HOME',
    ]);
    return {
      command: target.command,
      args: [...target.args],
      env: { ...configured, ...copilotLaunchEnv({ stateDir, loadUserConfig }) },
    };
  },
  applyPermissionTier: applyCopilotTier,
  forbiddenModes: COPILOT_FORBIDDEN_MODES,
  // Copilot's `agent` mode still routes tool approvals through ACP.
  safeModes: ['agent'],
  permissionOptions: { allowOnce: ['allow_once'], rejectOnce: ['reject_once'] },
  features: {
    steering: false,
    loadSession: true,
    resume: true,
    osSandbox: false,
    httpMcp: true,
    // Binary-only package: enable only after a real two-session prompt test.
    parallelSessions: false,
  },
  agentSideConfigFiles: [
    'AGENTS.md',
    '.github/copilot-instructions.md',
    '.github/copilot/settings.json',
    '.github/copilot/settings.local.json',
    '.github/mcp.json',
    '.mcp.json',
    '.agents/',
    'hooks/',
    'extensions/',
    'plugins/',
  ],
};
