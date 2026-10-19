<script lang="ts">
  import type { UsageSummaryEntry } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { Button } from '$lib/components/ui/button';

  const LOOP_KEYS: Record<UsageSummaryEntry['loopType'], MessageKey> = {
    triage: 'usage.loop.triage',
    reflection: 'usage.loop.reflection',
    memory_consolidation: 'usage.loop.memory_consolidation',
    profile_curation: 'usage.loop.profile_curation',
    wiki_maintenance: 'usage.loop.wiki_maintenance',
    skill_authoring: 'usage.loop.skill_authoring',
    conversation_summary: 'usage.loop.conversation_summary',
    subagent: 'usage.loop.subagent',
    widget_authoring: 'usage.loop.widget_authoring',
    turn: 'usage.loop.turn',
    task: 'usage.loop.task',
    memory: 'usage.loop.memory',
    voice_input: 'usage.loop.voice_input',
  };

  let entries = $state<UsageSummaryEntry[]>([]);
  let loading = $state(false);

  $effect(() => {
    void refresh();
  });

  function botName(botId: string | null): string {
    if (botId === null) return t('settings.usageGlobalBots');
    const known = contacts.bots.find((bot) => bot.id === botId);
    return known ? known.name || botId : botId;
  }

  /**
   * Bot rows in bot-then-name order (subscription / external-agent usage is
   * listed separately per D72 P5).
   */
  const botRows = $derived.by(() => {
    const ids = [...new Set(entries.map((entry) => entry.botId ?? ''))];
    return ids
      .map((id) => {
        const all = entries.filter((entry) => (entry.botId ?? '') === id);
        // D72 P5: subscription / external-agent usage is listed separately.
        const rows = all.filter((entry) => entry.agentId === undefined);
        const agentRows = all
          .filter((entry) => entry.agentId !== undefined)
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
        return {
          botId: id === '' ? null : id,
          name: botName(id === '' ? null : id),
          rows: rows.sort((a, b) =>
            a.date < b.date ? 1 : a.date > b.date ? -1 : a.loopType < b.loopType ? -1 : 1,
          ),
          agentRows,
        };
      })
      .sort((a, b) =>
        a.botId === null ? 1 : b.botId === null ? -1 : a.name.localeCompare(b.name),
      );
  });

  async function refresh(): Promise<void> {
    loading = true;
    try {
      const summary = (await core.call('usage.summary', {
        days: 7,
      })) as { entries: UsageSummaryEntry[] };
      entries = summary.entries;
    } finally {
      loading = false;
    }
  }

  function tokenText(entry: UsageSummaryEntry): string {
    return `${entry.inputTokens} / ${entry.outputTokens}`;
  }

  function agentName(agentId: string | undefined): string {
    if (agentId === undefined) return '';
    return agentsStore.get(agentId)?.name ?? agentId;
  }

  function agentTokenText(entry: UsageSummaryEntry): string {
    return entry.inputTokens + entry.outputTokens > 0 ? tokenText(entry) : '—';
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
          </div>
          {#if row.rows.length > 0}
            <table class="mt-2 w-full text-left text-xs">
              <thead class="text-muted-foreground">
                <tr>
                  <th class="py-1 font-normal">{t('settings.usageColumnDay')}</th>
                  <th class="py-1 font-normal">{t('settings.usageColumnLoop')}</th>
                  <th class="py-1 font-normal">{t('settings.usageColumnCalls')}</th>
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
                    <td class="py-1 tabular-nums" data-testid="usage-entry-calls"
                      >{entry.calls ?? '—'}</td
                    >
                    <td class="py-1 tabular-nums" data-testid="usage-entry-tokens"
                      >{tokenText(entry)}</td
                    >
                    <td class="py-1 tabular-nums">{costText(entry)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
          {#if row.agentRows.length > 0}
            <div class="mt-3" data-testid="usage-agent-rows">
              <p class="text-xs font-medium">{t('settings.usageAgentSection')}</p>
              <p class="text-xs text-muted-foreground">{t('settings.usageAgentNote')}</p>
              <table class="mt-1 w-full text-left text-xs">
                <thead class="text-muted-foreground">
                  <tr>
                    <th class="py-1 font-normal">{t('settings.usageColumnDay')}</th>
                    <th class="py-1 font-normal">{t('settings.usageColumnAgent')}</th>
                    <th class="py-1 font-normal">{t('settings.usageColumnTurns')}</th>
                    <th class="py-1 font-normal">{t('settings.usageColumnTokens')}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each row.agentRows as entry (`${entry.date}|${entry.loopType}|${entry.agentId}`)}
                    <tr
                      class="border-t"
                      data-testid="usage-agent-row"
                      data-agent-id={entry.agentId}
                    >
                      <td class="py-1 tabular-nums">{entry.date}</td>
                      <td class="py-1">{agentName(entry.agentId)}</td>
                      <td class="py-1 tabular-nums">{entry.turns ?? 0}</td>
                      <td class="py-1 tabular-nums">{agentTokenText(entry)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>
