<script lang="ts">
  import type { Component } from 'svelte';
  import type { Message } from '@kepcup/shared';
  import {
    AlarmClock,
    ClipboardList,
    Copy,
    Pin,
    Reply,
    Undo2,
    type LucideIcon,
  } from '@lucide/svelte';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { getChatSession } from './chat-session-context';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import MessageBody from './MessageBody.svelte';
  import { exchangeMessageShape } from './exchange-message';
  import MessageAttachments from './MessageAttachments.svelte';
  import QuotedMedia from './QuotedMedia.svelte';
  import FileArtifacts from '$lib/features/files/FileArtifacts.svelte';
  import { workbench } from '$lib/features/workbench/workbench.svelte';
  import { stickies } from './stickies.svelte';
  import { voiceRecordingOf } from './voice-message';

  /**
   * 普通对话消息行（用户 / Bot 文本消息）：负责布局与交互——用户消息反向
   * 排列、项目组头像列、引用行、hover 操作（引用/复制/固定/撤回）与右键
   * 菜单、证据跳转高亮。气泡内容与附件分别委托 MessageBody /
   * MessageAttachments（附件在上、正文在下）：后续多模态支持（图片、音
   * 频、视频等）只扩展那两层，本行的布局与操作保持稳定。merge 为连排信
   * 息，透传给 MessageBody 决定对齐侧圆角。isLast 标记本行是否为会话记录
   * 最后一条（撤回按钮只挂在其用户消息上）。
   */
  let {
    message,
    isLast = false,
    merge = { above: false, below: false },
  }: { message: Message; isLast?: boolean; merge?: { above: boolean; below: boolean } } = $props();

  const isUser = $derived(message.senderType === 'user');
  /** D71：另一个 Bot 代用户转交的消息（B 的私聊）——标注来源，不可撤回。 */
  const delegatedBy = $derived(
    message.senderType === 'user' &&
      'origin' in message.content &&
      message.content.origin === 'delegation'
      ? (message.content.delegatedBy ?? '')
      : null,
  );
  /**
   * D75 §6.1：任务发出的可见消息（origin = 'task'）——任务执行中的进度
   * （run_id = 任务）或旧版本 forward_task_result 留下的原文转发行——
   * 标出所属任务，与 Bot 的直接回复区分。
   */
  const taskOrigin = $derived(
    !isUser && 'origin' in message.content && message.content.origin === 'task'
      ? {
          taskId: message.content.taskId ?? '',
          forwarded: message.runId !== null && message.runId !== message.content.taskId,
        }
      : null,
  );
  $effect(() => {
    if (taskOrigin !== null && taskOrigin.taskId.length > 0) void tasks.ensure(taskOrigin.taskId);
  });
  const taskTitle = $derived(
    taskOrigin !== null ? (tasks.byId[taskOrigin.taskId]?.title ?? '') : '',
  );
  /** D80：定时触发的对话轮发出的回复——气泡下方「⏰ 标题」，点开定时任务列表。 */
  const scheduleTitle = $derived(
    !isUser && 'scheduleId' in message.content && message.content.scheduleId
      ? (message.content.scheduleTitle ?? '')
      : null,
  );
  /**
   * D94：系统分享导入的用户消息——气泡下方一个只读标签「通过系统分享导入」。
   * 不生成用户口吻的默认文案，正文只有用户自己写的附言（可能为空）。
   */
  const isShareImport = $derived(
    isUser &&
      message.kind === 'text' &&
      'shareIntakeId' in message.content &&
      typeof message.content.shareIntakeId === 'string' &&
      message.content.shareIntakeId.length > 0,
  );
  /** D90：工作台事项派发引出的回复——气泡下方「📋 标题」，点开工作台该事项。 */
  const todoSource = $derived(
    !isUser &&
      'todoId' in message.content &&
      message.content.todoId &&
      message.content.todoTitle !== undefined
      ? { id: message.content.todoId, title: message.content.todoTitle }
      : null,
  );
  // 头像：项目组里非用户消息带头像（头像即发送者身份，不渲染名字/时间行）；
  // v2.3 交换会话双侧都是 Bot——两边都带头像，同一 Bot 连续消息只有第一条
  // 带（merge.above 为真时留同尺寸占位，保持对齐不塌）。
  const session = getChatSession();
  const isProjectChat = $derived(session.view?.conversation.type === 'project');
  /**
   * v2.3 交换会话形态：发起方 A 相当于这条对话里的「用户」——消息居右、
   * 用户样式气泡（userStyle 传给 MessageBody）；B 居左 Bot 样式。普通对话
   * shape 为 null，isUser 保持按 senderType。
   */
  const exchangeShape = $derived(exchangeMessageShape(session.view?.conversation, message));
  const exchangeChat = $derived(session.view?.conversation.type === 'bot_direct');
  /** 布局用的「用户侧」（行方向 / 对齐 / 操作钮位置）：交换会话的发起方也算。 */
  const userSide = $derived(exchangeShape?.side === 'issuer' || isUser);
  /** Sender's stored avatar (preset / upload), falling back to initials. */
  const senderBot = $derived(
    message.senderBotId === null
      ? null
      : (session.view?.members.find((m) => m.bot.id === message.senderBotId)?.bot ??
          contacts.bots.find((b) => b.id === message.senderBotId) ??
          null),
  );
  const name = $derived(
    isUser || message.senderBotId === null ? '' : chat.botName(message.senderBotId),
  );
  /** 交换会话气泡两侧的头像名（A 的行 isUser 已翻转，不能用 name）。 */
  const avatarName = $derived(
    message.senderBotId === null ? '' : chat.botName(message.senderBotId),
  );
  /** Quoted message preview (引用回复): resolved from the loaded window. */
  const quoted = $derived(
    message.replyTo !== null
      ? (session.view?.messages.find((m) => m.id === message.replyTo) ?? null)
      : null,
  );
  const quotedName = $derived(
    quoted === null
      ? ''
      : quoted.senderType === 'user'
        ? settingsStore.userDisplayName
        : quoted.senderBotId
          ? chat.botName(quoted.senderBotId)
          : '',
  );
  /** 引用块里的被引用附件（图片缩略图 / 文件 chip）：映射成 QuotedMedia 的轻量形状。 */
  const quotedAttachments = $derived(
    quoted === null
      ? []
      : quoted.attachments.map((a) => ({
          attachmentId: a.id,
          fileName: a.fileName,
          mime: a.mime,
          size: a.size,
        })),
  );

  let menuPos = $state<{ x: number; y: number } | null>(null);

  // hover / 右键共用的操作集合：引用对所有消息可用。
  const canAct = $derived(message.status !== 'recalled');
  /** 可复制的纯文本：仅文本消息（卡片、任务事件等结构化内容不提供复制）。 */
  const messageText = $derived('text' in message.content ? message.content.text : '');
  const hasText = $derived(messageText.length > 0);
  /** Bot file cards carried by this reply (files.preview is scoped by conversation). */
  const artifacts = $derived(
    message.senderType === 'bot' && 'artifacts' in message.content
      ? (message.content.artifacts ?? [])
      : [],
  );
  const canCopy = $derived(canAct && hasText);
  /** 整条钉为便签：便签是纯文本，只对有正文的消息提供（与复制同一门槛）。 */
  const canPin = $derived(canAct && hasText);
  /** 撤回（design/02 §撤回与编辑）：只挂在本会话记录最后一条用户消息上（转交消息除外）。 */
  const canRecall = $derived(
    canAct && isLast && message.senderType === 'user' && delegatedBy === null,
  );
  /**
   * 语音消息的原始录音附件由语音气泡自己播放（53 号修订 v3）：附件行不再重复
   * 渲染它（撤回的语音消息同样过滤——不再露出可播放的录音）；其它附件（异常
   * 数据）照常显示。Bot 语音消息没有附件。
   */
  const voiceAttachment = $derived(voiceRecordingOf(message));
  const shownAttachments = $derived(
    voiceAttachment === null
      ? message.attachments
      : message.attachments.filter((attachment) => attachment.id !== voiceAttachment.id),
  );

  /** 撤回最后一条用户消息：正文交回输入框，改写后可重发；失败 toast 不回填。 */
  async function recallMessage(): Promise<void> {
    const text = messageText;
    if (await chat.recall(message.id)) session.requestComposerInsert(text);
  }

  function quote(): void {
    session.startReply(message);
  }

  async function copyText(): Promise<void> {
    try {
      await navigator.clipboard.writeText(messageText);
    } catch {
      // 剪贴板写入会因权限 / 失焦被拒（NotAllowedError）：给出明确失败提示，
      // 不让它变成未处理的 promise rejection，也不能假装「已复制」。
      toast.error(t('messages.copyFailed'));
      return;
    }
    toast.success(t('messages.copied'));
  }

  /** 整条消息钉成便签（与选中文本钉便签同一入口，作用域在便签卡片上切换）。 */
  function pinMessage(): void {
    const conversationId = session.view?.conversation.id;
    if (conversationId === undefined) return;
    stickies.pin(messageText, conversationId, 'conversation');
  }

  function openMenu(event: MouseEvent): void {
    if (!canAct) return;
    event.preventDefault();
    menuPos = {
      x: Math.min(event.clientX, window.innerWidth - 170),
      y: Math.min(event.clientY, window.innerHeight - 130),
    };
  }
</script>

{#snippet menuRow(icon: LucideIcon, label: string, onclick: () => void, testid: string)}
  {@const Icon = icon as unknown as Component<{ class?: string }>}
  <button
    type="button"
    class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
    {onclick}
    data-testid={testid}
  >
    <Icon class="size-3.5" />
    {label}
  </button>
{/snippet}

<div
  class="group flex w-full gap-2 rounded-md py-0.5 {userSide
    ? 'flex-row-reverse'
    : 'flex-row'} {session.highlightMessageId === message.id
    ? 'bg-accent/60 ring-1 ring-accent transition-colors'
    : ''}"
  role="group"
  aria-label={exchangeShape !== null ? avatarName : isUser ? settingsStore.userDisplayName : name}
  data-testid={`message-${message.id}`}
  data-message-status={message.status}
  data-highlighted={session.highlightMessageId === message.id ? 'true' : 'false'}
  oncontextmenu={openMenu}
>
  {#if exchangeChat}
    <!-- v2.3 交换会话：双侧 Bot 头像（连排时只有第一条带，其余留占位对齐）。 -->
    {#if merge.above}
      <div class="mt-0.5 size-7 shrink-0" aria-hidden="true"></div>
    {:else}
      <BotAvatar
        botId={message.senderBotId ?? ''}
        name={avatarName}
        avatar={senderBot?.avatar ?? null}
        accentColor={senderBot?.accentColor ?? null}
        mask={senderBot?.avatarMask ?? null}
        padding={senderBot?.avatarPadding ?? null}
        class="mt-0.5 size-7 shrink-0"
        animated={false}
        testId="bot-avatar"
      />
    {/if}
  {:else if !isUser && isProjectChat}
    <BotAvatar
      botId={message.senderBotId ?? ''}
      {name}
      avatar={senderBot?.avatar ?? null}
      accentColor={senderBot?.accentColor ?? null}
      mask={senderBot?.avatarMask ?? null}
      padding={senderBot?.avatarPadding ?? null}
      class="mt-0.5 size-7 shrink-0"
      animated={false}
      testId="bot-avatar"
    />
  {/if}
  <!-- 气泡列宽：宽屏 78%；窄屏（33-narrow-layout）改 100% - 64px——左右各让约
       一个头像的宽度， hover 操作钮落在让出的留白里，不再挤压气泡。 -->
  <div
    class="flex min-w-0 flex-col {narrowLayout.narrow
      ? 'max-w-[calc(100%-32px)]'
      : 'max-w-[78%]'} {userSide ? 'items-end' : 'items-start'}"
  >
    {#if delegatedBy !== null}
      <span class="mb-0.5 text-[11px] text-muted-foreground" data-testid="delegation-origin">
        {t('delegation.proxiedBy', { name: delegatedBy ? chat.botName(delegatedBy) : '' })}
      </span>
    {/if}
    {#if taskOrigin !== null}
      <span
        class="mb-0.5 text-[11px] text-muted-foreground"
        data-testid="task-origin"
        data-task-id={taskOrigin.taskId}
      >
        {taskOrigin.forwarded
          ? t('task.originResult', { title: taskTitle })
          : t('task.originProgress', { title: taskTitle })}
      </span>
    {/if}
    {#if quoted !== null}
      <!-- 引用块：文本 + 被引用附件（图片缩略图可点开大图）。外层用 div——
           内嵌缩略图按钮，不能再是 button（按钮不可嵌套）。 -->
      <div
        class="mt-0.5 flex max-w-full items-center gap-1 rounded-md border-l-2 border-muted-foreground/40 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
        data-testid="quoted-line"
      >
        <span class="min-w-0 truncate">
          {quoted.status === 'recalled'
            ? t('messages.quotedDeleted')
            : t('messages.quotedLine', {
                name: quotedName,
                text: 'text' in quoted.content ? quoted.content.text.slice(0, 60) : '',
              })}
        </span>
        {#if quoted.status !== 'recalled' && quotedAttachments.length > 0}
          <QuotedMedia attachments={quotedAttachments} />
        {/if}
      </div>
    {/if}

    {#if shownAttachments.length > 0}
      <MessageAttachments attachments={shownAttachments} />
    {/if}

    <MessageBody {message} {merge} userStyle={exchangeShape?.side === 'issuer'} />

    {#if artifacts.length > 0}
      <FileArtifacts {artifacts} conversationId={message.conversationId} />
    {/if}

    {#if isShareImport}
      <span class="mt-0.5 text-[11px] text-muted-foreground" data-testid="share-source"
        >{t('share.imported')}</span
      >
    {/if}

    {#if scheduleTitle !== null}
      <button
        type="button"
        class="mt-0.5 inline-flex max-w-full items-start gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
        title={t('schedules.sourceHint')}
        onclick={() => shell.openSchedules()}
        data-testid="schedule-source"
      >
        <AlarmClock class="mt-0.5 size-3 shrink-0" aria-hidden="true" />{scheduleTitle}
      </button>
    {/if}

    {#if todoSource !== null}
      <!-- 窄屏暂无工作台入口（P1）：标签只读。 -->
      {#if narrowLayout.narrow}
        <span
          class="mt-0.5 inline-flex max-w-full items-start gap-1 text-left text-[11px] text-muted-foreground"
          data-testid="todo-source"
        >
          <ClipboardList class="mt-0.5 size-3 shrink-0" aria-hidden="true" />{todoSource.title}
        </span>
      {:else}
        <button
          type="button"
          class="mt-0.5 inline-flex max-w-full items-start gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
          title={t('workbench.todoSource.hint')}
          onclick={() => workbench.focusTodo(todoSource.id)}
          data-testid="todo-source"
        >
          <ClipboardList class="mt-0.5 size-3 shrink-0" aria-hidden="true" />{todoSource.title}
        </button>
      {/if}
    {/if}
  </div>

  {#if canAct && !narrowLayout.narrow}
    <!-- hover 操作：放在消息旁的留白区（参考 Grok），悬停展示 tooltip，右键菜单为同一组操作。
         常驻占位（invisible↔visible）而非 hidden↔flex：出现/消失会挤压气泡横移，
         鼠标停在窄元素（如小图缩略图）上时形成「悬停→位移→移出→收起」的布局
         死循环，渲染层被 relayout 打满（P17 观察到的冻结）。
         窄屏（33-narrow-layout）整组不渲染——按钮组占掉大量宽度，操作只留右键菜单。 -->
    <div
      class="invisible flex shrink-0 items-center gap-0.5 self-center {userSide
        ? 'mr-1'
        : 'ml-1'} group-focus-within:visible group-hover:visible"
      data-testid="message-actions"
    >
      {#if !exchangeChat}
        <!-- 交换会话没有输入组件（宿主写入、用户不可发言），引用内容无处
             落点——引用按钮隐藏（右键菜单同步）。 -->
        <Tooltip.Root>
          <Tooltip.Trigger
            class="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={quote}
            aria-label={t('messages.quote')}
            data-testid="message-quote"
          >
            <Reply class="size-3.5" aria-hidden="true" />
          </Tooltip.Trigger>
          <Tooltip.Content>{t('messages.quote')}</Tooltip.Content>
        </Tooltip.Root>
      {/if}
      {#if canCopy}
        <Tooltip.Root>
          <Tooltip.Trigger
            class="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={() => void copyText()}
            aria-label={t('messages.copy')}
            data-testid="message-copy"
          >
            <Copy class="size-3.5" aria-hidden="true" />
          </Tooltip.Trigger>
          <Tooltip.Content>{t('messages.copy')}</Tooltip.Content>
        </Tooltip.Root>
      {/if}
      {#if canPin}
        <Tooltip.Root>
          <Tooltip.Trigger
            class="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={pinMessage}
            aria-label={t('messages.pinMessage')}
            data-testid="message-pin"
          >
            <Pin class="size-3.5" aria-hidden="true" />
          </Tooltip.Trigger>
          <Tooltip.Content>{t('messages.pinMessage')}</Tooltip.Content>
        </Tooltip.Root>
      {/if}
      {#if canRecall}
        <Tooltip.Root>
          <Tooltip.Trigger
            class="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={() => void recallMessage()}
            aria-label={t('chats.recall')}
            data-testid="message-recall"
          >
            <Undo2 class="size-3.5" aria-hidden="true" />
          </Tooltip.Trigger>
          <Tooltip.Content>{t('chats.recall')}</Tooltip.Content>
        </Tooltip.Root>
      {/if}
    </div>
  {/if}
</div>

{#if menuPos}
  <!-- 消息条目右键菜单：引用 / 复制 / 固定整条 -->
  <button
    type="button"
    class="fixed inset-0 z-40 cursor-default"
    aria-label={t('common.close')}
    onclick={() => (menuPos = null)}
    oncontextmenu={(event) => {
      event.preventDefault();
      menuPos = null;
    }}
  ></button>
  <div
    class="fixed z-50 w-40 rounded-xl border bg-popover p-1 shadow-xl"
    style="left: {menuPos.x}px; top: {menuPos.y}px;"
    data-testid="message-context-menu"
  >
    {#if !exchangeChat}
      {@render menuRow(
        Reply,
        t('messages.quote'),
        () => {
          menuPos = null;
          quote();
        },
        'context-message-quote',
      )}
    {/if}
    {#if canCopy}
      {@render menuRow(
        Copy,
        t('messages.copy'),
        () => {
          menuPos = null;
          void copyText();
        },
        'context-message-copy',
      )}
    {/if}
    {#if canPin}
      {@render menuRow(
        Pin,
        t('messages.pinMessage'),
        () => {
          menuPos = null;
          pinMessage();
        },
        'context-message-pin',
      )}
    {/if}
  </div>
{/if}
