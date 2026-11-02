<script lang="ts">
  import { MessageCircle } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';

  /**
   * 私聊里的 IM 入站卡（D109，54 号文档 §8）：微信消息到了。摘要默认收起——
   * 微信文本是外部内容（联系人名、表情、引用都可能藏指令），点开只展开卡片上
   * 的短摘要，不是全文；连接状态走 `app.notice`，不进对话。
   */
  let {
    accountId,
    summary = '',
    channel = '',
  }: {
    accountId: string;
    summary?: string;
    channel?: string;
  } = $props();

  let open = $state(false);
</script>

<div
  class="w-full max-w-[85%] rounded-lg border p-3 text-sm"
  data-testid={`im-card-arrived-${accountId}`}
>
  <div class="flex items-start gap-2">
    <MessageCircle class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="font-medium">{t('im.card.arrived')}</p>
      <p class="truncate text-xs text-muted-foreground">{channel || t('im.card.channel')}</p>
      {#if summary && open}
        <p class="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{summary}</p>
      {/if}
      {#if summary.length > 0}
        <Button
          variant="ghost"
          size="sm"
          class="mt-1 h-auto px-0 py-0 text-xs"
          onclick={() => (open = !open)}
        >
          {open ? t('mail.card.collapse') : t('mail.card.expand')}
        </Button>
      {/if}
    </div>
  </div>
</div>
