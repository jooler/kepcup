<script lang="ts">
  import { onMount } from 'svelte';
  import type { MailAccount } from '@kepcup/shared';
  import { AppError } from '@kepcup/shared';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Label } from '$lib/components/ui/label';
  import { Button } from '$lib/components/ui/button';

  /**
   * Bot 档案里的邮箱勾选（D84）。和「连接应用」分开：这里写的是绑定表，不是 MCP。
   * 新建 Bot 还没有 id，先提示到扩展中心。
   */
  let { botId }: { botId?: string | undefined } = $props();

  let accounts = $state<MailAccount[]>([]);
  let error = $state('');

  const bound = $derived(
    botId === undefined ? [] : accounts.filter((account) => account.botIds.includes(botId)),
  );

  async function reload(): Promise<void> {
    const result = (await core.call('mail.accounts.list')) as { accounts: MailAccount[] };
    accounts = result.accounts;
  }

  onMount(() => {
    void reload().catch((caught: unknown) => {
      error = caught instanceof AppError ? errorText(caught.code, caught.message) : String(caught);
    });
    // 对话内 mail setup / 扩展中心增删改绑定时推送；右栏开着时也要立刻刷新勾选列表。
    return core.onEvent('mail.account_updated', () => {
      void reload().catch(() => undefined);
    });
  });

  async function toggle(account: MailAccount, on: boolean): Promise<void> {
    if (botId === undefined) return;
    const next = on
      ? [...new Set([...account.botIds, botId])]
      : account.botIds.filter((id) => id !== botId);
    try {
      await core.call('mail.accounts.setBots', { id: account.id, botIds: next });
      await reload();
    } catch (caught) {
      error = caught instanceof AppError ? errorText(caught.code, caught.message) : String(caught);
    }
  }
</script>

<div class="grid gap-1.5" data-testid="bot-mail">
  <Label>{t('mail.botSection')}</Label>
  <p class="text-xs text-muted-foreground">{t('mail.botSectionHint')}</p>
  {#if botId === undefined}
    <p class="text-xs text-muted-foreground">{t('mail.botSectionAfterCreate')}</p>
  {:else if accounts.length === 0}
    <p class="text-xs text-muted-foreground">{t('mail.botSectionEmpty')}</p>
  {:else}
    <div class="space-y-1">
      {#each accounts as account (account.id)}
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={account.botIds.includes(botId)}
            onchange={(event) => void toggle(account, event.currentTarget.checked)}
            data-testid={`bot-mail-${account.id}`}
          />
          <span class="truncate">{account.label}</span>
          <span class="truncate text-xs text-muted-foreground">{account.address}</span>
        </label>
      {/each}
    </div>
    {#if bound.length > 0}
      <p class="text-xs text-muted-foreground">{t('mail.botSectionBound', { count: bound.length })}</p>
    {/if}
  {/if}
  {#if error}
    <p class="text-xs text-destructive">{error}</p>
  {/if}
  <Button
    type="button"
    variant="ghost"
    size="sm"
    class="justify-start px-0"
    onclick={() => shell.openExtensionCenter('mail')}
  >
    {t('mail.openExtension')}
  </Button>
</div>
