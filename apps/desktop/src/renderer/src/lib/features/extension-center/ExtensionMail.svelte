<script lang="ts">
  import { onMount } from 'svelte';
  import { Mail } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import {
    AppError,
    MAIL_PROVIDER_PRESETS,
    type Bot,
    type MailAccount,
    type MailProvider,
  } from '@kepcup/shared';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';

  /**
   * 扩展中心「邮件」（D84）。账号、授权码、收信模式和 Bot 绑定都在这一页。
   * 授权码只在填写时出现，列表和详情不再回显。
   */

  const PROVIDERS = Object.values(MAIL_PROVIDER_PRESETS);

  let accounts = $state<MailAccount[]>([]);
  let bots = $state<Bot[]>([]);
  let view = $state<'list' | 'add' | 'detail'>('list');
  let selectedId = $state<string | null>(null);
  let busy = $state(false);
  let formError = $state('');

  let provider = $state<MailProvider>('qq');
  let address = $state('');
  let password = $state('');
  let label = $state('');
  let imapHost = $state('');
  let smtpHost = $state('');
  let imapPort = $state('993');
  let smtpPort = $state('465');
  let newPassword = $state('');
  let passwordBusy = $state(false);

  const selected = $derived(accounts.find((account) => account.id === selectedId) ?? null);
  const preset = $derived(MAIL_PROVIDER_PRESETS[provider]);

  function statusText(account: MailAccount): string {
    if (account.status === 'paused') return t('mail.status.paused');
    if (account.status === 'error') return t('mail.status.error');
    if (account.listen === 'idle') return t('mail.status.idle');
    if (account.listen === 'poll') return t('mail.status.poll');
    return t('mail.status.connecting');
  }

  async function reload(): Promise<void> {
    const [accountResult, botResult] = await Promise.all([
      core.call('mail.accounts.list') as Promise<{ accounts: MailAccount[] }>,
      core.call('bots.list') as Promise<{ bots: Bot[] }>,
    ]);
    accounts = accountResult.accounts;
    bots = botResult.bots.filter((bot) => bot.status === 'active');
  }

  onMount(() => {
    void reload().catch((error: unknown) => {
      formError = error instanceof AppError ? errorText(error.code, error.message) : String(error);
    });
    return core.onEvent('mail.account_updated', () => {
      void reload().catch(() => undefined);
    });
  });

  function resetForm(): void {
    provider = 'qq';
    address = '';
    password = '';
    label = '';
    imapHost = '';
    smtpHost = '';
    imapPort = '993';
    smtpPort = '465';
    formError = '';
  }

  function explain(error: unknown): string {
    if (error instanceof AppError) return errorText(error.code, error.message);
    return error instanceof Error ? error.message : String(error);
  }

  async function addAccount(): Promise<void> {
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
        ...(provider === 'custom'
          ? {
              imapHost: imapHost.trim(),
              imapPort: Number(imapPort) || 993,
              smtpHost: smtpHost.trim(),
              smtpPort: Number(smtpPort) || 465,
            }
          : {}),
      })) as { account: MailAccount };
      password = '';
      await reload();
      selectedId = created.account.id;
      view = 'detail';
      toast.success(t('mail.added'));
    } catch (error) {
      formError = explain(error);
    } finally {
      busy = false;
    }
  }

  /** 授权码失效（登录被拒后会话已停止重试）或换了新码：测连通过后保存并重新连接。 */
  async function updatePassword(account: MailAccount): Promise<void> {
    if (newPassword.length === 0) return;
    passwordBusy = true;
    try {
      await core.call('mail.accounts.update', { id: account.id, password: newPassword });
      newPassword = '';
      await reload();
      toast.success(t('mail.passwordUpdated'));
    } catch (error) {
      toast.error(explain(error));
    } finally {
      passwordBusy = false;
    }
  }

  async function toggleBot(account: MailAccount, botId: string, on: boolean): Promise<void> {
    const next = on
      ? [...new Set([...account.botIds, botId])]
      : account.botIds.filter((id) => id !== botId);
    try {
      await core.call('mail.accounts.setBots', { id: account.id, botIds: next });
      await reload();
    } catch (error) {
      toast.error(explain(error));
    }
  }

  async function setMode(account: MailAccount, mode: 'auto' | 'poll_only'): Promise<void> {
    try {
      await core.call('mail.accounts.update', { id: account.id, mode });
      await reload();
    } catch (error) {
      toast.error(explain(error));
    }
  }

  async function setInterval(account: MailAccount, minutes: number): Promise<void> {
    try {
      await core.call('mail.accounts.update', {
        id: account.id,
        pollIntervalSec: Math.round(minutes * 60),
      });
      await reload();
    } catch (error) {
      toast.error(explain(error));
    }
  }

  async function pauseOrResume(account: MailAccount): Promise<void> {
    try {
      if (account.status === 'paused') await core.call('mail.accounts.resume', { id: account.id });
      else await core.call('mail.accounts.pause', { id: account.id });
      await reload();
    } catch (error) {
      toast.error(explain(error));
    }
  }

  async function remove(account: MailAccount): Promise<void> {
    try {
      await core.call('mail.accounts.delete', { id: account.id });
      selectedId = null;
      view = 'list';
      await reload();
    } catch (error) {
      toast.error(explain(error));
    }
  }

  async function resumeAlerts(account: MailAccount, botId: string): Promise<void> {
    try {
      await core.call('mail.bindings.resume', { accountId: account.id, botId });
      await reload();
    } catch (error) {
      toast.error(explain(error));
    }
  }
</script>

<div class="min-h-0 flex-1 overflow-y-auto pt-3 pr-0.5" data-testid="extension-mail">
  {#if view === 'list'}
    <div class="mb-3 flex items-center justify-between gap-2">
      <p class="text-xs text-muted-foreground">{t('mail.intro')}</p>
      <Button
        size="sm"
        onclick={() => {
          resetForm();
          view = 'add';
        }}
        data-testid="mail-add"
      >
        {t('mail.add')}
      </Button>
    </div>
    {#if accounts.length === 0}
      <div
        class="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="mail-empty"
      >
        <Mail class="mx-auto mb-2 size-5" aria-hidden="true" />
        <p>{t('mail.empty')}</p>
      </div>
    {:else}
      <ul class="space-y-2">
        {#each accounts as account (account.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm hover:bg-accent/40"
              onclick={() => {
                selectedId = account.id;
                view = 'detail';
              }}
              data-testid={`mail-account-${account.id}`}
            >
              <span class="min-w-0">
                <span class="block truncate font-medium">{account.label}</span>
                <span class="block truncate text-xs text-muted-foreground">{account.address}</span>
              </span>
              <span class="shrink-0 text-xs text-muted-foreground">
                {statusText(account)} · {t('mail.botCount', { count: account.botIds.length })}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if view === 'add'}
    <form
      class="space-y-3"
      onsubmit={(event) => {
        event.preventDefault();
        void addAccount();
      }}
      data-testid="mail-add-form"
    >
      <Button type="button" variant="ghost" size="sm" onclick={() => (view = 'list')}>
        {t('mail.back')}
      </Button>
      <div class="grid gap-1.5">
        <Label>{t('mail.provider')}</Label>
        <select
          class="h-9 rounded-md border bg-background px-2 text-sm"
          bind:value={provider}
          data-testid="mail-provider"
        >
          {#each PROVIDERS as item (item.id)}
            <option value={item.id}>{t(`mail.provider.${item.id}`)}</option>
          {/each}
        </select>
        <p class="text-xs text-muted-foreground">{t(`mail.providerNote.${provider}`)}</p>
        {#if preset.helpUrl.length > 0}
          <a class="text-xs underline" href={preset.helpUrl} target="_blank" rel="noreferrer">
            {t('mail.help')}
          </a>
        {/if}
      </div>
      {#if !preset.available}
        <p class="text-sm text-amber-700 dark:text-amber-400" data-testid="mail-outlook-unavailable">
          {t('mail.outlookUnavailable')}
        </p>
      {:else}
        <div class="grid gap-1.5">
          <Label for="mail-address">{t('mail.address')}</Label>
          <Input id="mail-address" bind:value={address} autocomplete="off" data-testid="mail-address" />
        </div>
        <div class="grid gap-1.5">
          <Label for="mail-password">{t('mail.password')}</Label>
          <Input
            id="mail-password"
            type="password"
            bind:value={password}
            autocomplete="new-password"
            data-testid="mail-password"
          />
          <p class="text-xs text-muted-foreground">{t('mail.passwordHint')}</p>
        </div>
        <div class="grid gap-1.5">
          <Label for="mail-label">{t('mail.label')}</Label>
          <Input id="mail-label" bind:value={label} data-testid="mail-label" />
        </div>
        {#if provider === 'custom'}
          <p class="text-xs text-amber-700 dark:text-amber-400">{t('mail.customWarning')}</p>
          <div class="grid grid-cols-2 gap-2">
            <div class="grid gap-1.5">
              <Label for="mail-imap-host">IMAP</Label>
              <Input id="mail-imap-host" bind:value={imapHost} data-testid="mail-imap-host" />
            </div>
            <div class="grid gap-1.5">
              <Label for="mail-imap-port">{t('mail.port')}</Label>
              <Input id="mail-imap-port" bind:value={imapPort} />
            </div>
            <div class="grid gap-1.5">
              <Label for="mail-smtp-host">SMTP</Label>
              <Input id="mail-smtp-host" bind:value={smtpHost} data-testid="mail-smtp-host" />
            </div>
            <div class="grid gap-1.5">
              <Label for="mail-smtp-port">{t('mail.port')}</Label>
              <Input id="mail-smtp-port" bind:value={smtpPort} />
            </div>
          </div>
        {/if}
        {#if formError}
          <p class="text-sm text-destructive" data-testid="mail-form-error">{formError}</p>
        {/if}
        <Button type="submit" disabled={busy || address.trim().length === 0 || password.length === 0}>
          {busy ? t('mail.testing') : t('mail.save')}
        </Button>
      {/if}
    </form>
  {:else if selected}
    <div class="space-y-4" data-testid="mail-detail">
      <Button type="button" variant="ghost" size="sm" onclick={() => (view = 'list')}>
        {t('mail.back')}
      </Button>
      <div>
        <h2 class="text-sm font-medium">{selected.label}</h2>
        <p class="text-xs text-muted-foreground">{selected.address}</p>
        <p class="mt-1 text-xs" data-testid="mail-detail-status">{statusText(selected)}</p>
        {#if selected.lastError}
          <p class="mt-1 text-xs text-destructive">{selected.lastError}</p>
        {/if}
      </div>
      <div class="grid gap-1.5 text-sm">
        <Label>{t('mail.mode')}</Label>
        <select
          class="h-9 rounded-md border bg-background px-2 text-sm"
          value={selected.mode}
          onchange={(event) => {
            const value = event.currentTarget.value;
            if (value === 'auto' || value === 'poll_only') void setMode(selected, value);
          }}
          data-testid="mail-mode"
        >
          <option value="auto">{t('mail.mode.auto')}</option>
          <option value="poll_only">{t('mail.mode.poll')}</option>
        </select>
        <Label for="mail-interval">{t('mail.interval')}</Label>
        <Input
          id="mail-interval"
          type="number"
          min="1"
          value={Math.max(1, Math.round(selected.pollIntervalSec / 60))}
          onchange={(event) => {
            const minutes = Number(event.currentTarget.value);
            if (Number.isFinite(minutes)) void setInterval(selected, minutes);
          }}
          data-testid="mail-interval"
        />
        {#if selected.provider === 'netease_163' || selected.provider === 'netease_126'}
          <p class="text-xs text-amber-700 dark:text-amber-400">{t('mail.pollWarning')}</p>
        {/if}
      </div>
      <form
        class="grid gap-1.5 text-sm"
        onsubmit={(event) => {
          event.preventDefault();
          void updatePassword(selected);
        }}
      >
        <Label for="mail-new-password">{t('mail.updatePassword')}</Label>
        <div class="flex gap-2">
          <Input
            id="mail-new-password"
            type="password"
            autocomplete="off"
            bind:value={newPassword}
            data-testid="mail-new-password"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={passwordBusy || newPassword.length === 0}
            data-testid="mail-update-password"
          >
            {passwordBusy ? t('mail.testing') : t('mail.updatePasswordSave')}
          </Button>
        </div>
      </form>
      <div class="space-y-1" data-testid="mail-bots">
        <Label>{t('mail.bots')}</Label>
        {#each bots as bot (bot.id)}
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.botIds.includes(bot.id)}
              onchange={(event) => void toggleBot(selected, bot.id, event.currentTarget.checked)}
              data-testid={`mail-bot-${bot.id}`}
            />
            <span>{bot.name}</span>
            {#if selected.alertPausedBotIds.includes(bot.id)}
              <button
                type="button"
                class="text-xs underline"
                onclick={() => void resumeAlerts(selected, bot.id)}
              >
                {t('mail.resumeAlerts')}
              </button>
            {/if}
          </label>
        {/each}
      </div>
      <div class="flex gap-2">
        <Button variant="secondary" onclick={() => void pauseOrResume(selected)} data-testid="mail-pause">
          {selected.status === 'paused' ? t('mail.resume') : t('mail.pause')}
        </Button>
        <Button variant="outline" onclick={() => void remove(selected)} data-testid="mail-delete">
          {t('mail.delete')}
        </Button>
      </div>
    </div>
  {/if}
</div>
