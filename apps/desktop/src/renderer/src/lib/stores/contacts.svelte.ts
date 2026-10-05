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

  async update(id: string, profile: Bot['profile']): Promise<Bot> {
    const result = (await core.call('bots.update', { id, profile })) as { bot: Bot };
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
