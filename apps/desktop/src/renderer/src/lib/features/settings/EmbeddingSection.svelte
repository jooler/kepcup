<script lang="ts">
  import type { EmbeddingStatus } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';

  /**
   * 「向量来源」section（docs/design/16-capability-models.md）：本地模型或
   * 使用「向量模型」section 的厂商配置（capabilityModels.embedding）。
   */
  let status = $state<EmbeddingStatus | null>(null);
  let source = $state<'local' | 'provider'>('local');
  let saving = $state(false);

  $effect(() => {
    void refresh();
  });

  /** 「向量模型」section 的配置是否齐备（厂商 + 模型 + key）。 */
  const embeddingConfigured = $derived(settingsStore.settings?.capabilityModels.embedding ?? null);
  const embeddingVendorHasKey = $derived(
    embeddingConfigured !== null &&
      (settingsStore.providers.find((p) => p.id === embeddingConfigured.vendor)?.hasKey ?? false),
  );

  async function refresh(): Promise<void> {
    status = (await core.call('embedding.status')) as EmbeddingStatus;
    if (status.source === 'provider') {
      source = 'provider';
    } else if (status.source === 'local') {
      source = 'local';
    }
  }

  async function save(): Promise<void> {
    saving = true;
    try {
      status = (await core.call('embedding.configure', { source })) as EmbeddingStatus;
      toast.success(t('settings.embeddingSaved'));
    } catch {
      toast.error(t('common.actionFailed'));
    } finally {
      saving = false;
    }
  }
</script>

<section class="space-y-3" data-testid="settings-embedding">
  <h3 class="text-sm font-medium">{t('settings.embeddingSection')}</h3>
  <p class="text-xs text-muted-foreground">{t('settings.embeddingNote')}</p>

  {#if status}
    <div class="flex flex-wrap items-center gap-2 text-sm" data-testid="embedding-status">
      <Badge variant={status.ready ? 'default' : 'outline'} data-testid="embedding-ready-badge">
        {status.ready ? t('settings.embeddingReady') : t('settings.embeddingNotReady')}
      </Badge>
      <span data-testid="embedding-source-label">
        {status.source === 'local'
          ? t('settings.embeddingSourceLocal')
          : status.source === 'provider'
            ? t('settings.embeddingSourceProvider')
            : t('settings.embeddingSourceNone')}
      </span>
      {#if status.source === 'provider' && status.provider.length > 0}
        <span class="text-xs text-muted-foreground">{status.provider}/{status.model}</span>
      {/if}
      {#if status.dim !== null}
        <span class="text-xs text-muted-foreground"
          >{t('settings.embeddingDim', { dim: status.dim })}</span
        >
      {/if}
      {#if !status.ready && status.reason}
        <p class="w-full text-xs text-muted-foreground" data-testid="embedding-reason">
          {status.reason}
        </p>
      {/if}
    </div>
  {/if}

  <div class="space-y-3 rounded-xl border px-4 py-3.5" data-testid="embedding-editor">
    <div class="flex flex-wrap gap-4">
      <label class="flex items-center gap-1.5 text-sm">
        <input
          type="radio"
          name="embedding-source"
          value="local"
          bind:group={source}
          data-testid="embedding-source-local"
        />
        {t('settings.embeddingSourceLocal')}
      </label>
      <label class="flex items-center gap-1.5 text-sm">
        <input
          type="radio"
          name="embedding-source"
          value="provider"
          bind:group={source}
          data-testid="embedding-source-provider"
        />
        {t('settings.embeddingSourceProvider')}
      </label>
    </div>

    {#if source === 'provider' && (embeddingConfigured === null || !embeddingVendorHasKey)}
      <p class="text-xs text-amber-700 dark:text-amber-400" data-testid="embedding-no-vendor-config">
        {t('settings.embeddingNoVendorConfig')}
      </p>
    {/if}

    <Button size="sm" disabled={saving} onclick={() => void save()} data-testid="embedding-save">
      {t('common.save')}
    </Button>
  </div>
</section>
