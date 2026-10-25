<script lang="ts">
  /**
   * D73 P2（design 29 §8.3）Bot 详情里的「污点外发」汇总：读取过连接应用的数据后，无人值守下
   * 自动放行的外发操作（审计 `egress_tainted`）的次数与最近几条。没有记录时不占位。
   * 右上角关闭 = 调 `apps.egressClear` 把这些审计记录从数据库删除（持久生效），
   * 新的外发记录会重新累计展示。
   */
  import { X } from '@lucide/svelte';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { toast } from 'svelte-sonner';

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
  let clearing = $state(false);

  const recordCount = $derived(total + refused);

  async function dismiss(): Promise<void> {
    if (clearing) return;
    clearing = true;
    try {
      await core.call('apps.egressClear', { botId });
      total = 0;
      refused = 0;
      recent = [];
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('chats.errorCode.INTERNAL')));
    } finally {
      clearing = false;
    }
  }

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

{#if recordCount > 0}
  <div
    class="relative grid gap-1 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300"
    data-testid="bot-egress-summary"
    data-count={total}
  >
    <button
      type="button"
      class="absolute right-1 top-1 rounded p-0.5 text-amber-800/60 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300/60 dark:hover:text-amber-300 disabled:opacity-50"
      onclick={() => void dismiss()}
      disabled={clearing}
      aria-label={t('common.close')}
      title={t('common.close')}
      data-testid="bot-egress-summary-close"
    >
      <X class="size-3" aria-hidden="true" />
    </button>
    <p class="pr-4 font-medium">
      {t('bot.egressSummary', { count: total })}{#if refused > 0}{t('common.parenthesized', {
          text: t('bot.egressSummaryRefused', { count: refused }),
        })}{/if}
    </p>
    <p class="text-muted-foreground">{t('bot.egressRecentTitle')}</p>
    <ul class="grid gap-0.5">
      {#each recent as entry, index (index)}
        <li class="truncate" title={entry.target}>
          <span class="text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
          ·
          <span data-approved={entry.approved}
            >{t(entry.approved ? 'bot.egressApproved' : 'bot.egressRefused')}</span
          >
          · {t(`approvals.egress.channel.${entry.channel}` as never)} · <code>{entry.target}</code>
        </li>
      {/each}
    </ul>
  </div>
{/if}
