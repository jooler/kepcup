import {
  AppError,
  permissionModeStateSchema,
  type PermissionMode,
  type PermissionModeSource,
  type PermissionModeState,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';

type ElevatedMode = Exclude<PermissionMode, 'manual'>;

interface ModeEntry {
  mode: ElevatedMode;
  enabledAt: number;
  until: number | null;
}

export interface PermissionModeDeps {
  clock: Clock;
  logger: CoreLogger;
  /** Publishes `permissions.mode.changed`. */
  publish: (state: PermissionModeState) => void;
  /**
   * Maps a run's conversation to the conversation that owns its setting:
   * a delegation exchange (`bot_direct`) inherits from the delegating chat,
   * a board-card chat inherits from its project conversation.
   */
  resolveScope?: (conversationId: string) => string;
  /** Global unattended switch — when on, every conversation runs at `bypass`. */
  unattended?: { effective(): { enabled: boolean } };
}

/** The mode a conversation actually runs at, with inheritance resolved. */
export interface EffectivePermissionMode {
  mode: PermissionMode;
  source: PermissionModeSource;
  /** The conversation that actually holds the setting; null when not inherited. */
  inheritedFrom: string | null;
  enabledAt: number | null;
  until: number | null;
}

/**
 * Per-conversation permission level (docs/design/13-permissions.md「权限级别」).
 *
 * Three levels: `manual` (default), `auto` (routine approvals are decided for
 * the user), `bypass` (every approval is skipped and commands may leave the
 * sandbox; a hard command guard still refuses catastrophic commands and the
 * app data directory).
 *
 * Deliberately in memory only: a restart — or a crash — always returns to
 * `manual`. Settings are per conversation; delegated work and board-card chats
 * inherit the setting of the conversation they started from, and the global
 * unattended switch forces `bypass` everywhere.
 */
export class PermissionModeService {
  readonly #deps: PermissionModeDeps;
  readonly #entries = new Map<string, ModeEntry>();

  constructor(deps: PermissionModeDeps) {
    this.#deps = deps;
  }

  effective(conversationId: string | null): EffectivePermissionMode {
    const requested = conversationId ?? '';
    const scope = this.#scopeOf(requested);
    const entry = requested.length > 0 ? this.#liveEntry(scope) : null;
    const inheritedFrom = scope !== requested ? scope : null;
    if (this.#deps.unattended?.effective().enabled === true) {
      return {
        mode: 'bypass',
        source: 'unattended',
        inheritedFrom,
        enabledAt: entry?.enabledAt ?? null,
        until: entry?.until ?? null,
      };
    }
    if (entry === null) {
      return {
        mode: 'manual',
        source: 'conversation',
        inheritedFrom,
        enabledAt: null,
        until: null,
      };
    }
    return {
      mode: entry.mode,
      source: 'conversation',
      inheritedFrom,
      enabledAt: entry.enabledAt,
      until: entry.until,
    };
  }

  /** Current state; expired time boxes fall back to `manual` first. */
  get(conversationId: string | null): PermissionModeState {
    const effective = this.effective(conversationId);
    return permissionModeStateSchema.parse({
      conversationId: conversationId ?? '',
      ...effective,
    });
  }

  /** The mode the conversation runs at (inheritance and unattended applied). */
  modeOf(conversationId: string | null): PermissionMode {
    return this.effective(conversationId).mode;
  }

  /** True while the conversation runs with every approval skipped. */
  isBypass(conversationId: string | null): boolean {
    return this.effective(conversationId).mode === 'bypass';
  }

  /**
   * Switches the level. `auto` / `bypass` require the explicit risk
   * acknowledgement the UI dialog sends (`acknowledgeRisk: true`); a
   * programmatic caller cannot widen permissions silently.
   */
  set(input: {
    conversationId: string;
    mode: PermissionMode;
    hours?: number | null;
    acknowledgeRisk?: true;
  }): PermissionModeState {
    if (input.conversationId.length === 0) {
      throw new AppError('INVALID_INPUT', '缺少对话 id');
    }
    const scope = this.#scopeOf(input.conversationId);
    if (input.mode === 'manual') return this.#clear(scope, input.conversationId);
    if (input.acknowledgeRisk !== true) {
      throw new AppError('INVALID_INPUT', '提升权限级别需要在弹框中确认风险');
    }
    const now = this.#deps.clock.now();
    const hours = input.hours ?? null;
    const entry: ModeEntry = {
      mode: input.mode,
      enabledAt: now,
      until: hours !== null ? now + hours * 3_600_000 : null,
    };
    this.#entries.set(scope, entry);
    this.#deps.logger.warn(
      { conversationId: scope, mode: entry.mode, until: entry.until },
      'permission level raised',
    );
    const state = this.get(input.conversationId);
    this.#deps.publish(state);
    return state;
  }

  /** Startup / shutdown: nothing survives a process restart. */
  clearAll(): void {
    this.#entries.clear();
  }

  #clear(scope: string, requested: string): PermissionModeState {
    const had = this.#entries.delete(scope);
    if (had) this.#deps.logger.info({ conversationId: scope }, 'permission level reset');
    const state = this.get(requested);
    if (had) this.#deps.publish(state);
    return state;
  }

  #scopeOf(conversationId: string): string {
    if (conversationId.length === 0) return conversationId;
    return this.#deps.resolveScope?.(conversationId) ?? conversationId;
  }

  #liveEntry(scope: string): ModeEntry | null {
    const entry = this.#entries.get(scope);
    if (entry === undefined) return null;
    if (entry.until !== null && this.#deps.clock.now() >= entry.until) {
      this.#entries.delete(scope);
      this.#deps.logger.info({ conversationId: scope }, 'permission level expired');
      // 过期发布延后到微任务：`effective()` 常被审批 / 执行路径同步读取，
      // 不要从读取路径的调用栈中间同步向外发事件。
      queueMicrotask(() => this.#deps.publish(this.get(scope)));
      return null;
    }
    return entry;
  }
}
