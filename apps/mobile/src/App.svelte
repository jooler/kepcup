<script lang="ts">
  import {
    buildConnectUrl,
    resolveConnectTarget,
    targetId,
    targetLabel,
    type ConnectTarget,
  } from '$lib/connect';
  import { probeReachable, scanOnce, type ScanFailure } from '$lib/scan';
  import { recentTargets } from '$lib/targets.svelte';
  import type { RecentTarget } from '$lib/target-model';

  /**
   * 原生首页(D122 §2.1):扫码 / 输入地址 / 最近连接三入口。连接 = 构建
   * `?shell=native&shellBack=…` 交接 URL 后整页导航——首页是 WebView history
   * 首项,Android 硬件返回与客户端里的「断开」都会回到这里。
   */

  // 迷你 i18n:首页只有十几条文案,不值得引入 renderer 的 i18n 基建;跟随系统
  // 语言一次定型(web-main.ts 同款兜底逻辑)。
  const zh = navigator.language.startsWith('zh');
  const t = {
    scan: zh ? '扫码连接' : 'Scan to Connect',
    scanHint: zh
      ? '扫桌面端「连接手机」二维码,或 headless 终端里的二维码'
      : "Scan the desktop's pairing QR or a headless server QR",
    address: zh ? '服务地址' : 'Server Address',
    addressPlaceholder: zh ? '192.168.1.5:8642' : '192.168.1.5:8642',
    connect: zh ? '连接' : 'Connect',
    recent: zh ? '最近连接' : 'Recent',
    empty: zh ? '还没有连接记录' : 'No connections yet',
    badCode: zh ? '不是 KepCup 配对码或服务地址' : 'Not a KepCup pairing code or server URL',
    scanUnsupported: zh
      ? '此环境不支持扫码,请手动输入地址'
      : 'Scanning is unavailable here — enter the address instead',
    scanDenied: zh ? '相机权限被拒绝,请在系统设置里开启' : 'Camera permission denied',
    scanFailed: zh ? '扫码失败,请重试或手动输入地址' : 'Scan failed — retry or enter the address',
    offline: zh
      ? (input: string) => `连不上 ${input}——服务可能没开机,仍要试试吗?`
      : (input: string) => `Cannot reach ${input}. Try anyway?`,
    confirm: zh ? '仍然连接' : 'Connect Anyway',
    cancel: zh ? '取消' : 'Cancel',
    connecting: zh ? '连接中…' : 'Connecting…',
    confirmTarget: zh ? '连接到以下设备/服务?' : 'Connect to this device/server?',
    clearAll: zh ? '清空' : 'Clear',
    footer: zh
      ? '连接后进入所连设备托管的遥控界面;配对在桌面端确认'
      : 'Connects to the paired desktop or headless server; confirm pairing on the host',
  };

  let addressInput = $state('');
  let inputError = $state<null | 'bad-code'>(null);
  let scanMessage = $state<string | null>(null);
  let connecting = $state(false);
  let pendingProbe = $state(false);

  const SCAN_MESSAGE: Record<Exclude<ScanFailure, 'cancelled'>, string> = {
    unsupported: t.scanUnsupported,
    denied: t.scanDenied,
    failed: t.scanFailed,
  };

  /**
   * 交接导航:先构建 URL 再置位(构建不会抛,但抛错会永久禁用按钮);首页留在
   * history 首项,返回语义由壳与客户端共同保证(D122 §3)。
   */
  function connect(target: ConnectTarget): void {
    const homeUrl = `${window.location.origin}${window.location.pathname}`;
    const url = buildConnectUrl(target, homeUrl);
    connecting = true;
    window.location.href = url;
  }

  /** 记录到最近连接:持久化失败不阻塞导航(下次冷启动只是没有这条记录)。 */
  async function recordQuietly(raw: string): Promise<void> {
    try {
      await recentTargets.record(raw);
    } catch {
      // Preferences 写失败(存储满等):忽略。
    }
  }

  /**
   * 首次目标确认(审查修复):壳内 WebView 无地址栏,恶意二维码可把无防备的用户
   * 导去仿冒的登录页。不在最近连接里的目标,连接前展示 host 让用户确认;已知目标
   * (点最近连接/重复扫)不打扰。
   */
  function confirmNewTarget(target: ConnectTarget): boolean {
    if (recentTargets.list.some((item) => item.id === targetId(target))) return true;
    return window.confirm(`${t.confirmTarget}\n${targetLabel(target)}`);
  }

  async function handleScan(): Promise<void> {
    if (connecting) return;
    scanMessage = null;
    inputError = null;
    const result = await scanOnce();
    if (!result.ok) {
      if (result.reason !== 'cancelled') scanMessage = SCAN_MESSAGE[result.reason];
      return;
    }
    const target = resolveConnectTarget(result.text);
    if (target === null) {
      scanMessage = t.badCode;
      return;
    }
    if (!confirmNewTarget(target)) return;
    await recordQuietly(target.kind === 'pairing' ? target.sourceUrl : target.url);
    connect(target);
  }

  async function handleManual(): Promise<void> {
    if (connecting) return;
    scanMessage = null;
    inputError = null;
    const target = resolveConnectTarget(addressInput);
    if (target === null) {
      inputError = 'bad-code';
      return;
    }
    if (!confirmNewTarget(target)) return;
    await recordQuietly(addressInput);
    if (target.kind === 'server') {
      pendingProbe = true;
      const reachable = await probeReachable(target.url);
      pendingProbe = false;
      if (!reachable) {
        // 不通给一次明确确认:服务可能没开机,防手滑连错地址(仍然允许连)。
        if (!window.confirm(t.offline(target.url))) return;
      }
    }
    connect(target);
  }

  async function handleRecent(item: RecentTarget): Promise<void> {
    if (connecting) return;
    scanMessage = null;
    inputError = null;
    // raw 已在 init 逐项校验为 string,resolveConnectTarget 不会抛;null = 数据被篡改
    // 成了可解析但失效的形态:移除坏条目,不给入口。
    const target = resolveConnectTarget(item.raw);
    if (target === null) {
      await recentTargets.remove(item.id);
      return;
    }
    await recordQuietly(item.raw);
    connect(target);
  }
</script>

<div
  class="flex h-full flex-col gap-8 overflow-y-auto px-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]"
>
  <header class="flex items-center justify-between pt-2">
    <h1 class="text-xl font-semibold tracking-tight">KepCup</h1>
    <span class="text-xs text-zinc-400">{__KEPCUP_MOBILE_VERSION__}</span>
  </header>

  <main class="flex flex-col gap-8">
    <section class="flex flex-col items-center gap-3 text-center">
      <button
        type="button"
        class="flex h-16 w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 text-base font-medium text-white shadow-lg shadow-blue-600/25 active:bg-blue-700 disabled:opacity-50"
        onclick={() => void handleScan()}
        disabled={connecting || pendingProbe}
        data-testid="home-scan"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          class="size-6"
          aria-hidden="true"
        >
          <path
            d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"
          />
          <path d="M3 12h18" />
        </svg>
        {t.scan}
      </button>
      <p class="text-xs text-zinc-400">{t.scanHint}</p>
      {#if scanMessage !== null}
        <p class="text-xs text-red-500" data-testid="home-scan-message">{scanMessage}</p>
      {/if}
    </section>

    <section class="flex flex-col gap-2">
      <h2 class="text-sm font-medium text-zinc-500">{t.address}</h2>
      <form
        class="flex gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          void handleManual();
        }}
      >
        <input
          class="h-11 min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-900"
          type="text"
          inputmode="url"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder={t.addressPlaceholder}
          bind:value={addressInput}
          data-testid="home-address"
        />
        <button
          type="submit"
          class="h-11 shrink-0 rounded-xl bg-zinc-900 px-5 text-sm font-medium text-white active:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:active:bg-zinc-300"
          disabled={connecting || pendingProbe || addressInput.trim().length === 0}
          data-testid="home-connect"
        >
          {pendingProbe ? t.connecting : t.connect}
        </button>
      </form>
      {#if inputError !== null}
        <p class="text-xs text-red-500" data-testid="home-address-error">{t.badCode}</p>
      {/if}
    </section>

    <section class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium text-zinc-500">{t.recent}</h2>
        {#if recentTargets.list.length > 0}
          <button
            type="button"
            class="text-xs text-zinc-400 hover:text-zinc-600"
            onclick={() => void recentTargets.clear()}
            data-testid="home-recent-clear"
          >
            {t.clearAll}
          </button>
        {/if}
      </div>
      {#if recentTargets.list.length === 0}
        <p
          class="rounded-xl border border-dashed border-zinc-200 p-4 text-center text-xs text-zinc-400 dark:border-zinc-800"
        >
          {t.empty}
        </p>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each recentTargets.list as item (item.id)}
            <li
              class="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <button
                type="button"
                class="min-w-0 flex-1 text-left"
                onclick={() => void handleRecent(item)}
                data-testid={`home-recent-${item.kind}`}
              >
                <span class="block truncate text-sm font-medium">{item.label}</span>
                <span class="block truncate text-xs text-zinc-400">
                  {item.kind === 'pairing' ? (zh ? '配对' : 'Pairing') : zh ? '服务' : 'Server'}
                </span>
              </button>
              <button
                type="button"
                class="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:text-red-500"
                aria-label="remove"
                onclick={() => void recentTargets.remove(item.id)}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  class="size-4"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </main>

  <footer class="mt-auto pt-4">
    <p class="text-center text-[11px] leading-relaxed text-zinc-400">{t.footer}</p>
  </footer>
</div>
