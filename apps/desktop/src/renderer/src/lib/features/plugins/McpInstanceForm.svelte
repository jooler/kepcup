<script lang="ts">
  import { AppError, type PluginInstanceSummary } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import { Button } from '$lib/components/ui/button';
  import PluginFieldForm from '$lib/features/plugins/PluginFieldForm.svelte';

  /**
   * MCP 实例表单（P4-M2）：宿主按插件声明的实例字段自动构建——厂商模版插件只有
   * 备注名 / 凭据字段（端点锁定），通用模版多出 MCP 服务地址；创建即落地
   * `settings.mcpServers`（headers 值进 secrets）。编辑用同一张表单：非敏感值
   * 预填、敏感字段只给「已设置」占位（缺省 = 保留存值，core 的 merge 语义）。
   * 扩展中心「已安装 → 工具插件 → 管理」与对话内设置卡共用。
   */

  let {
    pluginId,
    instance = null,
    testidPrefix = 'mcp',
    onSaved,
  }: {
    /** 提供 mcp 实例能力的插件 id（已安装且启用）。 */
    pluginId: string;
    /** 编辑目标；null = 新建。 */
    instance?: PluginInstanceSummary | null;
    testidPrefix?: string;
    /** 保存成功回调。 */
    onSaved?: () => void;
  } = $props();

  const plugin = $derived(
    plugins.plugins.find((candidate) => candidate.id === pluginId) ?? null,
  );
  /** 实例表单字段（core 按清单解析的安全投影；厂商锁定端点不出现）。 */
  const fields = $derived(plugin?.instanceFields ?? []);
  /** 编辑时有存值 secret 的敏感字段键（占位「已设置」；core 永不回传敏感明文）。 */
  const storedKeys = $derived(instance?.storedSensitiveKeys ?? []);

  let values = $state<Record<string, unknown>>({});
  let busy = $state(false);
  let formError = $state('');

  // 编辑：非敏感存值预填一次（instance 变化重置；敏感值永不回显，输入框留空 = 保留）。
  $effect(() => {
    if (instance === null) {
      values = {};
      return;
    }
    values = { ...instance.values };
  });

  function explain(error: unknown): string {
    if (error instanceof AppError) return errorText(error.code, error.message);
    return error instanceof Error ? error.message : String(error);
  }

  /** 必填项就绪：非敏感必填有值；敏感必填有值或已有存值（编辑保留）。 */
  function ready(): boolean {
    return fields.every((field) => {
      if (!field.required) return true;
      const raw = values[field.key];
      if (typeof raw === 'string' && raw.trim().length > 0) return true;
      if (typeof raw === 'number') return true;
      if (typeof raw === 'boolean') return true;
      if (field.sensitive && storedKeys.includes(field.key)) return true;
      return false;
    });
  }

  async function submit(): Promise<void> {
    formError = '';
    if (plugin === null) return;
    busy = true;
    try {
      if (instance !== null) {
        await core.call('plugins.instances.update', { id: instance.id, values });
        toast.success(t('mcp.updated'));
      } else {
        await core.call('plugins.instances.create', {
          pluginId: plugin.id,
          values,
        });
        toast.success(t('mcp.added'));
      }
      onSaved?.();
    } catch (error) {
      formError = explain(error);
    } finally {
      busy = false;
    }
  }
</script>

<form
  class="space-y-3"
  onsubmit={(event) => {
    event.preventDefault();
    void submit();
  }}
  data-testid={instance !== null ? `${testidPrefix}-edit-form` : `${testidPrefix}-add-form`}
>
  <p class="text-xs text-muted-foreground">
    {t('mcp.instanceFormNote', { plugin: plugin?.name ?? pluginId })}
  </p>
  {#if plugin !== null && !plugin.enabled}
    <p class="text-xs text-muted-foreground" data-testid={`${testidPrefix}-plugin-disabled`}>
      {t('mcp.pluginDisabled', { plugin: plugin.name })}
    </p>
  {/if}
  {#if plugin === null}
    <p class="text-sm text-muted-foreground" data-testid={`${testidPrefix}-plugin-missing`}>
      {t('mcp.pluginMissing')}
    </p>
  {:else if fields.length === 0}
    <p class="text-xs text-muted-foreground" data-testid={`${testidPrefix}-fields-loading`}>
      {t('apps.catalog.loading')}
    </p>
  {:else}
    <PluginFieldForm
      {fields}
      bind:values
      idScope={`${testidPrefix}-instance`}
      testid={`${testidPrefix}-instance-fields`}
      storedSensitiveKeys={storedKeys}
    />
  {/if}
  {#if formError}
    <p class="text-sm text-destructive" data-testid={`${testidPrefix}-form-error`}>{formError}</p>
  {/if}
  <Button
    type="submit"
    disabled={busy || plugin === null || !plugin.enabled || fields.length === 0 || !ready()}
    data-testid={`${testidPrefix}-save`}
  >
    {busy ? t('mcp.saving') : t('mcp.save')}
  </Button>
</form>
