import { describe, expect, it } from 'vitest';
import {
  PLUGIN_RUNTIME_ERROR_CODES,
  PLUGIN_RUNTIME_HOST_API_VERSION,
  PLUGIN_RUNTIME_MAX_INIT_INSTANCES,
  isPluginHostApiRequest,
  pluginManifestSchema,
  pluginRuntimeEventFrameSchema,
  pluginRuntimeHostToPluginFrameSchema,
  pluginRuntimePluginToHostFrameSchema,
  pluginRuntimeProgressPayloadSchema,
  pluginRuntimeReadyFrameSchema,
  pluginRuntimeStateFrameSchema,
  safeParseFrame,
  type PluginRuntimeFrame,
} from '../../src/index.js';

/**
 * 插件运行时 IPC 协议（D125 P1，docs/design/61-plugin-runtime-platform.md §3.2）：
 * 帧判别联合（init / ready / invoke / cancel / shutdown / result / error / event /
 * state）与 manifest `runtime` 段。P1 纯契约——进程管理、能力桥与错误码的运行时
 * 消费归 P2。全部对象 strictObject：未知帧 / 未知字段必须被拒。
 */

const digest = 'a'.repeat(64);

const frames: PluginRuntimeFrame[] = [
  {
    type: 'init',
    hostApiVersion: PLUGIN_RUNTIME_HOST_API_VERSION,
    manifestDigest: digest,
    instances: [{ instanceId: 'pli_one', fields: { apiKey: 'k-123' } }],
  },
  {
    type: 'invoke',
    callId: 'call-1',
    contract: 'media',
    method: 'generateImage',
    params: { prompt: '一只猫', size: '1024x1024' },
    context: {
      entryId: 'reference-image',
      model: 'reference-image-1',
      locale: 'zh-CN',
      credentials: { apiKey: 'k-123' },
      params: { size: '1024x1024' },
    },
  },
  { type: 'cancel', callId: 'call-1' },
  { type: 'shutdown' },
  {
    type: 'ready',
    hostApiVersion: 1,
    contracts: ['media'],
    features: ['invoke.context.instanceId'],
  },
  { type: 'result', callId: 'call-1', output: { images: [{ url: 'data:image/png;base64,x' }] } },
  { type: 'error', callId: 'call-1', code: 'PROVIDER_UNAVAILABLE', message: '厂商超时' },
  // 连接级错误（握手版本不匹配）：没有 callId 可回显。
  { type: 'error', code: 'PLUGIN_UPGRADE_REQUIRED', message: 'Host API 版本不匹配' },
  {
    type: 'event',
    callId: 'call-1',
    kind: 'progress',
    payload: { phase: 'generating', percent: 42, message: '生成中' },
  },
  { type: 'event', callId: 'call-1', kind: 'log', payload: { level: 'warn', message: '重试' } },
  { type: 'state', status: 'busy' },
  { type: 'state', status: 'error', detail: '磁盘配额用尽' },
];

describe('plugin runtime protocol frames (D125 P1)', () => {
  it('round-trips every frame type (parse output deep-equals the frame)', () => {
    for (const frame of frames) {
      expect(safeParseFrame(frame)).toEqual({ success: true, data: frame });
    }
  });

  it('exposes the frame sets as discriminated unions over `type`', () => {
    const hostToPlugin = new Set(['init', 'invoke', 'cancel', 'shutdown']);
    const pluginToHost = new Set(['ready', 'result', 'error', 'event', 'state']);
    for (const frame of frames) {
      expect(hostToPlugin.has(frame.type) || pluginToHost.has(frame.type)).toBe(true);
      expect(pluginRuntimeHostToPluginFrameSchema.safeParse(frame).success).toBe(
        hostToPlugin.has(frame.type),
      );
      expect(pluginRuntimePluginToHostFrameSchema.safeParse(frame).success).toBe(
        pluginToHost.has(frame.type),
      );
    }
  });

  it('rejects unknown frame types and unknown fields (strictObject everywhere)', () => {
    expect(safeParseFrame({ type: 'hello' }).success).toBe(false);
    expect(safeParseFrame({ type: 'shutdown', extra: 1 }).success).toBe(false);
    expect(
      safeParseFrame({ type: 'invoke', callId: 'c', contract: 'media', method: 'm' }).success,
    ).toBe(false);
    // event 载荷形状与 kind 绑定：progress 载荷不允许带 log 字段。
    expect(
      pluginRuntimeEventFrameSchema.safeParse({
        type: 'event',
        callId: 'c',
        kind: 'progress',
        payload: { level: 'info', message: 'x' },
      }).success,
    ).toBe(false);
  });

  it('rejects malformed frame bodies (callId / digest / bounds / status enum)', () => {
    expect(
      safeParseFrame({ type: 'init', hostApiVersion: 1, manifestDigest: 'zz', instances: [] })
        .success,
    ).toBe(false);
    expect(
      safeParseFrame({
        type: 'invoke',
        callId: '',
        contract: 'media',
        method: 'generateImage',
        params: {},
        context: {
          entryId: 'e',
          model: 'm',
          locale: 'zh-CN',
          credentials: {},
          params: {},
        },
      }).success,
    ).toBe(false);
    // 清单的 PLUGIN_MAX_INSTANCES（4）是实例 kind 上限，不是账号数：5 个账号实例是
    // 合法握手（D125 收口审查修复——旧 schema 复用清单常量会让第 5 个实例起不来）。
    expect(
      safeParseFrame({
        type: 'init',
        hostApiVersion: 1,
        manifestDigest: digest,
        instances: Array.from({ length: 5 }, (_, index) => ({
          instanceId: `pli_${index}`,
          fields: {},
        })),
      }).success,
    ).toBe(true);
    expect(
      safeParseFrame({
        type: 'init',
        hostApiVersion: 1,
        manifestDigest: digest,
        instances: Array.from({ length: PLUGIN_RUNTIME_MAX_INIT_INSTANCES + 1 }, () => ({
          instanceId: 'x',
          fields: {},
        })),
      }).success,
    ).toBe(false);
    expect(
      pluginRuntimeStateFrameSchema.safeParse({ type: 'state', status: 'paused' }).success,
    ).toBe(false);
    expect(pluginRuntimeProgressPayloadSchema.safeParse({ percent: 101 }).success).toBe(false);
    expect(
      safeParseFrame({
        type: 'invoke',
        callId: 'c',
        contract: 'search-provider',
        method: 'generateImage',
        params: {},
        context: { entryId: 'e', model: 'm', locale: 'zh-CN', credentials: {}, params: {} },
      }).success,
    ).toBe(false);
  });

  it('ready.features is optional (old SDK omits it) and bounded when present', () => {
    expect(
      pluginRuntimeReadyFrameSchema.safeParse({
        type: 'ready',
        hostApiVersion: 1,
        contracts: ['media'],
      }).success,
    ).toBe(true);
    expect(
      pluginRuntimeReadyFrameSchema.safeParse({
        type: 'ready',
        hostApiVersion: 1,
        contracts: ['media'],
        features: Array.from({ length: 17 }, (_, i) => `f${i}`),
      }).success,
    ).toBe(false);
  });

  it('accepts invoke.context.instanceId (D125 P4 / DEV-114) and rejects an empty value', () => {
    const base = {
      type: 'invoke',
      callId: 'c',
      contract: 'media',
      method: 'generateImage',
      params: {},
      context: {
        entryId: 'e',
        model: 'm',
        locale: 'zh-CN',
        credentials: {},
        params: {},
      },
    } as const;
    expect(
      safeParseFrame({ ...base, context: { ...base.context, instanceId: 'pli_abc' } }).success,
    ).toBe(true);
    expect(safeParseFrame({ ...base, context: { ...base.context, instanceId: '' } }).success).toBe(
      false,
    );
  });

  it('rejects invoke.context.credentials with non-string values (sensitive injection is string-only)', () => {
    expect(
      safeParseFrame({
        type: 'invoke',
        callId: 'c',
        contract: 'media',
        method: 'generateImage',
        params: {},
        context: {
          entryId: 'e',
          model: 'm',
          locale: 'zh-CN',
          credentials: { apiKey: 42 },
          params: {},
        },
      }).success,
    ).toBe(false);
    expect(
      safeParseFrame({
        type: 'invoke',
        callId: 'c',
        contract: 'media',
        method: 'generateImage',
        params: {},
        context: {
          entryId: 'e',
          model: 'm',
          locale: 'zh-CN',
          credentials: { apiKey: ['a'] },
          params: {},
        },
      }).success,
    ).toBe(false);
  });

  it('registers the runtime error codes (host-side; P2 consumes)', () => {
    expect([...PLUGIN_RUNTIME_ERROR_CODES]).toEqual([
      'PLUGIN_CRASHED',
      'PLUGIN_TIMEOUT',
      'PLUGIN_CONTRACT_VIOLATION',
      'PLUGIN_NETWORK_DENIED',
    ]);
  });
});

describe('plugin manifest runtime section (D125 P1, 61 §2)', () => {
  const baseManifest = {
    format_version: 1,
    id: 'io.kepcup/reference-media',
    name: '参考媒体插件',
    version: '1.0.0',
    usage: 'developer 试用。',
    instances: ['capability-model'],
    runtime: {
      entry: 'dist/main.js',
      hostApi: '^1',
      network: { allow: ['example.invalid', '*.example.invalid'] },
    },
    contributions: {
      capabilityModels: [
        { id: 'reference-image', capability: 'image', model: 'reference-image-1' },
      ],
    },
  } satisfies Record<string, unknown>;

  const parse = (input: unknown) => pluginManifestSchema.parse(input);

  it('accepts the runtime section as-is and defaults maxConcurrent to 1', () => {
    const manifest = parse(baseManifest);
    expect(manifest.runtime).toEqual({
      entry: 'dist/main.js',
      hostApi: '^1',
      network: { allow: ['example.invalid', '*.example.invalid'] },
      maxConcurrent: 1,
    });
    // 能力模型条目在执行型插件里不填 engine（执行逻辑来自插件自身，非 MEDIA_ENGINES）。
    expect('engine' in manifest.contributions.capabilityModels![0]!).toBe(false);
  });

  it('rejects `..` paths, absolute paths and padded entry values', () => {
    for (const entry of ['../escape.js', '/abs/main.js', 'a/../../b.js', ' dist/main.js']) {
      expect(() =>
        parse({ ...baseManifest, runtime: { ...baseManifest.runtime, entry } }),
      ).toThrow();
    }
  });

  it('rejects a missing hostApi and a non-shape network allowlist', () => {
    const { hostApi: _hostApi, ...runtimeWithoutHostApi } = baseManifest.runtime as Record<
      string,
      unknown
    >;
    expect(() => parse({ ...baseManifest, runtime: runtimeWithoutHostApi })).toThrow();
    expect(() =>
      parse({
        ...baseManifest,
        runtime: { ...baseManifest.runtime, network: { allow: ['https://example.invalid'] } },
      }),
    ).toThrow();
    expect(() =>
      parse({
        ...baseManifest,
        runtime: { ...baseManifest.runtime, network: { allow: ['ok.host', ''] } },
      }),
    ).toThrow();
  });

  it('rejects maxConcurrent outside 1..4 and non-integer values', () => {
    expect(() =>
      parse({ ...baseManifest, runtime: { ...baseManifest.runtime, maxConcurrent: 5 } }),
    ).toThrow();
    expect(() =>
      parse({ ...baseManifest, runtime: { ...baseManifest.runtime, maxConcurrent: 1.5 } }),
    ).toThrow();
  });

  it('accepts runtime.timeouts keyed by <contract>.<method> and rejects bad keys / values', () => {
    // 超时由插件按自己的厂商协议声明（DEV-130）；宿主只钳制上限。
    const ok = parse({
      ...baseManifest,
      runtime: {
        ...baseManifest.runtime,
        timeouts: { 'media.generateImage': 300_000, 'media.submitVideo': 900_000 },
      },
    });
    expect(ok.runtime?.timeouts).toEqual({
      'media.generateImage': 300_000,
      'media.submitVideo': 900_000,
    });
    for (const bad of [
      { 'media.generateImage': 500 }, // < 1s
      { 'media.generateImage': 900_001 }, // > 上限 15 分钟
      { 'media.generateImage': 1.5 }, // 非整数
      { generateImage: 60_000 }, // 缺 contract 前缀
      { 'Media.GenerateImage': 60_000 }, // 契约名必须小写
      { 'media.generate-image': 60_000 }, // 方法名不能带连字符
    ]) {
      expect(
        () => parse({ ...baseManifest, runtime: { ...baseManifest.runtime, timeouts: bad } }),
        JSON.stringify(bad),
      ).toThrow();
    }
  });

  it('accepts net.fetch init.timeoutMs within 1s..15min and rejects outside', () => {
    const frame = {
      type: 'host-api',
      requestId: 'r1',
      api: 'net.fetch',
      url: 'https://example.invalid/x',
      init: { timeoutMs: 300_000 },
    };
    expect(isPluginHostApiRequest(frame)).toBe(true);
    for (const bad of [500, 900_001, 1.5]) {
      expect(isPluginHostApiRequest({ ...frame, init: { timeoutMs: bad } }), String(bad)).toBe(
        false,
      );
    }
  });

  it('keeps runtime optional (data-shaped manifests unchanged)', () => {
    const manifest = parse({
      format_version: 1,
      id: 'com.example/plain',
      name: '普通插件',
      version: '1.0.0',
      usage: '',
      instances: ['capability-model'],
      contributions: {
        capabilityModels: [{ id: 'm', capability: 'image', model: 'm-1', engine: 'dashscope' }],
      },
    });
    expect(manifest.runtime).toBeUndefined();
  });

  it('rejects an engine-less capability entry without the runtime section (D124 data entries keep engine)', () => {
    // 执行型条目（不填 engine）必须与 `runtime` 段配对——没有 runtime 就没有执行体。
    // 这是 D124 数据型条目不受 D125 影响的关键反向保护：漏写 runtime 的执行型清单
    // 必须在 schema 层拒绝，而不是静默落进 MEDIA_ENGINES 解析链。
    expect(() =>
      parse({
        format_version: 1,
        id: 'io.kepcup/runtime-missing',
        name: '缺 runtime 的执行型清单',
        version: '1.0.0',
        usage: '',
        instances: ['capability-model'],
        contributions: {
          capabilityModels: [{ id: 'm', capability: 'image', model: 'm-1' }],
        },
      }),
    ).toThrow(/runtime/);
    // 配对成立（补上 runtime）即通过。
    expect(
      parse({
        format_version: 1,
        id: 'io.kepcup/runtime-missing',
        name: '缺 runtime 的执行型清单',
        version: '1.0.0',
        usage: '',
        instances: ['capability-model'],
        runtime: { entry: 'dist/main.js', hostApi: '^1' },
        contributions: {
          capabilityModels: [{ id: 'm', capability: 'image', model: 'm-1' }],
        },
      }).runtime,
    ).toEqual({ entry: 'dist/main.js', hostApi: '^1', maxConcurrent: 1 });
  });
});
