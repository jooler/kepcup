import type { Bot, Conversation } from '@kepcup/shared';
import { isArchivedConversation } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

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
