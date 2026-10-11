<script lang="ts">
  import { Mail } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { AppError } from '@kepcup/shared';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * 私聊里的邮件卡（D84）。摘要默认收起，点开也只是卡片上的短摘要，不是全文。
   */
  let {
    accountId,
    mailEvent,
    summary = '',
    from = '',
    subject = '',
  }: {
    accountId: string;
    mailEvent: string;
    summary?: string;
    from?: string;
    subject?: string;
  } = $props();

  let open = $state(false);
  const botId = $derived(chat.current?.conversation.directBotId ?? '');
  const title = $derived(
    mailEvent === 'paused'
      ? t('mail.card.paused')
      : mailEvent === 'error'
        ? t('mail.card.error')
        : t('mail.card.arrived'),
  );

  async function resume(): Promise<void> {
    if (botId.length === 0) return;
    try {
      await core.call('mail.bindings.resume', { accountId, botId });
      toast.success(t('mail.resumeAlerts'));
    } catch (error) {
      const text = error instanceof AppError ? errorText(error.code, error.message) : String(error);
      toast.error(text);
    }
  }
</script>

<div
  class="w-full max-w-[85%] rounded-lg border p-3 text-sm"
  data-testid={`mail-card-${mailEvent}-${accountId}`}
>
  <div class="flex items-start gap-2">
    <Mail class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="font-medium">{title}</p>
      {#if mailEvent === 'arrived'}
        <p class="truncate text-xs text-muted-foreground">
          {from || t('mail.card.unknownFrom')} · {subject || t('mail.card.noSubject')}
        </p>
      {/if}
      {#if summary && (open || mailEvent !== 'arrived')}
        <p class="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{summary}</p>
      {/if}
      <div class="mt-2 flex gap-2">
        {#if mailEvent === 'arrived' && summary.length > 0}
          <Button size="sm" variant="ghost" onclick={() => (open = !open)}>
            {open ? t('mail.card.collapse') : t('mail.card.expand')}
          </Button>
        {/if}
        {#if mailEvent === 'paused' && botId.length > 0}
          <Button size="sm" variant="secondary" onclick={() => void resume()} data-testid="mail-card-resume">
            {t('mail.resumeAlerts')}
          </Button>
        {/if}
      </div>
    </div>
  </div>
</div>
