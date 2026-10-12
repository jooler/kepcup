<script lang="ts">
  import { Mail } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';

  /**
   * 私聊里的新邮件卡（D84）：什么时间、谁发来的、摘要是什么，是对话上下文里的有效
   * 信息，所以固化在对话中。摘要默认收起，点开也只是卡片上的短摘要，不是全文。
   * 连接中断、提醒暂停这类应用状态不是对话内容，走 `app.notice` 提示。
   */
  let {
    accountId,
    summary = '',
    from = '',
    subject = '',
  }: {
    accountId: string;
    summary?: string;
    from?: string;
    subject?: string;
  } = $props();

  let open = $state(false);
</script>

<div
  class="w-full max-w-[85%] rounded-lg border p-3 text-sm"
  data-testid={`mail-card-arrived-${accountId}`}
>
  <div class="flex items-start gap-2">
    <Mail class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="font-medium">{t('mail.card.arrived')}</p>
      <p class="truncate text-xs text-muted-foreground">
        {from || t('mail.card.unknownFrom')} · {subject || t('mail.card.noSubject')}
      </p>
      {#if summary && open}
        <p class="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{summary}</p>
      {/if}
      {#if summary.length > 0}
        <div class="mt-2 flex gap-2">
          <Button size="sm" variant="ghost" onclick={() => (open = !open)}>
            {open ? t('mail.card.collapse') : t('mail.card.expand')}
          </Button>
        </div>
      {/if}
    </div>
  </div>
</div>
