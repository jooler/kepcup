<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { Check } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { chat } from '$lib/stores/chat.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { toast } from 'svelte-sonner';

  /**
   * 初始化访谈的问题卡片（参考 Grok）：问题文本 + 预置候选答案行 + 常驻的
   * 自定义回答输入框。点选候选或提交自定义回答后，卡片收起为「问题 + 单条
   * 已答行（✓）」，回答不再以用户消息气泡出现（走 bots.interview.answer，
   * 落一条 setupAnswer 标记消息，MessageList 不渲染）。
   * 卡片与 bot 气泡同形（MessageList 视其参与 bot 侧连排）：圆角取单行
   * 高度一半（py-3 + 行高 20px → 22px），merge 标记相邻 bot 侧条目时把
   * 左侧角缩到 1/3。
   */
  let {
    message,
    merge = { above: false, below: false },
  }: { message: Message; merge?: { above: boolean; below: boolean } } = $props();

  const question = $derived(
    message.kind === 'system_event' && 'text' in message.content ? message.content.text : '',
  );
  const options = $derived(
    message.kind === 'system_event' && 'options' in message.content
      ? (message.content.options ?? [])
      : [],
  );

  // 已答判定：访谈一问一答，本条之后的第一条用户文本消息即本次回答
  //（setupAnswer 标记消息 / 用户在输入框自由输入的普通消息都算）。
  const answeredText = $derived.by(() => {
    for (const m of chat.current?.messages ?? []) {
      if (m.seq <= message.seq || m.senderType !== 'user' || m.kind !== 'text') continue;
      if (m.status === 'recalled') continue;
      return 'text' in m.content ? m.content.text : '';
    }
    return null;
  });
  const interactive = $derived(
    answeredText === null && chat.current?.conversation.bot?.setupState === 'interviewing',
  );

  let customText = $state('');
  let submitting = $state(false);

  async function submit(text: string): Promise<void> {
    const answer = text.trim();
    const conversationId = chat.current?.conversation.id;
    if (answer.length === 0 || submitting || !interactive || conversationId === undefined) return;
    submitting = true;
    try {
      await core.call('bots.interview.answer', { conversationId, text: answer });
    } catch (error) {
      toast.error(t('chats.setupAnswerFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      submitting = false;
    }
  }

  function submitCustom(): void {
    void submit(customText);
  }
</script>

<div
  class="flex w-full max-w-[50%] flex-col gap-2 rounded-[22px] bg-muted px-4 py-3
    {merge.above ? 'rounded-tl-[7px]' : ''} {merge.below ? 'rounded-bl-[7px]' : ''}"
  data-testid="setup-question-card"
  data-answered={answeredText === null ? 'false' : 'true'}
>
  <div class="text-sm font-medium" data-testid="setup-question-text">{question}</div>
  {#if answeredText !== null}
    <!-- 已答态：答案列表与输入框收起，只留最终回答这一条 -->
    <div
      class="flex items-center justify-between gap-2 rounded-lg border border-primary/20 bg-background px-3 py-2 text-sm"
      data-testid="setup-answer"
    >
      <span class="min-w-0 truncate">{answeredText}</span>
      <Check class="size-4 shrink-0 text-primary" aria-hidden="true" />
    </div>
  {:else}
    <div class="flex flex-col gap-1.5">
      {#each options as option, index (option)}
        <button
          type="button"
          class="flex items-center rounded-lg border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent"
          disabled={submitting}
          onclick={() => void submit(option)}
          data-testid={`setup-option-${index}`}
        >
          <span class="min-w-0 truncate">{option}</span>
        </button>
      {/each}
    </div>
    <div class="flex items-center gap-2">
      <Input
        bind:value={customText}
        placeholder={t('chats.setupCustomPlaceholder')}
        disabled={submitting}
        class="h-9 bg-background"
        data-testid="setup-custom-input"
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submitCustom();
          }
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        class="size-9 shrink-0"
        disabled={submitting || customText.trim().length === 0}
        onclick={submitCustom}
        aria-label={t('chats.setupCustomSubmit')}
        data-testid="setup-custom-submit"
      >
        <Check class="size-4" aria-hidden="true" />
      </Button>
    </div>
  {/if}
</div>
