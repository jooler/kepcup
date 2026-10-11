<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Blocks, Code2, RefreshCw, ShieldCheck } from '@lucide/svelte';
  import { mode } from 'mode-watcher';
  import {
    BOT_WIDGET_CONSENT_STORAGE_KEY,
    BOT_WIDGET_CONSENTS_MAX,
    BOT_WIDGET_HEIGHT_MAX,
    BOT_WIDGET_HEIGHT_MIN,
    MCP_APP_LINK_COOLDOWN_MS,
    widgetsUiOpenLinkOutputSchema,
    widgetsUiOpenOutputSchema,
    widgetsUiSourceOutputSchema,
    widgetsUiStorageOutputSchema,
    type WidgetCard,
    type WidgetsUiOpenOutput,
    type WidgetsUiStorageCall,
    type WidgetsUiStorageOutput,
  } from '@kepcup/shared';
  import { Button } from '$lib/components/ui/button';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import LinkConfirmBar from '$lib/features/apps-ui/LinkConfirmBar.svelte';
  import { WidgetBridgeHost } from './widget-bridge-host';

  /**
   * 对话里的 Bot 自制交互组件卡片（D81，docs/design/32-bot-widgets.md）。
   *
   * 审查态先行：Bot 生成的 HTML 是最低信任内容——初始不挂 iframe，展示版本与能力
   * （禁网 / 本机 KV 存储），用户「查看源码」或「加载运行」。按 sha256 记忆确认（同版本
   * 只确认一次，localStorage），新版本视为新代码。加载后 `widgets.ui.open` 登记
   * 内存资源（core 在 HTML 前置 SDK 垫片），iframe `sandbox="allow-scripts"`
   * （opaque origin，无 preload）指向 `kepcup-app://widget-{hash}/{id}`。
   *
   * 能力桥（P1）：`WidgetBridgeHost` 在挂 iframe 前监听，只信
   * `event.source === frameWindow` 的消息——`storage.*` 转发为 `widgets.ui.storage`，
   * `openLink` 先出卡内确认条（拒绝后冷却，同 McpAppCard），`setHeight` 夹取后调高度，
   * `theme` 回建桥时的明暗主题。
   */
  let { messageId, card }: { messageId: string; card: WidgetCard } = $props();

  type CardState = 'review' | 'loading' | 'ready' | 'error';
  let cardState = $state<CardState>('review');
  let errorCode = $state<string | undefined>(undefined);
  let opened = $state<WidgetsUiOpenOutput | null>(null);
  let frame = $state<HTMLIFrameElement | undefined>(undefined);
  let sourceOpen = $state(false);
  let sourceHtml = $state<string | null>(null);
  let sourceError = $state(false);
  let sourceLoading = $state(false);
  /** 未上报前的缺省高度；组件可用 `kepcup.setHeight` 自适应（夹到 [100, 800]）。 */
  let height = $state(380);
  /** 查看源码的展示上限：本地库损坏时 html 可能远超 2MB 上限，整段渲染会卡死界面。 */
  const SOURCE_DISPLAY_MAX_CHARS = 20_000;
  let pendingLink = $state<{ url: string; resolve: (ok: boolean) => void } | null>(null);
  /** 一条外链被取消后的冷却（防反复弹确认条），与 McpAppCard 同值。 */
  let linkBlockedUntil = 0;

  let bridge: WidgetBridgeHost | null = null;
  let generation = 0;
  let activeResource: string | null = null;

  async function start(): Promise<void> {
    const gen = ++generation;
    cardState = 'loading';
    errorCode = undefined;
    try {
      const out = widgetsUiOpenOutputSchema.parse(await core.call('widgets.ui.open', { messageId }));
      if (gen !== generation) {
        void core.call('widgets.ui.close', { resourceId: out.resourceId }).catch(() => undefined);
        return;
      }
      // 确认在资源登记成功后记忆：open 失败不留下次自动重试失败请求的确认。
      rememberConsent(card.sha256);
      activeResource = out.resourceId;
      opened = out;
      await tick();
      const frameWindow = frame?.contentWindow;
      if (frame === undefined || !frameWindow) throw new Error('frame unavailable');
      // Listen first, then load: the shim's first calls must find the bridge ready.
      bridge = WidgetBridgeHost.connect({
        frameWindow,
        resourceId: out.resourceId,
        theme: mode.current === 'dark' ? 'dark' : 'light',
        storage: (input) => callStorage(input),
        openLink: (url) =>
          new Promise<boolean>((resolve) => {
            // One confirmation at a time; a second request while one is open is refused.
            if (pendingLink !== null || Date.now() < linkBlockedUntil) {
              resolve(false);
              return;
            }
            pendingLink = { url, resolve };
          }),
        onHeight: (value) => {
          height = value;
        },
      });
      if (gen !== generation) {
        bridge.destroy();
        bridge = null;
        return;
      }
      frame.src = out.url;
      cardState = 'ready';
    } catch (error) {
      if (gen !== generation) return;
      errorCode = (error as { code?: string }).code;
      cardState = 'error';
    }
  }

  /** `widgets.ui.storage` 的渲染端出站：schema.parse 后原样回给桥（契约纪律同其他 RPC）。 */
  async function callStorage(input: WidgetsUiStorageCall): Promise<WidgetsUiStorageOutput> {
    if (activeResource === null) throw new Error('组件界面已关闭');
    return widgetsUiStorageOutputSchema.parse(
      await core.call('widgets.ui.storage', { ...input, resourceId: activeResource }),
    );
  }

  async function stop(): Promise<void> {
    generation += 1;
    pendingLink?.resolve(false);
    pendingLink = null;
    const connected = bridge;
    bridge = null;
    connected?.destroy();
    const resource = activeResource;
    activeResource = null;
    opened = null;
    height = 380;
    if (resource !== null) {
      await core.call('widgets.ui.close', { resourceId: resource }).catch(() => undefined);
    }
  }

  async function reload(): Promise<void> {
    await stop();
    await start();
  }

  async function toggleSource(): Promise<void> {
    sourceOpen = !sourceOpen;
    if (sourceOpen && sourceHtml === null && !sourceError) {
      sourceLoading = true;
      try {
        const out = widgetsUiSourceOutputSchema.parse(
          await core.call('widgets.ui.source', { messageId }),
        );
        sourceHtml = out.html;
      } catch {
        // 失败不缓存错误文案：收起再展开即重试。
        sourceError = true;
      } finally {
        sourceLoading = false;
      }
    }
  }

  async function confirmLink(): Promise<void> {
    const link = pendingLink;
    const resource = activeResource;
    if (link === null || resource === null) return;
    pendingLink = null;
    try {
      const result = widgetsUiOpenLinkOutputSchema.parse(
        await core.call('widgets.ui.openLink', { resourceId: resource, url: link.url }),
      );
      link.resolve(result.ok);
    } catch {
      link.resolve(false);
    }
  }

  function cancelLink(): void {
    pendingLink?.resolve(false);
    pendingLink = null;
    linkBlockedUntil = Date.now() + MCP_APP_LINK_COOLDOWN_MS;
  }

  onMount(() => {
    // 卡片内容随消息固定（widget/version/sha 不变）：按版本记忆的确认直接自动加载。
    if (consented(card.sha256)) void start();
    return () => {
      void stop();
    };
  });

  function consents(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(BOT_WIDGET_CONSENT_STORAGE_KEY);
      const parsed = raw === null ? {} : (JSON.parse(raw) as Record<string, boolean>);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function consented(sha256: string): boolean {
    return consents()[sha256] === true;
  }

  function rememberConsent(sha256: string): void {
    try {
      const all = consents();
      all[sha256] = true;
      const keys = Object.keys(all);
      // 有界：超限丢最旧的确认（重新确认一次即可，安全侧无害）。
      while (keys.length > BOT_WIDGET_CONSENTS_MAX) {
        delete all[keys.shift() ?? ''];
      }
      localStorage.setItem(BOT_WIDGET_CONSENT_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // 隐私模式等存储不可用：仅本次会话内免确认，不影响功能。
    }
  }
</script>

<div
  class="w-full max-w-[85%] overflow-hidden rounded-lg border bg-background/80 text-sm"
  data-testid="bot-widget-card"
  data-state={cardState}
  data-version={card.version}
>
  <div class="flex items-center gap-2 px-3 py-2">
    <Blocks class="size-4 shrink-0 text-violet-600" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="truncate font-medium" data-testid="bot-widget-title">{card.title}</p>
      <p class="truncate text-xs text-muted-foreground">
        {#if card.description !== ''}
          {card.description} ·
        {/if}
        {t('botWidget.byBot')} · v{card.version}
      </p>
    </div>
    {#if cardState === 'ready'}
      <Button
        size="sm"
        variant="ghost"
        class="h-6 px-2 text-xs"
        onclick={() => void reload()}
        data-testid="bot-widget-reload"
        aria-label={t('botWidget.reload')}
      >
        <RefreshCw class="size-3" aria-hidden="true" />
      </Button>
    {/if}
  </div>

  {#if cardState === 'review'}
    <div class="border-t px-3 py-2" data-testid="bot-widget-review">
      <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {t('botWidget.reviewNote')}
      </p>
      <div class="mt-2 flex gap-1">
        <Button
          size="sm"
          variant="ghost"
          class="h-6 px-2 text-xs"
          onclick={() => void toggleSource()}
          data-testid="bot-widget-source-toggle"
        >
          <Code2 class="size-3" aria-hidden="true" />
          {sourceOpen ? t('botWidget.sourceHide') : t('botWidget.sourceShow')}
        </Button>
        <Button
          size="sm"
          class="h-6 px-2 text-xs"
          onclick={() => void start()}
          data-testid="bot-widget-load"
        >
          {t('botWidget.load')}
        </Button>
      </div>
      {#if sourceOpen}
        <pre
          class="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px] leading-relaxed"
          data-testid="bot-widget-source"
          >{sourceLoading
            ? t('botWidget.sourceLoading')
            : sourceError
              ? t('botWidget.sourceUnavailable')
              : sourceHtml !== null && sourceHtml.length > SOURCE_DISPLAY_MAX_CHARS
                ? `${sourceHtml.slice(0, SOURCE_DISPLAY_MAX_CHARS)}\n… ${t('botWidget.sourceTruncated')}`
                : (sourceHtml ?? t('botWidget.sourceLoading'))}</pre
        >
      {/if}
    </div>
  {:else if cardState === 'error'}
    <div class="px-3 pb-3" data-testid="bot-widget-error">
      <p class="text-xs text-amber-700 dark:text-amber-400">
        {errorText(errorCode, t('botWidget.loadFailed'))}
      </p>
      <Button
        size="sm"
        variant="ghost"
        class="mt-1 h-6 px-2 text-xs"
        onclick={() => void reload()}
        data-testid="bot-widget-retry"
      >
        {t('botWidget.retry')}
      </Button>
    </div>
  {:else if cardState === 'loading'}
    <p class="px-3 pb-3 text-xs text-muted-foreground" data-testid="bot-widget-loading">
      {t('botWidget.loading')}
    </p>
  {/if}

  {#if opened !== null}
    <!--
      sandbox: scripts only — no allow-same-origin (opaque origin), no popups,
      no top-navigation, no forms. allow="": no camera / microphone / etc.
      Capabilities reach the widget only through the WidgetBridgeHost listener.
    -->
    <iframe
      bind:this={frame}
      title={card.title}
      sandbox="allow-scripts"
      allow=""
      referrerpolicy="no-referrer"
      class="block w-full border-0 border-t bg-transparent {cardState === 'ready' ? '' : 'hidden'}"
      style="height: {Math.min(Math.max(height, BOT_WIDGET_HEIGHT_MIN), BOT_WIDGET_HEIGHT_MAX)}px; color-scheme: normal;"
      data-testid="bot-widget-frame"
    ></iframe>
  {/if}

  {#if pendingLink !== null}
    <LinkConfirmBar
      url={pendingLink.url}
      title={t('botWidget.openLinkTitle')}
      hostLabel={t('botWidget.openLinkHost')}
      confirmLabel={t('botWidget.openLinkConfirm')}
      cancelLabel={t('botWidget.openLinkCancel')}
      testidPrefix="bot-widget"
      onconfirm={() => void confirmLink()}
      oncancel={cancelLink}
    />
  {/if}

  {#if cardState === 'ready'}
    <p class="border-t px-3 py-1 text-[11px] text-muted-foreground" data-testid="bot-widget-footer">
      {t('botWidget.capabilities')}
    </p>
  {/if}
</div>
