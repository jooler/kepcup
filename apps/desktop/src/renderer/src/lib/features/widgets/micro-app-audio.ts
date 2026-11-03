import { encodeWav, SAMPLE_RATE } from '../chats/voice-recorder';
import { core } from '../../rpc/client.svelte';
import { microAppsMediaSynthesizeOutputSchema, microAppsMediaTranscribeOutputSchema } from '@kepcup/shared';
import workletModuleUrl from '../chats/voice-capture-worklet.js?url&no-inline';

/**
 * 微应用音频平面（D112，设计 55 §7）：宿主代理采集 + VAD 分段 + ASR / TTS。
 *
 * - 麦克风只在宿主渲染层打开（iframe `allow=""`，Permissions-Policy 拒绝 getUserMedia）；
 *   原始音频不出宿主——微应用只收到文本、电平与状态。
 * - 半双工：VAD 分段（静音 `silenceMs` 默认 700ms 收段，段长 1.5–15s）；播报时**不采集
 *   分段**但持续监测电平（插话 = 停播 + 清队列，barge-in 阈值略高于收段阈值防回声误触）。
 * - TTS 队列 ≤3 段，可打断；播放与合成都在宿主侧。
 * - 降级：缺 ASR 配置 → transcribe 抛 `MICRO_APP_CAPABILITY_NOT_CONFIGURED`（确认卡预检
 *   已先行标注）；麦克风被拒 / 总闸关闭 → listen 启动抛 `MICRO_APP_CAPABILITY_DENIED`。
 */

/** 收段阈值（worklet 的 RMS 电平，0..1）：与 53 号语音模式同源量级。 */
const SPEECH_LEVEL_THRESHOLD = 0.02;
/** 插话阈值：比收段阈值高一截，避免 TTS 从扬声器回灌被当成插话。 */
const BARGE_IN_LEVEL_THRESHOLD = 0.06;
const SPEECH_SUSTAIN_MS = 220;
const MIN_SEGMENT_MS = 1_500;
const MAX_SEGMENT_MS = 15_000;
const DEFAULT_SILENCE_MS = 700;
/** 播放队列上限（55 §5.1：media.speak 队列 ≤3 段）。 */
const SPEAK_QUEUE_MAX = 3;

export type MicroAppListenEventName =
  | 'level'
  | 'speech-start'
  | 'partial'
  | 'final'
  | 'error'
  | 'end';

export interface MicroAppListenConfig {
  lang?: string;
  mode: 'push-to-talk' | 'vad';
  silenceMs: number;
}

export type MicroAppListenSink = (name: MicroAppListenEventName, data: unknown) => void;

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * 一个微应用实例的音频会话。宿主桥（MicroAppBridgeHost）为每次 `media.listen` 建
 * 一个；`dispose` 时释放麦克风与播放队列（关闭即释放，55 §5.3）。
 */
export class MicroAppAudioSession {
  readonly #sink: MicroAppListenSink;
  readonly #config: MicroAppListenConfig;
  readonly #resourceId: () => string;
  #stream: MediaStream | null = null;
  #context: AudioContext | null = null;
  #worklet: AudioWorkletNode | null = null;
  #stopped = true;
  /** 当前分段的 PCM 累积与状态机。 */
  #segment: Float32Array[] = [];
  #segmentSamples = 0;
  #speechSince = 0;
  #silenceSince = 0;
  #inSpeech = false;
  #lastLevelEmit = 0;
  #transcribing = false;
  /** 播放面（所有 listen 会话共享一个实例级队列——由 Plane 注入）。 */
  readonly #speakQueue: MicroAppSpeakQueue;

  constructor(input: {
    resourceId: () => string;
    instanceId: string;
    config: MicroAppListenConfig;
    sink: MicroAppListenSink;
    speakQueue: MicroAppSpeakQueue;
    openMicrophone(): Promise<MediaStream>;
  }) {
    this.#resourceId = input.resourceId;
    this.#instanceId = input.instanceId;
    this.#config = input.config;
    this.#sink = input.sink;
    this.#speakQueue = input.speakQueue;
    this.#openMicrophone = input.openMicrophone;
  }

  readonly #instanceId: string;
  #openMicrophone: () => Promise<MediaStream>;

  async start(): Promise<void> {
    if (!this.#stopped) return;
    // 审查修复 F10：装配中途失败（AudioContext / worklet / 节点）也要释放麦克风——
    // #stopped 保持 true 会让 stop()/dispose() 早退，设备就一直开着。
    let stream: MediaStream;
    try {
      stream = await this.#openMicrophone();
      this.#stream = stream;
      this.#context = new AudioContext({ sampleRate: SAMPLE_RATE });
      await this.#context.audioWorklet.addModule(workletModuleUrl);
      const worklet = new AudioWorkletNode(this.#context, 'kepcup-voice-capture');
      const mute = this.#context.createGain();
      mute.gain.value = 0;
      this.#context.createMediaStreamSource(stream).connect(worklet);
      worklet.connect(mute);
      mute.connect(this.#context.destination);
      worklet.port.onmessage = (event: MessageEvent<{ pcm: Float32Array; level: number }>) => {
        this.#onFrame(event.data.pcm, event.data.level);
      };
      this.#worklet = worklet;
    } catch (error) {
      this.#teardown();
      throw Object.assign(
        new Error(`麦克风启动失败：${error instanceof Error ? error.message : String(error)}`),
        { code: 'MICRO_APP_CAPABILITY_NOT_CONFIGURED' },
      );
    }
    this.#stopped = false;
    // 播报时暂停分段、只监测插话（防回声）：speech-start 即停播 + 清队列（55 §7.2）。
    this.#speakQueue.setBargeInListener(() => this.#sink('speech-start', null), BARGE_IN_LEVEL_THRESHOLD);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#speakQueue.setBargeInListener(null, BARGE_IN_LEVEL_THRESHOLD);
    this.#teardown();
    this.#sink('end', null);
    // 注意：这里**不**调 microApps.ai.dispose——停一条监听通道不等于结束实例
    // （审查修复 F4）；实例收口由卡片关闭（WidgetRuntime.stop）统一做。
  }

  dispose(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#speakQueue.setBargeInListener(null, BARGE_IN_LEVEL_THRESHOLD);
    this.#teardown();
  }

  #teardown(): void {
    this.#worklet !== null && (this.#worklet.port.onmessage = null);
    this.#worklet?.disconnect();
    this.#worklet = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    void this.#context?.close().catch(() => undefined);
    this.#context = null;
    this.#segment = [];
    this.#segmentSamples = 0;
    this.#pendingSegments.length = 0;
    this.#inSpeech = false;
  }

  /** 播放期间继续喂电平（插话检测）；分段只在非播放期进行。 */
  #onFrame(pcm: Float32Array, level: number): void {
    const now = performance.now();
    if (now - this.#lastLevelEmit > 50) {
      this.#lastLevelEmit = now;
      this.#sink('level', level);
    }
    // 播报中：电平只用于插话检测（阈值更高，防 TTS 回灌），不参与分段。
    if (this.#speakQueue.speaking) {
      this.#speakQueue.feedLevelForBargeIn(level);
      return;
    }
    if (level >= SPEECH_LEVEL_THRESHOLD) {
      this.#silenceSince = 0;
      if (!this.#inSpeech) {
        this.#speechSince = this.#speechSince === 0 ? now : this.#speechSince;
        if (now - this.#speechSince >= SPEECH_SUSTAIN_MS) {
          this.#inSpeech = true;
          this.#speechSince = 0;
          this.#sink('speech-start', null);
        }
      }
    } else {
      this.#speechSince = 0;
      if (this.#inSpeech) {
        if (this.#silenceSince === 0) this.#silenceSince = now;
        const silenceMs = this.#config.silenceMs || DEFAULT_SILENCE_MS;
        if (now - this.#silenceSince >= silenceMs) {
          this.#finalizeSegment();
          return;
        }
      }
    }
    if (this.#inSpeech || this.#config.mode === 'push-to-talk') {
      // 分段累积：push-to-talk 模式持续累积（由应用决定何时 stop），vad 只在语音中累积。
      if (this.#config.mode === 'push-to-talk' || this.#inSpeech) {
        this.#segment.push(pcm);
        this.#segmentSamples += pcm.length;
        if (this.#segmentSamples / SAMPLE_RATE * 1000 >= MAX_SEGMENT_MS) this.#finalizeSegment();
      }
    }
  }

  #finalizeSegment(): void {
    const samples = this.#segmentSamples;
    const durationMs = Math.round((samples / SAMPLE_RATE) * 1000);
    const chunks = this.#segment;
    this.#segment = [];
    this.#segmentSamples = 0;
    this.#inSpeech = false;
    this.#silenceSince = 0;
    if (chunks.length === 0 || durationMs < MIN_SEGMENT_MS) return; // 过短丢弃（55 §7.2）
    // 审查修复 F11：ASR 在途时新分段排队（不丢弃——主教学环里用户的话不能消失）。
    this.#pendingSegments.push({ chunks, samples });
    void this.#drainSegments();
  }

  readonly #pendingSegments: Array<{ chunks: Float32Array[]; samples: number }> = [];

  async #drainSegments(): Promise<void> {
    if (this.#transcribing) return;
    this.#transcribing = true;
    try {
      while (this.#pendingSegments.length > 0) {
        const segment = this.#pendingSegments.shift()!;
        try {
          const merged = new Float32Array(segment.samples);
          let offset = 0;
          for (const chunk of segment.chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          const base64 = await blobToBase64(encodeWav(merged, SAMPLE_RATE));
          const out = microAppsMediaTranscribeOutputSchema.parse(
            await core.call('microApps.media.transcribe', {
              resourceId: this.#resourceId(),
              instanceId: this.#instanceId,
              audioBase64: base64,
              audioMime: 'audio/wav',
              ...(this.#config.lang !== undefined ? { language: this.#config.lang } : {}),
            }),
          );
          this.#sink('final', { text: out.text });
        } catch (error) {
          const code = (error as { code?: string }).code ?? 'MICRO_APP_CAPABILITY_NOT_CONFIGURED';
          this.#sink('error', { code, message: error instanceof Error ? error.message : String(error) });
          return; // 该段失败：停排（错误已给应用；后续分段由下一次收段触发重试排空）。
        }
      }
    } finally {
      this.#transcribing = false;
    }
  }
}

/** TTS 播放队列（实例级）：合成经 `microApps.media.synthesize`，播放可打断。 */
export class MicroAppSpeakQueue {
  readonly #resourceId: () => string;
  #instanceId = '';
  #audio: HTMLAudioElement | null = null;
  #queue: Array<{ run: () => Promise<void>; reject: () => void }> = [];
  #pumping = false;
  #epoch = 0;
  #bargeIn: { cb: (() => void) | null; threshold: number } = { cb: null, threshold: 0.06 };
  #speaking = false;
  /** 测试缝：注入合成与播放（生产 = core RPC + data URL Audio 元素）。 */
  readonly #synthesize: (input: { text: string; voice?: string; rate?: number }) => Promise<{
    audioBase64: string;
    mimeType: string;
  }>;
  readonly #playAudio: (audioBase64: string, mimeType: string) => Promise<void>;

  constructor(
    resourceId: string | (() => string),
    seams?: {
      synthesize?: (input: { text: string; voice?: string; rate?: number }) => Promise<{
        audioBase64: string;
        mimeType: string;
      }>;
      playAudio?: (audioBase64: string, mimeType: string) => Promise<void>;
    },
  ) {
    this.#resourceId = typeof resourceId === 'function' ? resourceId : () => resourceId;
    this.#synthesize =
      seams?.synthesize ??
      (async (input) =>
        microAppsMediaSynthesizeOutputSchema.parse(
          await core.call('microApps.media.synthesize', {
            resourceId: this.#resourceId(),
            instanceId: this.#instanceId,
            text: input.text,
            ...(input.voice !== undefined ? { voice: input.voice } : {}),
            ...(input.rate !== undefined ? { rate: input.rate } : {}),
          }),
        ));
    this.#playAudio = seams?.playAudio ?? ((audioBase64, mimeType) => this.#play(audioBase64, mimeType));
  }

  get speaking(): boolean {
    return this.#speaking;
  }

  setInstance(instanceId: string): void {
    this.#instanceId = instanceId;
  }

  /** listen 会话注册插话监听：播放期间用实时电平判断「用户开口了」。 */
  setBargeInListener(cb: (() => void) | null, threshold: number): void {
    this.#bargeIn = { cb, threshold };
  }

  /** speak 的宿主实现：入队（在播 + 排队合计 ≤3 段），Promise 在该段播完时 resolve。 */
  async speak(input: { text: string; voice?: string; rate?: number }): Promise<void> {
    if (this.#queue.length + (this.#speaking ? 1 : 0) >= SPEAK_QUEUE_MAX) {
      throw Object.assign(new Error(`播放队列已满（最多 ${SPEAK_QUEUE_MAX} 段）`), {
        code: 'WIDGET_RATE_LIMITED',
      });
    }
    await new Promise<void>((resolve, reject) => {
      const run = async (): Promise<void> => {
        const epoch = this.#epoch;
        const out = await this.#synthesize(input);
        // 合成期间被打断 / 停止：这一段不再播放（二轮 F3——停止键和插话不能漏出一段）。
        if (epoch !== this.#epoch) return;
        await this.#playAudio(out.audioBase64, out.mimeType);
      };
      this.#queue.push({
        run: () => run().then(resolve, reject),
        // 打断 / 停止时丢弃未播段：其 speak() 以可读错误收口，不悬挂。
        reject: () =>
          reject(
            Object.assign(new Error('播放已停止（用户打断或停止键）'), {
              code: 'MICRO_APP_BRIDGE_CLOSED',
            }),
          ),
      });
      void this.#pump();
    });
  }

  stopSpeaking(): void {
    this.#epoch += 1;
    for (const entry of this.#queue.splice(0)) entry.reject();
    if (this.#audio !== null) {
      this.#audio.pause();
      this.#audio.src = '';
      this.#audio = null;
    }
    this.#speaking = false;
  }

  dispose(): void {
    this.stopSpeaking();
  }

  /** 播放期间由 listen 会话喂入的实时电平（插话检测）。 */
  feedLevelForBargeIn(level: number): void {
    if (!this.#speaking || this.#bargeIn.cb === null) return;
    if (level >= this.#bargeIn.threshold) {
      const cb = this.#bargeIn.cb;
      this.stopSpeaking();
      cb();
    }
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length > 0) {
        const run = this.#queue.shift()!.run;
        this.#speaking = true;
        await run();
        this.#speaking = false;
      }
    } finally {
      this.#pumping = false;
      this.#speaking = false;
    }
  }

  #play(audioBase64: string, mimeType: string): Promise<void> {
    const epoch = this.#epoch;
    return new Promise((resolve) => {
      // 播放前再核一次 epoch：合成后到起播前被打断的段直接吞掉（二轮 F3）。
      if (epoch !== this.#epoch) {
        resolve();
        return;
      }
      const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
      this.#audio = audio;
      audio.onended = () => {
        if (epoch === this.#epoch) this.#audio = null;
        resolve();
      };
      audio.onerror = () => {
        if (epoch === this.#epoch) this.#audio = null;
        resolve();
      };
      void audio.play().catch(() => resolve());
    });
  }
}
