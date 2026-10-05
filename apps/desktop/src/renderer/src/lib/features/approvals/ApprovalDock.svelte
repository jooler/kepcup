<script lang="ts">
  import { permissions } from '$lib/stores/permissions.svelte';
  import ApprovalCard from './ApprovalCard.svelte';

  let { conversationId }: { conversationId: string } = $props();

  // 逐张聚焦：每次待确认集合变化（新卡片到达 / 前一张处理完）都把焦点交给
  // 队首卡片（docs/design/12-ui-layout.md 焦点三）。
  const pending = $derived(
    permissions.pendingOf(conversationId).sort((a, b) => a.createdAt - b.createdAt),
  );

  let dockEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    void pending.length;
    queueMicrotask(() => {
      dockEl?.querySelector<HTMLElement>('[data-testid^="approval-card-"]')?.focus();
    });
  });
</script>

{#if pending.length > 0}
  <div class="space-y-2 px-4 py-2" bind:this={dockEl} data-testid="approval-dock" data-pending-count={pending.length}>
    {#each pending as approval (approval.id)}
      <ApprovalCard {approval} />
    {/each}
  </div>
{/if}
