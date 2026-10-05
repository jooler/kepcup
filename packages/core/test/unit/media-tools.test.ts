import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { buildSpeechTools } from '../../src/tools/speech-tools.js';
import { TOOL_SETUP_REQUIRED } from '../../src/tools/image-tools.js';
import type { MediaToolFacade } from '../../src/tools/image-tools.js';
import type { RunIdentity, ToolContext } from '../../src/agent/types.js';

/**
 * generate_speech / generate_video 工具（docs/design/20-conversation-media.md）：
 * 成功落盘 .generated/、能力缺失 → SETUP_REQUIRED、视频异步轮询到终态。
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
    synthesizeSpeech: async () => ({ audioBase64: 'aGVsbG8=', mimeType: 'audio/mpeg' }),
    generateVideo: async () => ({ provider: 'volcengine', taskId: 'task_1' }),
    videoStatus: async () => ({ status: 'succeeded', videoUrl: 'https://example.invalid/v.mp4' }),
    ...overrides,
  };
}

const root = mkdtempSync(path.join(tmpdir(), 'speech-tools-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('generate_speech', () => {
  it('成功：字节落盘 workspace/.generated 并返回路径', async () => {
    const workspace = path.join(root, 'ws1');
    const tools = buildSpeechTools({ identity, media: facade({}), workspacePath: workspace });
    const speech = tools.find((tool) => tool.name === 'generate_speech')!;
    const result = await speech.execute({ text: '你好', file_name: 'greeting' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('greeting.mp3');
    const saved = readFileSync(path.join(workspace, '.generated', 'greeting.mp3'));
    expect(saved.toString()).toBe('hello');
  });

  it('能力缺失 → SETUP_REQUIRED 错误码', async () => {
    const tools = buildSpeechTools({
      identity,
      media: facade({
        synthesizeSpeech: async () => {
          throw new AppError('CAPABILITY_NOT_CONFIGURED', '未配置 tts');
        },
      }),
      workspacePath: path.join(root, 'ws2'),
    });
    const speech = tools.find((tool) => tool.name === 'generate_speech')!;
    const result = await speech.execute({ text: '你好' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(TOOL_SETUP_REQUIRED);
  });

  it('厂商失败照常作为普通失败结果', async () => {
    const tools = buildSpeechTools({
      identity,
      media: facade({
        synthesizeSpeech: async () => {
          throw new AppError('PROVIDER_UNAVAILABLE', '厂商抽风');
        },
      }),
      workspacePath: path.join(root, 'ws3'),
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
    const tools = buildSpeechTools({
      identity,
      media: facade({
        videoStatus: async () => {
          polls += 1;
          return polls === 1
            ? { status: 'queued' }
            : { status: 'succeeded', videoUrl: 'https://example.invalid/v.mp4' };
        },
      }),
      workspacePath: workspace,
      videoPollIntervalMs: 5,
    });
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
    const tools = buildSpeechTools({
      identity,
      media: facade({
        videoStatus: async () => ({ status: 'failed', error: '内容审核未通过' }),
      }),
      workspacePath: path.join(root, 'ws5'),
    });
    const video = tools.find((tool) => tool.name === 'generate_video')!;
    const result = await video.execute({ prompt: 'x' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain('内容审核未通过');
  });

  it('未配置能力 → SETUP_REQUIRED', async () => {
    const tools = buildSpeechTools({
      identity,
      media: facade({
        generateVideo: async () => {
          throw new AppError('CAPABILITY_NOT_CONFIGURED', '未配置 video');
        },
      }),
      workspacePath: path.join(root, 'ws6'),
    });
    const video = tools.find((tool) => tool.name === 'generate_video')!;
    const result = await video.execute({ prompt: 'x' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(TOOL_SETUP_REQUIRED);
  });
});
