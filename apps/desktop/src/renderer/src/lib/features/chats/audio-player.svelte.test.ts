import { beforeEach, describe, expect, it } from 'vitest';
import {
  AudioPlayerState,
  formatAudioDuration,
  type AudioPlayerElement,
} from './audio-player.svelte';

/**
 * 统一 H5 播放器的状态机（docs/design/53-voice-conversation.md 修订 v2 V2-2）：
 * idle / playing / paused / ended 四态由元素事件驱动，toggle 归零重播、seek
 * 钳制与 ended→paused。元素以最小依赖面注入假实现，事件手工触发。
 */

interface FakeElement extends AudioPlayerElement {
  playCalls: number;
  playError: unknown;
  emit(type: 'play' | 'pause' | 'ended' | 'timeupdate' | 'loadedmetadata' | 'error'): void;
}

function createFakeElement(): FakeElement {
  const handlers = new Map<string, Set<() => void>>();
  const element: FakeElement = {
    currentTime: 0,
    duration: NaN,
    playCalls: 0,
    playError: null,
    play: async () => {
      element.playCalls += 1;
      if (element.playError !== null) throw element.playError;
    },
    pause: () => undefined,
    addEventListener: (type, handler) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener: (type, handler) => {
      handlers.get(type)?.delete(handler);
    },
    emit: (type) => {
      for (const handler of handlers.get(type) ?? []) handler();
    },
  };
  return element;
}

describe('AudioPlayerState（播放/暂停状态机）', () => {
  let element: FakeElement;
  let player: AudioPlayerState;

  beforeEach(() => {
    element = createFakeElement();
    player = new AudioPlayerState();
    player.attach(element);
  });

  it('绑定后读现值；idle 点播放 → playing（play 事件驱动）', () => {
    element.duration = 90;
    element.emit('loadedmetadata');
    expect(player.duration).toBe(90);

    player.toggle();
    expect(element.playCalls).toBe(1);
    expect(player.status).toBe('idle'); // playing 事件未到
    element.emit('play');
    expect(player.status).toBe('playing');
  });

  it('toggle 来回：playing → paused → playing；自然播完 → ended', () => {
    element.duration = 60;
    element.emit('loadedmetadata');
    player.toggle();
    element.emit('play');
    expect(player.status).toBe('playing');

    player.toggle(); // 暂停
    element.emit('pause');
    expect(player.status).toBe('paused');

    player.toggle(); // 续播（currentTime 不动）
    element.emit('play');
    expect(player.status).toBe('playing');
    expect(player.currentTime).toBe(0);

    element.currentTime = 60;
    element.emit('timeupdate');
    element.emit('pause'); // HTML 规范：播完序列 pause 先于 ended
    element.emit('ended');
    expect(player.status).toBe('ended'); // 最终态落在 ended
  });

  it('ended 再点播放 = 归零重播；播放被拒回 idle', async () => {
    element.duration = 30;
    element.emit('loadedmetadata');
    player.toggle();
    element.emit('play');
    element.emit('ended');
    expect(player.status).toBe('ended');

    player.toggle();
    expect(element.currentTime).toBe(0); // 归零
    expect(element.playCalls).toBe(2);
    element.emit('play');
    expect(player.status).toBe('playing');

    element.playError = new Error('not allowed');
    player.toggle(); // 暂停
    element.emit('pause');
    player.toggle(); // 再播被拒
    await Promise.resolve();
    expect(player.status).toBe('idle');
  });

  it('seek 钳制 0..1；ended 态 seek 后停在 paused；时长未知时不动', () => {
    element.duration = 100;
    element.emit('loadedmetadata');
    player.seekToFraction(0.5);
    expect(element.currentTime).toBe(50);
    expect(player.currentTime).toBe(50);

    player.seekToFraction(5); // 越界钳到 1
    expect(element.currentTime).toBe(100);

    element.emit('ended');
    player.seekToFraction(0.2);
    expect(player.status).toBe('paused');

    element.duration = NaN; // 流式未就绪
    player.seekToFraction(0.9);
    expect(element.currentTime).toBe(20); // 不动
  });

  it('progress：时长未知为 0，正常按 currentTime/duration 封顶 1', () => {
    expect(player.progress).toBe(0);
    element.duration = 100;
    element.emit('loadedmetadata');
    element.currentTime = 250;
    element.emit('timeupdate');
    expect(player.progress).toBe(1); // 封顶
    element.currentTime = 40;
    element.emit('timeupdate');
    expect(player.progress).toBeCloseTo(0.4);
  });

  it('解绑后不再收事件（换绑安全）', () => {
    player.attach(null);
    element.emit('play');
    expect(player.status).toBe('idle');
  });
});

describe('formatAudioDuration', () => {
  it('秒 → m:ss；非法 / 非有限值按 0:00', () => {
    expect(formatAudioDuration(0)).toBe('0:00');
    expect(formatAudioDuration(5)).toBe('0:05');
    expect(formatAudioDuration(65)).toBe('1:05');
    expect(formatAudioDuration(601)).toBe('10:01');
    expect(formatAudioDuration(NaN)).toBe('0:00');
    expect(formatAudioDuration(-3)).toBe('0:00');
    expect(formatAudioDuration(Infinity)).toBe('0:00');
  });
});
