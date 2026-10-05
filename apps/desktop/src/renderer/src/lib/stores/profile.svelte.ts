import type { ProfileCard, ProfileItem } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/** P07 settings-page state: shared profile entries + the compiled card. */
class ProfileState {
  items = $state<ProfileItem[]>([]);
  card = $state<ProfileCard | null>(null);
  loaded = $state(false);

  async refresh(): Promise<void> {
    const [items, card] = await Promise.all([
      core.call('profile.list') as Promise<{ items: ProfileItem[] }>,
      core.call('profile.card') as Promise<{ card: ProfileCard }>,
    ]);
    this.items = items.items;
    this.card = card.card;
    this.loaded = true;
  }

  /** profile.update — the user's direct edit (one of the two legal writers). */
  async updateItem(id: string, patch: { content?: string; category?: ProfileItem['category'] }): Promise<void> {
    const result = (await core.call('profile.update', { id, ...patch })) as {
      items: ProfileItem[];
    };
    this.items = result.items;
  }

  async retractItem(id: string): Promise<void> {
    const result = (await core.call('profile.retract', { id })) as { items: ProfileItem[] };
    this.items = result.items;
  }
}

export const profileStore = new ProfileState();
