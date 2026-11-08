<script lang="ts">
  import type { CollabClientRef } from '@kepcup/shared';
  import { t } from '$lib/i18n';

  /** 只读提示：另一位客户端持有共享草稿的编辑权（D120 §7）。 */
  let {
    owner,
    onTakeover,
  }: {
    owner: CollabClientRef | null;
    onTakeover: () => void;
  } = $props();

  function confirmTakeover(): void {
    if (typeof window !== 'undefined' && !window.confirm(t('collab.takeoverConfirm'))) return;
    onTakeover();
  }
</script>

<div
  class="mb-1 flex items-center gap-2 rounded-xl border border-dashed bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
  data-testid="composer-collab-readonly"
>
  <span class="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true"></span>
  <span class="min-w-0 flex-1 truncate">
    {owner === null ? t('collab.draftReadonly') : t('collab.draftOwner', { name: owner.name })}
  </span>
  {#if owner !== null}
    <button
      type="button"
      class="shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent"
      data-testid="composer-collab-takeover"
      onclick={confirmTakeover}
    >
      {t('collab.takeover')}
    </button>
  {/if}
</div>
