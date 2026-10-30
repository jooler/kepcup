<script lang="ts">
  import { tick } from 'svelte';
  import { Crown, X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { createNamedBot } from '$lib/features/bot-setup';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { composeCandidates, composeEnterAction, composePool, stepHighlight } from './project-compose';

  const LISTBOX_ID = 'project-compose-listbox';
  const optionId = (botId: string): string => `project-compose-opt-${botId}`;

  let query = $state('');
  let hint = $state('');
  let busy = $state(false);
  /** Arrow-highlighted candidate; -1 = no arrow pick (Enter handles the typed text). */
  let highlight = $state(-1);
  let inputEl = $state<HTMLInputElement | null>(null);

  const shortcutMod = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';

  // The candidate pool drops butlers first (butlers never join a project); both rounds share it.
  const pool = $derived(composePool(contacts.bots));
  /** Round 1: butlers only (already dropped from the pool); round 2: plus lead and chosen members. */
  const excludedIds = $derived(
    chat.composePhase === 'members'
      ? [chat.composeLeadId, ...chat.composeMemberIds].filter((id): id is string => id !== null)
      : [],
  );
  const lead = $derived(
    chat.composeLeadId === null
      ? undefined
      : contacts.bots.find((bot) => bot.id === chat.composeLeadId),
  );
  const members = $derived(
    chat.composeMemberIds
      .map((id) => contacts.bots.find((bot) => bot.id === id))
      .filter((bot) => bot !== undefined),
  );
  const filtered = $derived(composeCandidates(pool, excludedIds, query));
  const activeOption = $derived(highlight >= 0 ? filtered[highlight] : undefined);

  // On a phase switch (including mount): reset input, hint and highlight, refocus the input.
  $effect(() => {
    void chat.composePhase;
    query = '';
    hint = '';
    highlight = -1;
    inputEl?.focus();
  });

  $effect(() => {
    void query;
    highlight = -1;
  });

  // An arrow-key move can land on a candidate outside the list viewport: scroll it in.
  $effect(() => {
    const bot = activeOption;
    if (bot === undefined) return;
    void tick().then(() => {
      document.getElementById(optionId(bot.id))?.scrollIntoView({ block: 'nearest' });
    });
  });

  function addMember(botId: string): void {
    chat.addComposeMember(botId);
    query = '';
    hint = '';
    highlight = -1;
    inputEl?.focus();
  }

  async function onEnter(): Promise<void> {
    if (busy) return;
    const action = composeEnterAction({
      phase: chat.composePhase,
      query,
      bots: pool,
      leadId: chat.composeLeadId,
      memberIds: chat.composeMemberIds,
      candidates: filtered,
      highlight,
    });
    switch (action.kind) {
      case 'selectLead':
        chat.selectComposeLead(action.botId);
        return;
      case 'add':
        addMember(action.botId);
        return;
      case 'alreadySelected': {
        const name = contacts.bots.find((bot) => bot.id === action.botId)?.name ?? '';
        query = '';
        hint = t('projectCompose.alreadyAdded', { name });
        return;
      }
      case 'create': {
        busy = true;
        try {
          const created = await createNamedBot(action.name);
          if (created) {
          // The phase may have changed while creating (e.g. back to round 1): place by the current phase.
          if (chat.composePhase === 'lead') chat.selectComposeLead(created.id);
          else chat.addComposeMember(created.id);
        }
      } finally {
        busy = false;
      }
      // The input stays readonly (not disabled) while busy, keeping focus; put it back on failure too.
      await tick();
        inputEl?.focus();
        return;
      }
      case 'needLead':
        hint = t('projectCompose.needLead');
        return;
      case 'needMembers':
        hint = t('projectCompose.needMembers');
        return;
      case 'commit':
        hint = '';
        busy = true;
        try {
          await chat.commitProjectCompose();
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
      chat.cancelProjectCompose();
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
    if (event.key === 'Backspace' && query.length === 0 && chat.composePhase === 'members') {
      // Round 2: drop the last member; with none left, go back to round 1 to re-pick the lead.
      if (members.length > 0) {
        const last = members[members.length - 1];
        if (last) chat.removeComposeMember(last.id);
      } else {
        chat.backToLeadPhase();
      }
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
        // Shortcuts are per-round too: round 1 picks the lead, round 2 adds a member.
        if (chat.composePhase === 'lead') chat.selectComposeLead(bot.id);
        else addMember(bot.id);
      }
    }
  }
</script>

<div class="app-no-drag w-full" data-testid="project-compose" data-phase={chat.composePhase}>
  <div
    class="flex min-h-12 flex-wrap items-center gap-1.5 px-3 py-2"
  >
    <span class="shrink-0 text-sm text-muted-foreground">{t('projectCompose.to')}</span>
    {#if chat.composePhase === 'members' && lead}
      <!-- The lead chip always comes first; its ✕ goes back to round 1 (chosen members kept). -->
      <span
        class="inline-flex max-w-48 items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-1 text-sm"
        data-testid="project-compose-lead-chip"
      >
        <BotAvatar
          botId={lead.id}
          name={lead.name}
          avatar={lead.avatar}
          mask={lead.avatarMask}
          class="size-5"
          animated={false}
        />
        <span class="truncate">{lead.name}</span>
        <Crown class="size-3 shrink-0 text-amber-500" aria-hidden="true" />
        <span
          class="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-xs text-amber-700 dark:text-amber-400"
        >
          {t('projectCompose.leadBadge')}
        </span>
        <button
          type="button"
          class="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label={t('projectCompose.backToLead')}
          onclick={() => chat.backToLeadPhase()}
          data-testid="project-compose-back-to-lead"
        >
          <X class="size-3" aria-hidden="true" />
        </button>
      </span>
    {/if}
    <span
      class="shrink-0 text-sm text-muted-foreground"
      data-testid="project-compose-phase"
      data-phase={chat.composePhase}
    >
      {chat.composePhase === 'lead'
        ? t('projectCompose.leadLabel')
        : t('projectCompose.membersLabel')}
    </span>
    {#if chat.composePhase === 'members'}
      {#each members as bot (bot.id)}
        <span
          class="inline-flex max-w-48 items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-1 text-sm"
          data-testid={`project-compose-chip-${bot.id}`}
        >
          <BotAvatar
            botId={bot.id}
            name={bot.name}
            avatar={bot.avatar}
            mask={bot.avatarMask}
            class="size-5"
            animated={false}
          />
          <span class="truncate">{bot.name}</span>
          <button
            type="button"
            class="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={t('projectCompose.remove', { name: bot.name })}
            onclick={() => chat.removeComposeMember(bot.id)}
            data-testid={`project-compose-remove-${bot.id}`}
          >
            <X class="size-3" aria-hidden="true" />
          </button>
        </span>
      {/each}
    {/if}
    <input
      bind:this={inputEl}
      bind:value={query}
      class="h-8 min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      placeholder={chat.composePhase === 'lead'
        ? t('projectCompose.leadPlaceholder')
        : t('projectCompose.membersPlaceholder')}
      readonly={busy}
      aria-busy={busy}
      role="combobox"
      aria-label={t('projectCompose.inputLabel')}
      aria-autocomplete="list"
      aria-expanded={filtered.length > 0}
      aria-controls={LISTBOX_ID}
      aria-activedescendant={activeOption ? optionId(activeOption.id) : undefined}
      autocomplete="off"
      data-testid="project-compose-input"
      onkeydown={onKeydown}
    />
    <button
      type="button"
      class="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={t('projectCompose.cancel')}
      onclick={() => chat.cancelProjectCompose()}
      data-testid="project-compose-cancel"
    >
      <X class="size-4" aria-hidden="true" />
    </button>
  </div>

  <div
    class="mt-1 rounded-2xl border bg-background py-1 shadow-xl max-w-md"
    data-testid="project-compose-menu"
  >
    {#if filtered.length > 0}
      <div
        id={LISTBOX_ID}
        class="max-h-80 overflow-y-auto p-1"
        role="listbox"
        aria-label={t('projectCompose.listLabel')}
      >
        {#each filtered as bot, index (bot.id)}
          <button
            type="button"
            id={optionId(bot.id)}
            role="option"
            aria-selected={index === highlight}
            tabindex="-1"
            class="flex w-full items-center gap-2 px-2 py-1 rounded-sm text-left text-sm hover:bg-accent {index ===
            highlight
              ? 'bg-accent'
              : ''}"
            onclick={() => (chat.composePhase === 'lead' ? chat.selectComposeLead(bot.id) : addMember(bot.id))}
            data-testid={`project-compose-option-${bot.id}`}
          >
            <BotAvatar
              botId={bot.id}
              name={bot.name}
              avatar={bot.avatar}
              mask={bot.avatarMask}
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
      <p class="px-3 py-2 text-sm text-muted-foreground">{t('projectCompose.emptyList')}</p>
    {/if}
  </div>
  {#if hint}
    <p
      class="mt-2 text-center text-xs text-muted-foreground"
      role="status"
      data-testid="project-compose-hint"
    >
      {hint}
    </p>
  {/if}
</div>
