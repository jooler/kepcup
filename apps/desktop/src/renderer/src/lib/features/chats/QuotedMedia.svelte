<script lang="ts">
  import type { Attachment } from '@kepcup/shared';
  import { Image as ImageIcon, Paperclip, Play } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import type { PersistedAttachment } from './composer-draft-persist';
  import { attachmentUrl, downloadAttachment } from './attachments.svelte';
  import { mediaViewer } from './media-viewer.svelte';

  /**
   * 引用块里的被引用附件（引用回复，消息行引用块与 composer 引用条共用）：
   * 图片渲染小缩略图（点击灯箱看大图）；视频先出占位（点击加载后进灯箱）；
   * 其余附件与解码失败的图片回退图标 chip（点击下载）。字节走
   * attachments.svelte.ts 的共享 LRU（消息附件与灯箱同一份 objectURL）。
   * 输入是 ComposerReplyRef / Message.attachments 映射出的轻量元数据——
   * 引用快照只有 attachmentId + 元数据，灯箱用 Attachment 兼容对象按 id
   * 经 attachments.get 取字节。
   */
  let { attachments }: { attachments: PersistedAttachment[] } = $props();

  type LoadState = { url: string | null; failed: boolean };
  const loaded = $state<Record<string, LoadState>>({});

  /** 灯箱媒体组（图片 + 视频；灯箱按 mime 渲染并按需拉字节）。 */
  const mediaItems = $derived(
    attachments
      .filter((a) => a.mime.startsWith('image/') || a.mime.startsWith('video/'))
      .map((a) => toAttachment(a)),
  );

  function toAttachment(ref: PersistedAttachment): Attachment {
    // attachments.get 按 id 取字节，其余字段仅灯箱头显 / 下载用，填默认值。
    return {
      id: ref.attachmentId,
      conversationId: '',
      messageId: null,
      fileName: ref.fileName,
      mime: ref.mime,
      size: ref.size,
      sha256: '',
      relPath: '',
      createdAt: 0,
    };
  }

  function stateOf(ref: PersistedAttachment): LoadState {
    return loaded[ref.attachmentId] ?? { url: null, failed: false };
  }

  function ensureLoaded(ref: PersistedAttachment): void {
    if (loaded[ref.attachmentId] !== undefined) return;
    loaded[ref.attachmentId] = { url: null, failed: false };
    attachmentUrl(toAttachment(ref))
      .then((url) => {
        loaded[ref.attachmentId] = { url, failed: false };
      })
      .catch(() => {
        loaded[ref.attachmentId] = { url: null, failed: true };
      });
  }

  function openLightbox(ref: PersistedAttachment): void {
    const index = mediaItems.findIndex((item) => item.id === ref.attachmentId);
    mediaViewer.show(mediaItems, Math.max(0, index));
  }

  // 图片缩略图挂载即加载（svg 等不可解码格式由 <img> onerror 回退 chip）。
  $effect(() => {
    for (const ref of attachments) {
      if (ref.mime.startsWith('image/')) ensureLoaded(ref);
    }
  });
</script>

<span class="inline-flex items-center gap-1">
  {#each attachments as ref (ref.attachmentId)}
    {@const state = stateOf(ref)}
    {@const isImage = ref.mime.startsWith('image/')}
    {@const isVideo = ref.mime.startsWith('video/')}
    {#if isImage && !state.failed}
      <button
        type="button"
        class="shrink-0 overflow-hidden rounded-md border border-border/50"
        onclick={() => openLightbox(ref)}
        data-testid="quoted-media-image"
        aria-label={t('attachments.openPreview', { name: ref.fileName })}
      >
        {#if state.url !== null}
          <img
            src={state.url}
            alt={ref.fileName}
            class="size-7 object-cover"
            loading="lazy"
            onerror={() => (loaded[ref.attachmentId] = { url: null, failed: true })}
          />
        {:else}
          <span class="flex size-7 items-center justify-center bg-muted/40">
            <ImageIcon class="size-3.5 animate-pulse text-muted-foreground" />
          </span>
        {/if}
      </button>
    {:else if isVideo && !state.failed}
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-black/80 text-white"
        onclick={() => openLightbox(ref)}
        data-testid="quoted-media-video"
        aria-label={t('attachments.playVideo', { name: ref.fileName })}
      >
        <Play class="size-3.5" />
      </button>
    {:else}
      <button
        type="button"
        class="flex shrink-0 items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
        onclick={() => void downloadAttachment(toAttachment(ref))}
        data-testid="quoted-media-chip"
      >
        <Paperclip class="size-3" />
        <span class="max-w-32 truncate">{ref.fileName}</span>
      </button>
    {/if}
  {/each}
</span>
