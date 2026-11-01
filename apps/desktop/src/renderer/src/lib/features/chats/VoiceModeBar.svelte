<script lang="ts">
  import { Loader2, Mic, Settings, X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { shell } from '$lib/stores/shell.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { getChatSession } from './chat-session-context';
  import { micIntentFor, voiceMode } from './voice-mode.svelte';
  import { formatRecordingDuration } from './voice-recorder';

  /**
   * 语音对话条（docs/design/53-voice-conversation.md，D106）：语音模式下占据
   * 输入坞原位（Composer 同层替换渲染，不走 fixed / Portal——不与窗口拖拽带
   * 重叠）。布局：Bot 头像 ｜ 波形/状态区（弹性）｜ 设置键 · 麦克风键 · 关闭键。
   * 只做展示与转发（mic / close 回调交给 Composer 编排）；录音 / 转写 / 发送
   * 的编排在 Composer，speaking 态是 WP3 播报队列的占位。
   */
  let {
    onMicClick,
    onClose,
  }: {
    /** 麦克风键点击（idle = 开始录音，recording = 停止并转写发送）。 */
    onMicClick: () => void;
    /** 关闭键 / 退出语音模式（停止录音 + 释放流 + 回文字输入）。 */
    onClose: () => void;
  } = $props();

  const chatSession = getChatSession();
  const phase = $derived(voiceMode.phase);
  const micIntent = $derived(micIntentFor(phase));
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
    phase === 'recording' ? t('voiceMode.stopAndSend') : t('voiceMode.startRecording'),
  );
</script>

<div
  class="flex h-14 items-center gap-1 rounded-3xl border bg-surface-raised px-1.5"
  role="group"
  aria-label={t('voiceMode.entry')}
  data-testid="voice-mode-bar"
  data-phase={phase}
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
    {:else if phase === 'transcribing'}
      <Loader2 class="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      <span class="truncate text-sm text-muted-foreground">{t('voiceMode.transcribing')}</span>
    {:else if phase === 'speaking'}
      <!-- speaking（WP3 播报队列接入）的占位：先按「合成中 Loader」形态。 -->
      <Loader2 class="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      <span class="truncate text-sm text-muted-foreground">{t('voiceMode.speaking')}</span>
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
  <Button
    variant="ghost"
    size="icon"
    class="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
    onclick={() => {
      if (micIntent !== 'disabled') onMicClick();
    }}
    disabled={micIntent === 'disabled'}
    title={micLabel}
    aria-label={micLabel}
    data-testid="voice-mode-mic"
    data-intent={micIntent}
  >
    {#if phase === 'recording'}
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
