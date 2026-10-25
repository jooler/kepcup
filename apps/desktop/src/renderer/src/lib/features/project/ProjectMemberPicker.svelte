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
   *
   * variant: `inline` keeps the candidate list permanently visible under the
   * input (header menu); `dropdown` shows it only while focus is inside the
   * picker, as an overlay panel under the input (settings page).
   */
  let {
    excludeIds,
    onPick,
    testid,
    variant = 'inline',
  }: {
    excludeIds: string[];
    onPick: (botId: string) => void | Promise<void>;
    /** Testid of the search input; candidates get `${testid}-option-<botId>`. */
    testid: string;
    variant?: 'inline' | 'dropdown';
  } = $props();

  let query = $state('');
  let root: HTMLElement | undefined = $state();
  let focused = $state(false);

  const dropdown = $derived(variant === 'dropdown');
  const listOpen = $derived(!dropdown || focused);

  const candidates = $derived(composeCandidates(composePool(contacts.bots), excludeIds, query));

  async function pick(botId: string): Promise<void> {
    await onPick(botId);
    query = '';
  }

  /** Keystrokes must not leak: global shortcuts listen at the window level. */
  function onKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Escape' && dropdown) focused = false;
  }

  /**
   * Dropdown mode closes the panel on focusout; a pressed option must not
   * move focus out of the input or the panel would unmount before the click
   * lands (on macOS clicking a button does not focus it). Standard combobox
   * trick: cancel the pointer's default action, focus stays, click still fires.
   */
  function onOptionPointerDown(event: PointerEvent): void {
    if (dropdown) event.preventDefault();
  }

  /** Tab or click into the option list keeps the panel open; leaving it closes. */
  function onFocusOut(event: FocusEvent): void {
    if (!root?.contains(event.relatedTarget as Node | null)) focused = false;
  }

  /** Esc closes the panel while the input keeps focus; clicking it reopens. */
  function onInputClick(): void {
    if (dropdown) focused = true;
  }
</script>

<div class="relative" bind:this={root} onfocusin={() => (focused = true)} onfocusout={onFocusOut}>
  <input
    bind:value={query}
    placeholder={t('project.members.search')}
    class="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none"
    data-testid={testid}
    onkeydown={onKeydown}
    onclick={onInputClick}
  />
  {#if listOpen}
    <ul
      class={dropdown
        ? 'absolute inset-x-0 top-full z-50 mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-md border bg-background p-1 shadow-lg'
        : 'max-h-40 space-y-0.5 overflow-y-auto'}
    >
      {#each candidates as bot (bot.id)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:bg-accent"
            onpointerdown={onOptionPointerDown}
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
  {/if}
</div>
