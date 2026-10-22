import { describe, expect, it } from 'vitest';
import { McpAbortError } from '@earendil-works/pi-mcp';
import { SseTransport } from '../../src/mcp/sse-transport.js';

/**
 * pi-mcp 1.4 的 `McpTransport.send` 增加可选 `signal`：取消只影响本次
 * dispatch，不能把 transport 标记为关闭（否则上层会误重连）。
 */

function endpointResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: endpoint\ndata: /messages?sessionId=s1\n\n'));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeTransport() {
  const posts: Array<{ url: string; init: RequestInit | undefined }> = [];
  let onPost: (init: RequestInit | undefined) => Promise<Response> = async () =>
    new Response(null, { status: 202 });
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    if (init?.method === 'GET') return endpointResponse();
    posts.push({ url: String(input), init });
    return onPost(init);
  };
  const transport = new SseTransport({ url: 'http://127.0.0.1:1/sse', fetch: fetchImpl });
  return {
    transport,
    posts,
    setPostHandler(handler: (init: RequestInit | undefined) => Promise<Response>) {
      onPost = handler;
    },
  };
}

const MESSAGE = { jsonrpc: '2.0' as const, id: 1, method: 'ping' };

describe('SseTransport.send cancellation', () => {
  it('sends normally when no signal is given', async () => {
    const { transport, posts } = makeTransport();
    await transport.start();
    await transport.send(MESSAGE);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('http://127.0.0.1:1/messages?sessionId=s1');
    expect(posts[0]!.init?.body).toBe(JSON.stringify(MESSAGE));
    await transport.close();
  });

  it('throws McpAbortError before dispatch when the signal is already aborted', async () => {
    const { transport, posts } = makeTransport();
    await transport.start();
    const controller = new AbortController();
    controller.abort();
    await expect(transport.send(MESSAGE, { signal: controller.signal })).rejects.toBeInstanceOf(
      McpAbortError,
    );
    expect(posts).toHaveLength(0);
    // The transport stays usable after a cancelled dispatch.
    await transport.send(MESSAGE);
    expect(posts).toHaveLength(1);
    await transport.close();
  });

  it('aborts an in-flight dispatch without closing the transport', async () => {
    const { transport, posts, setPostHandler } = makeTransport();
    await transport.start();
    setPostHandler(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const sending = transport.send(MESSAGE, { signal: controller.signal });
    controller.abort();
    await expect(sending).rejects.toBeDefined();
    expect(posts).toHaveLength(1);

    // Not closed: a later dispatch still goes out.
    setPostHandler(async () => new Response(null, { status: 202 }));
    await transport.send(MESSAGE);
    expect(posts).toHaveLength(2);
    await transport.close();
  });
});
