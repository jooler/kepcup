<script lang="ts">
  import { Globe, Mic, MicOff, Square, X, RefreshCw, WifiOff, Maximize2, Minimize2 } from '@lucide/svelte';
  import { Portal } from 'bits-ui';
  import { t } from '$lib/i18n';
  import { getChatSession } from '$lib/features/chats/chat-session-context';
  import { sidebarLayout } from '$lib/features/sidebar/sidebar-layout.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { ESCAPE_PRIORITY, registerEscapeLayer } from '$lib/features/shell/escape-layers';
  import { widgetViewer } from './widget-viewer.svelte';
  import WidgetRuntime from './WidgetRuntime.svelte';

  /**
   * 组件覆盖层（海报卡点击后真正运行的地方）：占满中部 + 右栏（左栏保持可见），几何与
   * FileViewer 一致。每次打开挂一个新 WidgetRuntime（资源随打开登记、随关闭释放——与
   * 关掉一个网页一致，组件内状态不跨打开保留）；重载按钮整体重开。切会话时组件卡属于
   * 旧对话：直接关闭（同 FileViewer 的归属守卫）。
   *
   * 微应用（D112 §7.3）header 即 MicroAppChrome：常驻网络徽标（点击展开「它能访问
   * 什么」）、麦克风指示 / 会话授权开关、全屏键（inline ⇄ immersive ⇄ requestDisplayMode）、
   * 停止键（立即关采集与播放）。这层不占微应用 iframe 的 DOM，微应用无法覆盖或伪造。
   */
  const session = getChatSession();
  const current = $derived(widgetViewer.current);
  const card = $derived(current?.card ?? null);
  const isMicroApp = $derived(card?.microApp !== undefined && card.microApp !== null);

  let closeButton = $state<HTMLButtonElement | null>(null);
  let runtime: { reload(): Promise<void>; stopAudio?(): void } | null = $state(null);
  /** P1：会话级麦克风授权（每次打开重置为关；用户在外壳开启 = 本次运行会话授权）。 */
  let micGranted = $state(false);
  let netInfoOpen = $state(false);
  let displayMode = $state<'inline' | 'immersive'>('immersive');
  $effect(() => {
    if (card?.microApp !== undefined) displayMode = card.microApp.displayMode;
  });

  const left = $derived(narrowLayout.narrow ? '0px' : `${sidebarLayout.effectiveWidth}px`);
  // 窄屏时本浮层盖住整窗，mac 红绿灯叠在 header 左上角，关闭按钮要右移让位。
  const isMac = /Mac/i.test(navigator.platform);

  // 切会话时组件卡属于旧对话：直接关闭，避免把旧会话的组件继续展示在新会话上。
  $effect(() => {
    const conversationId = session.conversationId;
    if (widgetViewer.current !== null && widgetViewer.current.conversationId !== conversationId) {
      widgetViewer.close();
    }
  });

  // 每次打开重置微应用的会话态（麦克风授权不跨打开保留，55 §5.1）。
  $effect(() => {
    void current?.messageId;
    micGranted = false;
    netInfoOpen = false;
  });

  // 非模态覆盖层：打开时把焦点移到关闭按钮，关闭时还给原来的元素。
  // 依赖里带 messageId：开着的状态下切换卡片（show 另一个组件）也重新归位焦点，
  // 旧卡片卸载后焦点不至于丢到 body。
  $effect(() => {
    if (!widgetViewer.open) return;
    void current?.messageId;
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() => closeButton?.focus());
    return () => previous?.focus?.();
  });

  $effect(() => {
    if (!widgetViewer.open) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.lightbox,
      onEscape: () => widgetViewer.close(),
    });
  });

  function close(event?: MouseEvent): void {
    event?.stopPropagation();
    widgetViewer.close();
  }
</script>

{#if widgetViewer.open && current !== null && card !== null}
  <Portal>
    <div
      class="app-no-drag fixed inset-y-0 right-0 z-50 flex flex-col bg-background"
      style:left
      role="dialog"
      aria-label={card.title}
      data-testid="widget-viewer"
    >
      <!-- 顶部即工具栏高度：header 自身是拖拽区（本浮层不挂 data-window-overlay），
           空白处拖窗口；文本与按钮挂 app-no-drag。布局同 FileViewer 的 header。 -->
      <header
        class="app-drag relative flex h-14 shrink-0 items-center justify-center border-b bg-background px-20"
      >
        <button
          bind:this={closeButton}
          type="button"
          class="app-no-drag absolute top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-none transition-colors hover:text-foreground
            {narrowLayout.narrow && isMac ? 'left-20' : 'left-4'}"
          onclick={close}
          aria-label={t('botWidget.close')}
          title={t('botWidget.close')}
          data-testid="widget-viewer-close"
        >
          <X class="size-5" aria-hidden="true" />
        </button>
        <div class="app-no-drag min-w-0 px-24 text-center">
          <div class="truncate text-sm font-medium" data-testid="widget-viewer-title">
            {card.title}
          </div>
          <div class="truncate text-[11px] text-muted-foreground">
            {t('botWidget.byBot')}
            <span class="mx-1 opacity-50">·</span>
            v{card.version}
          </div>
        </div>
        <div class="app-no-drag absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {#if isMicroApp && card.microApp}
            <!-- 常驻网络徽标（55 §3.3 / §7.3）：微应用无法隐藏或伪造；点击展开访问范围。 -->
            <div class="relative">
              <button
                type="button"
                class="flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                onclick={() => (netInfoOpen = !netInfoOpen)}
                aria-label={t('botWidget.microApp.netBadge')}
                title={t('botWidget.microApp.netBadge')}
                data-testid="widget-viewer-net-badge"
              >
                {#if card.microApp.netMode === 'none'}
                  <WifiOff class="size-3" aria-hidden="true" />
                  {t('botWidget.microApp.netNone')}
                {:else}
                  <Globe class="size-3" aria-hidden="true" />
                  {t('botWidget.microApp.netBadgeOnline')}
                {/if}
              </button>
              {#if netInfoOpen}
                <div
                  class="absolute right-0 top-9 z-10 w-64 rounded-md border bg-background p-2 text-[11px] shadow-md"
                  data-testid="widget-viewer-net-info"
                >
                  {#if card.microApp.netMode === 'open'}
                    {t('botWidget.microApp.netInfoOpen')}
                  {:else if card.microApp.netMode === 'none'}
                    {t('botWidget.microApp.netInfoNone')}
                  {:else}
                    {t('botWidget.microApp.netInfoAllowlist', {
                      domains: card.microApp.netAllowlist.join('、'),
                    })}
                  {/if}
                </div>
              {/if}
            </div>
            <!-- 麦克风：每次运行会话授权；关 = 撤销（停采集 + capability.revoked）。 -->
            <button
              type="button"
              class="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-accent {micGranted
                ? 'text-red-500'
                : 'text-muted-foreground hover:text-foreground'}"
              onclick={() => (micGranted = !micGranted)}
              aria-label={micGranted ? t('botWidget.microApp.micOn') : t('botWidget.microApp.micOff')}
              title={micGranted ? t('botWidget.microApp.micOn') : t('botWidget.microApp.micOff')}
              aria-pressed={micGranted}
              data-testid="widget-viewer-mic"
            >
              {#if micGranted}
                <Mic class="size-4" aria-hidden="true" />
              {:else}
                <MicOff class="size-4" aria-hidden="true" />
              {/if}
            </button>
            <!-- 全屏键：inline ⇄ immersive（requestDisplayMode 同一落点）。 -->
            <button
              type="button"
              class="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onclick={() => (displayMode = displayMode === 'immersive' ? 'inline' : 'immersive')}
              aria-label={t('botWidget.microApp.displayMode')}
              title={t('botWidget.microApp.displayMode')}
              data-testid="widget-viewer-display-mode"
            >
              {#if displayMode === 'immersive'}
                <Minimize2 class="size-4" aria-hidden="true" />
              {:else}
                <Maximize2 class="size-4" aria-hidden="true" />
              {/if}
            </button>
            <!-- 停止键：立即关闭采集与播放（55 §7.3）。 -->
            <button
              type="button"
              class="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onclick={() => runtime?.stopAudio?.()}
              aria-label={t('botWidget.microApp.stop')}
              title={t('botWidget.microApp.stop')}
              data-testid="widget-viewer-stop"
            >
              <Square class="size-4" aria-hidden="true" />
            </button>
          {/if}
          <button
            type="button"
            class="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={() => void runtime?.reload()}
            aria-label={t('botWidget.reload')}
            title={t('botWidget.reload')}
            data-testid="widget-viewer-reload"
          >
            <RefreshCw class="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div class="relative min-h-0 flex-1 overflow-hidden">
        {#key current.messageId}
          <div
            class="flex h-full {isMicroApp && displayMode === 'inline'
              ? 'items-center justify-center'
              : ''}"
          >
            <div class="h-full {isMicroApp && displayMode === 'inline' ? 'w-[420px] max-w-full' : 'w-full'}">
              <WidgetRuntime
                bind:this={runtime}
                messageId={current.messageId}
                {card}
                {micGranted}
                onDisplayMode={(mode) => (displayMode = mode)}
              />
            </div>
          </div>
        {/key}
      </div>
    </div>
  </Portal>
{/if}
