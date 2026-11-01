import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import {
  announceEntryFor,
  voiceMode,
  type AnnounceDeps,
  type PlaybackHandle,
} from './voice-mode.svelte';

/**
 * Bot 播报队列（docs/design/53-voice-conversation.md「Bot 语音播报链路」，WP3）：
 * 入队条件、顺序消费（一次一条、两阶段 speaking）、插话作废清队、暂播与恢复、
 * 失败停队（新消息重启）、退出清理与 objectURL 无泄漏。事件源 / 合成器 / 播放器
 * 全部注入假实现；宿主用真实 voiceMode store（$state 状态机一并被驱动）。
 */

/** 微任务排空（队列循环的每个 await 都只需一个宏任务拍点）。 */
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

interface FakeHandle extends PlaybackHandle {
  /** 模拟自然播完。 */
  end(): void;
  /** 模拟播放出错。 */
  fail(error: unknown): void;
}

function createHarness() {
  const synthCalls: string[] = [];
  const synthPending: Array<{
    resolve(value: { blob: Blob }): void;
    reject(error: unknown): void;
  }> = [];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const playedUrls: string[] = [];
  const stoppedUrls: string[] = [];
  const failures: unknown[] = [];
  const handles = new Map<string, FakeHandle>();

  const deps: AnnounceDeps = {
    synthesize: (text) => {
      synthCalls.push(text);
      return new Promise<{ blob: Blob }>((resolve, reject) => {
        synthPending.push({ resolve, reject });
      });
    },
    createObjectUrl: () => {
      const url = `blob:mock-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectUrl: (url) => {
      revokedUrls.push(url);
    },
    play: (url) => {
      playedUrls.push(url);
      let resolveEnded!: () => void;
      let rejectEnded!: (error: unknown) => void;
      const ended = new Promise<void>((resolve, reject) => {
        resolveEnded = resolve;
        rejectEnded = reject;
      });
      const handle: FakeHandle = {
        ended,
        stop() {
          stoppedUrls.push(url);
          resolveEnded();
        },
        end: () => resolveEnded(),
        fail: (error) => rejectEnded(error),
      };
      handles.set(url, handle);
      return handle;
    },
    onFirstFailure: (error) => {
      failures.push(error);
    },
  };

  return {
    deps,
    synthCalls,
    createdUrls,
    revokedUrls,
    playedUrls,
    stoppedUrls,
    failures,
    /** 让最早一条在途合成成功落地。 */
    resolveSynth(): void {
      synthPending.shift()?.resolve({ blob: new Blob(['audio']) });
    },
    /** 让最早一条在途合成失败。 */
    rejectSynth(error: unknown): void {
      synthPending.shift()?.reject(error);
    },
    /** 当前播放自然播完。 */
    endPlayback(): void {
      const url = playedUrls.at(-1);
      if (url !== undefined) handles.get(url)?.end();
    },
    failPlayback(error: unknown): void {
      const url = playedUrls.at(-1);
      if (url !== undefined) handles.get(url)?.fail(error);
    },
  };
}

describe('announceEntryFor（入队条件的排列，53 号）', () => {
  const base = { conversationId: 'c1', active: true };

  it('当前会话的可见 bot 文本消息 → 条目（文本经 extractSpeechText）', () => {
    const entry = announceEntryFor(
      botTextMessage({ content: { text: '**你好**，见 [文档](https://e.com)' } }),
      base,
    );
    expect(entry).toEqual({ id: 'm1', text: '你好，见 文档', truncated: false });
  });

  it('语音模式未开启 → 不播', () => {
    expect(announceEntryFor(botTextMessage(), { ...base, active: false })).toBeNull();
  });

  it('非当前会话 / 会话缺失 → 不播', () => {
    expect(announceEntryFor(botTextMessage({ conversationId: 'c2' }), base)).toBeNull();
    expect(announceEntryFor(botTextMessage(), { ...base, conversationId: null })).toBeNull();
  });

  it('非 bot（user / system）→ 不播', () => {
    expect(announceEntryFor(botTextMessage({ senderType: 'user' }), base)).toBeNull();
    expect(announceEntryFor(botTextMessage({ senderType: 'system' }), base)).toBeNull();
  });

  it('非 text（card / system_event）→ 不播', () => {
    expect(
      announceEntryFor(botTextMessage({ kind: 'card', content: { cardType: 'x' } }), base),
    ).toBeNull();
    expect(
      announceEntryFor(botTextMessage({ kind: 'system_event', content: { event: 'a' } }), base),
    ).toBeNull();
  });

  it('空文本（空串 / 纯空白）→ 不播', () => {
    expect(announceEntryFor(botTextMessage({ content: { text: '' } }), base)).toBeNull();
    expect(announceEntryFor(botTextMessage({ content: { text: '   ' } }), base)).toBeNull();
  });

  it('列表不可见（setupAnswer / task interim）→ 不播（播的 = 列表记的）', () => {
    expect(
      announceEntryFor(botTextMessage({ content: { text: '答案', setupAnswer: true } }), base),
    ).toBeNull();
    expect(
      announceEntryFor(botTextMessage({ content: { text: '处理中', interim: true } }), base),
    ).toBeNull();
  });

  it('提取后无文字（纯图片 / 纯代码块消息）→ 不播', () => {
    expect(
      announceEntryFor(botTextMessage({ content: { text: '![图](x.png)' } }), base),
    ).toBeNull();
    expect(
      announceEntryFor(botTextMessage({ content: { text: '```\ncode\n```' } }), base),
    ).toBeNull();
  });

  it('超长文本 → truncated 标记（调用方每条一次 toast）', () => {
    const entry = announceEntryFor(botTextMessage({ content: { text: '长'.repeat(2001) } }), base);
    expect(entry?.truncated).toBe(true);
    expect(Array.from(entry?.text ?? '')).toHaveLength(2000);
  });
});

describe('播报队列（注入假依赖驱动真实 voiceMode store）', () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    voiceMode.exit();
    h = createHarness();
    voiceMode.attachAnnouncer(h.deps);
  });

  it('顺序消费：一次一条，speaking 两阶段（合成中 → 播放中），播完回 idle', async () => {
    voiceMode.enter();
    expect(voiceMode.announce({ id: 'a', text: '第一条', truncated: false })).toBe(true);
    expect(voiceMode.announce({ id: 'b', text: '第二条', truncated: false })).toBe(true);
    await tick();

    expect(voiceMode.phase).toBe('speaking');
    expect(voiceMode.speakingStage).toBe('synthesizing');
    expect(h.synthCalls).toEqual(['第一条']); // 第二条未并播

    h.resolveSynth();
    await tick();
    expect(voiceMode.speakingStage).toBe('playing');
    expect(h.playedUrls).toHaveLength(1);
    expect(h.synthCalls).toEqual(['第一条']); // 播放中不预取下一条

    h.endPlayback();
    await tick();
    expect(h.synthCalls).toEqual(['第一条', '第二条']); // ended 后取下一条
    expect(h.revokedUrls).toEqual(h.createdUrls.slice(0, 1)); // 上一条已 revoke

    h.resolveSynth();
    await tick();
    h.endPlayback();
    await tick();
    expect(voiceMode.phase).toBe('idle'); // 队列空回 idle
    expect(voiceMode.speakingStage).toBeNull();
    expect(h.revokedUrls).toEqual(h.createdUrls); // 全部回收
  });

  it('recording / transcribing 期间入队暂播，回 idle 按序播', async () => {
    voiceMode.enter();
    voiceMode.dispatch('record-started');
    voiceMode.announce({ id: 'a', text: '一', truncated: false });
    await tick();
    expect(h.synthCalls).toEqual([]); // 录音中暂播

    voiceMode.dispatch('stop-requested'); // → transcribing
    voiceMode.announce({ id: 'b', text: '二', truncated: false });
    await tick();
    expect(h.synthCalls).toEqual([]); // 识别中同样暂播

    voiceMode.dispatch('settled'); // → idle，按入队序恢复
    await tick();
    expect(h.synthCalls).toEqual(['一']);
  });

  it('插话作废（拿到流后 interruptSpeech）：停当前音频 + 清未播队列 + 回 idle', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'a', text: '一', truncated: false });
    voiceMode.announce({ id: 'b', text: '二', truncated: false });
    await tick();
    h.resolveSynth();
    await tick(); // a 播放中，b 在队

    voiceMode.interruptSpeech();
    await tick();
    expect(voiceMode.phase).toBe('idle');
    expect(h.stoppedUrls).toEqual(h.playedUrls); // 当前音频被停
    expect(h.revokedUrls).toEqual(h.createdUrls); // objectURL 回收
    expect(h.synthCalls).toEqual(['一']); // b 被作废（只留文字），永不合成

    // 打断后随即可以开始录音（speaking → idle → recording）。
    voiceMode.dispatch('record-started');
    expect(voiceMode.phase).toBe('recording');
  });

  it('插话作废也掐掉合成中的条目：在途合成落地后不建 URL、不播放', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'a', text: '一', truncated: false });
    await tick();
    expect(voiceMode.speakingStage).toBe('synthesizing');

    voiceMode.interruptSpeech();
    h.resolveSynth(); // 在途合成此刻才落地
    await tick();
    expect(h.createdUrls).toEqual([]); // 无泄漏
    expect(h.playedUrls).toEqual([]);
    expect(h.failures).toEqual([]); // 作废不算失败
    expect(voiceMode.phase).toBe('idle');
  });

  it('合成失败：第一条即停队 + 提示一次；不自动重试，新消息到来重新开始', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'a', text: '一', truncated: false });
    voiceMode.announce({ id: 'b', text: '二', truncated: false });
    await tick();

    h.rejectSynth(new Error('tts down'));
    await tick();
    expect(h.failures).toHaveLength(1);
    expect(voiceMode.phase).toBe('idle');
    expect(h.synthCalls).toEqual(['一']); // 队列里剩下的 b 不再逐条试（不连环刷）

    await tick();
    expect(h.synthCalls).toEqual(['一']); // 不自动重试

    voiceMode.announce({ id: 'c', text: '三', truncated: false }); // 新消息重启
    await tick();
    expect(h.synthCalls).toEqual(['一', '三']);
    expect(h.failures).toHaveLength(1);
  });

  it('播放失败与合成失败同路径：停队 + 提示 + 回 idle', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'a', text: '一', truncated: false });
    voiceMode.announce({ id: 'b', text: '二', truncated: false });
    await tick();
    h.resolveSynth();
    await tick();

    h.failPlayback(new Error('decode failed'));
    await tick();
    expect(h.failures).toHaveLength(1);
    expect(voiceMode.phase).toBe('idle');
    expect(h.synthCalls).toEqual(['一']); // b 停队
    expect(h.revokedUrls).toEqual(h.createdUrls);
  });

  it('退出（exit）：停当前 + 清队 + revoke 全部；未开启时入队被拒', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'a', text: '一', truncated: false });
    voiceMode.announce({ id: 'b', text: '二', truncated: false });
    await tick();
    h.resolveSynth();
    await tick(); // a 播放中

    voiceMode.exit();
    await tick();
    expect(voiceMode.active).toBe(false);
    expect(voiceMode.phase).toBe('idle');
    expect(h.stoppedUrls).toEqual(h.playedUrls);
    expect(h.revokedUrls).toEqual(h.createdUrls);
    expect(voiceMode.announce({ id: 'b', text: '二', truncated: false })).toBe(false);
  });

  it('退出时在途合成落地不建 URL（revoke 无泄漏）', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'a', text: '一', truncated: false });
    await tick();
    voiceMode.exit();
    h.resolveSynth();
    await tick();
    expect(h.createdUrls).toEqual([]);
    expect(h.playedUrls).toEqual([]);
  });

  it('重复消息 id 只入队一次（含在播 / 已播后到达的重复事件）', async () => {
    voiceMode.enter();
    expect(voiceMode.announce({ id: 'a', text: '一', truncated: false })).toBe(true);
    expect(voiceMode.announce({ id: 'a', text: '一', truncated: false })).toBe(false);
    await tick();
    h.resolveSynth();
    await tick(); // a 播放中
    expect(voiceMode.announce({ id: 'a', text: '一', truncated: false })).toBe(false);
    h.endPlayback();
    await tick(); // a 播完
    expect(voiceMode.announce({ id: 'a', text: '一', truncated: false })).toBe(false);
    expect(h.synthCalls).toEqual(['一']);
  });

  it('进入模式不补播历史：enter 后队列从空开始', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'a', text: '一', truncated: false });
    await tick();
    h.resolveSynth();
    await tick();
    h.endPlayback();
    await tick();
    expect(voiceMode.phase).toBe('idle');

    voiceMode.exit();
    voiceMode.enter(); // 重新进入：上一轮的条目不会被重播
    await tick();
    expect(h.synthCalls).toEqual(['一']);
  });

  it('attachAnnouncer 替换实例时复位卡住的 speaking 相位（防御：reset 不派发 speech-ended）', async () => {
    voiceMode.enter();
    voiceMode.announce({ id: 'a', text: '一', truncated: false });
    await tick();
    h.resolveSynth();
    await tick(); // 播放中；此刻另一 Composer 挂载注入新依赖
    voiceMode.attachAnnouncer(createHarness().deps);
    expect(voiceMode.phase).toBe('idle'); // 不卡在 speaking
    expect(voiceMode.speakingStage).toBeNull();
    expect(h.stoppedUrls).toEqual(h.playedUrls); // 旧实例的音频被停
  });
});
