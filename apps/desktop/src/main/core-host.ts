import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from 'electron';
import {
  CORE_RESTART_BACKOFF_MS,
  CORE_RESTART_FAILURE_WINDOW_MS,
  CORE_RESTART_MAX_FAILURES,
  createRpcChannel,
  platformAutostartPayloadSchema,
  platformNotifyPayloadSchema,
  platformUnattendedPayloadSchema,
  type CoreStatusPayload,
  type RpcChannel,
  type RpcMethodSpec,
} from '@kepcup/shared';

export type CoreProcessState = 'up' | 'down' | 'failed';

export interface CoreHostEvents {
  onStatus(listener: (payload: CoreStatusPayload) => void): () => void;
  onState(listener: (state: CoreProcessState) => void): () => void;
  /** Core asks the main process to show a system notification (P03). */
  onNotify(listener: (payload: { conversationId: string | null; title: string; body: string }) => void): () => void;
  /** Unattended-mode state changed (tray indicator). */
  onUnattended(listener: (payload: { active: boolean; until: number | null }) => void): () => void;
  /** Launch-at-login setting changed or was pushed at bind (P13 任务 3). */
  onAutostart(listener: (payload: { enabled: boolean }) => void): () => void;
}

function portToTransport(port: MessagePortMain) {
  return {
    post: (data: unknown) => port.postMessage(data),
    onData: (handler: (data: unknown) => void) => {
      const listener = (event: Electron.MessageEvent) => handler(event.data);
      port.on('message', listener);
      return () => port.off('message', listener);
    },
    close: () => port.close(),
  };
}

export interface CoreHostOptions {
  /**
   * Methods the MAIN process serves to the core on port B (P11: browser.*).
   * One birpc channel serves these and calls the core's platform methods —
   * two instances on one transport would both answer the same request id.
   */
  serverMethods?: Record<string, RpcMethodSpec>;
}

/**
 * Forks and supervises the core service process. Crash policy per
 * docs/dev/02-architecture.md: restart with 1s/2s/5s backoff; five failures
 * inside one minute stop the restarts. The platform port (B) is created on
 * every fork and carries `core.status` back to the main process.
 */
export class CoreHost implements CoreHostEvents {
  private proc: UtilityProcess | null = null;
  private platformClient: RpcChannel | null = null;
  private failureTimes: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private quitting = false;
  private readonly statusListeners = new Set<(payload: CoreStatusPayload) => void>();
  private readonly stateListeners = new Set<(state: CoreProcessState) => void>();
  private readonly notifyListeners = new Set<
    (payload: { conversationId: string | null; title: string; body: string }) => void
  >();
  private readonly unattendedListeners = new Set<
    (payload: { active: boolean; until: number | null }) => void
  >();
  private readonly autostartListeners = new Set<(payload: { enabled: boolean }) => void>();

  constructor(
    private readonly appVersion: string,
    private readonly options: CoreHostOptions = {},
  ) {}

  start(): void {
    this.fork();
  }

  markQuitting(): void {
    this.quitting = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
  }

  /** Graceful shutdown over port B; resolves once the process is gone. */
  async shutdown(timeoutMs: number): Promise<void> {
    this.markQuitting();
    const proc = this.proc;
    if (!proc) return;
    try {
      await this.withTimeout(
        this.platformClient?.call('system.shutdown') ?? Promise.resolve(),
        timeoutMs,
      );
    } catch {
      proc.kill();
    }
    await this.waitForExit(proc, timeoutMs);
  }

  process(): UtilityProcess | null {
    return this.proc;
  }

  /** RPC call over port B (system.shutdown, unattended.*, power.*). */
  callPlatform(method: string, input?: unknown): Promise<unknown> {
    if (!this.platformClient) {
      // Events fired while the core is down (e.g. power.resume during a
      // restart window) are dropped; startup catch-up re-fires schedules.
      return Promise.reject(new Error('core platform port not connected'));
    }
    return this.platformClient.call(method, input);
  }
  onStatus(listener: (payload: CoreStatusPayload) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onState(listener: (state: CoreProcessState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onNotify(
    listener: (payload: { conversationId: string | null; title: string; body: string }) => void,
  ): () => void {
    this.notifyListeners.add(listener);
    return () => this.notifyListeners.delete(listener);
  }

  onUnattended(listener: (payload: { active: boolean; until: number | null }) => void): () => void {
    this.unattendedListeners.add(listener);
    return () => this.unattendedListeners.delete(listener);
  }

  onAutostart(listener: (payload: { enabled: boolean }) => void): () => void {
    this.autostartListeners.add(listener);
    return () => this.autostartListeners.delete(listener);
  }

  private fork(): void {
    const proc = utilityProcess.fork(join(__dirname, 'core-entry/index.js'), [], {
      serviceName: 'kepcup-core',
      env: {
        ...process.env,
        KEPCUP_APP_VERSION: this.appVersion,
        ...this.bundledBinEnv(),
        ...this.presetSkillsEnv(),
        ...this.connectorsEnv(),
      },
    });
    this.proc = proc;

    const { port1, port2 } = new MessageChannelMain();
    proc.postMessage({ type: 'platform-port' }, [port1]);
    port2.start();
    // One channel both serves browser.* (P11) to the core and calls the
    // core's platform methods (system.shutdown / power.*).
    this.platformClient = createRpcChannel({
      transport: portToTransport(port2),
      methods: this.options.serverMethods ?? {},
      eventHandlers: {
        'core.status': (payload) => {
          const parsed = payload as CoreStatusPayload;
          if (parsed.status === 'ready') {
            this.failureTimes = [];
            this.emitState('up');
          }
          for (const listener of this.statusListeners) listener(parsed);
        },
        'platform.notify': (payload) => {
          const parsed = platformNotifyPayloadSchema.safeParse(payload);
          if (!parsed.success) return;
          for (const listener of this.notifyListeners) listener(parsed.data);
        },
        'platform.unattended': (payload) => {
          const parsed = platformUnattendedPayloadSchema.safeParse(payload);
          if (!parsed.success) return;
          for (const listener of this.unattendedListeners) listener(parsed.data);
        },
        'platform.autostart': (payload) => {
          const parsed = platformAutostartPayloadSchema.safeParse(payload);
          if (!parsed.success) return;
          for (const listener of this.autostartListeners) listener(parsed.data);
        },
      },
    });

    proc.on('exit', () => this.handleExit());
  }

  /**
   * Bundled binaries live inside the packaged resources; the core process
   * cannot locate them by walking up from its own module in an asar.
   */
  private bundledBinEnv(): NodeJS.ProcessEnv {
    const dir = join(process.resourcesPath ?? '', 'bin', `${process.platform}-${process.arch}`);
    return existsSync(dir) ? { KEPCUP_BUNDLED_BIN: dir } : {};
  }

  /** Skill-marketplace preset catalog, also an extraResource (see paths.ts). */
  private presetSkillsEnv(): NodeJS.ProcessEnv {
    const dir = join(process.resourcesPath ?? '', 'preset-skills');
    return existsSync(dir) ? { KEPCUP_PRESET_SKILLS: dir } : {};
  }

  /** Connected-apps catalog (D73), an extraResource too (see core apps/catalog.ts). */
  private connectorsEnv(): NodeJS.ProcessEnv {
    const dir = join(process.resourcesPath ?? '', 'connectors');
    return existsSync(dir) ? { KEPCUP_CONNECTORS: dir } : {};
  }

  private handleExit(): void {
    this.proc = null;
    // Pending browser.* calls die with the core process; fail them now.
    this.platformClient?.rejectPending('core process exited');
    this.platformClient = null;
    if (this.quitting) return;

    this.emitState('down');
    const now = Date.now();
    this.failureTimes = this.failureTimes.filter((t) => now - t < CORE_RESTART_FAILURE_WINDOW_MS);
    this.failureTimes.push(now);

    if (this.failureTimes.length >= CORE_RESTART_MAX_FAILURES) {
      this.emitState('failed');
      return;
    }
    const attempt = Math.min(this.failureTimes.length - 1, CORE_RESTART_BACKOFF_MS.length - 1);
    this.restartTimer = setTimeout(() => this.fork(), CORE_RESTART_BACKOFF_MS[attempt]);
  }

  private emitState(state: CoreProcessState): void {
    for (const listener of this.stateListeners) listener(state);
  }

  private withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('shutdown timed out')), timeoutMs);
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private waitForExit(proc: UtilityProcess, timeoutMs: number): Promise<void> {
    if (!this.proc) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, timeoutMs);
      timer.unref?.();
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
