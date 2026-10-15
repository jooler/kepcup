<script lang="ts">
  import { tick } from 'svelte';
  import { X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { createNamedBot } from '$lib/features/bot-setup';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { composeCandidates, composeEnterAction, stepHighlight } from './group-compose';

  const LISTBOX_ID = 'group-compose-listbox';
  const optionId = (botId: string): string => `group-compose-opt-${botId}`;

  let query = $state('');
  let hint = $state('');
  let busy = $state(false);
  /** 方向键选中的候选；-1 = 没有用方向键选（回车按输入内容处理）。 */
  let highlight = $state(-1);
  let inputEl = $state<HTMLInputElement | null>(null);

  const shortcutMod = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';

  const selected = $derived(
    chat.composeMemberIds
      .map((id) => contacts.bots.find((bot) => bot.id === id))
      .filter((bot) => bot !== undefined),
  );
  const filtered = $derived(composeCandidates(contacts.bots, chat.composeMemberIds, query));
  const activeOption = $derived(highlight >= 0 ? filtered[highlight] : undefined);

  $effect(() => {
    inputEl?.focus();
  });

  $effect(() => {
    void query;
    highlight = -1;
  });

  // 方向键移到列表可视区外的候选：滚进视野。
  $effect(() => {
    const bot = activeOption;
    if (bot === undefined) return;
    void tick().then(() => {
      document.getElementById(optionId(bot.id))?.scrollIntoView({ block: 'nearest' });
    });
  });

  function add(botId: string): void {
    chat.addComposeMember(botId);
    query = '';
    hint = '';
    highlight = -1;
    inputEl?.focus();
  }

  async function onEnter(): Promise<void> {
    if (busy) return;
    const action = composeEnterAction({
      query,
      bots: contacts.bots,
      selectedIds: chat.composeMemberIds,
      candidates: filtered,
      highlight,
    });
    switch (action.kind) {
      case 'add':
        add(action.botId);
        return;
      case 'alreadySelected': {
        const name = contacts.bots.find((bot) => bot.id === action.botId)?.name ?? '';
        query = '';
        hint = t('groupCompose.alreadyAdded', { name });
        return;
      }
      case 'create': {
        busy = true;
        try {
          const created = await createNamedBot(action.name);
          if (created) add(created.id);
        } finally {
          busy = false;
        }
        // 输入框在忙碌期间只读（不禁用），焦点留在原处；新建失败时也把焦点放回。
        await tick();
        inputEl?.focus();
        return;
      }
      case 'needMembers':
        hint = t('groupCompose.needMembers');
        return;
      case 'commit':
        hint = '';
        busy = true;
        try {
          await chat.commitGroupCompose();
        } finally {
          busy = false;
        }
        return;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      chat.cancelGroupCompose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      highlight = stepHighlight(
        highlight,
        event.key === 'ArrowDown' ? 'down' : 'up',
        filtered.length,
      );
      return;
    }
    if (busy) return;
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

<div class="app-no-drag mx-auto w-full max-w-2xl" data-testid="group-compose">
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
      readonly={busy}
      aria-busy={busy}
      role="combobox"
      aria-label={t('groupCompose.inputLabel')}
      aria-autocomplete="list"
      aria-expanded={filtered.length > 0}
      aria-controls={LISTBOX_ID}
      aria-activedescendant={activeOption ? optionId(activeOption.id) : undefined}
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
    class="mt-1 rounded-2xl border bg-background py-1 shadow-xl"
    data-testid="group-compose-menu"
  >
    {#if filtered.length > 0}
      <div
        id={LISTBOX_ID}
        class="max-h-80 overflow-y-auto"
        role="listbox"
        aria-label={t('groupCompose.listLabel')}
      >
        {#each filtered as bot, index (bot.id)}
          <button
            type="button"
            id={optionId(bot.id)}
            role="option"
            aria-selected={index === highlight}
            tabindex="-1"
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
              <span class="shrink-0 text-xs text-muted-foreground" aria-hidden="true">
                {shortcutMod}{index + 1}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {:else}
      <p class="px-3 py-2 text-sm text-muted-foreground">{t('groupCompose.emptyList')}</p>
    {/if}
  </div>
  {#if hint}
    <p
      class="mt-2 text-center text-xs text-muted-foreground"
      role="status"
      data-testid="group-compose-hint"
    >
      {hint}
    </p>
  {/if}
</div>
