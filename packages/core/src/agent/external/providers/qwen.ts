import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import { defaultBridgeToolFromCall } from '../acp/client.js';
import type { AgentProvider, ConfigCheckContext, PermissionTierContext } from '../types.js';
import { stripEnvKeys } from './env.js';
import { genericAcpProvider } from './generic-acp.js';
import { switchToMode } from './mode-tier.js';

/**
 * Qwen Code 0.28.6 ACP differences, verified from the packaged chunks.
 * Approval modes are plan / default / auto-edit / auto / yolo; only plan and
 * default preserve host-mediated approval. MCP calls carry structured
 * `_meta: { toolName, provenance: 'mcp', serverId }`.
 */

export const QWEN_FORBIDDEN_MODES: readonly string[] = ['auto-edit', 'auto', 'yolo'];

export function qwenModeForTier(tier: AgentPermissionTier): string {
  return tier === 'read_only' ? 'plan' : 'default';
}

async function applyQwenTier(tier: AgentPermissionTier, ctx: PermissionTierContext): Promise<void> {
  await switchToMode('Qwen Code', qwenModeForTier(tier), ctx);
}

function ensureQwenSettings(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // A private settings file we cannot parse is unsafe to overwrite silently.
    throw new AppError('AGENT_CONFIG_UNSAFE', `Qwen 私有设置无法解析：${file}`);
  }
  const general =
    typeof settings.general === 'object' && settings.general !== null
      ? (settings.general as Record<string, unknown>)
      : {};
  settings.general = { ...general, enableAutoUpdate: false };
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Qwen loads user skills from `~/.agents/skills/<name>/SKILL.md` (one level). */
function skillFiles(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const skillDir = path.join(dir, name);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
      const file = path.join(skillDir, 'SKILL.md');
      if (statSync(file).isFile()) out.push(file);
    } catch {
      // Missing SKILL.md / unreadable entry: nothing loadable at this level.
    }
  }
}

/** `~/.agents` is read even with a private QWEN_HOME. */
function checkQwenConfig({ loadUserConfig }: ConfigCheckContext): void {
  if (loadUserConfig === true) return;
  const skills = path.join(os.homedir(), '.agents', 'skills');
  const files: string[] = [];
  if (existsSync(skills)) skillFiles(skills, files);
  const risky = files.filter((file) => {
    try {
      return /allowedTools|allowed-tools|hooks\s*:/i.test(readFileSync(file, 'utf8'));
    } catch {
      return true;
    }
  });
  if (risky.length > 0) {
    throw new AppError(
      'AGENT_CONFIG_UNSAFE',
      `Qwen 会加载 ~/.agents/skills 中可绕过宿主确认的 Skill，已拒绝运行：${risky.join('；')}`,
      { issues: risky },
    );
  }
}

function qwenLaunchEnv(ctx: {
  stateDir?: string;
  loadUserConfig?: boolean;
}): Record<string, string> {
  if (ctx.loadUserConfig !== true && ctx.stateDir === undefined) {
    throw new AppError('AGENT_UNAVAILABLE', 'Qwen Code 缺少私有状态目录，无法隔离个人配置');
  }
  if (ctx.loadUserConfig !== true) ensureQwenSettings(ctx.stateDir!);
  return {
    // Qwen only checks for updates once at startup; the host starts a fresh
    // process per idle window, so skipping that check covers every launch
    // without writing into a user's settings file when personal config is on.
    QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
    ...(ctx.loadUserConfig !== true ? { QWEN_HOME: ctx.stateDir! } : {}),
  };
}

export const qwenProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'qwen',
  launch: ({ entry, target, stateDir, loadUserConfig }) => {
    const configured = stripEnvKeys({ ...(entry.distribution.npx?.env ?? {}), ...target.env }, [
      'QWEN_HOME',
    ]);
    return {
      command: target.command,
      args: [...target.args],
      env: { ...configured, ...qwenLaunchEnv({ stateDir, loadUserConfig }) },
    };
  },
  applyPermissionTier: applyQwenTier,
  checkConfig: checkQwenConfig,
  forbiddenModes: QWEN_FORBIDDEN_MODES,
  permissionOptions: { allowOnce: ['proceed_once'], rejectOnce: ['cancel'] },
  bridgeToolFromCall: (toolCall, serverName) => {
    const meta = toolCall._meta;
    if (
      meta?.provenance === 'mcp' &&
      meta.serverId === serverName &&
      typeof meta.toolName === 'string' &&
      meta.toolName.length > 0
    ) {
      return meta.toolName;
    }
    return defaultBridgeToolFromCall(toolCall, serverName, (server, tool) =>
      genericAcpProvider.toolName(server, tool),
    );
  },
  features: {
    steering: false,
    loadSession: true,
    resume: true,
    osSandbox: false,
    httpMcp: true,
    // Requires a real two-session prompt test before enabling concurrency.
    parallelSessions: false,
  },
  agentSideConfigFiles: ['QWEN.md', 'AGENTS.md', '.qwen/', '.agents/'],
  sessionNotFound: (error) => {
    const candidate = (error ?? {}) as { code?: unknown; message?: unknown };
    return (
      candidate.code === -32603 &&
      typeof candidate.message === 'string' &&
      candidate.message.includes('Session not found:')
    );
  },
};
