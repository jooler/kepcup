<script lang="ts">
  import { RefreshCw, X } from '@lucide/svelte';
  import { ModeWatcher } from 'mode-watcher';
  import { widgetCardSchema, type WidgetCard } from '@kepcup/shared';
  import { Toaster } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import MicroAppControls from './MicroAppControls.svelte';
  import WidgetRuntime from './WidgetRuntime.svelte';

  /**
   * 组件窗口模式的整个页面（widget-window.md §4.4）：主进程用与主窗口同款的
   * preload / sandbox 加载渲染入口 + `?kcWindow=widget`，App.svelte 分支到这里，
   * 不进主壳。启动载荷（messageId + card）由主进程在 did-finish-load 后推送；
   * 端口 A 与 core 重启补发都由主进程统一处理（与主窗口同一套握手）。
   *
   * - 等待「载荷就绪 + core 连上」再挂 WidgetRuntime（过早挂只会拿到 not connected
   *   的错误态）；载荷按 widgetCardSchema 重验——主进程校验是第一道，这里是第二道。
   * - 麦克风授权是本窗口的会话态（每次打开重置为关，55 §5.1）；网络徽标 / 全屏键 /
   *   停止键与覆盖层共用 MicroAppControls（外壳提示面单一实现）。
   * - 关闭按钮 = window.close()；组件停止 = Runtime 卸载（资源关闭，不跨打开保留）。
   */
  let payload = $state<{ messageId: string; card: WidgetCard } | null>(null);
  let payloadMissing = $state(false);
  let micGranted = $state(false);
  let displayMode = $state<'inline' | 'immersive'>('immersive');
  let runtime: { reload(): Promise<void>; stopAudio?(): void } | null = $state(null);

  const card = $derived(payload?.card ?? null);
  const isMicroApp = $derived(card?.microApp !== undefined && card.microApp !== null);

  // 窗口模式不进主壳：core 连接与主题观察者由本组件自起（App.svelte 的那套
  // $effect 不在这里运行）。
  let started = false;
  $effect(() => {
    if (started) return;
    started = true;
    void core.start();
  });

  // 载荷只推一次（did-finish-load 后）；窗口模式页面挂载即监听，不会错过。
  $effect(() => {
    const off = window.kepcup.onWidgetWindowPayload((raw) => {
      const parsed = widgetCardSchema.safeParse(raw.card);
      if (typeof raw.messageId === 'string' && raw.messageId.length > 0 && parsed.success) {
        payload = { messageId: raw.messageId, card: parsed.data };
        displayMode = parsed.data.microApp?.displayMode ?? 'immersive';
      } else {
        payloadMissing = true;
      }
    });
    // 载荷若因极端时序先于监听到达（不会发生——主进程在 did-finish-load 后才推），
    // 这里没有兜底重取：窗口模式没有别的入口，缺载荷就是错误态。
    const timer = setTimeout(() => {
      if (payload === null) payloadMissing = true;
    }, 10_000);
    return () => {
      off();
      clearTimeout(timer);
    };
  });

  // 每次换卡重置会话态（55 §5.1：麦克风授权不跨打开保留）。
  $effect(() => {
    void payload?.messageId;
    micGranted = false;
  });

  const ready = $derived(payload !== null && core.connection === 'connected');
</script>

<div
  class="flex h-screen min-h-0 flex-col overflow-hidden bg-background"
  data-testid="widget-window"
>
  <ModeWatcher />
  <header class="flex h-14 shrink-0 items-center justify-between border-b bg-background px-4">
    <div class="min-w-0">
      <div class="truncate text-sm font-medium" data-testid="widget-window-title">
        {card?.title ?? t('botWidget.loading')}
      </div>
      {#if card}
        <div class="truncate text-[11px] text-muted-foreground">
          {t('botWidget.byBot')}
          <span class="mx-1 opacity-50">·</span>
          v{card.version}
        </div>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-1">
      {#if isMicroApp && card?.microApp}
        <MicroAppControls
          microApp={card.microApp}
          {micGranted}
          {displayMode}
          testidPrefix="widget-window"
          resetKey={payload?.messageId}
          onToggleMic={() => (micGranted = !micGranted)}
          onToggleDisplayMode={() => (displayMode = displayMode === 'immersive' ? 'inline' : 'immersive')}
          onStopAudio={() => runtime?.stopAudio?.()}
        />
      {/if}
      <button
        type="button"
        class="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onclick={() => void runtime?.reload()}
        aria-label={t('botWidget.reload')}
        title={t('botWidget.reload')}
        data-testid="widget-window-reload"
      >
        <RefreshCw class="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onclick={() => window.close()}
        aria-label={t('botWidget.close')}
        title={t('botWidget.close')}
        data-testid="widget-window-close"
      >
        <X class="size-5" aria-hidden="true" />
      </button>
    </div>
  </header>

  <div class="relative min-h-0 flex-1 overflow-hidden">
    {#if ready && payload !== null && card !== null}
      <div
        class="flex h-full {isMicroApp && displayMode === 'inline' ? 'items-center justify-center' : ''}"
      >
        <div class="h-full {isMicroApp && displayMode === 'inline' ? 'w-[420px] max-w-full' : 'w-full'}">
          <WidgetRuntime
            bind:this={runtime}
            messageId={payload.messageId}
            {card}
            {micGranted}
            onDisplayMode={(value) => (displayMode = value)}
          />
        </div>
      </div>
    {:else if payloadMissing}
      <div
        class="flex h-full items-center justify-center text-sm text-muted-foreground"
        data-testid="widget-window-error"
      >
        {t('botWidget.loadFailed')}
      </div>
    {:else}
      <div
        class="flex h-full items-center justify-center text-sm text-muted-foreground"
        data-testid="widget-window-loading"
      >
        {core.connection === 'failed' ? t('botWidget.loadFailed') : t('botWidget.loading')}
      </div>
    {/if}
  </div>
</div>

<Toaster position="bottom-right" />
