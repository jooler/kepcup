<script lang="ts">
  import { Loader2, Mic, Send, Settings, Square, X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils.js';
  import { shell } from '$lib/stores/shell.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { getChatSession } from './chat-session-context';
  import { micIntentFor, voiceMode } from './voice-mode.svelte';
  import { formatRecordingDuration } from './voice-recorder';

  /**
   * 语音对话条（docs/design/53-voice-conversation.md，D106）：语音模式下占据
   * 输入坞原位（Composer 同层替换渲染，不走 fixed / Portal——不与窗口拖拽带
   * 重叠）。布局：Bot 头像 ｜ 波形/状态区（弹性）｜ 设置键 · 停止播放键 ·
   * 麦克风键 · 关闭键。只做展示与转发（stop / mic / close 回调交给 Composer
   * 编排）；录音 / 转写 / 发送编排在 Composer，speaking 态由 voice-mode 播报
   * 队列驱动（合成中 / 播放中）。待发送子态（修订 v2 V2-4）：静音 3s 后麦克风
   * 键变绿色发送键（点击 = 立即停止转写发送，2s 无操作自动发送）。停止播放键
   * （修订 v2 V2-5）：仅 speaking 相位出现，点击只停播清队回 idle，不开始录音。
   */
  let {
    onMicClick,
    onStopClick,
    onClose,
  }: {
    /** 麦克风键点击（idle = 开始录音，recording = 停止并转写发送）。 */
    onMicClick: () => void;
    /** 停止播放键（V2-5，仅 speaking 相位渲染）：停当前 + 清播报队列，不录音。 */
    onStopClick: () => void;
    /** 关闭键 / 退出语音模式（停止录音 + 释放流 + 回文字输入）。 */
    onClose: () => void;
  } = $props();

  const chatSession = getChatSession();
  const phase = $derived(voiceMode.phase);
  const micIntent = $derived(micIntentFor(phase));
  /** 待发送子态（V2-4）：store 已保证 sendReady 只在 recording 相位为真，这里再与相位求交防御。 */
  const sendReady = $derived(phase === 'recording' && voiceMode.sendReady);
  const bot = $derived(chatSession.view?.conversation.bot ?? null);
  const botName = $derived(bot?.name || chatSession.view?.conversation.directBotId || '');
  /** idle 态的提示文案：run 进行中显示「正在思考…」（53 号交互状态机）。 */
  const runActive = $derived(chatSession.activeRuns.length > 0);

  // 录音计时：recording 态下 200ms 更新（对齐文字录音胶囊的节奏）。
  $effect(() => {
    if (voiceMode.phase !== 'recording') return;
    const startedAt = voiceMode.recordingStartedAt;
    const timer = setInterval(() => {
      voiceMode.elapsedMs = Date.now() - startedAt;
    }, 200);
    return () => clearInterval(timer);
  });

  // 波形（53 号 D106：复用 recording.level——onLevel 已过 levelToHeight——加
  // voice-dot 呼吸动画）：中间高两侧低的固定轮廓 × 当前电平，静默时留 3px 底。
  const WAVE_PROFILE = [0.55, 0.8, 1, 0.8, 0.55] as const;
  const waveBarPx = $derived(
    WAVE_PROFILE.map((factor) => Math.max(3, Math.round(voiceMode.level * factor * 22))),
  );

  const micLabel = $derived(
    sendReady
      ? t('voiceMode.sendNow')
      : phase === 'recording'
        ? t('voiceMode.stopAndSend')
        : phase === 'speaking'
          ? t('voiceMode.interruptAndRecord')
          : t('voiceMode.startRecording'),
  );
</script>

<div
  class="flex h-14 items-center gap-1 rounded-3xl border bg-surface-raised px-1.5"
  role="group"
  aria-label={t('voiceMode.entry')}
  data-testid="voice-mode-bar"
  data-phase={phase}
  data-speaking-stage={voiceMode.speakingStage ?? undefined}
  data-send-ready={sendReady ? 'true' : undefined}
>
  <BotAvatar
    botId={chatSession.view?.conversation.directBotId ?? ''}
    name={botName}
    avatar={bot?.avatar ?? null}
    mask={bot?.avatarMask ?? null}
    padding={bot?.avatarPadding ?? null}
    class="mx-1.5 size-9"
  />
  <div class="flex min-w-0 flex-1 items-center gap-2.5 px-1" data-testid="voice-mode-status">
    {#if phase === 'recording'}
      <span class="flex items-end gap-1" aria-hidden="true">
        {#each waveBarPx as height, index (index)}
          <span
            class="voice-dot w-1 rounded-full bg-foreground/70"
            style="height:{height}px; animation-delay:{index * 0.18}s"
          ></span>
        {/each}
      </span>
      <span class="text-sm text-foreground tabular-nums" data-testid="voice-mode-elapsed">
        {formatRecordingDuration(voiceMode.elapsedMs)}
      </span>
      {#if sendReady}
        <!-- 待发送（V2-4）：波形与计时照常，追加静音自动发送提示。 -->
        <span class="truncate text-sm text-emerald-600" data-testid="voice-mode-send-ready-hint">
          {t('voiceMode.sendReadyHint')}
        </span>
      {/if}
    {:else if phase === 'transcribing'}
      <Loader2 class="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      <!-- 识别与发送共用 transcribing 相位：转写落定后（onSending）切「发送中…」。 -->
      <span class="truncate text-sm text-muted-foreground" data-testid="voice-mode-transcribing">
        {voiceMode.sending ? t('voiceMode.sending') : t('voiceMode.transcribing')}
      </span>
    {:else if phase === 'speaking'}
      <!-- speaking 两阶段（53 号交互状态机）：合成中 Loader（TTS 整段非流式，长
           回复可能合成数秒，风险 #2）→ 播放中动画波形（真实电平是 P3）。 -->
      {#if voiceMode.speakingStage === 'playing'}
        <span
          class="flex items-end gap-1"
          aria-hidden="true"
          data-testid="voice-mode-speaking-wave"
        >
          {#each WAVE_PROFILE as factor, index (index)}
            <span
              class="voice-dot w-1 rounded-full bg-foreground/70"
              style="height:{Math.round(factor * 16) + 3}px; animation-delay:{index * 0.18}s"
            ></span>
          {/each}
        </span>
      {:else}
        <Loader2 class="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      {/if}
      <span class="truncate text-sm text-muted-foreground" data-testid="voice-mode-speaking">
        {voiceMode.speakingStage === 'playing'
          ? t('voiceMode.speaking')
          : t('voiceMode.synthesizing')}
      </span>
    {:else if runActive}
      <span class="truncate text-sm text-muted-foreground" data-run-active="true">
        {t('voiceMode.thinking')}
      </span>
    {:else}
      <span class="truncate text-sm text-muted-foreground">{t('voiceMode.idleHint')}</span>
    {/if}
  </div>
  <!-- 设置键：asr / tts 能力模型都在设置页「模型」分区，深链直达（53 号 D106）。 -->
  <Button
    variant="ghost"
    size="icon"
    class="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
    onclick={() => shell.openSettings('models')}
    title={t('voiceMode.settings')}
    aria-label={t('voiceMode.settings')}
    data-testid="voice-mode-settings"
  >
    <Settings class="size-4" />
  </Button>
  {#if phase === 'speaking'}
    <!-- 停止播放键（修订 v2 V2-5）：合成中与播放中都显示（合成中点击 = 连还没播
         的队列一起取消）；点击只停播清队回 idle，不开始录音（录音走麦克风键）。 -->
    <Button
      variant="ghost"
      size="icon"
      class="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
      onclick={onStopClick}
      title={t('voiceMode.stopPlayback')}
      aria-label={t('voiceMode.stopPlayback')}
      data-testid="voice-mode-stop"
    >
      <Square class="size-4" />
    </Button>
  {/if}
  <Button
    variant="ghost"
    size="icon"
    class={cn(
      'size-8 shrink-0 rounded-full',
      sendReady
        ? // 待发送（V2-4）：绿色发送键，点击 = 立即停止转写发送。
          'bg-emerald-600 text-white hover:bg-emerald-600 hover:text-white'
        : 'text-muted-foreground hover:text-foreground',
    )}
    onclick={() => {
      if (micIntent !== 'disabled') onMicClick();
    }}
    disabled={micIntent === 'disabled'}
    title={micLabel}
    aria-label={micLabel}
    data-testid="voice-mode-mic"
    data-intent={micIntent}
    data-send-ready={sendReady ? 'true' : undefined}
  >
    {#if sendReady}
      <!-- 绿色发送键（V2-4）：点击立即发送，2s 无操作自动发送。 -->
      <Send class="size-4" aria-hidden="true" />
    {:else if phase === 'recording'}
      <!-- 实心 ■：点击 = 停止并转写发送（与文字录音胶囊同款视觉）。 -->
      <span class="size-2.5 rounded-[3px] bg-foreground" aria-hidden="true"></span>
    {:else}
      <Mic class="size-4" />
    {/if}
  </Button>
  <Button
    variant="ghost"
    size="icon"
    class="size-8 shrink-0 rounded-full text-muted-foreground hover:text-destructive"
    onclick={onClose}
    title={t('voiceMode.close')}
    aria-label={t('voiceMode.close')}
    data-testid="voice-mode-close"
  >
    <X class="size-4 text-destructive" />
  </Button>
</div>
