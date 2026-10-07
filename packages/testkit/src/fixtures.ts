import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCore, type CoreHarness, type Keystore } from '@kepcup/core';
import type { TimerScheduler } from '@kepcup/core';

export interface TestHome {
  home: string;
  cleanup(): Promise<void>;
}

/** Creates a temporary KEPCUP_HOME; remove in test teardown. */
export async function createTestHome(prefix = 'kepcup-test-'): Promise<TestHome> {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  return {
    home,
    async cleanup() {
      await rm(home, { recursive: true, force: true });
    },
  };
}

export type { CoreHarness };

export interface CreateTestCoreOptions {
  home?: string;
  appVersion?: string;
  /** Extra environment overrides (e.g. KEPCUP_MOCK_LLM_URL). */
  env?: NodeJS.ProcessEnv;
  /** Shared keystore for tests that restart the core on the same home. */
  keystore?: Keystore;
  /** P06 test hook: replaces the pinned catalog (never hits real servers). */
  envCatalog?: unknown;
  /** P06 test hooks: system-item action/detection overrides. */
  envManagerHooks?: unknown;
  /** P07 test hook: replaces the configured embedder (deterministic vectors). */
  memoryEmbedder?: unknown;
  /** P10: controllable clock (paired with a TestClock timer scheduler). */
  clock?: unknown;
  /** P10: virtual timer arming driven by the controllable clock. */
  timers?: TimerScheduler;
  /** P11 test hook: fake browser host (pages/cookies/downloads assertions). */
  browserRpc?: unknown;
  /** P12 test hook: replaces the enhanced-level backend (Lima/Podman stub). */
  enhancedSandbox?: unknown;
  /** P12 test hook: fake distro-internal toolchain installer (Windows flows). */
  distroInstaller?: unknown;
  /** P12 test hook: platform override for the environment manager. */
  platform?: string;
  /** P13 修复轮 test hook (BR-P13-006): diagnostics disk-walk entry budget. */
  diskUsageBudget?: number;
  /** D72 test hooks: extra catalog entries / launch targets / in-process agents. */
  agentCatalog?: unknown[];
  agentLaunch?: (entry: { id: string }) => {
    command: string;
    args: string[];
    env: Record<string, string>;
  } | null;
  agentSpawn?: unknown;
}

/**
 * Starts the core in-process with the memory keystore and a temporary home.
 * Defaults follow docs/dev/05-testing.md ("Test fixtures").
 */
export async function createTestCore(options: CreateTestCoreOptions = {}): Promise<CoreHarness> {
  return createCore({
    home: options.home,
    appVersion: options.appVersion ?? '0.0.0-test',
    env: { NODE_ENV: 'test', KEPCUP_KEYSTORE: 'memory', ...options.env },
    ...(options.keystore ? { keystore: options.keystore } : {}),
    ...(options.envCatalog !== undefined ? { envCatalog: options.envCatalog as never } : {}),
    ...(options.envManagerHooks !== undefined
      ? { envManagerHooks: options.envManagerHooks as never }
      : {}),
    ...(options.memoryEmbedder !== undefined
      ? { memoryEmbedder: options.memoryEmbedder as never }
      : {}),
    ...(options.clock !== undefined ? { clock: options.clock as never } : {}),
    ...(options.timers !== undefined ? { timers: options.timers } : {}),
    ...(options.browserRpc !== undefined ? { browserRpc: options.browserRpc as never } : {}),
    ...(options.enhancedSandbox !== undefined ? { enhancedSandbox: options.enhancedSandbox as never } : {}),
    ...(options.distroInstaller !== undefined ? { distroInstaller: options.distroInstaller as never } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.diskUsageBudget !== undefined ? { diskUsageBudget: options.diskUsageBudget } : {}),
    ...(options.agentCatalog !== undefined ? { agentCatalog: options.agentCatalog as never } : {}),
    ...(options.agentLaunch !== undefined ? { agentLaunch: options.agentLaunch } : {}),
    ...(options.agentSpawn !== undefined ? { agentSpawn: options.agentSpawn as never } : {}),
  });
}
