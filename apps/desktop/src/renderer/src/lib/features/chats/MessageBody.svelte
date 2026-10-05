<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { lazyMarkdown } from './markdown-lazy.svelte';
  import Markdown from './Markdown.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';

  /**
   * 消息气泡本体（气泡槽位的内容渲染）：已撤回文案 / 编辑态（textarea +
   * 保存取消）/ 用户纯文本气泡 / Bot markdown 气泡。P13 任务 7 的 markdown
   * 管线（streamdown/shiki/katex）懒加载也挂在这里——它是 markdown 的消费方。
   * 后续新增内容形态（图片、音频、视频等多模态消息）在 MessageContent 联合
   * 类型上加成员并在这里加分支即可，不涉及消息行布局与操作层。
   * 圆角规律（参考 Grok）：半径取单行气泡高度的一半——用户气泡 py-2 + 行高
   * 20px＝36px → 18px，Bot 气泡 py-3 → 44px → 22px，单行整好成药丸形；
   * merge 标记上/下相邻条目是否同一发送者（MessageList 计算），连排时把
   * 对齐侧的两个角缩到约 1/3（用户在右减右角、Bot 在左减左角），同方连发
   * 在对齐侧看上去是一整块。
   * 编辑状态由 ChatMessageRow 持有（hover 编辑按钮与操作区都在行层），这里
   * 经 bindable 读写；保存经 onsave 回调交回行层（chat.edit）。
   */
  let {
    message,
    merge = { above: false, below: false },
    isEditing = $bindable(false),
    editText = $bindable(''),
    onsave,
  }: {
    message: Message;
    merge?: { above: boolean; below: boolean };
    isEditing?: boolean;
    editText?: string;
    onsave?: () => void;
  } = $props();

  const isRenderableText = $derived(
    message.senderType === 'bot' && message.kind !== 'card' && message.status !== 'recalled',
  );
  $effect(() => {
    if (isRenderableText) lazyMarkdown.start();
  });
</script>

{#if message.status === 'recalled'}
  <span class="mt-0.5 text-xs text-muted-foreground italic" data-testid="recalled-text">
    {t('chats.recalled')}
  </span>
{:else if isEditing}
  <div class="mt-1 w-full min-w-72 space-y-2">
    <Textarea bind:value={editText} rows={3} data-testid="edit-input" />
    <div class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={() => (isEditing = false)}>
        {t('chats.cancelEdit')}
      </Button>
      <Button size="sm" onclick={() => onsave?.()} data-testid="edit-save"
        >{t('chats.saveEdit')}</Button
      >
    </div>
  </div>
{:else if message.senderType === 'user'}
  {#if !('text' in message.content) || message.content.text.length > 0}
    <!-- 纯附件消息（docs/design/20-conversation-media.md）没有文本气泡，附件行即消息体。 -->
    <div
      class="rounded-[18px] bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground
        {merge.above ? 'rounded-tr-[6px]' : ''} {merge.below ? 'rounded-br-[6px]' : ''}"
      data-testid="user-bubble"
    >
      {'text' in message.content ? message.content.text : ''}
    </div>
  {/if}
{:else}
  <div
    class="rounded-[22px] bg-muted px-4 py-3 text-sm
      {merge.above ? 'rounded-tl-[7px]' : ''} {merge.below ? 'rounded-bl-[7px]' : ''}"
    data-testid="bot-bubble"
  >
    <div class="streamdown-wrap [&_pre]:overflow-x-auto [&_pre]:rounded-md">
      <Markdown content={'text' in message.content ? message.content.text : ''} />
    </div>
  </div>
{/if}
