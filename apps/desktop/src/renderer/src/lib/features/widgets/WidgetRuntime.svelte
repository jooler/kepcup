<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { mode } from 'mode-watcher';
  import { toast } from 'svelte-sonner';
  import {
    MCP_APP_LINK_COOLDOWN_MS,
    WIDGET_REPLY_COOLDOWN_MS,
    widgetsUiOpenLinkOutputSchema,
    widgetsUiOpenOutputSchema,
    widgetsUiReplyOutputSchema,
    widgetsUiQueryOutputSchema,
    widgetsUiStorageOutputSchema,
    type WidgetCard,
    type WidgetsUiQueryCall,
    type WidgetsUiQueryOutput,
    type WidgetsUiStorageCall,
    type WidgetsUiStorageOutput,
  } from '@kepcup/shared';
  import { Button } from '$lib/components/ui/button';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import LinkConfirmBar from '$lib/features/apps-ui/LinkConfirmBar.svelte';
  import { WidgetBridgeHost } from './widget-bridge-host';
  import { WidgetResourceLease } from './resource-lease';
  import { widgetConsented } from './consent.svelte';

  /**
   * 组件运行时（覆盖层里的那个 iframe）：海报卡确认后由 WidgetViewer 挂载，start →
   * `widgets.ui.open` 登记内存资源（core 注入 SDK 垫片）→ WidgetBridgeHost 桥 → iframe。
   *
   * 能力桥（P1 / P2）：只信 `event.source === frameWindow` 的消息——`storage.*` 转发为
   * `widgets.ui.storage`，`query` 转发为 `widgets.ui.query`（随版本预审的只读模板），
   * `openLink` 先出确认条（拒绝后冷却），`setHeight` 在覆盖层形态被忽略（iframe 铺满），
   * `theme` 回建桥时的明暗主题。
   *
   * 资源续命：资源 TTL / LRU 淘汰后下一次桥调用得 `WIDGET_RESOURCE_EXPIRED`——自动重新
   * `widgets.ui.open` 换 resourceId 并重放调用（iframe 不重载）；重开也失败才转错误态。
   * 关闭覆盖层 = 组件停止（资源关闭，组件内状态不保留，与关掉一个网页一致）。
   */
  let { messageId, card }: { messageId: string; card: WidgetCard } = $props();

  type RuntimeState = 'loading' | 'ready' | 'error';
  let phase = $state<RuntimeState>('loading');
  let errorCode = $state<string | undefined>(undefined);
  let frame = $state<HTMLIFrameElement | undefined>(undefined);
  let pendingLink = $state<{ url: string; resolve: (ok: boolean) => void } | null>(null);
  /** 一条外链被取消后的冷却（防反复弹确认条）。 */
  let linkBlockedUntil = 0;
  let pendingReply = $state<{ text: string; resolve: (ok: boolean) => void } | null>(null);
  let replyBlockedUntil = 0;

  let bridge: WidgetBridgeHost | null = null;
  let generation = 0;
  /** 当前挂载的资源租约（过期自动重开并重放调用，见 resource-lease.ts）。 */
  let lease: WidgetResourceLease | null = null;

  function currentTheme(): 'light' | 'dark' {
    return mode.current === 'dark' ? 'dark' : 'light';
  }

  // D87 P3b：应用切换明暗时推给已挂载的组件（垫片更新 data-theme 并派发 kepcup:theme）。
  $effect(() => {
    const theme = currentTheme();
    bridge?.setTheme(theme);
  });

  async function start(): Promise<void> {
    const gen = ++generation;
    phase = 'loading';
    errorCode = undefined;
    // 防御：运行时只应在确认后挂载；未确认（记忆被清等）回到海报卡的审查态流程。
    if (!widgetConsented(card)) {
      errorCode = 'WIDGET_REVIEW_REQUIRED';
      phase = 'error';
      return;
    }
    try {
      // 垫片按 open 时的主题烘焙进 HTML：桥从同一个主题起步（期间切换会在 load 时重推）。
      const openedTheme = currentTheme();
      const out = widgetsUiOpenOutputSchema.parse(
        await core.call('widgets.ui.open', { messageId, theme: openedTheme }),
      );
      if (gen !== generation) {
        void core.call('widgets.ui.close', { resourceId: out.resourceId }).catch(() => undefined);
        return;
      }
      lease = new WidgetResourceLease({
        resourceId: out.resourceId,
        reopen: async () =>
          widgetsUiOpenOutputSchema.parse(await core.call('widgets.ui.open', { messageId, theme: currentTheme() })).resourceId,
        discard: (resourceId) => {
          void core.call('widgets.ui.close', { resourceId }).catch(() => undefined);
        },
        onRenewFailed: (error) => {
          // 重开也失败（组件已删除 / 版本已修剪等）：转错误态，不再假装可用。
          errorCode = (error as { code?: string }).code;
          phase = 'error';
          void stop();
        },
      });
      await tick();
      const frameWindow = frame?.contentWindow;
      if (frame === undefined || !frameWindow) throw new Error('frame unavailable');
      // Listen first, then load: the shim's first calls must find the bridge ready.
      bridge = WidgetBridgeHost.connect({
        frameWindow,
        resourceId: out.resourceId,
        theme: openedTheme,
        storage: (input) => callStorage(input),
        query: (input) => callQuery(input),
        openLink: (url) =>
          new Promise<boolean>((resolve) => {
            // One confirmation at a time; a second request while one is open is refused.
            if (pendingLink !== null || pendingReply !== null || Date.now() < linkBlockedUntil) {
              resolve(false);
              return;
            }
            pendingLink = { url, resolve };
          }),
        reply: (text) =>
          new Promise<boolean>((resolve) => {
            if (pendingLink !== null || pendingReply !== null || Date.now() < replyBlockedUntil) {
              resolve(false);
              return;
            }
            pendingReply = { text, resolve };
          }),
        // 覆盖层形态 iframe 铺满：组件的高度上报不参与布局。
        onHeight: () => {},
      });
      if (gen !== generation) {
        bridge.destroy();
        bridge = null;
        return;
      }
      const connected = bridge;
      frame.addEventListener(
        'load',
        () => {
          connected.setTheme(currentTheme(), { force: true });
        },
        { once: true },
      );
      frame.src = out.url;
      phase = 'ready';
    } catch (error) {
      if (gen !== generation) return;
      const code = (error as { code?: string }).code;
      // 失败路径也要释放已登记的资源与半建的桥（例如 frame 不可用时租约已建立）。
      void stop();
      if (code === 'WIDGET_REVIEW_REQUIRED') {
        errorCode = code;
        phase = 'error';
        return;
      }
      errorCode = code;
      phase = 'error';
    }
  }

  /** 经当前租约发一次桥调用（资源过期时租约自动重开并重放）。 */
  async function withResource<T>(call: (resourceId: string) => Promise<T>): Promise<T> {
    if (lease === null) throw new Error('组件界面已关闭');
    return lease.call(call);
  }

  /** `widgets.ui.storage` 的渲染端出站：schema.parse 后原样回给桥（契约纪律同其他 RPC）。 */
  async function callStorage(input: WidgetsUiStorageCall): Promise<WidgetsUiStorageOutput> {
    return withResource(async (resourceId) =>
      widgetsUiStorageOutputSchema.parse(
        await core.call('widgets.ui.storage', { ...input, resourceId }),
      ),
    );
  }

  /** `widgets.ui.query` 的渲染端出站（P2）：错误（code/message）由桥透传给组件。 */
  async function callQuery(input: WidgetsUiQueryCall): Promise<WidgetsUiQueryOutput> {
    return withResource(async (resourceId) =>
      widgetsUiQueryOutputSchema.parse(await core.call('widgets.ui.query', { ...input, resourceId })),
    );
  }

  async function stop(): Promise<void> {
    generation += 1;
    pendingLink?.resolve(false);
    pendingLink = null;
    pendingReply?.resolve(false);
    pendingReply = null;
    const connected = bridge;
    bridge = null;
    connected?.destroy();
    const resource = lease?.close() ?? null;
    lease = null;
    if (resource !== null) {
      await core.call('widgets.ui.close', { resourceId: resource }).catch(() => undefined);
    }
  }

  /** 覆盖层 header 的重载按钮；错误态的重试也走这里。 */
  export async function reload(): Promise<void> {
    await stop();
    await start();
  }

  async function confirmLink(): Promise<void> {
    const link = pendingLink;
    if (link === null || lease === null) return;
    pendingLink = null;
    try {
      const result = await withResource(async (resourceId) =>
        widgetsUiOpenLinkOutputSchema.parse(
          await core.call('widgets.ui.openLink', { resourceId, url: link.url }),
        ),
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

  async function confirmReply(): Promise<void> {
    const reply = pendingReply;
    if (reply === null || lease === null) return;
    pendingReply = null;
    replyBlockedUntil = Date.now() + WIDGET_REPLY_COOLDOWN_MS;
    try {
      const result = await withResource(async (resourceId) =>
        widgetsUiReplyOutputSchema.parse(
          await core.call('widgets.ui.reply', { resourceId, text: reply.text }),
        ),
      );
      reply.resolve(result.ok);
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('botWidget.replyFailed')));
      reply.resolve(false);
    }
  }

  function cancelReply(): void {
    pendingReply?.resolve(false);
    pendingReply = null;
    replyBlockedUntil = Date.now() + WIDGET_REPLY_COOLDOWN_MS;
  }

  onMount(() => {
    void start();
    return () => {
      void stop();
    };
  });
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="widget-runtime" data-state={phase}>
  {#if phase === 'error'}
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <p class="text-sm text-amber-700 dark:text-amber-400">
        {errorText(errorCode, t('botWidget.loadFailed'))}
      </p>
      <Button size="sm" variant="ghost" class="h-6 px-2 text-xs" onclick={() => void reload()}>
        {t('botWidget.retry')}
      </Button>
    </div>
  {:else if phase === 'loading'}
    <div class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
      {t('botWidget.loading')}
    </div>
  {/if}

  {#if phase === 'ready' || phase === 'loading'}
    <!--
      sandbox：完整 WebApp 档——脚本 + 同源（localStorage 等存储可用）+ 表单 + 对话框；
      仍无弹窗（window.open 被主进程 deny）、无顶层导航。源是独占的
      kepcup-app://widget-{hash}（与宿主不同源），allow-same-origin 不解锁宿主。
      allow="": 不授予摄像头 / 麦克风等浏览器权限。能力仍只能经 WidgetBridgeHost 进来。
    -->
    <iframe
      bind:this={frame}
      title={card.title}
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
      allow=""
      referrerpolicy="no-referrer"
      class="min-h-0 w-full flex-1 border-0 bg-white {phase === 'ready' ? '' : 'hidden'}"
      data-testid="widget-runtime-frame"
    ></iframe>
  {/if}

  {#if pendingLink !== null}
    <div class="shrink-0">
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
    </div>
  {/if}

  {#if pendingReply !== null}
    <div
      class="shrink-0 border-t bg-sky-500/5 px-3 py-2 text-xs"
      data-testid="bot-widget-reply-confirm"
      role="alertdialog"
      aria-label={t('botWidget.replyTitle')}
    >
      <p class="font-medium">{t('botWidget.replyTitle')}</p>
      <p
        class="mt-1 max-h-32 overflow-y-auto rounded border bg-background px-2 py-1 whitespace-pre-wrap break-words"
        data-testid="bot-widget-reply-text"
      >
        {pendingReply.text}
      </p>
      <div class="mt-2 flex justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          class="h-6 px-2 text-xs"
          onclick={cancelReply}
          data-testid="bot-widget-reply-cancel">{t('botWidget.replyCancel')}</Button
        >
        <Button
          size="sm"
          class="h-6 px-2 text-xs"
          onclick={() => void confirmReply()}
          data-testid="bot-widget-reply-send">{t('botWidget.replyConfirm')}</Button
        >
      </div>
    </div>
  {/if}
</div>
