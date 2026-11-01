import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { speechAudio, type SpeechAudioDeps, type SpeechAudioElement } from './speech-audio.svelte';
import { voiceMode } from './voice-mode.svelte';

/**
 * Bot 语音音频缓存与播放仲裁（docs/design/53-voice-conversation.md 修订 v2
 * V2-3）：LRU 逐出即 revoke、每条消息只合成一次（含在途去重）、暂停/续播、
 * 停播保留缓存、手动朗读与播报队列的双向抢占（共用唯一音频元素，经
 * voiceMode 播报队列做端到端仲裁）、stop() 统一停播的收场语义（P2-1：录音
 * 开采前停掉在响的播报 / 朗读，在播请求以被抢占 resolve 不挂起）。合成 /
 * objectURL / 音频元素全部注入假实现；缓存是全局会话级，用例间以
 * __resetForTest 隔离。
 */

/** 微任务排空（toggle 的合成 → 播放链路每个 await 只需一个宏任务拍点）。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function botTextMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    seq: 1,
    senderType: 'bot',
    senderBotId: 'b1',
    kind: 'text',
    content: { text: '你好，世界' },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 1,
    attachments: [],
    ownerBotId: null,
    taskId: null,
    ...overrides,
  } as Message;
}

interface FakeElement extends SpeechAudioElement {
  playCalls: number;
  loadCalls: number;
  pauseCalls: number;
  /** 置非空时 play() reject（模拟解码失败 / 自动播放被拒）。 */
  playError: unknown;
  emit(type: 'ended' | 'error'): void;
}

function createFakeElement(): FakeElement {
  const handlers = new Map<string, Set<() => void>>();
  const element: FakeElement = {
    src: '',
    playCalls: 0,
    loadCalls: 0,
    pauseCalls: 0,
    playError: null,
    addEventListener: (type, handler) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    },
    play: async () => {
      element.playCalls += 1;
      if (element.playError !== null) throw element.playError;
    },
    pause: () => {
      element.pauseCalls += 1;
    },
    load: () => {
      element.loadCalls += 1;
    },
    emit: (type) => {
      for (const handler of handlers.get(type) ?? []) handler();
    },
  };
  return element;
}

function createHarness() {
  const synthCalls: string[] = [];
  const synthPending: Array<{
    resolve(value: { blob: Blob; mimeType: string }): void;
    reject(error: unknown): void;
  }> = [];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const elements: FakeElement[] = [];
  const toggleFailures: unknown[] = [];
  let manualPlayStarts = 0;

  const deps: SpeechAudioDeps = {
    synthesize: (text) => {
      synthCalls.push(text);
      return new Promise((resolve, reject) => {
        synthPending.push({ resolve, reject });
      });
    },
    createObjectUrl: () => {
      const url = `blob:u${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectUrl: (url) => {
      revokedUrls.push(url);
    },
    createElement: () => {
      const element = createFakeElement();
      elements.push(element);
      return element;
    },
    onToggleFailure: (error) => {
      toggleFailures.push(error);
    },
    onManualPlayStart: () => {
      manualPlayStarts += 1;
    },
  };

  return {
    deps,
    synthCalls,
    createdUrls,
    revokedUrls,
    elements,
    toggleFailures,
    get manualPlayStarts() {
      return manualPlayStarts;
    },
    /** 让最早一条在途合成成功落地。 */
    resolveSynth(): void {
      synthPending.shift()?.resolve({ blob: new Blob(['audio']), mimeType: 'audio/mpeg' });
    },
    /** 让最早一条在途合成失败。 */
    rejectSynth(error: unknown): void {
      synthPending.shift()?.reject(error);
    },
  };
}

/** 走完一次 toggle 的合成 → 播放链路。 */
async function toggleAndPlay(message: Message, h: ReturnType<typeof createHarness>): Promise<void> {
  speechAudio.toggle(message);
  await tick();
  h.resolveSynth();
  await tick();
}

describe('toggle（手动朗读开关）', () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    speechAudio.__resetForTest();
    h = createHarness();
    speechAudio.configure(h.deps);
  });

  it('空闲点击：合成一次并播放（唯一元素、onManualPlayStart 通知）', async () => {
    await toggleAndPlay(botTextMessage({ id: 'm1', content: { text: '你好' } }), h);

    expect(h.synthCalls).toEqual(['你好']);
    expect(speechAudio.currentId).toBe('m1');
    expect(speechAudio.isPlaying).toBe(true);
    expect(h.elements).toHaveLength(1); // 单元素：播报与朗读共用同一条声道
    expect(h.elements[0]!.src).toBe('blob:u1');
    expect(h.elements[0]!.playCalls).toBe(1);
    expect(h.elements[0]!.loadCalls).toBe(1);
    expect(h.manualPlayStarts).toBe(1);
  });

  it('播放中再点 = 暂停；再点 = 续播；同一条消息不重复合成', async () => {
    const message = botTextMessage({ id: 'm1', content: { text: '你好' } });
    await toggleAndPlay(message, h);

    speechAudio.toggle(message);
    expect(speechAudio.isPlaying).toBe(false);
    expect(speechAudio.currentId).toBe('m1'); // 暂停态保留归属
    expect(h.elements[0]!.pauseCalls).toBe(1);

    speechAudio.toggle(message);
    await tick();
    expect(speechAudio.isPlaying).toBe(true);
    expect(h.elements[0]!.playCalls).toBe(2);
    expect(h.synthCalls).toEqual(['你好']); // 暂停 / 续播不走 RPC
    expect(h.manualPlayStarts).toBe(1); // 不算开播，不打断播报
  });

  it('自然播完回空闲；再点从头重播且命中缓存（无第二次 RPC）', async () => {
    const message = botTextMessage({ id: 'm1', content: { text: '你好' } });
    await toggleAndPlay(message, h);

    h.elements[0]!.emit('ended');
    expect(speechAudio.isPlaying).toBe(false);
    expect(speechAudio.currentId).toBeNull();

    speechAudio.toggle(message);
    await tick();
    expect(h.synthCalls).toEqual(['你好']); // 缓存命中
    expect(speechAudio.isPlaying).toBe(true);
    expect(h.elements[0]!.src).toBe('blob:u1');
    expect(h.elements[0]!.loadCalls).toBe(2); // 同 URL 重播显式重载
  });

  it('合成在途的重复 toggle 只发一次 RPC（in-flight 去重）', async () => {
    const message = botTextMessage({ id: 'm1', content: { text: '你好' } });
    speechAudio.toggle(message);
    speechAudio.toggle(message);
    await tick();
    expect(h.synthCalls).toEqual(['你好']);

    h.resolveSynth();
    await tick();
    expect(h.elements[0]!.playCalls).toBe(1); // 只播一次
    expect(speechAudio.currentId).toBe('m1');
  });

  it('合成失败 → onToggleFailure 提示一次；不进缓存（再点重新合成）', async () => {
    const message = botTextMessage({ id: 'm1', content: { text: '你好' } });
    speechAudio.toggle(message);
    await tick();
    h.rejectSynth(new Error('tts down'));
    await tick();
    expect(h.toggleFailures).toEqual([new Error('tts down')]);
    expect(speechAudio.isPlaying).toBe(false);
    expect(speechAudio.currentId).toBeNull();

    await toggleAndPlay(message, h);
    expect(h.synthCalls).toEqual(['你好', '你好']);
    expect(speechAudio.isPlaying).toBe(true);
  });

  it('播放失败（play() 拒绝）→ onToggleFailure 同款提示', async () => {
    const message = botTextMessage({ id: 'm1', content: { text: '你好' } });
    await toggleAndPlay(message, h);
    h.elements[0]!.emit('ended'); // 播完回空闲，重播触发 play()
    h.elements[0]!.playError = new Error('decode failed');
    speechAudio.toggle(message); // 缓存命中直接重播 → play() 拒绝
    await tick();
    expect(h.toggleFailures).toEqual([new Error('decode failed')]);
    expect(speechAudio.isPlaying).toBe(false);
    expect(speechAudio.currentId).toBeNull();
  });

  it('无可朗读文字（空提取 / 非 bot text）no-op，不发 RPC', () => {
    speechAudio.toggle(botTextMessage({ id: 'm1', content: { text: '```\ncode\n```' } }));
    speechAudio.toggle(
      botTextMessage({ id: 'm2', senderType: 'user', content: { text: '用户的话' } }),
    );
    expect(h.synthCalls).toEqual([]);
    expect(h.manualPlayStarts).toBe(0);
  });

  it('停播（stop）保留缓存条目：再点即重播，不再合成', async () => {
    const message = botTextMessage({ id: 'm1', content: { text: '你好' } });
    await toggleAndPlay(message, h);

    speechAudio.stop();
    expect(speechAudio.isPlaying).toBe(false);
    expect(speechAudio.currentId).toBeNull();
    expect(h.elements[0]!.pauseCalls).toBe(1);

    await toggleAndPlay(message, h);
    expect(h.synthCalls).toEqual(['你好']); // 缓存命中
    expect(speechAudio.isPlaying).toBe(true);
  });

  it('合成期间改点别的消息：先前那条落地后放弃播放', async () => {
    speechAudio.toggle(botTextMessage({ id: 'm1', content: { text: '一' } }));
    await tick(); // m1 合成在途
    speechAudio.toggle(botTextMessage({ id: 'm2', content: { text: '二' } }));
    await tick();
    h.resolveSynth(); // m2 先落地（后发先至）
    h.resolveSynth(); // m1 落地
    await tick();
    expect(speechAudio.currentId).toBe('m2'); // m1 被放弃，不抢扬声器
    expect(h.elements[0]!.playCalls).toBe(1);
  });
});

describe('缓存（LRU，逐出即 revoke）', () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    speechAudio.__resetForTest();
    h = createHarness();
    speechAudio.configure(h.deps);
  });

  it('超过 20 条逐出最旧并 revoke；被逐出的再点重新合成', async () => {
    for (let i = 1; i <= 21; i += 1) {
      await toggleAndPlay(botTextMessage({ id: `m${i}`, content: { text: `第${i}条` } }), h);
    }
    expect(h.synthCalls).toHaveLength(21);
    expect(h.revokedUrls).toEqual(['blob:u1']); // 最旧被逐出（在播的 m21 跳过）

    await toggleAndPlay(botTextMessage({ id: 'm1', content: { text: '第一条' } }), h);
    expect(h.synthCalls).toHaveLength(22); // 缓存未命中 → 重新合成

    await toggleAndPlay(botTextMessage({ id: 'm21', content: { text: '第21条' } }), h);
    expect(h.synthCalls).toHaveLength(22); // m21 仍在缓存
  });

  it('在播条目不逐出：挤占时 revoke 的是别人，在播的仍命中缓存', async () => {
    // 填满 20 条（无播放，逐出不触发）。
    for (let i = 1; i <= 20; i += 1) {
      const pending = speechAudio.ensureUrl(`m${i}`, `第${i}条`);
      h.resolveSynth();
      await pending;
    }
    expect(h.revokedUrls).toEqual([]);
    expect(h.synthCalls).toHaveLength(20);
    // 直接低层播放第 20 条（占用扬声器），再挤进第 21 条。
    speechAudio.play({ messageId: 'm20', audio: 'blob:u20' });
    const pending21 = speechAudio.ensureUrl('m21', '第21条');
    h.resolveSynth();
    await pending21;
    expect(h.revokedUrls).toEqual(['blob:u1']); // 跳过在播的 m20
    expect(h.synthCalls).toHaveLength(21);
    await expect(speechAudio.ensureUrl('m20', '第20条')).resolves.toBe('blob:u20');
    expect(h.synthCalls).toHaveLength(21); // m20 仍在缓存，无第二次 RPC
  });
});

describe('播放仲裁（手动朗读 ↔ 播报队列双向互斥）', () => {
  let h: ReturnType<typeof createHarness>;
  const announceFailures: unknown[] = [];

  beforeEach(() => {
    speechAudio.__resetForTest();
    h = createHarness();
    speechAudio.configure(h.deps);
    voiceMode.exit();
    announceFailures.length = 0;
    voiceMode.attachAnnouncer({
      resolveAudio: (messageId, text) => speechAudio.ensureUrl(messageId, text),
      play: (input) => speechAudio.play(input),
      onFirstFailure: (error) => announceFailures.push(error),
    });
  });

  it('播报播放中点朗读：播报被抢占，队列作废，朗读接管扬声器', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'm1', text: '第一条', truncated: false });
    await tick();
    h.resolveSynth(); // 播报的合成经 speech-audio
    await tick();
    expect(voiceMode.phase).toBe('speaking');
    expect(speechAudio.isPlaying).toBe(true);
    expect(speechAudio.currentId).toBe('m1');

    // 播报队列里还有一条，但用户此刻点了另一条消息的朗读键。
    voiceMode.announce({ id: 'm2', text: '第二条', truncated: false });
    await toggleAndPlay(botTextMessage({ id: 'm9', content: { text: '手动朗读' } }), h);

    expect(voiceMode.phase).toBe('idle'); // 播报让位（interruptSpeech 清队）
    expect(speechAudio.currentId).toBe('m9');
    expect(speechAudio.isPlaying).toBe(true);
    expect(h.synthCalls).toEqual(['第一条', '手动朗读']); // 第二条播报永不合成
    expect(announceFailures).toEqual([]); // 抢占不是失败
  });

  it('朗读中播报到来：播报的 play 经仲裁抢占朗读', async () => {
    await toggleAndPlay(botTextMessage({ id: 'm1', content: { text: '手动朗读' } }), h);
    expect(speechAudio.currentId).toBe('m1');

    voiceMode.enter();
    voiceMode.announce({ id: 'm2', text: '新回复', truncated: false });
    await tick();
    h.resolveSynth();
    await tick();

    expect(voiceMode.phase).toBe('speaking');
    expect(speechAudio.currentId).toBe('m2'); // 朗读让位新播报
    expect(speechAudio.isPlaying).toBe(true);
    expect(h.elements).toHaveLength(1); // 始终唯一元素
  });

  it('朗读暂停中的播报（同一条消息）可续播，播报队列不受扰', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'm1', text: '第一条', truncated: false });
    await tick();
    h.resolveSynth(); // 播报的合成经 speech-audio
    await tick();
    expect(voiceMode.phase).toBe('speaking');
    expect(speechAudio.currentId).toBe('m1');
    expect(speechAudio.isPlaying).toBe(true);

    // 同一条消息 toggle = 暂停（不算开播，播报请求仍挂着等 ended）。
    const message = botTextMessage({ id: 'm1' });
    speechAudio.toggle(message);
    expect(speechAudio.isPlaying).toBe(false);
    expect(h.manualPlayStarts).toBe(0);

    // 续播后自然播完 → 播报队列正常收尾回 idle。
    speechAudio.toggle(message);
    await tick();
    expect(speechAudio.isPlaying).toBe(true);
    h.elements[0]!.emit('ended');
    await tick();
    expect(voiceMode.phase).toBe('idle');
    expect(announceFailures).toEqual([]);
  });
});

describe('stop()（录音接管扬声器前的统一停播，P2-1）', () => {
  let h: ReturnType<typeof createHarness>;
  const announceFailures: unknown[] = [];

  beforeEach(() => {
    speechAudio.__resetForTest();
    h = createHarness();
    speechAudio.configure(h.deps);
    voiceMode.exit();
    announceFailures.length = 0;
    voiceMode.attachAnnouncer({
      resolveAudio: (messageId, text) => speechAudio.ensureUrl(messageId, text),
      play: (input) => speechAudio.play(input),
      onFirstFailure: (error) => announceFailures.push(error),
    });
  });

  it('播报播放中 stop()：在播 ended 以被抢占 resolve（不挂起），队列作废回 idle，不误报失败', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'm1', text: '第一条', truncated: false });
    voiceMode.announce({ id: 'm2', text: '第二条', truncated: false });
    await tick();
    h.resolveSynth();
    await tick();
    expect(voiceMode.phase).toBe('speaking');
    expect(speechAudio.isPlaying).toBe(true);

    speechAudio.stop(); // acquireRecording 拿到流后的统一停播
    await tick();
    expect(speechAudio.isPlaying).toBe(false);
    expect(speechAudio.currentId).toBeNull();
    expect(h.elements[0]!.pauseCalls).toBe(1); // 扬声器真停了
    expect(h.synthCalls).toEqual(['第一条']); // 未播的 m2 被作废，永不合成
    expect(announceFailures).toEqual([]); // 停播不是失败（不二次 toast）
    expect(voiceMode.phase).toBe('idle'); // runOne 的 await 已收尾，相位不复位就没人派发

    // 队列可复用：新消息照常入队开播（pump 循环干净退出，无僵尸迭代）。
    voiceMode.announce({ id: 'm3', text: '第三条', truncated: false });
    await tick();
    expect(h.synthCalls).toEqual(['第一条', '第三条']);
  });

  it('stop() 后跟 interruptSpeech()（startVoiceModeRecording 的实际序列）只收场一次，随即能进录音', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'm1', text: '第一条', truncated: false });
    voiceMode.announce({ id: 'm2', text: '第二条', truncated: false });
    await tick();
    h.resolveSynth();
    await tick();
    expect(voiceMode.phase).toBe('speaking');

    // 最坏顺序：stop 与 interruptSpeech 之间不排空微任务（runOne 还没续跑，
    // 相位仍是 speaking）——interrupt 的 epoch++ / 清队 / stopCurrent 都不得
    // 双动作（onPreempted 的 epoch 守卫 + handle.stop 的 #current 自防）。
    speechAudio.stop(); // acquireRecording 内
    voiceMode.interruptSpeech(); // startVoiceModeRecording 内
    await tick();
    expect(voiceMode.phase).toBe('idle');
    expect(h.synthCalls).toEqual(['第一条']); // m2 只被作废一次，永不合成
    expect(announceFailures).toEqual([]); // 双触发不误报失败（无二次 toast）
    expect(speechAudio.isPlaying).toBe(false);
    expect(speechAudio.currentId).toBeNull();
    expect(h.elements[0]!.pauseCalls).toBe(1); // 不重复 pause
    expect(h.elements[0]!.playCalls).toBe(1); // 也不重新开播

    voiceMode.dispatch('record-started');
    expect(voiceMode.phase).toBe('recording');
  });

  it('手动朗读播放中 stop()：播放停止、isPlaying/currentId 复位，不误报 onToggleFailure', async () => {
    const message = botTextMessage({ id: 'm9', content: { text: '手动朗读' } });
    await toggleAndPlay(message, h);
    expect(speechAudio.isPlaying).toBe(true);

    speechAudio.stop();
    expect(speechAudio.isPlaying).toBe(false);
    expect(speechAudio.currentId).toBeNull();
    expect(h.elements[0]!.pauseCalls).toBe(1);
    expect(h.toggleFailures).toEqual([]); // 抢占式停播 resolve 而非 reject，无失败提示

    await toggleAndPlay(message, h); // 缓存保留：再点即重播，不再合成
    expect(speechAudio.isPlaying).toBe(true);
    expect(h.synthCalls).toEqual(['手动朗读']);
  });

  it('合成中（无在播请求）stop() no-op：不 epoch 作废，落地后照常开播', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'm1', text: '第一条', truncated: false });
    await tick();
    expect(voiceMode.speakingStage).toBe('synthesizing');

    speechAudio.stop();
    h.resolveSynth();
    await tick();
    expect(speechAudio.isPlaying).toBe(true); // stop 只仲裁扬声器，不清合成（清队归 interruptSpeech）
    expect(voiceMode.phase).toBe('speaking');
    expect(announceFailures).toEqual([]);
  });

  it('空闲时 stop() no-op：不碰元素，后续播放不受影响', async () => {
    speechAudio.stop(); // 从未播放过
    expect(speechAudio.isPlaying).toBe(false);
    expect(speechAudio.currentId).toBeNull();
    expect(h.elements).toHaveLength(0); // 连元素都没建

    const message = botTextMessage({ id: 'm1', content: { text: '你好' } });
    await toggleAndPlay(message, h);
    h.elements[0]!.emit('ended'); // 自然播完回空闲
    const pausesBefore = h.elements[0]!.pauseCalls;
    speechAudio.stop();
    expect(h.elements[0]!.pauseCalls).toBe(pausesBefore); // 无多余 pause
    expect(speechAudio.isPlaying).toBe(false);
    expect(speechAudio.currentId).toBeNull();
    expect(h.toggleFailures).toEqual([]);
  });
});
