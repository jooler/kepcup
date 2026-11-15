import { describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_RUNTIME_HOST_API_VERSION,
  definePlugin,
  host,
  PluginInvokeError,
  runPluginRuntime,
  type HostToPluginFrame,
  type PluginFrameTransport,
  type PluginRuntimeController,
  type PluginSpec,
  type PluginToHostFrame,
} from '../src/index.js';

/**
 * 插件侧运行时客户端（D125 P1，todo P1 步骤 2.4）：对假 duplex 通道验证
 * invoke→result / cancel→AbortSignal / progress 限速（1 次/秒），以及握手与
 * fail-safe 边界（输入 / 输出契约校验、并发=1、NOT_IMPLEMENTED）。
 */

interface Harness {
  pluginToHost: PluginToHostFrame[];
  fromHost(frame: HostToPluginFrame): void;
  closeChannel(): void;
  controller: PluginRuntimeController;
}

function startClient(spec: PluginSpec): Harness {
  const pluginToHost: PluginToHostFrame[] = [];
  let frameHandler: ((frame: HostToPluginFrame) => void) | null = null;
  const closeHandlers: Array<() => void> = [];
  const transport: PluginFrameTransport = {
    send: (frame) => {
      pluginToHost.push(frame);
    },
    onFrame: (handler) => {
      frameHandler = handler;
      return () => {
        frameHandler = null;
      };
    },
    onClose: (handler) => {
      closeHandlers.push(handler);
      return () => {
        const index = closeHandlers.indexOf(handler);
        if (index >= 0) closeHandlers.splice(index, 1);
      };
    },
  };
  const controller = runPluginRuntime(spec, transport);
  return {
    pluginToHost,
    fromHost: (frame) => frameHandler?.(frame),
    closeChannel: () => closeHandlers.forEach((handler) => handler()),
    controller,
  };
}

const digest = 'a'.repeat(64);

function initFrame(overrides?: Partial<Extract<HostToPluginFrame, { type: 'init' }>>) {
  return {
    type: 'init',
    hostApiVersion: PLUGIN_RUNTIME_HOST_API_VERSION,
    manifestDigest: digest,
    instances: [{ instanceId: 'pli_one', fields: { apiKey: 'k-123' } }],
    ...overrides,
  } as Extract<HostToPluginFrame, { type: 'init' }>;
}

function invokeFrame(
  method: string,
  params: unknown,
  callId = 'call-1',
  contextOverrides: Partial<Extract<HostToPluginFrame, { type: 'invoke' }>['context']> = {},
): Extract<HostToPluginFrame, { type: 'invoke' }> {
  return {
    type: 'invoke',
    callId,
    contract: 'media',
    method,
    params,
    context: {
      entryId: 'entry-1',
      model: 'model-1',
      locale: 'zh-CN',
      credentials: { apiKey: 'k-123' },
      params: {},
      ...contextOverrides,
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function handshake(client: Harness): Promise<void> {
  client.fromHost(initFrame());
  await waitForFrame(client.pluginToHost, (frame) => frame.type === 'ready');
}

async function waitForFrame(
  frames: PluginToHostFrame[],
  predicate: (frame: PluginToHostFrame) => boolean,
): Promise<PluginToHostFrame> {
  await vi.waitFor(() => {
    expect(frames.some(predicate)).toBe(true);
  });
  return frames.find(predicate)!;
}

const ONE_BY_ONE_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

describe('plugin sdk runtime client (D125 P1)', () => {
  describe('握手 init → ready', () => {
    it('reports the implemented contracts and passes handshake context to ready()', async () => {
      const readyContexts: unknown[] = [];
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage() {
                return { images: [{ url: ONE_BY_ONE_PNG_DATA_URL }] };
              },
            },
          },
          ready(ctx) {
            readyContexts.push(ctx);
          },
        }),
      );
      client.fromHost(initFrame());
      const ready = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'ready',
      )) as Extract<PluginToHostFrame, { type: 'ready' }>;
      expect(ready).toEqual({ type: 'ready', hostApiVersion: 1, contracts: ['media'] });
      expect(readyContexts).toEqual([
        {
          hostApiVersion: 1,
          manifestDigest: digest,
          instances: [{ instanceId: 'pli_one', fields: { apiKey: 'k-123' } }],
        },
      ]);
      client.controller.stop();
    });

    it('reports an empty contracts list when the plugin implements nothing', async () => {
      const client = startClient(definePlugin({}));
      client.fromHost(initFrame());
      const ready = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'ready',
      )) as Extract<PluginToHostFrame, { type: 'ready' }>;
      expect(ready.contracts).toEqual([]);
      client.controller.stop();
    });

    it('rejects a Host API version mismatch with PLUGIN_UPGRADE_REQUIRED and shuts down', async () => {
      const client = startClient(definePlugin({}));
      client.fromHost(initFrame({ hostApiVersion: 2 }));
      const error = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'error',
      )) as Extract<PluginToHostFrame, { type: 'error' }>;
      expect(error.callId).toBeUndefined();
      expect(error.code).toBe('PLUGIN_UPGRADE_REQUIRED');
      expect(client.pluginToHost.some((frame) => frame.type === 'ready')).toBe(false);
      await client.controller.done;
    });

    it('turns a throwing ready() into a PLUGIN_CRASHED error frame', async () => {
      const client = startClient(
        definePlugin({
          ready() {
            throw new Error('配置缺失');
          },
        }),
      );
      client.fromHost(initFrame());
      const error = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'error',
      )) as Extract<PluginToHostFrame, { type: 'error' }>;
      expect(error.code).toBe('PLUGIN_CRASHED');
      expect(error.message).toContain('配置缺失');
      await client.controller.done;
    });
  });

  describe('invoke → result / error', () => {
    it('round-trips generateImage through the media contract', async () => {
      const seenContexts: unknown[] = [];
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage(ctx, _params) {
                seenContexts.push({
                  entryId: ctx.entryId,
                  model: ctx.model,
                  locale: ctx.locale,
                  params: ctx.params,
                  credentials: ctx.credentials,
                  signalAborted: ctx.signal.aborted,
                });
                return { images: [{ url: ONE_BY_ONE_PNG_DATA_URL, mimeType: 'image/png' }] };
              },
            },
          },
        }),
      );
      await handshake(client);
      client.fromHost(
        invokeFrame(
          'generateImage',
          { prompt: '一只猫', size: '1024x1024' },
          'call-1',
          { params: { style: 'anime', seed: 7 } },
        ),
      );
      const result = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'result',
      )) as Extract<PluginToHostFrame, { type: 'result' }>;
      expect(result.callId).toBe('call-1');
      expect(result.output).toEqual({
        images: [{ url: ONE_BY_ONE_PNG_DATA_URL, mimeType: 'image/png' }],
      });
      expect(seenContexts).toEqual([
        {
          entryId: 'entry-1',
          model: 'model-1',
          locale: 'zh-CN',
          params: { style: 'anime', seed: 7 },
          credentials: { apiKey: 'k-123' },
          signalAborted: false,
        },
      ]);
      client.controller.stop();
    });

    it('wraps video wire shapes: submitVideo returns the handle, videoStatus takes {taskId}', async () => {
      const seenHandles: unknown[] = [];
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async submitVideo() {
                return { taskId: 'task-9' };
              },
              async videoStatus(_ctx, handle) {
                seenHandles.push(handle);
                return { status: 'succeeded', videoUrl: 'https://example.invalid/v.mp4' };
              },
            },
          },
        }),
      );
      await handshake(client);
      // 并发 = 1：宿主串行排队，这里同样先等 submit 回来再发 videoStatus。
      client.fromHost(invokeFrame('submitVideo', { prompt: '一段视频' }, 'call-s'));
      const submit = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'result' && frame.callId === 'call-s',
      )) as Extract<PluginToHostFrame, { type: 'result' }>;
      expect(submit.output).toEqual({ taskId: 'task-9' });
      client.fromHost(invokeFrame('videoStatus', { taskId: 'task-9' }, 'call-v'));
      const status = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'result' && frame.callId === 'call-v',
      )) as Extract<PluginToHostFrame, { type: 'result' }>;
      expect(status.output).toEqual({
        status: 'succeeded',
        videoUrl: 'https://example.invalid/v.mp4',
      });
      expect(seenHandles).toEqual([{ taskId: 'task-9' }]);
      client.controller.stop();
    });

    it('maps PluginInvokeError code/message/details onto the error frame', async () => {
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage() {
                throw new PluginInvokeError('PROVIDER_AUTH_FAILED', '密钥无效', { attempt: 1 });
              },
            },
          },
        }),
      );
      await handshake(client);
      client.fromHost(invokeFrame('generateImage', { prompt: 'x' }));
      const error = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'error',
      )) as Extract<PluginToHostFrame, { type: 'error' }>;
      expect(error.callId).toBe('call-1');
      expect(error.code).toBe('PROVIDER_AUTH_FAILED');
      expect(error.message).toBe('密钥无效');
      expect(error.details).toEqual({ attempt: 1 });
      client.controller.stop();
    });

    it('falls back to PROVIDER_UNAVAILABLE for unclassified throws', async () => {
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage() {
                throw new Error('boom');
              },
            },
          },
        }),
      );
      await handshake(client);
      client.fromHost(invokeFrame('generateImage', { prompt: 'x' }));
      const error = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'error',
      )) as Extract<PluginToHostFrame, { type: 'error' }>;
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      client.controller.stop();
    });

    it('never delivers contract-violating output (fail-safe, no partial delivery)', async () => {
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage() {
                return { images: [] } as unknown as { images: Array<{ url: string }> };
              },
            },
          },
        }),
      );
      await handshake(client);
      client.fromHost(invokeFrame('generateImage', { prompt: 'x' }));
      const error = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'error',
      )) as Extract<PluginToHostFrame, { type: 'error' }>;
      expect(error.code).toBe('PLUGIN_CONTRACT_VIOLATION');
      expect(client.pluginToHost.some((frame) => frame.type === 'result')).toBe(false);
      client.controller.stop();
    });

    it('rejects invoke params that violate the media contract schema', async () => {
      const calls: unknown[] = [];
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage(_ctx, params) {
                calls.push(params);
                return { images: [{ url: 'x' }] };
              },
            },
          },
        }),
      );
      await handshake(client);
      client.fromHost(invokeFrame('generateImage', { prompt: '' }));
      const error = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'error',
      )) as Extract<PluginToHostFrame, { type: 'error' }>;
      expect(error.code).toBe('PLUGIN_CONTRACT_VIOLATION');
      expect(calls).toEqual([]);
      client.controller.stop();
    });

    it('answers NOT_IMPLEMENTED for declared-but-unimplemented methods and unknown methods', async () => {
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage() {
                return { images: [{ url: 'x' }] };
              },
            },
          },
        }),
      );
      await handshake(client);
      client.fromHost(invokeFrame('videoStatus', { taskId: 't' }, 'call-a'));
      client.fromHost(invokeFrame('teleport', {}, 'call-b'));
      const notImplemented = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'error' && frame.callId === 'call-a',
      )) as Extract<PluginToHostFrame, { type: 'error' }>;
      const unknownMethod = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'error' && frame.callId === 'call-b',
      )) as Extract<PluginToHostFrame, { type: 'error' }>;
      expect(notImplemented.code).toBe('NOT_IMPLEMENTED');
      expect(unknownMethod.code).toBe('PLUGIN_CONTRACT_VIOLATION');
      client.controller.stop();
    });

    it('enforces call concurrency of 1 (second invoke while busy is a contract violation)', async () => {
      let releaseFirst: (() => void) | null = null;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage() {
                await firstGate;
                return { images: [{ url: 'x' }] };
              },
            },
          },
        }),
      );
      await handshake(client);
      client.fromHost(invokeFrame('generateImage', { prompt: 'first' }, 'call-1'));
      client.fromHost(invokeFrame('generateImage', { prompt: 'second' }, 'call-2'));
      const busy = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'error' && frame.callId === 'call-2',
      )) as Extract<PluginToHostFrame, { type: 'error' }>;
      expect(busy.code).toBe('PLUGIN_CONTRACT_VIOLATION');
      releaseFirst!();
      const result = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'result' && frame.callId === 'call-1',
      )) as Extract<PluginToHostFrame, { type: 'result' }>;
      expect(result.output).toEqual({ images: [{ url: 'x' }] });
      client.controller.stop();
    });
  });

  describe('cancel → AbortSignal', () => {
    it('aborts host.signal for the in-flight call and the method still returns', async () => {
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage(ctx) {
                await new Promise<void>((resolve) => {
                  ctx.signal.addEventListener('abort', () => resolve(), { once: true });
                });
                return { images: [{ url: 'cancelled-but-done' }] };
              },
            },
          },
        }),
      );
      await handshake(client);
      client.fromHost(invokeFrame('generateImage', { prompt: 'x' }));
      await flushMicrotasks();
      client.fromHost({ type: 'cancel', callId: 'call-1' });
      const result = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'result',
      )) as Extract<PluginToHostFrame, { type: 'result' }>;
      expect(result.output).toEqual({ images: [{ url: 'cancelled-but-done' }] });
      client.controller.stop();
    });

    it('ignores cancel frames for unknown call ids', async () => {
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage(ctx) {
                expect(ctx.signal.aborted).toBe(false);
                return { images: [{ url: 'x' }] };
              },
            },
          },
        }),
      );
      await handshake(client);
      client.fromHost(invokeFrame('generateImage', { prompt: 'x' }));
      await flushMicrotasks();
      client.fromHost({ type: 'cancel', callId: 'some-other-call' });
      const result = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'result',
      )) as Extract<PluginToHostFrame, { type: 'result' }>;
      expect(result.callId).toBe('call-1');
      client.controller.stop();
    });
  });

  describe('progress 限速（1 次/秒）', () => {
    it('sends the first progress immediately, coalesces the rest into one trailing frame, drops it after the call ends', async () => {
      vi.useFakeTimers();
      try {
        let releaseCall: (() => void) | null = null;
        const callGate = new Promise<void>((resolve) => {
          releaseCall = resolve;
        });
        const client = startClient(
          definePlugin({
            contracts: {
              media: {
                async generateImage() {
                  host.progress({ phase: 'queued', message: '已排队' });
                  host.progress({ phase: 'generating', percent: 40, message: '旧进度' });
                  host.progress({ phase: 'generating', percent: 50, message: '生成中' });
                  await callGate; // 保持调用在途，尾随事件才有机会发出
                  return { images: [{ url: 'x' }] };
                },
              },
            },
          }),
        );
        client.fromHost(initFrame());
        await vi.advanceTimersByTimeAsync(0);
        client.fromHost(invokeFrame('generateImage', { prompt: 'x' }));
        await vi.advanceTimersByTimeAsync(0);

        const progressFrames = () =>
          client.pluginToHost.filter(
            (frame) => frame.type === 'event' && frame.kind === 'progress',
          ) as Array<Extract<PluginToHostFrame, { type: 'event'; kind: 'progress' }>>;
        // 窗口内三条只发第一条；
        expect(progressFrames()).toEqual([
          {
            type: 'event',
            callId: 'call-1',
            kind: 'progress',
            payload: { phase: 'queued', message: '已排队' },
          },
        ]);
        // 1s 边界尾随发送合并后的最新一条（调用仍在途）。
        await vi.advanceTimersByTimeAsync(1000);
        let frames = progressFrames();
        expect(frames).toHaveLength(2);
        expect(frames[1]!.payload).toEqual({ phase: 'generating', percent: 50, message: '生成中' });
        // 调用结束后：结果帧发出，且不再有尾随进度漂进下一次调用。
        releaseCall!();
        await vi.advanceTimersByTimeAsync(0);
        expect(client.pluginToHost.some((frame) => frame.type === 'result')).toBe(true);
        frames = progressFrames();
        expect(frames).toHaveLength(2);
        client.controller.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes host.log through as log event frames', async () => {
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage() {
                host.log.warn('重试厂商请求', { attempt: 2 });
                return { images: [{ url: 'x' }] };
              },
            },
          },
        }),
      );
      client.fromHost(initFrame());
      await flushMicrotasks();
      client.fromHost(invokeFrame('generateImage', { prompt: 'x' }));
      const log = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'event' && frame.kind === 'log',
      )) as Extract<PluginToHostFrame, { type: 'event'; kind: 'log' }>;
      expect(log.payload).toEqual({ level: 'warn', message: '重试厂商请求', data: { attempt: 2 } });
      client.controller.stop();
    });
  });

  describe('shutdown 与通道断开', () => {
    it('resolves done on a shutdown frame', async () => {
      const client = startClient(definePlugin({}));
      client.fromHost(initFrame());
      await flushMicrotasks();
      client.fromHost({ type: 'shutdown' });
      await client.controller.done;
    });

    it('resolves done when the channel closes', async () => {
      const client = startClient(definePlugin({}));
      client.fromHost(initFrame());
      await flushMicrotasks();
      client.closeChannel();
      await client.controller.done;
    });
  });

  describe('net / secrets / storage（P2 能力桥注入面）', () => {
    it('rejects host.net with HostApiNotConnectedError until the bridge is wired', async () => {
      const client = startClient(
        definePlugin({
          contracts: {
            media: {
              async generateImage() {
                try {
                  await host.net.fetch('https://example.invalid/x');
                  return { images: [{ url: 'x' }] };
                } catch (error) {
                  expect((error as Error).name).toBe('HostApiNotConnectedError');
                  throw error;
                }
              },
            },
          },
        }),
      );
      client.fromHost(initFrame());
      await flushMicrotasks();
      client.fromHost(invokeFrame('generateImage', { prompt: 'x' }));
      const error = (await waitForFrame(
        client.pluginToHost,
        (frame) => frame.type === 'error',
      )) as Extract<PluginToHostFrame, { type: 'error' }>;
      // SDK 未注册的异常名字不猜映射，回退 PROVIDER_UNAVAILABLE（宿主侧归一）。
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      client.controller.stop();
    });
  });
});
