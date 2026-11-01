<script lang="ts">
  import { Pause, Play } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { AudioPlayerState, formatAudioDuration } from './audio-player.svelte';

  /**
   * 统一 H5 音频播放器（docs/design/53-voice-conversation.md 修订 v2 V2-2）：
   * 用户语音 wav 附件与 Bot 音频文件产物共用——播放/暂停键 + 可点进度条 +
   * 时长，点击切换。本组件只做展示（内部一个无控件的 <audio>，preload 取
   * 元数据好先出时长），卡片外壳由宿主提供（附件卡 / 产物卡各自的样式）。
   */
  let {
    src,
    name,
    testId,
  }: {
    src: string;
    /** 展示名（附件文件名 / 产物名；省略则只留时间）。 */
    name?: string;
    /** 容器 testid；播放键与进度条在其下加 -toggle / -seek。 */
    testId?: string;
  } = $props();

  const player = new AudioPlayerState();
  let element = $state<HTMLAudioElement | null>(null);
  $effect(() => {
    player.attach(element);
  });

  function seek(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    player.seekToFraction((event.clientX - rect.left) / rect.width);
  }

  const label = $derived(
    player.status === 'playing' ? t('audioPlayer.pause') : t('audioPlayer.play'),
  );
</script>

<!-- 无控件 <audio> 只作播放源：交互（播放/暂停/进度）由上方按钮承载 -->
<audio bind:this={element} {src} preload="metadata" class="hidden"></audio>
<div class="flex w-full min-w-0 flex-col gap-1.5">
  <div class="flex items-center gap-2">
    <button
      type="button"
      class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary transition-colors hover:bg-primary/20"
      onclick={() => player.toggle()}
      aria-label={label}
      title={label}
      data-testid={testId !== undefined ? `${testId}-toggle` : undefined}
    >
      {#if player.status === 'playing'}
        <Pause class="size-3.5" aria-hidden="true" />
      {:else}
        <Play class="size-3.5" aria-hidden="true" />
      {/if}
    </button>
    {#if name !== undefined}
      <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{name}</span>
    {:else}
      <span class="min-w-0 flex-1"></span>
    {/if}
    <span class="shrink-0 text-[10px] text-muted-foreground tabular-nums">
      {formatAudioDuration(player.currentTime)} / {formatAudioDuration(player.duration)}
    </span>
  </div>
  <button
    type="button"
    class="group relative h-2.5 w-full"
    onclick={seek}
    aria-label={t('audioPlayer.seek')}
    data-testid={testId !== undefined ? `${testId}-seek` : undefined}
  >
    <span class="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted"></span>
    <span
      class="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-primary"
      style="width:{player.progress * 100}%"
    ></span>
  </button>
</div>
