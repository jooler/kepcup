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
    widgetsUiQueryOutputSchema,
    widgetsUiSourceOutputSchema,
    widgetsUiStorageOutputSchema,
    type WidgetCard,
    type WidgetQueryDef,
    type WidgetsUiOpenOutput,
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
  import { checkBadge } from './check-status';

  /**
   * 对话里的 Bot 自制交互组件卡片（D81，docs/design/32-bot-widgets.md）。
   *
   * 审查态先行：Bot 生成的 HTML 是最低信任内容——初始不挂 iframe，展示版本与能力
   * （禁网 / 本机 KV 存储 / 预审查询模板），用户「查看源码」（含查询模板 SQL 全文）
   * 或「加载运行」。按「HTML sha256 + 查询摘要」记忆确认（同版本只确认一次，
   * localStorage），新版本或仅查询变化都视为新代码。加载后 `widgets.ui.open` 登记
   * 内存资源（core 在 HTML 前置 SDK 垫片），iframe `sandbox="allow-scripts"`
   * （opaque origin，无 preload）指向 `kepcup-app://widget-{hash}/{id}`。
   *
   * 能力桥（P1 / P2）：`WidgetBridgeHost` 在挂 iframe 前监听，只信
   * `event.source === frameWindow` 的消息——`storage.*` 转发为 `widgets.ui.storage`，
   * `query` 转发为 `widgets.ui.query`（随版本预审的只读模板），`openLink` 先出卡内
   * 确认条（拒绝后冷却，同 McpAppCard），`setHeight` 夹取后调高度，`theme` 回建桥时
   * 的明暗主题。
   *
   * 资源续命：卡片挂着不动超过资源 TTL（或被 LRU 淘汰、或组件版本被修剪）后，下一次
   * 桥调用会得 `WIDGET_RESOURCE_EXPIRED`——这里自动重新 `widgets.ui.open` 换一个
   * resourceId 并重放这次调用（iframe 不重载，组件内状态不丢）；重开也失败（组件已被
   * 删除等）才转错误态。预审强制：带查询模板的版本必须先展开源码（SQL 全文）才能
   * 加载，core 的 open 同样拒绝未审查的版本（`WIDGET_REVIEW_REQUIRED`）。
   */
  let { messageId, card }: { messageId: string; card: WidgetCard } = $props();

  type CardState = 'review' | 'loading' | 'ready' | 'error';
  let cardState = $state<CardState>('review');
  let errorCode = $state<string | undefined>(undefined);
  let opened = $state<WidgetsUiOpenOutput | null>(null);
  let frame = $state<HTMLIFrameElement | undefined>(undefined);
  let sourceOpen = $state(false);
  let sourceHtml = $state<string | null>(null);
  let sourceQueries = $state<WidgetQueryDef[]>([]);
  let sourceError = $state(false);
  let sourceLoading = $state(false);
  /** 未上报前的缺省高度；组件可用 `kepcup.setHeight` 自适应（夹到 [100, 800]）。 */
  let height = $state(380);
  /** 自检徽标（`legacy` 为 null）与「已知问题」展开态。 */
  const badge = $derived(checkBadge(card.checkStatus));
  let issuesOpen = $state(false);
  /** 查看源码的展示上限：本地库损坏时 html 可能远超 2MB 上限，整段渲染会卡死界面。 */
  const SOURCE_DISPLAY_MAX_CHARS = 20_000;
  let pendingLink = $state<{ url: string; resolve: (ok: boolean) => void } | null>(null);
  /** 一条外链被取消后的冷却（防反复弹确认条），与 McpAppCard 同值。 */
  let linkBlockedUntil = 0;

  let bridge: WidgetBridgeHost | null = null;
  let generation = 0;
  /** 当前挂载的资源租约（过期自动重开并重放调用，见 resource-lease.ts）。 */
  let lease: WidgetResourceLease | null = null;
  /** 带查询模板的版本：本次会话里已展开过源码（SQL 全文）才放行「加载」。 */
  const needsReview = $derived(card.queriesCount > 0 && sourceHtml === null);

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
    cardState = 'loading';
    errorCode = undefined;
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
      // 确认在资源登记成功后记忆：open 失败不留下次自动重试失败请求的确认。
      rememberConsent(consentKey(card));
      lease = new WidgetResourceLease({
        resourceId: out.resourceId,
        reopen: async () =>
          widgetsUiOpenOutputSchema.parse(await core.call('widgets.ui.open', { messageId, theme: currentTheme() })).resourceId,
        discard: (resourceId) => {
          void core.call('widgets.ui.close', { resourceId }).catch(() => undefined);
        },
        onRenewFailed: (error) => {
          // 重开也失败（组件已删除 / 版本已修剪等）：卡片转错误态，不再假装可用。
          errorCode = (error as { code?: string }).code;
          cardState = 'error';
          void stop();
        },
      });
      opened = out;
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
      const connected = bridge;
      frame.addEventListener(
        'load',
        () => {
          connected.setTheme(currentTheme(), { force: true });
        },
        { once: true },
      );
      frame.src = out.url;
      cardState = 'ready';
    } catch (error) {
      if (gen !== generation) return;
      const code = (error as { code?: string }).code;
      // 失败路径也要释放已登记的资源与半建的桥（例如 frame 不可用时租约已建立），
      // 不能把资源留到 TTL。stop() 不碰 cardState / errorCode。
      void stop();
      if (code === 'WIDGET_REVIEW_REQUIRED') {
        // core 侧预审强制（例如旧确认记忆下的自动加载）：回到审查态并展开源码。
        cardState = 'review';
        if (!sourceOpen) void toggleSource();
        return;
      }
      errorCode = code;
      cardState = 'error';
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

  /** `widgets.ui.query` 的渲染端出站（P2）：同上，错误（code/message）由桥透传给组件。 */
  async function callQuery(input: WidgetsUiQueryCall): Promise<WidgetsUiQueryOutput> {
    return withResource(async (resourceId) =>
      widgetsUiQueryOutputSchema.parse(await core.call('widgets.ui.query', { ...input, resourceId })),
    );
  }

  async function stop(): Promise<void> {
    generation += 1;
    pendingLink?.resolve(false);
    pendingLink = null;
    const connected = bridge;
    bridge = null;
    connected?.destroy();
    const resource = lease?.close() ?? null;
    lease = null;
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
        sourceQueries = out.queries;
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

  onMount(() => {
    // 卡片内容随消息固定（widget/version/sha 不变）：按版本记忆的确认直接自动加载。
    if (consented(consentKey(card))) void start();
    return () => {
      void stop();
    };
  });

  /**
   * 确认记忆的指纹 = HTML sha256 + 查询模板摘要（P2）：HTML 不变、仅查询变化的
   * 新版本同样视为新代码要求重新确认。旧确认（P1 时代只按 sha256 记）会失配、
   * 多确认一次——安全方向的代价。
   */
  function consentKey(c: WidgetCard): string {
    return `${c.sha256}|${c.queriesSha256}`;
  }

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
      {#if badge !== null}
        <!-- D87 P3c 自检徽标：只说明它能运行、不代表安全；按版本确认照旧（设计 32 §11.12）。 -->
        <div class="mb-1.5" data-testid="bot-widget-check">
          <span
            class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium {badge.tone}"
            data-testid="bot-widget-check-badge"
            data-status={card.checkStatus}>{t(badge.label)}</span
          >
          {#if card.knownIssues.length > 0}
            <button
              type="button"
              class="ml-1 text-[11px] text-muted-foreground underline underline-offset-2"
              aria-expanded={issuesOpen}
              aria-controls={`known-issues-${messageId}`}
              onclick={() => (issuesOpen = !issuesOpen)}
              data-testid="bot-widget-known-issues-toggle"
            >
              {t(issuesOpen ? 'botWidget.check.hideIssues' : 'botWidget.check.showIssues', {
                n: card.knownIssues.length,
              })}
            </button>
            {#if issuesOpen}
              <ul
                id={`known-issues-${messageId}`}
                class="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground"
                data-testid="bot-widget-known-issues"
              >
                {#each card.knownIssues as issue, index (index)}
                  <li>{issue}</li>
                {/each}
              </ul>
            {/if}
          {/if}
          <p class="mt-1 text-[11px] text-muted-foreground" data-testid="bot-widget-check-note">
            {t('botWidget.check.note')}
          </p>
        </div>
      {/if}
      <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <!-- 声明了查询的版本换专门文案：笼统的「读不到你的其他数据」会与下方查询提示自相矛盾。 -->
        {t(card.queriesCount > 0 ? 'botWidget.reviewNoteQueries' : 'botWidget.reviewNote')}
      </p>
      {#if card.queriesCount > 0}
        <p class="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="bot-widget-queries-note">
          {t('botWidget.queriesNote', { n: card.queriesCount })}
        </p>
      {/if}
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
          disabled={needsReview}
          data-testid="bot-widget-load"
        >
          {t('botWidget.load')}
        </Button>
      </div>
      {#if needsReview}
        <p class="mt-1 text-xs text-muted-foreground" data-testid="bot-widget-review-first">
          {t('botWidget.reviewQueriesFirst')}
        </p>
      {/if}
      {#if sourceOpen}
        {#if sourceQueries.length > 0}
          <div class="mt-2 rounded bg-muted p-2 text-[11px]" data-testid="bot-widget-queries">
            <p class="mb-1 font-medium">{t('botWidget.queriesTitle')}</p>
            {#each sourceQueries as query (query.name)}
              <div class="mt-1">
                <p class="text-muted-foreground">
                  kepcup.query('{query.name}') →
                </p>
                <pre class="overflow-auto whitespace-pre-wrap leading-relaxed">{query.sql}</pre>
              </div>
            {/each}
          </div>
        {/if}
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
