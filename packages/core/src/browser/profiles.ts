import {
  AppError,
  BROWSER_PROFILE_NAME_MAX_CHARS,
  newId,
  type Bot,
  type BrowserProfile,
  type BrowserProfileEntry,
} from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import type { BotsService } from '../domain/bots.js';
import type { SettingsService } from '../domain/settings.js';
import type { Clock } from '../infra/clock.js';
import type { PermissionRevocations } from '../permissions/revocations.js';
import type { BrowserHostRpc } from './facade.js';

/**
 * W8 共享浏览器资料（todo/borrowings-from-personal-agents.md W8 §设计 B）：
 * 默认每个 Bot 私有资料（partition `persist:bot-{botId}`）；用户显式建立的共享
 * 资料（settings.browserProfiles）可挂多个 Bot（`persist:shared-{id}`），共用登录
 * 状态。core 只决定「哪份资料」（profileKey），partition 由主进程据此派生；网络
 * 策略、记忆、委派隔离仍按 Bot（§5 护栏 6）。
 */

/** The bot's effective shared profile id; null = private (unknown / deleted id → private). */
export function effectiveBrowserProfileId(
  bot: Pick<Bot, 'profile'> | null,
  profiles: readonly BrowserProfile[],
): string | null {
  const id = bot?.profile.runtime.browser_profile ?? '';
  if (id.length === 0) return null;
  return profiles.some((profile) => profile.id === id) ? id : null;
}

/** The profile key core sends with `browser.ensurePage` (host → partition). */
export function browserProfileKey(botId: string, sharedProfileId: string | null): string {
  return sharedProfileId === null ? `bot:${botId}` : `shared:${sharedProfileId}`;
}

export interface BrowserProfilesDeps {
  settings: SettingsService;
  bots: BotsService;
  browser: BrowserHostRpc;
  clock: Clock;
  revocations: PermissionRevocations;
  logger: Pick<CoreLogger, 'warn' | 'info'>;
  /** `bot.updated` push (a deleted profile moves its bots back to private). */
  publishBotUpdated: (bot: Bot) => void;
}

export class BrowserProfilesService {
  readonly #deps: BrowserProfilesDeps;

  constructor(deps: BrowserProfilesDeps) {
    this.#deps = deps;
  }

  /** Profiles with the (active) bots currently on each. */
  list(): BrowserProfileEntry[] {
    const profiles = this.#deps.settings.get().browserProfiles;
    const bots = this.#deps.bots.listActive();
    return profiles.map((profile) => ({
      ...profile,
      botIds: bots
        .filter((bot) => bot.profile.runtime.browser_profile === profile.id)
        .map((bot) => bot.id),
    }));
  }

  /** The profile key of the bot's pages right now. */
  profileKeyFor(botId: string): string {
    const profiles = this.#deps.settings.get().browserProfiles;
    return browserProfileKey(
      botId,
      effectiveBrowserProfileId(this.#deps.bots.get(botId), profiles),
    );
  }

  create(name: string): BrowserProfileEntry {
    const profile: BrowserProfile = {
      id: newId('bpf'),
      name: cleanName(name),
      createdAt: this.#deps.clock.now(),
    };
    const settings = this.#deps.settings.get();
    this.#deps.settings.update({ browserProfiles: [...settings.browserProfiles, profile] });
    return { ...profile, botIds: [] };
  }

  rename(id: string, name: string): BrowserProfileEntry[] {
    const settings = this.#deps.settings.get();
    this.#find(settings.browserProfiles, id);
    this.#deps.settings.update({
      browserProfiles: settings.browserProfiles.map((profile) =>
        profile.id === id ? { ...profile, name: cleanName(name) } : profile,
      ),
    });
    return this.list();
  }

  /**
   * `bots.create` / `bots.update`: a bot may only be put on an existing shared
   * profile ('' = private is always fine; an unchanged id is left alone).
   */
  assertSelectable(nextId: string, previousId?: string): void {
    if (nextId.length === 0 || nextId === previousId) return;
    this.#find(this.#deps.settings.get().browserProfiles, nextId);
  }

  /**
   * A bot's effective profile changed (bots.update, or its shared profile was
   * deleted): its running tasks that used the browser are interrupted (the
   * identity changed under them — W3 撤销即中断, scope `browser_profile`), then
   * every page of the bot is closed; the next browser call reopens it in the
   * new profile. Returns how many tasks were interrupted.
   */
  async onBotProfileChanged(botId: string): Promise<number> {
    const interrupted = this.#deps.revocations.emit({ scope: 'browser_profile', botIds: [botId] });
    try {
      await this.#deps.browser.closeBotPages({ botId });
    } catch (error) {
      // No host yet (BROWSER_UNAVAILABLE): no pages to close. Pages are also
      // re-created on a profile mismatch by the host's ensurePage.
      this.#deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'browser profile switch: closing pages failed',
      );
    }
    return interrupted;
  }

  /**
   * Deletes a shared profile: the bots on it go back to private first (same
   * switch rule as bots.update), then the profile's storage is wiped and its
   * partition directory removed (tombstoned like clearBotData).
   */
  async delete(id: string): Promise<{ movedBotIds: string[]; interrupted: number }> {
    const settings = this.#deps.settings.get();
    this.#find(settings.browserProfiles, id);
    const movedBotIds: string[] = [];
    let interrupted = 0;
    for (const bot of this.#deps.bots.listActive()) {
      if (bot.profile.runtime.browser_profile !== id) continue;
      const updated = this.#deps.bots.update(bot.id, {
        ...bot.profile,
        runtime: { ...bot.profile.runtime, browser_profile: '' },
      });
      movedBotIds.push(bot.id);
      this.#deps.publishBotUpdated(updated);
      interrupted += await this.onBotProfileChanged(bot.id);
    }
    // Deleted bots keep their (inert) reference; they never browse again.
    this.#deps.settings.update({
      browserProfiles: this.#deps.settings
        .get()
        .browserProfiles.filter((profile) => profile.id !== id),
    });
    try {
      await this.#deps.browser.clearProfileData({ profileId: id, remove: true });
    } catch (error) {
      // No host (BROWSER_UNAVAILABLE): the entry is gone and no bot points at
      // it any more; only the on-disk partition is left behind.
      this.#deps.logger.warn(
        { profileId: id, error: error instanceof Error ? error.message : String(error) },
        'browser profile delete: clearing the partition failed',
      );
    }
    this.#deps.logger.info(
      { profileId: id, moved: movedBotIds.length, interrupted },
      'browser profile deleted',
    );
    return { movedBotIds, interrupted };
  }

  /** 清除数据: wipes the shared profile's storage; the entry and its bots stay. */
  async clear(id: string): Promise<void> {
    this.#find(this.#deps.settings.get().browserProfiles, id);
    await this.#deps.browser.clearProfileData({ profileId: id });
  }

  #find(profiles: readonly BrowserProfile[], id: string): BrowserProfile {
    const profile = profiles.find((entry) => entry.id === id);
    if (profile === undefined) throw new AppError('NOT_FOUND', `浏览器资料 ${id} 不存在`);
    return profile;
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > BROWSER_PROFILE_NAME_MAX_CHARS) {
    throw new AppError('INVALID_INPUT', `名称需要 1~${BROWSER_PROFILE_NAME_MAX_CHARS} 个字符`);
  }
  return trimmed;
}
