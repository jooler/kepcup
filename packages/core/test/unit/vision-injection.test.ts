import { describe, expect, it } from 'vitest';
import { buildUserMessageContent } from '../../src/agent/pi-engine.js';
import { stripImageBlocks } from '../../src/dispatch/orchestrator.js';

/**
 * 视觉注入（docs/design/20-conversation-media.md）：触发批图片按模型能力
 * 组装 content blocks；run_steps 的 request 记录对 image block 脱敏占位。
 */

describe('buildUserMessageContent', () => {
  const images = [{ mimeType: 'image/png', base64: 'aGk=' }];

  it('无图片：原样返回文本', () => {
    expect(buildUserMessageContent('hello', undefined, true)).toBe('hello');
    expect(buildUserMessageContent('hello', [], true)).toBe('hello');
  });

  it('支持视觉：text + image blocks', () => {
    const content = buildUserMessageContent('看这张图', images, true) as Array<
      Record<string, unknown>
    >;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: '看这张图' });
    expect(content[1]).toEqual({ type: 'image', data: 'aGk=', mimeType: 'image/png' });
  });

  it('空文本（纯附件）：不产生空 text block（部分厂商对空文本块 400）', () => {
    for (const acceptsImages of [true, false]) {
      const content = buildUserMessageContent('', images, acceptsImages) as Array<
        Record<string, unknown>
      >;
      expect(
        content.some(
          (block) =>
            block['type'] === 'text' &&
            typeof block['text'] === 'string' &&
            block['text'].length === 0,
        ),
      ).toBe(false);
    }
    const vision = buildUserMessageContent('', images, true) as Array<Record<string, unknown>>;
    expect(vision[0]).toEqual({ type: 'image', data: 'aGk=', mimeType: 'image/png' });
    const fallback = buildUserMessageContent('', images, false) as Array<Record<string, unknown>>;
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('不支持图像输入'),
    });
  });

  it('不支持视觉：字节丢弃，追加提示文本', () => {
    const content = buildUserMessageContent('看这张图', images, false) as Array<
      Record<string, unknown>
    >;
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: 'text', text: expect.stringContaining('不支持图像输入') });
    expect(JSON.stringify(content)).not.toContain('aGk=');
  });
});

describe('stripImageBlocks（run_steps.request 脱敏）', () => {
  const payload = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', data: 'QUJD', mimeType: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      },
    ],
    tools: [{ name: 'web_search' }],
  };

  it('image block 替换为占位（保留 mime 与体量，去掉 base64）', () => {
    const stripped = stripImageBlocks(payload) as typeof payload & {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const block = stripped.messages[0]!.content[1]!;
    expect(block['type']).toBe('image');
    expect(block['data']).toBeUndefined();
    expect(block['mimeType']).toBe('image/png');
    // base64 'QUJD' (4 chars) ≈ 3 bytes。
    expect(block['approxBytes']).toBe(3);
    expect(JSON.stringify(stripped)).not.toContain('QUJD');
    // 文本与其余结构原样保留。
    expect(stripped.messages[0]!.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(stripped.tools).toEqual([{ name: 'web_search' }]);
  });

  it('无图片的 payload 原样通过', () => {
    expect(stripImageBlocks({ a: 1, b: ['x'] })).toEqual({ a: 1, b: ['x'] });
  });
});
