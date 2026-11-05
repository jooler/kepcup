import { describe, expect, test, vi } from 'vitest';
import { MicroAppSpeakQueue } from './micro-app-audio';

/**
 * 微应用 TTS 播放队列（D112 §7）：≤3 段、顺序播放、插话（barge-in）停播 + 清队列。
 * 合成与播放都注入替身（node 环境无 DOM / 无 core 连接）。
 */

const synthesizeStub = async (): Promise<{ audioBase64: string; mimeType: string }> => ({
  audioBase64: 'AAAA',
  mimeType: 'audio/mp3',
});

describe('MicroAppSpeakQueue', () => {
  test('顺序播放：两段按入队顺序播完', async () => {
    const played: string[] = [];
    const queue = new MicroAppSpeakQueue('res_test', {
      synthesize: synthesizeStub,
      playAudio: async () => {
        played.push('play');
      },
    });
    await queue.speak({ text: 'one' });
    await queue.speak({ text: 'two' });
    expect(played).toHaveLength(2);
  });

  test('队列上限 3 段（在播 + 排队）：第四段得 WIDGET_RATE_LIMITED', async () => {
    const releasers: Array<() => void> = [];
    const queue = new MicroAppSpeakQueue('res_test', {
      synthesize: synthesizeStub,
      playAudio: () => new Promise<void>((resolve) => releasers.push(resolve)),
    });
    const first = queue.speak({ text: '1' });
    void queue.speak({ text: '2' }).catch(() => undefined);
    void queue.speak({ text: '3' }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await expect(queue.speak({ text: '4' })).rejects.toMatchObject({ code: 'WIDGET_RATE_LIMITED' });
    queue.stopSpeaking();
    for (const release of releasers.splice(0)) release();
    await Promise.allSettled([first]);
  });

  test('插话：播放中电平超阈值 → 停播 + 清队列 + 触发回调', async () => {
    const releasers: Array<() => void> = [];
    const queue = new MicroAppSpeakQueue('res_test', {
      synthesize: synthesizeStub,
      playAudio: () => new Promise<void>((resolve) => releasers.push(resolve)),
    });
    const bargeIn = vi.fn();
    queue.setBargeInListener(bargeIn, 0.06);
    const first = queue.speak({ text: 'hello' });
    const second = queue.speak({ text: 'world' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(queue.speaking).toBe(true);
    // 阈值以下：不打断。
    queue.feedLevelForBargeIn(0.03);
    expect(bargeIn).not.toHaveBeenCalled();
    queue.feedLevelForBargeIn(0.08);
    expect(bargeIn).toHaveBeenCalledTimes(1);
    expect(queue.speaking).toBe(false);
    for (const release of releasers.splice(0)) release();
    await Promise.allSettled([first, second]);
  });

  test('stopSpeaking：清队列（后续段不再播放）', async () => {
    const played: string[] = [];
    const releasers: Array<() => void> = [];
    const queue = new MicroAppSpeakQueue('res_test', {
      synthesize: synthesizeStub,
      playAudio: () => {
        played.push('play');
        return new Promise<void>((resolve) => releasers.push(resolve));
      },
    });
    const first = queue.speak({ text: 'a' });
    const second = queue.speak({ text: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    queue.stopSpeaking();
    for (const release of releasers.splice(0)) release();
    await Promise.allSettled([first, second]);
    expect(played).toHaveLength(1);
  });

  test('非播放期电平不触发插话', () => {
    const queue = new MicroAppSpeakQueue('res_test', {
      synthesize: synthesizeStub,
      playAudio: async () => undefined,
    });
    const bargeIn = vi.fn();
    queue.setBargeInListener(bargeIn, 0.06);
    queue.feedLevelForBargeIn(0.9);
    expect(bargeIn).not.toHaveBeenCalled();
  });
});
