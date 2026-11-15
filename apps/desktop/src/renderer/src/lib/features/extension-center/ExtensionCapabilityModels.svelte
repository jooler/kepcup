<script lang="ts">
  import { onMount } from 'svelte';
  import { AppError, type PluginCapabilityEntryGroup, type PluginInstanceSummary } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import { capabilityEntries } from '$lib/features/plugins/capability-entries.svelte';
  import { ENTRY_GROUP_LABEL_KEYS } from '$lib/features/bot-panel/bot-plugins';
  import CapabilityInstanceForm from '$lib/features/plugins/CapabilityInstanceForm.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';

  /**
   * 扩展中心 → 能力模型插件的详情视图（D124，60 号文档 §5）：
   * - 「模型条目」区：只读列表（能力徽标 / displayName / model / engine），每行
   *   「测试连接」→ `plugins.testCapabilityEntry`，结果以行内徽标回显（成功绿 /
   *   失败红 + 人话——errorText 走 media/http 错误码的既有文案映射）。
   * - 「账号实例」区：与 mail / im 实例管理同形（添加 / 编辑 / 删除 + 凭据表单）。
   *   多实例时条目行给「调用需在条目上指定实例」的行内提示（INSTANCE_AMBIGUOUS）。
   */

  let { pluginId }: { pluginId: string } = $props();

  const plugin = $derived(plugins.plugins.find((candidate) => candidate.id === pluginId) ?? null);
  const entries = $derived(capabilityEntries.entriesOf(pluginId));

  // --- 模型条目：逐条「测试连接」的行内状态 -----------------------------------
  type TestState = { state: 'running' | 'ok' | 'fail'; reason?: string };
  let testStates = $state<Record<string, TestState>>({});

  async function testEntry(entry: PluginCapabilityEntryGroup['entries'][number]): Promise<void> {
    const key = capabilityEntries.testKey(pluginId, entry.entryId);
    testStates = { ...testStates, [key]: { state: 'running' } };
    try {
      await core.call('plugins.testCapabilityEntry', { pluginId, entryId: entry.entryId });
      testStates = { ...testStates, [key]: { state: 'ok' } };
    } catch (error) {
      const reason =
        error instanceof AppError
          ? errorText(error.code, error.message)
          : error instanceof Error
            ? error.message
            : String(error);
      testStates = { ...testStates, [key]: { state: 'fail', reason } };
    }
  }

  // --- 账号实例：列表 + 添加 / 编辑 / 删除 ------------------------------------
  let instances = $state<PluginInstanceSummary[]>([]);
  let view = $state<'list' | 'add' | 'edit'>('list');
  let editTarget = $state<PluginInstanceSummary | null>(null);
  /** 实例操作在途（删除按钮禁用）。 */
  let busy = $state(false);

  function explain(error: unknown): string {
    if (error instanceof AppError) return errorText(error.code, error.message);
    return error instanceof Error ? error.message : String(error);
  }

  async function reload(): Promise<void> {
    const result = (await core.call('plugins.instances.list', { pluginId })) as {
      instances: PluginInstanceSummary[];
    };
    instances = result.instances.filter((instance) => instance.kind === 'capability-model');
  }

  function subtitle(instance: PluginInstanceSummary): string {
    const baseUrl = instance.values.baseUrl;
    if (typeof baseUrl === 'string' && baseUrl.length > 0) return baseUrl;
    return plugin?.name ?? pluginId;
  }

  async function removeInstance(instance: PluginInstanceSummary): Promise<void> {
    busy = true;
    try {
      await core.call('plugins.instances.delete', { id: instance.id });
      if (editTarget?.id === instance.id) {
        editTarget = null;
        view = 'list';
      }
      await reload();
    } catch (error) {
      toast.error(explain(error));
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    capabilityEntries.start();
    void capabilityEntries.load().catch(() => undefined);
    void plugins.load().catch(() => undefined);
    void reload().catch((error: unknown) => {
      toast.error(explain(error));
    });
    return core.onEvent('plugins.changed', () => {
      void reload().catch(() => undefined);
    });
  });
</script>

<div class="space-y-5" data-testid="extension-capability-models">
  <!-- 模型条目（只读 + 测试连接） -->
  <section class="space-y-2" data-testid="extension-capability-entries">
    <div class="space-y-0.5">
      <h2 class="text-sm font-medium">{t('plugins.capabilityModels.title')}</h2>
      <p class="text-xs text-muted-foreground">{t('plugins.capabilityModels.hint')}</p>
    </div>
    {#if capabilityEntries.loadError !== null}
      <p class="text-xs text-destructive" data-testid="capability-entries-error">
        {t('plugins.capabilityModels.loadFailed', { reason: capabilityEntries.loadError })}
      </p>
    {:else if entries.length === 0}
      <p class="text-xs text-muted-foreground" data-testid="capability-entries-empty">
        {capabilityEntries.loading ? t('apps.catalog.loading') : t('plugins.capabilityModels.noEntries')}
      </p>
    {:else}
      <ul class="space-y-2">
        {#each entries as entry (entry.entryId)}
          {@const key = capabilityEntries.testKey(pluginId, entry.entryId)}
          {@const state = testStates[key]}
          <li
            class="rounded-xl border px-3 py-2"
            data-testid={`capability-entry-${entry.entryId}`}
            data-configured={entry.configured}
          >
            <div class="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" class="text-[10px]">
                {t(ENTRY_GROUP_LABEL_KEYS[entry.capability])}
              </Badge>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium"
                  >{entry.displayName ?? entry.model}</span
                >
                <span class="block truncate text-xs text-muted-foreground"
                  >{entry.model} · {entry.engine}</span
                >
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={state?.state === 'running'}
                onclick={() => void testEntry(entry)}
                data-testid={`capability-entry-test-${entry.entryId}`}
              >
                {state?.state === 'running'
                  ? t('plugins.capabilityModels.testing')
                  : t('plugins.capabilityModels.test')}
              </Button>
            </div>
            {#if state?.state === 'ok'}
              <p
                class="mt-1 text-xs text-emerald-700 dark:text-emerald-400"
                data-testid={`capability-entry-test-ok-${entry.entryId}`}
              >
                {t('plugins.capabilityModels.testOk')}
              </p>
            {:else if state?.state === 'fail'}
              <p
                class="mt-1 text-xs text-destructive"
                data-testid={`capability-entry-test-error-${entry.entryId}`}
              >
                {t('plugins.capabilityModels.testFailed', { reason: state.reason ?? '' })}
              </p>
            {/if}
            {#if !entry.configured}
              <p class="mt-1 text-xs text-amber-700 dark:text-amber-400">
                {t('botPanel.plugins.entryNotConfigured')}：{t('plugins.capabilityModels.notConfiguredHint')}
              </p>
            {:else if entry.instanceState === 'multi'}
              <p
                class="mt-1 text-xs text-amber-700 dark:text-amber-400"
                data-testid={`capability-entry-multi-${entry.entryId}`}
              >
                {t('plugins.capabilityModels.multiInstance')}
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- 账号实例（与 mail / im 实例管理同形） -->
  <section class="space-y-2 border-t pt-4" data-testid="extension-capability-instances">
    <div class="space-y-0.5">
      <h2 class="text-sm font-medium">{t('plugins.capabilityModels.instances')}</h2>
      <p class="text-xs text-muted-foreground">{t('plugins.capabilityModels.instancesHint')}</p>
    </div>
    {#if view === 'list'}
      <div class="flex justify-end">
        <Button
          size="sm"
          onclick={() => (view = 'add')}
          disabled={plugin === null || !plugin.enabled}
          data-testid="capability-instance-add"
        >
          {t('plugins.capabilityModels.addInstance')}
        </Button>
      </div>
      {#if instances.length === 0}
        <p class="text-xs text-muted-foreground" data-testid="capability-instances-empty">
          {t('plugins.capabilityModels.empty')}
        </p>
      {:else}
        <ul class="space-y-2">
          {#each instances as instance (instance.id)}
            <li>
              <button
                type="button"
                class="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm hover:bg-accent/40"
                onclick={() => {
                  editTarget = instance;
                  view = 'edit';
                }}
                data-testid={`capability-instance-${instance.id}`}
              >
                <span class="min-w-0">
                  <span class="block truncate font-medium">{instance.title}</span>
                  <span class="block truncate text-xs text-muted-foreground"
                    >{subtitle(instance)}</span
                  >
                </span>
                <span class="shrink-0 text-xs text-muted-foreground">{t('mcp.editHint')}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if view === 'add'}
      <div class="space-y-3" data-testid="capability-instance-add-view">
        <Button type="button" variant="ghost" size="sm" onclick={() => (view = 'list')}>
          {t('mcp.back')}
        </Button>
        <CapabilityInstanceForm
          {pluginId}
          testidPrefix="capability-instance-add"
          onSaved={async () => {
            await reload();
            view = 'list';
          }}
        />
      </div>
    {:else if editTarget !== null}
      <div class="space-y-4" data-testid="capability-instance-edit-view">
        <Button type="button" variant="ghost" size="sm" onclick={() => (view = 'list')}>
          {t('mcp.back')}
        </Button>
        <div>
          <h3 class="text-sm font-medium">{editTarget.title}</h3>
          <p class="text-xs text-muted-foreground">{subtitle(editTarget)}</p>
        </div>
        <CapabilityInstanceForm
          {pluginId}
          instance={editTarget}
          testidPrefix="capability-instance-edit"
          onSaved={async () => {
            await reload();
            view = 'list';
          }}
        />
        <div>
          <Button
            variant="outline"
            disabled={busy}
            onclick={() => {
              const target = editTarget;
              if (target !== null) void removeInstance(target);
            }}
            data-testid="capability-instance-delete"
          >
            {t('mcp.delete')}
          </Button>
        </div>
      </div>
    {/if}
  </section>
</div>
