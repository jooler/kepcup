<script lang="ts">
  import { AppError, type PluginInstanceSummary } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import { capabilityEntries } from '$lib/features/plugins/capability-entries.svelte';
  import { Button } from '$lib/components/ui/button';
  import PluginFieldForm from '$lib/features/plugins/PluginFieldForm.svelte';

  /**
   * 能力模型插件的账号实例表单（D124，60 号文档 §5「与 mail / im 实例管理同形」）：
   * 字段 = 该插件条目引用引擎的 credentialFields 并集（core 经 PluginSummary.
   * instanceFields 安全投影）；创建即落地 `plugin_instances`（sensitive → secrets）。
   * 编辑用同一张表单：非敏感值预填、敏感字段只给「已设置」占位（缺省 = 保留存值，
   * core 的 merge 语义）。插件详情「账号实例」区与对话内凭据卡共用。
   */

  let {
    pluginId,
    instance = null,
    testidPrefix = 'capability-instance',
    onSaved,
  }: {
    /** 能力模型插件 id（已安装且启用）。 */
    pluginId: string;
    /** 编辑目标；null = 新建。 */
    instance?: PluginInstanceSummary | null;
    testidPrefix?: string;
    /** 保存成功回调。 */
    onSaved?: () => void;
  } = $props();

  const plugin = $derived(plugins.plugins.find((candidate) => candidate.id === pluginId) ?? null);
  /** 实例表单字段（引擎 credentialFields 并集的安全投影）。 */
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
          // 插件只声明一种实例 kind（capability-model）；显式传避免歧义。
          kind: 'capability-model',
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

  /** 未保存先测（可选）：用当前填写的 key 发一次条目级最小真实请求。 */
  let testing = $state(false);
  let testResult = $state<'ok' | 'fail' | null>(null);
  let testError = $state('');

  async function test(): Promise<void> {
    if (plugin === null) return;
    testing = true;
    testResult = null;
    testError = '';
    try {
      // 未选条目时取该插件首个条目作探针（实例凭据探测与条目无关，引擎能力一致）。
      const entries = capabilityEntries.entriesOf(plugin.id);
      const entry = entries[0];
      if (entry === undefined) {
        testResult = 'fail';
        testError = t('plugins.capabilityModels.noEntries');
        return;
      }
      // 未保存先测覆盖敏感字段当前填写值：键从实例字段声明取（首批三引擎都是
      // `apiKey`，不从声明取键的话后续引擎换键名会静默退回「用已存凭据测」）。
      const sensitiveKey = fields.find((field) => field.sensitive)?.key;
      const override = sensitiveKey !== undefined ? values[sensitiveKey] : undefined;
      const keyOverride = typeof override === 'string' && override.length > 0 ? override : undefined;
      await core.call('plugins.testCapabilityEntry', {
        pluginId: plugin.id,
        entryId: entry.entryId,
        ...(instance !== null ? { instanceId: instance.id } : {}),
        ...(keyOverride !== undefined && keyOverride.length > 0 ? { keyOverride } : {}),
      });
      testResult = 'ok';
    } catch (error) {
      testResult = 'fail';
      testError = explain(error);
    } finally {
      testing = false;
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
    {t('plugins.capabilityModels.instanceFormNote')}
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
  <div class="flex flex-wrap items-center gap-2">
    <Button
      type="submit"
      disabled={busy || plugin === null || !plugin.enabled || fields.length === 0 || !ready()}
      data-testid={`${testidPrefix}-save`}
    >
      {busy ? t('mcp.saving') : t('mcp.save')}
    </Button>
    {#if fields.length > 0 && plugin?.enabled}
      <Button
        type="button"
        variant="secondary"
        disabled={busy || testing}
        onclick={() => void test()}
        data-testid={`${testidPrefix}-test`}
      >
        {testing ? t('plugins.capabilityModels.testing') : t('plugins.capabilityModels.test')}
      </Button>
    {/if}
    {#if testResult === 'ok'}
      <span
        class="text-xs text-emerald-700 dark:text-emerald-400"
        data-testid={`${testidPrefix}-test-ok`}>
        {t('plugins.capabilityModels.testOk')}
      </span>
    {:else if testResult === 'fail'}
      <span class="text-xs text-destructive" data-testid={`${testidPrefix}-test-error`}>
        {t('plugins.capabilityModels.testFailed', { reason: testError })}
      </span>
    {/if}
  </div>
</form>
