import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { buildSpeechTools } from '../../src/tools/speech-tools.js';
import {
  buildImageTools,
  TOOL_SETUP_REQUIRED,
  type MediaToolFacade,
} from '../../src/tools/image-tools.js';
import type { AttachmentsService } from '../../src/domain/attachments.js';
import type { ToolGateway } from '../../src/gateway/index.js';
import type { RunIdentity, ToolContext, ToolDefinition } from '../../src/agent/types.js';

/**
 * generate_speech / generate_video / transcribe_audio / understand_image 工具
 * （docs/design/20-conversation-media.md、25-capability-tools.md）：成功落盘
 * 或回传内容、能力缺失 → SETUP_REQUIRED、视频异步轮询到终态、素材来源解析。
 */

const identity: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'turn',
};

const ctx = (signal = new AbortController().signal): ToolContext => ({
  identity,
  signal,
  terminate: () => {},
  progress: () => {},
});

/** D125 P3：记录状态行文案 / 可注入取消信号的工具上下文。 */
const progressCtx = (lines: string[], signal?: AbortSignal): ToolContext => ({
  identity,
  signal: signal ?? new AbortController().signal,
  terminate: () => {},
  progress: (text) => lines.push(text),
});

function facade(overrides: Partial<MediaToolFacade>): MediaToolFacade {
  return {
    generateImage: async () => ({ images: [] }),
    understandImage: async () => ({ text: '图里是一只猫' }),
    synthesizeSpeech: async () => ({ audioBase64: 'aGVsbG8=', mimeType: 'audio/mpeg' }),
    transcribeSpeech: async () => ({ text: '你好，今天天气怎么样' }),
    generateVideo: async () => ({ provider: 'volcengine', taskId: 'task_1' }),
    videoStatus: async () => ({ status: 'succeeded', videoUrl: 'https://example.invalid/v.mp4' }),
    ...overrides,
  };
}

interface FakeAttachment {
  id: string;
  conversationId: string;
  mime: string;
  fileName: string;
  bytes: Buffer;
}

function attachmentsFake(byId: Record<string, FakeAttachment>): AttachmentsService {
  return {
    get: (id: string) => byId[id] ?? null,
    readBytes: (attachment: { id: string }) => byId[attachment.id]!.bytes,
  } as unknown as AttachmentsService;
}

function gatewayFake(allowedPrefix: string): ToolGateway {
  const check = (target: string) =>
    path.resolve(target).startsWith(path.resolve(allowedPrefix))
      ? { kind: 'allowed' as const, resolvedPath: path.resolve(target) }
      : { kind: 'forbidden' as const, reason: '测试网关：路径越界' };
  return {
    // D75: generation tools refuse read-only runs up front (covered in gateway-read-only).
    writeDenial: () => null,
    checkPath: (_identity: RunIdentity, target: string) => check(target),
    ensurePathAccess: async (_identity: RunIdentity, target: string) => {
      const decision = check(target);
      if (decision.kind === 'allowed') return decision.resolvedPath;
      throw new AppError(
        'PATH_OUT_OF_SCOPE',
        `来源不在可访问范围内：${target}（${decision.reason}）`,
      );
    },
  } as unknown as ToolGateway;
}

const root = mkdtempSync(path.join(tmpdir(), 'media-tools-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function speechTools(
  overrides: Partial<MediaToolFacade> = {},
  opts: {
    workspace?: string;
    attachments?: Record<string, FakeAttachment>;
    videoPollIntervalMs?: number;
  } = {},
) {
  return buildSpeechTools({
    identity,
    media: facade(overrides),
    workspacePath: opts.workspace ?? path.join(root, 'speech-ws'),
    attachments: attachmentsFake(
      opts.attachments ?? {
        att_voice: {
          id: 'att_voice',
          conversationId: identity.conversationId!,
          mime: 'audio/wav',
          fileName: 'voice-message.wav',
          bytes: Buffer.from('fake-wav-bytes'),
        },
        att_other: {
          id: 'att_other',
          conversationId: 'conv_elsewhere',
          mime: 'audio/wav',
          fileName: 'elsewhere.wav',
          bytes: Buffer.from('nope'),
        },
      },
    ),
    gateway: gatewayFake(root),
    ...(opts.videoPollIntervalMs !== undefined
      ? { videoPollIntervalMs: opts.videoPollIntervalMs }
      : {}),
  });
}

/**
 * D124 P3：工具描述的条目清单注入（docs/design/60-capability-model-plugins.md 决策 7）。
 * 未绑定条目（hints 缺省或空清单）时描述与今日逐字节一致——字符串级断言是硬约束。
 */
describe('生成工具描述的条目清单注入（D124 P3）', () => {
  const BASE_IMAGE_DESCRIPTION =
    '生成图片（文生图）。用户要图片、图标、插画、海报等真实图片文件时必须调用本工具产出，不要用文字描述或字符画代替；图片保存到 workspace 后会自动作为消息附件发给用户，无需再调 send_message。未配置图像生成模型时本工具会返回「需要设置」，由系统引导用户完成配置并自动继续，不要因此改用文字方案或推荐外部工具。';
  const BASE_SPEECH_DESCRIPTION =
    '把文本合成为语音（TTS）。用户要配音、朗读、语音消息等真实音频文件时必须调用本工具产出，不要只给文字稿；音频保存到 workspace 后会自动作为消息附件发给用户，无需再调 send_message。未配置语音合成模型时本工具会返回「需要设置」，由系统引导用户完成配置并自动继续。';
  const BASE_VIDEO_DESCRIPTION =
    '根据文字描述生成一段短视频（文生视频，异步任务，通常需要几十秒到几分钟）。用户要真实视频文件时必须调用本工具产出，不要只给分镜脚本；视频保存到 workspace 后会自动作为消息附件发给用户，无需再调 send_message。未配置视频生成模型时本工具会返回「需要设置」，由系统引导用户完成配置并自动继续。';

  function imageToolWithHints(hints?: { image?: string[] }): ToolDefinition {
    return buildImageTools({
      identity,
      media: facade(),
      workspacePath: path.join(root, 'hints-ws'),
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
      ...(hints !== undefined ? { entryHints: hints } : {}),
    }).find((tool) => tool.name === 'generate_image')!;
  }

  it('未绑定条目（缺省 hints）：三个生成工具描述与今日逐字节一致', () => {
    expect(imageToolWithHints().description).toBe(BASE_IMAGE_DESCRIPTION);
    const speech = buildSpeechTools({
      identity,
      media: facade(),
      workspacePath: path.join(root, 'hints-ws'),
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
    });
    expect(speech.find((tool) => tool.name === 'generate_speech')!.description).toBe(
      BASE_SPEECH_DESCRIPTION,
    );
    expect(speech.find((tool) => tool.name === 'generate_video')!.description).toBe(
      BASE_VIDEO_DESCRIPTION,
    );
  });

  it('清单为空数组（如 Bot 勾选集为空）：同样逐字节一致', () => {
    expect(imageToolWithHints({ image: [] }).description).toBe(BASE_IMAGE_DESCRIPTION);
  });

  it('绑定了条目：描述尾部追加条目清单段', () => {
    const tool = imageToolWithHints({ image: ['水墨画（inkwash-xl）', 'qwen-image-2.0'] });
    expect(tool.description).toBe(
      `${BASE_IMAGE_DESCRIPTION}本 Bot 可用的图片生成模型条目：水墨画（inkwash-xl）、qwen-image-2.0；用 model 参数指定，留空用默认。`,
    );
  });

  it('只注入对应能力：speech 工具不出现 image 条目，video 工具不出现 tts 条目', () => {
    const tools = buildSpeechTools({
      identity,
      media: facade(),
      workspacePath: path.join(root, 'hints-ws'),
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
      entryHints: {
        tts: ['音色甲（voice-a）'],
        video: ['wan2.6-t2v'],
      },
    });
    const speech = tools.find((tool) => tool.name === 'generate_speech')!;
    expect(speech.description).toBe(
      `${BASE_SPEECH_DESCRIPTION}本 Bot 可用的语音合成模型条目：音色甲（voice-a）；用 model 参数指定，留空用默认。`,
    );
    const video = tools.find((tool) => tool.name === 'generate_video')!;
    expect(video.description).toBe(
      `${BASE_VIDEO_DESCRIPTION}本 Bot 可用的视频生成模型条目：wan2.6-t2v；用 model 参数指定，留空用默认。`,
    );
  });

  it('清单超过 6 条：截断为前 6 条 + 「等 N 个」', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const tool = imageToolWithHints({ image: names });
    expect(tool.description).toBe(
      `${BASE_IMAGE_DESCRIPTION}本 Bot 可用的图片生成模型条目：${names
        .slice(0, 6)
        .join('、')} 等 8 个；用 model 参数指定，留空用默认。`,
    );
  });
});

describe('generate_speech', () => {
  it('成功：字节落盘 workspace/.generated 并返回路径', async () => {
    const workspace = path.join(root, 'ws1');
    const tools = speechTools({}, { workspace });
    const speech = tools.find((tool) => tool.name === 'generate_speech')!;
    const result = await speech.execute({ text: '你好', file_name: 'greeting' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('greeting.mp3');
    const saved = readFileSync(path.join(workspace, '.generated', 'greeting.mp3'));
    expect(saved.toString()).toBe('hello');
  });

  it('能力缺失 → SETUP_REQUIRED 错误码', async () => {
    const tools = speechTools({
      synthesizeSpeech: async () => {
        throw new AppError('CAPABILITY_NOT_CONFIGURED', '未配置 tts');
      },
    });
    const speech = tools.find((tool) => tool.name === 'generate_speech')!;
    const result = await speech.execute({ text: '你好' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(TOOL_SETUP_REQUIRED);
  });

  it('厂商失败照常作为普通失败结果', async () => {
    const tools = speechTools({
      synthesizeSpeech: async () => {
        throw new AppError('PROVIDER_UNAVAILABLE', '厂商抽风');
      },
    });
    const speech = tools.find((tool) => tool.name === 'generate_speech')!;
    const result = await speech.execute({ text: '你好' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('生成产物的确定性投递（GeneratedMediaDelivery）', () => {
  it('generate_image：落盘后 delivery.send 收到保存路径，文案改为「已作为消息附件」', async () => {
    const workspace = path.join(root, 'ws-delivery-img');
    const sent: Array<{ files: string[]; caption: string }> = [];
    const tools = buildImageTools({
      identity,
      media: facade({
        generateImage: async () => ({
          images: [{ b64: Buffer.from('png-bytes').toString('base64') }],
        }),
      }),
      workspacePath: workspace,
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
      delivery: {
        send: (files, caption) => {
          sent.push({ files, caption });
          return { delivered: files, failed: [] };
        },
      },
    });
    const image = tools.find((tool) => tool.name === 'generate_image')!;
    const result = await image.execute({ prompt: '一只猫', file_name: 'cat' }, ctx());
    expect(result.ok).toBe(true);
    expect(sent).toEqual([{ files: [path.join(workspace, '.generated', 'cat.png')], caption: '' }]);
    expect(result.content).toContain('已作为消息附件显示在用户的对话界面中');
    expect(result.content).not.toContain('请用 send_message');
    // 不把绝对路径回给模型——它只会把路径复述给用户（噪声）。
    expect(result.content).not.toContain(workspace);
    expect(readFileSync(path.join(workspace, '.generated', 'cat.png')).toString()).toBe(
      'png-bytes',
    );
  });

  it('generate_speech：同样自动投递', async () => {
    const workspace = path.join(root, 'ws-delivery-speech');
    const sent: Array<{ files: string[]; caption: string }> = [];
    const tools = buildSpeechTools({
      identity,
      media: facade(),
      workspacePath: workspace,
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
      delivery: {
        send: (files, caption) => {
          sent.push({ files, caption });
          return { delivered: files, failed: [] };
        },
      },
    });
    const speech = tools.find((tool) => tool.name === 'generate_speech')!;
    const result = await speech.execute({ text: '你好', file_name: 'greeting' }, ctx());
    expect(result.ok).toBe(true);
    expect(sent).toEqual([
      { files: [path.join(workspace, '.generated', 'greeting.mp3')], caption: '' },
    ]);
    expect(result.content).toContain('已作为消息附件显示在用户的对话界面中');
    expect(result.content).not.toContain(workspace);
  });
});

describe('投递失败时的工具结果（不得谎称已显示）', () => {
  const failedOutcome = (file: string, reason: string) => ({
    delivered: [],
    failed: [{ path: file, reason }],
  });

  it('generate_image 多张：部分失败 → 已送达数量 + 失败项路径与原因，ok 仍为 true', async () => {
    const workspace = path.join(root, 'ws-delivery-partial');
    const tools = buildImageTools({
      identity,
      media: facade({
        generateImage: async () => ({
          images: [
            { b64: Buffer.from('a').toString('base64') },
            { b64: Buffer.from('b').toString('base64') },
          ],
        }),
      }),
      workspacePath: workspace,
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
      delivery: {
        send: (files) => ({
          delivered: [files[0]!],
          failed: [{ path: files[1]!, reason: '文件过大（31.0MB，附件上限 30.0MB）' }],
        }),
      },
    });
    const image = tools.find((tool) => tool.name === 'generate_image')!;
    const result = await image.execute({ prompt: 'x', file_name: 'p', n: 2 }, ctx());
    const second = path.join(workspace, '.generated', 'p-2.png');
    expect(result.ok).toBe(true);
    expect(result.content).toContain('其中 1 个文件已作为消息附件显示');
    expect(result.content).toContain(second);
    expect(result.content).toContain('文件过大');
    // 已送达的那张不再列为待补发。
    expect(result.content).not.toContain(path.join(workspace, '.generated', 'p-1.png'));
    expect(result.content).toContain('send_message');
  });

  it('generate_speech：全部失败 → 回路径与原因，不说「已显示」', async () => {
    const workspace = path.join(root, 'ws-delivery-speech-fail');
    const tools = buildSpeechTools({
      identity,
      media: facade(),
      workspacePath: workspace,
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
      delivery: {
        send: (files) => failedOutcome(files[0]!, '没有读取权限（测试）'),
      },
    });
    const speech = tools.find((tool) => tool.name === 'generate_speech')!;
    const result = await speech.execute({ text: '你好', file_name: 'g' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain(path.join(workspace, '.generated', 'g.mp3'));
    expect(result.content).toContain('没有读取权限');
    expect(result.content).toContain('投递到对话失败');
    expect(result.content).not.toContain('无需再调 send_message');
  });

  it('generate_video：超过附件上限 → 回路径与原因', async () => {
    const workspace = path.join(root, 'ws-delivery-video-fail');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;
    try {
      const tools = buildSpeechTools({
        identity,
        media: facade(),
        workspacePath: workspace,
        attachments: attachmentsFake({}),
        gateway: gatewayFake(root),
        delivery: {
          send: (files) => failedOutcome(files[0]!, '文件过大（40.0MB，附件上限 30.0MB）'),
        },
      });
      const video = tools.find((tool) => tool.name === 'generate_video')!;
      const result = await video.execute({ prompt: 'x', file_name: 'v' }, ctx());
      expect(result.ok).toBe(true);
      expect(result.content).toContain(path.join(workspace, '.generated', 'v.mp4'));
      expect(result.content).toContain('文件过大');
      expect(result.content).not.toContain('无需再调 send_message');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('generate_video', () => {
  it('提交 → 轮询到成功 → 下载字节落盘', async () => {
    const workspace = path.join(root, 'ws4');
    let polls = 0;
    const tools = speechTools(
      {
        videoStatus: async () => {
          polls += 1;
          return polls === 1
            ? { status: 'queued' }
            : { status: 'succeeded', videoUrl: 'https://example.invalid/v.mp4' };
        },
      },
      { workspace, videoPollIntervalMs: 5 },
    );
    // 让下载得到确定字节：替换全局 fetch。
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as typeof fetch;
    try {
      const video = tools.find((tool) => tool.name === 'generate_video')!;
      const result = await video.execute({ prompt: '一只猫', file_name: 'cat' }, ctx());
      expect(result.ok).toBe(true);
      expect(result.content).toContain('cat.mp4');
      expect(readFileSync(path.join(workspace, '.generated', 'cat.mp4')).length).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('任务失败 → 携带厂商原因的失败结果', async () => {
    const tools = speechTools({
      videoStatus: async () => ({ status: 'failed', error: '内容审核未通过' }),
    });
    const video = tools.find((tool) => tool.name === 'generate_video')!;
    const result = await video.execute({ prompt: 'x' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain('内容审核未通过');
  });

  it('未配置能力 → SETUP_REQUIRED', async () => {
    const tools = speechTools({
      generateVideo: async () => {
        throw new AppError('CAPABILITY_NOT_CONFIGURED', '未配置 video');
      },
    });
    const video = tools.find((tool) => tool.name === 'generate_video')!;
    const result = await video.execute({ prompt: 'x' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(TOOL_SETUP_REQUIRED);
  });
});

describe('transcribe_audio', () => {
  it('附件来源：字节转 base64 走转写，结果包 untrusted', async () => {
    let received: { audioBase64: string; audioMime: string; language?: string } | null = null;
    const tools = speechTools({
      transcribeSpeech: async (input) => {
        received = input;
        return { text: '会议纪要如下……' };
      },
    });
    const tool = tools.find((t) => t.name === 'transcribe_audio')!;
    const result = await tool.execute({ audio: 'att_voice', language: 'zh' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('会议纪要如下……');
    expect(result.content.startsWith('<untrusted>')).toBe(true);
    expect(received).not.toBeNull();
    expect(received!.audioMime).toBe('audio/wav');
    expect(received!.language).toBe('zh');
    expect(Buffer.from(received!.audioBase64, 'base64').toString()).toBe('fake-wav-bytes');
  });

  it('路径来源：走网关检查后读取文件', async () => {
    const dir = path.join(root, 'audio-src');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'memo.mp3');
    writeFileSync(file, 'mp3-bytes');
    const tools = speechTools({
      transcribeSpeech: async () => ({ text: '转写结果' }),
    });
    const tool = tools.find((t) => t.name === 'transcribe_audio')!;
    const result = await tool.execute({ audio: file }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('转写结果');
  });

  it('越界路径 → PATH_OUT_OF_SCOPE 失败结果', async () => {
    const tools = speechTools();
    const tool = tools.find((t) => t.name === 'transcribe_audio')!;
    const result = await tool.execute({ audio: '/etc/passwd' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('PATH_OUT_OF_SCOPE');
  });

  it('附件不属于当前对话 → NOT_FOUND', async () => {
    const tools = speechTools();
    const tool = tools.find((t) => t.name === 'transcribe_audio')!;
    const result = await tool.execute({ audio: 'att_other' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });

  it('未配置能力 → SETUP_REQUIRED', async () => {
    const tools = speechTools({
      transcribeSpeech: async () => {
        throw new AppError('CAPABILITY_NOT_CONFIGURED', '未配置 asr');
      },
    });
    const tool = tools.find((t) => t.name === 'transcribe_audio')!;
    const result = await tool.execute({ audio: 'att_voice' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(TOOL_SETUP_REQUIRED);
  });
});

describe('understand_image', () => {
  function imageTools(overrides: Partial<MediaToolFacade> = {}) {
    const dir = path.join(root, 'image-src');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'photo.png');
    writeFileSync(file, Buffer.from('png-bytes'));
    return buildImageTools({
      identity,
      media: facade(overrides),
      workspacePath: path.join(root, 'image-ws'),
      attachments: attachmentsFake({
        att_shot: {
          id: 'att_shot',
          conversationId: identity.conversationId!,
          mime: 'image/png',
          fileName: 'shot.png',
          bytes: Buffer.from('png-bytes'),
        },
      }),
      gateway: gatewayFake(root),
    });
  }

  it('路径 + 附件来源：转 data URI 走理解，结果包 untrusted', async () => {
    const received: string[][] = [];
    const tools = imageTools({
      understandImage: async (input) => {
        received.push(input.images);
        return { text: '图中是一张截图' };
      },
    });
    const tool = tools.find((t) => t.name === 'understand_image')!;
    const file = path.join(root, 'image-src', 'photo.png');
    const result = await tool.execute({ images: [file, 'att_shot'], prompt: '描述图片' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('图中是一张截图');
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
    expect(received[0]![0]).toMatch(/^data:image\/png;base64,/);
    expect(received[0]![1]).toMatch(/^data:image\/png;base64,/);
  });

  it('超大图片跳过并在结果中说明；全部超大 → 失败', async () => {
    const dir = path.join(root, 'image-src');
    const big = path.join(dir, 'big.png');
    writeFileSync(big, Buffer.alloc(6_000_000, 1));
    const tools = imageTools();
    const tool = tools.find((t) => t.name === 'understand_image')!;
    const partial = await tool.execute({ images: [big, 'att_shot'], prompt: 'x' }, ctx());
    expect(partial.ok).toBe(true);
    expect(partial.content).toContain('过大已跳过');

    const none = await tool.execute({ images: [big], prompt: 'x' }, ctx());
    expect(none.ok).toBe(false);
    expect(none.errorCode).toBe('INVALID_INPUT');
  });

  it('未配置能力 → SETUP_REQUIRED', async () => {
    const tools = imageTools({
      understandImage: async () => {
        throw new AppError('CAPABILITY_NOT_CONFIGURED', '未配置 multimodal');
      },
    });
    const tool = tools.find((t) => t.name === 'understand_image')!;
    const result = await tool.execute({ images: ['att_shot'], prompt: 'x' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(TOOL_SETUP_REQUIRED);
  });
});

describe('文件卡登记：已投递的生成媒体不再列出（recordUndeliveredFiles）', () => {
  it('generate_image 全部投递成功 → 不登记文件卡（附件是持久副本，源文件是临时产物）', async () => {
    const workspace = path.join(root, 'ws-record-delivered');
    const recorded: string[] = [];
    const tools = buildImageTools({
      identity,
      media: facade({
        generateImage: async () => ({
          images: [{ b64: Buffer.from('png-bytes').toString('base64') }],
        }),
      }),
      workspacePath: workspace,
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
      recordFile: (target) => recorded.push(target),
      delivery: {
        send: (files) => ({ delivered: files, failed: [] }),
      },
    });
    const image = tools.find((tool) => tool.name === 'generate_image')!;
    await image.execute({ prompt: '一只猫', file_name: 'cat' }, ctx());
    expect(recorded).toEqual([]);
  });

  it('generate_image 部分投递失败 → 只登记未投递的文件', async () => {
    const workspace = path.join(root, 'ws-record-partial');
    const recorded: string[] = [];
    const tools = buildImageTools({
      identity,
      media: facade({
        generateImage: async () => ({
          images: [
            { b64: Buffer.from('a').toString('base64') },
            { b64: Buffer.from('b').toString('base64') },
          ],
        }),
      }),
      workspacePath: workspace,
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
      recordFile: (target) => recorded.push(target),
      delivery: {
        send: (files) => ({
          delivered: [files[0]!],
          failed: [{ path: files[1]!, reason: '文件过大' }],
        }),
      },
    });
    const image = tools.find((tool) => tool.name === 'generate_image')!;
    await image.execute({ prompt: 'x', file_name: 'p', n: 2 }, ctx());
    expect(recorded).toEqual([path.join(workspace, '.generated', 'p-2.png')]);
  });

  it('generate_speech 投递全部失败 → 照常登记（用户还需要从文件卡找到它）', async () => {
    const workspace = path.join(root, 'ws-record-failed');
    const recorded: string[] = [];
    const tools = buildSpeechTools({
      identity,
      media: facade(),
      workspacePath: workspace,
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
      recordFile: (target) => recorded.push(target),
      delivery: {
        send: (files) => ({ delivered: [], failed: [{ path: files[0]!, reason: '没有读取权限' }] }),
      },
    });
    const speech = tools.find((tool) => tool.name === 'generate_speech')!;
    await speech.execute({ text: '你好', file_name: 'g' }, ctx());
    expect(recorded).toEqual([path.join(workspace, '.generated', 'g.mp3')]);
  });

  it('没有 delivery（精简装配）→ 全部登记，行为不变', async () => {
    const workspace = path.join(root, 'ws-record-no-delivery');
    const recorded: string[] = [];
    const tools = buildImageTools({
      identity,
      media: facade({
        generateImage: async () => ({
          images: [{ b64: Buffer.from('png-bytes').toString('base64') }],
        }),
      }),
      workspacePath: workspace,
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
      recordFile: (target) => recorded.push(target),
    });
    const image = tools.find((tool) => tool.name === 'generate_image')!;
    await image.execute({ prompt: '一只猫', file_name: 'cat' }, ctx());
    expect(recorded).toEqual([path.join(workspace, '.generated', 'cat.png')]);
  });
});

/**
 * D125 P3：插件进度 / 取消的工具侧接线（61 §6、DEV-118）。
 * 工具把 `ctx.signal` / `ctx.progress` 桥成 facade 第 4 参；插件 progress 帧收成
 * 状态行文案；视频工具在插件开口后不再重复上报宿主自己的阶段文案。
 */
describe('插件进度与取消接线（D125 P3）', () => {
  it('generate_image：ctx.signal 下传 facade；插件 progress → 状态行（message + percent）', async () => {
    const workspace = path.join(root, 'ws-p3-image');
    const controller = new AbortController();
    const seen: Array<{ signal?: AbortSignal; hasProgress: boolean }> = [];
    const lines: string[] = [];
    const tools = buildImageTools({
      identity,
      media: facade({
        generateImage: async (_input, _usage, _resolve, controls) => {
          seen.push({
            signal: controls?.signal,
            hasProgress: controls?.onProgress !== undefined,
          });
          controls?.onProgress?.({ phase: 'queued', percent: 42.4, message: '生成中' });
          controls?.onProgress?.({ phase: 'downloading' });
          controls?.onProgress?.({ phase: 'noop' }); // 无 message/percent → phase 原样
          return { images: [{ b64: Buffer.from('png-bytes').toString('base64') }] };
        },
      }),
      workspacePath: workspace,
      attachments: attachmentsFake({}),
      gateway: gatewayFake(root),
    });
    const image = tools.find((tool) => tool.name === 'generate_image')!;
    const result = await image.execute(
      { prompt: '一只猫', file_name: 'cat' },
      progressCtx(lines, controller.signal),
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ signal: controller.signal, hasProgress: true }]);
    expect(lines).toEqual(['生成中 42%', 'downloading', 'noop']);
  });

  it('generate_video：插件给了阶段文案后，宿主自己的轮询文案让位（不双份）', async () => {
    const workspace = path.join(root, 'ws-p3-video-plugin');
    const lines: string[] = [];
    let polls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2]), { status: 200 })) as typeof fetch;
    try {
      const tools = speechTools(
        {
          generateVideo: async (_input, _usage, _resolve, controls) => {
            controls?.onProgress?.({ phase: 'queued', percent: 5, message: '任务已排队' });
            return { provider: 'pli_x', taskId: 'task_p3' };
          },
          videoStatus: async (_provider, _taskId, controls) => {
            polls += 1;
            if (polls === 1) {
              controls?.onProgress?.({ phase: 'generating', percent: 60, message: '生成中' });
              return { status: 'running' };
            }
            return { status: 'succeeded', videoUrl: 'https://example.invalid/v.mp4' };
          },
        },
        { workspace, videoPollIntervalMs: 5 },
      );
      const video = tools.find((tool) => tool.name === 'generate_video')!;
      const result = await video.execute(
        { prompt: '一只猫', file_name: 'cat' },
        progressCtx(lines),
      );
      expect(result.ok).toBe(true);
      expect(lines).toEqual(['任务已排队 5%', '生成中 60%']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('generate_video：内置引擎路径（插件未开口）保持既有宿主阶段文案', async () => {
    const workspace = path.join(root, 'ws-p3-video-engine');
    const lines: string[] = [];
    let polls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2]), { status: 200 })) as typeof fetch;
    try {
      const tools = speechTools(
        {
          generateVideo: async () => ({ provider: 'volcengine', taskId: 'task_engine' }),
          videoStatus: async () => {
            polls += 1;
            if (polls === 1) return { status: 'queued' };
            if (polls === 2) return { status: 'running' };
            return { status: 'succeeded', videoUrl: 'https://example.invalid/v.mp4' };
          },
        },
        { workspace, videoPollIntervalMs: 5 },
      );
      const video = tools.find((tool) => tool.name === 'generate_video')!;
      const result = await video.execute(
        { prompt: '一只猫', file_name: 'cat' },
        progressCtx(lines),
      );
      expect(result.ok).toBe(true);
      expect(lines).toEqual([
        '视频任务已提交（task_engine），等待生成…',
        '视频排队中…',
        '视频生成中…',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
