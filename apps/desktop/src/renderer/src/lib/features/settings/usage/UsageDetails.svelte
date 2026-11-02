<script lang="ts">
  import type { UsageSummaryEntry } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { loopLabel } from './usage-labels';

  /**
   * 「逐日明细」视图：与「统计」平级的原表，按 Bot → (本地日, loop 类型)
   * 汇总；外部 Agent（D72 P5）在所属 Bot 下单独一张按轮数的表。
   */
  let { entries, days }: { entries: UsageSummaryEntry[]; days: 7 | 30 } = $props();

  function botName(botId: string | null): string {
    if (botId === null) return t('settings.usageGlobalBots');
    const known = contacts.bots.find((bot) => bot.id === botId);
    return known ? known.name || botId : botId;
  }

  const botRows = $derived.by(() => {
    const ids = [...new Set(entries.map((entry) => entry.botId ?? ''))];
    return ids
      .map((id) => {
        const all = entries.filter((entry) => (entry.botId ?? '') === id);
        const rows = all
          .filter((entry) => entry.agentId === undefined)
          .sort((a, b) =>
            a.date < b.date ? 1 : a.date > b.date ? -1 : a.loopType < b.loopType ? -1 : 1,
          );
        const agentRows = all
          .filter((entry) => entry.agentId !== undefined)
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
        return {
          botId: id === '' ? null : id,
          name: botName(id === '' ? null : id),
          rows,
          agentRows,
        };
      })
      .filter((row) => row.rows.length > 0 || row.agentRows.length > 0)
      .sort((a, b) =>
        a.botId === null ? 1 : b.botId === null ? -1 : a.name.localeCompare(b.name),
      );
  });

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

<section class="rounded-lg border bg-card p-4" data-testid="usage-details">
  <p class="text-xs text-muted-foreground">
    {t('settings.usageDetailsHint')} · {days === 7
      ? t('settings.usageRange7')
      : t('settings.usageRange30')}
  </p>

  {#if botRows.length === 0}
    <p class="mt-6 text-sm text-muted-foreground">{t('settings.usageNoData')}</p>
  {:else}
    <div class="mt-4 space-y-3" data-testid="usage-rows">
      {#each botRows as row (row.botId ?? 'global')}
        <div class="rounded-md border p-3" data-testid={`usage-bot-${row.botId ?? 'global'}`}>
          <span class="text-sm font-medium" data-testid="usage-bot-name">{row.name}</span>
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
                    <td class="py-1">{loopLabel(entry.loopType)}</td>
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
