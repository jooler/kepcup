<script lang="ts">
  import { ArrowUp, AudioLines, Loader2, Paperclip, Plus, Reply, X } from '@lucide/svelte';
  import { Editor } from '@tiptap/core';
  import type { JSONContent } from '@tiptap/core';
  import { Markdown } from '@tiptap/markdown';
  import { Placeholder } from '@tiptap/extensions';
  import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
  import { untrack } from 'svelte';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { resolveComposerAction } from './key-handling';
  import { buildMentionTargets, type MentionTarget } from './composer-text';
  import {
    collectMentionTokens,
    composerMention,
    composerNodes,
    mergeMentionTokens,
  } from './composer-editor';
  import { parsePresetAvatar } from '$lib/avatars/presets';
  import { mediaViewer, type LocalMedia } from './media-viewer.svelte';
  import { composerDrafts, type PendingUpload } from './composer-drafts.svelte';
  import { EMPTY_COMPOSER_DOC, isComposerDocEmpty } from './composer-draft-persist';
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

  /**
   * 输入区是 TipTap 编辑器（contenteditable）：列表（`- `/`1. ` 输入规则自动
   * 转换、回车续行、空项回车退出）与 @ 提及（mention 节点 + suggestion 弹层）
   * 都是 ProseMirror 原生节点行为。中间过程保持编辑器原生 JSON（草稿缓存、
   * 提及收集都以它为准）；markdown 只在发送入队时 getMarkdown() 转换一次。
   * 编辑器内容只在草稿水合时反向写入（setContent）。
   */
  let docJson = $state<JSONContent>(EMPTY_COMPOSER_DOC);
  /** 当前内容的结构化提及 token（文档 mention 节点；发送时再并入手打名称）。 */
  let mentionTokens: string[] = $state([]);
  let editorHostEl: HTMLDivElement | null = $state(null);
  let editor = $state<Editor | null>(null);
  /** 药丸两态（参考 Grok Bot）：内容换行或有待发送附件时输入占满整行。 */
  let multiline = $state(false);
  /** IME 组合中（handleKeyDown 的 Enter 拦截要避开候选确认）。 */
  let composing = false;
  /**
   * suggestion 弹层存活状态（非响应式，给 handleKeyDown 判断用）：打开且
   * 有候选时 Enter 是「确认提及目标」，不得截走为入队。
   */
  const suggestionState = { active: false, count: 0 };
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

  const composerEmpty = $derived(isComposerDocEmpty(docJson));
  const hasContent = $derived(!composerEmpty || pendingUploads.length > 0);

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
   * @ 提及注册表（suggestion 弹层候选与发送解析共用）：当前群成员优先，
   * 其余活跃 Bot 次之，其他群聊最后；当前会话自己不作候选。单聊同样可用
   * ——提及非成员 Bot / 群是「引用」，不参与群聊路由。
   */
  const mentionTargets = $derived.by(() =>
    buildMentionTargets({
      memberBots: (chat.current?.members ?? []).map((m) => m.bot),
      allBots: contacts.bots,
      groups: chat.conversations
        .filter((c) => c.type === 'group')
        .map((c) => ({ id: c.id, title: c.title })),
      currentConversationId: chat.current?.conversation.id ?? null,
      // 单聊里排除当前对话的 Bot 自己（@ 自己没有意义）；群聊的成员是
      // 主力候选，不排除。
      excludeBotIds:
        isGroup || chat.current?.conversation.directBotId == null
          ? []
          : [chat.current.conversation.directBotId],
    }),
  );

  /**
   * @ 文字色：当前会话 Bot 的预置头像色（单聊取 direct Bot；群聊无单一
   * Bot，回退主色）。与用户气泡取色同源（MessageBody）。经 CSS 变量下发，
   * mention 节点的渲染无需感知会话切换。
   */
  const mentionColor = $derived(
    parsePresetAvatar(chat.current?.conversation.bot?.avatar ?? null)?.color ?? null,
  );

  // --- TipTap 编辑器 -----------------------------------------------------------

  /** 编辑器原生 JSON → docJson/mentionTokens 单向同步 + 多行形态测量。 */
  function syncFromEditor(ed: Editor): void {
    docJson = ed.getJSON();
    mentionTokens = collectMentionTokens(docJson);
    queueMicrotask(() => {
      multiline = (editorHostEl?.scrollHeight ?? 0) > 48;
    });
  }

  /** suggestion 弹层：纯 DOM 渲染（插件负责定位/外点关闭），键盘导航在此。 */
  function suggestionRender(): {
    onStart: (props: SuggestionProps) => void;
    onUpdate: (props: SuggestionProps) => void;
    onKeyDown: (props: SuggestionKeyDownProps) => boolean;
    onExit: () => void;
  } {
    let popup: HTMLUListElement | null = null;
    let unmountPopup: (() => void) | null = null;
    let items: MentionTarget[] = [];
    let selectedIndex = 0;
    /** 方向键导航后才显示选中背景：首项不默认加背景（Enter 仍以其为目标）。 */
    let navigated = false;
    let currentCommand: ((target: MentionTarget) => void) | null = null;

    const renderList = (): void => {
      if (popup === null) return;
      popup.textContent = '';
      if (items.length === 0) {
        popup.style.display = 'none';
        return;
      }
      popup.style.display = '';
      items.forEach((target, index) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className =
          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent' +
          (navigated && index === selectedIndex ? ' bg-accent' : '');
        button.dataset.testid = `mention-candidate-${target.token}`;
        button.onclick = () => currentCommand?.(target);
        const name = document.createElement('span');
        name.className = 'min-w-0 flex-1 truncate';
        name.textContent = `@${target.name}`;
        button.append(name);
        // 群聊候选带角标区分；Bot 简介不再展示（弹层保持紧凑固定宽度）。
        if (target.kind === 'group') {
          const badge = document.createElement('span');
          badge.className = 'shrink-0 text-xs text-muted-foreground';
          badge.textContent = t('composer.mentionGroup');
          button.append(badge);
        }
        li.append(button);
        popup?.append(li);
        // 管家是特殊成员：行下加分隔线与普通候选分区（列表末尾不加）。
        if (target.butler === true && index < items.length - 1) {
          const divider = document.createElement('li');
          divider.setAttribute('aria-hidden', 'true');
          divider.className = 'mx-2 border-t border-border';
          popup?.append(divider);
        }
      });
    };

    return {
      onStart: (props) => {
        popup = document.createElement('ul');
        popup.className =
          'absolute z-50 max-h-48 overflow-x-hidden overflow-y-auto rounded-md border bg-background p-1 shadow-md';
        popup.style.zIndex = '50';
        // 浮层定位脚本会把宽度撑成 max-content（长简介把弹层拉满屏），固定
        // 宽度 + 文本截断（inline style 压过定位脚本写入的样式）。
        popup.style.width = '18rem';
        popup.dataset.testid = 'mention-popup';
        items = props.items as MentionTarget[];
        selectedIndex = 0;
        currentCommand = props.command as (target: MentionTarget) => void;
        suggestionState.active = true;
        suggestionState.count = items.length;
        navigated = false;
        renderList();
        unmountPopup = props.mount(popup);
      },
      onUpdate: (props) => {
        items = props.items as MentionTarget[];
        selectedIndex = 0;
        navigated = false;
        currentCommand = props.command as (target: MentionTarget) => void;
        suggestionState.count = items.length;
        renderList();
      },
      onKeyDown: (props) => {
        if (popup === null || items.length === 0) return false;
        // IME 组合中的按键（含候选确认的 Enter）不参与提及选择。
        if (props.event.isComposing || props.event.keyCode === 229) return false;
        if (props.event.key === 'ArrowDown') {
          navigated = true;
          selectedIndex = (selectedIndex + 1) % items.length;
          renderList();
          return true;
        }
        if (props.event.key === 'ArrowUp') {
          navigated = true;
          selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          renderList();
          return true;
        }
        if (props.event.key === 'Enter' || props.event.key === 'Tab') {
          const target = items[selectedIndex];
          if (target) currentCommand?.(target);
          return true;
        }
        if (props.event.key === 'Escape') {
          // Esc 关闭弹层并交还 Enter 语义（此后 Enter 恢复入队/发送）。
          suggestionState.active = false;
          suggestionState.count = 0;
          popup.style.display = 'none';
          return true;
        }
        return false;
      },
      onExit: () => {
        suggestionState.active = false;
        suggestionState.count = 0;
        unmountPopup?.();
        unmountPopup = null;
        popup?.remove();
        popup = null;
      },
    };
  }

  /** 创建守卫用普通变量（非响应式）：effect 里读写响应式 editor 会自触发。 */
  let editorInstance: Editor | null = null;
  $effect(() => {
    const host = editorHostEl;
    if (host === null || editorInstance !== null) return;
    // 构造期间 Placeholder 等扩展的闭包会同步读取组件状态（placeholder /
    // mentionTargets），必须 untrack——否则 effect 隐式依赖草稿队列，草稿一变
    // 就销毁重建编辑器（in-flight 的 clearContent 直接踩空）。
    const ed = untrack(
      () =>
        new Editor({
          element: host,
          extensions: [
            Markdown.configure({ markedOptions: { breaks: true, gfm: true } }),
            Placeholder.configure({ placeholder: () => placeholder }),
            composerMention.configure({
              // 退格删除提及节点时保留触发符 @（扩展内建行为）：删除后的
              // insertText('@') 事务会让 suggestion 插件立刻重开弹层（空查询
              // = 全部候选），可直接继续选目标。一次 Backspace 仍删掉整个
              // mention 节点，不会逐字删除。
              deleteTriggerWithBackspace: false,
              renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
              renderHTML: ({ node, options }) => [
                'span',
                {
                  ...options.HTMLAttributes,
                  'data-type': 'mention',
                  class: 'composer-mention',
                  'data-testid': 'composer-mention',
                },
                `@${node.attrs.label ?? node.attrs.id}`,
              ],
              suggestion: {
                char: '@',
                placement: 'top-start',
                items: ({ query }) => {
                  const q = query.trim().toLowerCase();
                  return mentionTargets.filter(
                    (target) =>
                      q.length === 0 ||
                      target.name.toLowerCase().includes(q) ||
                      target.token.toLowerCase().includes(q),
                  );
                },
                render: suggestionRender,
                command: ({ editor: targetEditor, range, props }) => {
                  // suggestion 的选中项泛型默认是节点 attrs；我们的选中项是
                  // MentionTarget（token + name），在边界收窄一次。
                  const target = props as unknown as MentionTarget;
                  targetEditor
                    .chain()
                    .focus()
                    .insertContentAt(range, [
                      { type: 'mention', attrs: { id: target.token, label: target.name } },
                      { type: 'text', text: ' ' },
                    ])
                    .run();
                },
              },
            }),
            ...composerNodes,
          ],
          editorProps: {
            attributes: {
              class:
                'composer-editor max-h-40 min-h-10 w-full overflow-y-auto px-2 py-2.5 text-sm outline-none [&_p]:my-0 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_li]:my-0',
              'data-testid': 'composer-input',
              role: 'textbox',
              'aria-multiline': 'true',
            },
            handleDOMEvents: {
              compositionstart: () => {
                composing = true;
                return false;
              },
              compositionend: () => {
                composing = false;
                return false;
              },
            },
            handleKeyDown: (view, event) => {
              if (composing || event.isComposing || event.keyCode === 229) return false;
              if (event.key !== 'Enter') return false;
              // @ 弹层打开且有候选：Enter 是确认提及目标，放行给 suggestion
              // 插件。directProps 的按键处理先于插件，不在这里让路会被入队
              // 截走（弹层选不上、消息直接进了待发送队列）。
              if (
                !event.shiftKey &&
                !(event.metaKey || event.ctrlKey) &&
                suggestionState.active &&
                suggestionState.count > 0
              ) {
                return false;
              }
              // 列表项内回车交给 ProseMirror：续行（有序自动 +1）/ 空项退出列表。
              if (
                !event.shiftKey &&
                !(event.metaKey || event.ctrlKey) &&
                editor !== null &&
                editor.isActive('listItem')
              ) {
                return false;
              }
              const action = resolveComposerAction({
                key: event.key,
                meta: event.metaKey || event.ctrlKey,
                shift: event.shiftKey,
                isComposing: false,
                hasText: !composerEmpty,
                hasAttachments: pendingUploads.length > 0,
                queueLength: drafts.length,
              });
              if (action === 'none' || action === 'newline') return false;
              if (action === 'add-draft') void queueCurrent();
              else if (action === 'flush') void chat.flush();
              else if (action === 'add-and-flush') void queueAndFlush();
              return true;
            },
          },
          // content 先留空：会话草稿由水合 effect 写入。
          content: '',
        }),
    );
    ed.on('update', () => syncFromEditor(ed));
    editorInstance = ed;
    editor = ed;
    return () => {
      ed.destroy();
      editorInstance = null;
      editor = null;
    };
  });

  /** 会话草稿的按会话缓存：水合（JSON → 编辑器）与保存（编辑器 → JSON）。 */
  let activeConversationId: string | null = null;
  $effect(() => {
    const conversationId = chat.current?.conversation.id ?? null;
    const ed = editor;
    const currentDoc = docJson;
    const currentMentionTokens = mentionTokens;
    const currentReply = chat.replyTo;
    if (conversationId !== activeConversationId) {
      activeConversationId = conversationId;
      if (conversationId === null || ed === null) return;
      untrack(() => {
        composerDrafts.hydrate(conversationId);
        const saved = composerDrafts.loadDraft(conversationId);
        // 草稿缓存是编辑器原生 JSON：mention/列表节点原样回位，无需任何转换。
        ed.commands.setContent(saved.doc);
        syncFromEditor(ed);
        chat.replyTo = saved.reply;
      });
      return;
    }
    if (conversationId === null || ed === null) return;
    composerDrafts.saveComposerDoc(conversationId, currentDoc, currentMentionTokens, currentReply);
  });

  /**
   * 把当前内容入队为草稿。markdown/提及/引用在进 await 前捕获，编辑器
   * 同步清空——对齐原 textarea 的键入语义：连续 Enter / 自动化脚本不会
   * 踩到尚未清空的旧内容（清空放在异步入队之后会把它抹掉）。
   */
  async function queueCurrent(): Promise<void> {
    const ed = editor;
    const conversationId = chat.current?.conversation.id;
    if (ed === null || !conversationId) return;
    const markdown = ed.getMarkdown();
    const trimmed = markdown.trim();
    if (trimmed.length === 0 && pendingUploads.length === 0) return;
    const tokens = mergeMentionTokens(ed.getJSON(), markdown, mentionTargets);
    const replyToId = replyTo?.id ?? null;
    ed.commands.clearContent();
    const attachmentIds = await composerDrafts.settle(conversationId);
    await chat.addDraft(trimmed, {
      ...(tokens.length > 0 ? { mentions: tokens } : {}),
      ...(replyToId !== null ? { replyTo: replyToId } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    });
  }

  /** Cmd/Ctrl+Enter：入队当前内容并冲出队列。 */
  async function queueAndFlush(): Promise<void> {
    if (!composerEmpty || pendingUploads.length > 0) await queueCurrent();
    await chat.flush();
  }

  async function onSendClick(): Promise<void> {
    if (readOnly) return;
    if (hasContent) {
      await queueCurrent();
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
      const ed = editor;
      if (ed !== null) {
        ed.commands.insertContent(!composerEmpty ? ` ${transcript}` : transcript);
        ed.commands.focus('end');
      }
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
        <!-- 输入坞（参考 Grok）：引用条 / 待发送附件内嵌在圆角容器里，
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
               占满整行，附件键/发送键落到底部两角。@ 提及文字色取当前 Bot
               头像色，经 --mention-color 下发给 .composer-mention -->
          <div class="flex {stacked ? 'flex-col' : 'flex-row items-center'}">
            {#if !stacked}
              {@render attachButton()}
            {/if}
            <div
              class={stacked ? 'w-full' : 'w-auto min-w-0 flex-1'}
              style:--mention-color={mentionColor?.hex ?? ''}
            >
              <div bind:this={editorHostEl}></div>
            </div>
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
