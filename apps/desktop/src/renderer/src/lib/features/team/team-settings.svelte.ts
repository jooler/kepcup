import type { TeamSettings, TeamUsageSummary } from '@kepcup/shared';
import { connections, serverHashOf, teamSourceId, type SourceId } from '$lib/rpc/connections.svelte';

/**
 * 成员域团队设置（T7 步骤 5，62.03 §5 / 62 号设计「成员域免打扰」）：
 * `team.settings.get / update` 的渲染层状态——免打扰时段（quietHours）与
 * 个人用量（`team.usage.mine`）。按来源（serverHash）分桶：web 团队端点的
 * 来源是同源 `core`（T5），走 `connections.get('local')` 上的 team 方法；
 * 桌面融合视图按各团队连接。
 *
 * 休眠：非团队上下文（web 未登录团队 / 桌面未融合）没有来源，本 store 恒为
 * 空分桶，设置小节不渲染。
 */

export interface QuietHoursWindow {
  enabled: boolean;
  startMinute: number;
  endMinute: number;
}

/**
 * 当下是否处于免打扰时段（纯函数，node 单测直测）。分钟数是客户端本地时
 * （成员时区 P3，服务器按不透明边界处理，shared team/domain.ts）：
 * `start <= end` 为同日窗口；`start > end` 跨午夜（如 22:00–07:00）。
 */
export function withinQuietHours(window: QuietHoursWindow, now: Date): boolean {
  if (!window.enabled) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  if (window.startMinute === window.endMinute) {
    // 同点窗口按空窗处理（0 分钟），与表单语义一致。
    return false;
  }
  return window.startMinute < window.endMinute
    ? minute >= window.startMinute && minute < window.endMinute
    : minute >= window.startMinute || minute < window.endMinute;
}

class TeamSettingsState {
  /** 各来源的成员域设置（serverHash → settings；未加载不建键）。 */
  settingsBySource = $state<Record<string, TeamSettings>>({});
  /** 各来源的个人用量（serverHash → summary；null = 加载中 / 失败占位）。 */
  usageBySource = $state<Record<string, TeamUsageSummary | null>>({});
  #started = false;
  /** 已接线的连接实例（按实例而非来源键：断开重连会换新连接对象）。 */
  readonly #wired = new Set<object>();
  readonly #unsubscribers: Array<() => void> = [];

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribers.push(connections.onSourcesChanged(() => this.#wireSources()));
    this.#wireSources();
  }

  /** 某来源此刻是否处于免打扰时段（通知抑制判定）。 */
  quietHoursActive(source: SourceId): boolean {
    if (source === 'local') {
      // web 团队端点（T5）：同源 core，来源桶挂在活跃成员下（单桶 'local'）。
      const settings = this.settingsBySource.local;
      return settings?.quietHours !== undefined && withinQuietHours(settings.quietHours, new Date());
    }
    const settings = this.settingsBySource[source.slice('team:'.length)];
    return settings?.quietHours !== undefined && withinQuietHours(settings.quietHours, new Date());
  }

  settingsOf(source: SourceId): TeamSettings | null {
    const key = source === 'local' ? 'local' : serverHashOf(source) ?? 'local';
    return this.settingsBySource[key] ?? null;
  }

  /** 保存成员域设置（设置小节表单提交）。 */
  async update(source: SourceId, settings: TeamSettings): Promise<boolean> {
    const conn = connections.get(source);
    try {
      const result = (await conn.callTeam('team.settings.update', { settings })) as {
        settings: TeamSettings;
      };
      const key = source === 'local' ? 'local' : serverHashOf(source) ?? 'local';
      this.settingsBySource = { ...this.settingsBySource, [key]: result.settings };
      return true;
    } catch {
      return false;
    }
  }

  /** 拉个人用量（设置小节挂载时）。 */
  async loadUsage(source: SourceId): Promise<void> {
    const key = source === 'local' ? 'local' : serverHashOf(source) ?? 'local';
    const conn = connections.get(source);
    try {
      const result = (await conn.callTeam('team.usage.mine')) as TeamUsageSummary;
      this.usageBySource = { ...this.usageBySource, [key]: result };
    } catch {
      this.usageBySource = { ...this.usageBySource, [key]: null };
    }
  }

  async #wireSources(): Promise<void> {
    for (const source of connections.sources()) {
      const key = source === 'local' ? 'local' : serverHashOf(source)!;
      const conn = connections.get(source);
      if (this.#wired.has(conn)) continue;
      this.#wired.add(conn);
      this.#unsubscribers.push(conn.onConnected(() => void this.#loadSettings(source, key)));
      if (conn.status === 'connected') void this.#loadSettings(source, key);
    }
  }

  async #loadSettings(source: SourceId, key: string): Promise<void> {
    try {
      const result = (await connections.get(source).callTeam('team.settings.get')) as {
        settings: TeamSettings;
      };
      this.settingsBySource = { ...this.settingsBySource, [key]: result.settings };
    } catch {
      // 断线 / 非 P1 服务器：保留旧值；重连后 onConnected 再收敛。
    }
  }
}

export const teamSettings = new TeamSettingsState();

/** local 团队端点（web T5）也需要 sources 列表出现——teamContext 激活后由消费方调用。 */
export function teamSettingsSourceOf(serverHash: string | null): SourceId {
  return serverHash === null ? 'local' : teamSourceId(serverHash);
}
