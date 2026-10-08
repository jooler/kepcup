<script lang="ts">
  import type { Component } from 'svelte';
  import type { Message } from '@kepcup/shared';
  import { Pencil, Reply, type LucideIcon } from '@lucide/svelte';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { tasks } from '$lib/stores/tasks.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import MessageBody from './MessageBody.svelte';
  import MessageAttachments from './MessageAttachments.svelte';

  /**
   * 普通对话消息行（用户 / Bot 文本消息）：负责布局与交互——用户消息反向
   * 排列、群聊头像列、引用行、已编辑标记、hover 操作（引用/编辑）与右键
   * 菜单、证据跳转高亮。气泡内容与附件分别委托 MessageBody /
   * MessageAttachments：后续多模态支持（图片、音频、视频等）只扩展那两
   * 层，本行的布局与操作保持稳定。merge 为连排信息，透传给 MessageBody
   * 决定对齐侧圆角。
   */
  let {
    message,
    editing = false,
    merge = { above: false, below: false },
  }: { message: Message; editing?: boolean; merge?: { above: boolean; below: boolean } } = $props();

  const isUser = $derived(message.senderType === 'user');
  /** D71：另一个 Bot 代用户转交的消息（B 的私聊）——标注来源，不可编辑。 */
  const delegatedBy = $derived(
    isUser && 'origin' in message.content && message.content.origin === 'delegation'
      ? (message.content.delegatedBy ?? '')
      : null,
  );
  /**
   * D75 §6.1：任务发出的可见消息（origin = 'task'）——任务执行中的进度
   * （run_id = 任务）或对话轮原文转发的任务结果（forward_task_result）——
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
  // 头像只在群聊出现：单聊双方都是纯气泡（UI 改版）；群聊里头像即发送者身份
  // （不再渲染名字/时间行）。
  const isGroupChat = $derived(chat.current?.conversation.type === 'group');
  /** Sender's stored avatar (preset / upload), falling back to initials. */
  const senderBot = $derived(
    message.senderBotId === null
      ? null
      : (chat.current?.members.find((m) => m.bot.id === message.senderBotId)?.bot ??
          contacts.bots.find((b) => b.id === message.senderBotId) ??
          null),
  );
  const name = $derived(
    isUser || message.senderBotId === null ? '' : chat.botName(message.senderBotId),
  );
  /** Quoted message preview (引用回复): resolved from the loaded window. */
  const quoted = $derived(
    message.replyTo !== null
      ? (chat.current?.messages.find((m) => m.id === message.replyTo) ?? null)
      : null,
  );
  const quotedName = $derived(
    quoted === null
      ? ''
      : quoted.senderType === 'user'
        ? t('sidebar.userName')
        : quoted.senderBotId
          ? chat.botName(quoted.senderBotId)
          : '',
  );

  let editText = $state('');
  let isEditing = $state(false);
  let menuPos = $state<{ x: number; y: number } | null>(null);

  // hover / 右键共用的操作集合：引用对所有消息可用。
  const canAct = $derived(message.status !== 'recalled' && !isEditing);

  function startEdit(): void {
    editText = 'text' in message.content ? message.content.text : '';
    isEditing = true;
  }

  async function saveEdit(): Promise<void> {
    if (editText.trim().length === 0) return;
    await chat.edit(message.id, editText);
    isEditing = false;
  }

  function quote(): void {
    chat.startReply(message);
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
  class="group flex w-full gap-2 rounded-md py-1 {isUser
    ? 'flex-row-reverse'
    : 'flex-row'} {chat.highlightMessageId === message.id
    ? 'bg-accent/60 ring-1 ring-accent transition-colors'
    : ''}"
  role="group"
  aria-label={isUser ? t('sidebar.userName') : name}
  data-testid={`message-${message.id}`}
  data-message-status={message.status}
  data-highlighted={chat.highlightMessageId === message.id ? 'true' : 'false'}
  oncontextmenu={openMenu}
>
  {#if !isUser && isGroupChat}
    <BotAvatar
      botId={message.senderBotId ?? ''}
      {name}
      avatar={senderBot?.avatar ?? null}
      class="mt-0.5 size-7 shrink-0"
      animated={false}
      testId="bot-avatar"
    />
  {/if}
  <div class="flex max-w-[78%] min-w-0 flex-col {isUser ? 'items-end' : 'items-start'}">
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
      <button
        type="button"
        class="mt-0.5 max-w-full truncate rounded-md border-l-2 border-muted-foreground/40 bg-muted/40 px-2 py-0.5 text-left text-[11px] text-muted-foreground"
        data-testid="quoted-line"
      >
        {quoted.status === 'recalled'
          ? t('messages.quotedDeleted')
          : t('messages.quotedLine', {
              name: quotedName,
              text: 'text' in quoted.content ? quoted.content.text.slice(0, 60) : '',
            })}
      </button>
    {/if}

    <MessageBody {message} {merge} bind:isEditing bind:editText onsave={() => void saveEdit()} />

    {#if message.status === 'edited' && !isEditing}
      <span class="mt-0.5 text-[11px] text-muted-foreground" data-testid="message-edited"
        >{t('chats.edited')}</span
      >
    {/if}

    {#if message.attachments.length > 0}
      <MessageAttachments attachments={message.attachments} />
    {/if}
  </div>

  {#if canAct}
    <!-- hover 操作：放在消息旁的留白区（参考 Grok），悬停展示 tooltip，右键菜单为同一组操作。
         常驻占位（invisible↔visible）而非 hidden↔flex：出现/消失会挤压气泡横移，
         鼠标停在窄元素（如小图缩略图）上时形成「悬停→位移→移出→收起」的布局
         死循环，渲染层被 relayout 打满（P17 观察到的冻结）。 -->
    <div
      class="invisible flex shrink-0 items-center gap-0.5 self-center {isUser
        ? 'mr-1'
        : 'ml-1'} group-focus-within:visible group-hover:visible"
      data-testid="message-actions"
    >
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
      {#if isUser && editing && delegatedBy === null}
        <Tooltip.Root>
          <Tooltip.Trigger
            class="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={startEdit}
            aria-label={t('chats.edit')}
            data-testid="message-edit"
          >
            <Pencil class="size-3.5" aria-hidden="true" />
          </Tooltip.Trigger>
          <Tooltip.Content>{t('chats.edit')}</Tooltip.Content>
        </Tooltip.Root>
      {/if}
    </div>
  {/if}
</div>

{#if menuPos}
  <!-- 消息条目右键菜单：引用 -->
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
    {@render menuRow(
      Reply,
      t('messages.quote'),
      () => {
        menuPos = null;
        quote();
      },
      'context-message-quote',
    )}
  </div>
{/if}
