/**
 * 语音对话模式的 UI 状态机（docs/design/53-voice-conversation.md，D106）。
 *
 * 会话内即时态：进入即开启、关闭即退出，不持久化、不跨会话（切换会话 /
 * 组件卸载由 Composer 的 effect 调 exit()）。本模块只持 UI 状态与纯转移
 * 表（单测锚点）；录音传感器链路 / 转写 / 发送编排在 Composer（26 号
 * 「语音消息语义」），Bot 播报队列是 WP3 的扩展（speaking 态先占位）。
 */

/** 四态（53 号交互状态机）；speaking 由 WP3 播报队列驱动，本期不可达。 */
export type VoiceUiPhase = 'idle' | 'recording' | 'transcribing' | 'speaking';

export type VoiceUiEvent =
  /** 拿到麦克风流、采集真正开始——TCC 授权弹框等待期不算（WP3 打断绑这个点）。 */
  | 'record-started'
  /** 点击麦克风键 / 60s 到点：停止采集并转写发送。 */
  | 'stop-requested'
  /** 收尾回空闲：转写发送链路结束（成功 / 空识别 / 失败兜底后）或录音被取消丢弃。 */
  | 'settled';

/** 纯转移表：null = 该态下忽略该事件（防重入，如 transcribing 再按停止）。 */
export function nextVoicePhase(phase: VoiceUiPhase, event: VoiceUiEvent): VoiceUiPhase | null {
  switch (event) {
    case 'record-started':
      return phase === 'idle' ? 'recording' : null;
    case 'stop-requested':
      return phase === 'recording' ? 'transcribing' : null;
    case 'settled':
      return phase === 'idle' ? null : 'idle';
  }
}

/** Esc 分档（53 号）：recording 中先取消录音（丢弃），其余态退出语音模式。 */
export function escapeActionForVoiceMode(
  phase: VoiceUiPhase,
): 'cancel-recording' | 'exit-voice-mode' {
  return phase === 'recording' ? 'cancel-recording' : 'exit-voice-mode';
}

/**
 * 麦克风键在各态的意图：idle 开始 / recording 停止并转写发送 / transcribing
 * 禁用（识别在途）/ speaking 打断并开始录音（WP3 接入，本期不可达）。
 */
export function micIntentFor(
  phase: VoiceUiPhase,
): 'start' | 'stop-send' | 'disabled' | 'interrupt' {
  switch (phase) {
    case 'idle':
      return 'start';
    case 'recording':
      return 'stop-send';
    case 'transcribing':
      return 'disabled';
    case 'speaking':
      return 'interrupt';
  }
}

class VoiceModeState {
  /** 语音条是否接管输入坞（入口即开关，53 号 D106）。 */
  active = $state(false);
  phase = $state<VoiceUiPhase>('idle');
  /** 实时电平（0..1，已经 voice-recorder 的 levelToHeight 映射），驱动波形。 */
  level = $state(0);
  /** 录音计时（ms；VoiceModeBar 的 interval 驱动，200ms 对齐文字录音胶囊）。 */
  elapsedMs = $state(0);
  /** 本次录音起点（Date.now()），elapsedMs 的基准。 */
  recordingStartedAt = $state(0);

  enter(): void {
    this.active = true;
    this.#reset();
  }

  /** 幂等：未开启时同样复位（组件卸载 cleanup 直接调用）。 */
  exit(): void {
    this.active = false;
    this.#reset();
  }

  /** 按纯转移表推进；进 recording 时起表（电平 / 计时清零）。 */
  dispatch(event: VoiceUiEvent): void {
    const next = nextVoicePhase(this.phase, event);
    if (next === null) return;
    if (next === 'recording') {
      this.level = 0;
      this.elapsedMs = 0;
      this.recordingStartedAt = Date.now();
    }
    this.phase = next;
  }

  #reset(): void {
    this.phase = 'idle';
    this.level = 0;
    this.elapsedMs = 0;
    this.recordingStartedAt = 0;
  }
}

export const voiceMode = new VoiceModeState();
