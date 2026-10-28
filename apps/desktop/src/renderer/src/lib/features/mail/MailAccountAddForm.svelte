<script lang="ts">
  import { AppError, type MailAccount, type PluginSummary } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import { Button } from '$lib/components/ui/button';
  import PluginFieldForm from '$lib/features/plugins/PluginFieldForm.svelte';

  /**
   * 邮件实例表单（P3）：宿主按插件声明的实例字段自动构建——厂商插件只有
   * 地址 / 授权码（/ 用户名）与厂商附加字段，通用插件多出 IMAP/SMTP 端点；
   * 连接测试在 `plugins.instances.create` 内完成。一个插件可添加多个账号。
   * 扩展中心「已安装 → 邮件插件 → 管理」与对话内 mail setup 卡共用。
   */

  let {
    pluginId,
    bindBotId = undefined,
    testidPrefix = 'mail',
    onSaved,
  }: {
    /** 提供邮件实例能力的插件 id（已安装且启用）。 */
    pluginId: string;
    /** 创建成功后绑定的 Bot（对话内设置卡传入当前 Bot）。 */
    bindBotId?: string | undefined;
    testidPrefix?: string;
    onSaved?: (account: MailAccount) => void;
  } = $props();

  const plugin = $derived(
    plugins.plugins.find((candidate) => candidate.id === pluginId) ?? null,
  );
  /** 实例表单字段（core 按清单解析的安全投影；厂商插件的端点不出现）。 */
  const fields = $derived(plugin?.instanceFields ?? []);

  let values = $state<Record<string, unknown>>({});
  let busy = $state(false);
  let formError = $state('');

  function explain(error: unknown): string {
    if (error instanceof AppError) return errorText(error.code, error.message);
    return error instanceof Error ? error.message : String(error);
  }

  /** 必填项就绪：非敏感必填有值，敏感必填有值或已有存值。 */
  function ready(): boolean {
    return fields.every((field) => {
      if (!field.required) return true;
      const raw = values[field.key];
      if (typeof raw === 'string' && raw.trim().length > 0) return true;
      if (typeof raw === 'number') return true;
      if (typeof raw === 'boolean') return true;
      return false;
    });
  }

  async function submit(): Promise<void> {
    formError = '';
    if (plugin === null) return;
    busy = true;
    try {
      const result = (await core.call('plugins.instances.create', {
        pluginId: plugin.id,
        values,
      })) as { instance: { id: string; title: string } };
      values = {};
      // 对话内设置卡：创建后直接绑定当前 Bot（实例路径不管绑定，写 mail_account_bots）。
      if (bindBotId !== undefined) {
        const accounts = (await core.call('mail.accounts.list', undefined)) as {
          accounts: MailAccount[];
        };
        const account = accounts.accounts.find(
          (row) => row.instanceId === result.instance.id,
        );
        if (account !== undefined) {
          await core.call('mail.accounts.setBots', { id: account.id, botIds: [bindBotId] });
        }
      }
      toast.success(t('mail.added'));
      // 实例标题即账号地址；账号列表随后由 mail.account_updated 事件刷新，
      // 这里用标题给调用方一个可显示的标识。
      onSaved?.({ address: result.instance.title } as MailAccount);
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
  data-testid={`${testidPrefix}-add-form`}
>
  <p class="text-xs text-muted-foreground">
    {t('mail.instanceFormNote', { plugin: plugin?.name ?? pluginId })}
  </p>
  {#if fields.length === 0}
    <p class="text-xs text-muted-foreground" data-testid={`${testidPrefix}-fields-loading`}>
      {t('apps.catalog.loading')}
    </p>
  {:else}
    <PluginFieldForm
      {fields}
      bind:values
      idScope={`${testidPrefix}-instance`}
      testid={`${testidPrefix}-instance-fields`}
    />
  {/if}
  {#if formError}
    <p class="text-sm text-destructive" data-testid={`${testidPrefix}-form-error`}>{formError}</p>
  {/if}
  <Button
    type="submit"
    disabled={busy || fields.length === 0 || !ready()}
    data-testid={`${testidPrefix}-save`}
  >
    {busy ? t('mail.testing') : t('mail.save')}
  </Button>
</form>
