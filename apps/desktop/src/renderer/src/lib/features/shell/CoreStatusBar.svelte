<script lang="ts">
  import { core } from '$lib/rpc/client.svelte';
  import { t } from '$lib/i18n';

  let pingOk = $state<boolean | null>(null);

  $effect(() => {
    if (core.connection !== 'connected') return;
    let cancelled = false;
    const check = async () => {
      try {
        await core.call('system.ping');
        if (!cancelled) pingOk = true;
        void core.refreshInfo();
      } catch {
        if (!cancelled) pingOk = false;
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  });

  const statusText = $derived.by(() => {
    const status = core.coreStatus?.status;
    if (!status) return t('shell.coreStarting');
    return t(`coreStatus.${status}` as const);
  });
</script>

<footer
  class="flex h-7 shrink-0 items-center justify-between border-t bg-background px-3 text-xs text-muted-foreground"
  data-testid="core-status-bar"
>
  <span class="flex items-center gap-1.5">
    <span
      class="size-1.5 rounded-full
        {core.connection === 'connected' && core.coreStatus?.status === 'ready'
        ? 'bg-emerald-500'
        : 'bg-amber-500'}"
    ></span>
    核心：{statusText}
  </span>
  <span class="flex items-center gap-3" data-testid="ping-result">
    {#if pingOk !== null}
      <span>ping {pingOk ? '✓' : '✗'}</span>
    {/if}
    {#if core.info}
      <span>Node {core.info.nodeVersion}</span>
    {/if}
  </span>
</footer>
