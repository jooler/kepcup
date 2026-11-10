<script lang="ts">
  import type { CollabPresenceEntry } from '@kepcup/shared';
  import { t } from '$lib/i18n';

  /** 输入区上方的其他客户端提示（D119，docs/design/57 §3.4）。 */
  let { entries }: { entries: CollabPresenceEntry[] } = $props();

  const typing = $derived(entries.filter((entry) => entry.state === 'typing'));
  const visible = $derived(entries.slice(0, 3));
  const label = $derived(
    typing.length === 0
      ? t('collab.online', { count: entries.length })
      : typing.length === 1
        ? t('collab.typing', { name: typing[0]!.clientName })
        : t('collab.typingMany', { count: typing.length }),
  );
</script>

<div
  class="mb-1 flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground"
  data-testid="composer-presence"
>
  <div class="flex -space-x-1">
    {#each visible as entry (entry.clientId)}
      <span
        class="flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-medium text-white ring-1 ring-background"
        style:background-color={entry.color}
        title={entry.clientName}
      >
        {entry.clientName.slice(0, 1).toUpperCase()}
      </span>
    {/each}
    {#if entries.length > visible.length}
      <span
        class="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] text-muted-foreground ring-1 ring-background"
        title={entries
          .slice(visible.length)
          .map((entry) => entry.clientName)
          .join(', ')}
      >
        +{entries.length - visible.length}
      </span>
    {/if}
  </div>
  <span class="truncate" data-testid="composer-presence-label">{label}</span>
</div>
