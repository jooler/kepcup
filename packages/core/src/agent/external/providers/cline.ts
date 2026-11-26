import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import type { AgentProvider, ConfigCheckContext, PermissionTierContext } from '../types.js';
import { stripEnvKeys } from './env.js';
import { genericAcpProvider } from './generic-acp.js';
import { switchToMode } from './mode-tier.js';

/**
 * Cline 3.0.76 ACP differences, verified from the packaged Bun bundle.
 * `plan` is read-only; `act` sends one-shot permission requests. The bundle
 * stores sessions in a Map and keeps the abort controller on each session.
 */

export function clineModeForTier(tier: AgentPermissionTier): string {
  return tier === 'read_only' ? 'plan' : 'act';
}

async function applyClineTier(
  tier: AgentPermissionTier,
  ctx: PermissionTierContext,
): Promise<void> {
  await switchToMode('Cline', clineModeForTier(tier), ctx);
  // Cline's real auto-approval switch is a session config option, not _meta.
  const option = ctx.configOptions.find((candidate) => candidate.id === 'auto_approve');
  if (option?.type === 'boolean' && option.currentValue !== false) {
    await ctx.setConfigOption(option.id, 'false');
  } else if (option?.type === 'select' && option.currentValue !== 'false') {
    const values = (
      option.options as ReadonlyArray<{ value?: string; options?: Array<{ value: string }> }>
    ).flatMap((entry) =>
      entry.value !== undefined ? [entry.value] : (entry.options ?? []).map((inner) => inner.value),
    );
    if (values.includes('false')) await ctx.setConfigOption(option.id, 'false');
  }
}

function clineLaunchEnv(ctx: {
  stateDir?: string;
  loadUserConfig?: boolean;
}): Record<string, string> {
  const updateEnv = { CLINE_NO_AUTO_UPDATE: '1' };
  if (ctx.loadUserConfig === true) return updateEnv;
  if (ctx.stateDir === undefined) {
    throw new AppError('AGENT_UNAVAILABLE', 'Cline 缺少私有状态目录，无法隔离个人配置');
  }
  return {
    ...updateEnv,
    CLINE_DIR: ctx.stateDir,
    CLINE_DATA_DIR: path.join(ctx.stateDir, 'data'),
  };
}

function hasEntries(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function riskyAgentSkills(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const skillDir = path.join(dir, name);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
      const file = path.join(skillDir, 'SKILL.md');
      if (
        statSync(file).isFile() &&
        /allowedTools|allowed-tools|hooks\s*:/i.test(readFileSync(file, 'utf8'))
      ) {
        out.push(file);
      }
    } catch {
      // No SKILL.md at this level.
    }
  }
  return out;
}

function checkClineConfig({ loadUserConfig }: ConfigCheckContext): void {
  if (loadUserConfig === true) return;
  const home = os.homedir();
  const risky = [
    path.join(home, 'Documents', 'Cline', 'Hooks'),
    path.join(home, 'Documents', 'Cline', 'Plugins'),
  ]
    .filter((dir) => existsSync(dir) && hasEntries(dir))
    .concat(riskyAgentSkills(path.join(home, '.agents', 'skills')));
  if (risky.length > 0) {
    throw new AppError(
      'AGENT_CONFIG_UNSAFE',
      `Cline 会加载 KepCup 无法隔离的个人 Hooks / Plugins / Skills，已拒绝运行。请移除或清空：${risky.join('；')}`,
      { issues: risky },
    );
  }
}

export const clineProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'cline',
  launch: ({ entry, target, stateDir, loadUserConfig }) => {
    const configured = stripEnvKeys({ ...(entry.distribution.npx?.env ?? {}), ...target.env }, [
      'CLINE_DIR',
      'CLINE_DATA_DIR',
    ]);
    return {
      command: target.command,
      args: [...target.args],
      env: { ...configured, ...clineLaunchEnv({ stateDir, loadUserConfig }) },
    };
  },
  // auto-approval defaults off in Cline ACP; applyPermissionTier also forces
  // the `auto_approve` config option off when the agent advertises it.
  applyPermissionTier: applyClineTier,
  checkConfig: checkClineConfig,
  permissionOptions: { allowOnce: ['allow_once'], rejectOnce: ['reject_once'] },
  features: {
    steering: false,
    loadSession: true,
    resume: false,
    osSandbox: false,
    httpMcp: true,
    // Requires a real two-session prompt test before enabling concurrency.
    parallelSessions: false,
  },
  agentSideConfigFiles: ['.cline/', '.clinerules/', '.agents/', 'AGENTS.md'],
  sessionNotFound: (error) => {
    const candidate = (error ?? {}) as { code?: unknown; message?: unknown };
    return (
      candidate.code === -32603 &&
      typeof candidate.message === 'string' &&
      candidate.message.includes('unknown session:')
    );
  },
};
