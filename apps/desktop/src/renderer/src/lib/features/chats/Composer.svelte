<script lang="ts">
  import { ArrowUp, AudioLines, Loader2, Paperclip, Plus, Reply, X } from '@lucide/svelte';
  import type { Bot } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { resolveComposerAction } from './key-handling';
  import { mediaViewer, type LocalMedia } from './media-viewer.svelte';
  import { composerDrafts, type PendingUpload } from './composer-drafts.svelte';
  import DraftQueue from './DraftQueue.svelte';
  import {
    MAX_RECORDING_MS,
    MIN_RECORDING_MS,
    formatRecordingDuration,
    startVoiceRecording,
    type ActiveRecording,
    type VoiceRecording,
  } from './voice-recorder';
  import { sensors } from '$lib/sensors/sensors.svelte';
  import { SensorDisabledError } from '$lib/sensors/types';
  import { shell } from '$lib/stores/shell.svelte';

  let {
    readOnly = false,
    centered = false,
    readOnlyHint,
  }: { readOnly?: boolean; centered?: boolean; readOnlyHint?: string } = $props();

  let text = $state('');
  let isComposing = $state(false);
  /**
   * 药丸两态（参考 Grok Bot）：单行时附件键在最左、发送键在最右、输入居中
   * 占余宽；内容换行或有待发送附件时输入占满整行、附件键/发送键沉底两角。
   */
  let multiline = $state(false);
  /** Structured mentions accumulated via the @ popup (P05). */
  let mentions: string[] = $state([]);
  /** @ popup state: open + the query text typed after the '@'. */
  let mentionOpen = $state(false);
  let mentionQuery = $state('');
  let mentionIndex = $state(0);
  let textareaEl: HTMLTextAreaElement | null = $state(null);
  let fileInputEl: HTMLInputElement | null = $state(null);
  let dragOver = $state(false);

  // --- 语音输入（docs/design/26-voice-input.md）-------------------------------
  // 点击式录音（非长按）：输入框为空时右侧是语音键（点击开始录音），录音中
  // 原位变成「停止 + 计时 + 点点」胶囊（点击停止并转写填入输入框）。未配置
  // ASR 时点击置起对话内设置卡（isCapabilityReady 预检，core 错误码兜底）。
  // 语音对话模式（按住发音频消息）暂缓实现，入口隐藏。
  /** null = 未在录音。 */
  let recording = $state<{ level: number; startedAt: number } | null>(null);
  let recordingElapsed = $state(0);
  /** 识别进行中（停止后的异步尾巴，期间禁用再次开始）。 */
  let voiceBusy = $state(false);
  // 录音会话号：finish 使 in-flight 的 start（getUserMedia 授权等待期）失效。
  let recordingSession = 0;
  // 普通变量（刻意非响应式）：录音句柄，没有界面从它派生。
  let activeRecording: ActiveRecording | null = null;
  let maxRecordingTimer: ReturnType<typeof setTimeout> | null = null;

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
    replyTo === null ? '' : replyTo.text.slice(0, 60).replace(/\*\*/g, ''),
  );

  /**
   * 待发送附件（docs/design/20-conversation-media.md）：选中即上传，随下一
   * 条草稿发出。数据源在 composerDrafts（按会话缓存），组件只持视图——
   * 切换会话/重启应用后按会话重载，不再切换即丢弃。
   */
  const pendingUploads = $derived(composerDrafts.uploadsOf(chat.current?.conversation.id ?? ''));

  const hasContent = $derived(text.trim().length > 0 || pendingUploads.length > 0);

  /**
   * 沉底两态的开关：内容换行（multiline）或有待发送图片/文件时，输入占满
   * 整行、附件键与发送键沉到底部两角（参考 Grok 的图 2/图 3 形态）。
   */
  const stacked = $derived(multiline || pendingUploads.length > 0);

  const placeholder = $derived(
    drafts.length > 0
      ? t('composer.queuePlaceholder')
      : isGroup
        ? t('composer.mentionPlaceholder')
        : t('composer.placeholder'),
  );

  /**
   * 会话草稿的按会话缓存：进入会话先把缓存水合进本地状态（文本/提及/引用），
   * 之后内容变化即写回（composerDrafts 负责防抖落盘，附件走它自己的管道）。
   * 单个 effect 承担水合/保存两个分支：切换会话时水合分支先执行，避免旧
   * 会话的文本被写进新会话的缓存。
   */
  let activeConversationId: string | null = null;
  $effect(() => {
    const conversationId = chat.current?.conversation.id ?? null;
    // 依赖在每次运行都要读取（含水合分支）：Svelte 按次运行追踪，若只在保存
    // 分支读取，首跑走水合分支后键入将不触发本 effect，草稿永远不落盘。
    const currentText = text;
    const currentMentions = mentions;
    const currentReply = chat.replyTo;
    if (conversationId !== activeConversationId) {
      activeConversationId = conversationId;
      if (conversationId === null) return;
      untrack(() => {
        composerDrafts.hydrate(conversationId);
        const saved = composerDrafts.loadDraft(conversationId);
        text = saved.text;
        mentions = [...saved.mentions];
        chat.replyTo = saved.reply;
      });
      return;
    }
    if (conversationId === null) return;
    composerDrafts.saveComposerText(conversationId, currentText, currentMentions, currentReply);
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
    const conversationId = chat.current?.conversation.id;
    if (!conversationId) return;
    const attachmentIds = await composerDrafts.settle(conversationId);
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

  // --- 语音输入（docs/design/26-voice-input.md）-------------------------------

  $effect(() => {
    if (recording === null) return;
    const startedAt = recording.startedAt;
    const timer = setInterval(() => {
      recordingElapsed = Date.now() - startedAt;
    }, 200);
    return () => clearInterval(timer);
  });

  // 录音中 Esc 取消；组件卸载（切会话/关窗）丢弃录音并释放麦克风。
  $effect(() => {
    if (recording === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void finishRecording(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  $effect(() => () => {
    recordingSession += 1;
    if (maxRecordingTimer !== null) clearTimeout(maxRecordingTimer);
    activeRecording?.cancel();
    activeRecording = null;
  });

  // 录音中麦克风被停用（设置页取消勾选）：立即取消，hub 同时已切断轨道（D76-5）。
  $effect(() => {
    if (!sensors.state.microphone.enabled && recording !== null) void finishRecording(false);
  });

  function openHardwareSettings(): void {
    shell.openSettings('hardware');
  }

  async function startRecording(): Promise<void> {
    if (readOnly || recording !== null || voiceBusy) return;
    if (!settingsStore.isCapabilityReady('asr')) {
      chat.requestCapabilitySetup('asr');
      return;
    }
    const session = ++recordingSession;
    // 启用开关是隐私总闸（D76-5）：停用时不采集，提示去「设置 → 硬件」启用。
    if (!sensors.state.microphone.enabled) {
      toast.error(t('composer.micDisabled'), {
        action: { label: t('composer.micOpenHardware'), onClick: openHardwareSettings },
      });
      return;
    }
    // TCC 授权门：not-determined 时在这里拉起系统授权弹框；被拒后系统永远
    // 不会再弹，只能 toast + 深链系统设置（docs/design/26-voice-input.md）。
    let access: Awaited<ReturnType<typeof sensors.ensureAccess>>;
    try {
      access = await sensors.ensureAccess('microphone');
    } catch {
      toast.error(t('composer.voiceMicUnavailable'));
      return;
    }
    if (access !== 'granted') {
      if (access === 'denied') {
        toast.error(t('composer.micDenied'), {
          action: {
            label: t('composer.micOpenSettings'),
            onClick: () => sensors.openSettings('microphone'),
          },
        });
      } else {
        toast.error(t('composer.voiceMicUnavailable'));
      }
      return;
    }
    let fellBack: boolean;
    try {
      // 每次按录取当前设备偏好（设置页「硬件」分区可换设备；空 = 系统默认）。
      const opened = await sensors.open('microphone');
      try {
        activeRecording = await startVoiceRecording(opened.stream, (level) => {
          if (recording !== null) recording.level = level;
        });
      } catch (error) {
        for (const track of opened.stream.getTracks()) track.stop();
        throw error;
      }
      fellBack = opened.fellBack;
    } catch (error) {
      if (error instanceof SensorDisabledError) {
        toast.error(t('composer.micDisabled'), {
          action: { label: t('composer.micOpenHardware'), onClick: openHardwareSettings },
        });
        return;
      }
      // 失败原因透传（getUserMedia / addModule 的底层异常），定位设备问题用。
      toast.error(
        t('composer.voiceMicFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    if (session !== recordingSession) {
      // 授权弹框期间组件已卸载（finish 已跑）：立即释放刚拿到的麦克风。
      activeRecording.cancel();
      activeRecording = null;
      return;
    }
    // 所选设备不可用已回退系统默认：显式告知，不静默（D76）。
    if (fellBack) toast.warning(t('composer.micFellBack'));
    recording = { level: 0, startedAt: Date.now() };
    recordingElapsed = 0;
    // 60s 上限从真正开始采集起算（授权弹框期间不占时长）。
    maxRecordingTimer = setTimeout(() => void finishRecording(true), MAX_RECORDING_MS);
  }

  /** 点击胶囊/到时限=停止并转写（send）；Esc/组件卸载=取消丢弃。 */
  async function finishRecording(send: boolean): Promise<void> {
    recordingSession += 1;
    const current = recording;
    recording = null;
    if (maxRecordingTimer !== null) {
      clearTimeout(maxRecordingTimer);
      maxRecordingTimer = null;
    }
    const active = activeRecording;
    activeRecording = null;
    if (current === null || active === null) return;
    if (!send) {
      active.cancel();
      return;
    }
    voiceBusy = true;
    try {
      const result = await active.stop();
      if (result.durationMs < MIN_RECORDING_MS) {
        toast.error(t('composer.voiceTooShort'));
        return;
      }
      // 转写及其错误处理都在 transcribeIntoComposer 内；这里只兜停采/编码的失败。
      await transcribeIntoComposer(result);
    } catch (error) {
      toast.error(
        t('composer.voiceRecordFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      voiceBusy = false;
    }
  }

  function isCapabilityError(error: unknown): boolean {
    const code = (error as { code?: string } | undefined)?.code;
    return code === 'CAPABILITY_NOT_CONFIGURED' || code === 'PROVIDER_AUTH_FAILED';
  }

  /** mic 键路径：转写结果填入输入框（已有文本则追加）。 */
  async function transcribeIntoComposer(rec: VoiceRecording): Promise<void> {
    try {
      const result = (await core.call('media.transcribeSpeech', {
        audioBase64: rec.base64,
        audioMime: 'audio/wav',
      })) as { text: string };
      const transcript = result.text.trim();
      if (transcript.length === 0) {
        toast.error(t('composer.voiceNoSpeech'));
        return;
      }
      text = text.trim().length > 0 ? `${text.trimEnd()} ${transcript}` : transcript;
      textareaEl?.focus();
    } catch (error) {
      if (isCapabilityError(error)) {
        chat.requestCapabilitySetup('asr');
        return;
      }
      toast.error(
        errorText(
          (error as { code?: string } | undefined)?.code,
          t('composer.voiceTranscribeFailed'),
        ),
      );
    }
  }

  // 语音对话模式（按住发音频消息）暂缓实现：入口已隐藏，逻辑待后续恢复
  //（sendVoiceMessage / 语音条 UI 的设计见 docs/design/26-voice-input.md）。

  // --- 附件上传（docs/design/20-conversation-media.md） ----------------------
  // 上传管道在 composerDrafts（按会话缓存）；这里只负责收集文件与视图操作。

  function pickFiles(): void {
    fileInputEl?.click();
  }

  function onPickedFiles(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    uploadFiles(input.files ?? []);
    input.value = '';
  }

  function onPaste(event: ClipboardEvent): void {
    const files = event.clipboardData?.files;
    if (files !== undefined && files.length > 0) {
      event.preventDefault();
      uploadFiles(files);
    }
  }

  function onDrop(event: DragEvent): void {
    dragOver = false;
    const files = event.dataTransfer?.files;
    if (files !== undefined && files.length > 0) {
      event.preventDefault();
      uploadFiles(files);
    }
  }

  function uploadFiles(files: FileList | File[]): void {
    const conversationId = chat.current?.conversation.id;
    if (!conversationId) return;
    composerDrafts.uploadFiles(conversationId, files);
  }

  function removePendingUpload(key: string): void {
    const conversationId = chat.current?.conversation.id;
    if (!conversationId) return;
    void composerDrafts.removeUpload(conversationId, key);
  }

  /** 待发送图片缩略图 → 灯箱：直接喂本地 objectURL，上传未完成也可预览。 */
  function openPendingPreview(upload: PendingUpload): void {
    const items: LocalMedia[] = [];
    for (const entry of pendingUploads) {
      if (entry.previewUrl !== null) {
        items.push({
          local: true,
          id: entry.key,
          fileName: entry.fileName,
          mime: entry.mime,
          url: entry.previewUrl,
        });
      }
    }
    if (items.length === 0) return;
    const index = items.findIndex((item) => item.id === upload.key);
    mediaViewer.show(items, Math.max(0, index));
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
          class="relative flex flex-col gap-1 rounded-3xl border bg-surface-raised px-1.5 py-0.5 transition-colors focus-within:border-ring/40 {dragOver
            ? 'border-ring/60'
            : ''}"
          data-testid="composer-pill"
          data-multiline={stacked ? 'true' : 'false'}
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
            <div
              class="flex flex-wrap items-center gap-1.5 px-1 pt-2"
              data-testid="composer-pending-attachments"
            >
              {#each pendingUploads as upload (upload.key)}
                {#if upload.mime.startsWith('image/')}
                  <!-- 图片：缩略图形态（点击灯箱预览，不等上传完成），悬浮露出移除键。
                       重启水合的条目预览字节异步重建，就绪前显示加载态 -->
                  <div class="group relative" data-testid={`pending-attachment-${upload.state}`}>
                    <button
                      type="button"
                      class="block size-18 overflow-hidden rounded-xl border border-border/50 {upload.state ===
                      'error'
                        ? 'border-destructive'
                        : ''}"
                      onclick={() => openPendingPreview(upload)}
                      aria-label={t('attachments.openPreview', { name: upload.fileName })}
                      data-testid="pending-attachment-image"
                    >
                      {#if upload.previewUrl !== null}
                        <img
                          src={upload.previewUrl}
                          alt={upload.fileName}
                          class="size-full object-cover"
                          draggable="false"
                        />
                      {:else}
                        <Loader2
                          class="mx-auto size-4 animate-spin text-muted-foreground"
                          aria-hidden="true"
                        />
                      {/if}
                    </button>
                    {#if upload.state === 'uploading'}
                      <div
                        class="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40"
                      >
                        <Loader2 class="size-4 animate-spin text-white" aria-hidden="true" />
                      </div>
                    {/if}
                    <button
                      type="button"
                      class="absolute -top-1.5 -right-1.5 rounded-full bg-foreground/70 p-0.5 text-background opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onclick={() => removePendingUpload(upload.key)}
                      aria-label={t('composer.attachmentRemove')}
                      data-testid="pending-attachment-image-remove"
                    >
                      <X class="size-3" />
                    </button>
                  </div>
                {:else}
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
                {/if}
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
          {#snippet attachButton()}
            <Button
              variant="ghost"
              size="icon"
              class="size-8 shrink-0 rounded-full border-border text-muted-foreground hover:text-foreground"
              onclick={pickFiles}
              disabled={readOnly}
              aria-label={t('composer.attach')}
              data-testid="composer-attach"
            >
              <Plus class="size-4" />
            </Button>
          {/snippet}
          {#snippet sendButton()}
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
          {/snippet}
          <!-- 两态布局（参考 Grok）：单行＝附件键｜输入｜发送键；沉底＝输入
               占满整行，附件键/发送键落到底部两角 -->
          <div class="flex {stacked ? 'flex-col' : 'flex-row items-center'}">
            {#if !stacked}
              {@render attachButton()}
            {/if}
            <Textarea
              bind:value={text}
              bind:ref={textareaEl}
              {placeholder}
              rows={1}
              class="max-h-40 min-h-10 resize-none border-none bg-transparent px-2 py-2.5 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent
                {stacked ? 'w-full' : 'w-auto min-w-0 flex-1'}"
              onkeydown={handleKeydown}
              oninput={onInput}
              oncompositionstart={() => (isComposing = true)}
              oncompositionend={() => (isComposing = false)}
              data-testid="composer-input"
            />
            <div
              class="flex items-center {stacked ? 'w-full justify-between pt-0.5 pb-1' : 'pr-0.5'}"
            >
              {#if stacked}
                {@render attachButton()}
              {/if}
              <div class="flex items-center gap-1">
                {#if recording !== null || voiceBusy}
                  <!-- 录音胶囊（点击式录音，参考 Grok）：点击停止并转写填入输入框；
                       Esc 取消。识别中（voiceBusy）原位显示加载态。 -->
                  <button
                    type="button"
                    class="flex h-8 shrink-0 {voiceBusy
                      ? 'cursor-default'
                      : 'cursor-pointer'} items-center gap-2 rounded-full bg-foreground/10 pr-3 pl-2.5"
                    onclick={() => void finishRecording(true)}
                    disabled={voiceBusy}
                    aria-label={t('composer.recordingStop')}
                    data-testid="composer-recording"
                  >
                    {#if voiceBusy}
                      <Loader2 class="size-3.5 animate-spin text-foreground" aria-hidden="true" />
                    {:else}
                      <span class="size-2.5 rounded-[3px] bg-foreground" aria-hidden="true"></span>
                    {/if}
                    <span class="text-xs text-foreground tabular-nums">
                      {formatRecordingDuration(recordingElapsed)}
                    </span>
                    <span class="flex items-center gap-0.5" aria-hidden="true">
                      {#each [0, 1, 2, 3] as dot (dot)}
                        <span
                          class="voice-dot size-1 rounded-full bg-foreground/70"
                          style="animation-delay: {dot * 0.18}s"
                        ></span>
                      {/each}
                    </span>
                  </button>
                {:else if !hasContent && drafts.length === 0}
                  <!-- 语音键：点击开始录音（录音中原位变胶囊）；有内容/有队列时
                       此位让给发送键。语音对话模式暂缓，入口隐藏。 -->
                  <button
                    type="button"
                    class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
                    onclick={() => void startRecording()}
                    disabled={readOnly}
                    aria-label={t('composer.voiceStart')}
                    data-testid="composer-voice-start"
                  >
                    <AudioLines class="size-4" />
                  </button>
                {/if}
                {#if hasContent || drafts.length > 0}
                  {@render sendButton()}
                {/if}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
