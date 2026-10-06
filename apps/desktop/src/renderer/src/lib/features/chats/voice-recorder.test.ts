import { describe, expect, it } from 'vitest';
import { encodeWav, formatRecordingDuration, levelToHeight } from './voice-recorder';

/**
 * 录音模块的纯函数（docs/design/26-voice-input.md）：WAV 容器编码、时长展示、
 * 电平映射。采集链路（getUserMedia/AudioWorklet）需要真实麦克风，不在单测内。
 */

describe('encodeWav', () => {
  it('生成 44 字节头 + 16-bit 单声道 PCM 的 WAV 容器', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const blob = encodeWav(samples, 16_000);
    expect(blob.type).toBe('audio/wav');
    const view = new DataView(await blob.arrayBuffer());
    expect(blob.size).toBe(44 + samples.length * 2);
    expect(
      String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)),
    ).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint16(34, true)).toBe(16); // bits
    // 振幅 0.5 → 0x4000 附近（Int16），-0.5 → -0x4000 附近。
    expect(view.getInt16(44 + 1 * 2, true)).toBeGreaterThan(10_000);
    expect(view.getInt16(44 + 2 * 2, true)).toBeLessThan(-10_000);
    // 超出 [-1,1] 的样本被夹紧。
    const clipped = new Float32Array([2]);
    const clippedView = new DataView(await encodeWav(clipped, 16_000).arrayBuffer());
    expect(clippedView.getInt16(44, true)).toBe(32_767);
  });
});

describe('formatRecordingDuration', () => {
  it('按 m:ss 展示并向下取整', () => {
    expect(formatRecordingDuration(0)).toBe('0:00');
    expect(formatRecordingDuration(7_400)).toBe('0:07');
    expect(formatRecordingDuration(61_000)).toBe('1:01');
  });
});

describe('levelToHeight', () => {
  it('RMS 电平映射到 0..1，安静环境也有可见起伏', () => {
    expect(levelToHeight(0)).toBe(0);
    expect(levelToHeight(0.01)).toBeGreaterThan(0);
    expect(levelToHeight(0.5)).toBeLessThanOrEqual(1);
    expect(levelToHeight(99)).toBe(1);
  });
});
