<script lang="ts">
  import { untrack } from 'svelte';
  import type { PluginInstanceSummary, SettingValues } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import McpInstanceForm from '$lib/features/plugins/McpInstanceForm.svelte';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { Button } from '$lib/components/ui/button';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { applySettingItem } from './apply';
  import { prefillString } from './setting-card-model';

  /**
   * 插件工具服务卡（`mcp.instance`）：选插件 → 新建或编辑一个工具服务（表单按插件声明的
   * 实例字段动态构建，token 等凭据进 secrets、永不回显）→ 逐个勾选授权给这个 Bot
   * （写入 `mcp_server_ids`，经 `bot.mcp-servers` 条目的条目级 CAS）。实例保存用扩展中心
   * 原有的 `plugins.instances.*` RPC，保存后由 `completeCard` 核对结卡。
   */

  let {
    botId,
    prefill = null,
    testid = 'setting-card-mcp-instance',
    onSaved,
  }: {
    botId: string;
    prefill?: SettingValues | null;
    testid?: string;
    onSaved?: (values?: SettingValues) => void;
  } = $props();

  const candidates = $derived(
    plugins.plugins.filter((plugin) => plugin.providesInstances.includes('mcp')),
  );
  let pluginId = $state(untrack(() => prefillString(prefill, 'plugin') ?? ''));
  /** '' = 新建；否则编辑这个实例。 */
  let instanceId = $state(untrack(() => prefillString(prefill, 'instance') ?? ''));
  let instances = $state<PluginInstanceSummary[]>([]);
  let instancesLoading = $state(false);
  let busy = $state(false);
  /** 每个实例 serverId 的检测结果（保存后 / 点「检测连接」时更新；R1 可见性）。 */
  let testState = $state<Record<string, { busy: boolean; ok: boolean; text: string }>>({});

  const selected = $derived(candidates.find((plugin) => plugin.id === pluginId) ?? null);
  const editing = $derived(instances.find((entry) => entry.id === instanceId) ?? null);
  const bot = $derived(contacts.bots.find((entry) => entry.id === botId) ?? null);
  const authorizedIds = $derived(bot?.profile.runtime.mcp_server_ids ?? []);
  /** 带落地 serverId 的实例（只有 mcp 实例有；授权勾选只列这些）。 */
  const authorizable = $derived(
    instances.filter((entry): entry is PluginInstanceSummary & { serverId: string } =>
      entry.serverId !== undefined),
  );

  $effect(() => {
    plugins.start();
    void plugins.load().catch(() => undefined);
    contacts.start();
    settingsStore.start();
    if (contacts.bots.length === 0) void contacts.refresh().catch(() => undefined);
  });

  // 插件清单到位后选一个缺省插件（优先这个 Bot 已启用的）；预填的 id 不在清单里（已卸载）也回退。
  $effect(() => {
    if (candidates.length === 0) return;
    if (pluginId.length > 0 && candidates.some((plugin) => plugin.id === pluginId)) return;
    const enabledIds = new Set(bot?.profile.runtime.plugin_ids ?? []);
    const preferred =
      candidates.find((plugin) => enabledIds.has(plugin.id) && plugin.enabled) ??
      candidates.find((plugin) => plugin.enabled) ??
      candidates[0]!;
    pluginId = preferred.id;
  });

  async function loadInstances(id: string): Promise<void> {
    instancesLoading = true;
    try {
      const result = (await core.call('plugins.instances.list', { pluginId: id })) as {
        instances: PluginInstanceSummary[];
      };
      instances = result.instances.filter((entry) => entry.kind === 'mcp');
    } catch {
      instances = [];
    } finally {
      instancesLoading = false;
    }
  }

  // 实例清单随插件拉取；用户换插件时回到「新建」，初次挂载保留预填的编辑目标。
  let lastPluginId = '';
  $effect(() => {
    const id = pluginId;
    if (id.length === 0) return;
    void loadInstances(id);
    if (lastPluginId !== '' && lastPluginId !== id) instanceId = '';
    lastPluginId = id;
  });

  function explain(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** 授权勾选：走 `bot.mcp-servers` 的条目级 CAS（不带 messageId，独立于本卡的保存）。 */
  async function toggleAuthorize(serverId: string, checked: boolean): Promise<void> {
    if (busy || bot === null) return;
    const current = bot.profile.runtime.mcp_server_ids ?? [];
    const servers = checked
      ? current.includes(serverId)
        ? current
        : [...current, serverId]
      : current.filter((entry) => entry !== serverId);
    busy = true;
    try {
      await applySettingItem({ itemId: 'bot.mcp-servers', values: { servers }, expected: null });
      bot.profile.runtime.mcp_server_ids = servers;
    } catch (error) {
      toast.error(t('settingCard.actionFailed', { error: explain(error) }));
    } finally {
      busy = false;
    }
  }

  async function instanceSaved(): Promise<void> {
    const before = new Set(instances.map((entry) => entry.serverId).filter(Boolean));
    await loadInstances(pluginId);
    // 新建的实例默认授权给当前 Bot（用户是从这个 Bot 的设置卡里填的凭据）。
    const created = instances.find(
      (entry) => entry.serverId !== undefined && !before.has(entry.serverId),
    );
    if (created?.serverId !== undefined) await toggleAuthorize(created.serverId, true);
    await settingsStore.refresh().catch(() => undefined);
    // 保存后立刻检测一次，把工具数 / 缺凭据 / 失败原因回显在卡上（不自动结卡，用户看完再点「完成」）。
    const target = created?.serverId ?? editing?.serverId;
    if (target !== undefined) void testInstance(target);
  }

  /** 实时检测：`mcp.test` 用完整 server 配置连一次，把工具数 / 缺凭据 / 失败原因显示在卡上。 */
  async function testInstance(serverId: string): Promise<void> {
    const server = settingsStore.settings?.mcpServers?.find((entry) => entry.id === serverId);
    if (server === undefined) {
      testState = { ...testState, [serverId]: { busy: false, ok: false, text: t('mcpCard.testNoServer') } };
      return;
    }
    testState = { ...testState, [serverId]: { busy: true, ok: false, text: t('mcpCard.testing') } };
    try {
      const result = (await core.call('mcp.test', { server })) as {
        tools: string[];
        missingSecrets: string[];
        message?: string;
      };
      const text =
        result.missingSecrets.length > 0
          ? t('mcpCard.testMissing', { names: result.missingSecrets.join('、') })
          : result.tools.length === 0
            ? t('mcpCard.testFail', { error: result.message ?? '0 个工具' })
            : t('mcpCard.testOk', { count: String(result.tools.length) });
      testState = {
        ...testState,
        [serverId]: { busy: false, ok: result.missingSecrets.length === 0 && result.tools.length > 0, text },
      };
    } catch (error) {
      testState = {
        ...testState,
        [serverId]: { busy: false, ok: false, text: t('mcpCard.testFail', { error: explain(error) }) },
      };
    }
  }
</script>

<div class="grid gap-2" data-testid={testid}>
  {#if candidates.length === 0}
    <p class="text-xs text-muted-foreground" data-testid={`${testid}-empty`}>
      {t('mcp.noPlugin')}
    </p>
  {:else}
    <Label for={`${testid}-plugin`}>{t('mcpCard.pickPlugin')}</Label>
    <select
      id={`${testid}-plugin`}
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      bind:value={pluginId}
      data-testid={`${testid}-plugin`}
    >
      {#each candidates as plugin (plugin.id)}
        <option value={plugin.id}>{plugin.name}</option>
      {/each}
    </select>

    {#if instancesLoading}
      <p class="text-xs text-muted-foreground" data-testid={`${testid}-loading`}>
        {t('apps.catalog.loading')}
      </p>
    {:else if instances.length === 0}
      <p class="text-xs text-muted-foreground" data-testid={`${testid}-no-instances`}>
        {t('mcpCard.newInstanceHint')}
      </p>
    {:else}
      <Label for={`${testid}-instance`}>{t('mcpCard.instance')}</Label>
      <select
        id={`${testid}-instance`}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={instanceId}
        data-testid={`${testid}-instance`}
      >
        <option value="">{t('mcpCard.newInstance')}</option>
        {#each instances as entry (entry.id)}
          <option value={entry.id}>{entry.title}</option>
        {/each}
      </select>
    {/if}

    {#if selected !== null}
      <div class="grid gap-2 border-t pt-2">
        <McpInstanceForm
          pluginId={selected.id}
          instance={editing}
          testidPrefix={testid}
          onSaved={() => instanceSaved()}
        />
      </div>
    {/if}

    {#if authorizable.length > 0 && bot !== null}
      <div class="grid gap-1.5 border-t pt-2">
        <Label>{t('mcpCard.forBot')}</Label>
        {#each authorizable as entry (entry.id)}
          <div class="grid gap-1">
            <div class="flex items-center gap-2 text-sm">
              <Checkbox
                checked={authorizedIds.includes(entry.serverId)}
                onCheckedChange={(checked) => void toggleAuthorize(entry.serverId, checked === true)}
                data-testid={`${testid}-authorize-${entry.serverId}`}
              />
              <span class="min-w-0 flex-1 truncate">{entry.title}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={testState[entry.serverId]?.busy === true}
                onclick={() => void testInstance(entry.serverId)}
                data-testid={`${testid}-test-${entry.serverId}`}
              >
                {t('mcpCard.test')}
              </Button>
            </div>
            {#if testState[entry.serverId] !== undefined && !testState[entry.serverId]!.busy}
              <p
                class:text-destructive={!testState[entry.serverId]!.ok}
                class="text-xs text-muted-foreground"
                data-testid={`${testid}-test-result-${entry.serverId}`}
              >
                {testState[entry.serverId]!.text}
              </p>
            {/if}
          </div>
        {/each}
        <p class="text-xs text-muted-foreground">{t('mcpCard.forBotHint')}</p>
      </div>
    {/if}

    {#if authorizable.length > 0}
      <div class="flex justify-end">
        <Button
          type="button"
          size="sm"
          onclick={() => onSaved?.({ plugin: pluginId, ...(instanceId.length > 0 ? { instance: instanceId } : {}) })}
          data-testid={`${testid}-done`}
        >
          {t('mcpCard.done')}
        </Button>
      </div>
    {/if}
  {/if}
</div>
