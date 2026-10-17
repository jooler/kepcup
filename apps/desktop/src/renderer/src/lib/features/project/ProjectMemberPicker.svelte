<script lang="ts">
  import { t } from '$lib/i18n';
  import { contacts } from '$lib/stores/contacts.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { composeCandidates, composePool } from '$lib/features/chats/project-compose';

  /**
   * Shared "search + candidate bots" block for adding project members
   * (D92 §11.3): one copy of the roster logic, used by the header members
   * menu and the settings-page members section alike. The pool drops butlers
   * (they never join a project) and `excludeIds` (usually the current
   * members); picking a candidate calls `onPick` and clears the input.
   */
  let {
    excludeIds,
    onPick,
    testid,
  }: {
    excludeIds: string[];
    onPick: (botId: string) => void | Promise<void>;
    /** Testid of the search input; candidates get `${testid}-option-<botId>`. */
    testid: string;
  } = $props();

  let query = $state('');

  const candidates = $derived(composeCandidates(composePool(contacts.bots), excludeIds, query));

  async function pick(botId: string): Promise<void> {
    await onPick(botId);
    query = '';
  }

  /** Keystrokes must not leak: global shortcuts listen at the window level. */
  function onKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
  }
</script>

<input
  bind:value={query}
  placeholder={t('project.members.search')}
  class="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none"
  data-testid={testid}
  onkeydown={onKeydown}
/>
<ul class="max-h-40 space-y-0.5 overflow-y-auto">
  {#each candidates as bot (bot.id)}
    <li>
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:bg-accent"
        onclick={() => void pick(bot.id)}
        data-testid={`${testid}-option-${bot.id}`}
      >
        <BotAvatar botId={bot.id} name={bot.name} avatar={bot.avatar ?? null} class="size-6 shrink-0" animated={false} />
        <span class="min-w-0 truncate">{bot.name}</span>
      </button>
    </li>
  {:else}
    <li class="px-1 py-1.5 text-xs text-muted-foreground">{t('project.members.noAddable')}</li>
  {/each}
</ul>
