<script lang="ts">
  import { core } from '$lib/rpc/client.svelte';
  import ReconnectBanner from './ReconnectBanner.svelte';
  import NoModelBanner from '$lib/features/onboarding/NoModelBanner.svelte';
  import UnattendedBanner from '$lib/features/approvals/UnattendedBanner.svelte';
  import { narrowLayout } from './narrow-layout.svelte';

  /**
   * 全局顶部浮层通知（重连 / 无模型 / 无人值守）：固定定位、不参与主布局高度，
   * 避免把 h-screen 的应用撑出滚动条。三条同时成立时纵向堆叠，不互相遮挡。
   *
   * 「无模型」只在核心真正可用时提示：锁屏 / 核心错误页 / 断连重连期间
   * 设置快照可能仍是旧值，药丸浮在全屏状态页之上只会误导（这些页面自身
   * 已说明发生了什么）。窄屏下仍只出现在「对话」tab（其它 tab 不依赖模型），
   * 与原先挂在 NarrowShell 对话页时的可见范围一致。
   */
  const coreUsable = $derived(
    core.connection === 'connected' && core.coreStatus?.status === 'ready',
  );
  const showNoModel = $derived(
    coreUsable && (!narrowLayout.narrow || narrowLayout.tab === 'chats'),
  );
</script>

<div
  class="pointer-events-none fixed inset-x-0 top-3 z-40 flex flex-col items-center gap-2 px-4"
  data-testid="top-banners"
>
  {#if core.connection === 'reconnecting'}
    <ReconnectBanner />
  {/if}
  {#if showNoModel}
    <NoModelBanner />
  {/if}
  <UnattendedBanner />
</div>
