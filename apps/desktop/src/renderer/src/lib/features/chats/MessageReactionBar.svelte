<script lang="ts">
  import { Smile } from '@lucide/svelte';
  import { Popover } from 'bits-ui';
  import { t, type MessageKey } from '$lib/i18n';
  import {
    MORE_REACTION_EMOJIS,
    QUICK_REACTION_EMOJIS,
    messageReactions,
    type ReactionTarget,
  } from './message-reactions.svelte';

  /**
   * Bot 消息的 emoji 反应入口（AI 内容举报 todo §4.1 / §4.2）：hover 操作组
   * 第一个按钮弹出 bits-ui Popover 面板——第一行 5 个快捷表情，「＋」展开
   * 剩余 7 个常用表情（都取 shared MESSAGE_REACTION_EMOJIS 的切片，不复制）。
   * 非 👎 点选切换本机 reaction（再点同一个取消）；👎 走举报流程（记 👎 +
   * reports.submit，无弹窗无 toast）。点选后关面板、焦点回触发按钮；当前
   * 已选中的高亮并带 aria-pressed。触发按钮不用 styled Tooltip（那会嵌套
   * 两个按钮元素），用 title + aria-label 提供同一份文案。
   */
  let { reactionTarget: target }: { reactionTarget: ReactionTarget } = $props();

  let open = $state(false);
  let expanded = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  /** 本 client 在该消息上的当前 emoji（面板高亮与 aria-pressed 用）。 */
  const mineEmoji = $derived(
    messageReactions.mineEmojiOf(target.source, target.message.conversationId, target.message.id),
  );

  function emojiLabel(emoji: string): string {
    return t(`messages.reactions.emoji.${emoji}` as MessageKey);
  }

  function pick(emoji: string): void {
    messageReactions.handleReact(target, emoji);
    // 点选即关面板并把焦点交回触发按钮（§4.2 键盘可达）。
    open = false;
    triggerEl?.focus();
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    bind:ref={triggerEl}
    class="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    title={t('messages.reactions.add')}
    aria-label={t('messages.reactions.add')}
    data-testid="message-react"
  >
    <Smile class="size-3.5" aria-hidden="true" />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      class="z-50 flex w-fit flex-col gap-0.5 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl"
      side="bottom"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      data-testid="message-react-panel"
    >
      <div class="flex items-center gap-0.5">
        {#each QUICK_REACTION_EMOJIS as emoji (emoji)}
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-lg text-base transition-colors hover:bg-accent {mineEmoji === emoji
              ? 'bg-accent ring-1 ring-accent'
              : ''}"
            onclick={() => pick(emoji)}
            aria-label={emojiLabel(emoji)}
            aria-pressed={mineEmoji === emoji}
            data-testid={`reaction-option-${emoji}`}
          >
            {emoji}
          </button>
        {/each}
        {#if !expanded}
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={() => (expanded = true)}
            aria-label={t('messages.reactions.more')}
            data-testid="message-react-more"
          >
            ＋
          </button>
        {/if}
      </div>
      {#if expanded}
        <div class="flex items-center gap-0.5">
          {#each MORE_REACTION_EMOJIS as emoji (emoji)}
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-lg text-base transition-colors hover:bg-accent {mineEmoji === emoji
                ? 'bg-accent ring-1 ring-accent'
                : ''}"
              onclick={() => pick(emoji)}
              aria-label={emojiLabel(emoji)}
              aria-pressed={mineEmoji === emoji}
              data-testid={`reaction-option-${emoji}`}
            >
              {emoji}
            </button>
          {/each}
        </div>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
