import type { EnvInstall, EnvSystemStatus } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/** environment.progress payload (packages/shared/src/domain/types.ts). */
export interface EnvironmentProgress {
  installId: string;
  item: string;
  version: string;
  stage: 'queued' | 'downloading' | 'verifying' | 'extracting' | 'checking' | 'done' | 'failed';
  receivedBytes?: number;
  totalBytes?: number;
  error?: string;
}

export interface EnvironmentList {
  installs: EnvInstall[];
  system: EnvSystemStatus[];
}

/**
 * P06 client state: installed toolchains, system-item detection and live
 * install progress. Updated from environment.* events; the settings page
 * refetches on demand.
 */
class EnvironmentState {
  installs = $state<EnvInstall[]>([]);
  system = $state<EnvSystemStatus[]>([]);
  /** Latest progress event per install id (card progress bar). */
  progress = $state<Record<string, EnvironmentProgress>>({});
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('environment.changed', (payload) => {
      const data = payload as EnvironmentList;
      this.installs = data.installs;
      this.system = data.system;
    });
    core.onEvent('environment.progress', (payload) => {
      const data = payload as EnvironmentProgress;
      this.progress = { ...this.progress, [data.installId]: data };
      if (data.stage === 'done' || data.stage === 'failed') {
        // Keep the terminal state for the card; the row list refreshes via
        // environment.changed right after.
        const next = { ...this.progress };
        setTimeout(() => {
          if (this.progress[data.installId] === next[data.installId]) {
            const copy = { ...this.progress };
            delete copy[data.installId];
            this.progress = copy;
          }
        }, 8000);
      }
    });
  }

  async refresh(): Promise<EnvironmentList> {
    const result = (await core.call('environment.list')) as EnvironmentList;
    this.installs = result.installs;
    this.system = result.system;
    return result;
  }

  async recheck(): Promise<EnvironmentList> {
    const result = (await core.call('environment.recheck')) as EnvironmentList;
    this.installs = result.installs;
    this.system = result.system;
    return result;
  }

  async remove(id: string): Promise<void> {
    await core.call('environment.remove', { id });
    await this.refresh();
  }

  async reinstall(id: string): Promise<void> {
    await core.call('environment.reinstall', { id });
    await this.refresh();
  }

  progressOf(installId: string): EnvironmentProgress | null {
    return this.progress[installId] ?? null;
  }
}

export const environmentStore = new EnvironmentState();
