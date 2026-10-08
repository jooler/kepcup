/**
 * 麦克风按录（语音输入，docs/design/26-voice-input.md）。
 *
 * 直接采 16kHz 单声道 PCM 并编码 WAV，而不是 MediaRecorder：MediaRecorder 在
 * Chromium 里只产 webm/opus，部分 ASR 厂商（如百炼 qwen3-asr）不收 webm，而
 * WAV 16k mono 全部兼容；采集途中的 PCM 同时用于 RMS 电平回调，驱动波形动画。
 *
 * 采集链路：getUserMedia → AudioContext(16k) → AudioWorklet（独立资源文件，
 * 经 `?url` 同源加载——渲染层 CSP 的 script-src 'self' 拦 blob: 脚本，内联
 * 会让 addModule 直接失败）→ 零增益 GainNode 落地（worklet 不接目的地不会被
 * graph 拉动）。stop() 后拼合 PCM 转 Int16 WAV 并转 base64，一次录音约 ≤2MB（60s）。
 */

// `?url&no-inline`：强制独立资源文件。普通 `?url` 在文件小于 4KB 时会被 Vite
// 内联成 data: URL——打包版 CSP 的 script-src 'self' 照样拦 data: 脚本，问题复发。
import workletModuleUrl from './voice-capture-worklet.js?url&no-inline';

/** 单次录音上限（按住说话 / 语音消息同限）；到点由调用方自动收尾。 */
export const MAX_RECORDING_MS = 60_000;
/** 短于此的录音视为误触，调用方丢弃。 */
export const MIN_RECORDING_MS = 500;
export const SAMPLE_RATE = 16_000;

export interface VoiceRecording {
  /** WAV 容器（audio/wav），发送语音消息时作为附件字节。 */
  blob: Blob;
  /** base64（不带 data: 前缀），media.transcribeSpeech 入参。 */
  base64: string;
  durationMs: number;
}

export interface ActiveRecording {
  /** 停止采集并编码产物（等在途的音频帧落袋）。 */
  stop(): Promise<VoiceRecording>;
  /** 丢弃产物并释放资源（取消手势 / 组件卸载）。 */
  cancel(): void;
}

/** RMS 电平（0..1）映射为视觉高度的粗略指数曲线，安静环境也能看出起伏。 */
export function levelToHeight(level: number): number {
  return Math.min(1, Math.pow(level * 4, 0.6));
}

/** 把底层异常转成可直接展示的技术性原因（调试定位用，headline 由调用方 i18n）。 */
function describeError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 在已打开的麦克风流上开始采集。流由传感器层打开（`sensors.open('microphone')`：
 * 设备偏好、启用开关、设备回退都在那里，docs/design/31-sensors.md）；本模块只管
 * AudioContext / worklet / WAV 编码，并在失败或结束时负责停掉传入的轨道。
 */
export async function startVoiceRecording(
  stream: MediaStream,
  onLevel?: (level: number) => void,
): Promise<ActiveRecording> {
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
  } catch (error) {
    // 采样率等参数不被设备支持时构造即抛：先释放刚拿到的麦克风再报错。
    for (const track of stream.getTracks()) track.stop();
    throw new Error(`AudioContext init failed: ${describeError(error)}`, { cause: error });
  }
  // worklet 以同源静态资源加载（blob: 脚本会被渲染层 CSP 拦掉，见模块注释）。
  try {
    await context.audioWorklet.addModule(workletModuleUrl);
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
    throw new Error(`AudioWorklet module load failed: ${describeError(error)}`, {
      cause: error,
    });
  }
  const chunks: Float32Array[] = [];
  let totalSamples = 0;
  let lastLevelEmit = 0;

  let worklet: AudioWorkletNode;
  let mute: GainNode;
  try {
    worklet = new AudioWorkletNode(context, 'kepcup-voice-capture');
    worklet.port.onmessage = (event: MessageEvent<{ pcm: Float32Array; level: number }>) => {
      chunks.push(event.data.pcm);
      totalSamples += event.data.pcm.length;
      const now = performance.now();
      if (onLevel !== undefined && now - lastLevelEmit > 50) {
        lastLevelEmit = now;
        onLevel(levelToHeight(event.data.level));
      }
    };
    mute = context.createGain();
    mute.gain.value = 0;
    context.createMediaStreamSource(stream).connect(worklet);
    worklet.connect(mute);
    mute.connect(context.destination);
  } catch (error) {
    // 节点装配失败：释放麦克风与 AudioContext 再上抛，兑现「失败时负责停轨」的契约。
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
    throw new Error(`Audio graph setup failed: ${describeError(error)}`, { cause: error });
  }

  const cleanup = (): void => {
    worklet.port.onmessage = null;
    worklet.disconnect();
    mute.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };

  return {
    async stop(): Promise<VoiceRecording> {
      // 等一拍让最后的音频帧走完 postMessage 再拼合，避免截掉尾音。
      await new Promise((resolve) => setTimeout(resolve, 80));
      cleanup();
      const samples = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      const durationMs = Math.round((totalSamples / SAMPLE_RATE) * 1000);
      const blob = encodeWav(samples, SAMPLE_RATE);
      return { blob, base64: await blobToBase64(blob), durationMs };
    },
    cancel(): void {
      cleanup();
    },
  };
}

/** 16-bit PCM WAV 容器（44 字节头 + 交错单声道）。 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(',');
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** 录音时长展示（"0:04" 形态，与录音胶囊 UI 一致）。 */
export function formatRecordingDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
