<script lang="ts">
  import {
    AppError,
    MAIL_PROVIDER_PRESETS,
    type MailAccount,
    type MailMode,
    type MailProvider,
    type MailSecure,
    type MailProviderTemplate,
  } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { applyTemplate, parseTemplateOption, templateOptionValue } from './mail-template';

  /**
   * 添加邮箱表单（D84）：扩展中心「邮件」与对话内 mail-account 设置卡共用。
   * 测连在 `mail.accounts.create` 内完成；`bindBotId` 有值时创建后直接绑定该 Bot。
   */
  let {
    initialProvider = 'qq',
    bindBotId = undefined,
    testidPrefix = 'mail',
    onSaved,
  }: {
    initialProvider?: MailProvider;
    /** 创建成功后绑定的 Bot（对话内设置卡传入当前 Bot）。 */
    bindBotId?: string | undefined;
    testidPrefix?: string;
    onSaved?: (account: MailAccount) => void;
  } = $props();

  const PROVIDERS = Object.values(MAIL_PROVIDER_PRESETS);

  // initialProvider 变化时同步厂商（可写 derived：用户手选后保持到下次 prop 变化）。
  let provider = $derived<MailProvider>(initialProvider);
  let address = $state('');
  let password = $state('');
  let label = $state('');
  let imapHost = $state('');
  let smtpHost = $state('');
  let imapPort = $state('993');
  let smtpPort = $state('465');
  let busy = $state(false);
  let formError = $state('');
  /** 选中的插件模板 id（`pluginId#localId`）；非模板选择时为 null。 */
  let templateId = $state<string | null>(null);
  let templates = $state<MailProviderTemplate[]>([]);
  // 模板带出的连接参数（只有选中模板时才随创建请求发送；普通自定义邮箱保持原样）。
  let imapSecure = $state<MailSecure>('ssl');
  let smtpSecure = $state<MailSecure>('ssl');
  let mode = $state<MailMode>('auto');
  let pollIntervalSec = $state('300');

  const preset = $derived(MAIL_PROVIDER_PRESETS[provider]);
  const template = $derived(
    templateId === null ? null : (templates.find((item) => item.id === templateId) ?? null),
  );
  /** `<select>` 的当前值：模板选择用 `tpl:` 前缀，其余是内置厂商 id。 */
  const providerOption = $derived(templateId === null ? provider : templateOptionValue(templateId));

  $effect(() => {
    void (async () => {
      try {
        const result = (await core.call('mail.providerTemplates.list', undefined)) as {
          templates: MailProviderTemplate[];
        };
        templates = result.templates;
      } catch {
        // 模板只是预填便利：读不到就当没有（不影响手动添加）。
        templates = [];
      }
    })();
  });

  function onProviderChange(value: string): void {
    const picked = parseTemplateOption(value);
    if (picked === null) {
      templateId = null;
      provider = value as MailProvider;
      return;
    }
    const found = templates.find((item) => item.id === picked);
    if (found === undefined) return;
    const form = applyTemplate(found);
    templateId = found.id;
    provider = 'custom';
    imapHost = form.imapHost;
    imapPort = form.imapPort;
    smtpHost = form.smtpHost;
    smtpPort = form.smtpPort;
    imapSecure = form.imapSecure;
    smtpSecure = form.smtpSecure;
    mode = form.mode;
    pollIntervalSec = form.pollIntervalSec;
  }

  function explain(error: unknown): string {
    if (error instanceof AppError) return errorText(error.code, error.message);
    return error instanceof Error ? error.message : String(error);
  }

  async function submit(): Promise<void> {
    formError = '';
    if (!preset.available) {
      formError = t('mail.outlookUnavailable');
      return;
    }
    busy = true;
    try {
      const created = (await core.call('mail.accounts.create', {
        provider,
        address: address.trim(),
        password,
        ...(label.trim().length > 0 ? { label: label.trim() } : {}),
        ...(bindBotId !== undefined ? { botIds: [bindBotId] } : {}),
        ...(provider === 'custom'
          ? {
              imapHost: imapHost.trim(),
              imapPort: Number(imapPort) || 993,
              smtpHost: smtpHost.trim(),
              smtpPort: Number(smtpPort) || 465,
              // 模板选中时才带出这些参数；普通自定义邮箱的请求体保持原样。
              ...(templateId !== null
                ? {
                    imapSecure,
                    smtpSecure,
                    mode,
                    pollIntervalSec: Number(pollIntervalSec) || 300,
                  }
                : {}),
            }
          : {}),
      })) as { account: MailAccount };
      password = '';
      toast.success(t('mail.added'));
      onSaved?.(created.account);
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
  <div class="grid gap-1.5">
    <Label>{t('mail.provider')}</Label>
    <select
      class="h-9 rounded-md border bg-background px-2 text-sm"
      value={providerOption}
      onchange={(event) => onProviderChange(event.currentTarget.value)}
      data-testid={`${testidPrefix}-provider`}
    >
      {#each PROVIDERS as item (item.id)}
        <option value={item.id}>{t(`mail.provider.${item.id}`)}</option>
      {/each}
      {#if templates.length > 0}
        <optgroup label={t('mail.template.group')}>
          {#each templates as item (item.id)}
            <option value={templateOptionValue(item.id)}>
              {t('mail.template.option', { label: item.label, plugin: item.pluginName })}
            </option>
          {/each}
        </optgroup>
      {/if}
    </select>
    {#if template !== null}
      <p class="text-xs text-muted-foreground">
        {t('mail.template.note', { plugin: template.pluginName })}
      </p>
      {#if template.helpUrl !== null}
        <a class="text-xs underline" href={template.helpUrl} target="_blank" rel="noreferrer">
          {t('mail.help')}
        </a>
      {/if}
    {:else}
      <p class="text-xs text-muted-foreground">{t(`mail.providerNote.${provider}`)}</p>
      {#if preset.helpUrl.length > 0}
        <a class="text-xs underline" href={preset.helpUrl} target="_blank" rel="noreferrer">
          {t('mail.help')}
        </a>
      {/if}
    {/if}
  </div>
  {#if !preset.available}
    <p
      class="text-sm text-amber-700 dark:text-amber-400"
      data-testid={`${testidPrefix}-outlook-unavailable`}
    >
      {t('mail.outlookUnavailable')}
    </p>
  {:else}
    <div class="grid gap-1.5">
      <Label for={`${testidPrefix}-address`}>{t('mail.address')}</Label>
      <Input
        id={`${testidPrefix}-address`}
        bind:value={address}
        autocomplete="off"
        data-testid={`${testidPrefix}-address`}
      />
    </div>
    <div class="grid gap-1.5">
      <Label for={`${testidPrefix}-password`}>{t('mail.password')}</Label>
      <Input
        id={`${testidPrefix}-password`}
        type="password"
        bind:value={password}
        autocomplete="new-password"
        data-testid={`${testidPrefix}-password`}
      />
      <p class="text-xs text-muted-foreground">{t('mail.passwordHint')}</p>
    </div>
    <div class="grid gap-1.5">
      <Label for={`${testidPrefix}-label`}>{t('mail.label')}</Label>
      <Input
        id={`${testidPrefix}-label`}
        bind:value={label}
        data-testid={`${testidPrefix}-label`}
      />
    </div>
    {#if provider === 'custom'}
      <p class="text-xs text-amber-700 dark:text-amber-400">{t('mail.customWarning')}</p>
      <div class="grid grid-cols-2 gap-2">
        <div class="grid gap-1.5">
          <Label for={`${testidPrefix}-imap-host`}>IMAP</Label>
          <Input
            id={`${testidPrefix}-imap-host`}
            bind:value={imapHost}
            data-testid={`${testidPrefix}-imap-host`}
          />
        </div>
        <div class="grid gap-1.5">
          <Label for={`${testidPrefix}-imap-port`}>{t('mail.port')}</Label>
          <Input id={`${testidPrefix}-imap-port`} bind:value={imapPort} />
        </div>
        <div class="grid gap-1.5">
          <Label for={`${testidPrefix}-smtp-host`}>SMTP</Label>
          <Input
            id={`${testidPrefix}-smtp-host`}
            bind:value={smtpHost}
            data-testid={`${testidPrefix}-smtp-host`}
          />
        </div>
        <div class="grid gap-1.5">
          <Label for={`${testidPrefix}-smtp-port`}>{t('mail.port')}</Label>
          <Input id={`${testidPrefix}-smtp-port`} bind:value={smtpPort} />
        </div>
      </div>
    {/if}
    {#if formError}
      <p class="text-sm text-destructive" data-testid={`${testidPrefix}-form-error`}>{formError}</p>
    {/if}
    <Button
      type="submit"
      disabled={busy || address.trim().length === 0 || password.length === 0}
      data-testid={`${testidPrefix}-save`}
    >
      {busy ? t('mail.testing') : t('mail.save')}
    </Button>
  {/if}
</form>
