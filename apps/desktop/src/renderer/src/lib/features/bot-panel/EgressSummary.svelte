<script lang="ts">
  /**
   * D73 P2（design 29 §8.3）Bot 详情里的「污点外发」汇总：读取过连接应用的数据后，无人值守下
   * 自动放行的外发操作（审计 `egress_tainted`）的次数与最近几条。没有记录时不占位。
   */
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';

  let { botId }: { botId: string } = $props();

  interface EgressEntry {
    at: number;
    conversationId: string | null;
    channel: string;
    target: string;
    approved: boolean;
  }
  let total = $state(0);
  let refused = $state(0);
  let recent = $state<EgressEntry[]>([]);

  // 换 Bot、或无人值守开关变化（刚关闭时产生了新记录）时重取。
  $effect(() => {
    const id = botId;
    void permissions.unattended.enabled;
    let cancelled = false;
    void core
      .call('apps.egressSummary', { botId: id })
      .then((result) => {
        if (cancelled) return;
        const summary = result as { total: number; refused: number; recent: EgressEntry[] };
        total = summary.total;
        refused = summary.refused;
        recent = summary.recent;
      })
      .catch(() => {
        if (!cancelled) {
          total = 0;
          refused = 0;
          recent = [];
        }
      });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if total > 0 || refused > 0}
  <div
    class="grid gap-1 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300"
    data-testid="bot-egress-summary"
    data-count={total}
  >
    <p class="font-medium">
      {t('bot.egressSummary', { count: total })}{#if refused > 0}（{t('bot.egressSummaryRefused', {
          count: refused,
        })}）{/if}
    </p>
    <p class="text-muted-foreground">{t('bot.egressRecentTitle')}</p>
    <ul class="grid gap-0.5">
      {#each recent as entry, index (index)}
        <li class="truncate" title={entry.target}>
          <span class="text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
          · <span data-approved={entry.approved}
            >{t(entry.approved ? 'bot.egressApproved' : 'bot.egressRefused')}</span
          >
          · {t(`approvals.egress.channel.${entry.channel}` as never)} · <code>{entry.target}</code>
        </li>
      {/each}
    </ul>
  </div>
{/if}
