<script lang="ts">
  import { t } from '$lib/i18n';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { agentIconUrl } from '$lib/features/settings/agent-icons';

  /**
   * Bot 详情的外部智能体徽标（D72，design 28 §3）：所用 Agent 的图标 / 名称 +
   * 「隔离由 Agent 自身沙箱提供」说明（含读取让渡的披露）；点击跳到设置页
   * 「智能体」中该 Agent 的卡片。
   */
  let { agentId }: { agentId: string } = $props();

  $effect(() => {
    agentsStore.start();
    if (!agentsStore.loaded) void agentsStore.refresh().catch(() => undefined);
  });

  const agent = $derived(agentsStore.get(agentId));
  const name = $derived(agent?.name ?? agentId);
  const icon = $derived(agent !== null ? agentIconUrl(agent.icon) : null);
</script>

<div class="flex flex-col items-center gap-1" data-testid="bot-agent-badge">
  <button
    type="button"
    class="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent"
    title={t('contacts.agentBadgeOpen')}
    onclick={() => shell.openSettings('agents', `agent-${agentId}`)}
    data-testid="bot-agent-badge-button"
  >
    {#if icon !== null}
      <img src={icon} alt="" class="size-3.5 shrink-0 rounded" />
    {:else}
      <span
        class="flex size-3.5 shrink-0 items-center justify-center rounded bg-muted text-[9px] font-medium"
        >{name.slice(0, 1)}</span
      >
    {/if}
    <span class="truncate">{t('contacts.agentBadge', { name })}</span>
  </button>
  <p class="px-2 text-center text-[11px] leading-snug text-muted-foreground">
    {t('contacts.agentIsolationNote')}
  </p>
</div>
