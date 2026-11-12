<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { getChatSession } from './chat-session-context';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { avatarOnFillForeground, resolveAccentColor } from '$lib/avatars/presets';
  import { lazyMarkdown } from './markdown-lazy.svelte';
  import Markdown from './Markdown.svelte';
  import VoiceMessageBubble from './VoiceMessageBubble.svelte';
  import { isVoiceMessage, voiceAttachmentOf } from './voice-message';
  import { buildLocalPathMentionTargets, buildMentionTargets } from './composer-text';
  import { composerTextToMarkdown } from './user-markdown';

  /**
   * 消息气泡本体（气泡槽位的内容渲染）：已撤回文案 / 用户 markdown 气泡 /
   * Bot markdown 气泡——两种发送方共用同一条 markdown 管线。P13 任务 7 的
   * markdown 管线（streamdown/shiki/katex）懒加载也挂在这里——它是 markdown
   * 的消费方。后续新增内容形态（图片、音频、视频等多模态消息）在 MessageContent
   * 联合类型上加成员并在这里加分支即可，不涉及消息行布局与操作层。
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

  /**
   * 气泡正文走 markdown 的两种发送方：Bot（默认）与用户（含 v2.3 交换会话里
   * 按用户气泡渲染的发起方）——两边共用同一个 Markdown 组件与懒加载入口。
   */
  const isUserBubble = $derived(message.senderType === 'user' || userStyle);
  const isRenderableText = $derived(
    message.kind !== 'card' &&
      message.status !== 'recalled' &&
      (message.senderType === 'bot' || isUserBubble),
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
  /**
   * 用户气泡是 markdown 源码：@提及转成 mention 链接（渲染后仍是胶囊），
   * 段内单换行补成硬换行（原来靠 whitespace-pre-wrap）。
   */
  const userMarkdown = $derived(composerTextToMarkdown(userText, mentionTargets));
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
      class="my-2 rounded-[18px] px-4 py-2 text-sm
        {merge.above ? 'rounded-tr-[6px]' : ''} {merge.below ? 'rounded-br-[6px]' : ''}
        {userBubbleAccent ? '' : 'bg-primary text-primary-foreground'}"
      style:background={userBubbleAccent?.hex}
      style:color={userBubbleAccent ? avatarOnFillForeground(userBubbleAccent) : undefined}
      data-testid="user-bubble"
      data-user-markdown
    >
      <!-- 正文与 Bot 气泡走同一条 markdown 管线；@提及已由 user-markdown 转成
           mention 链接、渲染成胶囊（非链接元素，点击不跳转）。气泡内的排版适配
           （currentColor 链接、行内代码底色、表格滚动）在 app.css 的
           [data-user-markdown] 段。 -->
      <div class="streamdown-wrap min-w-0">
        <Markdown content={userMarkdown} fallback={userText} userMessage />
      </div>
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
