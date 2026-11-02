<script lang="ts">
  import type { UsageSummaryEntry } from '@kepcup/shared';
  import { i18n, t } from '$lib/i18n';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { formatFull } from './usage-format';

  /**
   * D72 P5：订阅 / 外部 Agent 的用量单列。外部智能体按自己的订阅计费，
   * 常常不回报 token，因此以模型轮数为主、token 有则显示。
   */
  let { entries }: { entries: UsageSummaryEntry[] } = $props();

  const locale = $derived(i18n.locale);

  interface AgentRow {
    key: string;
    agentName: string;
    botName: string;
    turns: number;
    tokens: number;
  }

  const rows = $derived.by<AgentRow[]>(() => {
    const aggregated: Record<string, AgentRow> = {};
    for (const entry of entries) {
      if (entry.agentId === undefined) continue;
      const key = `${entry.agentId}|${entry.botId ?? ''}`;
      const current = (aggregated[key] ??= {
        key,
        agentName: agentsStore.get(entry.agentId)?.name ?? entry.agentId,
        botName:
          entry.botId === null
            ? t('settings.usageGlobalBots')
            : (contacts.bots.find((bot) => bot.id === entry.botId)?.name ?? entry.botId),
        turns: 0,
        tokens: 0,
      });
      current.turns += entry.turns ?? entry.calls ?? 0;
      current.tokens += entry.inputTokens + entry.outputTokens;
    }
    return Object.values(aggregated).sort((a, b) => b.turns - a.turns);
  });
</script>

{#if rows.length > 0}
  <section class="rounded-lg border bg-card p-4" data-testid="usage-agent-section">
    <h4 class="text-sm font-medium">{t('settings.usageAgentSection')}</h4>
    <p class="mt-0.5 text-xs text-muted-foreground">{t('settings.usageAgentNote')}</p>
    <ul class="mt-3 space-y-2" data-testid="usage-agent-rows">
      {#each rows as row (row.key)}
        <li
          class="flex items-center gap-2 text-xs"
          data-testid="usage-agent-row"
          data-agent-id={row.key.split('|')[0]}
        >
          <span class="min-w-0 flex-1 truncate">{row.agentName}</span>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">{row.botName}</span>
          <span class="w-14 shrink-0 text-right tabular-nums"
            >{row.turns} {t('settings.usageTurnsUnit')}</span
          >
          <span class="w-20 shrink-0 text-right text-muted-foreground tabular-nums"
            >{row.tokens > 0 ? `${formatFull(row.tokens, locale)} Token` : '—'}</span
          >
        </li>
      {/each}
    </ul>
  </section>
{/if}
