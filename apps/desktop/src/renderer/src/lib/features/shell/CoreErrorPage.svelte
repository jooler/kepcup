<script lang="ts">
  import { CircleAlert } from '@lucide/svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { t } from '$lib/i18n';

  const logsPath = $derived(
    core.info?.dataDir ? `${core.info.dataDir}/logs` : '~/.kepcup/logs',
  );
</script>

<div
  class="flex h-full flex-col items-center justify-center gap-4 bg-background p-8 text-center"
  data-testid="core-error-page"
>
  <CircleAlert class="size-10 text-destructive" aria-hidden="true" />
  <h1 class="text-lg font-semibold">{t('shell.coreFailed')}</h1>
  <p class="max-w-md text-sm text-muted-foreground">{t('shell.coreFailedHint')}</p>
  <p class="font-mono text-xs text-muted-foreground">{t('shell.logsHint', { path: logsPath })}</p>
</div>
