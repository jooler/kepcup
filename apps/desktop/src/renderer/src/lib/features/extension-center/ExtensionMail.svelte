<script lang="ts">
  import { onMount } from 'svelte';
  import { Mail } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { AppError, type Bot, type MailAccount } from '@kepcup/shared';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import MailAccountAddForm from '$lib/features/mail/MailAccountAddForm.svelte';

  /**
   * 扩展中心「邮件」（D84；P3 语义）：已建账号的聚合视图——按归属插件分组，每行
   * 显示所属插件；遗留无主账号标「未关联插件」。添加入口在邮件插件卡（本视图的
   * 「添加」引导过去：`installed?filter=mail` 深链）；没有任何邮件插件时给市场深链。
   * 账号 / 授权码 / 收信模式 / Bot 绑定的管理动作保留。授权码只在填写时出现。
   */

  let accounts = $state<MailAccount[]>([]);
  let bots = $state<Bot[]>([]);
  let view = $state<'list' | 'add' | 'detail'>('list');
  /** 添加流程选中的邮件插件 id（本视图提供选择；深链场景由插件卡直接进入）。 */
  let addPluginId = $state<string | null>(null);
  let selectedId = $state<string | null>(null);

  let newPassword = $state('');
  let passwordBusy = $state(false);

  const selected = $derived(accounts.find((account) => account.id === selectedId) ?? null);

  /** 提供邮件实例能力的已启用插件（添加入口的候选）。 */
  const mailPlugins = $derived(
    plugins.plugins.filter((plugin) => plugin.enabled && plugin.providesInstances.includes('mail')),
  );

  /** 按归属插件分组的账号（无主账号归 `null` 组）。 */
  const groups = $derived.by(() => {
    // Plain Map: group accounts for one render pass, not reactive UI state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const map = new Map<string | null, MailAccount[]>();
    for (const account of accounts) {
      const key = account.instanceId === null ? null : (account.pluginId ?? null);
      const list = map.get(key) ?? [];
      list.push(account);
      map.set(key, list);
    }
    return [...map.entries()];
  });

  /** 无任何邮件插件且有账号时的分组名回退（归属插件已卸载的残留实例账号）。 */
  function groupName(pluginId: string | null): string {
    if (pluginId === null) return t('mail.group.legacy');
    return plugins.nameOf(pluginId);
  }

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
    void plugins.load().catch(() => undefined);
    void reload().catch((error: unknown) => {
      toast.error(error instanceof AppError ? errorText(error.code, error.message) : String(error));
    });
    return core.onEvent('mail.account_updated', () => {
      void reload().catch(() => undefined);
    });
  });

  function explain(error: unknown): string {
    if (error instanceof AppError) return errorText(error.code, error.message);
    return error instanceof Error ? error.message : String(error);
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

  /** 删除：实例账号走实例路径（级联），遗留账号走旧路径。 */
  async function remove(account: MailAccount): Promise<void> {
    try {
      if (account.instanceId !== null) {
        await core.call('plugins.instances.delete', { id: account.instanceId });
      } else {
        await core.call('mail.accounts.delete', { id: account.id });
      }
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
  /** embedded：嵌进「已安装」的邮件筛选视图（不再是独立页签），去掉自带的滚动容器。 */
  let { embedded = false }: { embedded?: boolean } = $props();
</script>

<div
  class={embedded ? 'pt-3' : 'min-h-0 flex-1 overflow-y-auto pt-3 pr-0.5'}
  data-testid="extension-mail"
>
  {#if view === 'list'}
    <div class="mb-3 flex items-center justify-between gap-2">
      <p class="text-xs text-muted-foreground">{t('mail.intro')}</p>
      <Button
        size="sm"
        onclick={() => {
          addPluginId = mailPlugins.length === 1 ? (mailPlugins[0]!.id ?? null) : null;
          view = 'add';
        }}
        disabled={mailPlugins.length === 0}
        data-testid="mail-add"
      >
        {t('mail.add')}
      </Button>
    </div>
    {#if mailPlugins.length === 0}
      <div
        class="mb-3 rounded-xl border border-dashed px-4 py-3 text-center text-sm text-muted-foreground"
        data-testid="mail-no-plugin"
      >
        <p>{t('mail.noPlugin')}</p>
        <Button
          size="sm"
          variant="outline"
          class="mt-2"
          onclick={() => shell.openExtensionCenter('market')}
          data-testid="mail-market-deeplink"
        >
          {t('mail.openMarket')}
        </Button>
      </div>
    {/if}
    {#if accounts.length === 0}
      <div
        class="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="mail-empty"
      >
        <Mail class="mx-auto mb-2 size-5" aria-hidden="true" />
        <p>{t('mail.empty')}</p>
      </div>
    {:else}
      <div class="space-y-4">
        {#each groups as [pluginKey, groupAccounts] (pluginKey ?? '__legacy__')}
          <section>
            <p class="mb-1.5 text-xs font-medium text-muted-foreground" data-testid={`mail-group-${pluginKey ?? 'legacy'}`}>
              {groupName(pluginKey)}
            </p>
            <ul class="space-y-2">
              {#each groupAccounts as account (account.id)}
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
                      <span class="block truncate text-xs text-muted-foreground"
                        >{account.address}</span
                      >
                    </span>
                    <span class="shrink-0 text-xs text-muted-foreground">
                      {statusText(account)} · {t('mail.botCount', { count: account.botIds.length })}
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
    <div class="space-y-3" data-testid="mail-add-view">
      <Button type="button" variant="ghost" size="sm" onclick={() => (view = 'list')}>
        {t('mail.back')}
      </Button>
      {#if mailPlugins.length === 0}
        <p class="text-sm text-muted-foreground">{t('mail.noPlugin')}</p>
      {:else if mailPlugins.length === 1 && addPluginId !== null}
        <MailAccountAddForm
          pluginId={addPluginId}
          testidPrefix="mail"
          onSaved={async () => {
            await reload();
            view = 'list';
          }}
        />
      {:else}
        <div class="space-y-2">
          <Label>{t('mail.pickPlugin')}</Label>
          {#each mailPlugins as plugin (plugin.id)}
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm hover:bg-accent/40"
              onclick={() => (addPluginId = plugin.id)}
              data-testid={`mail-pick-${plugin.id}`}
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
                {t('mail.instanceCount', { count: plugin.instanceCounts.mail })}
              </span>
            </button>
          {/each}
        </div>
        {#if addPluginId !== null}
          <MailAccountAddForm
            pluginId={addPluginId}
            testidPrefix="mail"
            onSaved={async () => {
              await reload();
              view = 'list';
            }}
          />
        {/if}
      {/if}
    </div>
  {:else if selected}
    <div class="space-y-4" data-testid="mail-detail">
      <Button type="button" variant="ghost" size="sm" onclick={() => (view = 'list')}>
        {t('mail.back')}
      </Button>
      <div>
        <h2 class="text-sm font-medium">{selected.label}</h2>
        <p class="text-xs text-muted-foreground">{selected.address}</p>
        <p class="mt-1 text-xs" data-testid="mail-detail-status">{statusText(selected)}</p>
        <p class="mt-1 text-xs text-muted-foreground" data-testid="mail-detail-owner">
          {selected.instanceId === null
            ? t('mail.group.legacy')
            : t('mail.ownerOf', {
                plugin:
                  selected.pluginName ??
                  (selected.pluginId !== null ? plugins.nameOf(selected.pluginId) : ''),
              })}
        </p>
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
        <Button
          variant="secondary"
          onclick={() => void pauseOrResume(selected)}
          data-testid="mail-pause"
        >
          {selected.status === 'paused' ? t('mail.resume') : t('mail.pause')}
        </Button>
        <Button variant="outline" onclick={() => void remove(selected)} data-testid="mail-delete">
          {t('mail.delete')}
        </Button>
      </div>
    </div>
  {/if}
</div>
