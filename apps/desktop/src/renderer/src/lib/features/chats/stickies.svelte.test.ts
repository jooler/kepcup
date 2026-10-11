import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STICKIE_TEXT_MAX_CHARS } from '@kepcup/shared';

/**
 * 便签 store 的 pin 入口：选中文本与「整条消息固定」共用。落库走异步
 * RPC（失败只记日志），这里 mock 掉 core，断言乐观行与 RPC 载荷。
 */

const created: { method: string; payload: Record<string, unknown> }[] = [];

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    onEvent: () => () => undefined,
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      created.push({ method, payload });
      return { stickie: payload };
    },
  },
}));

const { stickies } = await import('./stickies.svelte');

beforeEach(() => {
  for (const item of [...stickies.items]) stickies.remove(item.id);
  created.length = 0;
});

describe('stickies.pin（整条消息固定与选中文本共用）', () => {
  it('全文乐观上屏并落库：conversation 作用域、position null、z 单调递增', () => {
    stickies.pin('第一条', 'conv_1', 'conversation');
    stickies.pin('第二条', 'conv_1', 'conversation');
    expect(stickies.items.map((item) => item.text)).toEqual(['第一条', '第二条']);
    expect(stickies.items.every((item) => item.scope === 'conversation')).toBe(true);
    expect(stickies.items.every((item) => item.position === null)).toBe(true);
    expect(stickies.items[1]!.z).toBeGreaterThan(stickies.items[0]!.z);
    expect(created.map((entry) => entry.method)).toEqual(['stickies.create', 'stickies.create']);
    expect(created[0]!.payload).toMatchObject({
      conversationId: 'conv_1',
      text: '第一条',
      scope: 'conversation',
      position: null,
    });
    expect(created[0]!.payload.id).toBe(stickies.items[0]!.id);
  });

  it(`超过便签上限（${STICKIE_TEXT_MAX_CHARS}）的整条消息在入口截断，乐观行与落库一致`, () => {
    const long = '囍'.repeat(STICKIE_TEXT_MAX_CHARS + 500);
    stickies.pin(long, 'conv_1', 'conversation');
    expect(stickies.items).toHaveLength(1);
    expect(stickies.items[0]!.text).toHaveLength(STICKIE_TEXT_MAX_CHARS);
    expect(created[0]!.payload.text).toHaveLength(STICKIE_TEXT_MAX_CHARS);
    expect(created[0]!.payload.text).toBe(stickies.items[0]!.text);
  });

  it('纯空白不钉', () => {
    stickies.pin('   \n  ', 'conv_1', 'conversation');
    expect(stickies.items).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});
