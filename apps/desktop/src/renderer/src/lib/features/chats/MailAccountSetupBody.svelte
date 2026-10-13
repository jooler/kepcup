<script lang="ts">
  import type { SetupRequirement } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import MailAccountAddForm from '$lib/features/mail/MailAccountAddForm.svelte';

  /**
   * 对话内「添加邮箱」卡（D84 + design 18）：`mail_request_setup` 中断 run 并携带
   * `setup.kind === 'mail-account'` 时出现。表单与扩展中心同源（MailAccountAddForm）；
   * 保存时绑定发起该 run 的 Bot，再走 `chat.continueAfterSetup`（收起 + runs.retry）。
   */
  let { requirement }: { requirement: Extract<SetupRequirement, { kind: 'mail-account' }> } =
    $props();

  const runBotId = $derived.by((): string | null => {
    const current = chat.current;
    if (current === null) return null;
    return current.failedRun?.botId ?? current.conversation.bot?.id ?? null;
  });

  let continued = false;
  function proceed(): void {
    if (continued) return;
    continued = true;
    void chat.continueAfterSetup();
  }

  $effect(() => {
    void requirement;
    continued = false;
  });
</script>

<div class="space-y-0.5 pr-6">
  <p class="text-sm font-medium" data-testid="setup-card-title">
    {t('setupCard.mailAccountTitle')}
  </p>
  <p class="text-xs text-muted-foreground">
    {requirement.reason && requirement.reason.trim().length > 0
      ? requirement.reason
      : t('setupCard.mailAccountHint')}
  </p>
</div>
{#if runBotId === null}
  <p class="text-sm text-destructive" data-testid="setup-card-mail-no-bot">
    {t('setupCard.mailAccountNoBot')}
  </p>
{:else}
  <MailAccountAddForm
    initialProvider={requirement.provider ?? 'qq'}
    bindBotId={runBotId}
    testidPrefix="setup-card-mail"
    onSaved={() => proceed()}
  />
{/if}
