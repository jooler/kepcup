import type { Bot, Conversation, TeamMember } from '@kepcup/shared';
import { isArchivedConversation } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { teamContext } from '$lib/features/team/team-context.svelte';

class ContactsState {
  bots = $state<Bot[]>([]);
  /**
   * 通讯录名册里的会话（含已从对话列表移除的归档会话）：项目组一栏用它，
   * Bot 一栏用它标出「这个 Bot 的对话已从列表移除」。
   */
  conversations = $state<Conversation[]>([]);
  /** 名册是否已加载过（首屏之后才有归档会话的名单）。 */
  rosterLoaded = $state(false);
  #started = false;

  /**
   * 团队成员名册（T5，62.04 §1 融合名册）：数据源是团队上下文的
   * `team.members.list` + member.* 事件（在 team-context 统一拉取与刷新，
   * 通讯录 / @ 候选 / dm 会话头共用同一份）。非团队上下文恒为空数组——
   * 通讯录只有 Bot 与项目组两栏，与现状逐字节一致（休眠验收项）。
   */
  get members(): TeamMember[] {
    return teamContext.active ? teamContext.members : [];
  }

  /** 当前成员（「成员」栏顶部的「我」条目）；非团队上下文为 null。 */
  get self(): TeamMember | null {
    return teamContext.active ? teamContext.member : null;
  }

  /** 打开与某成员的 dm（team.dm.open：既有会话复用，没有则新建），返回会话 id。 */
  async openDm(targetMemberId?: string): Promise<string | null> {
    if (!teamContext.active) return null;
    // 无参调用（自我会话）发空参数帧：入参 schema 的 optional 字段缺省即合法。
    const result = (await core.callTeam(
      'team.dm.open',
      targetMemberId === undefined ? undefined : { targetMemberId },
    )) as { conversation: Conversation };
    return result.conversation.id;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('bot.updated', (payload) => {
      const data = payload as { bot: Bot };
      const index = this.bots.findIndex((b) => b.id === data.bot.id);
      if (index >= 0) {
        this.bots[index] = data.bot;
        this.bots = [...this.bots];
      } else {
        this.bots = [...this.bots, data.bot];
      }
    });
    core.onEvent('bot.deleted', (payload) => {
      const data = payload as { id: string };
      this.bots = this.bots.filter((b) => b.id !== data.id);
    });
    core.onEvent('conversation.updated', (payload) => {
      const data = payload as { conversation: Conversation };
      // Card chats stay out of the address book; bot_direct exchange
      // conversations too (v2.3 — pill detail only). The dialog session
      // listens on its own.
      if (data.conversation.type === 'card' || data.conversation.type === 'bot_direct') return;
      this.#upsertConversation(data.conversation);
    });
    core.onEvent('conversation.deleted', (payload) => {
      const data = payload as { id: string };
      this.conversations = this.conversations.filter((c) => c.id !== data.id);
    });
  }

  async refresh(): Promise<void> {
    const result = (await core.call('bots.list')) as { bots: Bot[] };
    this.bots = result.bots;
    try {
      const roster = (await core.call('conversations.all')) as { conversations: Conversation[] };
      this.conversations = roster.conversations;
      this.rosterLoaded = true;
    } catch {
      // 名册拿不到也不该拖垮通讯录：Bot 一栏照常显示（项目组一栏暂时为空）。
      this.rosterLoaded = true;
    }
  }

  /** 通讯录里的项目组（含已归档的）。 */
  get projects(): Conversation[] {
    return this.conversations.filter((c) => c.type === 'project');
  }

  /** 某个 Bot 的直聊是否已从对话列表移除（归档）。 */
  isChatArchived(botId: string): boolean {
    return this.archivedChatOf(botId) !== undefined;
  }

  /** 某个 Bot 已归档的直聊（恢复它用）。 */
  archivedChatOf(botId: string): Conversation | undefined {
    return this.conversations.find(
      (c) => c.type === 'direct' && c.directBotId === botId && isArchivedConversation(c),
    );
  }

  #upsertConversation(conversation: Conversation): void {
    const index = this.conversations.findIndex((c) => c.id === conversation.id);
    if (index >= 0) {
      this.conversations[index] = { ...this.conversations[index], ...conversation };
      this.conversations = [...this.conversations];
    } else {
      this.conversations = [conversation, ...this.conversations];
    }
  }

  async create(profile: Bot['profile']): Promise<Bot> {
    const result = (await core.call('bots.create', { profile })) as { bot: Bot };
    return result.bot;
  }

  /**
   * `base`：表单是从哪一版 Profile 改出来的。给了就由 core 与最新 Profile 三方合并，表单没碰的
   * 字段（如 Bot 刚直改的模型、设置卡刚收回的 MCP）不会被过期表单覆盖（D89 审查修复）。
   */
  async update(id: string, profile: Bot['profile'], base?: Bot['profile'] | null): Promise<Bot> {
    const result = (await core.call('bots.update', {
      id,
      profile,
      ...(base !== undefined && base !== null ? { base } : {}),
    })) as { bot: Bot };
    return result.bot;
  }

  /** Projects this bot currently leads (deleting it is blocked until replaced). */
  async deletionPreview(id: string): Promise<{
    conversations: number;
    messages: number;
    memoryItems: number;
    wikiPages: number;
    skills: number;
    ledProjects: Array<{ id: string; title: string | null }>;
  }> {
    return (await core.call('bots.deletionPreview', { id })) as {
      conversations: number;
      messages: number;
      memoryItems: number;
      wikiPages: number;
      skills: number;
      ledProjects: Array<{ id: string; title: string | null }>;
    };
  }

  async remove(id: string): Promise<void> {
    await core.call('bots.delete', { id });
  }
}

export const contacts = new ContactsState();
