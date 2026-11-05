<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
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
  import { sensors } from '$lib/sensors/sensors.svelte';
  import LinkConfirmBar from '$lib/features/apps-ui/LinkConfirmBar.svelte';
  import { WidgetBridgeHost } from './widget-bridge-host';
  import { MicroAppBridgeHost } from './micro-app-bridge-host';
  import { WidgetResourceLease } from './resource-lease';
  import { widgetConsented } from './consent.svelte';
  import { microAppEffectiveConsentOk, microAppOpenAllowed } from './micro-app-gate';
  import {
    MicroAppAudioSession,
    MicroAppSpeakQueue,
  } from './micro-app-audio';

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
  let {
    messageId,
    card,
    /** P1：会话级麦克风授权（外壳 MicroAppChrome 的开关；撤销即 revokeCapability）。 */
    micGranted = false,
    /** P1：展示模式（外壳全屏键 / 微应用 requestDisplayMode 的落点）。 */
    onDisplayMode,
  }: {
    messageId: string;
    card: WidgetCard;
    micGranted?: boolean;
    onDisplayMode?: (mode: 'inline' | 'immersive') => void;
  } = $props();

  type RuntimeState = 'loading' | 'ready' | 'error';
  let phase = $state<RuntimeState>('loading');
  let errorCode = $state<string | undefined>(undefined);
  let frame = $state<HTMLIFrameElement | undefined>(undefined);
  let pendingLink = $state<{ url: string; resolve: (ok: boolean) => void } | null>(null);
  /** 一条外链被取消后的冷却（防反复弹确认条）。 */
  let linkBlockedUntil = 0;
  let pendingReply = $state<{ text: string; resolve: (ok: boolean) => void } | null>(null);
  let replyBlockedUntil = 0;

  let bridge: WidgetBridgeHost | MicroAppBridgeHost | null = null;
  let microBridge: MicroAppBridgeHost | null = null;
  let generation = 0;
  /** 当前挂载的资源租约（过期自动重开并重放调用，见 resource-lease.ts）。 */
  let lease: WidgetResourceLease | null = null;
  /** 运行中的版本（微应用续期钉住它——升级不热替换运行中的实例，55 §9.1）。 */
  let runningVersion: number | null = null;
  /** P1：音频面（实例级 TTS 队列；麦克风由各 listen 会话开关）。 */
  let speakQueue: MicroAppSpeakQueue | null = null;
  let offStream: (() => void) | null = null;
  /** 宿主铸造的实例键（ai / 媒体 RPC 的记账与归属；续期不变）。 */
  let microInstanceId: string | null = null;
  /** 诊断限流（code:detail → 上次发送时间）。 */
  const diagnosticSentAt = new SvelteMap<string, number>();
  /** 当前资源 id（续期后更新；ai / 媒体面调用时读取，避免打到过期资源）。 */
  let currentResourceId: string | null = null;

  // 麦克风撤销：桥已建时立即停采集并通知微应用 capability.revoked（55 §5.3）。
  $effect(() => {
    if (micGranted) return;
    if (microBridge !== null) microBridge.revokeCapability('media.listen');
  });

  // P2（§9.1）：窗口不可见 → pause；恢复可见 → resume（微应用写 session: 快照）。
  $effect(() => {
    if (card.microApp === undefined) return;
    void card.widgetId;
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') microBridge?.pushAppEvent('pause', null);
      else microBridge?.pushAppEvent('resume', null);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  // core 的模型流式增量 → 桥 v2 event 帧（按实例过滤）。
  $effect(() => {
    if (card.microApp === undefined) return;
    void card.widgetId;
    offStream?.();
    offStream = core.onEvent('micro-app.stream', (payload) => {
      microBridge?.forwardStreamEvent(
        payload as {
          instanceId: string;
          streamId: string;
          kind: string;
          delta?: string;
          code?: string;
        },
      );
    });
    return () => {
      offStream?.();
      offStream = null;
    };
  });

  function currentTheme(): 'light' | 'dark' {
    return mode.current === 'dark' ? 'dark' : 'light';
  }

  // D87 P3b：应用切换明暗时推给已挂载的组件（垫片更新 data-theme 并派发 kepcup:theme）。
  // 微应用走桥 v2 的 event 帧（同一语义，协议换了）。
  $effect(() => {
    const theme = currentTheme();
    bridge?.setTheme(theme);
  });

  async function start(): Promise<void> {
    const gen = ++generation;
    phase = 'loading';
    errorCode = undefined;
    // 防御：运行时只应在确认后挂载；未确认（记忆被清等）回到海报卡的审查态流程。
    // 微应用（D112）的确认按能力面指纹——卡片门控之外，open 后还要对生效版本再核一次。
    if (card.microApp === undefined ? !widgetConsented(card) : !microAppOpenAllowed(card)) {
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
      // 微应用：生效版本的指纹必须被当前确认覆盖（卡片门控可能基于过期指纹）——
      // 能力面已扩大时这里兜底拒绝，不静默运行未确认的能力。
      if (out.microApp !== undefined && out.capabilityFingerprint !== undefined) {
        if (!microAppEffectiveConsentOk(out.widgetId, out.capabilityFingerprint)) {
          void core.call('widgets.ui.close', { resourceId: out.resourceId }).catch(() => undefined);
          errorCode = 'WIDGET_REVIEW_REQUIRED';
          phase = 'error';
          return;
        }
      }
      runningVersion = out.version;
      currentResourceId = out.resourceId;
      lease = new WidgetResourceLease({
        resourceId: out.resourceId,
        reopen: async () => {
          const renewed = widgetsUiOpenOutputSchema.parse(
            await core.call('widgets.ui.open', {
              messageId,
              theme: currentTheme(),
              // 续期钉住运行中的版本：next_version 前移 / 新版本未过预审都不能把
              // 在跑的实例换掉（升级 = 重新打开生效，不热替换）。
              ...(runningVersion !== null ? { pinVersion: runningVersion } : {}),
            }),
          );
          // 续期换 resourceId 后，ai / 媒体面要跟着用新的（审查修复 F8）。
          currentResourceId = renewed.resourceId;
          return renewed.resourceId;
        },
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
      // 微应用挂桥 v2（能力路由 / 事件 / 预算 / 音频面），存量组件挂 v1（行为零变化）。
      if (out.microApp !== undefined) {
        // resourceId 用读取器（二轮 F1）：租期续命换 id 后，speak / transcribe 跟着新 id 走。
        speakQueue = new MicroAppSpeakQueue(() => currentResourceId ?? '');
        bridge = MicroAppBridgeHost.connect({
          frameWindow,
          resourceId: out.resourceId,
          permissions: out.microApp.permissions,
          net: { mode: out.microApp.netMode, domains: out.microApp.netAllowlist },
          theme: openedTheme,
          displayMode: out.microApp.displayMode,
          viewport: {
            width: frame.clientWidth || 360,
            height: frame.clientHeight || 520,
          },
          storage: (input) => callStorage(input),
          query: (input) => callQuery(input),
          openLink: (url) =>
            new Promise<boolean>((resolve) => {
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
          onTitle: () => {},
          micGrant: () => {
            if (!micGranted) return 'denied';
            if (!sensors.state.microphone.enabled) return 'unavailable';
            return 'granted';
          },
          // 审查修复 F1/F3：instanceId 一律由宿主加盖（盖掉 iframe 传来的任何值），
          // resourceId 用续期后的当前值——预算 / 并发 / 归属才不被伪造实例键绕过。
          aiCall: (method, params) => {
            const { instanceId: _ignored, ...rest } = params;
            void _ignored;
            return core.call(aiRpcNameOf(method), {
              ...rest,
              resourceId: currentResourceId ?? '',
              instanceId: microInstanceId ?? '',
            });
          },
          createListenSession: (config, sink, instanceId) =>
            new MicroAppAudioSession({
              resourceId: () => currentResourceId ?? '',
              instanceId,
              config,
              sink,
              speakQueue: speakQueue!,
              openMicrophone: async () => (await sensors.open('microphone')).stream,
            }),
          speak: (input) => speakQueue!.speak(input),
          stopSpeaking: () => speakQueue?.stopSpeaking(),
          onRequestDisplayMode: async (mode) => {
            onDisplayMode?.(mode);
            return { mode };
          },
          onClose: () => {
            /* 关闭由用户掌握（外壳 X / Esc）；微应用请求只作为提示，P1 不代关。 */
          },
          // P2（55 §9.4）：诊断回流（限流：同 code 一分钟至多一条，内容不落库）。
          onDiagnostic: (event) => {
            const key = `${event.code}:${event.detail}`;
            const now = Date.now();
            if ((diagnosticSentAt.get(key) ?? 0) > now - 60_000) return;
            diagnosticSentAt.set(key, now);
            if (diagnosticSentAt.size > 128) diagnosticSentAt.clear();
            void core
              .call('microApps.diagnostics.record', {
                resourceId: currentResourceId ?? '',
                instanceId: microInstanceId ?? '',
                phase: event.phase,
                code: event.code,
                detail: event.detail,
              })
              .catch(() => undefined);
          },
          onUnresponsive: () => {
            // §9.1：无响应 → 「微应用无响应」+ 重新打开（不自动循环重试）。
            errorCode = 'MICRO_APP_UNRESPONSIVE';
            phase = 'error';
          },
        });
        microBridge = bridge;
        microInstanceId = microBridge.instanceId;
        speakQueue.setInstance(microInstanceId);
      } else {
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
      }
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
    runningVersion = null;
    pendingLink?.resolve(false);
    pendingLink = null;
    pendingReply?.resolve(false);
    pendingReply = null;
    const connected = bridge;
    bridge = null;
    microBridge = null;
    connected?.destroy();
    // 音频面收口：停播放（监听会话已随桥 destroy 释放麦克风）。
    speakQueue?.dispose();
    speakQueue = null;
    const resource = lease?.close() ?? null;
    lease = null;
    // 实例收口（审查修复 F4）：关闭即取消全部在途模型调用、释放会话与并发位
    // （「关闭微应用即取消全部在途调用」，55 §6.2 / §9.1）。
    if (microInstanceId !== null && resource !== null) {
      await core
        .call('microApps.ai.dispose', { resourceId: resource, instanceId: microInstanceId })
        .catch(() => undefined);
    }
    microInstanceId = null;
    currentResourceId = null;
    if (resource !== null) {
      await core.call('widgets.ui.close', { resourceId: resource }).catch(() => undefined);
    }
  }

  /** 外壳「停止」键：立即停采集与播放（55 §7.3）。 */
  export function stopAudio(): void {
    speakQueue?.stopSpeaking();
    microBridge?.revokeCapability('media.listen');
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

<script lang="ts" module>
  /** 桥方法名 → microApps.* RPC 名（ai 面）。 */
  export function aiRpcNameOf(method: string): string {
    switch (method) {
      case 'ai.chat':
        return 'microApps.ai.chat';
      case 'ai.session.create':
        return 'microApps.ai.sessionCreate';
      case 'ai.session.send':
        return 'microApps.ai.sessionSend';
      case 'ai.session.history':
        return 'microApps.ai.sessionHistory';
      case 'ai.session.reset':
        return 'microApps.ai.sessionReset';
      case 'collections.put':
        return 'microApps.collections.put';
      case 'collections.get':
        return 'microApps.collections.get';
      case 'collections.delete':
        return 'microApps.collections.delete';
      case 'collections.list':
        return 'microApps.collections.list';
      case 'collections.query':
        return 'microApps.collections.query';
      case 'context.update':
        return 'microApps.context.update';
      case 'context.clear':
        return 'microApps.context.clear';
      default:
        return `microApps.${method}`;
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col h-full" data-testid="widget-runtime" data-state={phase}>
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
