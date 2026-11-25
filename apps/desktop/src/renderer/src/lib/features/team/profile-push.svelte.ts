import type { ProfileCategory } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { connections, serverHashOf, type SourceId } from '$lib/rpc/connections.svelte';
import { profilePushCheckedByDefault } from './profile-sensitive';
import { ENDPOINT_KIND } from '$lib/features/web-shell/endpoint';

/**
 * 画像上行（T7 步骤 5，62.05 §1）+ 启动静默同步（2026-11 调整）：
 *
 * 团队连接**真·上线**（平台 WS connected + 端口就绪，`connections.onTeamOnline`）
 * 后，每会话每服务器至多一次：读本机 `profile.list`，再经团队连接读服务端同名
 * 绑定（member scope 的 `profile.list` = 调用者自己的服务端分桶），按
 * (category, 规范化 content) 键求差额——
 *
 * - 从未上行过（无 pushed 标记）且有差额：弹确认清单（每日至多一次；`boundaries`
 *   类与命中敏感规则的条目默认不勾选）；取消 = 今日不再问，明日再审。
 * - 已上行过：差额里**非敏感且未被明确拒绝**的条目静默上行，不弹框——服务端
 *   只增不改、同键去重（重复上行 = skipped，无副作用），完全同步则什么都不发生。
 * - 服务端条目读不到（旧版服务器 / 抖动）按空集处理，上行幂等兜底。
 *
 * 确认清单勾选结果会回写本地记账：未勾选且不在服务端的条目进「拒绝集」，静默
 * 同步永不再带；勾选的条目移出拒绝集。手动入口（团队设置「刷新我的画像上行」）
 * 不限次。**仅桌面端点**：web 无本机画像，不显示入口。
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
const PUSHED_KEY_PREFIX = 'kepcup.teamServers.profilePush.pushed.';
const DECLINED_KEY_PREFIX = 'kepcup.teamServers.profilePush.declined.';

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

/**
 * 与服务端 `team.profile.push` 一致的规范化口径（团队服务器端
 * `normalizeProfileContent`：trim、折叠空白、大小写折叠）。两端
 * 是同权利人的同口径移植（同 profile-sensitive.ts 先例）；漂移的最坏后果是多一次
 * 空推——服务端按同键去重，上行幂等。
 */
function normalizeProfileContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 上行去重键：(category, 规范化 content)，与服务端逐字同构。 */
function pushKey(category: string, content: string): string {
  return `${category}\u0000${normalizeProfileContent(content)}`;
}

/** 自动路径的弹框判定（按 serverHash 记 UTC 日；存储不可用视为已问过——
 * 弹窗是打扰，宁少勿多）。 */
function autoDialogAllowedToday(serverHash: string, now: Date): boolean {
  const store = storage();
  if (store === null) return false;
  try {
    const last = store.getItem(DAY_KEY_PREFIX + serverHash);
    return last !== utcDay(now);
  } catch {
    return false;
  }
}

function markAutoDialogDay(serverHash: string, now: Date): void {
  try {
    storage()?.setItem(DAY_KEY_PREFIX + serverHash, utcDay(now));
  } catch {
    // 尽力而为：明天可能再弹一次，可接受。
  }
}

/** 是否上行过至少一次（确认清单成功推过 / 手动确认推过；静默同步不再置位）。 */
function everPushed(serverHash: string): boolean {
  try {
    return storage()?.getItem(PUSHED_KEY_PREFIX + serverHash) === '1';
  } catch {
    return false;
  }
}

function markEverPushed(serverHash: string): void {
  try {
    storage()?.setItem(PUSHED_KEY_PREFIX + serverHash, '1');
  } catch {
    // 尽力而为：丢了下次会再走一次确认清单，可接受。
  }
}

/** 明确不要上行的条目键（确认清单里未勾选且不在服务端的差额）。 */
function declinedKeys(serverHash: string): Set<string> {
  try {
    const raw = storage()?.getItem(DECLINED_KEY_PREFIX + serverHash);
    if (raw === undefined || raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((key): key is string => typeof key === 'string'));
  } catch {
    return new Set();
  }
}

function saveDeclinedKeys(serverHash: string, keys: Set<string>): void {
  try {
    storage()?.setItem(DECLINED_KEY_PREFIX + serverHash, JSON.stringify([...keys]));
  } catch {
    // 尽力而为：拒绝集丢了会多推一次（服务端去重），可接受。
  }
}

interface LocalProfileItem {
  id: string;
  category: ProfileCategory;
  content: string;
}

class ProfilePushState {
  open = $state(false);
  items = $state<ProfilePushItem[]>([]);
  loading = $state(false);
  pushing = $state(false);
  error = $state<string | null>(null);
  #source: SourceId | null = null;
  /** 打开清单时服务端已有的条目键（确认时区分「已同步」与「明确不要」）。 */
  #serverKeys = new Set<string>();
  #started = false;
  readonly #seenSources = new Set<string>();
  /** 本会话已完成的自动同步（每服务器一次；防重连风暴反复触发）。 */
  readonly #synced = new Set<string>();
  readonly #syncing = new Set<string>();

  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (ENDPOINT_KIND !== 'desktop') return; // web 无本机画像：入口不激活
    connections.onSourcesChanged(() => {
      for (const source of connections.sources()) {
        const hash = serverHashOf(source);
        if (hash === null || this.#seenSources.has(hash)) continue;
        this.#seenSources.add(hash);
        // 真·上线边沿才同步：桥在建连时先交付端口、WS 在后台握手，端口就绪
        // ≠ 服务器可达（服务器没启动时旧实现会照弹清单）。
        connections.onTeamOnline(hash, () => void this.#syncAfterConnect(source));
      }
    });
  }

  /** 手动入口（团队设置小节）：不限次。 */
  async openManual(source: SourceId): Promise<void> {
    await this.openFor(source, 'manual');
  }

  /**
   * 上线边沿的自动同步（每会话每服务器一次；本轮失败不占坑，下次上线重试）。
   */
  async #syncAfterConnect(source: SourceId): Promise<void> {
    const hash = serverHashOf(source);
    if (hash === null || this.#syncing.has(hash) || this.#synced.has(hash)) return;
    this.#syncing.add(hash);
    try {
      await this.#syncFlow(source, hash);
    } catch {
      // 本机 / 服务端读取失败：留待下次上线边沿重试。
    } finally {
      this.#syncing.delete(hash);
    }
  }

  async #syncFlow(source: SourceId, hash: string): Promise<void> {
    const local = await this.#loadLocalItems();
    if (local.length === 0) {
      this.#synced.add(hash);
      return;
    }
    const conn = connections.get(source);
    const serverKeys = await this.#loadServerKeys(conn);
    const delta = local.filter((item) => !serverKeys.has(pushKey(item.category, item.content)));
    if (!everPushed(hash)) {
      // 从未上行过：有差额才走确认清单（首次知情同意）；全在服务端（如他机推过）
      // 或今日已问过，本轮结束。
      if (delta.length === 0 || !autoDialogAllowedToday(hash, new Date())) {
        this.#synced.add(hash);
        return;
      }
      this.#synced.add(hash);
      await this.openFor(source, 'auto');
      return;
    }
    this.#synced.add(hash);
    // 已上行过：静默同步非敏感、未被明确拒绝的差额（服务端同键去重，幂等）。
    // 敏感条目只经确认清单 / 手动入口上行；失败不打扰，手动入口可重试。
    const declined = declinedKeys(hash);
    const pushable = delta.filter(
      (item) =>
        profilePushCheckedByDefault(item.category, item.content) &&
        !declined.has(pushKey(item.category, item.content)),
    );
    if (pushable.length === 0) return;
    try {
      await conn.callTeam('team.profile.push', {
        items: pushable.map((item) => ({ category: item.category, content: item.content })),
      });
    } catch {
      // 静默失败（限流 / 抖动）不打扰。
    }
  }

  /** 本机生效条目（superseded / retracted 不上行；读取失败抛给上层重试）。 */
  async #loadLocalItems(): Promise<LocalProfileItem[]> {
    const result = (await core.call('profile.list')) as {
      items: Array<{ id: string; category: ProfileCategory; content: string; status: string }>;
    };
    return result.items
      .filter((item) => item.status === 'active')
      .map((item) => ({ id: item.id, category: item.category, content: item.content }));
  }

  /**
   * 服务端该成员分桶已有的条目键（经团队连接读 member scope 的 `profile.list`，
   * 与 push 的去重读同一份数据）。读不到按空集处理：上行幂等，服务端同键去重。
   */
  async #loadServerKeys(conn: { call(method: string): Promise<unknown> }): Promise<Set<string>> {
    try {
      const result = (await conn.call('profile.list')) as {
        items?: Array<{ category: string; content: string; status?: string }>;
      };
      const active = (result.items ?? []).filter(
        (item) => item.status === undefined || item.status === 'active',
      );
      return new Set(active.map((item) => pushKey(item.category, item.content)));
    } catch {
      return new Set();
    }
  }

  private async openFor(source: SourceId, mode: 'auto' | 'manual'): Promise<void> {
    if (serverHashOf(source) === null) return;
    this.#source = source;
    this.loading = true;
    this.error = null;
    this.open = true;
    try {
      const [local, serverKeys] = await Promise.all([
        this.#loadLocalItems(),
        this.#loadServerKeys(connections.get(source)),
      ]);
      this.#serverKeys = serverKeys;
      this.items = local.map((item) => {
        const sensitive = !profilePushCheckedByDefault(item.category, item.content);
        const alreadyOnServer = serverKeys.has(pushKey(item.category, item.content));
        return {
          id: item.id,
          category: item.category,
          content: item.content,
          // 敏感条目与已在服务端的条目默认不勾选（后者勾了也只是 skipped）。
          checked: !sensitive && !alreadyOnServer,
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
      if (hash !== null) markAutoDialogDay(hash, new Date());
    }
  }

  toggle(itemId: string): void {
    this.items = this.items.map((item) =>
      item.id === itemId ? { ...item, checked: !item.checked } : item,
    );
  }

  /**
   * 确认上行勾选条目（经团队连接 team.profile.push；只补不删），并把勾选结果
   * 回写本地记账（拒绝集 + pushed 标记）。
   *
   * 成功即关闭对话框：留在原地等用户点「取消」会让人以为还有事务未完成，
   * 且服务端有一分钟一次的限流（再次点确认会拿到 RATE_LIMITED，结果行与
   * 错误行同屏）。结果经返回值交给调用方 toast 告知。失败时保留对话框
   * 与错误行供重试。
   */
  async confirm(): Promise<{ added: number; skipped: number } | null> {
    const source = this.#source;
    if (source === null) return null;
    const hash = serverHashOf(source);
    const selected = this.items.filter((item) => item.checked);
    if (hash !== null) this.#recordDeclines(hash);
    if (selected.length === 0) {
      this.open = false;
      return null;
    }
    this.pushing = true;
    this.error = null;
    try {
      const result = (await connections.get(source).callTeam('team.profile.push', {
        items: selected.map((item) => ({ category: item.category, content: item.content })),
      })) as { added: number; skipped: number };
      if (hash !== null) markEverPushed(hash);
      this.open = false;
      return result;
    } catch {
      this.error = 'team.profile.push failed';
      return null;
    } finally {
      this.pushing = false;
    }
  }

  /**
   * 确认时回写拒绝集：未勾选且不在服务端的条目 =「明确不要」，静默同步永不再带；
   * 勾选的条目移出拒绝集（改主意）；已在服务端的条目不记（那是已同步，不是拒绝
   * ——否则服务端清空后这些条目会被拒绝集误拦）。
   */
  #recordDeclines(hash: string): void {
    const declined = declinedKeys(hash);
    for (const item of this.items) {
      const key = pushKey(item.category, item.content);
      if (this.#serverKeys.has(key)) continue;
      if (item.checked) declined.delete(key);
      else declined.add(key);
    }
    saveDeclinedKeys(hash, declined);
  }

  close(): void {
    this.open = false;
  }

  /** 测试专用：清空会话级同步状态（#synced / #syncing 单例跨用例残留）。 */
  resetSyncStateForTests(): void {
    this.#synced.clear();
    this.#syncing.clear();
  }
}

export const profilePush = new ProfilePushState();
