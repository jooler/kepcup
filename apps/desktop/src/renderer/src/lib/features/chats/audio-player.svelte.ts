/**
 * 统一 H5 音频播放器的状态机（docs/design/53-voice-conversation.md 修订 v2
 * V2-2）：用户语音 wav 附件与 Bot 音频文件产物共用一个 AudioPlayer 组件——
 * 播放/暂停键 + 可点进度条 + 时长。本模块持状态与元素事件（runes，随组件
 * 实例化），AudioPlayer.svelte 只做展示；元素以最小依赖面注入（bind:this 的
 * HTMLAudioElement 结构兼容，测试用假元素驱动事件）。
 *
 * 状态：idle（未播）/ playing / paused / ended（播完，再点从头重播）。
 */

export type AudioPlayerStatus = 'idle' | 'playing' | 'paused' | 'ended';

/** 播放器依赖的元素面（HTMLAudioElement 子集；测试注入假元素）。 */
export interface AudioPlayerElement {
  currentTime: number;
  duration: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(
    type: 'play' | 'pause' | 'ended' | 'timeupdate' | 'loadedmetadata' | 'error',
    handler: () => void,
  ): void;
  removeEventListener(
    type: 'play' | 'pause' | 'ended' | 'timeupdate' | 'loadedmetadata' | 'error',
    handler: () => void,
  ): void;
}

export class AudioPlayerState {
  status = $state<AudioPlayerStatus>('idle');
  currentTime = $state(0);
  duration = $state(0);

  #element: AudioPlayerElement | null = null;

  /** 绑定元素（bind:this；null = 解绑）。重复绑同一元素 no-op。 */
  attach(element: AudioPlayerElement | null): void {
    if (this.#element === element) return;
    this.#detach();
    this.#element = element;
    if (element === null) return;
    element.addEventListener('play', this.#onPlay);
    element.addEventListener('pause', this.#onPause);
    element.addEventListener('ended', this.#onEnded);
    element.addEventListener('timeupdate', this.#onTimeUpdate);
    element.addEventListener('loadedmetadata', this.#onMetadata);
    element.addEventListener('error', this.#onError);
    // preload="metadata" 时 duration 在绑定后不久才就绪；先取一次现值。
    this.duration = Number.isFinite(element.duration) ? element.duration : 0;
  }

  /** 播放/暂停开关：playing → 暂停；paused / ended（归零重播）/ idle → 播放。 */
  toggle(): void {
    const element = this.#element;
    if (element === null) return;
    if (this.status === 'playing') {
      element.pause();
      return;
    }
    if (this.status === 'ended') element.currentTime = 0;
    void element.play().catch(() => {
      // 自动播放被拒 / 源失效：回 idle，用户可再点（按钮交互本身就是用户手势）。
      this.status = 'idle';
    });
  }

  /** 按进度条点击位置（0..1）跳转；ended 态跳转后停在 paused，可续播。 */
  seekToFraction(fraction: number): void {
    const element = this.#element;
    if (element === null || !Number.isFinite(element.duration) || element.duration <= 0) return;
    element.currentTime = Math.min(Math.max(fraction, 0), 1) * element.duration;
    this.currentTime = element.currentTime;
    if (this.status === 'ended') this.status = 'paused';
  }

  /** 进度条填充比例（0..1；时长未知时 0）。 */
  get progress(): number {
    return this.duration > 0 ? Math.min(1, this.currentTime / this.duration) : 0;
  }

  #detach(): void {
    const element = this.#element;
    if (element === null) return;
    element.removeEventListener('play', this.#onPlay);
    element.removeEventListener('pause', this.#onPause);
    element.removeEventListener('ended', this.#onEnded);
    element.removeEventListener('timeupdate', this.#onTimeUpdate);
    element.removeEventListener('loadedmetadata', this.#onMetadata);
    element.removeEventListener('error', this.#onError);
  }

  // 自然播完序列：pause 事件先于 ended（HTML 规范），最终态落在 ended。
  #onPlay = (): void => {
    this.status = 'playing';
  };

  #onPause = (): void => {
    if (this.status === 'ended') return; // 播完序列的 pause，让位给 ended
    this.status = 'paused';
  };

  #onEnded = (): void => {
    this.status = 'ended';
  };

  #onTimeUpdate = (): void => {
    this.currentTime = this.#element?.currentTime ?? 0;
  };

  #onMetadata = (): void => {
    const duration = this.#element?.duration ?? NaN;
    this.duration = Number.isFinite(duration) ? duration : 0;
  };

  #onError = (): void => {
    this.status = 'idle';
  };
}

/** 秒 → m:ss（时长未知 / 非法按 0:00，进度条与时长占位一致）。 */
export function formatAudioDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
