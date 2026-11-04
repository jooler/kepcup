<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { File as FileIcon, Folder as FolderIcon } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { getChatSession } from './chat-session-context';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { avatarOnFillForeground, resolveAccentColor } from '$lib/avatars/presets';
  import { lazyMarkdown } from './markdown-lazy.svelte';
  import Markdown from './Markdown.svelte';
  import VoiceMessageBubble from './VoiceMessageBubble.svelte';
  import { isVoiceMessage, voiceAttachmentOf } from './voice-message';
  import {
    buildLocalPathMentionTargets,
    buildMentionTargets,
    localPathName,
    segmentComposerText,
  } from './composer-text';

  /**
   * 消息气泡本体（气泡槽位的内容渲染）：已撤回文案 / 用户纯文本气泡 /
   * Bot markdown 气泡。P13 任务 7 的 markdown 管线（streamdown/shiki/katex）
   * 懒加载也挂在这里——它是 markdown 的消费方。后续新增内容形态（图片、音
   * 频、视频等多模态消息）在 MessageContent 联合类型上加成员并在这里加分
   * 支即可，不涉及消息行布局与操作层。
   * 圆角规律（参考 Grok）：半径取单行气泡高度的一半——text-sm 行高 20px +
   * py-2（上下各 8px）＝36px → 18px，用户气泡与 Bot 气泡单行都成药丸形；
   * merge 标记上/下相邻条目是否同一发送者（MessageList 计算），连排时把
   * 对齐侧的两个角缩到约 1/3（用户在右减右角、Bot 在左减左角），同方连发
   * 在对齐侧看上去是一整块。
   */
  let {
    message,
    merge = { above: false, below: false },
    userStyle = false,
  }: {
    message: Message;
    merge?: { above: boolean; below: boolean };
    /** v2.3 交换会话：发起方 A 的消息按用户气泡渲染（ChatMessageRow 传入）。 */
    userStyle?: boolean;
  } = $props();

  const isRenderableText = $derived(
    message.senderType === 'bot' && message.kind !== 'card' && message.status !== 'recalled',
  );
  $effect(() => {
    if (isRenderableText) lazyMarkdown.start();
  });
  const session = getChatSession();
  /**
   * 用户气泡跟随对话 Bot 的强调色（单聊取 direct bot；项目组没有单一 Bot，
   * 维持默认主色）。这是「Bot 的腔调色」而非头像色：换预置形状、上传头像都
   * 不影响它。第一种「黑白」是 var() 主题变量，亮/暗风格下黑白互换，文字用
   * 其对比色；其余固定色一律白字。v2.3 交换会话里发起方 A 扮演用户侧——
   * 直聊 bot 缺失时回落 A 自己的强调色，与用户在 A 私聊里看到的气泡一致。
   */
  const exchangeIssuerBot = $derived(
    session.view?.conversation.type === 'bot_direct'
      ? (contacts.bots.find((b) => b.id === (session.view?.conversation.fromBotId ?? '')) ?? null)
      : null,
  );
  const userBubbleAccent = $derived(
    session.view?.conversation.bot
      ? resolveAccentColor(
          session.view.conversation.bot.accentColor,
          session.view.conversation.bot.avatar,
        )
      : exchangeIssuerBot !== null
        ? resolveAccentColor(exchangeIssuerBot.accentColor, exchangeIssuerBot.avatar)
        : null,
  );
  /**
   * 用户气泡的 @ 提及分词：注册表（全部活跃 Bot + 项目组）与输入框共用同一
   * 套规则，手动输入的全名同样命中着色。本地文件/文件夹提及从消息的 mentions
   * token 还原（正文里是 `@完整路径`，气泡里换成 icon + basename 展示）。
   */
  const mentionTargets = $derived.by(() => [
    ...buildMentionTargets({
      memberBots: [],
      allBots: contacts.bots,
      projects: chat.conversations
        .filter((c) => c.type === 'project')
        .map((c) => ({ id: c.id, title: c.title })),
    }),
    ...buildLocalPathMentionTargets(message.mentions),
  ]);
  const userText = $derived('text' in message.content ? message.content.text : '');
  const userSegments = $derived(
    message.senderType === 'user' || userStyle ? segmentComposerText(userText, mentionTargets) : [],
  );
  // Bot 气泡的正文；空（含纯空白）时不渲染气泡容器——纯附件消息（如媒体
  // 生成的确定性投递）只有附件行，空气泡会在 UI 里留下空元素。
  const botText = $derived('text' in message.content ? message.content.text : '');
  const hasBotText = $derived(botText.trim().length > 0);
  /**
   * 语音气泡（53 号修订 v3）：origin='voice' 的消息按语音消息形态渲染——用户
   * 消息还必须有原始录音附件（转写失败但附件在也照常可播）；Bot 消息不需要
   * 附件（音频按需合成）。其余消息走原来的文本气泡。
   */
  const voiceBubble = $derived(
    isVoiceMessage(message) &&
      (message.senderType === 'bot' || voiceAttachmentOf(message) !== null),
  );
</script>

{#if message.status === 'recalled'}
  <span class="mt-0.5 text-xs text-muted-foreground italic" data-testid="recalled-text">
    {t('chats.recalled')}
  </span>
{:else if voiceBubble}
  <!-- 语音消息（53 号修订 v3）：药丸 + 波形进度 + 下方 caption；用户原始录音
       与 Bot 合成音频共用一条音频声道。 -->
  <VoiceMessageBubble {message} />
{:else if message.senderType === 'user' || userStyle}
  {#if !('text' in message.content) || message.content.text.length > 0}
    <!-- 纯附件消息（docs/design/20-conversation-media.md）没有文本气泡，附件行即消息体。 -->
    <div
      class="my-2 rounded-[18px] px-4 py-2 text-sm whitespace-pre-wrap
        {merge.above ? 'rounded-tr-[6px]' : ''} {merge.below ? 'rounded-br-[6px]' : ''}
        {userBubbleAccent ? '' : 'bg-primary text-primary-foreground'}"
      style:background={userBubbleAccent?.hex}
      style:color={userBubbleAccent ? avatarOnFillForeground(userBubbleAccent) : undefined}
      data-testid="user-bubble"
    >
      {#each userSegments as segment, index (index)}
        {#if segment.kind === 'mention'}
          <!-- 边框取 currentColor（= 气泡文字色，跟随任意强调色/主色），
               不再用背景色。本地文件/文件夹用 icon + 名称，左右各留 4px。 -->
          <span
            class="mx-1 inline-flex items-center gap-1 rounded-sm border border-current/30 px-1 align-baseline"
            data-testid="user-mention"
            data-kind={segment.target.kind === 'file' || segment.target.kind === 'folder'
              ? segment.target.kind
              : undefined}
            title={segment.target.kind === 'file' || segment.target.kind === 'folder'
              ? segment.target.path
              : undefined}
          >
            {#if segment.target.kind === 'folder'}
              <FolderIcon class="size-3 shrink-0" aria-hidden="true" />
            {:else if segment.target.kind === 'file'}
              <FileIcon class="size-3 shrink-0" aria-hidden="true" />
            {/if}
            <span class="max-w-48 truncate">
              {segment.target.kind === 'file' || segment.target.kind === 'folder'
                ? localPathName(segment.target.path ?? segment.target.name)
                : segment.text}
            </span>
          </span>
        {:else}
          {segment.text}
        {/if}
      {/each}
    </div>
  {/if}
{:else if hasBotText}
  <div
    class="max-w-full min-w-0 rounded-[1.625rem] bg-muted p-4 text-sm
      {merge.above ? 'rounded-tl-[0.5rem]' : ''} {merge.below ? 'rounded-bl-[0.5rem]' : ''}"
    data-testid="bot-bubble"
  >
    <div class="streamdown-wrap min-w-0 [&_pre]:rounded-md">
      <Markdown content={botText} />
    </div>
  </div>
{/if}
