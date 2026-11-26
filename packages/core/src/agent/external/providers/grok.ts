import { lstatSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import { defaultClassifyError, type AgentErrorInfo } from '../errors.js';
import type { AgentProvider } from '../types.js';
import { stripEnvKeys } from './env.js';
import { genericAcpProvider } from './generic-acp.js';

/**
 * Grok Build 1.0.92 ACP differences, verified from the packaged binary and its
 * embedded documentation. Permission tiers are fixed when the session opens:
 * the no-subagents plan profile is read-only, while ask-user keeps tool
 * approvals interactive. There is no host-selected ACP mode switch.
 */

const GROK_AUTH_MESSAGES: readonly string[] = [
  'Not signed in',
  'set the XAI_API_KEY',
  'Authentication required',
];

export function grokProfileForTier(tier: AgentPermissionTier): string {
  return tier === 'read_only' ? 'grok-build-plan-no-subagents' : 'grok-build-ask-user';
}

/**
 * Whether `$GROK_HOME/bin/grok` is this catalog version's managed binary.
 *
 * The npm bootstrap returns the canonical path whenever it exists, without
 * checking the version, and `npm ci --ignore-scripts` skips postinstall — so a
 * binary cached by an older catalog version would keep running after upgrade.
 * `pinned` = confirmed current; `missing` = bootstrap will extract the pinned
 * version; `other` = stale/unknown.
 */
export function grokBinaryState(
  home: string,
  version: string,
  platform: NodeJS.Platform,
): 'pinned' | 'missing' | 'other' {
  const exe = platform === 'win32' ? '.exe' : '';
  const canonical = path.join(home, 'bin', `grok${exe}`);
  const versionedName = `grok-${version}${exe}`;
  let canonicalStat;
  try {
    canonicalStat = lstatSync(canonical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'other';
  }
  if (canonicalStat.isSymbolicLink()) {
    let target: string;
    try {
      // postinstall/bootstrap always link to the bare `grok-<version>` name.
      target = readlinkSync(canonical);
    } catch {
      return 'other';
    }
    if (target !== versionedName) return 'other';
    try {
      statSync(canonical);
      return 'pinned';
    } catch {
      // Dangling pinned link: bootstrap re-extracts it on launch.
      return 'missing';
    }
  }
  // Windows (and hand-copied Unix binaries): postinstall/bootstrap copy instead
  // of symlinking. The pinned version's file must exist and match the copy.
  // Standalone Windows installs keep it under `downloads/grok-<version>-<os>-<arch>.exe`.
  const candidates = [path.join(home, 'bin', versionedName)];
  if (platform === 'win32') {
    try {
      for (const name of readdirSync(path.join(home, 'downloads'))) {
        if (name.startsWith(`grok-${version}-`) && name.toLowerCase().endsWith('.exe')) {
          candidates.push(path.join(home, 'downloads', name));
        }
      }
    } catch {
      // No standalone downloads directory: only the npm layout applies.
    }
  }
  for (const candidate of candidates) {
    try {
      const versioned = statSync(candidate);
      if (
        canonicalStat.size === versioned.size &&
        canonicalStat.mtimeMs + 2_000 >= versioned.mtimeMs
      ) {
        return 'pinned';
      }
    } catch {
      // Try the next layout.
    }
  }
  return 'other';
}

/** Remove a stale canonical binary so the pinned package's bootstrap re-extracts it. */
function resetStaleGrokBinary(home: string, version: string, platform: NodeJS.Platform): void {
  if (grokBinaryState(home, version, platform) !== 'other') return;
  const exe = platform === 'win32' ? '.exe' : '';
  rmSync(path.join(home, 'bin', `grok${exe}`), { force: true });
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return typeof error === 'string' ? error : '';
}

export const grokProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'grok',
  launch: ({ entry, target, stateDir, loadUserConfig }) => {
    if (loadUserConfig !== true && stateDir === undefined) {
      throw new AppError('AGENT_UNAVAILABLE', 'Grok Build 缺少私有状态目录，无法隔离个人配置');
    }
    // The user's own Grok home is only shared on explicit opt-in; its binary is
    // never replaced, so a different version is refused instead of downgraded.
    const home = loadUserConfig === true ? path.join(os.homedir(), '.grok') : stateDir!;
    if (loadUserConfig === true) {
      if (grokBinaryState(home, entry.version, process.platform) === 'other') {
        throw new AppError(
          'AGENT_CONFIG_UNSAFE',
          `个人 Grok 安装（~/.grok/bin/grok）不是目录锁定的 ${entry.version} 版本。请先运行 \`grok update\`，或关闭「加载我的个人配置」使用 KepCup 管理的版本。`,
        );
      }
    } else {
      resetStaleGrokBinary(home, entry.version, process.platform);
    }
    const configured = stripEnvKeys({ ...(entry.distribution.npx?.env ?? {}), ...target.env }, [
      'GROK_HOME',
    ]);
    return {
      command: target.command,
      args: [...target.args],
      env: {
        ...configured,
        GROK_DISABLE_AUTOUPDATER: '1',
        // Keep the managed wrapper on its own binary; only user config is shared.
        ...(loadUserConfig === true ? {} : { GROK_HOME: stateDir! }),
        GROK_MANAGED_BY_NPM: '1',
      },
    };
  },
  sessionNew: ({ permission }) => ({
    _meta: {
      agentProfile: grokProfileForTier(permission),
      yoloMode: false,
      autoMode: false,
    },
  }),
  permissionOptions: { allowOnce: ['allow_once'], rejectOnce: ['reject_once'] },
  toolName: (server, tool) => `${server}__${tool}`,
  features: {
    steering: false,
    loadSession: true,
    resume: true,
    osSandbox: false,
    httpMcp: true,
    // Binary-only package: enable only after a real two-session prompt test.
    parallelSessions: false,
  },
  agentSideConfigFiles: ['.grok/', '.agents/', '.claude/', 'AGENTS.md'],
  classifyError: (error: AgentErrorInfo) =>
    defaultClassifyError(error) === 'auth_required' ||
    GROK_AUTH_MESSAGES.some((message) => error.message.includes(message))
      ? 'auth_required'
      : 'other',
  sessionNotFound: (error) => {
    const message = messageOf(error);
    return (
      message.includes('unknown session id:') ||
      message.includes('session is not loaded') ||
      message.includes('is not loaded in this process')
    );
  },
};
