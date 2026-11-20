import { connections, serverHashOf, type SourceId } from '$lib/rpc/connections.svelte';
import { contacts } from '$lib/stores/contacts.svelte';
import { teamContext } from './team-context.svelte';
import { avatarRuntime } from './avatar-runtime.svelte';

/**
 * 离开态（T7 步骤 5，62.01 S12 / 62.06）：用户菜单「设置离开 / 回来」+ 备注 →
 * `team.presence.setAway`。状态展示（月牙徽标 / dm 头部提示）由名册的
 * `member.state === 'away'` 驱动；`avatarBotName`（分身开启时）由 T6 的
 * presence 广播携带，这里只读展示「将由其分身处理」。
 *
 * T10：`avatar` 选项生效——桌面融合视图设置离开并开分身时，成功后激活本窗口
 * 的分身运行端（avatar-runtime；web / 未连接不激活，休眠不变）；回来时停用并
 * 由运行时出「离开期间代回 N 条」的本机摘要。
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

  /**
   * 设置 / 取消离开（备注可选，≤200 字）。`avatar`（T10）：`enabled` = 分身
   * 开关，`botId` = 用户选的本机 Bot（空 = 缺省管家）——仅桌面融合视图会传；
   * 成功后激活 / 停用本窗口的分身运行端。
   */
  async setAway(
    source: SourceId,
    away: boolean,
    note?: string,
    avatar?: { enabled: boolean; botId?: string },
  ): Promise<boolean> {
    const hash = serverHashOf(source);
    const conn = connections.get(source);
    if (hash === null && source !== 'local') return false;
    if (hash !== null && conn.status !== 'connected') return false;
    // T10：分身开关 → 先解析本机 Bot（默认管家）；解析不出按「不开分身」继续。
    let avatarBot: { id: string; name: string } | null = null;
    if (away && avatar?.enabled === true && hash !== null) {
      avatarBot = await avatarRuntime.resolveAvatarBot(avatar.botId ?? '');
    }
    this.submitting = true;
    try {
      const identity = conn.clientIdentity;
      await conn.callTeam('team.presence.setAway', {
        away,
        ...(away && note !== undefined && note.trim().length > 0
          ? { note: note.trim().slice(0, 200) }
          : {}),
        ...(avatarBot !== null ? { avatar: { botName: avatarBot.name } } : {}),
        // client（T10）：绑定分身运行端（avatarSetBy）——单一运行端判定与
        // origin='avatar' 代发校验都以它为准。
        ...(avatarBot !== null ? { client: { id: identity.id, name: identity.name } } : {}),
      });
      if (hash !== null) {
        if (avatarBot !== null) {
          avatarRuntime.activate(source, avatarBot.id);
        } else if (!away) {
          avatarRuntime.deactivate(source, { silent: false });
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      this.submitting = false;
    }
  }
}

export const awayState = new AwayState();
