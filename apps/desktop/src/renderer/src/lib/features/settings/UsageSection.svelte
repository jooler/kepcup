<script lang="ts">
  import type { UsageSummaryEntry } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';

  const LOOP_KEYS: Record<UsageSummaryEntry['loopType'], MessageKey> = {
    response: 'usage.loop.response',
    triage: 'usage.loop.triage',
    reflection: 'usage.loop.reflection',
    memory_consolidation: 'usage.loop.memory_consolidation',
    profile_curation: 'usage.loop.profile_curation',
    wiki_maintenance: 'usage.loop.wiki_maintenance',
    skill_authoring: 'usage.loop.skill_authoring',
    conversation_summary: 'usage.loop.conversation_summary',
    subagent: 'usage.loop.subagent',
  };

  let budgetTokens = $state<number | null>(null);
  let budgetDraft = $state('');
  let entries = $state<UsageSummaryEntry[]>([]);
  let loading = $state(false);
  let savingBudget = $state(false);

  $effect(() => {
    void refresh();
  });

  /** Local calendar date in the same shape the core reports (YYYY-MM-DD). */
  function todayKey(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    }).format(new Date());
  }

  function botName(botId: string | null): string {
    if (botId === null) return t('settings.usageGlobalBots');
    const known = contacts.bots.find((bot) => bot.id === botId);
    return known ? known.name || botId : botId;
  }

  /**
   * Bot rows in bot-then-name order; background usage vs the budget mirrors
   * BudgetService (response/triage never count).
   */
  const botRows = $derived.by(() => {
    const today = todayKey();
    const ids = [...new Set(entries.map((entry) => entry.botId ?? ''))];
    return ids
      .map((id) => {
        const rows = entries.filter((entry) => (entry.botId ?? '') === id);
        const backgroundToday = rows
          .filter(
            (entry) =>
              entry.date === today && entry.loopType !== 'response' && entry.loopType !== 'triage',
          )
          .reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0);
        return {
          botId: id === '' ? null : id,
          name: botName(id === '' ? null : id),
          rows: rows.sort((a, b) =>
            a.date < b.date ? 1 : a.date > b.date ? -1 : a.loopType < b.loopType ? -1 : 1,
          ),
          backgroundToday,
          exceeded: budgetTokens !== null && budgetTokens > 0 && backgroundToday >= budgetTokens,
        };
      })
      .sort((a, b) =>
        a.botId === null ? 1 : b.botId === null ? -1 : a.name.localeCompare(b.name),
      );
  });

  async function refresh(): Promise<void> {
    loading = true;
    try {
      const [summary, budget] = await Promise.all([
        core.call('usage.summary', { days: 7 }) as Promise<{ entries: UsageSummaryEntry[] }>,
        core.call('budget.get') as Promise<{ tokens: number }>,
      ]);
      entries = summary.entries;
      budgetTokens = budget.tokens;
      budgetDraft = String(budget.tokens);
    } finally {
      loading = false;
    }
  }

  async function saveBudget(): Promise<void> {
    const parsed = Number.parseInt(budgetDraft, 10);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    savingBudget = true;
    try {
      const result = (await core.call('budget.update', { tokens: parsed })) as { tokens: number };
      budgetTokens = result.tokens;
      budgetDraft = String(result.tokens);
      toast.success(t('settings.budgetSaved'));
    } catch {
      toast.error(t('common.actionFailed'));
    } finally {
      savingBudget = false;
    }
  }

  function tokenText(entry: UsageSummaryEntry): string {
    return `${entry.inputTokens} / ${entry.outputTokens}`;
  }

  function costText(entry: UsageSummaryEntry): string {
    return entry.costUsd === null ? '—' : `$${entry.costUsd.toFixed(4)}`;
  }
</script>

<section class="space-y-3" data-testid="settings-usage">
  <div class="flex items-center gap-2">
    <h3 class="text-sm font-medium">{t('settings.usageSection')}</h3>
    <Button
      size="sm"
      variant="ghost"
      class="ml-auto h-7 px-2 text-xs"
      disabled={loading}
      onclick={() => void refresh()}
      data-testid="usage-refresh"
    >
      {t('common.refresh')}
    </Button>
  </div>
  <p class="text-xs text-muted-foreground">{t('settings.usageNote')}</p>

  <div class="flex flex-wrap items-end gap-3" data-testid="budget-editor">
    <div class="grid gap-1.5">
      <Label for="budget-tokens">{t('settings.budgetLabel')}</Label>
      <Input
        id="budget-tokens"
        type="number"
        min="0"
        class="w-40"
        bind:value={budgetDraft}
        data-testid="budget-input"
      />
    </div>
    <Button
      variant="outline"
      size="sm"
      disabled={savingBudget}
      onclick={() => void saveBudget()}
      data-testid="budget-save"
    >
      {t('common.save')}
    </Button>
    <p class="text-xs text-muted-foreground">{t('settings.budgetHint')}</p>
  </div>

  {#if loading && entries.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="usage-loading">…</p>
  {:else if entries.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="usage-empty">
      {t('settings.usageEmpty')}
    </p>
  {:else}
    <div class="space-y-3" data-testid="usage-rows">
      {#each botRows as row (row.botId ?? 'global')}
        <div class="rounded-md border p-3" data-testid={`usage-bot-${row.botId ?? 'global'}`}>
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium" data-testid="usage-bot-name">{row.name}</span>
            {#if row.exceeded}
              <span
                class="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                data-testid="usage-exceeded"
              >
                {t('settings.usageExceeded')}
              </span>
            {/if}
          </div>
          <table class="mt-2 w-full text-left text-xs">
            <thead class="text-muted-foreground">
              <tr>
                <th class="py-1 font-normal">{t('settings.usageColumnDay')}</th>
                <th class="py-1 font-normal">{t('settings.usageColumnLoop')}</th>
                <th class="py-1 font-normal">{t('settings.usageColumnTokens')}</th>
                <th class="py-1 font-normal">{t('settings.usageColumnCost')}</th>
              </tr>
            </thead>
            <tbody>
              {#each row.rows as entry (`${entry.date}|${entry.loopType}`)}
                <tr
                  class="border-t"
                  data-testid="usage-entry-row"
                  data-loop-type={entry.loopType}
                  data-date={entry.date}
                >
                  <td class="py-1 tabular-nums">{entry.date}</td>
                  <td class="py-1">{t(LOOP_KEYS[entry.loopType])}</td>
                  <td class="py-1 tabular-nums" data-testid="usage-entry-tokens"
                    >{tokenText(entry)}</td
                  >
                  <td class="py-1 tabular-nums">{costText(entry)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/each}
    </div>
  {/if}
</section>
