<script lang="ts">
  import { Download, ExternalLink, FolderOpen, X } from '@lucide/svelte';
  import { Portal } from 'bits-ui';
  import { toast } from 'svelte-sonner';
  import {
    FILE_APP_SCHEME,
    filePreviewSessionOutputSchema,
  } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { sidebarLayout } from '$lib/features/sidebar/sidebar-layout.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { ESCAPE_PRIORITY, registerEscapeLayer } from '$lib/features/shell/escape-layers';
  import Markdown from '$lib/features/chats/Markdown.svelte';
  import { fileViewer } from './file-viewer.svelte';
  import {
    artifactKindLabelKey,
    artifactKindOf,
    extensionOf,
    formatFileSize,
    isTextualKind,
  } from './artifact-kind';
  import {
    base64ObjectUrl,
    base64ToArrayBuffer,
    base64ToBytes,
    decodeBase64Text,
    loadFilePreview,
    type FilePreviewPayload,
  } from './file-preview';

  /**
   * Bot file artifact overlay: fills the middle + right columns (the left
   * sidebar stays visible), closes from the round button at its top-left.
   * Files are read on demand and rendered by kind: image / video, HTML as a
   * full WebApp (directory preview protocol, scripts and network enabled,
   * isolated by the sandboxed iframe on its own kepcup-file origin),
   * Markdown, DOCX, XLSX and plain text. PDF and other formats without a
   * suitable in-app renderer show an actions panel (open with the system app /
   * download) instead of a blank frame.
   */
  const current = $derived(fileViewer.current);
  const artifact = $derived(current?.artifact ?? null);
  const kind = $derived(artifact === null ? 'other' : artifactKindOf(artifact.path));
  const extension = $derived(artifact === null ? '' : extensionOf(artifact.path));

  let loading = $state(false);
  let error = $state<string | null>(null);
  let payload = $state<FilePreviewPayload | null>(null);
  let text = $state('');
  let objectUrl = $state<string | null>(null);
  let docxHtml = $state<string | null>(null);
  let sheets = $state<Array<{ name: string; rows: unknown[][] }>>([]);
  let activeSheet = $state(0);
  let closeButton = $state<HTMLButtonElement | null>(null);
  /** HTML 的目录预览会话（kepcup-file 源）；其余类型不走这条通道。 */
  let htmlSession = $state<{ token: string; size: number } | null>(null);

  const left = $derived(narrowLayout.narrow ? '0px' : `${sidebarLayout.effectiveWidth}px`);
  // 窄屏时本浮层盖住整窗，mac 红绿灯叠在 header 左上角，关闭按钮要右移让位。
  const isMac = /Mac/i.test(navigator.platform);
  /** HTML 入口 = 协议 URL 的路径段（所在目录在 core 侧已按 artifact 路径登记）。 */
  const htmlEntry = $derived(
    artifact === null ? '' : (artifact.path.split(/[\\/]/).pop() ?? ''),
  );

  $effect(() => {
    const request = current;
    const file = request?.artifact ?? null;
    payload = null;
    error = null;
    text = '';
    objectUrl = null;
    docxHtml = null;
    sheets = [];
    activeSheet = 0;
    htmlSession = null;
    if (request === null || file === null) return;

    let cancelled = false;
    let createdUrl: string | null = null;
    loading = true;
    void (async () => {
      try {
        if (kind === 'html') {
          // 完整 WebApp 档：不把字节拉进渲染层，页面与相对资源由 kepcup-file 协议按需服务。
          const session = filePreviewSessionOutputSchema.parse(
            await core.call('files.previewSession', {
              conversationId: request.conversationId,
              path: file.path,
            }),
          );
          if (!cancelled) htmlSession = session;
          return;
        }
        const data = await loadFilePreview(request.conversationId, file.path);
        if (cancelled) return;
        payload = data;
        if (kind === 'image' || kind === 'video' || kind === 'pdf') {
          createdUrl = base64ObjectUrl(data.dataBase64, data.mime);
          objectUrl = createdUrl;
        } else if (isTextualKind(kind)) {
          text = decodeBase64Text(data.dataBase64);
        } else if (kind === 'document' && extension === '.docx') {
          const mammoth = await import('mammoth');
          const result = await mammoth.convertToHtml({
            arrayBuffer: base64ToArrayBuffer(data.dataBase64),
          });
          if (!cancelled) docxHtml = result.value;
        } else if (kind === 'spreadsheet' && extension !== '.csv') {
          const XLSX = await import('xlsx');
          const workbook = XLSX.read(base64ToBytes(data.dataBase64), {
            type: 'array',
          });
          const parsed = workbook.SheetNames.slice(0, 20).map((name) => {
            const sheet = workbook.Sheets[name];
            const rows =
              sheet === undefined
                ? []
                : XLSX.utils.sheet_to_json<unknown[]>(sheet, {
                    header: 1,
                    raw: false,
                    defval: '',
                  });
            return { name, rows: rows.slice(0, 500) };
          });
          if (!cancelled) sheets = parsed;
        } else if (kind === 'spreadsheet' && extension === '.csv') {
          text = decodeBase64Text(data.dataBase64);
        }
      } catch (cause) {
        if (!cancelled) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl !== null) URL.revokeObjectURL(createdUrl);
    };
  });

  // 切换会话时文件卡属于旧对话：直接关闭，避免把旧会话文件继续展示在新会话上。
  $effect(() => {
    const conversationId = chat.currentId;
    if (fileViewer.current !== null && fileViewer.current.conversationId !== conversationId) {
      fileViewer.close();
    }
  });

  // 非模态覆盖层：打开时把焦点移到关闭按钮，关闭时还给原来的元素。
  $effect(() => {
    if (!fileViewer.open) return;
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() => closeButton?.focus());
    return () => previous?.focus?.();
  });

  $effect(() => {
    if (!fileViewer.open) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.lightbox,
      onEscape: () => fileViewer.close(),
    });
  });

  function close(event?: MouseEvent): void {
    event?.stopPropagation();
    fileViewer.close();
  }

  function download(): void {
    if (payload === null || artifact === null) return;
    const url = objectUrl ?? base64ObjectUrl(payload.dataBase64, payload.mime);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    if (objectUrl === null) setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  async function openWithSystem(): Promise<void> {
    if (artifact === null) return;
    try {
      await window.kepcup.openPath(artifact.path);
    } catch {
      toast.error(t('files.openFailed'));
    }
  }

  async function revealInFolder(): Promise<void> {
    if (artifact === null) return;
    try {
      await window.kepcup.showItemInFolder(artifact.path);
    } catch {
      toast.error(t('files.revealFailed'));
    }
  }
</script>

{#snippet actionsPanel(message: string)}
  <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
    <p class="text-sm text-muted-foreground">{message}</p>
    <p class="max-w-xl text-xs break-all text-muted-foreground">{artifact?.path}</p>
    {#if payload !== null}
      <p class="text-xs text-muted-foreground">{formatFileSize(payload.size)}</p>
    {/if}
    <div class="mt-1 flex flex-wrap justify-center gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
        onclick={() => void openWithSystem()}
        data-testid="file-viewer-open-system"
      >
        <ExternalLink class="size-3.5" aria-hidden="true" />
        {t('files.openExternal')}
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
        onclick={download}
        data-testid="file-viewer-download-panel"
      >
        <Download class="size-3.5" aria-hidden="true" />
        {t('files.download')}
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
        onclick={() => void revealInFolder()}
        data-testid="file-viewer-reveal-panel"
      >
        <FolderOpen class="size-3.5" aria-hidden="true" />
        {t('files.reveal')}
      </button>
    </div>
  </div>
{/snippet}

{#if fileViewer.open && artifact !== null}
  <Portal>
    <div
      class="app-no-drag fixed inset-y-0 right-0 z-50 flex flex-col bg-background"
      style:left
      role="dialog"
      aria-label={artifact.name}
      data-testid="file-viewer"
      data-kind={kind}
    >
      <!-- 顶部即工具栏高度：header 自身是拖拽区（本浮层不挂 data-window-overlay，
           全局拖拽带不会盖住顶部），空白处拖窗口；文本与按钮挂 app-no-drag 不被
           拖拽占用。高度与按钮留空对齐左栏顶部容器（h-14 + size-9 居中，上下各
           10px）；圆形关闭按钮沿用左栏顶部按钮的样式。 -->
      <header
        class="app-drag relative flex h-14 shrink-0 items-center justify-center border-b bg-background px-20"
      >
        <button
          bind:this={closeButton}
          type="button"
          class="app-no-drag absolute top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-none transition-colors hover:text-foreground
            {narrowLayout.narrow && isMac ? 'left-20' : 'left-4'}"
          onclick={close}
          aria-label={t('files.close')}
          title={t('files.close')}
          data-testid="file-viewer-close"
        >
          <X class="size-5" aria-hidden="true" />
        </button>
        <div class="app-no-drag min-w-0 px-24 text-center">
          <div class="truncate text-sm font-medium" data-testid="file-viewer-title">
            {artifact.name}
          </div>
          <div class="truncate text-[11px] text-muted-foreground">
            {t(artifactKindLabelKey(kind))}
            {#if payload !== null || htmlSession !== null}
              <span class="mx-1 opacity-50">·</span>
              {formatFileSize(payload?.size ?? htmlSession?.size)}
            {/if}
          </div>
        </div>
        {#if payload !== null || htmlSession !== null}
          <div class="app-no-drag absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-1">
            <button
              type="button"
              class="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onclick={() => void revealInFolder()}
              aria-label={t('files.reveal')}
              title={t('files.reveal')}
              data-testid="file-viewer-reveal"
            >
              <FolderOpen class="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onclick={() => void openWithSystem()}
              aria-label={t('files.openExternal')}
              title={t('files.openExternal')}
              data-testid="file-viewer-open-external"
            >
              <ExternalLink class="size-4" aria-hidden="true" />
            </button>
            {#if payload !== null}
              <button
                type="button"
                class="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onclick={download}
                aria-label={t('files.download')}
                title={t('files.download')}
                data-testid="file-viewer-download"
              >
                <Download class="size-4" aria-hidden="true" />
              </button>
            {/if}
          </div>
        {/if}
      </header>

      <div class="relative min-h-0 flex-1 overflow-hidden">
        {#if loading}
          <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('files.loading')}
          </div>
        {:else if error !== null}
          <div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <p class="text-sm text-destructive">{t('files.loadFailed')}</p>
            <p class="max-w-lg text-xs break-all text-muted-foreground">{error}</p>
          </div>
        {:else if kind === 'image' && objectUrl !== null}
          <div class="flex h-full items-center justify-center bg-muted/30 p-6">
            <img
              src={objectUrl}
              alt={artifact.name}
              class="max-h-full max-w-full object-contain"
              data-testid="file-viewer-image"
            />
          </div>
        {:else if kind === 'video' && objectUrl !== null}
          <div class="flex h-full items-center justify-center bg-black p-6">
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              src={objectUrl}
              controls
              autoplay
              class="max-h-full max-w-full"
              data-testid="file-viewer-video"
            ></video>
          </div>
        {:else if kind === 'html' && htmlSession !== null}
          <!-- 完整 WebApp 档（kepcup-file://，docs/design/47）：脚本、网络、相对路径资源、
               localStorage 全部可用；隔离靠 sandbox 属性（无弹窗 / 无顶层导航 / 无下载）+
               独占协议源（与宿主不同源，碰不到 window.kepcup 与父窗口）。 -->
          <iframe
            title={artifact.name}
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
            referrerpolicy="no-referrer"
            src={`${FILE_APP_SCHEME}://${htmlSession.token}/${encodeURIComponent(htmlEntry)}`}
            class="min-h-0 w-full h-full flex-1 border-0 bg-white"
            data-testid="file-viewer-html"
          ></iframe>
        {:else if kind === 'markdown'}
          <div class="h-full overflow-auto">
            <div class="mx-auto max-w-4xl px-8 py-8">
              <div class="streamdown-wrap text-sm">
                <Markdown content={text} />
              </div>
            </div>
          </div>
        {:else if kind === 'pdf' && objectUrl !== null}
          <embed
            src={objectUrl}
            type="application/pdf"
            class="h-full w-full border-0"
            data-testid="file-viewer-pdf"
          />
        {:else if kind === 'document' && docxHtml !== null}
          <div class="h-full overflow-auto bg-white text-black">
            <div class="docx-preview mx-auto max-w-4xl px-8 py-8 text-sm">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- mammoth output is a local document body -->
              {@html docxHtml}
            </div>
          </div>
        {:else if kind === 'spreadsheet' && sheets.length > 0}
          <div class="flex h-full min-h-0 flex-col">
            {#if sheets.length > 1}
              <div class="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2">
                {#each sheets as sheet, index (sheet.name)}
                  <button
                    type="button"
                    class="rounded-full px-3 py-1 text-xs transition-colors {index === activeSheet
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent'}"
                    onclick={() => (activeSheet = index)}>{sheet.name}</button
                  >
                {/each}
              </div>
            {/if}
            <div class="min-h-0 flex-1 overflow-auto">
              <table class="w-full border-collapse text-xs">
                <tbody>
                  {#each sheets[activeSheet]?.rows ?? [] as row, r (r)}
                    <tr class="even:bg-muted/40">
                      {#each row as cell, c (c)}
                        <td class="border-r border-b px-2 py-1 whitespace-nowrap"
                          >{String(cell ?? '')}</td
                        >
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {:else if kind === 'spreadsheet' && text.length > 0}
          <div class="h-full overflow-auto p-6">
            <pre class="text-xs whitespace-pre-wrap">{text}</pre>
          </div>
        {:else if kind === 'text'}
          <div class="h-full overflow-auto">
            <pre
              class="min-h-full p-6 font-mono text-xs leading-relaxed whitespace-pre-wrap">{text}</pre>
          </div>
        {:else}
          {@render actionsPanel(t('files.unsupported'))}
        {/if}
      </div>
    </div>
  </Portal>
{/if}
