<script lang="ts">
  import { Hourglass } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { chat, type ActiveRunView } from '$lib/stores/chat.svelte';
  import { projects } from '$lib/stores/projects.svelte';
  import { toast } from 'svelte-sonner';
  import { toolVerb } from './tool-labels';

  let { entry }: { entry: ActiveRunView } = $props();

  const run = $derived(entry.run);

  const isQueued = $derived(run.status === 'queued');
  const lease = $derived(run.status === 'waiting_lease' ? projects.leaseWaiting[run.id] : undefined);
  const holderName = $derived(
    lease !== undefined
      ? (chat.conversations.find((c) => c.id === lease.holderConversationId)?.bot?.name ??
          lease.holderBotId ??
          '')
      : '',
  );

  /**
   * 状态文案（docs/design/12-ui-layout.md 焦点二）：排队 > 工具自报文本 >
   * 正在调用工具 > 请稍等。entry.muted（本 run 刚有消息落库）时整行让位
   * 隐藏——状态行的位置就是下一条消息出现的位置。纯展示：只有绿点与
   * 文字，这里不允许取消。
   */
  const label = $derived.by(() => {
    if (entry.progress.length > 0) return entry.progress;
    const verb = toolVerb(entry.toolName);
    if (verb !== null) return t('runStatus.callingVerb', { verb });
    if (entry.toolName.length > 0) return t('runStatus.callingTool', { tool: entry.toolName });
    return t('runStatus.pleaseWait');
  });

  async function revokeLease(): Promise<void> {
    const conversationId = run.conversationId;
    if (conversationId === null) return;
    const revoked = await projects.revokeLease(conversationId);
    if (revoked) toast.success(t('projects.leaseRevoked'));
    else toast.info(t('projects.leaseNothing'));
  }
</script>

{#if !entry.muted}
  <div
    class="flex items-center gap-2 py-1 text-sm text-muted-foreground"
    data-testid="run-status"
    data-run-id={run.id}
  >
    <span class="relative flex size-2.5 shrink-0">
      <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"></span>
      <span class="relative inline-flex size-2.5 rounded-full bg-emerald-500"></span>
    </span>
    <span class="min-w-0 truncate" data-testid="run-status-text">
      {#if lease !== undefined}
        <span class="inline-flex items-center gap-1.5" data-testid="lease-waiting-text">
          <Hourglass class="size-3.5 animate-pulse" aria-hidden="true" />
          {t('projects.leaseWaiting', { name: holderName })}
        </span>
      {:else}
        {isQueued ? t('runStatus.queued') : label}
      {/if}
    </span>
    {#if lease !== undefined}
      <Button
        variant="outline"
        size="sm"
        class="h-7 shrink-0 gap-1 px-2"
        onclick={() => void revokeLease()}
        data-testid="lease-revoke"
      >
        {t('projects.leaseRevoke')}
      </Button>
    {/if}
  </div>
{/if}
