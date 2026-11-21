import type { ProfileCategory } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { connections, serverHashOf, type SourceId } from '$lib/rpc/connections.svelte';
import { profilePushCheckedByDefault } from './profile-sensitive';
import { ENDPOINT_KIND } from '$lib/features/web-shell/endpoint';

/**
 * 画像上行（T7 步骤 5，62.05 §1）：桌面融合视图首次连接成功后弹确认清单
 *（读本机 `profile.list`，`boundaries` 类与命中敏感规则的条目默认不勾选），
 * 确认后经团队连接 `team.profile.push` 上行（只补不删 / 只增不改，服务端合并）。
 *
 * 自动路径每日至多一次（localStorage 按 serverHash 记 UTC 日）；手动入口
 *（团队设置「刷新我的画像上行」）不限次。**仅桌面端点**：web 无本机画像，
 * 不显示入口。
 */

export interface ProfilePushItem {
  id: string;
  category: ProfileCategory;
  content: string;
  checked: boolean;
  /** 默认不勾选的原因（展示给成员：类别敏感 / 命中敏感规则）。 */
  sensitive: boolean;
}

const DAY_KEY_PREFIX = 'kepcup.teamServers.profilePush.day.';

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 自动路径的每日一次判定（按 serverHash 记 UTC 日；存储不可用视为已推过——
 * 弹窗是打扰，宁少勿多）。 */
function autoPushAllowedToday(serverHash: string, now: Date): boolean {
  const store = storage();
  if (store === null) return false;
  try {
    const last = store.getItem(DAY_KEY_PREFIX + serverHash);
    return last !== utcDay(now);
  } catch {
    return false;
  }
}

function markAutoPushed(serverHash: string, now: Date): void {
  try {
    storage()?.setItem(DAY_KEY_PREFIX + serverHash, utcDay(now));
  } catch {
    // 尽力而为：明天可能再弹一次，可接受。
  }
}

class ProfilePushState {
  open = $state(false);
  items = $state<ProfilePushItem[]>([]);
  loading = $state(false);
  pushing = $state(false);
  /** 最近一次上行结果（成功条数；null = 未推 / 失败）。 */
  lastResult = $state<{ added: number; skipped: number } | null>(null);
  error = $state<string | null>(null);
  #source: SourceId | null = null;
  #started = false;
  readonly #seenSources = new Set<string>();

  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (ENDPOINT_KIND !== 'desktop') return; // web 无本机画像：入口不激活
    connections.onSourcesChanged(() => {
      for (const source of connections.sources()) {
        const hash = serverHashOf(source);
        if (hash === null || this.#seenSources.has(hash)) continue;
        this.#seenSources.add(hash);
        const conn = connections.get(source);
        conn.onConnected(() => {
          // 首次连接成功 → 每日至多一次的自动确认清单。
          if (autoPushAllowedToday(hash, new Date())) void this.openFor(source, 'auto');
        });
      }
    });
  }

  /** 手动入口（团队设置小节）：不限次。 */
  async openManual(source: SourceId): Promise<void> {
    await this.openFor(source, 'manual');
  }

  private async openFor(source: SourceId, mode: 'auto' | 'manual'): Promise<void> {
    if (serverHashOf(source) === null) return;
    this.#source = source;
    this.loading = true;
    this.error = null;
    this.lastResult = null;
    this.open = true;
    try {
      const result = (await core.call('profile.list')) as {
        items: Array<{ id: string; category: ProfileCategory; content: string; status: string }>;
      };
      // 只上行生效条目（superseded / retracted 不带）。
      this.items = result.items
        .filter((item) => item.status === 'active')
        .map((item) => {
          const sensitive = !profilePushCheckedByDefault(item.category, item.content);
          return {
            id: item.id,
            category: item.category,
            content: item.content,
            checked: !sensitive,
            sensitive,
          };
        });
    } catch {
      this.error = 'profile.list failed';
      this.items = [];
    } finally {
      this.loading = false;
    }
    if (mode === 'auto' && this.#source !== null) {
      const hash = serverHashOf(this.#source);
      if (hash !== null) markAutoPushed(hash, new Date());
    }
  }

  toggle(itemId: string): void {
    this.items = this.items.map((item) =>
      item.id === itemId ? { ...item, checked: !item.checked } : item,
    );
  }

  /** 确认上行勾选条目（经团队连接 team.profile.push；只补不删）。 */
  async confirm(): Promise<void> {
    const source = this.#source;
    if (source === null) return;
    const selected = this.items.filter((item) => item.checked);
    if (selected.length === 0) {
      this.open = false;
      return;
    }
    this.pushing = true;
    this.error = null;
    try {
      const result = (await connections.get(source).callTeam('team.profile.push', {
        items: selected.map((item) => ({ category: item.category, content: item.content })),
      })) as { added: number; skipped: number };
      this.lastResult = result;
    } catch {
      this.error = 'team.profile.push failed';
    } finally {
      this.pushing = false;
    }
  }

  close(): void {
    this.open = false;
  }
}

export const profilePush = new ProfilePushState();
