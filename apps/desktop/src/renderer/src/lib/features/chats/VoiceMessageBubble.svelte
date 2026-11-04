<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { Loader2, Pause, Play } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { avatarOnFillForeground, resolveAccentColor } from '$lib/avatars/presets';
  import { formatAudioDuration } from './audio-player.svelte';
  import { attachmentUrl } from './attachments.svelte';
  import { getChatSession } from './chat-session-context';
  import { speechAudio } from './speech-audio.svelte';
  import { voiceMode } from './voice-mode.svelte';
  import { voiceAttachmentOf, voiceCaptionOf, voiceWaveformProfile } from './voice-message';

  /**
   * 语音消息气泡（docs/design/53-voice-conversation.md 修订 v3）：语音对话模式
   * 下双方消息的形态——药丸外形、左侧播放/暂停状态图标、主体波形（已播部分着色，即进度）、
   * 点击整个容器播放 / 暂停，正文以 caption 放在气泡下方。用户消息的音频来自
   * 原始录音附件，Bot 消息由 speech-audio 按需合成；两者共用唯一音频声道，
   * 因此点击任一条都会停掉正在播的另一条（含播报队列）。用户气泡的底色跟随
   * 当前对话 Bot 的强调色（与用户文本气泡同一取色口径）。
   */
  let { message }: { message: Message } = $props();

  const session = getChatSession();
  const isUser = $derived(message.senderType === 'user');
  const caption = $derived(voiceCaptionOf(message));
  const attachment = $derived(voiceAttachmentOf(message));
  const waveform = $derived(voiceWaveformProfile(message.id));
  /**
   * 用户气泡的强调色（与 MessageBody 的用户文本气泡同源）：显式 accentColor →
   * 预置头像内嵌色 → mono；无对话 Bot（项目组不会进语音模式）时不取色，回退
   * 主色。前景色按填充色亮度取黑白，保证波形/图标始终可读。
   */
  const userAccent = $derived(
    isUser && session.view?.conversation.bot
      ? resolveAccentColor(
          session.view.conversation.bot.accentColor,
          session.view.conversation.bot.avatar,
        )
      : null,
  );
  const userForeground = $derived(userAccent ? avatarOnFillForeground(userAccent) : undefined);

  const isCurrent = $derived(speechAudio.currentId === message.id);
  const playing = $derived(isCurrent && speechAudio.isPlaying);
  const progress = $derived(isCurrent ? speechAudio.progress : 0);
  const playedBars = $derived(Math.round(progress * waveform.length));
  const durationLabel = $derived(
    isCurrent && speechAudio.duration > 0 ? formatAudioDuration(speechAudio.duration) : '',
  );
  const label = $derived(
    playing
      ? t('voiceMode.pauseVoice')
      : isCurrent
        ? t('voiceMode.resumeVoice')
        : t('voiceMode.playVoice'),
  );

  let loading = $state(false);
  /**
   * 麦克风占用（语音模式录音 / 识别中）时禁用播放：录音起点已统一停播，但
   * 用户此时再点气泡会把 TTS 外放录进转写（V2-3 的半双工约束，朗读键在 v2
   * 就是同一门禁）。
   */
  const disabled = $derived(voiceMode.phase === 'recording' || voiceMode.phase === 'transcribing');

  async function toggle(): Promise<void> {
    if (loading || disabled) return;
    loading = true;
    try {
      // 用户消息：原始录音附件（首次点击才拉字节）；Bot 消息：TTS 缓存 / 合成。
      if (attachment !== null) {
        await speechAudio.toggleSource(message.id, () => attachmentUrl(attachment));
      } else {
        await speechAudio.toggle(message);
      }
    } finally {
      loading = false;
    }
  }
</script>

<div class="flex max-w-full min-w-0 flex-col {isUser ? 'items-end' : 'items-start'}">
  <button
    type="button"
    class="flex h-11 w-64 max-w-full items-center gap-2.5 rounded-full px-2.5 text-left transition-opacity hover:opacity-90 cursor-pointer {isUser
      ? userAccent
        ? ''
        : 'bg-primary text-primary-foreground'
      : 'bg-muted text-foreground'} {disabled ? 'cursor-not-allowed opacity-50' : ''}"
    style:background={isUser ? userAccent?.hex : undefined}
    style:color={isUser ? userForeground : undefined}
    onclick={() => void toggle()}
    {disabled}
    aria-label={label}
    title={label}
    data-testid="voice-message"
    data-sender={isUser ? 'user' : 'bot'}
    data-playing={playing ? 'true' : undefined}
    data-current={isCurrent ? 'true' : undefined}
  >
    <span
      class="flex size-7 shrink-0 items-center justify-center rounded-full {isUser
        ? 'bg-current/15'
        : 'bg-foreground/10'}"
      aria-hidden="true"
    >
      {#if loading}
        <Loader2 class="size-3.5 animate-spin" />
      {:else if playing}
        <Pause class="size-3.5" />
      {:else}
        <Play class="size-3.5" />
      {/if}
    </span>
    <span class="flex h-6 min-w-0 flex-1 items-center gap-[3px]" aria-hidden="true">
      {#each waveform as factor, index (index)}
        <span
          class="w-[3px] shrink-0 rounded-full bg-current transition-opacity duration-150"
          style="height:{Math.round(4 + factor * 16)}px; opacity:{index < playedBars ? 1 : 0.28}"
        ></span>
      {/each}
    </span>
    <span class="w-9 shrink-0 text-right text-[10px] tabular-nums opacity-70">
      {durationLabel}
    </span>
  </button>
  {#if caption.length > 0}
    <p
      class="mt-1 max-w-full px-1 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground select-text"
      data-testid="voice-message-caption"
    >
      {caption}
    </p>
  {/if}
</div>
