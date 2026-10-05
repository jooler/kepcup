import { unattendedStateSchema, type UnattendedState } from '@kepcup/shared';
import type { SettingsService } from '../domain/settings.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';

export interface UnattendedDeps {
  settings: SettingsService;
  clock: Clock;
  logger: CoreLogger;
  /** Publishes `unattended.changed` (and the port-B tray notification). */
  publish: (state: UnattendedState) => void;
}

/**
 * Unattended mode (docs/design/13-permissions.md "无人值守模式"): global,
 * opt-in, optionally time-boxed. While active, approvals auto-approve (the
 * approvals service owns that decision); the data directory stays untouchable.
 * State persists in settings.unattended; only the UI / tray RPCs write it.
 */
export class UnattendedService {
  readonly #deps: UnattendedDeps;

  constructor(deps: UnattendedDeps) {
    this.#deps = deps;
  }

  get(): UnattendedState {
    return this.#deps.settings.get().unattended;
  }

  /** Current state with the time box applied (auto-off past `until`). */
  effective(): UnattendedState {
    const state = this.get();
    if (!state.enabled) return state;
    if (state.until !== null && this.#deps.clock.now() >= state.until) {
      return this.disable('时间到，自动关闭');
    }
    return state;
  }

  enable(input: { hours: number | null; acknowledgeRisk: true }): UnattendedState {
    const now = this.#deps.clock.now();
    const state = unattendedStateSchema.parse({
      enabled: true,
      until: input.hours !== null ? now + input.hours * 3_600_000 : null,
      enabledAt: now,
    });
    this.#save(state);
    this.#deps.logger.warn({ until: state.until }, 'unattended mode enabled');
    return state;
  }

  disable(reason?: string): UnattendedState {
    const current = this.get();
    if (!current.enabled) return current;
    const state = unattendedStateSchema.parse({ enabled: false, until: null, enabledAt: null });
    this.#save(state);
    this.#deps.logger.info({ reason: reason ?? 'manual' }, 'unattended mode disabled');
    return state;
  }

  /** Expiry check for timers; safe to call when already off. */
  checkExpiry(): UnattendedState {
    return this.effective();
  }

  #save(state: UnattendedState): void {
    this.#deps.settings.update({ unattended: state });
    this.#deps.publish(state);
  }
}
