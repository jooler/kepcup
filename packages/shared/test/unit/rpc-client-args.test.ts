import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRpcClient } from '../../src/rpc/client.js';
import type { RpcTransport } from '../../src/rpc/transport.js';

/**
 * 无参调用的线上参数组（D102 修复）：birpc `$call(method, undefined)` 发出
 * `a: [undefined]`，JSON 线（WebSocket / 中转）序列化成 `[null]`，z.void() 拒绝
 * null——一切 JSON 传输上的 void 方法全部 INVALID_INPUT（桌面 MessagePort 结构
 * 化克隆保真 undefined，从未暴露）。修复：无参调用发空参数组。
 */

describe('createRpcClient 无参调用', () => {
  it('void 输入发 a: []（而非 [undefined]→[null]），z.void() 服务端可接受', async () => {
    const posted: unknown[] = [];
    let deliver: ((data: unknown) => void) | null = null;
    const transport: RpcTransport = {
      post: (data) => {
        // JSON 线语义：过一遍 stringify/parse 再断言形状。
        const wire = JSON.parse(JSON.stringify(data)) as { t: string; i: string; a: unknown[] };
        posted.push(wire);
        // 服务端语义：birpc 以 fn.apply(rpc, a) 分发，首个参数喂 z.void()。
        const input = z.void().safeParse(wire.a[0]);
        void deliver?.({
          t: 's',
          i: wire.i,
          ...(input.success ? { r: 'void-ok' } : { e: { message: 'INVALID_INPUT' } }),
        });
      },
      onData: (handler) => {
        deliver = handler;
        return () => {};
      },
      close: () => {},
    };
    const client = createRpcClient({ transport });
    await expect(client.call('settings.get')).resolves.toBe('void-ok');
    expect(posted).toHaveLength(1);
    expect((posted[0] as { a: unknown[] }).a).toEqual([]);
  });

  it('带参调用不受影响（参数原样透传）', async () => {
    let deliver: ((data: unknown) => void) | null = null;
    const seen: unknown[] = [];
    const transport: RpcTransport = {
      post: (data) => {
        const wire = JSON.parse(JSON.stringify(data)) as { t: string; i: string; a: unknown[] };
        seen.push(wire.a[0]);
        void deliver?.({ t: 's', i: wire.i, r: 'ok' });
      },
      onData: (handler) => {
        deliver = handler;
        return () => {};
      },
      close: () => {},
    };
    const client = createRpcClient({ transport });
    await expect(client.call('conversations.get', { conversationId: 'c1' })).resolves.toBe('ok');
    expect(seen).toEqual([{ conversationId: 'c1' }]);
  });
});
