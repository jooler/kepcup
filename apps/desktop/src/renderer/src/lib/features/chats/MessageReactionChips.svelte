<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { getChatSession } from './chat-session-context';
  import { REPORT_EMOJI, messageReactions } from './message-reactions.svelte';

  /**
   * 气泡下方的 reaction chips 行（AI 内容举报 todo §4.4）：数据来自 reaction
   * store 的会话聚合（messageId → {emoji, count, mine}[]），无 reaction 不渲染。
   * chip = emoji +（count > 1 时）数字；自己的 chip accent 高亮；自己的非 👎
   * chip 点击 = 取消自己的 reaction（messages.react null）；👎 chip 不可点取
   * 消（举报不可撤回，§4.3）。本行独立于气泡 merge 圆角计算，只占 mt-0.5
   * 的一行。
   */
  let { message }: { message: Message } = $props();

  const session = getChatSession();

  const summaries = $derived(
    messageReactions.summariesOf(session.source, message.conversationId, message.id),
  );

  function chipAria(emoji: string, count: number): string {
    return t('messages.reactions.chipAria' as MessageKey, { emoji, count });
  }

  /** 自己的非 👎 chip：点击取消自己的 reaction（store 按「同一个再点 = 取消」处理）。 */
  function chipClick(emoji: string): void {
    if (emoji === REPORT_EMOJI) return;
    messageReactions.handleReact({ source: session.source, message, view: null }, emoji);
  }
</script>

{#if summaries.length > 0}
  <div class="mt-0.5 flex flex-wrap items-center gap-1" data-testid="message-reactions">
    {#each summaries as entry (entry.emoji)}
      {#if entry.mine && entry.emoji !== REPORT_EMOJI}
        <button
          type="button"
          class="inline-flex items-center gap-0.5 rounded-full border border-accent bg-accent/40 px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-accent/60"
          onclick={() => chipClick(entry.emoji)}
          aria-label={chipAria(entry.emoji, entry.count)}
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
