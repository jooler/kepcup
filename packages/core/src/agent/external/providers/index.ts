import {
  AGENT_DEFAULT_CONCURRENCY,
  AppError,
  agentEngineKey,
  type AgentCatalogEntry,
} from '@kepcup/shared';
// Registers the dev-time global default for __KEPCUP_TEST_HOOKS__ (tsc output).
import '../../../infra/test-hooks.js';
import { approvedReleaseGates } from '../catalog.js';
import type { AgentProvider, ProviderRegistry } from '../types.js';
import { antigravityProvider } from './antigravity.js';
import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';
import { cursorProvider } from './cursor.js';
import { dshProvider } from './dsh.js';
import { genericAcpProvider } from './generic-acp.js';
import { opencodeProvider } from './opencode.js';

/**
 * PROVIDERS 登记表（D72 §10）：目录条目的 `provider` 字段 → Provider 模块。
 * 新增有差异的 Agent 时在 `providers/` 新建模块并在此加一行。
 */
export const PROVIDERS: ProviderRegistry = {
  'generic-acp': genericAcpProvider,
  claude: claudeProvider,
  codex: codexProvider,
  opencode: opencodeProvider,
  dsh: dshProvider,
  cursor: cursorProvider,
  antigravity: antigravityProvider,
};

export function providerFor(
  entry: AgentCatalogEntry,
  registry: ProviderRegistry = PROVIDERS,
): AgentProvider {
  const provider = registry[entry.provider];
  if (provider === undefined) {
    throw new AppError(
      'AGENT_UNAVAILABLE',
      `智能体「${entry.name}」的 Provider「${entry.provider}」未登记`,
    );
  }
  return provider;
}

/**
 * Whether a background session (`SessionContext.oneShot`) of this entry runs
 * without any native tool (审查 S1): the provider declares it
 * (`backgroundNoNativeTools`), or the entry is the testkit fake agent
 * (`testkitExempt`).
 */
export function backgroundToolFree(entry: AgentCatalogEntry, provider: AgentProvider): boolean {
  if (provider.backgroundNoNativeTools === true) return true;
  return testkitExempt(entry);
}

/**
 * Whether one process of this entry may have prompts in flight on several
 * sessions at once (`features.parallelSessions`, design 28 §7 / §9.2). The
 * testkit fake agent keeps all prompt state per session, so it is exempt in
 * test / dev builds exactly like `backgroundToolFree`.
 */
export function parallelSessionsFor(entry: AgentCatalogEntry, provider: AgentProvider): boolean {
  return provider.features.parallelSessions || testkitExempt(entry);
}

/**
 * Effective scheduler concurrency for `agent:{id}` — the single source of
 * truth for the scheduler, the background-routing blocker and the settings
 * view. Agents with parallel sessions: the user's override
 * (`providerConcurrency['agent:{id}']`) or `AGENT_DEFAULT_CONCURRENCY`, 1..16.
 * Agents without (or whose provider is not registered): always 1 — a user
 * override above 1 is clamped (fail-safe: their processes run every session
 * of the agent, and concurrent prompts on two sessions were never verified).
 */
export function agentConcurrency(
  providerConcurrency: Readonly<Record<string, number | undefined>>,
  entry: AgentCatalogEntry,
  registry: ProviderRegistry = PROVIDERS,
): number {
  let parallel: boolean;
  try {
    parallel = parallelSessionsFor(entry, providerFor(entry, registry));
  } catch {
    parallel = false;
  }
  if (!parallel) return 1;
  const override = providerConcurrency[agentEngineKey(entry.id)];
  return Math.max(1, Math.min(16, override ?? AGENT_DEFAULT_CONCURRENCY));
}

/**
 * The testkit fake agent (scripted, no native tools, per-session state,
 * never shipped). The exemption holds only in test / dev builds — test hooks
 * on and no release gates pinned; the packaged build
 * (`__KEPCUP_TEST_HOOKS__=false`, gates injected, dist.mjs refuses a
 * `testkit` gate) never grants it.
 */
function testkitExempt(entry: AgentCatalogEntry): boolean {
  return (
    entry.releaseGate === 'testkit' &&
    __KEPCUP_TEST_HOOKS__ === true &&
    approvedReleaseGates() === null
  );
}
