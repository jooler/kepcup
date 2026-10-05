<script lang="ts">
  import { Download, X, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { mediaViewer, isLocalMedia } from './media-viewer.svelte';
  import { attachmentUrl, downloadAttachment } from './attachments.svelte';

  /**
   * 媒体灯箱（docs/design/20-conversation-media.md）：全屏遮罩 + 缩放平移
   * （图片）/播放器（音视频）/下载。全局单例，挂 ChatView，状态在
   * media-viewer.svelte.ts。已发送附件的字节加载用模板级
   * {#await attachmentUrl(current)}（attachmentUrl 内置 LRU 缓存，灯箱与
   * 消息气泡共享同一份 objectURL）；待发送附件直接用自带本地 objectURL。
   */

  // 图片缩放/平移；scale=1 即适配窗口。{#key current?.id} 在切换附件时复位。
  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let dragging = $state(false);

  const current = $derived(mediaViewer.current);
  const kind = $derived(
    current === null
      ? 'file'
      : current.mime.startsWith('video/')
        ? 'video'
        : current.mime.startsWith('audio/')
          ? 'audio'
          : 'image',
  );
  // 待发送附件自带 objectURL，无需按 id 拉字节。
  const currentUrl = $derived(
    current === null
      ? Promise.resolve('')
      : isLocalMedia(current)
        ? Promise.resolve(current.url)
        : attachmentUrl(current),
  );

  function zoomBy(factor: number): void {
    scale = Math.min(8, Math.max(1, scale * factor));
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
  }

  function resetView(): void {
    scale = 1;
    tx = 0;
    ty = 0;
  }

  function onWheel(event: WheelEvent): void {
    if (kind !== 'image') return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  let lastPointer: { x: number; y: number } | null = null;

  function onPointerDown(event: PointerEvent): void {
    if (kind !== 'image' || scale === 1) return;
    dragging = true;
    lastPointer = { x: event.clientX, y: event.clientY };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging || lastPointer === null) return;
    tx += event.clientX - lastPointer.x;
    ty += event.clientY - lastPointer.y;
    lastPointer = { x: event.clientX, y: event.clientY };
  }

  function onPointerUp(): void {
    dragging = false;
    lastPointer = null;
  }

  function onDoubleClick(): void {
    if (kind !== 'image') return;
    if (scale > 1) resetView();
    else scale = 2.5;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!mediaViewer.open) return;
    if (event.key === 'Escape') mediaViewer.close();
    if (event.key === 'ArrowRight') mediaViewer.step(1);
    if (event.key === 'ArrowLeft') mediaViewer.step(-1);
  }

  async function download(): Promise<void> {
    if (current === null) return;
    if (isLocalMedia(current)) {
      // 本地文件尚未入库：<a download> 指向本地 objectURL 即可。
      const anchor = document.createElement('a');
      anchor.href = current.url;
      anchor.download = current.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      return;
    }
    await downloadAttachment(current);
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if mediaViewer.open && current}
  <!-- 背板：点击空白处关闭；媒体区阻止冒泡 -->
  <div
    class="fixed inset-0 z-50 flex flex-col bg-black/85"
    data-testid="lightbox"
    onclick={() => mediaViewer.close()}
    onwheel={onWheel}
    role="presentation"
  >
    <!-- 顶栏 -->
    <div
      class="flex items-center justify-between px-4 py-3 text-white"
      onclick={(event) => event.stopPropagation()}
      role="presentation"
    >
      <div class="flex items-center gap-2 text-sm text-white/80">
        <span>{current.fileName}</span>
        {#if mediaViewer.items.length > 1}
          <span class="text-white/50">{mediaViewer.index + 1}/{mediaViewer.items.length}</span>
        {/if}
      </div>
      <div class="flex items-center gap-1">
        {#if kind === 'image'}
          <span class="mr-1 w-12 text-center text-xs text-white/70">{Math.round(scale * 100)}%</span
          >
          <Button
            variant="ghost"
            size="icon"
            class="size-8 text-white hover:bg-white/15 hover:text-white"
            onclick={() => zoomBy(1 / 1.25)}
            aria-label={t('lightbox.zoomOut')}
            data-testid="lightbox-zoom-out"
          >
            <ZoomOut class="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="size-8 text-white hover:bg-white/15 hover:text-white"
            onclick={() => zoomBy(1.25)}
            aria-label={t('lightbox.zoomIn')}
            data-testid="lightbox-zoom-in"
          >
            <ZoomIn class="size-4" />
          </Button>
        {/if}
        <Button
          variant="ghost"
          size="icon"
          class="size-8 text-white hover:bg-white/15 hover:text-white"
          onclick={() => void download()}
          aria-label={t('lightbox.download')}
          data-testid="lightbox-download"
        >
          <Download class="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="size-8 text-white hover:bg-white/15 hover:text-white"
          onclick={() => mediaViewer.close()}
          aria-label={t('lightbox.close')}
          data-testid="lightbox-close"
        >
          <X class="size-4" />
        </Button>
      </div>
    </div>

    <!-- 媒体区 -->
    <div
      class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 pb-6"
      onclick={(event) => event.stopPropagation()}
      role="presentation"
    >
      {#key current.id}
        {#await currentUrl}
          <p class="text-sm text-white/50">{t('lightbox.loading')}</p>
        {:then url}
          {#if kind === 'image'}
            <img
              src={url}
              alt={current.fileName}
              class="max-h-full max-w-full select-none {dragging
                ? 'cursor-grabbing'
                : scale > 1
                  ? 'cursor-grab'
                  : 'cursor-zoom-in'}"
              style="transform: translate({tx}px, {ty}px) scale({scale}); transform-origin: center;"
              draggable="false"
              onpointerdown={onPointerDown}
              onpointermove={onPointerMove}
              onpointerup={onPointerUp}
              onpointercancel={onPointerUp}
              ondblclick={onDoubleClick}
              data-testid="lightbox-image"
            />
          {:else if kind === 'video'}
            <!-- svelte-ignore a11y_media_has_caption --><!-- 生成的视频无字幕轨道可挂 -->
            <video
              src={url}
              controls
              autoplay
              class="max-h-full max-w-full rounded-md"
              data-testid="lightbox-video"
            ></video>
          {:else}
            <div class="w-full max-w-xl rounded-xl bg-white/10 p-6 backdrop-blur">
              <p class="mb-3 truncate text-center text-sm text-white/80">{current.fileName}</p>
              <audio src={url} controls autoplay class="w-full" data-testid="lightbox-audio"
              ></audio>
            </div>
          {/if}
        {:catch}
          <p class="text-sm text-white/70">{t('lightbox.loadFailed')}</p>
        {/await}
      {/key}

      {#if mediaViewer.items.length > 1}
        {#if mediaViewer.index > 0}
          <button
            type="button"
            class="absolute left-2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onclick={() => {
              mediaViewer.step(-1);
              resetView();
            }}
            aria-label={t('lightbox.prev')}
            data-testid="lightbox-prev"
          >
            <ChevronLeft class="size-5" />
          </button>
        {/if}
        {#if mediaViewer.index < mediaViewer.items.length - 1}
          <button
            type="button"
            class="absolute right-2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onclick={() => {
              mediaViewer.step(1);
              resetView();
            }}
            aria-label={t('lightbox.next')}
            data-testid="lightbox-next"
          >
            <ChevronRight class="size-5" />
          </button>
        {/if}
      {/if}
    </div>
  </div>
{/if}
