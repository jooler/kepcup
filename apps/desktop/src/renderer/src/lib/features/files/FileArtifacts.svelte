<script lang="ts">
  import type { Component } from 'svelte';
  import type { MessageArtifact } from '@kepcup/shared';
  import {
    ChevronDown,
    ChevronUp,
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
    type ArtifactKind,
  } from './artifact-kind';

  /**
   * The cards under a Bot reply for the local files it created / modified
   * (screenshot reference: one row per file, click opens the overlay). The
   * first few stay visible; a longer list folds behind「还有 N 个」so a batch
   * task cannot dominate the transcript.
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
    text: FileCode2,
    other: FileIcon,
  };

  let expanded = $state(false);
  const shown = $derived(expanded ? artifacts : artifacts.slice(0, COLLAPSED_COUNT));
  const hidden = $derived(Math.max(0, artifacts.length - shown.length));
</script>

{#if artifacts.length > 0}
  <div class="mt-2 flex w-full flex-col gap-1.5" data-testid="message-artifacts">
    {#each shown as artifact (artifact.path)}
      {@const kind = artifactKindOf(artifact.path)}
      {@const Icon = KIND_ICONS[kind] as unknown as Component<{ class?: string }>}
      <button
        type="button"
        class="group flex w-full items-center gap-3 rounded-[16px] border bg-background/70 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
        title={artifact.path}
        onclick={() => fileViewer.show(artifact, conversationId)}
        data-testid="message-artifact-card"
        data-kind={kind}
      >
        <span
          class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"
        >
          <Icon class="size-5" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium" data-testid="message-artifact-name"
            >{artifact.name}</span
          >
          <span class="block truncate text-xs text-muted-foreground">
            {t(artifactKindLabelKey(kind))}
            <span class="mx-1 opacity-50">·</span>
            {t(artifact.change === 'created' ? 'files.change.created' : 'files.change.modified')}
            {#if artifact.size !== undefined}
              <span class="mx-1 opacity-50">·</span>
              {formatFileSize(artifact.size)}
            {/if}
          </span>
        </span>
      </button>
    {/each}
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
