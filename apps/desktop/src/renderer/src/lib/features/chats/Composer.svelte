<script lang="ts">
  import { ArrowUp, Loader2, Paperclip, Reply, X } from '@lucide/svelte';
  import type { Bot } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { resolveComposerAction } from './key-handling';
  import DraftQueue from './DraftQueue.svelte';

  let {
    readOnly = false,
    centered = false,
    readOnlyHint,
  }: { readOnly?: boolean; centered?: boolean; readOnlyHint?: string } = $props();

  let text = $state('');
  let isComposing = $state(false);
  /**
   * 药丸两态（参考 Grok Bot）：单行时按钮与输入同行、输入不占满宽度；
   * 内容增多即将换行时输入占满整行、按钮移到底部。
   */
  let multiline = $state(false);
  /** Structured mentions accumulated via the @ popup (P05). */
  let mentions: string[] = $state([]);
  /** @ popup state: open + the query text typed after the '@'. */
  let mentionOpen = $state(false);
  let mentionQuery = $state('');
  let mentionIndex = $state(0);
  let textareaEl: HTMLTextAreaElement | null = $state(null);
  /** 待发送附件（docs/design/20-conversation-media.md）：选中即上传，随下一条草稿发出。 */
  let pendingUploads = $state<PendingUpload[]>([]);
  let fileInputEl: HTMLInputElement | null = $state(null);
  let dragOver = $state(false);

  interface PendingUpload {
    key: string;
    fileName: string;
    mime: string;
    size: number;
    state: 'uploading' | 'ready' | 'error';
    attachmentId: string | null;
  }

  const drafts = $derived(chat.current?.drafts ?? []);
  const isGroup = $derived(chat.current?.conversation.type === 'group');
  const replyTo = $derived(chat.replyTo);
  const replyToName = $derived(
    replyTo === null
      ? ''
      : replyTo.senderType === 'user'
        ? t('sidebar.userName')
        : replyTo.senderBotId
          ? chat.botName(replyTo.senderBotId)
          : '',
  );
  /** 引用预览去掉常见强调标记（**），其余 Markdown 原样截断。 */
  const replyToText = $derived(
    replyTo === null || !('text' in replyTo.content)
      ? ''
      : replyTo.content.text.slice(0, 60).replace(/\*\*/g, ''),
  );

  const hasContent = $derived(text.trim().length > 0 || pendingUploads.length > 0);

  const placeholder = $derived(
    drafts.length > 0
      ? t('composer.queuePlaceholder')
      : isGroup
        ? t('composer.mentionPlaceholder')
        : t('composer.placeholder'),
  );

  // 切换会话时清掉未发送的附件；已上传/在途的字节调 detach 善后，避免在原
  // 会话留下无主附件行与文件（untrack：这里不追踪 pendingUploads，否则每次
  // 上传状态变化都会触发本 effect 清空 chip）。
  $effect(() => {
    void chat.current?.conversation.id;
    untrack(() => {
      const leftovers = pendingUploads;
      if (leftovers.length === 0) return;
      pendingUploads = [];
      for (const entry of leftovers) {
        void discardUpload(entry).catch(() => {});
      }
    });
  });

  // 内容变化后测量实际行高：field-sizing 让 textarea 随内容增高，
  // scrollHeight 超过单行（约 40px + 容差）即进入多行形态。
  $effect(() => {
    void text;
    queueMicrotask(() => {
      const el = textareaEl;
      if (!el) return;
      multiline = el.scrollHeight > 48;
    });
  });

  /** Members matching the query typed after '@'; already-mentioned ones hidden. */
  const candidates = $derived.by(() => {
    if (!mentionOpen) return [] as Bot[];
    const memberBots = (chat.current?.members ?? []).map((m) => m.bot);
    const query = mentionQuery.trim().toLowerCase();
    return memberBots.filter(
      (bot) =>
        !mentions.includes(bot.id) &&
        (query.length === 0 ||
          bot.name.toLowerCase().includes(query) ||
          bot.id.toLowerCase().includes(query)),
    );
  });

  function onInput(): void {
    if (!isGroup) return;
    // Open the popup when the caret is right after an '@' (possibly with a
    // query); close when the '@' is gone.
    const match = /@([^@]*)$/.exec(text);
    if (match) {
      mentionOpen = true;
      mentionQuery = match[1] ?? '';
      mentionIndex = 0;
    } else {
      mentionOpen = false;
    }
  }

  function pick(bot: Bot): void {
    mentions = [...mentions, bot.id];
    text = text.replace(/@([^@]*)$/, `@${bot.name} `);
    mentionOpen = false;
    mentionQuery = '';
    textareaEl?.focus();
  }

  function removeMention(botId: string): void {
    const bot = (chat.current?.members ?? []).find((m) => m.bot.id === botId)?.bot;
    mentions = mentions.filter((id) => id !== botId);
    if (bot) {
      const token = `@${bot.name} `;
      const index = text.lastIndexOf(token);
      if (index >= 0) text = text.slice(0, index) + text.slice(index + token.length);
    }
  }

  function onMentionKeydown(event: KeyboardEvent): boolean {
    if (!mentionOpen || candidates.length === 0) return false;
    if (event.key === 'ArrowDown') {
      mentionIndex = (mentionIndex + 1) % candidates.length;
      return true;
    }
    if (event.key === 'ArrowUp') {
      mentionIndex = (mentionIndex - 1 + candidates.length) % candidates.length;
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const bot = candidates[mentionIndex];
      if (bot) pick(bot);
      return true;
    }
    if (event.key === 'Escape') {
      mentionOpen = false;
      return true;
    }
    return false;
  }

  async function handleKeydown(event: KeyboardEvent): Promise<void> {
    if (readOnly) return;
    if (onMentionKeydown(event)) {
      event.preventDefault();
      return;
    }
    const action = resolveComposerAction({
      key: event.key,
      meta: event.metaKey || event.ctrlKey,
      shift: event.shiftKey,
      isComposing: isComposing || event.isComposing || event.keyCode === 229,
      hasText: text.trim().length > 0,
      hasAttachments: pendingUploads.length > 0,
      queueLength: drafts.length,
    });
    if (action === 'none' || action === 'newline') return;
    event.preventDefault();
    if (action === 'add-draft') {
      const current = text;
      text = '';
      await addCurrent(current);
    } else if (action === 'flush') {
      await chat.flush();
    } else if (action === 'add-and-flush') {
      const current = text;
      text = '';
      if (current.trim().length > 0 || pendingUploads.length > 0) await addCurrent(current);
      await chat.flush();
    }
  }

  /** Adds a draft carrying the structured mentions + reply reference + attachments. */
  async function addCurrent(current: string): Promise<void> {
    const attachmentIds = await settlePendingUploads();
    const trimmed = current.trim();
    if (trimmed.length === 0 && attachmentIds.length === 0) return;
    await chat.addDraft(trimmed, {
      ...(mentions.length > 0 ? { mentions: [...mentions] } : {}),
      ...(replyTo !== null ? { replyTo: replyTo.id } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    });
    mentions = [];
  }

  async function onSendClick(): Promise<void> {
    if (readOnly) return;
    if (hasContent) {
      const current = text;
      text = '';
      await addCurrent(current);
    } else if (drafts.length > 0) {
      await chat.flush();
    }
  }

  // --- 附件上传（docs/design/20-conversation-media.md） ----------------------

  const MAX_UPLOAD_BYTES = 30_000_000;

  function pickFiles(): void {
    fileInputEl?.click();
  }

  function onPickedFiles(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    void uploadFiles(input.files ?? []);
    input.value = '';
  }

  function onPaste(event: ClipboardEvent): void {
    const files = event.clipboardData?.files;
    if (files !== undefined && files.length > 0) {
      event.preventDefault();
      void uploadFiles(files);
    }
  }

  function onDrop(event: DragEvent): void {
    dragOver = false;
    const files = event.dataTransfer?.files;
    if (files !== undefined && files.length > 0) {
      event.preventDefault();
      void uploadFiles(files);
    }
  }

  // 每个 chip 的上传任务（key → 完成后的 attachmentId，失败为 null）。
  // 普通 Map（刻意非响应式）：这是任务管道，没有界面从它派生。
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const uploadTasks = new Map<string, Promise<string | null>>();

  /** 移除 chip / 切换会话的善后：等在途上传落定后把附件行与文件清掉，
   * 不在会话里留无主附件（此前只删本地状态，孤儿要等删会话才级联清理）。 */
  async function discardUpload(entry: PendingUpload): Promise<void> {
    const task = uploadTasks.get(entry.key);
    const id = entry.attachmentId ?? (task !== undefined ? await task.catch(() => null) : null);
    if (id !== null) await chat.detachAttachment(id);
  }

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    const conversationId = chat.current?.conversation.id;
    if (!conversationId) return;
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(t('composer.attachmentTooLarge', { name: file.name }));
        continue;
      }
      const entry: PendingUpload = {
        key: `up_${Math.random().toString(36).slice(2)}_${Date.now()}`,
        fileName: file.name.length > 0 ? file.name : 'pasted-image.png',
        mime: file.type.length > 0 ? file.type : guessMime(file.name),
        size: file.size,
        state: 'uploading',
        attachmentId: null,
      };
      pendingUploads = [...pendingUploads, entry];
      const patch = (next: PendingUpload): void => {
        // $state 数组里的对象是深代理：必须按 key 替换整个条目才触发更新
        //（直接改 push 前的原始对象对界面不可见）。
        pendingUploads = pendingUploads.map((upload) => (upload.key === next.key ? next : upload));
      };
      const task = (async (): Promise<string | null> => {
        try {
          const bytesBase64 = await fileToBase64(file);
          const result = (await core.call('attachments.upload', {
            conversationId,
            fileName: entry.fileName,
            mime: entry.mime,
            bytesBase64,
          })) as { attachment: { id: string } };
          patch({ ...entry, state: 'ready', attachmentId: result.attachment.id });
          return result.attachment.id;
        } catch {
          patch({ ...entry, state: 'error' });
          toast.error(t('composer.attachmentUploadFailed', { name: entry.fileName }));
          return null;
        }
      })();
      uploadTasks.set(entry.key, task);
    }
  }

  /** 等待在途上传完成，返回可发送的附件 id。已就绪/失败的条目从 chip 区移除；
   * 超时仍未完成的保留在原地（随下一条草稿发出或手动移除），不再静默丢弃。 */
  async function settlePendingUploads(): Promise<string[]> {
    for (let guard = 0; guard < 600; guard += 1) {
      if (!pendingUploads.some((upload) => upload.state === 'uploading')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const ids = pendingUploads
      .filter((upload) => upload.state === 'ready' && upload.attachmentId !== null)
      .map((upload) => upload.attachmentId as string);
    pendingUploads = pendingUploads.filter((upload) => upload.state === 'uploading');
    return ids;
  }

  function removePendingUpload(key: string): void {
    const entry = pendingUploads.find((upload) => upload.key === key);
    pendingUploads = pendingUploads.filter((upload) => upload.key !== key);
    if (entry !== undefined) void discardUpload(entry).catch(() => {});
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const comma = dataUrl.indexOf(',');
        resolve(comma >= 0 ? dataUrl.slice(comma + 1) : '');
      };
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  const MIME_BY_EXTENSION: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.zip': 'application/zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };

  function guessMime(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return MIME_BY_EXTENSION[fileName.slice(dot).toLowerCase()] ?? 'application/octet-stream';
  }
</script>

<div class="{centered ? 'pt-3' : ''} px-4 pb-3" data-testid="composer">
  {#if readOnly}
    <div class="mx-auto w-full max-w-3xl">
      <div
        class="rounded-3xl border border-dashed bg-muted/40 px-3 py-3 text-center text-sm text-muted-foreground"
        data-testid="composer-readonly"
      >
        {readOnlyHint ?? t('composer.readOnly')}
      </div>
    </div>
  {:else}
    <div class="mx-auto w-full max-w-3xl">
      <div class="relative flex flex-col">
        {#if mentionOpen && candidates.length > 0}
          <ul
            class="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-64 overflow-y-auto rounded-md border bg-background shadow-md"
            data-testid="mention-popup"
          >
            {#each candidates as bot, index (bot.id)}
              <li>
                <button
                  type="button"
                  class="w-full px-3 py-1.5 text-left text-sm hover:bg-accent {index ===
                  mentionIndex
                    ? 'bg-accent'
                    : ''}"
                  onclick={() => pick(bot)}
                  data-testid={`mention-candidate-${bot.id}`}
                >
                  @{bot.name}
                  <span class="ml-1 text-xs text-muted-foreground">{bot.bio}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        <!-- 待发送抽屉：待发送行不内嵌进输入坞，而是从输入坞背后向上伸出——
             底边下移一个圆角半径（-mb-6）塞进输入坞背后被压住，左上/右上圆角
             与输入坞一致、底部直角（藏在输入坞后），底部一个圆角半径的内边距
             让草稿文字停在输入坞上边缘之上、不被盖住；仅在有待发送内容时出现 -->
        {#if drafts.length > 0}
          <div
            class="-mb-6 rounded-t-3xl border bg-background px-1 pt-1 pb-7 shadow-sm"
            data-testid="draft-drawer"
          >
            <DraftQueue {drafts} />
          </div>
        {/if}
        <!-- 输入坞（参考 Grok）：引用条 / @ 提及 / 待发送附件内嵌在圆角容器里，
             待发送抽屉从容器背后向上伸出；输入区垫底；单行＝输入与按钮同行，
             多行＝输入占满整宽、按钮沉底。背景用 surface-raised（比背景亮一级），
             relative 保证压在抽屉上层；粘贴/拖拽文件即上传附件 -->
        <div
          class="relative flex flex-col gap-1 rounded-3xl border bg-surface-raised pr-1.5 pl-2 shadow-sm transition-colors focus-within:border-ring/40 {dragOver
            ? 'border-ring/60'
            : ''}"
          data-testid="composer-pill"
          data-multiline={multiline ? 'true' : 'false'}
          role="group"
          onpaste={onPaste}
          ondragover={(event) => {
            event.preventDefault();
            dragOver = true;
          }}
          ondragleave={() => (dragOver = false)}
          ondrop={onDrop}
        >
          <input
            type="file"
            multiple
            class="hidden"
            bind:this={fileInputEl}
            onchange={onPickedFiles}
            data-testid="composer-file-input"
          />
          {#if pendingUploads.length > 0}
            <div class="flex flex-wrap gap-1 px-1 pt-2" data-testid="composer-pending-attachments">
              {#each pendingUploads as upload (upload.key)}
                <span
                  class="flex items-center gap-1 rounded-full border bg-background/80 py-1 pr-1 pl-2.5 text-xs text-muted-foreground
                    {upload.state === 'error' ? 'border-destructive/50 text-destructive' : ''}"
                  data-testid={`pending-attachment-${upload.state}`}
                >
                  {#if upload.state === 'uploading'}
                    <Loader2 class="size-3 animate-spin" aria-hidden="true" />
                  {:else}
                    <Paperclip class="size-3" aria-hidden="true" />
                  {/if}
                  <span class="max-w-40 truncate">{upload.fileName}</span>
                  <button
                    type="button"
                    class="shrink-0 rounded-full p-0.5 hover:bg-accent"
                    onclick={() => removePendingUpload(upload.key)}
                    aria-label={t('composer.attachmentRemove')}
                  >
                    <X class="size-3" />
                  </button>
                </span>
              {/each}
            </div>
          {/if}
          {#if replyTo}
            <div
              class="mt-2 flex items-center gap-2 rounded-full border bg-background/80 py-1.5 pr-1 pl-2.5 text-xs text-muted-foreground"
              data-testid="reply-preview"
            >
              <Reply class="size-3.5 shrink-0" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">
                {t('composer.replying', { name: replyToName, text: replyToText })}
              </span>
              <button
                type="button"
                class="shrink-0 rounded-full p-1 hover:bg-accent"
                onclick={() => chat.cancelReply()}
                data-testid="reply-cancel"
                aria-label={t('composer.replyCancel')}
              >
                <X class="size-3" />
              </button>
            </div>
          {/if}
          {#if mentions.length > 0}
            <div class="flex flex-wrap gap-1 px-1" data-testid="mention-tags">
              {#each mentions as botId (botId)}
                <span
                  class="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                >
                  @{chat.botName(botId)}
                  <button
                    type="button"
                    class="rounded-full p-0.5 hover:bg-primary/20"
                    onclick={() => removeMention(botId)}
                    data-testid={`mention-tag-remove-${botId}`}
                    aria-label={t('composer.replyCancel')}
                  >
                    <X class="size-3" />
                  </button>
                </span>
              {/each}
            </div>
          {/if}
          <div class="flex {multiline ? 'flex-col' : 'flex-row items-center'}">
            <Textarea
              bind:value={text}
              bind:ref={textareaEl}
              {placeholder}
              rows={1}
              class="max-h-40 min-h-10 resize-none border-none bg-transparent px-2 py-2.5 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent
                {multiline ? 'w-full' : 'w-auto min-w-0 flex-1'}"
              onkeydown={handleKeydown}
              oninput={onInput}
              oncompositionstart={() => (isComposing = true)}
              oncompositionend={() => (isComposing = false)}
              data-testid="composer-input"
            />
            <div class="flex items-center {multiline ? 'justify-end pt-0.5' : 'pr-0.5'}">
              <Button
                variant="ghost"
                size="icon"
                class="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                onclick={pickFiles}
                disabled={readOnly}
                aria-label={t('composer.attach')}
                data-testid="composer-attach"
              >
                <Paperclip class="size-4" />
              </Button>
              <Button
                size="icon"
                class="size-8 shrink-0 rounded-full"
                onclick={onSendClick}
                disabled={readOnly}
                data-testid="composer-send"
                aria-label={t('composer.send')}
              >
                <ArrowUp class="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
