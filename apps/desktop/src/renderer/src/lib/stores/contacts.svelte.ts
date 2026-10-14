import type { Bot } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

class ContactsState {
  bots = $state<Bot[]>([]);
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
  }

  async refresh(): Promise<void> {
    const result = (await core.call('bots.list')) as { bots: Bot[] };
    this.bots = result.bots;
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

  async deletionPreview(id: string): Promise<{
    conversations: number;
    messages: number;
    memoryItems: number;
    wikiPages: number;
    skills: number;
  }> {
    return (await core.call('bots.deletionPreview', { id })) as {
      conversations: number;
      messages: number;
      memoryItems: number;
      wikiPages: number;
      skills: number;
    };
  }

  async remove(id: string): Promise<void> {
    await core.call('bots.delete', { id });
  }
}

export const contacts = new ContactsState();
