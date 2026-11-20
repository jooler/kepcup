import { connections, serverHashOf, type SourceId } from '$lib/rpc/connections.svelte';
import { contacts } from '$lib/stores/contacts.svelte';
import { teamContext } from './team-context.svelte';

/**
 * 离开态（T7 步骤 5，62.01 S12 / 62.06）：用户菜单「设置离开 / 回来」+ 备注 →
 * `team.presence.setAway`。状态展示（月牙徽标 / dm 头部提示）由名册的
 * `member.state === 'away'` 驱动；`avatarBotName`（分身开启时）由 T6 的
 * presence 广播携带，这里只读展示「将由其分身处理」。
 *
 * 来源选择：桌面融合视图取第一个已连接的团队来源；web 团队端点（T5）是
 * teamContext（同源 core）。非团队上下文没有入口。
 */

class AwayState {
  /** 「设置离开」对话框当前编辑的备注（200 字上限，随入参 schema）。 */
  note = $state('');
  submitting = $state(false);

  /** 有可操作的团队身份的来源（菜单 / 对话框的门控）；没有返回 null。 */
  activeSource(): SourceId | null {
    for (const source of connections.sources()) {
      if (source === 'local') continue;
      if (connections.get(source).status === 'connected') return source;
    }
    return teamContext.active ? 'local' : null;
  }

  /** 当前成员是否处于离开态（展示侧）。 */
  isAway(source: SourceId): boolean {
    const self = source === 'local' ? contacts.self : contacts.teamSelfOf(source);
    return self?.state === 'away';
  }

  /** 离开时代回的分身 Bot 名（未开启分身为 null；文案由消费方组合）。 */
  avatarBotNameOf(source: SourceId): string | null {
    if (!this.isAway(source)) return null;
    const self = source === 'local' ? contacts.self : contacts.teamSelfOf(source);
    const name = self?.avatarBotName;
    return name !== undefined && name.length > 0 ? name : null;
  }

  /** 设置 / 取消离开（备注可选，≤200 字）。 */
  async setAway(source: SourceId, away: boolean, note?: string): Promise<boolean> {
    const hash = serverHashOf(source);
    const conn = connections.get(source);
    if (hash === null && source !== 'local') return false;
    if (hash !== null && conn.status !== 'connected') return false;
    this.submitting = true;
    try {
      await conn.callTeam('team.presence.setAway', {
        away,
        ...(away && note !== undefined && note.trim().length > 0
          ? { note: note.trim().slice(0, 200) }
          : {}),
      });
      return true;
    } catch {
      return false;
    } finally {
      this.submitting = false;
    }
  }
}

export const awayState = new AwayState();
