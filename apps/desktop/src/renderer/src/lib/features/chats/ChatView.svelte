<script lang="ts">
  import { ChevronRight, MessageSquare, Users, X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Avatar from '$lib/components/ui/avatar';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import MessageList from './MessageList.svelte';
  import Composer from './Composer.svelte';
  import SetupRequiredCard from './SetupRequiredCard.svelte';
  import MediaLightbox from './MediaLightbox.svelte';
  import ApprovalDock from '$lib/features/approvals/ApprovalDock.svelte';

  /**
   * 聊天区（参考 Grok Bot）：消息列表占满整个高度并在顶部药丸与底部输入坞
   * 之下滚动；输入坞绝对定位在底部，其高度经 bind:clientHeight 动态回填给
   * 消息列表的底部 padding（输入多行增高时消息区让位随之变化）。
   */
  const current = $derived(chat.current);
  const hasMessages = $derived((current?.messages.length ?? 0) > 0);
  const confirmMode = $derived(
    current !== null && permissions.sandbox !== null && !permissions.sandbox.available,
  );
  const isGroup = $derived(current?.conversation.type === 'group');
  // 对话内群创建进行中（19/D60）：输入禁用（project 选择器在右栏，由 GroupInfo
  // 在创建期隐藏），标题用占位名。
  const creating = $derived(current?.conversation.setupState === 'creating');
  // 访谈目录闸门（19/D59）：目录卡未答期间输入禁用——回答只能经卡片提交。
  const pathGateClosed = $derived.by(() => {
    const c = current;
    if (c === null || c.conversation.type !== 'direct') return false;
    if (c.conversation.bot?.setupState !== 'interviewing') return false;
    const card = [...c.messages]
      .reverse()
      .find(
        (m) =>
          m.kind === 'system_event' &&
          'event' in m.content &&
          m.content.event === 'bot_setup_path_question',
      );
    if (card === undefined) return false;
    return !c.messages.some((m) => m.seq > card.seq && m.senderType === 'user');
  });
  const composerHint = $derived(
    creating
      ? t('groupSetup.composerHint')
      : pathGateClosed
        ? t('chats.setupPathGateHint')
        : undefined,
  );
  const headerTitle = $derived(
    current === null
      ? ''
      : isGroup
        ? (current.conversation.title ?? t('groupSetup.creatingTitle'))
        : // 已删除 Bot 的占位行 name 为空串，回退其 id（设计/01：显示为 id）。
          current.conversation.bot?.name ||
          current.conversation.bot?.id ||
          current.conversation.directBotId ||
          t('rightPanel.title'),
  );
  const panelCollapsed = $derived(shell.rightPanelCollapsed);

  let composerDockHeight = $state(0);
</script>

{#if !current}
  <div class="app-drag flex h-full flex-1 items-center justify-center p-8" data-testid="chat-empty">
    <div class="text-center text-muted-foreground">
      <MessageSquare class="mx-auto mb-3 size-8 opacity-60" aria-hidden="true" />
      <p class="text-sm">{t('chats.empty')}</p>
    </div>
  </div>
{:else}
  <!-- h-full：Pane 是块级盒子，聊天区以绝对定位布局，必须显式取满高度 -->
  <div
    class="relative h-full min-h-0 min-w-0 flex-1"
    data-testid="chat-view"
    data-readonly={current.conversation.readOnly}
  >
    <!-- 顶部 Bot 药丸：点击切换右栏；收起时右侧「>」提示可展开 -->
    <header
      class="app-drag absolute inset-x-0 top-0 z-30 flex h-16 items-center justify-center bg-gradient-to-b from-background to-background/0"
    >
      <Button
        variant="outline"
        class="app-no-drag h-10 cursor-pointer gap-1.5 rounded-full border-border/25 bg-background py-0 pr-2.5 pl-1.5 text-sm font-medium shadow-xl backdrop-blur dark:border-input/25 dark:bg-background"
        onclick={() => shell.toggleRightPanel()}
        title={panelCollapsed ? t('chatHeader.expandPanel') : t('chatHeader.collapsePanel')}
        data-testid="right-panel-toggle"
      >
        {#if isGroup}
          <Avatar.Root class="size-5">
            <Avatar.Fallback class="text-[10px]">
              <Users class="size-3" aria-hidden="true" />
            </Avatar.Fallback>
          </Avatar.Root>
        {:else}
          <BotAvatar
            botId={current.conversation.directBotId ?? ''}
            name={headerTitle}
            avatar={current.conversation.bot?.avatar ?? null}
            class="size-7"
            fallbackClass="text-[10px]"
          />
        {/if}
        <span class="max-w-48 truncate pr-1.5">{headerTitle}</span>
        {#if panelCollapsed}
          <!-- 展开提示只在 hover 时浮现（参考 Grok），展开态不再显示箭头。
               外层宽度 0 → 内容宽（6px 间距 + 14px 图标）撑开按钮，-ml-1.5 抵消按钮自身的
               gap-1.5，未 hover 时按钮宽度与没有提示时完全一致 -->
          <span
            class="-ml-1.5 flex w-0 overflow-hidden transition-[width] duration-200 ease-out group-hover/button:w-5"
          >
            <ChevronRight
              class="ml-1.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/button:opacity-100"
              aria-hidden="true"
              data-testid="panel-expand-hint"
            />
          </span>
        {/if}
      </Button>
    </header>

    <!-- 浮动提示条（只读 / 确认模式 / 执行失败） -->
    {#if current.conversation.readOnly || confirmMode || current.failedRun}
      <div
        class="pointer-events-none absolute inset-x-0 top-14 z-30 flex flex-col items-center gap-1.5 px-4"
      >
        {#if current.conversation.readOnly}
          <div
            class="pointer-events-auto rounded-full border bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur"
            data-testid="readonly-banner"
          >
            {t('composer.readOnly')}
          </div>
        {/if}
        {#if confirmMode}
          <div
            class="pointer-events-auto rounded-full border border-amber-500/40 bg-background/95 px-3 py-1 text-xs text-amber-700 shadow-sm backdrop-blur dark:text-amber-400"
            data-testid="confirm-mode-banner"
          >
            {t('chats.confirmModeBanner', { reason: permissions.sandbox?.reason ?? '' })}
          </div>
        {/if}
        {#if current.failedRun && !current.failedRun.setup}
          <!-- 缺设置的失败（run.setup）由消息列表内的设置卡片接管（18-inline-setup），
               此处只展示普通失败。 -->
          <div
            class="pointer-events-auto flex items-center gap-2 rounded-full border border-destructive/30 bg-background/95 py-1 pr-1.5 pl-3 text-xs text-destructive shadow-sm backdrop-blur"
            data-testid="run-failed-banner"
          >
            <span class="max-w-md min-w-0 truncate">
              {t('chats.runFailed', { reason: current.failedRun.error ?? '' })}
            </span>
            <Button
              variant="outline"
              size="sm"
              class="h-6 rounded-full px-2"
              onclick={() => void chat.retryRun(current.failedRun!.id)}
              data-testid="run-retry"
            >
              {t('chats.retry')}
            </Button>
            <!-- 关闭只是收起横幅（会话内不再回弹）；run 本身仍可从失败记录重试。 -->
            <Button
              variant="ghost"
              size="sm"
              class="h-6 w-6 rounded-full p-0 text-destructive hover:text-destructive"
              aria-label={t('common.close')}
              title={t('common.close')}
              onclick={() => chat.dismissFailedRun(current.failedRun!.id)}
              data-testid="run-failed-dismiss"
            >
              <X class="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        {/if}
      </div>
    {/if}

    {#if hasMessages}
      <MessageList bottomInset={composerDockHeight} />
    {/if}

    <!--
      底部输入坞：有消息时绝对定位在底部（消息列表按其高度让位）；
      无消息时垂直居中（docs/design/12-ui-layout.md 焦点一）。
    -->
    <div
      class="absolute z-30 {hasMessages
        ? 'inset-x-0 bottom-0'
        : 'top-1/2 right-0 left-0 -translate-y-1/2 px-4'}"
      bind:clientHeight={composerDockHeight}
      data-testid="composer-dock"
      data-centered={hasMessages ? 'false' : 'true'}
    >
      <!--
        底部遮罩（仅消息模式）：上段渐变（背景色→透明）占 1/3、下段实色背景
        占 2/3，纵向拼满坞体高度，滚入坞后的消息先在渐变段淡出、再被实色段
        完全盖住。-z-10 垫在坞内交互内容之下（坞 z-30 自成层，仍整体盖住
        消息列表），pointer-events-none 不拦截任何操作。
      -->
      {#if hasMessages}
        <div
          class="pointer-events-none absolute inset-x-0 top-0 -z-10 h-1/3 bg-gradient-to-t from-background to-background/0"
          aria-hidden="true"
        ></div>
        <div
          class="pointer-events-none absolute inset-x-0 top-1/3 bottom-0 -z-10 bg-background"
          aria-hidden="true"
        ></div>
      {/if}
      <ApprovalDock conversationId={current.conversation.id} />
      {#if chat.setupRequirement}
        <!--
          缺设置引导卡（docs/design/18-inline-setup.md）：发送门禁置起或最近
          失败 run 携带结构化 setup 时出现在输入坞上方——对话的注意力位置；
          无消息（门禁）与有消息（失败改判）两种场景都可见。完成设置后原
          对话自动继续。
        -->
        <div class="pb-2" data-testid="setup-required-wrap">
          <SetupRequiredCard requirement={chat.setupRequirement} />
        </div>
      {/if}
      <Composer
        readOnly={current.conversation.readOnly || creating || pathGateClosed}
        readOnlyHint={composerHint}
        centered={!hasMessages}
      />
    </div>
    <!-- 媒体灯箱（docs/design/20-conversation-media.md）：消息附件图片/音视频的放大预览。
         组件内部 portal 到 body 末尾 + no-drag，否则顶部 drag 区矩形会盖住顶栏按钮 -->
    <MediaLightbox />
  </div>
{/if}
