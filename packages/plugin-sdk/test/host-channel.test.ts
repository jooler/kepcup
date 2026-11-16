import { describe, expect, it } from 'vitest';
import { connectHostApiChannel } from '../src/host-channel.js';

/**
 * 宿主 API 通道（D125 P2，61 §4）：插件侧代理把 host.net / secrets / storage 编码成
 * `host-api` 信封，并自动回宿主的看门狗 ping。宿主侧裁决在 core（plugin-bridge.test.ts），
 * 这里验证插件侧编码 / 解码 / 错误传播。
 */

interface FakeIpc {
  sent: Array<Record<string, unknown>>;
  emit(message: unknown): void;
  send(message: Record<string, unknown>): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  off(event: 'message', listener: (...args: unknown[]) => void): void;
}

function makeIpc(): FakeIpc {
  const listeners: Array<(message: unknown) => void> = [];
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    emit: (message) => {
      for (const listener of [...listeners]) listener(message);
    },
    send: (message) => {
      sent.push(message);
    },
    on: (_event, listener) => {
      listeners.push(listener);
    },
    off: (_event, listener) => {
      const index = listeners.indexOf(listener as (message: unknown) => void);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

/** 应答下一个请求（请求入参 + 自动回包）。 */
function respond(
  ipc: FakeIpc,
  handler: (request: Record<string, unknown>) => Record<string, unknown>,
): void {
  const request = [...ipc.sent].reverse().find((message) => message['type'] === 'host-api');
  expect(request).toBeDefined();
  ipc.emit({
    type: 'host-api-response',
    requestId: request!['requestId'],
    ok: true,
    value: handler(request!),
  });
}

describe('connectHostApiChannel（插件侧 Host API 代理）', () => {
  it('net.fetch：编码请求（文本 / base64 请求体）、解码文本响应', async () => {
    const ipc = makeIpc();
    const channel = connectHostApiChannel(ipc as never);
    const pending = channel.net.fetch('https://example.invalid/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    respond(ipc, (request) => {
      expect(request).toMatchObject({
        api: 'net.fetch',
        url: 'https://example.invalid/x',
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
      });
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/json' },
        bodyText: '{"ok":true}',
      };
    });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    channel.dispose();
  });

  it('net.fetch：二进制 body → bodyBase64；二进制响应 → arrayBuffer 解码', async () => {
    const ipc = makeIpc();
    const channel = connectHostApiChannel(ipc as never);
    const body = new Uint8Array([1, 2, 3]);
    const pending = channel.net.fetch('https://example.invalid/bin', { body });
    respond(ipc, (request) => {
      expect(request['init']).toMatchObject({ bodyBase64: 'AQID' });
      return {
        status: 200,
        ok: true,
        headers: {},
        bodyBase64: Buffer.from([9, 8, 7]).toString('base64'),
      };
    });
    const response = await pending;
    expect(Array.from(await response.arrayBuffer())).toEqual([9, 8, 7]);
    channel.dispose();
  });

  it('secrets.get / storage.*：值往返；错误信封 → 带 code 的 Error', async () => {
    const ipc = makeIpc();
    const channel = connectHostApiChannel(ipc as never);
    const secret = channel.secrets.get('plugin:x:instance:i:k');
    respond(ipc, () => ({ value: 'sk-1' }));
    await expect(secret).resolves.toBe('sk-1');

    const set = channel.storage.set('k', { a: 1 });
    respond(ipc, () => ({ ok: true }));
    await expect(set).resolves.toBeUndefined();

    const get = channel.storage.get('k');
    respond(ipc, () => ({ value: { a: 1 } }));
    await expect(get).resolves.toEqual({ a: 1 });

    const list = channel.storage.list('pro');
    respond(ipc, () => ({ keys: ['pro-a'] }));
    await expect(list).resolves.toEqual(['pro-a']);

    const del = channel.storage.delete('k');
    respond(ipc, () => ({ ok: true }));
    await expect(del).resolves.toBeUndefined();

    const failing = channel.storage.get('bad');
    const request = [...ipc.sent].reverse().find((message) => message['type'] === 'host-api');
    ipc.emit({
      type: 'host-api-response',
      requestId: request?.['requestId'],
      ok: false,
      code: 'INVALID_INPUT',
      message: '只能读取本插件的实例密钥',
    });
    await expect(failing).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    channel.dispose();
  });

  it('看门狗 ping：通道立即回 pong；非通道信封不被当成请求处理', () => {
    const ipc = makeIpc();
    const channel = connectHostApiChannel(ipc as never);
    expect(channel.isChannelMessage({ type: 'host-api', requestId: 'p1', api: 'ping' })).toBe(true);
    expect(
      channel.isChannelMessage({ type: 'ready', hostApiVersion: 1, contracts: ['media'] }),
    ).toBe(false);
    ipc.emit({ type: 'host-api', requestId: 'ping-1', api: 'ping' });
    // D125 P4：pong 顺带自报 RSS（宿主 >512MB 记 warn 的观测项）。
    expect(ipc.sent.at(-1)).toMatchObject({
      type: 'host-api-response',
      requestId: 'ping-1',
      ok: true,
      value: { pong: true, rssBytes: expect.any(Number) },
    });
    channel.dispose();
  });

  it('dispose：挂起请求以「通道已关闭」拒绝', async () => {
    const ipc = makeIpc();
    const channel = connectHostApiChannel(ipc as never);
    const pending = channel.net.fetch('https://example.invalid/slow');
    channel.dispose();
    await expect(pending).rejects.toThrow(/通道已关闭/);
  });
});
