<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { avatarOnFillForeground, parsePresetAvatar } from '$lib/avatars/presets';
  import { lazyMarkdown } from './markdown-lazy.svelte';
  import Markdown from './Markdown.svelte';
  import { buildMentionTargets, segmentComposerText } from './composer-text';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';

  /**
   * 消息气泡本体（气泡槽位的内容渲染）：已撤回文案 / 编辑态（textarea +
   * 保存取消）/ 用户纯文本气泡 / Bot markdown 气泡。P13 任务 7 的 markdown
   * 管线（streamdown/shiki/katex）懒加载也挂在这里——它是 markdown 的消费方。
   * 后续新增内容形态（图片、音频、视频等多模态消息）在 MessageContent 联合
   * 类型上加成员并在这里加分支即可，不涉及消息行布局与操作层。
   * 圆角规律（参考 Grok）：半径取单行气泡高度的一半——text-sm 行高 20px +
   * py-2（上下各 8px）＝36px → 18px，用户气泡与 Bot 气泡单行都成药丸形；
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
  /**
   * 用户气泡跟随对话 Bot 的预置头像色（单聊取 direct bot，项目组没有单一
   * Bot，维持默认主色）。第一种「黑白」是 var() 主题变量，亮/暗风格下
   * 黑白互换，文字用其对比色；其余固定色一律白字。
   */
  const userBubbleColor = $derived(
    parsePresetAvatar(chat.current?.conversation.bot?.avatar ?? null)?.color ?? null,
  );
  /**
   * 用户气泡的 @ 提及分词：注册表（全部活跃 Bot + 项目组）与输入框共用同一
   * 套规则，手动输入的全名同样命中着色。
   */
  const mentionTargets = $derived.by(() =>
    buildMentionTargets({
      memberBots: [],
      allBots: contacts.bots,
      projects: chat.conversations
        .filter((c) => c.type === 'project')
        .map((c) => ({ id: c.id, title: c.title })),
    }),
  );
  const userText = $derived('text' in message.content ? message.content.text : '');
  const userSegments = $derived(
    message.senderType === 'user' ? segmentComposerText(userText, mentionTargets) : [],
  );
  // Bot 气泡的正文；空（含纯空白）时不渲染气泡容器——纯附件消息（如媒体
  // 生成的确定性投递）只有附件行，空气泡会在 UI 里留下空元素。
  const botText = $derived('text' in message.content ? message.content.text : '');
  const hasBotText = $derived(botText.trim().length > 0);
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
      class="rounded-[18px] px-3 py-2 my-2 text-sm whitespace-pre-wrap
        {merge.above ? 'rounded-tr-[6px]' : ''} {merge.below ? 'rounded-br-[6px]' : ''}
        {userBubbleColor ? '' : 'bg-primary text-primary-foreground'}"
      style:background={userBubbleColor?.hex}
      style:color={userBubbleColor ? avatarOnFillForeground(userBubbleColor) : undefined}
      data-testid="user-bubble"
    >
      {#each userSegments as segment, index (index)}
        {#if segment.kind === 'mention'}
          <!-- 边框取 currentColor（= 气泡文字色，跟随任意预置头像色/主色），
               不再用背景色 -->
          <span class="mx-1 rounded-sm border border-current/30 px-1" data-testid="user-mention">
            {segment.text}
          </span>
        {:else}
          {segment.text}
        {/if}
      {/each}
    </div>
  {/if}
{:else if hasBotText}
  <div
    class="max-w-full min-w-0 rounded-[16px] bg-muted px-3 py-2 text-sm
      {merge.above ? 'rounded-tl-[5px]' : ''} {merge.below ? 'rounded-bl-[5px]' : ''}"
    data-testid="bot-bubble"
  >
    <div class="streamdown-wrap min-w-0 [&_pre]:rounded-md">
      <Markdown content={botText} />
    </div>
  </div>
{/if}
