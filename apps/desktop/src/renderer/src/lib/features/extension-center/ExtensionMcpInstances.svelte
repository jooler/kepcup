<script lang="ts">
  import { onMount } from 'svelte';
  import { Wrench } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { AppError, type PluginInstanceSummary } from '@kepcup/shared';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import { Button } from '$lib/components/ui/button';
  import McpInstanceForm from '$lib/features/plugins/McpInstanceForm.svelte';

  /**
   * 扩展中心「工具」实例视图（P4-M2）：提供 mcp 实例能力的插件的实例列表——每行
   * 显示备注名 / 端点；「添加」引导到实例表单（从插件卡进入时默认选中该插件）。
   * 编辑 = 同一张表单（URL 续期 / 令牌轮换），删除走实例级联（server、secrets
   * 一并清场）。固定投影贡献（MCPB / 固定 http）的插件仍走 ExtensionMcp（McpSection）。
   */

  /** 插件卡「管理」传入的插件 id：添加时默认选中；未传时聚合全部 mcp 实例插件。 */
  let {
    embedded = false,
    pluginId = undefined,
  }: { embedded?: boolean; pluginId?: string | undefined } = $props();

  let instances = $state<PluginInstanceSummary[]>([]);
  let view = $state<'list' | 'add' | 'edit'>('list');
  let addPluginId = $state<string | null>(null);
  let editTarget = $state<PluginInstanceSummary | null>(null);

  /** 提供 mcp 实例能力的已启用插件（添加入口的候选）。 */
  const mcpPlugins = $derived(
    plugins.plugins.filter((plugin) => plugin.enabled && plugin.providesInstances.includes('mcp')),
  );

  const scopedPlugins = $derived(
    pluginId === undefined ? mcpPlugins : mcpPlugins.filter((plugin) => plugin.id === pluginId),
  );

  const visible = $derived(
    pluginId === undefined
      ? instances
      : instances.filter((instance) => instance.pluginId === pluginId),
  );

  /** 按归属插件分组（mcp 实例恒有属主）。 */
  const groups = $derived.by(() => {
    // Plain Map: group instances for one render pass, not reactive UI state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const map = new Map<string, PluginInstanceSummary[]>();
    for (const instance of visible) {
      const list = map.get(instance.pluginId) ?? [];
      list.push(instance);
      map.set(instance.pluginId, list);
    }
    return [...map.entries()];
  });

  function subtitle(instance: PluginInstanceSummary): string {
    const url = instance.values.url;
    if (typeof url === 'string' && url.length > 0) return url;
    return plugins.nameOf(instance.pluginId);
  }

  async function reload(): Promise<void> {
    const candidates = scopedPlugins.map((plugin) => plugin.id);
    if (candidates.length === 0) {
      instances = [];
    } else {
      const results = await Promise.all(
        candidates.map(
          (id) =>
            core.call('plugins.instances.list', { pluginId: id }) as Promise<{
              instances: PluginInstanceSummary[];
            }>,
        ),
      );
      instances = results.flatMap((result) =>
        result.instances.filter((instance) => instance.kind === 'mcp'),
      );
    }
    // 实例落地 / 删除会改写 `settings.mcpServers`，但实例 RPC 只广播 `plugins.changed`
    // （domain 的 settings.update 只写库）——下方同屏的 MCP 服务器管理区读的是
    // settingsStore，必须在这里显式对齐，否则添加首个实例后服务器区仍空、删除后残留旧行。
    await settingsStore.refresh();
  }

  onMount(() => {
    // 插件卡「管理」直达：默认选中该插件的添加流程（卡片视图每次挂载传入）。
    if (pluginId !== undefined) addPluginId = pluginId;
    void plugins.load().catch(() => undefined);
    void reload().catch((error: unknown) => {
      toast.error(error instanceof AppError ? errorText(error.code, error.message) : String(error));
    });
    return core.onEvent('plugins.changed', () => {
      void reload().catch(() => undefined);
    });
  });

  function explain(error: unknown): string {
    if (error instanceof AppError) return errorText(error.code, error.message);
    return error instanceof Error ? error.message : String(error);
  }

  async function remove(instance: PluginInstanceSummary): Promise<void> {
    try {
      await core.call('plugins.instances.delete', { id: instance.id });
      if (editTarget?.id === instance.id) {
        editTarget = null;
        view = 'list';
      }
      await reload();
    } catch (error) {
      toast.error(explain(error));
    }
  }
</script>

<div
  class={embedded ? 'min-w-0 pt-3' : 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-3 pr-0.5'}
  data-testid="extension-mcp-instances"
>
  {#if view === 'list'}
    <div class="mb-3 flex items-center justify-between gap-2">
      <p class="text-xs text-muted-foreground">{t('mcp.intro')}</p>
      <Button
        size="sm"
        onclick={() => {
          addPluginId =
            pluginId ?? (scopedPlugins.length === 1 ? (scopedPlugins[0]!.id ?? null) : null);
          view = 'add';
        }}
        disabled={mcpPlugins.length === 0}
        data-testid="mcp-add"
      >
        {t('mcp.add')}
      </Button>
    </div>
    {#if mcpPlugins.length === 0}
      <div
        class="mb-3 rounded-xl border border-dashed px-4 py-3 text-center text-sm text-muted-foreground"
        data-testid="mcp-no-plugin"
      >
        <p>{t('mcp.noPlugin')}</p>
        <Button
          size="sm"
          variant="outline"
          class="mt-2"
          onclick={() => shell.openExtensionCenter('market')}
          data-testid="mcp-market-deeplink"
        >
          {t('mcp.openMarket')}
        </Button>
      </div>
    {/if}
    {#if visible.length === 0}
      <div
        class="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="mcp-empty"
      >
        <Wrench class="mx-auto mb-2 size-5" aria-hidden="true" />
        <p>{t('mcp.empty')}</p>
      </div>
    {:else}
      <div class="space-y-4">
        {#each groups as [pluginKey, groupInstances] (pluginKey)}
          <section>
            <p
              class="mb-1.5 text-xs font-medium text-muted-foreground"
              data-testid={`mcp-group-${pluginKey}`}
            >
              {plugins.nameOf(pluginKey)}
            </p>
            <ul class="space-y-2">
              {#each groupInstances as instance (instance.id)}
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm hover:bg-accent/40"
                    onclick={() => {
                      editTarget = instance;
                      view = 'edit';
                    }}
                    data-testid={`mcp-instance-${instance.id}`}
                  >
                    <span class="min-w-0">
                      <span class="block truncate font-medium">{instance.title}</span>
                      <span class="block truncate text-xs text-muted-foreground"
                        >{subtitle(instance)}</span
                      >
                    </span>
                    <span class="shrink-0 text-xs text-muted-foreground">
                      {t('mcp.editHint')}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}
  {:else if view === 'add'}
    <div class="space-y-3" data-testid="mcp-add-view">
      <Button type="button" variant="ghost" size="sm" onclick={() => (view = 'list')}>
        {t('mcp.back')}
      </Button>
      {#if mcpPlugins.length === 0}
        <p class="text-sm text-muted-foreground">{t('mcp.noPlugin')}</p>
      {:else if mcpPlugins.length === 1 && addPluginId !== null}
        <McpInstanceForm
          pluginId={addPluginId}
          onSaved={async () => {
            await reload();
            view = 'list';
          }}
        />
      {:else}
        <div class="space-y-2">
          {#each mcpPlugins as plugin (plugin.id)}
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm hover:bg-accent/40"
              onclick={() => (addPluginId = plugin.id)}
              data-testid={`mcp-pick-${plugin.id}`}
            >
              <span class="min-w-0">
                <span class="block truncate font-medium">{plugin.name}</span>
                {#if plugin.description.length > 0}
                  <span class="block truncate text-xs text-muted-foreground"
                    >{plugin.description}</span
                  >
                {/if}
              </span>
              <span class="shrink-0 text-xs text-muted-foreground">
                {t('mcp.instanceCount', { count: plugin.instanceCounts.mcp })}
              </span>
            </button>
          {/each}
        </div>
        {#if addPluginId !== null}
          <McpInstanceForm
            pluginId={addPluginId}
            onSaved={async () => {
              await reload();
              view = 'list';
            }}
          />
        {/if}
      {/if}
    </div>
  {:else if editTarget !== null}
    <div class="space-y-4" data-testid="mcp-edit-view">
      <Button type="button" variant="ghost" size="sm" onclick={() => (view = 'list')}>
        {t('mcp.back')}
      </Button>
      <div>
        <h2 class="text-sm font-medium">{editTarget.title}</h2>
        <p class="text-xs text-muted-foreground">{subtitle(editTarget)}</p>
        <p class="mt-1 text-xs text-muted-foreground">
          {t('mcp.ownerOf', { plugin: plugins.nameOf(editTarget.pluginId) })}
        </p>
      </div>
      <McpInstanceForm
        pluginId={editTarget.pluginId}
        instance={editTarget}
        onSaved={async () => {
          await reload();
          view = 'list';
        }}
      />
      <div>
        <Button
          variant="outline"
          onclick={() => {
            const target = editTarget;
            if (target !== null) void remove(target);
          }}
          data-testid="mcp-delete"
        >
          {t('mcp.delete')}
        </Button>
      </div>
    </div>
  {/if}
</div>
