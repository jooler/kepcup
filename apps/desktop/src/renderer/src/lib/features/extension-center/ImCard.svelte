<script lang="ts">
  import { t } from '$lib/i18n';
  import { avatarOnFillForeground, resolveAccentColor } from '$lib/avatars/presets';
  import { getChatSession } from '$lib/features/chats/chat-session-context';

  /**
   * 私聊里的 IM 入站消息（D109，54 号文档 §8）：微信消息到了。按正常用户消息
   * 的形态渲染——右对齐、跟随对话 Bot 强调色的药丸气泡（同 MessageBody 用户
   * 气泡），容器下方 caption「来自微信」标明来源。正文是宿主截取的入站摘要
   * （imSnippet，500 字符内，Svelte 自动转义不渲染格式）。
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

  const session = getChatSession();
  const userBubbleAccent = $derived(
    session.view?.conversation.bot
      ? resolveAccentColor(
          session.view.conversation.bot.accentColor,
          session.view.conversation.bot.avatar,
        )
      : null,
  );
</script>

<div class="flex w-full flex-col items-end" data-testid={`im-card-arrived-${accountId}`}>
  {#if summary.length > 0}
    <div
      class="my-2 max-w-[85%] rounded-[18px] px-3 py-2 text-sm whitespace-pre-wrap
        {userBubbleAccent ? '' : 'bg-primary text-primary-foreground'}"
      style:background={userBubbleAccent?.hex}
      style:color={userBubbleAccent ? avatarOnFillForeground(userBubbleAccent) : undefined}
      data-testid="im-card-bubble"
    >
      {summary}
    </div>
  {/if}
  <span class="mt-0.5 text-[11px] text-muted-foreground" data-testid="im-card-caption">
    {channel.length > 0 ? t('im.card.from', { channel }) : t('im.card.fromIm')}
  </span>
</div>
