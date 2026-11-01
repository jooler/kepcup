<script lang="ts">
  import type { Component } from 'svelte';
  import type { MessageArtifact } from '@kepcup/shared';
  import {
    AudioLines,
    ChevronDown,
    ChevronUp,
    Expand,
    File as FileIcon,
    FileCode2,
    FileImage,
    FileSpreadsheet,
    FileText,
    FileVideo,
    Presentation,
    type LucideIcon,
  } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { fileViewer } from './file-viewer.svelte';
  import {
    artifactKindLabelKey,
    artifactKindOf,
    formatFileSize,
    isAudioArtifact,
    type ArtifactKind,
  } from './artifact-kind';
  import { base64ObjectUrl, loadFilePreview } from './file-preview';
  import AudioPlayer from '$lib/features/chats/AudioPlayer.svelte';

  /**
   * The single card under a Bot reply for the local files it created /
   * modified: one compact row per file — icon + name on the left, kind /
   * change / size on the right; click opens the overlay. The first few stay
   * visible; a longer list folds behind「还有 N 个」so a batch task cannot
   * dominate the transcript.
   */
  const COLLAPSED_COUNT = 6;

  let { artifacts, conversationId }: { artifacts: MessageArtifact[]; conversationId: string } =
    $props();

  const KIND_ICONS: Record<ArtifactKind, LucideIcon> = {
    image: FileImage,
    video: FileVideo,
    html: FileCode2,
    markdown: FileText,
    pdf: FileText,
    document: FileText,
    spreadsheet: FileSpreadsheet,
    presentation: Presentation,
    text: FileText,
    code: FileCode2,
    other: FileIcon,
  };

  let expanded = $state(false);
  const shown = $derived(expanded ? artifacts : artifacts.slice(0, COLLAPSED_COUNT));
  const hidden = $derived(Math.max(0, artifacts.length - shown.length));

  // --- 音频产物（53 号修订 v2 V2-2：TTS 语音回复直接可播） -------------------
  // 与 FileViewer 同一条字节通道（files.preview）；产物是本地文件、行数有限，
  // 展示即加载（进度 / 时长开箱即用），失败回退普通卡片（下载走查看器）。
  // objectURL 生命周期与 MessageAttachments 的附件行一致（组件内缓存，不主动
  // revoke，随页面回收）。

  type AudioLoad = { url: string | null; failed: boolean };
  const audioLoads = $state<Record<string, AudioLoad>>({});

  function ensureArtifactAudio(path: string): void {
    if (audioLoads[path] !== undefined) return;
    audioLoads[path] = { url: null, failed: false };
    void loadFilePreview(conversationId, path)
      .then((data) => {
        audioLoads[path] = { url: base64ObjectUrl(data.dataBase64, data.mime), failed: false };
      })
      .catch(() => {
        audioLoads[path] = { url: null, failed: true };
      });
  }

  $effect(() => {
    for (const artifact of shown) {
      if (isAudioArtifact(artifact.path)) ensureArtifactAudio(artifact.path);
    }
  });
</script>

{#if artifacts.length > 0}
  <div class="mt-2 flex w-full flex-col gap-1" data-testid="message-artifacts">
    <div
      class="w-full overflow-hidden rounded-[14px] border bg-background/70 [&>*+*]:border-t [&>*+*]:border-border/60"
    >
      {#each shown as artifact (artifact.path)}
        {@const kind = artifactKindOf(artifact.path)}
        {@const Icon = KIND_ICONS[kind] as unknown as Component<{ class?: string }>}
        {@const audioUrl = isAudioArtifact(artifact.path)
          ? (audioLoads[artifact.path]?.url ?? null)
          : null}
        {#if audioUrl !== null}
          <!-- 音频产物（53 号修订 v2 V2-2）：同一 AudioPlayer 行；查看 / 下载走查看器。 -->
          <div
            class="flex w-full items-center gap-2.5 px-3 py-2"
            title={artifact.path}
            data-testid="message-artifact-audio"
            data-kind={kind}
          >
            <span
              class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            >
              <AudioLines class="size-3.5" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <AudioPlayer
                src={audioUrl}
                name={artifact.name}
                testId="message-artifact-audio-player"
              />
            </div>
            <button
              type="button"
              class="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onclick={() => fileViewer.show(artifact, conversationId)}
              aria-label={t('attachments.openPreview', { name: artifact.name })}
              title={t('attachments.openPreview', { name: artifact.name })}
              data-testid="message-artifact-audio-viewer"
            >
              <Expand class="size-3.5" aria-hidden="true" />
            </button>
          </div>
        {:else}
          <button
            type="button"
            class="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-accent/40"
            title={artifact.path}
            onclick={() => fileViewer.show(artifact, conversationId)}
            data-testid="message-artifact-card"
            data-kind={kind}
          >
            <span
              class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            >
              <Icon class="size-3.5" />
            </span>
            <span
              class="min-w-0 flex-1 truncate text-[13px] font-medium"
              data-testid="message-artifact-name">{artifact.name}</span
            >
            <span
              class="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
              data-testid="message-artifact-meta"
            >
              {t(artifactKindLabelKey(kind))}
              <span class="mx-1 opacity-50">·</span>
              {t(artifact.change === 'created' ? 'files.change.created' : 'files.change.modified')}
              {#if artifact.size !== undefined}
                <span class="mx-1 opacity-50">·</span>
                {formatFileSize(artifact.size)}
              {/if}
            </span>
          </button>
        {/if}
      {/each}
    </div>
    {#if artifacts.length > COLLAPSED_COUNT}
      <button
        type="button"
        class="inline-flex items-center gap-1 self-start rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onclick={() => (expanded = !expanded)}
        data-testid="message-artifacts-toggle"
      >
        {#if expanded}
          <ChevronUp class="size-3" aria-hidden="true" />{t('files.collapse')}
        {:else}
          <ChevronDown class="size-3" aria-hidden="true" />{t('files.more', { count: hidden })}
        {/if}
      </button>
    {/if}
  </div>
{/if}
