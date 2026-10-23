<script lang="ts">
  import { X, RefreshCw } from '@lucide/svelte';
  import { Portal } from 'bits-ui';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
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
   */
  const current = $derived(widgetViewer.current);
  const card = $derived(current?.card ?? null);

  let closeButton = $state<HTMLButtonElement | null>(null);
  let runtime: { reload(): Promise<void> } | null = $state(null);

  const left = $derived(narrowLayout.narrow ? '0px' : `${sidebarLayout.effectiveWidth}px`);
  // 窄屏时本浮层盖住整窗，mac 红绿灯叠在 header 左上角，关闭按钮要右移让位。
  const isMac = /Mac/i.test(navigator.platform);

  // 切会话时组件卡属于旧对话：直接关闭，避免把旧会话的组件继续展示在新会话上。
  $effect(() => {
    const conversationId = chat.currentId;
    if (widgetViewer.current !== null && widgetViewer.current.conversationId !== conversationId) {
      widgetViewer.close();
    }
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
          <WidgetRuntime bind:this={runtime} messageId={current.messageId} card={card} />
        {/key}
      </div>
    </div>
  </Portal>
{/if}
