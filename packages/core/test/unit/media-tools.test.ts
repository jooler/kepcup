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
import type { RunIdentity, ToolContext } from '../../src/agent/types.js';

/**
 * generate_speech / generate_video / transcribe_audio / understand_image 工具
 * （docs/design/20-conversation-media.md、25-capability-tools.md）：成功落盘
 * 或回传内容、能力缺失 → SETUP_REQUIRED、视频异步轮询到终态、素材来源解析。
 */

const identity: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'response',
};

const ctx = (signal = new AbortController().signal): ToolContext => ({
  identity,
  signal,
  terminate: () => {},
  progress: () => {},
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
  return {
    // D75: generation tools refuse read-only runs up front (covered in gateway-read-only).
    writeDenial: () => null,
    checkPath: (_identity: RunIdentity, target: string) =>
      path.resolve(target).startsWith(path.resolve(allowedPrefix))
        ? { kind: 'allowed', resolvedPath: path.resolve(target) }
        : { kind: 'forbidden', reason: '测试网关：路径越界' },
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
