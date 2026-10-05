<script lang="ts">
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { sandboxWizard } from '$lib/stores/sandbox-wizard.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  let fixDialogOpen = $state(false);
  let probing = $state(false);
  let copied = $state(false);

  const status = $derived(settingsStore.sandboxStatus);

  $effect(() => {
    void settingsStore.refreshSandbox(false);
  });

  async function reprobe(): Promise<void> {
    probing = true;
    try {
      await settingsStore.refreshSandbox(true);
    } finally {
      probing = false;
      copied = false;
    }
  }

  async function copyFix(): Promise<void> {
    if (status?.fixHint === undefined) return;
    await navigator.clipboard.writeText(status.fixHint);
    copied = true;
  }

  /** P12-B: human-readable backend kind (srt/wsl/lima/podman/none). */
  function backendLabel(backend: 'srt' | 'wsl' | 'lima' | 'podman' | 'none'): string {
    if (backend === 'srt') return 'srt';
    if (backend === 'wsl') return 'WSL2';
    if (backend === 'lima') return 'Lima';
    if (backend === 'podman') return 'Podman';
    return t('settings.sandboxBackendNone');
  }

  function enhancedLabel(backend: 'lima' | 'podman' | 'wsl'): string {
    if (backend === 'lima') return 'Lima';
    if (backend === 'podman') return 'Podman';
    return 'WSL2';
  }
</script>

<section class="space-y-3" data-testid="settings-sandbox">
  <h3 class="text-sm font-medium">{t('settings.sandboxSection')}</h3>
  {#if status === null}
    <p class="text-xs text-muted-foreground">{t('settings.sandboxChecking')}</p>
  {:else}
    <div class="flex flex-wrap items-center gap-2" data-testid="sandbox-status">
      <Badge variant={status.available ? 'default' : 'destructive'} data-testid="sandbox-state">
        {status.available ? t('settings.sandboxAvailable') : t('settings.sandboxUnavailable')}
      </Badge>
      <span class="text-xs text-muted-foreground" data-testid="sandbox-backend">
        {t('settings.sandboxBackend', { backend: backendLabel(status.backend) })}
      </span>
      {#if !status.available && status.reason !== undefined}
        <span class="w-full text-xs text-muted-foreground" data-testid="sandbox-reason">{status.reason}</span>
      {/if}
    </div>
    {#if status.enhanced !== null && status.enhanced !== undefined}
      <!-- P12-B: enhanced-level sub state (Windows: null — the WSL distro serves both levels) -->
      <div class="flex flex-wrap items-center gap-2" data-testid="sandbox-enhanced">
        <Badge
          variant={status.enhanced.available ? 'default' : 'outline'}
          data-testid="sandbox-enhanced-state"
        >
          {status.enhanced.available
            ? t('settings.sandboxEnhancedAvailable')
            : t('settings.sandboxEnhancedMissing')}
        </Badge>
        <span class="text-xs text-muted-foreground" data-testid="sandbox-enhanced-backend">
          {t('settings.sandboxEnhancedLabel', { backend: enhancedLabel(status.enhanced.backend) })}
        </span>
        {#if !status.enhanced.available && status.enhanced.reason !== undefined}
          <span class="w-full text-xs text-muted-foreground" data-testid="sandbox-enhanced-reason">
            {status.enhanced.reason}
          </span>
        {/if}
      </div>
    {/if}
    <p class="text-xs text-muted-foreground">{t('settings.sandboxNote')}</p>
    {#if status.backend === 'wsl'}
      <p class="text-xs text-muted-foreground" data-testid="sandbox-shared-vm-note">
        {t('settings.sandboxSharedVmNote')}
      </p>
    {/if}
    <div class="flex gap-2">
      <Button size="sm" variant="outline" disabled={probing} onclick={() => void reprobe()} data-testid="sandbox-reprobe">
        {probing ? t('settings.sandboxChecking') : t('settings.sandboxReprobe')}
      </Button>
      <!-- P12-B 任务 7：可随时从设置页开始准备（向导按平台渲染内容） -->
      <Button size="sm" variant="secondary" onclick={() => sandboxWizard.show()} data-testid="sandbox-wizard-open">
        {t('settings.sandboxWizardOpen')}
      </Button>
      {#if !status.available && status.fixHint !== undefined}
        <Button size="sm" variant="secondary" onclick={() => (fixDialogOpen = true)} data-testid="sandbox-fix-open">
          {t('settings.sandboxFixOpen')}
        </Button>
      {/if}
    </div>
  {/if}
</section>

<Dialog bind:open={fixDialogOpen}>
  <DialogContent data-testid="sandbox-fix-dialog">
    <DialogHeader>
      <DialogTitle>{t('settings.sandboxFixTitle')}</DialogTitle>
      <DialogDescription>{t('settings.sandboxFixDescription')}</DialogDescription>
    </DialogHeader>
    <pre class="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs" data-testid="sandbox-fix-command">{status?.fixHint}</pre>
    <div class="flex gap-2">
      <Button size="sm" variant="outline" onclick={() => void copyFix()} data-testid="sandbox-fix-copy">
        {copied ? t('settings.sandboxFixCopied') : t('settings.sandboxFixCopy')}
      </Button>
      <Button size="sm" onclick={() => void reprobe()} data-testid="sandbox-fix-reprobe">
        {t('settings.sandboxFixReprobe')}
      </Button>
    </div>
  </DialogContent>
</Dialog>
