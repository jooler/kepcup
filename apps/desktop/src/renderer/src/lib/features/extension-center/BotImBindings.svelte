<script lang="ts">
  import { onMount } from 'svelte';
  import type { ImAccount } from '@kepcup/shared';
  import { AppError } from '@kepcup/shared';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { Label } from '$lib/components/ui/label';

  /**
   * Bot 档案里的 IM 账号勾选与「同步消息到此微信」开关（D111，54 号文档 §7）。
   * 勾选 = 绑定（绑定即入站：微信永远能发消息唤醒 Bot）；行内开关 = 出站转发
   * （Bot 回复自动同步到微信，Bot 无感）。开关关闭时收到微信消息会自动补勾
   * + 一次性提示；永不自动取消——回电脑后由用户手动关闭。
   */
  let { botId }: { botId?: string | undefined } = $props();

  let accounts = $state<ImAccount[]>([]);
  let error = $state('');

  const bound = $derived(
    botId === undefined ? [] : accounts.filter((account) => account.botIds.includes(botId)),
  );

  async function reload(): Promise<void> {
    const result = (await core.call('im.accounts.list')) as { accounts: ImAccount[] };
    accounts = result.accounts;
  }

  onMount(() => {
    void reload().catch((caught: unknown) => {
      error = caught instanceof AppError ? errorText(caught.code, caught.message) : String(caught);
    });
    // 扩展中心增删 / 重扫 / 状态变化推送；右栏开着时也要立刻刷新。
    return core.onEvent('im.account_updated', () => {
      void reload().catch(() => undefined);
    });
  });

  async function toggle(account: ImAccount, on: boolean): Promise<void> {
    if (botId === undefined) return;
    const next = on
      ? [...new Set([...account.botIds, botId])]
      : account.botIds.filter((id) => id !== botId);
    try {
      await core.call('im.accounts.setBots', { id: account.id, botIds: next });
      await reload();
    } catch (caught) {
      error = caught instanceof AppError ? errorText(caught.code, caught.message) : String(caught);
    }
  }

  /** D111 同步开关：只改出站，不影响绑定（入站恒可用）。 */
  async function setForward(account: ImAccount, enabled: boolean): Promise<void> {
    if (botId === undefined) return;
    try {
      await core.call('im.bindings.setForward', { accountId: account.id, botId, forwardEnabled: enabled });
      await reload();
    } catch (caught) {
      error = caught instanceof AppError ? errorText(caught.code, caught.message) : String(caught);
    }
  }
</script>

<div class="grid gap-1.5" data-testid="bot-im">
  <Label>{t('im.botSection')}</Label>
  <p class="text-xs text-muted-foreground">{t('im.botSectionHint')}</p>
  {#if botId === undefined}
    <p class="text-xs text-muted-foreground">{t('im.botSectionAfterCreate')}</p>
  {:else if accounts.length === 0}
    <p class="text-xs text-muted-foreground">{t('im.botSectionEmpty')}</p>
  {:else}
    <div class="space-y-1">
      {#each accounts as account (account.id)}
        <div class="flex items-center gap-2 text-sm" data-testid={`bot-im-${account.id}`}>
          <label class="flex min-w-0 items-center gap-2">
            <input
              type="checkbox"
              checked={account.botIds.includes(botId)}
              onchange={(event) => void toggle(account, event.currentTarget.checked)}
              data-testid={`bot-im-bind-${account.id}`}
            />
            <span class="truncate">{account.label}</span>
          </label>
          {#if account.botIds.includes(botId)}
            <label
              class="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              title={t('im.forwardHint')}
            >
              <input
                type="checkbox"
                checked={account.forwardBotIds.includes(botId)}
                onchange={(event) => void setForward(account, event.currentTarget.checked)}
                data-testid={`bot-im-forward-${account.id}`}
              />
              {t('im.forwardToggle')}
            </label>
          {/if}
        </div>
      {/each}
    </div>
    {#if bound.length > 0}
      <p class="text-xs text-muted-foreground">{t('im.botSectionBound', { count: bound.length })}</p>
    {/if}
  {/if}
  {#if error}
    <p class="text-xs text-destructive">{error}</p>
  {/if}
</div>
