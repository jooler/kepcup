<script lang="ts">
  import jsQR from 'jsqr';
  import type { Snippet } from 'svelte';
  import { ModeWatcher } from 'mode-watcher';
  import { t, type MessageKey } from '$lib/i18n';
  import { webGate, type RejectReason } from './gate.svelte';
  import { ENDPOINT_KIND } from './endpoint';
  import { bindWebBackNavigation } from './back-navigation.svelte';

  /**
   * web 构建（手机 PWA）的门（D96 WP5，design 46 §3.2）：App 模板整体作为 children
   * 传进来——已连接才渲染正常 App UI；未配对 / 配对中 / 桌面离线等状态渲染本组件
   * 的状态页（纯遥控器：不做任何本地缓存式浏览）。
   *
   * Electron 端点恒走 connected 分支，children 原样渲染，其余模板不进 DOM、
   * 副作用不执行——桌面路径零行为变化。
   */
  let { children }: { children?: Snippet } = $props();

  const view = $derived(ENDPOINT_KIND === 'remote' ? webGate.view : 'connected');

  // 横滑返回（popstate → 关最上层）：只在 web 端点接管，见 back-navigation.svelte.ts。
  $effect(() => {
    if (ENDPOINT_KIND !== 'remote') return;
    return bindWebBackNavigation();
  });

  const REJECT_KEYS: Record<RejectReason, MessageKey> = {
    expired: 'web.rejected.expired',
    declined: 'web.rejected.declined',
    bad_code: 'web.rejected.bad_code',
    busy: 'web.rejected.busy',
    error: 'web.rejected.error',
  };
  const rejectKey = $derived(REJECT_KEYS[webGate.rejectReason]);

  // --- 页内扫码（D96 配对体验）：系统相机扫完一关浏览器地址就找不回来（微信内置
  // 浏览器尤甚），页内扫码让配对链接全程不离开本页。iOS Safari 没有 BarcodeDetector，
  // 直接用 jsQR 全平台一条路径；getUserMedia 需 HTTPS（PWA 部署域满足）。 ---
  let scanning = $state(false);
  let scanError = $state<'denied' | 'failed' | 'bad-code' | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let stream: MediaStream | null = null;
  let rafId = 0;
  let lastDecodeAt = 0;

  async function startScan(): Promise<void> {
    scanError = null;
    if (navigator.mediaDevices?.getUserMedia === undefined) {
      scanError = 'failed';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
    } catch {
      scanError = 'denied';
      return;
    }
    scanning = true;
  }

  function stopScan(): void {
    if (rafId !== 0) cancelAnimationFrame(rafId);
    rafId = 0;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (videoEl !== null) videoEl.srcObject = null;
    scanning = false;
  }

  // video 元素就绪（scanning 为真 + bind:this 到位）后接流并开始解码循环；
  // 清理只停 rAF（停流归 stopScan / 卸载 effect），避免与取消按钮双停竞态。
  $effect(() => {
    if (!scanning || videoEl === null || stream === null) return;
    const video = videoEl;
    video.srcObject = stream;
    void video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = (): void => {
      rafId = requestAnimationFrame(tick);
      if (ctx === null || video.readyState < 2) return;
      const now = performance.now();
      if (now - lastDecodeAt < 120) return; // ~8fps 解码：扫码足够，功耗友好
      lastDecodeAt = now;
      const width = 480;
      const height =
        video.videoHeight > 0 ? Math.round((video.videoHeight / video.videoWidth) * width) : 360;
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(video, 0, 0, width, height);
      const code = jsQR(ctx.getImageData(0, 0, width, height).data, width, height);
      if (code === null) return;
      stopScan();
      // 扫到但不是配对链接：回到粘贴页给出错误，不空转继续扫。
      if (!webGate.acceptScannedCode(code.data)) scanError = 'bad-code';
    };
    tick();
    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      rafId = 0;
    };
  });
  // 组件卸载（配对成功进 App / 刷新）必须停流释放摄像头。
  $effect(() => () => stopScan());

  const SCAN_ERROR_KEYS = {
    'bad-code': 'web.scan.badCode',
    denied: 'web.scan.denied',
    failed: 'web.scan.failed',
  } as const;
</script>

{#if view === 'connected'}
  {@render children?.()}
{:else}
  <!-- children（App UI）未渲染，主题监听由门自己带一份。 -->
  <ModeWatcher />
  <div class="flex h-dvh flex-col bg-background text-foreground" data-testid="web-gate">
    <header class="flex items-center gap-2 px-4 pt-4 pb-2">
      <img src="/icon.svg" alt="" class="size-7 rounded-lg" />
      <span class="text-sm font-medium">{t('web.gate.title')}</span>
    </header>

    <main class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 pb-10">
      {#if scanning}
        <div class="w-full max-w-sm space-y-3 text-center" data-testid="web-gate-scan">
          <h1 class="text-lg font-semibold">{t('web.scan.title')}</h1>
          <div
            class="relative aspect-square w-full overflow-hidden rounded-lg border border-border bg-black"
          >
            <!-- svelte-ignore a11y_media_has_caption -->
            <video bind:this={videoEl} class="size-full object-cover" muted autoplay playsinline
            ></video>
          </div>
          <p class="text-xs text-muted-foreground">{t('web.scan.hint')}</p>
          <button
            type="button"
            class="h-10 w-full rounded-md border border-border text-sm hover:bg-muted"
            onclick={stopScan}
            data-testid="web-scan-stop"
          >
            {t('web.scan.stop')}
          </button>
        </div>
      {:else if view === 'unpaired'}
        <div class="w-full max-w-sm space-y-4" data-testid="web-gate-unpaired">
          <h1 class="text-lg font-semibold">{t('web.unpaired.title')}</h1>
          <p class="text-sm text-muted-foreground">{t('web.unpaired.body')}</p>
          <input
            class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring"
            type="text"
            placeholder={t('web.unpaired.placeholder')}
            bind:value={webGate.linkInput}
            onkeydown={(event) => {
              if (event.key === 'Enter') webGate.submitLink();
            }}
            data-testid="web-pair-input"
          />
          {#if webGate.inputError !== null}
            <p class="text-xs text-destructive" data-testid="web-pair-invalid">
              {t('web.unpaired.invalid')}
            </p>
          {/if}
          {#if scanError !== null}
            <p class="text-xs text-destructive" data-testid="web-scan-error">
              {t(SCAN_ERROR_KEYS[scanError])}
            </p>
          {/if}
          <button
            type="button"
            class="h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/80"
            onclick={() => webGate.submitLink()}
            data-testid="web-pair-submit"
          >
            {t('web.unpaired.submit')}
          </button>
          <button
            type="button"
            class="h-10 w-full rounded-md border border-border text-sm hover:bg-muted"
            onclick={() => void startScan()}
            data-testid="web-scan-start"
          >
            {t('web.scan.action')}
          </button>
        </div>
      {:else if view === 'enter-name'}
        <div class="w-full max-w-sm space-y-4" data-testid="web-gate-enter-name">
          <h1 class="text-lg font-semibold">{t('web.name.title')}</h1>
          <p class="text-sm text-muted-foreground">
            {t('web.name.body', {
              host: new URL(webGate.pendingLink?.relayUrl ?? 'wss://relay').host,
            })}
          </p>
          <label class="grid gap-1.5">
            <span class="text-xs text-muted-foreground">{t('web.name.label')}</span>
            <!-- spellcheck off：设备名常含机型词，输入法联想无意义。 -->
            <input
              class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring"
              type="text"
              maxlength="60"
              spellcheck="false"
              bind:value={webGate.deviceName}
              data-testid="web-device-name"
            />
          </label>
          <div class="flex gap-2">
            <button
              type="button"
              class="h-10 flex-1 rounded-md border border-border text-sm hover:bg-muted"
              onclick={() => webGate.backToUnpaired()}
            >
              {t('web.name.back')}
            </button>
            <button
              type="button"
              class="h-10 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/80"
              onclick={() => webGate.submitDeviceName()}
              data-testid="web-pair-confirm"
            >
              {t('web.name.submit')}
            </button>
          </div>
        </div>
      {:else if view === 'joining' || view === 'awaiting-confirm' || view === 'booting'}
        <div class="w-full max-w-sm space-y-2 text-center" data-testid="web-gate-status">
          <div
            class="mx-auto size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
            aria-hidden="true"
          ></div>
          <p class="text-sm text-muted-foreground">
            {view === 'joining'
              ? t('web.joining')
              : view === 'awaiting-confirm'
                ? t('web.awaiting')
                : t('web.booting')}
          </p>
        </div>
      {:else if view === 'rejected'}
        <div class="w-full max-w-sm space-y-3 text-center" data-testid="web-gate-rejected">
          <h1 class="text-lg font-semibold">{t('web.rejected.title')}</h1>
          <p class="text-sm text-muted-foreground">{t(rejectKey)}</p>
          <button
            type="button"
            class="h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/80"
            onclick={() => webGate.resetPairing()}
            data-testid="web-pair-retry"
          >
            {t('web.rejected.retry')}
          </button>
        </div>
      {:else if view === 'failed'}
        <div class="w-full max-w-sm space-y-3 text-center" data-testid="web-gate-failed">
          <h1 class="text-lg font-semibold">{t('web.failed.title')}</h1>
          <p class="text-sm text-muted-foreground">{t('web.failed.body')}</p>
          <button
            type="button"
            class="h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/80"
            onclick={() => webGate.retryConnection()}
            data-testid="web-failed-retry"
          >
            {t('web.retry')}
          </button>
          <button
            type="button"
            class="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onclick={() => webGate.resetPairing()}
          >
            {t('web.rejected.retry')}
          </button>
        </div>
      {:else if view === 'kicked'}
        <div class="w-full max-w-sm space-y-3 text-center" data-testid="web-gate-kicked">
          <h1 class="text-lg font-semibold">{t('web.kicked.title')}</h1>
          <p class="text-sm text-muted-foreground">
            {webGate.kickReason === 'revoked'
              ? t('web.kicked.revoked')
              : t('web.kicked.auth_failed')}
          </p>
          <button
            type="button"
            class="h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/80"
            onclick={() => webGate.resetPairing()}
          >
            {t('web.kicked.action')}
          </button>
        </div>
      {:else if view === 'offline'}
        <div class="w-full max-w-sm space-y-3 text-center" data-testid="web-gate-offline">
          <h1 class="text-lg font-semibold">{t('web.offline.title')}</h1>
          <p class="text-sm text-muted-foreground">{t('web.offline.body')}</p>
          {#if webGate.keyFingerprint !== null && webGate.keyFingerprint !== ''}
            <p class="font-mono text-xs break-all text-muted-foreground">
              {t('web.connected.fingerprint')}: {webGate.keyFingerprint}
            </p>
          {/if}
          <button
            type="button"
            class="h-10 w-full rounded-md border border-border text-sm hover:bg-muted"
            onclick={() => webGate.retryConnection()}
            data-testid="web-offline-retry"
          >
            {t('web.retry')}
          </button>
        </div>
      {:else if view === 'disconnected'}
        <div class="w-full max-w-sm space-y-3 text-center" data-testid="web-gate-disconnected">
          <h1 class="text-lg font-semibold">{t('web.disconnected.title')}</h1>
          <p class="text-sm text-muted-foreground">{t('web.disconnected.body')}</p>
          <button
            type="button"
            class="h-10 w-full rounded-md border border-border text-sm hover:bg-muted"
            onclick={() => webGate.retryConnection()}
            data-testid="web-disconnected-retry"
          >
            {t('web.retry')}
          </button>
        </div>
      {/if}

      <!-- 安装引导（web-main.ts 捕获 beforeinstallprompt 后 webGate.available 才为真）。 -->
      {#if webGate.installAvailable}
        <div class="w-full max-w-sm space-y-2 rounded-lg border border-border p-3 text-center">
          <p class="text-xs text-muted-foreground">{t('web.install.hint')}</p>
          <button
            type="button"
            class="h-9 w-full rounded-md border border-border text-sm hover:bg-muted"
            onclick={() => void webGate.promptInstall()}
            data-testid="web-install"
          >
            {t('web.install.action')}
          </button>
        </div>
      {/if}
    </main>
  </div>
{/if}
