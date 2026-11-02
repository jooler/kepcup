<script lang="ts">
  import { untrack } from 'svelte';
  import type { MailAccount, SettingValues } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { prefillBoolean, prefillString } from './setting-card-model';

  /**
   * 已配置邮箱的设置卡（mail.mailbox）：选一个已经建好的邮箱 → 决定它交给哪些 Bot、
   * 是否暂停收信。保存走 `mail.accounts.setBots` / `pause` / `resume`（扩展中心同一条管理
   * 路径），完成后由 `completeCard` 核对；删除与改授权码仍在扩展中心的账号详情里。
   */

  let {
    botId,
    prefill = null,
    testid = 'setting-card-mail-mailbox',
    onSaved,
  }: {
    botId: string;
    prefill?: SettingValues | null;
    testid?: string;
    onSaved?: (values?: SettingValues) => void;
  } = $props();

  let accounts = $state<MailAccount[]>([]);
  let loading = $state(true);
  let accountId = $state(untrack(() => prefillString(prefill, 'account') ?? ''));
  /** null = 跟随选中邮箱的当前绑定；数组 = 用户刚改过。 */
  let botsDraft = $state<string[] | null>(
    untrack(() => {
      const value = prefill?.bots;
      return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : null;
    }),
  );
  /** null = 跟随选中邮箱的当前状态；布尔值 = 用户刚改过。 */
  let pausedDraft = $state<boolean | null>(
    untrack(() => prefillBoolean(prefill, 'paused') ?? null),
  );
  let busy = $state(false);

  const selected = $derived(accounts.find((account) => account.id === accountId) ?? null);
  const bots = $derived(botsDraft ?? selected?.botIds ?? []);
  const paused = $derived(pausedDraft ?? selected?.status === 'paused');
  const activeBots = $derived(contacts.bots.filter((bot) => bot.status === 'active'));

  function explain(error: unknown): string {
    return error instanceof Error ? errorText(undefined, error.message) : String(error);
  }

  function statusText(account: MailAccount): string {
    if (account.status === 'paused') return t('mail.status.paused');
    if (account.status === 'error') return t('mail.status.error');
    if (account.listen === 'idle') return t('mail.status.idle');
    if (account.listen === 'poll') return t('mail.status.poll');
    return t('mail.status.connecting');
  }

  async function reload(): Promise<void> {
    const result = (await core.call('mail.accounts.list', undefined)) as {
      accounts: MailAccount[];
    };
    accounts = result.accounts;
    loading = false;
  }

  $effect(() => {
    contacts.start();
    if (contacts.bots.length === 0) void contacts.refresh().catch(() => undefined);
  });

  $effect(() => {
    void reload().catch((error: unknown) => {
      loading = false;
      toast.error(explain(error));
    });
    return core.onEvent('mail.account_updated', () => {
      void reload().catch(() => undefined);
    });
  });

  // 账号列表到位后选一个缺省邮箱：优先已经交给这个 Bot 的，其次第一个；预填的 id
  // 已不存在（账号被删）时同样回退。
  $effect(() => {
    if (accounts.length === 0) return;
    if (accountId.length > 0 && accounts.some((account) => account.id === accountId)) return;
    const preferred = accounts.find((account) => account.botIds.includes(botId)) ?? accounts[0]!;
    accountId = preferred.id;
  });

  function pickAccount(id: string): void {
    accountId = id;
    botsDraft = null;
    pausedDraft = null;
  }

  function toggleBot(id: string, on: boolean): void {
    const base = bots;
    botsDraft = on ? [...new Set([...base, id])] : base.filter((entry) => entry !== id);
  }

  async function save(): Promise<void> {
    const account = selected;
    if (account === null || busy) return;
    busy = true;
    try {
      const nextBots = [...new Set(bots)];
      const sameBots =
        nextBots.length === account.botIds.length &&
        nextBots.every((id) => account.botIds.includes(id));
      if (!sameBots) {
        await core.call('mail.accounts.setBots', { id: account.id, botIds: nextBots });
      }
      const wasPaused = account.status === 'paused';
      if (paused !== wasPaused) {
        await core.call(paused ? 'mail.accounts.pause' : 'mail.accounts.resume', {
          id: account.id,
        });
      }
      toast.success(t('mailCard.mailbox.saved'));
      onSaved?.({ account: account.id, bots: nextBots, paused });
    } catch (error) {
      toast.error(explain(error));
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid gap-2" data-testid={testid}>
  {#if loading}
    <p class="text-xs text-muted-foreground">{t('mail.testing')}</p>
  {:else if accounts.length === 0}
    <p class="text-xs text-muted-foreground" data-testid={`${testid}-empty`}>
      {t('mailCard.mailbox.empty')}
    </p>
    <div class="flex justify-end">
      <Button
        size="sm"
        variant="outline"
        onclick={() => shell.openExtensionCenter('installed', 'plugins-filter-mail')}
        data-testid={`${testid}-open`}
      >
        {t('mail.openExtension')}
      </Button>
    </div>
  {:else}
    <Label for={`${testid}-account`}>{t('mailCard.mailbox.pick')}</Label>
    <select
      id={`${testid}-account`}
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      value={accountId}
      onchange={(event) => pickAccount(event.currentTarget.value)}
      data-testid={`${testid}-account`}
    >
      {#each accounts as account (account.id)}
        <option value={account.id}>{account.label} ({account.address})</option>
      {/each}
    </select>

    {#if selected !== null}
      <p class="text-xs text-muted-foreground" data-testid={`${testid}-status`}>
        {statusText(selected)}
        {#if selected.pluginName !== null}
          · {t('mail.ownerOf', { plugin: selected.pluginName })}
        {/if}
      </p>

      <div class="space-y-1 border-t pt-2">
        <Label>{t('mail.bots')}</Label>
        {#each activeBots as bot (bot.id)}
          <label class="flex items-center gap-2 text-sm">
            <Checkbox
              checked={bots.includes(bot.id)}
              onCheckedChange={(checked) => toggleBot(bot.id, checked === true)}
              data-testid={`${testid}-bot-${bot.id}`}
            />
            <span>{bot.name}</span>
          </label>
        {/each}
      </div>

      <label class="flex items-center gap-2 text-sm">
        <Checkbox
          checked={paused}
          onCheckedChange={(checked) => (pausedDraft = checked === true)}
          data-testid={`${testid}-paused`}
        />
        {t('mail.pause')}
      </label>

      <div class="flex justify-end">
        <Button
          size="sm"
          disabled={busy}
          onclick={() => void save()}
          data-testid={`${testid}-save`}
        >
          {t('mailCard.save')}
        </Button>
      </div>
    {/if}
  {/if}
</div>
