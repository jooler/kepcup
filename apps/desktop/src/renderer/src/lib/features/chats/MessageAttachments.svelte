<script lang="ts">
  import type { Component } from 'svelte';
  import type { Attachment } from '@kepcup/shared';
  import {
    AudioLines,
    Download,
    Film,
    Image as ImageIcon,
    Paperclip,
    Play,
    type LucideIcon,
  } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { attachmentUrl, downloadAttachment } from './attachments.svelte';
  import { mediaViewer } from './media-viewer.svelte';

  /**
   * 消息附件行（docs/design/20-conversation-media.md）：按 mime 大类内联
   * 渲染——图片缩略图（点击灯箱）、音视频点击加载后内联播放、文件 chip
   * 点击下载。字节经 attachments.svelte.ts 的共享缓存（灯箱复用）。
   * svg 等浏览器不可解码的图片格式由 <img> onerror 回退文件 chip。
   */
  let { attachments }: { attachments: Attachment[] } = $props();

  type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

  function kindOf(mime: string): AttachmentKind {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'file';
  }

  const KIND_ICONS: Record<AttachmentKind, LucideIcon> = {
    image: ImageIcon,
    video: Film,
    audio: AudioLines,
    file: Paperclip,
  };

  /** 同一条消息里可进灯箱的媒体（图片/视频；文件与音频不进——灯箱按媒体渲染，
   * 文件条目会被当作图片渲染出破图）。 */
  const mediaItems = $derived(
    attachments.filter((a) => kindOf(a.mime) === 'image' || kindOf(a.mime) === 'video'),
  );

  function sizeLabel(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
  }

  // --- 逐附件的加载态（字节按需拉取） ---------------------------------------

  type LoadState = { url: string | null; failed: boolean };
  const loaded = $state<Record<string, LoadState>>({});

  function stateOf(attachment: Attachment): LoadState {
    return loaded[attachment.id] ?? { url: null, failed: false };
  }

  function ensureLoaded(attachment: Attachment): void {
    if (loaded[attachment.id] !== undefined) return;
    loaded[attachment.id] = { url: null, failed: false };
    attachmentUrl(attachment)
      .then((url) => {
        loaded[attachment.id] = { url, failed: false };
      })
      .catch(() => {
        loaded[attachment.id] = { url: null, failed: true };
      });
  }

  function openLightbox(attachment: Attachment): void {
    const index = mediaItems.findIndex((item) => item.id === attachment.id);
    mediaViewer.show(mediaItems, Math.max(0, index));
  }

  /** 图片加载失败（svg/HEIC 等浏览器不可解码）→ 回退文件 chip。 */
  function markImageFailed(attachment: Attachment): void {
    loaded[attachment.id] = { url: null, failed: true };
  }

  // 图片缩略图挂载即加载（音视频保持点击加载，避免大文件自动下载）。
  $effect(() => {
    for (const attachment of attachments) {
      if (kindOf(attachment.mime) === 'image') ensureLoaded(attachment);
    }
  });
</script>

<div class="mt-1 flex flex-wrap gap-1">
  {#each attachments as attachment (attachment.id)}
    {@const kind = kindOf(attachment.mime)}
    {@const state = stateOf(attachment)}
    {#if kind === 'image' && !state.failed}
      <button
        type="button"
        class="group relative overflow-hidden rounded-xl border border-border/50"
        onclick={() => openLightbox(attachment)}
        data-testid="attachment-image"
        aria-label={t('attachments.openPreview', { name: attachment.fileName })}
      >
        {#if state.url !== null}
          <img
            src={state.url}
            alt={attachment.fileName}
            class="max-h-56 min-h-16 max-w-64 min-w-16 object-cover"
            loading="lazy"
            onerror={() => markImageFailed(attachment)}
          />
        {:else}
          <div
            class="flex h-28 w-44 items-center justify-center bg-muted/40"
            data-testid="attachment-image-loading"
          >
            <ImageIcon class="size-5 animate-pulse text-muted-foreground" />
          </div>
        {/if}
      </button>
    {:else if kind === 'video'}
      {#if state.url !== null}
        <!-- svelte-ignore a11y_media_has_caption --><!-- 生成的视频无字幕轨道可挂 -->
        <div
          class="overflow-hidden rounded-xl border border-border/50"
          data-testid="attachment-video"
        >
          <video src={state.url} controls class="max-h-64 max-w-80"></video>
        </div>
      {:else if state.failed}
        {@render fileChip({
          kind: 'video',
          fileName: attachment.fileName,
          onDownload: () => void downloadAttachment(attachment),
        })}
      {:else}
        <button
          type="button"
          class="relative flex h-24 w-44 items-center justify-center overflow-hidden rounded-xl border border-border/50 bg-black/80 text-white"
          onclick={() => ensureLoaded(attachment)}
          data-testid="attachment-video-placeholder"
          aria-label={t('attachments.playVideo', { name: attachment.fileName })}
        >
          <Play class="size-8" />
          <span class="absolute bottom-1 left-2 text-[10px] text-white/80">
            {attachment.fileName} · {sizeLabel(attachment.size)}
          </span>
        </button>
      {/if}
    {:else if kind === 'audio'}
      {#if state.url !== null}
        <div
          class="flex w-72 flex-col gap-1 rounded-xl border bg-background/60 px-3 py-2"
          data-testid="attachment-audio"
        >
          <span class="truncate text-[11px] text-muted-foreground">{attachment.fileName}</span>
          <audio src={state.url} controls class="h-8 w-full"></audio>
        </div>
      {:else if state.failed}
        {@render fileChip({
          kind: 'audio',
          fileName: attachment.fileName,
          onDownload: () => void downloadAttachment(attachment),
        })}
      {:else}
        <button
          type="button"
          class="flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          onclick={() => ensureLoaded(attachment)}
          data-testid="attachment-audio-placeholder"
        >
          <AudioLines class="size-3.5" />
          {attachment.fileName} · {sizeLabel(attachment.size)}
        </button>
      {/if}
    {:else}
      {@render fileChip({
        kind: 'file',
        fileName: attachment.fileName,
        size: attachment.size,
        onDownload: () => void downloadAttachment(attachment),
      })}
    {/if}
  {/each}
</div>

{#snippet fileChip(props: {
  kind: AttachmentKind;
  fileName: string;
  size?: number;
  onDownload: () => void;
})}
  {@const Icon = KIND_ICONS[props.kind] as unknown as Component<{ class?: string }>}
  <button
    type="button"
    class="group flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
    onclick={props.onDownload}
    data-testid="attachment-chip"
  >
    <Icon class="size-3" />
    <span class="max-w-48 truncate">{props.fileName}</span>
    {#if props.size !== undefined}
      <span class="text-[10px] opacity-70">{sizeLabel(props.size)}</span>
    {/if}
    <Download class="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
  </button>
{/snippet}
