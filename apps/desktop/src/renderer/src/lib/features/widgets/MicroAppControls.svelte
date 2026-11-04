<script lang="ts">
  import { Globe, Mic, MicOff, Maximize2, Minimize2, Square, WifiOff } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import type { MicroAppCardSummary } from '@kepcup/shared';

  /**
   * 微应用外壳控件（55 §3.3 / §7.3）：常驻网络徽标（点击展开「它能访问什么」）、
   * 麦克风指示 / 会话授权开关、全屏键（inline ⇄ immersive）、停止键。覆盖层
   * （WidgetViewer）与独立窗口（WidgetWindowApp）共用同一份实现——这些是 55 号
   * 规定的外壳提示面，任何宿主形态都不可缺，也不允许两处实现漂移。
   * 这层不占微应用 iframe 的 DOM，微应用无法覆盖或伪造。
   */
  let {
    microApp,
    micGranted,
    displayMode,
    testidPrefix,
    /** 卡片变化时重置本控件内部的展开态（外层把 messageId 传进来）。 */
    resetKey,
    onToggleMic,
    onToggleDisplayMode,
    onStopAudio,
  }: {
    microApp: MicroAppCardSummary;
    micGranted: boolean;
    displayMode: 'inline' | 'immersive';
    testidPrefix: string;
    resetKey?: string | number;
    onToggleMic: () => void;
    onToggleDisplayMode: () => void;
    onStopAudio: () => void;
  } = $props();

  let netInfoOpen = $state(false);
  $effect(() => {
    void resetKey;
    netInfoOpen = false;
  });
</script>

<!-- 常驻网络徽标（55 §3.3）：微应用无法隐藏或伪造；点击展开访问范围。 -->
<div class="relative">
  <button
    type="button"
    class="flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    onclick={() => (netInfoOpen = !netInfoOpen)}
    aria-label={t('botWidget.microApp.netBadge')}
    title={t('botWidget.microApp.netBadge')}
    data-testid="{testidPrefix}-net-badge"
  >
    {#if microApp.netMode === 'none'}
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
      data-testid="{testidPrefix}-net-info"
    >
      {#if microApp.netMode === 'open'}
        {t('botWidget.microApp.netInfoOpen')}
      {:else if microApp.netMode === 'none'}
        {t('botWidget.microApp.netInfoNone')}
      {:else}
        {t('botWidget.microApp.netInfoAllowlist', {
          domains: microApp.netAllowlist.join('、'),
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
  onclick={onToggleMic}
  aria-label={micGranted ? t('botWidget.microApp.micOn') : t('botWidget.microApp.micOff')}
  title={micGranted ? t('botWidget.microApp.micOn') : t('botWidget.microApp.micOff')}
  aria-pressed={micGranted}
  data-testid="{testidPrefix}-mic"
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
  onclick={onToggleDisplayMode}
  aria-label={t('botWidget.microApp.displayMode')}
  title={t('botWidget.microApp.displayMode')}
  data-testid="{testidPrefix}-display-mode"
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
  onclick={onStopAudio}
  aria-label={t('botWidget.microApp.stop')}
  title={t('botWidget.microApp.stop')}
  data-testid="{testidPrefix}-stop"
>
  <Square class="size-4" aria-hidden="true" />
</button>
