#!/usr/bin/env node
// PluginHost 集成测试夹具（D125 P2）：手写 fork IPC 协议帧与 Host API 信封。
//
// 不打 @kepcup/plugin-sdk：这里直接说九个协议帧与 host-api 信封，用来验证宿主侧
// 行为（握手 / 契约校验 / 超时 / 看门狗 / 崩溃重启 / 能力桥）。行为由
// invoke.context.model 选择（plugins/reference-media 之外的自检面）。
//
// 支持的行为：
//   ok          → 一条 progress + 一条 log + 合法 1×1 PNG
//   slow        → 50ms 后合法结果（串行队列验证：并发 invoke 报契约违规）
//   hang        → 永不返回（调用级超时）
//   abortable   → 等宿主 cancel 帧后返回（AbortSignal 联动）
//   spin        → 同步死循环（心跳看门狗）
//   crash       → process.exit(3)（崩溃 → 下次调用重启）
//   bad-output  → 非法输出（宿主侧 PLUGIN_CONTRACT_VIOLATION）
//   error-auth  → error 帧 PROVIDER_AUTH_FAILED（托管适配器透传）
//   error-quota → error 帧 PROVIDER_QUOTA（配额 / 认证分家透传）
//   net         → host.net.fetch 到 context.params.url（白名单 / SSRF）
//   storage     → host.storage set/get/list/delete 往返
//   env         → 报告 env 白名单 / cwd / execArgv（进程边界测试）
//   stderr      → 写 stderr 后返回（宿主日志收集 / 限速测试）
//   creds       → 回显注入的 credentials 键与 apiKey（调用时注入测试）
//   ctx         → 回显 invoke.context.instanceId（D125 P4 / DEV-114）
//   secret      → host.secrets.get(context.params.key)（前缀越权测试）

const ONE_BY_ONE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const CONTRACTS = ['media'];
// 目录名带 probe-legacy = 模拟旧 SDK 的 ready 帧（不带 features，宿主因此不发送
// invoke.context.instanceId）。同一份夹具，便于 D125 P4 的兼容性对照。
const LEGACY_SDK = import.meta.url.includes('probe-legacy');
let ready = false;
let busy = false;
let requestSeq = 0;
const pendingRequests = new Map();
const cancelWaiters = new Map();

process.on('message', (message) => {
  if (message === null || typeof message !== 'object') return;
  switch (message.type) {
    case 'init':
      if (message.hostApiVersion !== 1) {
        process.send({
          type: 'error',
          code: 'PLUGIN_UPGRADE_REQUIRED',
          message: `不支持的 Host API：${message.hostApiVersion}`,
        });
        return;
      }
      ready = true;
      process.send({
        type: 'ready',
        hostApiVersion: 1,
        contracts: CONTRACTS,
        ...(LEGACY_SDK ? {} : { features: ['invoke.context.instanceId'] }),
      });
      return;
    case 'invoke':
      void handleInvoke(message);
      return;
    case 'cancel':
      // 只有 abortable 模型等待 cancel；其余行为由 model 决定（探针不模拟真实取消）。
      cancelWaiters.get(message.callId)?.();
      return;
    case 'shutdown':
      process.exit(0);
      return;
    case 'host-api': {
      // 宿主发来的 ping（看门狗）：立即回 pong。
      if (message.api === 'ping') {
        process.send({
          type: 'host-api-response',
          requestId: message.requestId,
          ok: true,
          // P4 观测项：宿主从 pong 里读自报 RSS（>512MB 记 warn）。
          value: { pong: true, rssBytes: process.memoryUsage().rss },
        });
      }
      return;
    }
    case 'host-api-response': {
      const pending = pendingRequests.get(message.requestId);
      if (pending === undefined) return;
      pendingRequests.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.value);
        return;
      }
      const error = new Error(message.message);
      error.code = message.code;
      pending.reject(error);
      return;
    }
    default:
      return;
  }
});

function hostApi(payload) {
  const requestId = `probe_${++requestSeq}`;
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    process.send({ type: 'host-api', requestId, ...payload });
  });
}

function sendResult(callId, output) {
  process.send({ type: 'result', callId, output });
}

function sendError(callId, code, message) {
  process.send({ type: 'error', callId, code, message });
}

async function handleInvoke(frame) {
  if (!ready) {
    sendError(frame.callId, 'PLUGIN_CONTRACT_VIOLATION', '握手前收到 invoke');
    return;
  }
  if (busy) {
    // 宿主必须串行排队（61 §3.1）；并发的出现就是宿主队列失效。
    sendError(frame.callId, 'PLUGIN_CONTRACT_VIOLATION', '探针检测到并发 invoke');
    return;
  }
  const model = frame.context.model;
  const callId = frame.callId;
  if (model === 'crash') {
    process.exit(3);
  }
  if (model === 'spin') {
    for (;;) {
      // 同步死循环：心跳 ping 无法被处理，看门狗击杀。
    }
  }
  busy = true;
  try {
    if (model === 'hang') {
      // 保持 busy，永不返回；宿主调用级超时负责击杀。
      return;
    }
    if (model === 'abortable') {
      // 等待宿主 cancel 帧（AbortSignal 联动），收到后返回一个可区分的合法结果。
      await new Promise((resolve) => cancelWaiters.set(callId, resolve));
      cancelWaiters.delete(callId);
      sendResult(callId, {
        images: [{ url: ONE_BY_ONE_PNG_DATA_URL, mimeType: 'image/png+aborted' }],
      });
      return;
    }
    if (model === 'bad-output') {
      // 不合 imageGenerationResultSchema 的输出：宿主必须整体丢弃。
      sendResult(callId, { images: 'not-an-array' });
      return;
    }
    if (model === 'error-auth') {
      sendError(callId, 'PROVIDER_AUTH_FAILED', '探针：凭据无效');
      return;
    }
    if (model === 'error-quota') {
      sendError(callId, 'PROVIDER_QUOTA', '探针：配额不足');
      return;
    }
    if (model === 'net') {
      const url = frame.context.params?.url ?? '';
      await hostApi({ api: 'net.fetch', url });
      sendResult(callId, { images: [{ url: ONE_BY_ONE_PNG_DATA_URL, mimeType: 'image/png' }] });
      return;
    }
    if (model === 'storage') {
      await hostApi({ api: 'storage.set', key: 'probe-key', value: { hello: 'world' } });
      const got = await hostApi({ api: 'storage.get', key: 'probe-key' });
      const list = await hostApi({ api: 'storage.list', prefix: 'probe' });
      await hostApi({ api: 'storage.delete', key: 'probe-key' });
      sendResult(callId, {
        images: [
          {
            url: ONE_BY_ONE_PNG_DATA_URL,
            mimeType: `image/png+${got.value.hello}+${list.keys.length}`,
          },
        ],
      });
      return;
    }
    if (model === 'env') {
      // 进程边界：宿主 env 白名单 / cwd = 插件安装目录 / execArgv 为空。
      const leaked = process.env.PLUGIN_TEST_SECRET === undefined ? 'no-secret' : 'leaked';
      sendResult(callId, {
        images: [
          {
            url: ONE_BY_ONE_PNG_DATA_URL,
            mimeType: `image/png+${leaked}+${process.cwd()}+${process.execArgv.length}`,
          },
        ],
      });
      return;
    }
    if (model === 'stderr') {
      process.stderr.write('探针 stderr 输出\n');
      sendResult(callId, { images: [{ url: ONE_BY_ONE_PNG_DATA_URL }] });
      return;
    }
    if (model === 'creds') {
      const credentials = frame.context.credentials ?? {};
      const keys = Object.keys(credentials).sort().join(',');
      sendResult(callId, {
        images: [
          {
            url: ONE_BY_ONE_PNG_DATA_URL,
            mimeType: `image/png+${keys}+${credentials.apiKey ?? ''}`,
          },
        ],
      });
      return;
    }
    if (model === 'ctx') {
      sendResult(callId, {
        images: [
          {
            url: ONE_BY_ONE_PNG_DATA_URL,
            mimeType: `image/png+${frame.context.instanceId ?? ''}`,
          },
        ],
      });
      return;
    }
    if (model === 'secret') {
      const want = frame.context.params?.key ?? '';
      try {
        const got = await hostApi({ api: 'secrets.get', key: want });
        sendResult(callId, {
          images: [
            { url: ONE_BY_ONE_PNG_DATA_URL, mimeType: `image/png+ok+${got.value ?? 'null'}` },
          ],
        });
      } catch (error) {
        sendError(callId, error.code ?? 'PROVIDER_UNAVAILABLE', String(error.message ?? error));
      }
      return;
    }
    if (model === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    process.send({
      type: 'event',
      callId,
      kind: 'progress',
      payload: { phase: 'queued', percent: 10, message: '探针已排队' },
    });
    process.send({
      type: 'event',
      callId,
      kind: 'log',
      payload: { level: 'info', message: '探针日志', data: { model } },
    });
    sendResult(callId, { images: [{ url: ONE_BY_ONE_PNG_DATA_URL, mimeType: 'image/png' }] });
  } catch (error) {
    sendError(callId, error.code ?? 'PROVIDER_UNAVAILABLE', String(error.message ?? error));
  } finally {
    busy = false;
  }
}
