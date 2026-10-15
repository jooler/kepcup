<script lang="ts">
  import { X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { createNamedBot } from '$lib/features/bot-setup';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';

  let query = $state('');
  let hint = $state('');
  let busy = $state(false);
  let highlight = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);

  const shortcutMod = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';

  const selected = $derived(
    chat.composeMemberIds
      .map((id) => contacts.bots.find((bot) => bot.id === id))
      .filter((bot) => bot !== undefined),
  );
  const selectedIds = $derived(new Set(selected.map((bot) => bot.id)));
  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return contacts.bots.filter((bot) => {
      if (selectedIds.has(bot.id)) return false;
      if (needle.length === 0) return true;
      return bot.name.toLowerCase().includes(needle);
    });
  });

  $effect(() => {
    inputEl?.focus();
  });

  $effect(() => {
    void query;
    highlight = 0;
  });

  function add(botId: string): void {
    chat.addComposeMember(botId);
    query = '';
    hint = '';
    inputEl?.focus();
  }

  async function onEnter(): Promise<void> {
    if (busy) return;
    const text = query.trim();
    if (text.length > 0) {
      const exact = contacts.bots.find((bot) => bot.name === text && !selectedIds.has(bot.id));
      if (exact) {
        add(exact.id);
        return;
      }
      busy = true;
      try {
        const created = await createNamedBot(text);
        if (created) add(created.id);
      } finally {
        busy = false;
      }
      return;
    }
    if (chat.composeMemberIds.length < 2) {
      hint = t('groupCompose.needMembers');
      return;
    }
    hint = '';
    busy = true;
    try {
      await chat.commitGroupCompose();
    } finally {
      busy = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      chat.cancelGroupCompose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filtered.length === 0) return;
      highlight = Math.min(filtered.length - 1, highlight + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlight = Math.max(0, highlight - 1);
      return;
    }
    if (event.key === 'Backspace' && query.length === 0 && selected.length > 0) {
      const last = selected[selected.length - 1];
      if (last) chat.removeComposeMember(last.id);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void onEnter();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      const bot = filtered[index];
      if (bot) {
        event.preventDefault();
        add(bot.id);
      }
    }
  }
</script>

<div class="mx-auto w-full max-w-2xl" data-testid="group-compose">
  <div
    class="flex min-h-12 flex-wrap items-center gap-1.5 rounded-2xl border bg-background px-3 py-2 shadow-xl"
  >
    <span class="shrink-0 text-sm text-muted-foreground">{t('groupCompose.to')}</span>
    {#each selected as bot (bot.id)}
      <span
        class="inline-flex max-w-48 items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-1 text-sm"
        data-testid={`group-compose-chip-${bot.id}`}
      >
        <BotAvatar
          botId={bot.id}
          name={bot.name}
          avatar={bot.avatar}
          class="size-5"
          animated={false}
        />
        <span class="truncate">{bot.name}</span>
        <button
          type="button"
          class="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label={t('groupCompose.remove', { name: bot.name })}
          onclick={() => chat.removeComposeMember(bot.id)}
          data-testid={`group-compose-remove-${bot.id}`}
        >
          <X class="size-3" aria-hidden="true" />
        </button>
      </span>
    {/each}
    <input
      bind:this={inputEl}
      bind:value={query}
      class="h-8 min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      placeholder={t('groupCompose.placeholder')}
      disabled={busy}
      autocomplete="off"
      data-testid="group-compose-input"
      onkeydown={onKeydown}
    />
    <button
      type="button"
      class="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={t('groupCompose.cancel')}
      onclick={() => chat.cancelGroupCompose()}
      data-testid="group-compose-cancel"
    >
      <X class="size-4" aria-hidden="true" />
    </button>
  </div>

  <div
    class="mt-1 max-h-80 overflow-y-auto rounded-2xl border bg-background py-1 shadow-xl"
    data-testid="group-compose-menu"
  >
    {#each filtered as bot, index (bot.id)}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent {index ===
        highlight
          ? 'bg-accent'
          : ''}"
        onclick={() => add(bot.id)}
        data-testid={`group-compose-option-${bot.id}`}
      >
        <BotAvatar
          botId={bot.id}
          name={bot.name}
          avatar={bot.avatar}
          class="size-7"
          animated={false}
        />
        <span class="min-w-0 flex-1 truncate">{bot.name}</span>
        {#if index < 9}
          <span class="shrink-0 text-xs text-muted-foreground">{shortcutMod}{index + 1}</span>
        {/if}
      </button>
    {:else}
      <p class="px-3 py-2 text-sm text-muted-foreground">{t('groupCompose.emptyList')}</p>
    {/each}
  </div>
  {#if hint}
    <p class="mt-2 text-center text-xs text-muted-foreground" data-testid="group-compose-hint">
      {hint}
    </p>
  {/if}
</div>
