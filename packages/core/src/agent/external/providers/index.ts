import { AppError, type AgentCatalogEntry } from '@kepcup/shared';
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
 * (`backgroundNoNativeTools`), or the entry is a testkit fake agent (scripted,
 * no native tools, never shipped). The testkit exemption holds only in test /
 * dev builds — test hooks on and no release gates pinned; the packaged build
 * (`__KEPCUP_TEST_HOOKS__=false`, gates injected, dist.mjs refuses a
 * `testkit` gate) never grants it.
 */
export function backgroundToolFree(entry: AgentCatalogEntry, provider: AgentProvider): boolean {
  if (provider.backgroundNoNativeTools === true) return true;
  return (
    entry.releaseGate === 'testkit' &&
    __KEPCUP_TEST_HOOKS__ === true &&
    approvedReleaseGates() === null
  );
}
