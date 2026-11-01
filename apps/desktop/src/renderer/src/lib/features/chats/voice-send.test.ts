import { describe, expect, it } from 'vitest';
import type { ComposerSendDeps } from './composer-send.js';
import { createSendGuard } from './composer-send.js';
import {
  isCapabilityError,
  sendVoiceRecording,
  type VoiceSendDeps,
  type VoiceSendGuard,
} from './voice-send.js';

/**
 * 语音消息发送编排（docs/design/53-voice-conversation.md 发送链路 + 26 号
 * 「语音消息语义」）：转写分支（空识别 / 缺设置 / 非缺设置照发）、WAV File
 * 上传、settle → send → commit 的参数配对，以及 guard 忙时的排队串行
 * （P2-1：连发是正常路径，不允许静默丢转写文本）。依赖全部注入，无 core /
 * 麦克风。Composer 的接线（RPC / toast / 置卡 / composerDrafts）不在单测内。
 */

const CONV = 'conv_voice';

const recording = { blob: new Blob([new Uint8Array([1, 2, 3])]), base64: 'QUJD' };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(
  opts: {
    deps?: Partial<VoiceSendDeps>;
    send?: Partial<ComposerSendDeps>;
    /** 包一层默认的 send（记录行为不变，可注入阻塞等），供时序用例用。 */
    wrapSend?: (inner: ComposerSendDeps['send']) => ComposerSendDeps['send'];
  } = {},
) {
  const events: string[] = [];
  const sent: Array<{ text: string; ids: string[] }> = [];
  const uploads: File[] = [];
  const transcribeInputs: string[] = [];
  let settledIds: string[] = ['att_voice'];
  const recordSend = async (text: string, ids: string[]) => {
    events.push('send');
    sent.push({ text, ids });
    return { ok: true } as const;
  };
  const deps: VoiceSendDeps = {
    transcribe: async (audioBase64) => {
      transcribeInputs.push(audioBase64);
      return '你好';
    },
    onNoSpeech: () => events.push('no-speech'),
    onCapabilityMissing: () => events.push('capability-missing'),
    onTranscribeFailed: () => events.push('transcribe-failed'),
    onSending: () => events.push('sending'),
    uploadVoiceRecording: (file) => {
      uploads.push(file);
      events.push('upload');
    },
    guard: createSendGuard(),
    composerSend: {
      settle: async () => {
        events.push('settle');
        return settledIds;
      },
      send: opts.wrapSend ? opts.wrapSend(recordSend) : recordSend,
      commit: (ids) => events.push(`commit:${ids.join(',')}`),
      restore: () => events.push('restore'),
      inspectAttachments: async () => ({ missing: [], sent: [] }),
      onAttachmentIssue: () => events.push('issue'),
      reportFailure: (code) => events.push(`report:${code ?? 'none'}`),
      ...opts.send,
    },
    ...opts.deps,
  };
  return {
    deps,
    events,
    sent,
    uploads,
    transcribeInputs,
    setSettledIds: (ids: string[]) => {
      settledIds = ids;
    },
  };
}

describe('sendVoiceRecording（53 号发送链路编排）', () => {
  it('正常链路：转写文本作正文、附件 id 随消息发出、成功后 commit；转写拿的是录音 base64', async () => {
    const { deps, events, sent, transcribeInputs } = harness();
    expect(await sendVoiceRecording(recording, CONV, deps)).toBe('sent');
    expect(events).toEqual(['sending', 'upload', 'settle', 'send', 'commit:att_voice']);
    expect(sent).toEqual([{ text: '你好', ids: ['att_voice'] }]);
    expect(transcribeInputs).toEqual(['QUJD']);
  });

  it('上传的 WAV File：voice-{ts}.wav / audio/wav / 字节就是录音 blob', async () => {
    const { deps, uploads } = harness();
    await sendVoiceRecording(recording, CONV, deps);
    expect(uploads.length).toBe(1);
    const file = uploads[0];
    if (file === undefined) throw new Error('voice wav not uploaded');
    expect(file).toBeInstanceOf(File);
    expect(file.name).toMatch(/^voice-\d+\.wav$/);
    expect(file.type).toBe('audio/wav');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('空识别（没说话 / 纯空白）：toast 不发送、不上传附件', async () => {
    const { deps, events, uploads, sent } = harness({
      deps: { transcribe: async () => '   ' },
    });
    expect(await sendVoiceRecording(recording, CONV, deps)).toBe('no-speech');
    expect(events).toEqual(['no-speech']);
    expect(uploads).toEqual([]);
    expect(sent).toEqual([]);
  });

  for (const code of ['CAPABILITY_NOT_CONFIGURED', 'PROVIDER_AUTH_FAILED']) {
    it(`缺设置（${code}）：置卡不发送、不上传（此时尚无附件可撤）`, async () => {
      const { deps, events, uploads, sent } = harness({
        deps: {
          transcribe: async () => {
            const error = new Error('no asr') as Error & { code: string };
            error.code = code;
            throw error;
          },
        },
      });
      expect(await sendVoiceRecording(recording, CONV, deps)).toBe('capability-missing');
      expect(events).toEqual(['capability-missing']);
      expect(uploads).toEqual([]);
      expect(sent).toEqual([]);
    });
  }

  it('非缺设置的转写失败：提示后空文本 + 附件照发（模型侧 transcribe_audio 兜底）', async () => {
    const { deps, events, sent } = harness({
      deps: {
        transcribe: async () => {
          throw new Error('network down');
        },
      },
    });
    expect(await sendVoiceRecording(recording, CONV, deps)).toBe('sent');
    expect(events).toEqual([
      'transcribe-failed',
      'sending',
      'upload',
      'settle',
      'send',
      'commit:att_voice',
    ]);
    // 空文本 + 纯附件对 messages.send 合法（26 号语义）。
    expect(sent).toEqual([{ text: '', ids: ['att_voice'] }]);
  });

  it('转写失败且上传也失败（settle 为空）：不发空消息（core 会回 INVALID_INPUT）', async () => {
    const { deps, events, sent, setSettledIds } = harness({
      deps: {
        transcribe: async () => {
          throw new Error('network down');
        },
      },
    });
    setSettledIds([]);
    expect(await sendVoiceRecording(recording, CONV, deps)).toBe('empty');
    expect(events).toEqual(['transcribe-failed', 'sending', 'upload', 'settle']);
    expect(sent).toEqual([]);
  });

  it('发送失败：performComposerSend 的失败收尾原样透传（restore 语义由接线方决定）', async () => {
    const { deps, events } = harness({
      send: { send: async () => ({ ok: false, code: 'PROVIDER_UNREACHABLE' }) },
    });
    expect(await sendVoiceRecording(recording, CONV, deps)).toBe('failed');
    expect(events).toEqual([
      'sending',
      'upload',
      'settle',
      'report:PROVIDER_UNREACHABLE',
      'restore',
    ]);
  });

  it('onSending（WP3 小项）：只在「即将进入发送」时于上传前触发——空识别 / 缺设置不触发', async () => {
    // 正常路径：sending 在 upload 之前（上面各用例的事件序已覆盖）。这里补
    // 两个不发出的分支，钩子不该误报「发送中」。
    const noSpeech = harness({ deps: { transcribe: async () => '' } });
    await sendVoiceRecording(recording, CONV, noSpeech.deps);
    expect(noSpeech.events).toEqual(['no-speech']);

    const missing = harness({
      deps: {
        transcribe: async () => {
          throw Object.assign(new Error('no asr'), { code: 'CAPABILITY_NOT_CONFIGURED' });
        },
      },
    });
    await sendVoiceRecording(recording, CONV, missing.deps);
    expect(missing.events).toEqual(['capability-missing']);
  });
});

describe('guard 忙时串行（P2-1：不允许静默丢转写文本）', () => {
  it('前一条（文字或语音）settle+send 在途：这条排队等空闲再发，文本与附件配对完整', async () => {
    // 模拟文字直发占闸（sendCurrent 的 run 在途）。
    const guard = createSendGuard();
    let release!: () => void;
    const inFlight = guard.run(
      CONV,
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('text-sent');
        }),
    );
    const { deps, events, sent } = harness({ deps: { guard } });

    const pending = sendVoiceRecording(recording, CONV, deps);
    await wait(10);
    // 转写 / 上传已就绪，但闸被占：未 settle 未 send，也不静默丢弃。
    expect(events).toEqual(['sending', 'upload']);
    expect(sent).toEqual([]);
    expect(guard.isBusy(CONV)).toBe(true);

    release();
    await inFlight;
    expect(await pending).toBe('sent');
    expect(events).toEqual(['sending', 'upload', 'settle', 'send', 'commit:att_voice']);
    expect(sent).toEqual([{ text: '你好', ids: ['att_voice'] }]);
  });

  it('连发两条：按说出的顺序逐条发出（第二条等第一条收尾），都不丢', async () => {
    const guard = createSendGuard();
    let transcribeCalls = 0;
    let releaseFirst!: () => void;
    const { deps, sent } = harness({
      deps: {
        guard,
        transcribe: async () => (transcribeCalls++ === 0 ? '第一条' : '第二条'),
      },
      wrapSend: (inner) => async (text, ids) => {
        const outcome = inner(text, ids); // 记录先行（inner 同步段就落 sent）
        if (text === '第一条') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return outcome;
      },
    });

    const first = sendVoiceRecording(recording, CONV, deps);
    await wait(10); // 第一条已进闸、卡在 send
    const second = sendVoiceRecording(recording, CONV, deps);
    await wait(10); // 第二条在等闸：还没有第二条的消息
    expect(sent.map((entry) => entry.text)).toEqual(['第一条']);

    releaseFirst();
    expect(await first).toBe('sent');
    expect(await second).toBe('sent');
    expect(sent.map((entry) => entry.text)).toEqual(['第一条', '第二条']);
    expect(sent.every((entry) => entry.ids.length === 1)).toBe(true);
  });

  it('waitForIdle 解锁与抢闸之间被并发发送占先（run 返回 undefined）：再等一轮仍发出', async () => {
    let runs = 0;
    const guard: VoiceSendGuard = {
      isBusy: () => false,
      waitForIdle: async () => {},
      async run<T>(_key: string, task: () => Promise<T>): Promise<T | undefined> {
        runs += 1;
        if (runs === 1) return undefined; // 模拟抢闸失败
        return task();
      },
    };
    const { deps, sent } = harness({ deps: { guard } });
    expect(await sendVoiceRecording(recording, CONV, deps)).toBe('sent');
    expect(runs).toBe(2);
    expect(sent).toEqual([{ text: '你好', ids: ['att_voice'] }]);
  });

  it('闸空闲（无在途）：直接发出，不额外等待', async () => {
    const { deps } = harness();
    await expect(sendVoiceRecording(recording, CONV, deps)).resolves.toBe('sent');
  });
});

describe('isCapabilityError', () => {
  it('只认 CAPABILITY_NOT_CONFIGURED / PROVIDER_AUTH_FAILED（带 code 的抛错）', () => {
    const withCode = (code: string) => Object.assign(new Error('x'), { code });
    expect(isCapabilityError(withCode('CAPABILITY_NOT_CONFIGURED'))).toBe(true);
    expect(isCapabilityError(withCode('PROVIDER_AUTH_FAILED'))).toBe(true);
    expect(isCapabilityError(withCode('INTERNAL'))).toBe(false);
    expect(isCapabilityError(new Error('network down'))).toBe(false);
    expect(isCapabilityError(undefined)).toBe(false);
    expect(isCapabilityError('CAPABILITY_NOT_CONFIGURED')).toBe(false);
  });
});
