<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { AppWindow, RefreshCw } from '@lucide/svelte';
  import { mode } from 'mode-watcher';
  import {
    appsUiCallToolOutputSchema,
    appsUiOpenLinkOutputSchema,
    appsUiOpenOutputSchema,
    type AppUiCard,
    type AppsUiOpenOutput,
  } from '@kepcup/shared';
  import { Button } from '$lib/components/ui/button';
  import { errorText, i18n, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { AppBridgeHost } from './app-bridge-host';
  import { clampAppHeight } from './bridge-guard';
  import LinkConfirmBar from './LinkConfirmBar.svelte';
  import { MCP_APP_LINK_COOLDOWN_MS } from '@kepcup/shared';

  /**
   * 对话里的 MCP App 界面卡片（D73 P3 §7.5，设计 29 §11.6）。
   *
   * 挂载时 `apps.ui.open`（core 经所属 MCP 连接 `resources/read` 取 HTML 并登记）→ 渲染
   * `sandbox="allow-scripts"` 的 iframe（opaque origin，无 allow-same-origin / popups / top-navigation / forms，
   * `allow=""` 不授予任何浏览器权限，无 preload）指向 `kepcup-app://…`，主进程协议处理器带逐应用 CSP 响应头
   * 服务页面。宿主桥（`AppBridgeHost`，官方 ext-apps `AppBridge`）只接收来自这个 iframe 窗口的消息：
   * 界面发起的 `tools/call` 回到 core 的网关（同一审批 / 风险策略，审批卡出现在输入区上方的 dock）；
   * `ui/open-link` 先在卡片里征得用户确认再经 core → 主进程 `shell.openExternal`（仅 https）；
   * `ui/message` / `ui/update-model-context` 本期不支持。
   */
  let { messageId, card }: { messageId: string; card: AppUiCard } = $props();

  type CardState = 'loading' | 'ready' | 'error';
  let cardState = $state<CardState>('loading');
  let errorCode = $state<string | undefined>(undefined);
  let opened = $state<AppsUiOpenOutput | null>(null);
  let frame = $state<HTMLIFrameElement | undefined>(undefined);
  let height = $state(160);
  let pendingLink = $state<{ url: string; resolve: (ok: boolean) => void } | null>(null);
  /** After a cancelled link the app may not ask again until then (no confirmation-bar spam). */
  let linkBlockedUntil = 0;

  let bridge: AppBridgeHost | null = null;
  let generation = 0;
  let activeResource: string | null = null;

  const bordered = $derived(opened?.prefersBorder !== false);

  async function start(): Promise<void> {
    const gen = ++generation;
    cardState = 'loading';
    errorCode = undefined;
    try {
      const out = appsUiOpenOutputSchema.parse(await core.call('apps.ui.open', { messageId }));
      if (gen !== generation) {
        void core.call('apps.ui.close', { resourceId: out.resourceId }).catch(() => undefined);
        return;
      }
      activeResource = out.resourceId;
      opened = out;
      await tick();
      const frameWindow = frame?.contentWindow;
      if (frame === undefined || !frameWindow) throw new Error('frame unavailable');
      const connected = await AppBridgeHost.connect({
        frameWindow,
        toolInput: out.toolInput,
        toolResult: out.toolResult,
        hostContext: { theme: mode.current === 'dark' ? 'dark' : 'light', locale: i18n.locale },
        callTool: async (name, args) => {
          try {
            return appsUiCallToolOutputSchema.parse(
              await core.call('apps.ui.callTool', {
                resourceId: out.resourceId,
                toolName: name,
                arguments: args,
              }),
            );
          } catch (error) {
            const code = (error as { code?: string }).code;
            // The registered page is gone (evicted / expired / server removed): show it, offer reload.
            if (code === 'APP_UI_EXPIRED') {
              errorCode = code;
              cardState = 'error';
            }
            throw new Error(errorText(code, t('appsUi.callFailed')), { cause: error });
          }
        },
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
          const clamped = clampAppHeight(value);
          if (clamped !== null) height = clamped;
        },
      });
      if (gen !== generation) {
        await connected.close();
        return;
      }
      bridge = connected;
      // Listen first, then load: the app's `ui/initialize` must find the bridge ready.
      frame.src = out.url;
      cardState = 'ready';
    } catch (error) {
      if (gen !== generation) return;
      errorCode = (error as { code?: string }).code;
      cardState = 'error';
    }
  }

  async function stop(): Promise<void> {
    generation += 1;
    pendingLink?.resolve(false);
    pendingLink = null;
    const closing = bridge;
    bridge = null;
    const resource = activeResource;
    activeResource = null;
    opened = null;
    await closing?.close();
    if (resource !== null) {
      await core.call('apps.ui.close', { resourceId: resource }).catch(() => undefined);
    }
  }

  async function reload(): Promise<void> {
    await stop();
    await start();
  }

  async function confirmLink(): Promise<void> {
    const link = pendingLink;
    const resource = activeResource;
    if (link === null || resource === null) return;
    pendingLink = null;
    try {
      const result = appsUiOpenLinkOutputSchema.parse(
        await core.call('apps.ui.openLink', { resourceId: resource, url: link.url }),
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
    void start();
    return () => {
      void stop();
    };
  });
</script>

<div
  class="w-full max-w-[85%] overflow-hidden rounded-lg text-sm {bordered
    ? 'border bg-background/80'
    : ''}"
  data-testid="mcp-app-card"
  data-state={cardState}
  data-resource-id={opened?.resourceId ?? ''}
>
  <div class="flex items-center gap-2 px-3 py-2">
    <AppWindow class="size-4 shrink-0 text-sky-600" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="truncate font-medium" data-testid="mcp-app-title">{card.title}</p>
      <p class="truncate text-xs text-muted-foreground">
        {t('appsUi.fromApp', { app: card.appName })}
      </p>
    </div>
    <Button
      size="sm"
      variant="ghost"
      class="h-6 px-2 text-xs"
      disabled={cardState === 'loading'}
      onclick={() => void reload()}
      data-testid="mcp-app-reload"
      aria-label={t('appsUi.reload')}
    >
      <RefreshCw class="size-3" aria-hidden="true" />
    </Button>
  </div>

  {#if cardState === 'error'}
    <div class="px-3 pb-3" data-testid="mcp-app-error">
      <p class="text-xs text-amber-700 dark:text-amber-400">
        {errorText(errorCode, t('appsUi.loadFailed'))}
      </p>
    </div>
  {:else if cardState === 'loading'}
    <p class="px-3 pb-3 text-xs text-muted-foreground" data-testid="mcp-app-loading">
      {t('appsUi.loading')}
    </p>
  {/if}

  {#if opened !== null}
    <!--
      sandbox: scripts only — no allow-same-origin (opaque origin: no cookies / storage / parent
      access), no popups, no top-navigation, no forms. allow="": no camera / microphone / etc.
    -->
    <iframe
      bind:this={frame}
      title={card.title}
      sandbox="allow-scripts"
      allow=""
      referrerpolicy="no-referrer"
      class="block w-full border-0 bg-transparent {cardState === 'ready' ? '' : 'hidden'}"
      style="height: {height}px; color-scheme: normal;"
      data-testid="mcp-app-frame"
    ></iframe>
  {/if}

  {#if pendingLink !== null}
    <LinkConfirmBar
      url={pendingLink.url}
      title={t('appsUi.openLinkTitle')}
      hostLabel={t('appsUi.openLinkHost')}
      confirmLabel={t('appsUi.openLinkConfirm')}
      cancelLabel={t('appsUi.openLinkCancel')}
      testidPrefix="mcp-app"
      onconfirm={() => void confirmLink()}
      oncancel={cancelLink}
    />
  {/if}

  {#if opened !== null}
    <p
      class="border-t px-3 py-1 text-[11px] text-muted-foreground"
      data-testid="mcp-app-network"
      title={opened.connectDomains.join(' ')}
    >
      {opened.connectDomains.length === 0
        ? t('appsUi.networkNone')
        : t('appsUi.network', { domains: opened.connectDomains.join(' ') })}
      {#if opened.deniedPermissions.length > 0}
        · {t('appsUi.permissionsDenied', { items: opened.deniedPermissions.join(' ') })}
      {/if}
      {#if opened.ignored.length > 0}
        · {t('appsUi.ignored', { count: opened.ignored.length })}
      {/if}
    </p>
  {/if}
</div>
