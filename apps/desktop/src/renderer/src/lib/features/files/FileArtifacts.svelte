<script lang="ts">
  import type { Component } from 'svelte';
  import type { MessageArtifact } from '@kepcup/shared';
  import {
    AudioLines,
    ChevronDown,
    ChevronRight,
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
  import { listSeparator, t, type MessageKey } from '$lib/i18n';
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
   * modified / deleted: a collapsed header sums up the changes ("新增了 2 个
   * 文件、修改了 6 个文件"); expanding it lists one compact row per file —
   * icon + name on the left, kind / change / size on the right; click opens
   * the overlay. Audio artifacts stay outside the fold: their player row is
   * the reply itself, not a change summary.
   */

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

  const CHANGE_LABEL: Record<MessageArtifact['change'], MessageKey> = {
    created: 'files.change.created',
    modified: 'files.change.modified',
    deleted: 'files.change.deleted',
  };

  let expanded = $state(false);
  const audioArtifacts = $derived(artifacts.filter((artifact) => isAudioArtifact(artifact.path)));
  const fileArtifacts = $derived(artifacts.filter((artifact) => !isAudioArtifact(artifact.path)));

  const summary = $derived.by(() => {
    let created = 0;
    let modified = 0;
    let deleted = 0;
    for (const artifact of fileArtifacts) {
      if (artifact.change === 'created') created += 1;
      else if (artifact.change === 'deleted') deleted += 1;
      else modified += 1;
    }
    const parts: string[] = [];
    if (created > 0) parts.push(t('files.summary.created', { count: created }));
    if (modified > 0) parts.push(t('files.summary.modified', { count: modified }));
    if (deleted > 0) parts.push(t('files.summary.deleted', { count: deleted }));
    return parts.join(listSeparator());
  });

  function nameClassOf(change: MessageArtifact['change']): string {
    if (change === 'created') return 'text-emerald-600 dark:text-emerald-400';
    if (change === 'deleted')
      return 'text-red-600 underline underline-offset-2 decoration-red-500/50 dark:text-red-400 dark:decoration-red-400/50';
    return '';
  }

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
    for (const artifact of audioArtifacts) ensureArtifactAudio(artifact.path);
  });
</script>

{#snippet meta(artifact: MessageArtifact, kind: ArtifactKind)}
  <span
    class="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
    data-testid="message-artifact-meta"
  >
    {t(artifactKindLabelKey(kind))}
    <span class="mx-1 opacity-50">·</span>
    {t(CHANGE_LABEL[artifact.change])}
    {#if artifact.size !== undefined && artifact.change !== 'deleted'}
      <span class="mx-1 opacity-50">·</span>
      {formatFileSize(artifact.size)}
    {/if}
  </span>
{/snippet}

{#snippet fileRow(
  artifact: MessageArtifact,
  kind: ArtifactKind,
  Icon: Component<{ class?: string }>,
)}
  <span
    class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
  >
    <Icon class="size-3.5" />
  </span>
  <span
    class="min-w-0 flex-1 truncate text-[13px] font-medium {nameClassOf(artifact.change)}"
    data-testid="message-artifact-name">{artifact.name}</span
  >
  {@render meta(artifact, kind)}
{/snippet}

{#if artifacts.length > 0}
  <div class="mt-2 flex w-full flex-col gap-1" data-testid="message-artifacts">
    {#if audioArtifacts.length > 0}
      <div
        class="w-full overflow-hidden rounded-[14px] border bg-background/70 [&>*+*]:border-t [&>*+*]:border-border/60"
      >
        {#each audioArtifacts as artifact (artifact.path)}
          {@const kind = artifactKindOf(artifact.path)}
          {@const audioUrl = audioLoads[artifact.path]?.url ?? null}
          {#if audioUrl !== null}
            <!-- 音频产物（53 号修订 v2 V2-2）：同一 AudioPlayer 行；查看 / 下载走查看器。 -->
            <div
              class="flex w-full items-center gap-2.5 px-3 py-2"
              title={artifact.path}
              data-testid="message-artifact-audio"
              data-change={artifact.change}
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
              data-change={artifact.change}
              data-kind={kind}
            >
              {@render fileRow(
                artifact,
                kind,
                KIND_ICONS[kind] as unknown as Component<{ class?: string }>,
              )}
            </button>
          {/if}
        {/each}
      </div>
    {/if}

    {#if fileArtifacts.length > 0}
      <div class="w-full overflow-hidden rounded-[14px] border bg-background/70">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-accent/40"
          onclick={() => (expanded = !expanded)}
          aria-expanded={expanded}
          data-testid="message-artifacts-toggle"
        >
          {#if expanded}
            <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {:else}
            <ChevronRight class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {/if}
          <span
            class="min-w-0 truncate text-[13px] text-muted-foreground"
            data-testid="message-artifacts-summary">{summary}</span
          >
        </button>
        {#if expanded}
          <div
            class="border-t border-border/60 [&>*+*]:border-t [&>*+*]:border-border/60"
            data-testid="message-artifacts-list"
          >
            {#each fileArtifacts as artifact (artifact.path)}
              {@const kind = artifactKindOf(artifact.path)}
              {@const Icon = KIND_ICONS[kind] as unknown as Component<{ class?: string }>}
              {#if artifact.change === 'deleted'}
                <div
                  class="flex w-full items-center gap-2.5 px-3 py-1.5"
                  title={artifact.path}
                  data-testid="message-artifact-card"
                  data-change={artifact.change}
                  data-kind={kind}
                >
                  {@render fileRow(artifact, kind, Icon)}
                </div>
              {:else}
                <button
                  type="button"
                  class="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-accent/40"
                  title={artifact.path}
                  onclick={() => fileViewer.show(artifact, conversationId)}
                  data-testid="message-artifact-card"
                  data-change={artifact.change}
                  data-kind={kind}
                >
                  {@render fileRow(artifact, kind, Icon)}
                </button>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
