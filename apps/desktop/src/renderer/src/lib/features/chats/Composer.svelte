<script lang="ts">
  import { ArrowUp, AudioLines, Loader2, Paperclip, Plus, Reply, Speech, X } from '@lucide/svelte';
  import { Editor } from '@tiptap/core';
  import type { JSONContent } from '@tiptap/core';
  import { Markdown } from '@tiptap/markdown';
  import { Placeholder } from '@tiptap/extensions';
  import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
  import { fileMentionToken, folderMentionToken, parseLocalPathMentionToken } from '@kepcup/shared';
  import { mount, unmount, untrack } from 'svelte';
  import { errorText, t, listSeparator } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Button, buttonVariants } from '$lib/components/ui/button';
  import { cn } from '$lib/utils.js';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { getChatSession } from './chat-session-context';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { endpointSupports } from '$lib/features/web-shell/endpoint';
  import { resolveComposerAction } from './key-handling';
  import {
    buildMentionTargets,
    createPickFileTarget,
    localPathName,
    type MentionTarget,
  } from './composer-text';
  import { createSendGuard, performComposerSend, type AttachmentIssue } from './composer-send';
  import {
    collectMentionTokens,
    composerMention,
    composerNodes,
    mergeMentionTokens,
  } from './composer-editor';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { avatarOnFillForeground, parsePresetAvatar } from '$lib/avatars/presets';
  import QuotedMedia from './QuotedMedia.svelte';
  import { mediaViewer, type LocalMedia } from './media-viewer.svelte';
  import { composerDrafts, type PendingUpload } from './composer-drafts.svelte';
  import { EMPTY_COMPOSER_DOC, isComposerDocEmpty } from './composer-draft-persist';
  import {
    COMPOSER_SINGLE_LINE_MAX_PX,
    nextMultiline,
    singleLineWidth,
  } from './composer-multiline';
  import {
    MAX_RECORDING_MS,
    MIN_RECORDING_MS,
    formatRecordingDuration,
    levelToHeight,
    startVoiceRecording,
    type ActiveRecording,
    type VoiceRecording,
  } from './voice-recorder';
  import { sensors } from '$lib/sensors/sensors.svelte';
  import { SensorDisabledError } from '$lib/sensors/types';
  import { shell } from '$lib/stores/shell.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { ESCAPE_PRIORITY, registerEscapeLayer } from '$lib/features/shell/escape-layers';
  import VoiceModeBar from './VoiceModeBar.svelte';
  import {
    announceEntryFor,
    createAutoSendCountdown,
    escapeActionForVoiceMode,
    micIntentFor,
    voiceMode,
    type AnnounceDeps,
  } from './voice-mode.svelte';
  import { speechAudio, type SpeechAudioDeps } from './speech-audio.svelte';
  import { isCapabilityError, sendVoiceRecording, type VoiceSendDeps } from './voice-send';
  import { SPEECH_TEXT_LIMIT } from './extractSpeechText';
  import { createBargeInMonitor, type BargeInSession } from './voice-barge-in';

  let {
    readOnly = false,
    centered = false,
    readOnlyHint,
    placeholderText = undefined,
  }: {
    readOnly?: boolean;
    centered?: boolean;
    readOnlyHint?: string;
    /** Replaces the default placeholder. A card dialog names the assignee. */
    placeholderText?: string;
  } = $props();

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
  /**
   * 单行布局下药丸外壳宽度与编辑区文字可用宽度之差（附件键、发送键、间距）。
   * 每次在单行布局里测量时更新；沉底时用「药丸宽度 − 它」推算单行可用宽度，
   * 判定回不回单行（composer-multiline.ts）。null = 还没在单行布局里测过。
   */
  let singleLineChromePx: number | null = null;
  /** 药丸外壳（宽度不随单行↔沉底切换），供 ResizeObserver 判定真·宽度变化。 */
  let composerPillEl: HTMLDivElement | null = $state(null);
  let lastPillWidth = 0;
  let remasureAfterCollapse: number | null = null;
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
  // 语音对话模式（docs/design/53-voice-conversation.md，D106）：左下工具行的
  // Speech 键进入，输入坞原位切语音条（VoiceModeBar），说话停止后按 26 号
  // 「语音消息语义」转文字 + 音频附件发送；编排见下方语音对话分段。
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
  /**
   * 待发送 2s 自动发送倒计时（修订 v2 V2-4）：send-ready 信号武装（电平静音
   * 3s 判定后），重新开口 / 全部收尾路径撤销；到期与用户点击绿键同走
   * stopVoiceModeRecording（有 spoken 的录音必然 >500ms，下限检查不受影响）。
   */
  const autoSendCountdown = createAutoSendCountdown({
    schedule: (handler, delayMs) => setTimeout(handler, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    fire: () => void stopVoiceModeRecording(),
  });

  const chatSession = getChatSession();
  const isProject = $derived(chatSession.view?.conversation.type === 'project');
  const replyTo = $derived(chatSession.replyTo);
  const replyToName = $derived(
    replyTo === null
      ? ''
      : replyTo.senderType === 'user'
        ? settingsStore.userDisplayName
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
  const pendingUploads = $derived(
    composerDrafts.uploadsOf(chatSession.view?.conversation.id ?? ''),
  );

  const composerEmpty = $derived(isComposerDocEmpty(docJson));
  const hasContent = $derived(!composerEmpty || pendingUploads.length > 0);

  /**
   * 沉底两态的开关：内容换行（multiline）或有待发送图片/文件时，输入占满
   * 整行、附件键与发送键沉到底部两角（参考 Grok 的图 2/图 3 形态）。
   */
  const stacked = $derived(multiline || pendingUploads.length > 0);

  const placeholder = $derived(
    placeholderText ?? (isProject ? t('composer.mentionPlaceholder') : t('composer.placeholder')),
  );

  /**
   * @ 提及注册表（suggestion 弹层候选与发送解析共用）：当前项目组成员优先，
   * 其余活跃 Bot 次之，其他项目组最后；当前会话自己不作候选。单聊同样可用
   * ——提及非成员 Bot / 项目组是「引用」，不参与项目组路由。
   */
  const mentionTargets = $derived.by(() =>
    buildMentionTargets({
      memberBots: (chatSession.view?.members ?? []).map((m) => m.bot),
      allBots: contacts.bots,
      projects: chat.conversations
        .filter((c) => c.type === 'project')
        .map((c) => ({ id: c.id, title: c.title })),
      currentConversationId: chatSession.view?.conversation.id ?? null,
      // 单聊里排除当前对话的 Bot 自己（@ 自己没有意义）；项目组的成员是
      // 主力候选，不排除。
      excludeBotIds:
        isProject || chatSession.view?.conversation.directBotId == null
          ? []
          : [chatSession.view.conversation.directBotId],
    }),
  );

  /** @ 菜单末尾的「选择文件或文件夹」动作项（不进入 mention 注册表，避免被当成员解析）。 */
  const pickFileTarget = $derived(createPickFileTarget(t('composer.mentionPickFile')));

  /**
   * 当前会话 Bot 的预置头像色（单聊取 direct Bot；项目组无单一 Bot、上传
   * 头像等取不到时为 null）。@ 文字色、发送键、语音键与用户气泡同源
   * （MessageBody）。hex 可能是 var()（黑白随主题），必须经 style 下发。
   */
  const botAvatarColor = $derived(
    parsePresetAvatar(chatSession.view?.conversation.bot?.avatar ?? null)?.color ?? null,
  );
  /**
   * 两键的填色。null 时不覆盖：发送键留主题 primary，语音键留前景色。
   * 图标色与用户气泡文字同一规则（avatarOnFillForeground）：黑白随主题取反，
   * 其余预置色一律白。
   */
  const botAvatarButtonPaint = $derived(
    botAvatarColor
      ? {
          background: botAvatarColor.hex,
          color: avatarOnFillForeground(botAvatarColor),
        }
      : null,
  );

  // --- 本地文件/文件夹提及 -----------------------------------------------------
  // 只把绝对路径写进消息（正文 @路径 + mentions token），不上传文件字节。
  // 图标走内联 SVG：TipTap 的 renderHTML 与 suggestion 弹层都是纯 DOM，不能挂
  // Svelte 组件；沿用 lucide 的路径数据保持视觉一致。

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MENTION_ICON_PATHS: Record<'file' | 'folder' | 'pick-file' | 'project', readonly string[]> =
    {
      file: [
        'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
        'M14 2v4a2 2 0 0 0 2 2h4',
      ],
      folder: [
        'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
      ],
      'pick-file': [
        'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
      ],
      // lucide `users`：项目组在头像位显示，避免一大块空白。
      project: [
        'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
        'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
        'M22 21v-2a4 4 0 0 0-3-3.87',
        'M16 3.13a4 4 0 0 1 0 7.75',
      ],
    };

  function createMentionIcon(
    kind: 'file' | 'folder' | 'pick-file' | 'project',
    className = 'composer-mention-icon',
  ): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    for (const d of MENTION_ICON_PATHS[kind]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  /**
   * @ 菜单「选择文件或文件夹」：先删掉触发中的 @query 关闭弹层，再拉起原生
   * 面板；选中后把文件/文件夹 mention 节点插回原位置（取消则什么都不留）。
   */
  async function insertLocalPathMention(
    ed: Editor,
    range: { from: number; to: number },
  ): Promise<void> {
    const insertAt = range.from;
    ed.chain().focus().deleteRange(range).run();
    let picked: { path: string; kind: 'file' | 'folder' } | null;
    try {
      picked = (await window.kepcup?.platform?.selectLocalPath?.()) ?? null;
    } catch {
      picked = null;
    }
    if (ed.isDestroyed || picked === null) return;
    const token =
      picked.kind === 'folder' ? folderMentionToken(picked.path) : fileMentionToken(picked.path);
    const at = Math.min(insertAt, ed.state.doc.content.size);
    ed.chain()
      .focus()
      .insertContentAt(at, [
        { type: 'mention', attrs: { id: token, label: localPathName(picked.path) } },
        { type: 'text', text: ' ' },
      ])
      .run();
  }

  // --- TipTap 编辑器 -----------------------------------------------------------

  /** 元素内容区宽度（clientWidth 去掉左右内边距）。 */
  function contentBoxWidth(el: HTMLElement): number {
    const style = getComputedStyle(el);
    return (
      el.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0)
    );
  }

  /**
   * 测量单行 / 多行：始终按「单行布局下放不放得下」判定（composer-multiline.ts）。
   * 从多行塌回单行后 rAF 再测一次，让软换行能在收窄后立刻重新进入，无需等下一键。
   */
  function measureMultiline(): void {
    const host = editorHostEl;
    const pill = composerPillEl;
    if (host === null) return;
    const empty = ((editorInstance ?? editor)?.getText().length ?? 0) === 0;
    const wraps = host.scrollHeight > COMPOSER_SINGLE_LINE_MAX_PX;
    // 以已渲染的布局为准（状态可能已改、DOM 尚未刷新）。
    const layout = pill?.dataset.multiline === 'true' ? 'stacked' : 'single';
    const pillWidth = pill?.getBoundingClientRect().width ?? null;
    const prose = host.querySelector<HTMLElement>('.ProseMirror');
    const widths = singleLineWidth({
      layout,
      pillWidthPx: pillWidth,
      editorWidthPx: prose !== null ? contentBoxWidth(prose) : null,
      chromePx: singleLineChromePx,
    });
    singleLineChromePx = widths.chromePx;
    const singleLineWidthPx = widths.singleLineWidthPx;
    let contentWidthPx: number | null = null;
    if (!wraps && prose !== null) {
      // 只量第一个文本块的内联内容：选中整个块会把块级盒（满宽）算进去。
      const range = document.createRange();
      range.selectNodeContents(prose.querySelector('p') ?? prose);
      contentWidthPx = range.getBoundingClientRect().width;
    }
    const wasMultiline = multiline;
    multiline = nextMultiline({
      multiline,
      layout,
      empty,
      wraps,
      contentWidthPx,
      singleLineWidthPx,
    });
    if (wasMultiline && !multiline) {
      if (remasureAfterCollapse !== null) cancelAnimationFrame(remasureAfterCollapse);
      remasureAfterCollapse = requestAnimationFrame(() => {
        remasureAfterCollapse = null;
        measureMultiline();
      });
    }
  }

  /** 编辑器原生 JSON → docJson/mentionTokens 单向同步 + 多行形态测量。 */
  function syncFromEditor(ed: Editor): void {
    docJson = ed.getJSON();
    mentionTokens = collectMentionTokens(docJson);
    queueMicrotask(() => {
      measureMultiline();
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
    let currentCommand: ((target: MentionTarget) => void) | null = null;
    /** 与 items 一一对应的行元素（分隔线不入列），用于切换高亮与滚动。 */
    let itemEls: HTMLLIElement[] = [];
    /** 纯 DOM 弹层里挂载的 Bot 头像；列表重建/关闭前统一卸载。 */
    let mountedAvatars: Array<ReturnType<typeof mount>> = [];
    const clearAvatars = (): void => {
      for (const avatar of mountedAvatars) void unmount(avatar);
      mountedAvatars = [];
    };

    /** 只把选中的行滚进弹层视口，避免 scrollIntoView 连带滚动页面/编辑器。 */
    const scrollItemIntoView = (li: HTMLLIElement): void => {
      if (popup === null) return;
      const viewport = popup.getBoundingClientRect();
      const item = li.getBoundingClientRect();
      if (item.top < viewport.top) {
        popup.scrollTop -= viewport.top - item.top;
      } else if (item.bottom > viewport.bottom) {
        popup.scrollTop += item.bottom - viewport.bottom;
      }
    };

    /** 只更新高亮 + 滚动，不重建列表（重建会把滚动位置重置到顶部）。 */
    const paintSelection = (): void => {
      itemEls.forEach((li, index) => {
        li.firstElementChild?.classList.toggle('bg-accent', index === selectedIndex);
      });
      const selected = itemEls[selectedIndex];
      if (selected !== undefined) scrollItemIntoView(selected);
    };

    const renderList = (): void => {
      if (popup === null) return;
      clearAvatars();
      popup.textContent = '';
      itemEls = [];
      if (items.length === 0) {
        popup.style.display = 'none';
        return;
      }
      popup.style.display = '';
      items.forEach((target, index) => {
        const isPickFile = target.kind === 'pick-file';
        // 文件选择是动作项，与 @ 成员/项目组之间用分隔线隔开。
        if (isPickFile && index > 0) {
          const divider = document.createElement('li');
          divider.setAttribute('aria-hidden', 'true');
          divider.className = 'mx-2 my-1 border-t border-border';
          popup?.append(divider);
        }
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className =
          'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent';
        button.dataset.testid = isPickFile
          ? 'mention-candidate-pick-file'
          : `mention-candidate-${target.token}`;
        button.onclick = () => currentCommand?.(target);
        if (isPickFile) {
          // 与 Bot 头像同宽的头像位，名称列保持对齐。
          const iconHost = document.createElement('span');
          iconHost.className = 'flex size-5 shrink-0 items-center justify-center';
          iconHost.append(createMentionIcon('pick-file', 'size-4'));
          button.append(iconHost);
        }
        if (target.kind === 'bot') {
          const avatarHost = document.createElement('span');
          avatarHost.className = 'flex shrink-0 items-center';
          button.append(avatarHost);
          mountedAvatars.push(
            mount(BotAvatar, {
              target: avatarHost,
              props: {
                botId: target.token,
                name: target.name,
                avatar: target.avatar ?? null,
                class: 'size-5',
                animated: false,
              },
            }),
          );
        } else if (target.kind === 'project') {
          // 项目组没有头像：头像位放群组图标，名称仍与 Bot 名称对齐。
          const iconHost = document.createElement('span');
          iconHost.className =
            'flex size-5 shrink-0 items-center justify-center text-muted-foreground';
          iconHost.append(createMentionIcon('project', 'size-4'));
          button.append(iconHost);
        }
        const name = document.createElement('span');
        name.className = 'min-w-0 flex-1 truncate pr-8';
        name.textContent = target.name;
        // Bot 名称与它的预置头像同色；上传头像/占位没有单一主色，保持默认前景。
        const avatarColor = target.kind === 'bot' ? parsePresetAvatar(target.avatar)?.color : null;
        if (avatarColor !== undefined && avatarColor !== null) name.style.color = avatarColor.hex;
        button.append(name);
        // 最右侧固定显示类型；Bot 简介不再展示（弹层保持紧凑固定宽度）。
        const kindLabel =
          target.kind === 'bot'
            ? t('composer.mentionKindBot')
            : target.kind === 'project'
              ? t('composer.mentionKindProject')
              : null;
        if (kindLabel !== null) {
          const badge = document.createElement('span');
          badge.className = 'shrink-0 text-xs text-muted-foreground';
          badge.textContent = kindLabel;
          button.append(badge);
        }
        li.append(button);
        popup?.append(li);
        itemEls.push(li);
        // 管家是特殊成员：行下加分隔线与普通候选分区（列表末尾不加）。
        if (target.butler === true && index < items.length - 1) {
          const divider = document.createElement('li');
          divider.setAttribute('aria-hidden', 'true');
          divider.className = 'mx-2 border-t border-border';
          popup?.append(divider);
        }
      });
      paintSelection();
    };

    return {
      onStart: (props) => {
        popup = document.createElement('ul');
        popup.className =
          'absolute z-50 max-h-64 overflow-x-hidden overflow-y-auto rounded-md border bg-background p-1 shadow-md';
        popup.style.zIndex = '50';
        // 浮层定位脚本会把宽度撑成 max-content（长简介把弹层拉满屏），固定
        // 宽度 + 文本截断（inline style 压过定位脚本写入的样式）。
        popup.style.width = '22rem';
        popup.dataset.testid = 'mention-popup';
        items = props.items as MentionTarget[];
        selectedIndex = 0;
        currentCommand = props.command as (target: MentionTarget) => void;
        suggestionState.active = true;
        suggestionState.count = items.length;
        renderList();
        unmountPopup = props.mount(popup);
      },
      onUpdate: (props) => {
        items = props.items as MentionTarget[];
        selectedIndex = 0;
        currentCommand = props.command as (target: MentionTarget) => void;
        suggestionState.count = items.length;
        renderList();
      },
      onKeyDown: (props) => {
        if (popup === null || items.length === 0) return false;
        // IME 组合中的按键（含候选确认的 Enter）不参与提及选择。
        if (props.event.isComposing || props.event.keyCode === 229) return false;
        if (props.event.key === 'ArrowDown') {
          // 默认选中首项；向下按列表循环。
          selectedIndex = (selectedIndex + 1) % items.length;
          paintSelection();
          return true;
        }
        if (props.event.key === 'ArrowUp') {
          // 首项再向上绕到末项。
          selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          paintSelection();
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
        clearAvatars();
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
    // mentionTargets），必须 untrack——否则 effect 隐式依赖这些响应式值，
    // 它们一变就销毁重建编辑器（in-flight 的 clearContent 直接踩空）。
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
              renderHTML: ({ node, options }) => {
                const token = String(node.attrs.id ?? '');
                const local = parseLocalPathMentionToken(token);
                const label = String(node.attrs.label ?? node.attrs.id ?? '');
                // 本地文件/文件夹：icon + 名称，替换掉常规的 `@名字` 文本。
                if (local !== null) {
                  return [
                    'span',
                    {
                      ...options.HTMLAttributes,
                      'data-type': 'mention',
                      class: 'composer-mention composer-mention-path',
                      'data-testid': 'composer-mention',
                      'data-kind': local.kind,
                      title: local.path,
                    },
                    createMentionIcon(local.kind),
                    ['span', { class: 'composer-mention-label' }, label],
                  ];
                }
                return [
                  'span',
                  {
                    ...options.HTMLAttributes,
                    'data-type': 'mention',
                    class: 'composer-mention',
                    'data-testid': 'composer-mention',
                  },
                  `@${label}`,
                ];
              },
              suggestion: {
                char: '@',
                placement: 'top-start',
                items: ({ query }) => {
                  const q = query.trim().toLowerCase();
                  const matched = mentionTargets.filter(
                    (target) =>
                      q.length === 0 ||
                      target.name.toLowerCase().includes(q) ||
                      target.token.toLowerCase().includes(q),
                  );
                  // 文件/文件夹选择是固定动作项：不过滤，始终在列表末尾。
                  return [...matched, pickFileTarget];
                },
                render: suggestionRender,
                command: ({ editor: targetEditor, range, props }) => {
                  // suggestion 的选中项泛型默认是节点 attrs；我们的选中项是
                  // MentionTarget（token + name），在边界收窄一次。
                  const target = props as unknown as MentionTarget;
                  if (target.kind === 'pick-file') {
                    void insertLocalPathMention(targetEditor, range);
                    return;
                  }
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
              // 插件。directProps 的按键处理先于插件，不在这里让路会被发送
              // 截走（弹层选不上、消息直接发了出去）。
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
              });
              if (action === 'none' || action === 'newline') return false;
              if (action === 'send') void sendCurrent();
              return true;
            },
          },
          // 初次挂载 docJson 还是空文档（会话草稿由水合 effect 写入）；语音模式
          // 切换会卸载/重建编辑器，用当前 docJson 重建 = 文字草稿原样保留（53 号）。
          // 整个构造在 untrack 内，这里不会把 docJson 变成 effect 依赖。
          content: docJson,
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

  /**
   * 渲染出的布局或按键变了就在新布局里重测：附件出现 / 清空（stacked 跟着变，
   * 不经编辑器事务）、发送键与语音键互换（hasContent，改变单行可用宽度）、引用条
   * 出现 / 消失。$effect 在 DOM 更新后运行；重测改 multiline 会让本 effect 再跑
   * 一次，判定有滞回，第二次结果不变即停（composer-multiline.test「settle」）。
   */
  $effect(() => {
    void stacked;
    void hasContent;
    void (replyTo !== null);
    untrack(() => measureMultiline());
  });

  /** 输入坞宽度变化（拖窗口等）时重测：单行可用宽度随药丸宽度变。 */
  $effect(() => {
    const pill = composerPillEl;
    if (pill === null) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? pill.getBoundingClientRect().width;
      if (lastPillWidth === 0) {
        lastPillWidth = width;
        return;
      }
      if (Math.abs(width - lastPillWidth) < 0.5) return;
      lastPillWidth = width;
      measureMultiline();
    });
    ro.observe(pill);
    return () => {
      ro.disconnect();
      if (remasureAfterCollapse !== null) {
        cancelAnimationFrame(remasureAfterCollapse);
        remasureAfterCollapse = null;
      }
    };
  });

  /** 会话草稿的按会话缓存：水合（JSON → 编辑器）与保存（编辑器 → JSON）。 */
  let activeConversationId: string | null = null;
  $effect(() => {
    const conversationId = chatSession.view?.conversation.id ?? null;
    const ed = editor;
    const currentDoc = docJson;
    const currentMentionTokens = mentionTokens;
    const currentReply = chatSession.replyTo;
    if (conversationId !== activeConversationId) {
      activeConversationId = conversationId;
      if (conversationId === null || ed === null) return;
      untrack(() => {
        composerDrafts.hydrate(conversationId);
        const saved = composerDrafts.loadDraft(conversationId);
        // 换会话时回单行，按新草稿重新测量。
        multiline = false;
        if (remasureAfterCollapse !== null) {
          cancelAnimationFrame(remasureAfterCollapse);
          remasureAfterCollapse = null;
        }
        // 草稿缓存是编辑器原生 JSON：mention/列表节点原样回位，无需任何转换。
        ed.commands.setContent(saved.doc);
        syncFromEditor(ed);
        chatSession.replyTo = saved.reply;
      });
      return;
    }
    if (conversationId === null || ed === null) return;
    composerDrafts.saveComposerDoc(conversationId, currentDoc, currentMentionTokens, currentReply);
  });

  /**
   * 撤回回填（ChatMessageRow 经 session.requestComposerInsert 请求）：把撤回
   * 消息的正文交回输入框，语义与语音转写回填一致——已有内容则空格追加，
   * 焦点落到结尾。消费即清引用；nonce 让同文本的两次撤回也会各触发一次。
   */
  $effect(() => {
    const insertion = chatSession.composerInsertion;
    const ed = editor;
    if (insertion === null || ed === null) return;
    chatSession.composerInsertion = null;
    ed.commands.insertContent(!composerEmpty ? ` ${insertion.text}` : insertion.text);
    ed.commands.focus('end');
  });

  /**
   * 防重入（按会话分闸）：同一会话上传未完成时连按两次 Enter / 点发送，第二次直接
   * 忽略；会话 A 还在等上传时切到 B，B 的发送不受 A 影响。
   */
  const sendGuard = createSendGuard();

  /**
   * 附件失效提示（INVALID_INPUT 判因后）：摘 chip + 按因给说法。文字直发与语音
   * 消息发送（performComposerSend 的 onAttachmentIssue）共用，不复制两份。
   */
  function attachmentIssueReporter(conversationId: string): (issue: AttachmentIssue) => void {
    return (issue) => {
      const nameOf = (id: string): string =>
        composerDrafts.uploadsOf(conversationId).find((upload) => upload.attachmentId === id)
          ?.fileName ?? id;
      composerDrafts.discardAttachments(conversationId, issue);
      if (issue.sent.length > 0) {
        toast.error(
          t('composer.attachmentIssueSent', {
            names: issue.sent.map(nameOf).join(listSeparator()),
          }),
        );
      }
      if (issue.missing.length > 0) {
        toast.error(
          t('composer.attachmentIssueMissing', {
            names: issue.missing.map(nameOf).join(listSeparator()),
          }),
        );
      }
    };
  }

  /**
   * 直发当前内容（docs/design/01-conversation.md 输入与发送）。markdown/提及/
   * 引用在进 await 前捕获，编辑器同步清空——对齐原 textarea 的键入语义：
   * 清空放在异步发送之后会把用户接着键入的新内容抹掉。缺设置门禁拦下时不清空、
   * 不上传：内容原样留在输入框，设置完成后用户再按一次发送。
   *
   * 编排见 composer-send.ts：等上传落定后重新判空；附件 chip 发送成功才摘，
   * 失败则回填文本（chip 本就没动）；整个过程由 sendGuard 防重入。
   */
  async function sendCurrent(): Promise<void> {
    const ed = editor;
    const conversationId = chatSession.view?.conversation.id;
    if (ed === null || !conversationId) return;
    if (sendGuard.isBusy(conversationId)) return;
    const markdown = ed.getMarkdown();
    const trimmed = markdown.trim();
    if (trimmed.length === 0 && pendingUploads.length === 0) return;
    if (chatSession.gateForSend()) return;
    const tokens = mergeMentionTokens(ed.getJSON(), markdown, mentionTargets);
    const replyToId = replyTo?.id ?? null;
    const docSnapshot = ed.getJSON();
    await sendGuard.run(conversationId, async () => {
      ed.commands.clearContent();
      await performComposerSend(trimmed, {
        settle: () => composerDrafts.settle(conversationId),
        // 显式只发往发起发送时的会话：等上传期间用户可能已切走。
        send: (text, attachmentIds) =>
          chatSession.send(conversationId, text, {
            ...(tokens.length > 0 ? { mentions: tokens } : {}),
            ...(replyToId !== null ? { replyTo: replyToId } : {}),
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          }),
        commit: (attachmentIds) => {
          composerDrafts.commitSent(conversationId, attachmentIds);
          if (replyToId !== null) composerDrafts.clearReply(conversationId);
        },
        restore: () => restoreComposerContent(ed, docSnapshot, conversationId),
        inspectAttachments: (attachmentIds) =>
          composerDrafts.inspectAttachments(conversationId, attachmentIds),
        onAttachmentIssue: attachmentIssueReporter(conversationId),
        reportFailure: (code) => chat.reportSendFailure(code),
      });
    });
  }

  /**
   * 发送失败：把发送前清掉的内容放回编辑器。用户在等待期间已键入新内容时，
   * 旧内容插到最前面而不是覆盖它；用户已切到别的会话时，改写回原会话的草稿缓存
   *（那边仍为空才写，不覆盖），回到该会话即可见——内容不会因发送失败而丢。
   */
  function restoreComposerContent(ed: Editor, doc: JSONContent, conversationId: string): void {
    if (editor !== ed || ed.isDestroyed || chatSession.view?.conversation.id !== conversationId) {
      const cached = composerDrafts.loadDraft(conversationId);
      if (isComposerDocEmpty(cached.doc)) {
        composerDrafts.saveComposerDoc(
          conversationId,
          doc,
          collectMentionTokens(doc),
          cached.reply,
        );
      }
      return;
    }
    if (ed.isEmpty) {
      ed.commands.setContent(doc);
    } else if (doc.content !== undefined && doc.content.length > 0) {
      ed.commands.insertContentAt(0, doc.content);
    }
    syncFromEditor(ed);
  }

  async function onSendClick(): Promise<void> {
    if (readOnly) return;
    await sendCurrent();
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

  // 录音中 Esc 取消（走仲裁器，优先级在所有覆盖层之下：有层开着时 Esc 先关那一层，
  // 不会一次 Esc 既取消录音又关掉层）；组件卸载（切会话/关窗）丢弃录音并释放麦克风。
  $effect(() => {
    if (recording === null) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.inline,
      onEscape: () => void finishRecording(false),
    });
  });
  // 语音模式 Esc 分档（53 号）：recording 中 = 取消录音丢弃，其余态 = 退出语音
  // 模式。同样走 inline 档——覆盖层开着时 Esc 先关那层（两态互斥，不会同时注册）。
  $effect(() => {
    if (!voiceModeOwned) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.inline,
      onEscape: () => {
        if (escapeActionForVoiceMode(voiceMode.phase) === 'cancel-recording') {
          cancelVoiceModeRecording();
        } else {
          exitVoiceMode();
        }
      },
    });
  });
  $effect(() => () => {
    recordingSession += 1;
    clearVoiceModeRecordingTimers();
    activeRecording?.cancel();
    activeRecording = null;
    // 语音模式随组件卸载退出（状态复位即可，录音资源上面已释放）；非归属
    // 实例卸载不得关掉别人的语音模式。
    if (voiceModeOwned) voiceMode.exit();
  });
  // 切换会话 = 退出语音模式（会话内即时态，不跨会话，53 号 D106）：停录音、
  // 释放流；文字草稿按会话缓存原样保留。
  let voiceModeConversationId: string | null = null;
  $effect(() => {
    const conversationId = chatSession.view?.conversation.id ?? null;
    const previous = voiceModeConversationId;
    voiceModeConversationId = conversationId;
    // 归属门禁：只有本实例曾是本次语音模式的归属会话才退出——否则隐藏的
    // 项目会话 Composer 一切会话就会把卡片对话的语音模式关掉（P2 同源）。
    const ownedBefore = voiceMode.active && voiceMode.ownerConversationId === previous;
    if (ownedBefore && previous !== null && conversationId !== previous) exitVoiceMode();
  });
  // readOnly 动态翻转（卡片会话可在打开中被置 readOnly/blocked，ChatView /
  // CardChat 直接下传 prop）：{#if readOnly} 分支会顶掉语音条——没有关闭键可
  // 点，状态机却仍 active。在这里主动退出（含停录音释放流），与切换会话同语义。
  $effect(() => {
    if (readOnly && voiceModeOwned) exitVoiceMode();
  });

  // 录音中麦克风被停用（设置页取消勾选）：立即取消，hub 同时已切断轨道（D76-5）。
  $effect(() => {
    if (sensors.state.microphone.enabled) return;
    if (recording !== null) void finishRecording(false);
    if (voiceModeOwned && voiceMode.phase === 'recording') cancelVoiceModeRecording();
  });

  function openHardwareSettings(): void {
    shell.openSettings('hardware');
  }

  /**
   * 传感器链路（26 号 §录音管道 / 31 号传感器层；文字语音输入与语音对话模式
   * 共用的同一条链路，勿复制粘贴）：隐私总闸 → TCC 授权门 → sensors.open
   * ('microphone') → startVoiceRecording。失败 toast、设备回退提示、会话号
   * 失效检查都在这里；拿到录音写入模块级 activeRecording（组件卸载 cleanup
   * 统一释放）。返回 false = 没开始录音（原因已提示，或已被后续会话作废）。
   */
  async function acquireRecording(
    session: number,
    onLevel: (level: number) => void,
  ): Promise<boolean> {
    // 启用开关是隐私总闸（D76-5）：停用时不采集，提示去「设置 → 硬件」启用。
    if (!sensors.state.microphone.enabled) {
      toast.error(t('composer.micDisabled'), {
        action: { label: t('composer.micOpenHardware'), onClick: openHardwareSettings },
      });
      return false;
    }
    // TCC 授权门：not-determined 时在这里拉起系统授权弹框；被拒后系统永远
    // 不会再弹，只能 toast + 深链系统设置（docs/design/26-voice-input.md）。
    let access: Awaited<ReturnType<typeof sensors.ensureAccess>>;
    try {
      access = await sensors.ensureAccess('microphone');
    } catch {
      toast.error(t('composer.voiceMicUnavailable'));
      return false;
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
      return false;
    }
    let fellBack: boolean;
    let acquired: ActiveRecording;
    try {
      // 每次按录取当前设备偏好（设置页「硬件」分区可换设备；空 = 系统默认）。
      const opened = await sensors.open('microphone');
      // 拿到流即统一停播（修订 v2 V2-3 P2-1）：播报队列与手动朗读共用
      // speech-audio 唯一声道，录音开采时扬声器必须让位（否则麦克风采到的
      // 是自己 TTS 的回声）——idle 态的播报正卡在「playing 但 phase=idle」
      //（手动朗读），interruptSpeech 对它 no-op，只能在这里停。stop() 把在播
      // 请求以「被抢占」收场（ended resolve 不挂起、不误报失败，onPreempted
      // 的 epoch 守卫保证与 interruptSpeech 双触发只作废一次）；语音模式
      // speaking 的清队收尾仍由 startVoiceModeRecording 的 interruptSpeech
      // 负责（队列语义与裸停音频正交）。TCC 等待期（open 之前）不打断。
      speechAudio.stop();
      try {
        acquired = await startVoiceRecording(opened.stream, onLevel);
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
        return false;
      }
      // 失败原因透传（getUserMedia / addModule 的底层异常），定位设备问题用。
      toast.error(
        t('composer.voiceMicFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
    if (session !== recordingSession) {
      // 授权弹框期间已有后续会话（finish / 退出语音模式 / 再次按录）：立即释放
      // 刚拿到的麦克风。
      acquired.cancel();
      return false;
    }
    activeRecording = acquired;
    // 所选设备不可用已回退系统默认：显式告知，不静默（D76）。
    if (fellBack) toast.warning(t('composer.micFellBack'));
    return true;
  }

  async function startRecording(): Promise<void> {
    if (readOnly || recording !== null || voiceBusy) return;
    if (!settingsStore.isCapabilityReady('asr')) {
      chatSession.requestCapabilitySetup('asr');
      return;
    }
    const session = ++recordingSession;
    const started = await acquireRecording(session, (level) => {
      if (recording !== null) recording.level = level;
    });
    if (!started) return;
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
        chatSession.requestCapabilitySetup('asr');
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

  // --- 语音对话模式（docs/design/53-voice-conversation.md，D106）------------
  // 输入坞原位切语音条（VoiceModeBar），说话停止后按 26 号「语音消息语义」
  // 发送：转写文本作消息正文 + WAV 音频附件。UI 状态在 voice-mode.svelte.ts
  //（四态状态机），录音传感器链路复用 acquireRecording，发送编排在
  // voice-send.ts（复用 performComposerSend / sendGuard）；Bot 播报（speaking
  // 态）见下方「Bot 播报」分段（队列在 voice-mode，依赖在此注入）。
  // 静音自动发送（修订 v2 V2-4）：端点检测状态机在 voice-mode（feedLevel 纯
  // 函数），本文件只接信号——待发送武装 2s 自动发送倒计时、5s 未说话自动取消。

  /** 入口可见性：仅私聊（direct / card）且非项目组；readOnly 分支整体不出输入坞。 */
  const voiceModeEntryVisible = $derived(!isProject);
  /** 录音中禁用入口（文字语音输入进行时不得切入语音模式）。 */
  const voiceModeEntryDisabled = $derived(recording !== null || voiceBusy);
  /**
   * 本实例是否接管语音模式（修订 v2 V2-5 审查 P2）：voiceMode 是模块单例，而
   * 主聊天与卡片对话两个 Composer 可同时挂载（项目会话的 ProjectView 只 CSS
   * 隐藏聊天体）——语音条渲染、播报入队、barge-in 武装与全部收尾路径都只归
   * 归属会话那个实例，否则隐藏实例会抢先把录音写进自己的会话。
   */
  const voiceModeOwned = $derived(voiceMode.owns(chatSession.view?.conversation.id ?? null));

  /**
   * 入口键：预检 asr 与 tts（缺哪个置哪张能力卡、不进入；快照未加载时放行，
   * 由 core 错误码兜底）。都 ready 才进入——语音模式内部不再处理缺能力。
   */
  function enterVoiceMode(): void {
    if (recording !== null || voiceBusy) return;
    const conversationId = chatSession.view?.conversation.id ?? null;
    if (conversationId === null) return; // 视图未载入：无归属会话，不进入
    if (!settingsStore.isCapabilityReady('asr')) {
      chatSession.requestCapabilitySetup('asr');
      return;
    }
    if (!settingsStore.isCapabilityReady('tts')) {
      chatSession.requestCapabilitySetup('tts');
      return;
    }
    // 刷新麦克风权限快照（修订 v2 V2-5 审查 P3）：barge-in 监听只在
    // permission === 'granted' 时武装（不在播报中弹 TCC），hub 启动时不查权限，
    // 不刷新会让本轮播报静默失去语音打断。
    void sensors.refresh('microphone');
    voiceMode.enter(conversationId);
  }

  /**
   * 语音模式的录音一次性计时器统一清撤：60s 上限 + 待发送 2s 自动发送
   * （修订 v2 V2-4）。stop / cancel / exit / 卸载四类收尾路径都必须经过这里
   * ——待发送倒计时漏撤会在退出后误发一条语音消息。
   */
  function clearVoiceModeRecordingTimers(): void {
    if (maxRecordingTimer !== null) {
      clearTimeout(maxRecordingTimer);
      maxRecordingTimer = null;
    }
    autoSendCountdown.disarm();
  }

  /** 退出语音模式：使在途 start 失效、停录音释放流，回文字输入（草稿保留）。 */
  function exitVoiceMode(): void {
    if (!voiceMode.active) return;
    recordingSession += 1;
    clearVoiceModeRecordingTimers();
    activeRecording?.cancel();
    activeRecording = null;
    voiceMode.exit();
  }

  /** 语音条麦克风键（idle = 开始录音 / recording = 停止并转写发送 / speaking = 打断并录音）。 */
  function onVoiceModeMicClick(): void {
    const intent = micIntentFor(voiceMode.phase);
    if (intent === 'start' || intent === 'interrupt') void startVoiceModeRecording();
    else if (intent === 'stop-send') void stopVoiceModeRecording();
    // transcribing 禁用（识别在途）。
  }

  /**
   * 语音条录音：与文字语音输入同一条传感器链路（acquireRecording）。speaking
   * 态点麦克风也走这里——**拿到流之后**才打断播报（53 号风险 #1：TCC 授权弹框
   * 等待期播报继续，不在用户还没开口时白打断）。拿到流后的收尾分两层：
   * acquireRecording 里 speechAudio.stop() 停掉在响的音频（播报 / 手动朗读
   * 通吃，idle 态播报只能靠它）；这里的 interruptSpeech 再清播报队列（epoch
   * 作废、phase 复位——queue 语义，裸停音频不覆盖；idle 态 no-op）。
   */
  async function startVoiceModeRecording(): Promise<void> {
    if (!voiceModeOwned) return;
    if (voiceMode.phase !== 'idle' && voiceMode.phase !== 'speaking') return;
    const session = ++recordingSession;
    const started = await acquireRecording(session, (level) => {
      voiceMode.level = level;
      onVoiceModeLevel(level);
    });
    if (!started) return;
    // 拿到流才打断：停当前音频 + 清空未播队列（插话作废），随即进 recording。
    voiceMode.interruptSpeech();
    voiceMode.dispatch('record-started');
    // 60s 到点自动停止并转写发送；上限从真正开始采集起算（与文字语音输入一致）。
    maxRecordingTimer = setTimeout(() => void stopVoiceModeRecording(), MAX_RECORDING_MS);
  }

  /**
   * 录音电平 → 端点检测接线（修订 v2 V2-4）：映射电平喂状态机（feedLevel 内部
   * 只在 recording 相位生效），按一次性信号接自动收尾——待发送武装 2s 自动发送
   * 倒计时、重新开口撤销、5s 未说话自动取消（不干等 60s 上限）。
   */
  function onVoiceModeLevel(level: number): void {
    const signal = voiceMode.feedLevel(level, Date.now());
    if (signal === 'send-ready') autoSendCountdown.arm();
    else if (signal === 'speech-resumed') autoSendCountdown.disarm();
    else if (signal === 'no-speech') autoCancelNoSpeechRecording();
  }

  /** 全程未说话满 5s（修订 v2 V2-4）：自动取消录音并提示（复用「未识别到语音」）。 */
  function autoCancelNoSpeechRecording(): void {
    if (voiceMode.phase !== 'recording' || voiceMode.hasSpoken) return;
    cancelVoiceModeRecording();
    toast.error(t('composer.voiceNoSpeech'));
  }

  /** 取消录音（丢弃）：Esc（recording 档）、麦克风被停用、退出语音模式。 */
  function cancelVoiceModeRecording(): void {
    if (voiceMode.phase !== 'recording') return;
    recordingSession += 1;
    clearVoiceModeRecordingTimers();
    activeRecording?.cancel();
    activeRecording = null;
    voiceMode.dispatch('settled');
  }

  /**
   * 停止录音并转写发送（麦克风键 / 60s 到点 / 待发送绿键与 2s 到点）：停止采集
   * → 转写 → 附件管道发送，收尾回 idle——发送不等 Bot 回复，立即可再录
   * （53 号半双工）。所有触发都汇入这里，相位守卫保证不会双重收尾。
   */
  async function stopVoiceModeRecording(): Promise<void> {
    if (voiceMode.phase !== 'recording') return;
    recordingSession += 1;
    clearVoiceModeRecordingTimers();
    const active = activeRecording;
    activeRecording = null;
    voiceMode.dispatch('stop-requested');
    if (active === null) {
      voiceMode.dispatch('settled');
      return;
    }
    // 显式只发往发起录音时的会话（转写/上传期间用户可能已切走；切走会退出
    // 语音模式，但这条已说出口的消息仍应落到原会话）。
    const conversationId = chatSession.view?.conversation.id;
    try {
      const result = await active.stop();
      if (result.durationMs < MIN_RECORDING_MS) {
        toast.error(t('composer.voiceTooShort'));
        return;
      }
      if (conversationId !== undefined) {
        await sendVoiceRecording(result, conversationId, voiceSendDeps(conversationId));
      }
    } catch (error) {
      toast.error(
        t('composer.voiceRecordFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      voiceMode.dispatch('settled');
    }
  }

  /**
   * 语音消息发送（26 号「语音消息语义」）的接线：分支编排在 voice-send.ts
   * （空识别不发送 / 缺设置置卡 / 非缺设置空文本 + 附件照发 / guard 忙时排队
   * 串行——不静默丢转写文本），这里只注入转写 RPC、toast、置卡与附件管道。
   */
  function voiceSendDeps(conversationId: string): VoiceSendDeps {
    return {
      transcribe: async (audioBase64) => {
        const result = (await core.call('media.transcribeSpeech', {
          audioBase64,
          audioMime: 'audio/wav',
        })) as { text: string };
        // trim 与空判在 voice-send 编排侧（「没说话」语义集中在被测模块）。
        return result.text;
      },
      onNoSpeech: () => toast.error(t('composer.voiceNoSpeech')),
      onCapabilityMissing: () => chatSession.requestCapabilitySetup('asr'),
      onTranscribeFailed: (error) =>
        toast.error(
          errorText(
            (error as { code?: string } | undefined)?.code,
            t('composer.voiceTranscribeFailed'),
          ),
        ),
      uploadVoiceRecording: (file) => composerDrafts.uploadFiles(conversationId, [file]),
      // 与文字直发共用同一 sendGuard（按会话分闸）：语音侧在 guard 忙时等待
      // 前一条完成后再发（voice-send.ts 头注释，P2-1）。
      guard: sendGuard,
      // 转写落定、进入上传/排队/发送：语音条文案「识别中…」→「发送中…」。
      onSending: () => {
        voiceMode.sending = true;
      },
      composerSend: {
        settle: () => composerDrafts.settle(conversationId),
        // 显式只发往发起录音时的会话：转写/上传/排队期间用户可能已切走。
        // voiceMode 由 voice-send 编排传入（53 号修订 v2 V2-1）：core 记
        // origin:'voice'，Bot 收到纯文本语义；文字直发不带。
        send: (body, attachmentIds, opts) =>
          chatSession.send(conversationId, body, {
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
            ...(opts?.voiceMode === true ? { voiceMode: true } : {}),
          }),
        commit: (attachmentIds) => composerDrafts.commitSent(conversationId, attachmentIds),
        // 语音内容不进输入框，无草稿可回填：发送失败时附件 chip 原样留在
        // composerDrafts，退回文字模式可见可删（53 号「无静默孤儿」）。
        restore: () => undefined,
        inspectAttachments: (attachmentIds) =>
          composerDrafts.inspectAttachments(conversationId, attachmentIds),
        onAttachmentIssue: attachmentIssueReporter(conversationId),
        reportFailure: (code) => chat.reportSendFailure(code),
      },
    };
  }

  // --- Bot 播报（docs/design/53-voice-conversation.md「Bot 语音播报链路」，WP3）
  // 队列与状态机在 voice-mode.svelte.ts（可注入纯逻辑，单测在那边）；音频统一
  // 走 speech-audio.svelte.ts（缓存 + 播放仲裁，修订 v2 V2-3）——这里注入真实
  // 依赖（合成 RPC / objectURL / Audio 元素 / 失败 toast）并订阅消息事件。
  // 播报音频不落附件——文字已在列表，落附件会拖慢落库且污染上下文附件行（53 号）。

  /** atob 手动解码（CSP 同 attachments.svelte.ts：connect-src 不含 data:）。 */
  function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * speech-audio 依赖（53 号修订 v2 V2-3）：Bot 语音音频缓存 + 播放仲裁的真实
   * 接线——合成 RPC / objectURL / 唯一 Audio 元素 / 失败 toast（手动朗读失败
   * 与播报失败同款提示）。播报队列与朗读键共用。
   */
  function speechAudioDeps(): SpeechAudioDeps {
    return {
      synthesize: async (text) => {
        const result = (await core.call('media.synthesizeSpeech', {
          text,
          format: 'mp3',
        })) as { audioBase64: string; mimeType: string };
        return {
          blob: new Blob([base64ToBytes(result.audioBase64)], { type: result.mimeType }),
          mimeType: result.mimeType,
        };
      },
      createObjectUrl: (blob) => URL.createObjectURL(blob),
      revokeObjectUrl: (url) => URL.revokeObjectURL(url),
      createElement: () => new Audio(),
      onToggleFailure: (error) => {
        toast.error(
          errorText((error as { code?: string } | undefined)?.code, t('voiceMode.speakFailed')),
          {
            action: {
              label: t('voiceMode.openSettings'),
              onClick: () => shell.openSettings('models'),
            },
          },
        );
      },
      // 手动朗读开播即打断播报（含合成中的条目）；语音模式之外 no-op（interruptSpeech
      // 只在 speaking 态生效），朗读因此在退出语音模式后依然可用。
      onManualPlayStart: () => voiceMode.interruptSpeech(),
    };
  }

  /** 播报队列依赖：音频经 speech-audio（缓存 + 仲裁）；第一条失败停队 + toast。 */
  function announceDeps(): AnnounceDeps {
    return {
      resolveAudio: (messageId, text) => speechAudio.ensureUrl(messageId, text),
      play: (input) => speechAudio.play(input),
      onFirstFailure: (error) => {
        toast.error(
          errorText((error as { code?: string } | undefined)?.code, t('voiceMode.speakFailed')),
          {
            action: {
              label: t('voiceMode.openSettings'),
              onClick: () => shell.openSettings('models'),
            },
          },
        );
      },
    };
  }

  // 挂载即注入（无响应式依赖，只跑一次）；重复挂载（主聊天 + 卡片对话）时后者
  // 替换前者（attachAnnouncer 先清理旧实例；speech-audio 缓存不清——全局会话级）。
  // 卸载清理走既有的 voiceMode.exit()。
  $effect(() => {
    speechAudio.configure(speechAudioDeps());
    // 播报器归属（P2 同源）：两个 Composer 都挂载时只有归属实例注入队列依赖，
    // 否则后挂载的隐藏实例会顶掉 owner 的 toast / 合成接线。
    if (!voiceModeOwned) return;
    voiceMode.attachAnnouncer(announceDeps());
  });

  // 入队（53 号）：语音模式开启期间经 chat-session 订阅口收 message.created，
  // 入队条件与朗读文本提取在 announceEntryFor（可见性口径 = 消息列表）；截断
  // toast 每条消息一次（enqueue 去重后 announce 返回 false 的不提示）。
  $effect(() => {
    if (!voiceModeOwned) return;
    const conversationId = chatSession.view?.conversation.id ?? null;
    return chatSession.onIncomingMessage((_conversationId, message) => {
      const entry = announceEntryFor(message, {
        conversationId,
        active: voiceMode.active,
        approvals: permissions.approvals,
      });
      if (entry === null) return;
      const enqueued = voiceMode.announce(entry);
      if (enqueued && entry.truncated) {
        // {limit} 占位符：locales.test.ts 的占位符一致性校验兜住 zh/en 同步。
        toast.info(t('voiceMode.truncated', { limit: SPEECH_TEXT_LIMIT }));
      }
    });
  });

  // --- 停止播放键 + 播报中语音打断（barge-in，docs/design/53 修订 v2 V2-5）----
  // 停止播放键（■，VoiceModeBar）：只停播清队回 idle，不开始录音——走既有语义
  // 组合（interruptSpeech 清队 + speechAudio.stop 兜底静音），不新造停止语义。
  // 语音触发打断：纯逻辑状态机在 voice-barge-in.ts（武装 / 拆除 / 一次性触发，
  // 零 DOM import），本文件持有依赖注入（传感器层开流 + AnalyserNode 电平 /
  // clock / 计时器）并挂武装窗口；监听电平只喂 barge-in 判定，不进 feedLevel
  // （端点检测仅 recording 相位生效，互不干扰）。

  /**
   * 停止播放键（修订 v2 V2-5）：speaking 相位停当前音频 + 清播报队列（含合成
   * 中的条目，epoch 作废），相位回 idle，**不开始录音**。interruptSpeech 的
   * 当前播放 stop 经 speech-audio 句柄落为仲裁抢占；speechAudio.stop() 兜底
   * 静音唯一声道（缓存条目保留，可回放）。
   */
  function stopVoiceModePlayback(): void {
    if (!voiceModeOwned || voiceMode.phase !== 'speaking') return;
    voiceMode.interruptSpeech();
    speechAudio.stop();
  }

  /**
   * barge-in 监听会话（DOM 实现，注入给 createBargeInMonitor）：复用传感器层
   * 开一路麦克风流（隐私总闸关闭时 hub 会统一停流；不弹 TCC——监听失败静默
   * 降级，点麦克风打断始终可用）→ AudioContext + AnalyserNode 读 RMS →
   * levelToHeight 映射（与 SPEECH_LEVEL_THRESHOLD / 录音电平同一口径）。
   */
  async function openBargeInSession(): Promise<BargeInSession> {
    const opened = await sensors.open('microphone');
    let context: AudioContext | null = null;
    try {
      context = new AudioContext();
      void context.resume().catch(() => {}); // 挂起态防御（sticky 激活下通常已在运行）
      const source = context.createMediaStreamSource(opened.stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      // 零增益落地（voice-recorder 同款）：不接目的地不会被 graph 拉动。
      const mute = context.createGain();
      mute.gain.value = 0;
      analyser.connect(mute);
      mute.connect(context.destination);
      const buffer = new Float32Array(analyser.fftSize);
      return {
        readLevel: () => {
          analyser.getFloatTimeDomainData(buffer);
          let sum = 0;
          for (let i = 0; i < buffer.length; i += 1) {
            const sample = buffer[i] ?? 0;
            sum += sample * sample;
          }
          return levelToHeight(Math.sqrt(sum / buffer.length));
        },
        close: () => {
          source.disconnect();
          analyser.disconnect();
          mute.disconnect();
          for (const track of opened.stream.getTracks()) track.stop();
          void context?.close().catch(() => {});
        },
      };
    } catch (error) {
      for (const track of opened.stream.getTracks()) track.stop();
      void context?.close().catch(() => {});
      throw error;
    }
  }

  const bargeInMonitor = createBargeInMonitor({
    timers: {
      timeout: (delayMs, handler) => {
        const handle = setTimeout(handler, delayMs);
        return () => clearTimeout(handle);
      },
      interval: (intervalMs, handler) => {
        const handle = setInterval(handler, intervalMs);
        return () => clearInterval(handle);
      },
    },
    now: () => Date.now(),
    open: () => openBargeInSession(),
    onTrigger: () => void onBargeInTriggered(),
  });

  /**
   * barge-in 触发（监听判定用户开口，监听已在状态机内自拆）：先停播清队——
   * TCC 等待期不回播（打断时机绑定「触发即停播、录音拿到流才开始」，53 号
   * 风险 #1 同语义）；再走与点麦克风同一条 startVoiceModeRecording 链路
   * （acquireRecording 内含隐私总闸 / TCC 门 / sensors.open 全部守卫）。
   */
  function onBargeInTriggered(): void {
    // 两个 Composer（主聊天 + 卡片对话）并存时各挂一份监听，同拍触发会走两次
    // 本回调：先到者 interruptSpeech 已把相位翻出 speaking，后到者在此放弃——
    // 只起一条录音链路。
    if (!voiceModeOwned || voiceMode.phase !== 'speaking') return;
    voiceMode.interruptSpeech();
    speechAudio.stop();
    void startVoiceModeRecording();
  }

  /**
   * 武装窗口（仅播报队列 playing 阶段；合成中无声音不监听，手动朗读开播即打断
   * 播报、相位已不在 speaking）。active / phase / speakingStage / 麦克风总闸任一
   * 变化都会重跑：条件不再成立（播完 / 打断 / 清队 / 退出模式 / 切会话 / 组件
   * 卸载）即走 cleanup 拆除（含取消未到点的武装定时器与在途 open）。主聊天与
   * 卡片对话两个 Composer 并存时会各挂一份监听——触发后 interruptSpeech 只在
   * speaking 相位生效一次、effects cleanup 同拍拆除另一份，不会双重起录音。
   */
  $effect(() => {
    if (!voiceModeOwned) return;
    if (voiceMode.phase !== 'speaking' || voiceMode.speakingStage !== 'playing') return;
    if (!sensors.state.microphone.enabled) return; // 隐私总闸：不开监听
    // 权限门：只对已授权设备开监听流——未授权 / 未查询时空 `sensors.open` 会在
    // 播报中弹 TCC 授权框（用户只是在听回复），违背「监听失败静默降级」。用户
    // 经由本模式录过一次音即授权，之后监听自然可用。
    if (sensors.state.microphone.permission !== 'granted') return;
    bargeInMonitor.arm();
    return () => bargeInMonitor.disarm();
  });

  // --- 附件上传（docs/design/20-conversation-media.md） ----------------------
  // 上传管道在 composerDrafts（按会话缓存）；这里只负责收集文件与视图操作。

  // D96 远程端点（web 构建）：附件上传按 desktop-only 能力裁剪（设计 §3.2「本地
  // 文件选择对话框」；手机相册上行是 P1）——按钮置灰、title 提示，不隐藏入口。
  const canAttachFiles = $derived(endpointSupports('local-file-dialog'));

  function pickFiles(): void {
    if (!canAttachFiles) return;
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
    const conversationId = chatSession.view?.conversation.id;
    if (!conversationId) return;
    composerDrafts.uploadFiles(conversationId, files);
  }

  function removePendingUpload(key: string): void {
    const conversationId = chatSession.view?.conversation.id;
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
        {#if voiceModeOwned}
          <!-- 语音对话条（53 号 D106）：语音模式占输入坞原位（同层替换，不走
               fixed/Portal，不接 data-window-overlay），消息列表始终可见可滚动；
               待发送附件 chips / 引用条不在此渲染（草稿仍共用 composerDrafts）。 -->
          <VoiceModeBar
            onMicClick={onVoiceModeMicClick}
            onStopClick={stopVoiceModePlayback}
            onClose={exitVoiceMode}
          />
        {:else}
          <!-- 输入坞（参考 Grok）：引用条 / 待发送附件内嵌在圆角容器里；
             输入区垫底；单行＝输入与按钮同行，多行＝输入占满整宽、按钮沉底。
             背景用 surface-raised（比背景亮一级）；粘贴/拖拽文件即上传附件 -->
          <div
            class="relative flex flex-col gap-1 rounded-3xl border bg-surface-raised px-1.5 py-0.5 transition-colors focus-within:border-ring/40 {dragOver
              ? 'border-ring/60'
              : ''}"
            bind:this={composerPillEl}
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
                {#if (replyTo.attachments ?? []).length > 0}
                  <!-- 被引用的图片等附件（图片消息没有正文文字，空文本块靠它可辨） -->
                  <QuotedMedia attachments={replyTo.attachments ?? []} />
                {/if}
                <button
                  type="button"
                  class="shrink-0 rounded-full p-1 hover:bg-accent"
                  onclick={() => (chatSession.replyTo = null)}
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
                class="size-8 shrink-0 rounded-full border-border text-muted-foreground hover:text-foreground {canAttachFiles
                  ? ''
                  : 'opacity-50'}"
                onclick={pickFiles}
                disabled={readOnly}
                aria-disabled={readOnly ? undefined : !canAttachFiles}
                title={canAttachFiles ? t('composer.attach') : t('settings.desktopOnly')}
                aria-label={t('composer.attach')}
                data-testid="composer-attach"
              >
                <Plus class="size-4" />
              </Button>
            {/snippet}
            {#snippet voiceModeEntry()}
              {#if voiceModeEntryVisible}
                <!-- 语音对话入口（53 号 D106）：附件键旁；录音中禁用，点击预检
                   asr + tts（缺哪个置哪张能力卡，不进入）。 -->
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-8 shrink-0 rounded-full border-border text-muted-foreground hover:text-foreground"
                  onclick={enterVoiceMode}
                  disabled={voiceModeEntryDisabled}
                  title={t('voiceMode.entry')}
                  aria-label={t('voiceMode.entry')}
                  data-testid="composer-voice-mode-entry"
                >
                  <Speech class="size-4" />
                </Button>
              {/if}
            {/snippet}
            {#snippet sendButton()}
              <!-- 原生 button 才能吃 style:（Button 组件不转发该指令）。
                 取到预置色时内联盖住 primary；悬停改透明度，避免 hover 主色盖回来。 -->
              <button
                type="button"
                class={cn(
                  buttonVariants({ size: 'icon' }),
                  'shrink-0 rounded-full',
                  botAvatarButtonPaint ? 'hover:opacity-90' : '',
                )}
                style:background={botAvatarButtonPaint?.background}
                style:color={botAvatarButtonPaint?.color}
                onclick={onSendClick}
                disabled={readOnly}
                data-testid="composer-send"
                aria-label={t('composer.send')}
              >
                <ArrowUp class="size-4" />
              </button>
            {/snippet}
            <!-- 两态布局（参考 Grok）：单行＝附件键｜输入｜发送键；沉底＝输入
               占满整行，附件键/发送键落到底部两角。@ 文字色与发送/语音键
               取当前 Bot 头像色；mention 经 --mention-color 下发。 -->
            <div class="flex {stacked ? 'flex-col' : 'flex-row items-center'}">
              {#if !stacked}
                <!-- 左下工具行：附件键 + 语音对话键（53 号 D106）。 -->
                <div class="flex shrink-0 items-center gap-1">
                  {@render attachButton()}
                  {@render voiceModeEntry()}
                </div>
              {/if}
              <div
                class={stacked ? 'w-full' : 'w-auto min-w-0 flex-1'}
                style:--mention-color={botAvatarColor?.hex ?? ''}
              >
                <div bind:this={editorHostEl}></div>
              </div>
              <div
                class="flex items-center {stacked
                  ? 'w-full justify-between pt-0.5 pb-1'
                  : 'pr-0.5'}"
              >
                {#if stacked}
                  <div class="flex items-center gap-1">
                    {@render attachButton()}
                    {@render voiceModeEntry()}
                  </div>
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
                        <span class="size-2.5 rounded-[3px] bg-foreground" aria-hidden="true"
                        ></span>
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
                  {:else if !hasContent}
                    <!-- 语音键：点击开始录音（录音中原位变胶囊）；有内容时
                       此位让给发送键。语音对话模式的入口在左下工具行（Speech 键）。 -->
                    <button
                      type="button"
                      class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-opacity hover:opacity-90 {botAvatarButtonPaint
                        ? ''
                        : 'bg-foreground text-background'}"
                      style:background={botAvatarButtonPaint?.background}
                      style:color={botAvatarButtonPaint?.color}
                      onclick={() => void startRecording()}
                      disabled={readOnly}
                      aria-label={t('composer.voiceStart')}
                      data-testid="composer-voice-start"
                    >
                      <AudioLines class="size-4" />
                    </button>
                  {/if}
                  {#if hasContent}
                    {@render sendButton()}
                  {/if}
                </div>
              </div>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
