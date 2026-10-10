<script lang="ts">
  import type { EmbeddingStatus } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { environmentStore } from '$lib/stores/environment.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';

  /**
   * 「向量来源」section（docs/design/16-capability-models.md）：本地模型或
   * 使用「向量模型」section 的厂商配置（capabilityModels.embedding）。
   */
  let status = $state<EmbeddingStatus | null>(null);
  let source = $state<'local' | 'provider'>('local');
  let saving = $state(false);
  let downloading = $state(false);

  $effect(() => {
    environmentStore.start();
    void environmentStore.refresh();
    void refresh();
  });

  /** 本地向量模型的安装行（environment.changed / progress 事件实时更新）。 */
  const modelInstall = $derived(
    environmentStore.installs.find((install) => install.item === 'embedding-model') ?? null,
  );
  const modelReady = $derived(modelInstall?.status === 'installed');
  const downloadProgress = $derived(
    modelInstall?.status === 'installing'
      ? (environmentStore.progress[modelInstall.id] ?? null)
      : null,
  );
  const downloadPercent = $derived.by(() => {
    const event = downloadProgress;
    if (event === null || event.totalBytes === undefined || event.totalBytes <= 0) return null;
    return Math.min(100, Math.round(((event.receivedBytes ?? 0) / event.totalBytes) * 100));
  });

  // 安装落位（environment.changed 翻转行状态）后重取状态，徽章翻为「已就绪」。
  $effect(() => {
    if (modelReady) void refresh();
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

  /** 手动下载本地模型：用户点击即同意，core 侧直接安装（不再发审批卡）。 */
  async function downloadModel(): Promise<void> {
    downloading = true;
    try {
      await core.call('embedding.download');
      toast.success(t('settings.embeddingDownloadStarted'));
    } catch {
      toast.error(t('common.actionFailed'));
    } finally {
      downloading = false;
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

    {#if source === 'local' && !modelReady}
      {#if modelInstall?.status === 'installing'}
        <div class="space-y-1" data-testid="embedding-download-progress">
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span
              >{downloadProgress === null
                ? t('approvals.environmentPreparing')
                : t(`approvals.envStage.${downloadProgress.stage}`)}</span
            >
            {#if downloadPercent !== null}<span>{downloadPercent}%</span>{/if}
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              class="h-full rounded-full bg-amber-500 transition-all"
              style="width: {downloadPercent ?? 8}%"
              data-testid="embedding-download-progress-bar"
            ></div>
          </div>
        </div>
      {:else}
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={downloading}
            onclick={() => void downloadModel()}
            data-testid="embedding-download"
          >
            {t('settings.embeddingDownload')}
          </Button>
        </div>
      {/if}
    {/if}

    {#if source === 'provider' && (embeddingConfigured === null || !embeddingVendorHasKey)}
      <p
        class="text-xs text-amber-700 dark:text-amber-400"
        data-testid="embedding-no-vendor-config"
      >
        {t('settings.embeddingNoVendorConfig')}
      </p>
    {/if}

    <Button size="sm" disabled={saving} onclick={() => void save()} data-testid="embedding-save">
      {t('common.save')}
    </Button>
  </div>
</section>
