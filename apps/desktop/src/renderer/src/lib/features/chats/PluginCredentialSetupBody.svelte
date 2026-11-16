<script lang="ts">
  import type { PluginInstanceSummary } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { getChatSession } from '$lib/features/chats/chat-session-context';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import { capabilityEntries } from '$lib/features/plugins/capability-entries.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import CapabilityInstanceForm from '$lib/features/plugins/CapabilityInstanceForm.svelte';

  /**
   * 对话内插件凭据卡（D124，60 号文档决策 8）：媒体工具在条目路径缺凭据时，
   * setup 需求 payload `{kind:'capability-model', pluginId, instanceId?, entryId?}`
   * 带插件 / 条目 / 实例定位——本卡按定位渲染插件实例凭据表单（PluginField 表单
   * 复用，sensitive 密码框），保存 = 实例创建 / 更新（既有 RPC），完成后 onSaved
   * → 宿主 proceed（chat.continueAfterSetup → runs.retry 自动续跑）。
   * 插件清单未拉到先给载入态（分发处同口径，isPluginCredentialEntryPath）；清单
   * 拉到后插件缺失如实提示（mcp.pluginMissing），不落全局槽位卡。
   * 凭据永不出现在回执 / 消息 / 设置快照（D89 敏感字段规则沿用，表单组件保证）。
   */

  let {
    requirement,
    onProceed,
  }: {
    requirement: {
      kind: 'capability-model';
      capability: string;
      pluginId?: string | undefined;
      instanceId?: string | undefined;
      entryId?: string | undefined;
    };
    /** 保存成功的承接（缺省走会话的 continueAfterSetup，由 SettingSetupBody 注入）。 */
    onProceed?: () => void;
  } = $props();

  $effect(() => {
    plugins.start();
    void plugins.load().catch(() => undefined);
    capabilityEntries.start();
    void capabilityEntries.load().catch(() => undefined);
  });

  const pluginId = $derived(requirement.pluginId ?? null);
  const plugin = $derived(pluginId === null ? null : (plugins.plugins.find((candidate) => candidate.id === pluginId) ?? null));
  /** 条目显示名（回执文案用；找不到时回退条目 id / 能力名）。 */
  const entryName = $derived.by(() => {
    if (requirement.entryId !== undefined && pluginId !== null) {
      const entry = capabilityEntries.entriesOf(pluginId).find((row) => row.entryId === requirement.entryId);
      if (entry !== undefined) return entry.displayName ?? entry.model;
      return requirement.entryId;
    }
    return null;
  });

  // 指定了实例 → 编辑既有实例（非敏感值预填、敏感留空 = 保留）；没指定 → 新建。
  let instance = $state<PluginInstanceSummary | null>(null);
  let loadedFor = $state<string | null>(null);
  $effect(() => {
    const target = requirement.instanceId;
    const owner = pluginId;
    if (target === undefined || owner === null) {
      instance = null;
      loadedFor = owner;
      return;
    }
    void (async () => {
      try {
        const result = (await core.call('plugins.instances.list', { pluginId: owner })) as {
          instances: PluginInstanceSummary[];
        };
        const row = result.instances.find((candidate) => candidate.id === target) ?? null;
        if (owner === pluginId) {
          instance = row;
          loadedFor = owner;
        }
      } catch {
        if (owner === pluginId) {
          instance = null;
          loadedFor = owner;
        }
      }
    })();
  });
  /** 实例行尚未读回时不渲染表单（避免把「编辑」误渲染成「新建」）。 */
  const instanceReady = $derived(requirement.instanceId === undefined || loadedFor === pluginId);

  const session = getChatSession();

  let continued = false;
  function proceed(): void {
    if (continued) return;
    continued = true;
    toast.success(
      t('setupCard.pluginCredentialSaved', {
        plugin: plugin?.name ?? (pluginId ?? ''),
        entry: entryName ?? requirement.capability,
      }),
    );
    if (onProceed !== undefined) {
      onProceed();
      return;
    }
    // 宿主未注入承接时兜底走会话续跑（与 SettingSetupBody 同语义）。
    void session.continueAfterSetup();
  }

  $effect(() => {
    void requirement;
    continued = false;
  });
</script>

{#if pluginId === null}
  <!-- 无插件定位（分发处已挡，理论上不可达）：提示去扩展中心补配置。 -->
  <p class="text-xs text-muted-foreground" data-testid="setup-card-credential-no-plugin">
    {t('plugins.capabilityModels.empty')}
  </p>
{:else if !plugins.loaded && plugins.loadError === null}
  <!-- 清单尚未拉到（冷启动直出卡）：先给载入态再定表单，避免按「插件缺失」误报。 -->
  <p class="text-xs text-muted-foreground" data-testid="setup-card-credential-loading">
    {t('apps.catalog.loading')}
  </p>
{:else if plugin === null}
  <!-- 插件已卸载 / 清单读失败：出不了凭据表单（全局槽位卡也解不了实例凭据），如实提示。 -->
  <p class="text-xs text-muted-foreground" data-testid="setup-card-credential-no-plugin">
    {t('mcp.pluginMissing')}
  </p>
{:else if !instanceReady}
  <p class="text-xs text-muted-foreground" data-testid="setup-card-credential-loading">
    {t('apps.catalog.loading')}
  </p>
{:else}
  <div class="space-y-1 pr-6" data-testid="setup-card-credential">
    <p class="text-sm font-medium">
      {t('setupCard.pluginCredentialTitle', { plugin: plugin.name, entry: entryName ?? requirement.capability })}
    </p>
    <p class="text-xs break-words text-muted-foreground">
      {t('setupCard.pluginCredentialReason')}
    </p>
  </div>
  <CapabilityInstanceForm
    pluginId={plugin.id}
    {instance}
    testidPrefix="setup-card-credential"
    onSaved={proceed}
  />
{/if}
