<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { getChatSession } from './chat-session-context';
  import { reactionTargetOf } from './message-reaction-target';
  import { REPORT_EMOJI, messageReactions } from './message-reactions.svelte';

  /**
   * 气泡下方的 reaction chips 行（AI 内容举报 todo §4.4）：数据来自 reaction
   * store 的会话聚合（messageId → {emoji, count, mine}[]），无 reaction 不渲染。
   * chip = emoji +（count > 1 时）数字；自己的 chip accent 高亮且可点——非 👎
   * 点击 = 取消自己的 reaction（messages.react null），👎 点击 = 切换关闭
   * （移除 emoji + 撤回待发送的举报，与面板同一 store 路径，§4.3）；他人的
   * chip 只读（span）。本行独立于气泡 merge 圆角计算，只占 mt-0.5 的一行。
   */
  let { message }: { message: Message } = $props();

  const session = getChatSession();

  const summaries = $derived(
    messageReactions.summariesOf(session.source, message.conversationId, message.id),
  );

  function chipAria(emoji: string, count: number): string {
    return t('messages.reactions.chipAria' as MessageKey, { emoji, count });
  }

  function emojiAria(emoji: string): string {
    return t(`messages.reactions.emoji.${emoji}` as MessageKey);
  }

  /**
   * 自己的 chip：点击走 store 同一路径（非 👎 取消 reaction；👎 切换关闭）。
   * target 用 reactionTargetOf 与面板/右键菜单同源构建——chip 的 👎 再点也可能
   * 落到首次举报路径（此前 toggle 关闭后 mine ≠ 👎），团队来源需要 view 快照。
   */
  function chipClick(emoji: string): void {
    messageReactions.handleReact(reactionTargetOf(session, message), emoji);
  }
</script>

{#if summaries.length > 0}
  <div class="mt-0.5 flex flex-wrap items-center gap-1" data-testid="message-reactions">
    {#each summaries as entry (entry.emoji)}
      {#if entry.mine}
        <button
          type="button"
          class="inline-flex items-center gap-0.5 rounded-full border border-accent bg-accent/40 px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-accent/60"
          onclick={() => chipClick(entry.emoji)}
          aria-label={entry.emoji === REPORT_EMOJI
            ? emojiAria(entry.emoji)
            : chipAria(entry.emoji, entry.count)}
          data-testid={`reaction-chip-${entry.emoji}`}
        >
          <span aria-hidden="true">{entry.emoji}</span>
          {#if entry.count > 1}<span>{entry.count}</span>{/if}
        </button>
      {:else}
        <span
          class="inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-xs {entry.mine
            ? 'border-accent bg-accent/40 text-foreground'
            : 'border-border text-muted-foreground'}"
          aria-label={chipAria(entry.emoji, entry.count)}
          data-testid={`reaction-chip-${entry.emoji}`}
        >
          <span aria-hidden="true">{entry.emoji}</span>
          {#if entry.count > 1}<span>{entry.count}</span>{/if}
        </span>
      {/if}
    {/each}
  </div>
{/if}
