<script lang="ts">
  import { ShieldAlert } from '@lucide/svelte';
  import { t } from '$lib/i18n';

  let { reason }: { reason?: string } = $props();
</script>

<div
  class="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
  data-testid="locked-page"
>
  <ShieldAlert class="size-10 text-muted-foreground" aria-hidden="true" />
  <h1 class="text-lg font-semibold">{t('locked.title')}</h1>
  {#if reason}
    <p class="max-w-md text-sm text-muted-foreground">{t('locked.reason', { reason })}</p>
  {/if}
  <p class="max-w-md text-sm text-muted-foreground">{t('locked.hint')}</p>
</div>
