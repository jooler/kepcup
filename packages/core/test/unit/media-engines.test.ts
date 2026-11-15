import { describe, expect, it } from 'vitest';
import { pluginManifestSchema } from '@kepcup/shared';
import { MEDIA_ENGINES, mediaEngineIds } from '../../src/media/engines.js';
import { dashscopeAdapter } from '../../src/media/adapters/dashscope.js';
import { openAICompatibleAdapter } from '../../src/media/adapters/openai-compatible.js';
import { volcengineAdapter } from '../../src/media/adapters/volcengine.js';
import { CAPABILITY_KINDS, capabilityKindOf, capabilityModelKind } from '../../src/plugins/kinds.js';
import { CapabilityModelsProjector } from '../../src/plugins/projectors/capability-models.js';
import type { PluginProjectorsDeps } from '../../src/plugins/projectors/index.js';

const noopLogger = { info() {}, warn() {}, error() {} };

const deps = {
  skills: { skills: {}, logger: noopLogger },
  mcp: { settings: {}, mcpb: {}, mcp: {}, disconnector: {}, revokeMcpServerChanges: () => {}, logger: noopLogger },
  connectors: { catalog: {}, connectionStore: {}, disconnector: {}, connections: {}, events: {}, logger: noopLogger },
} as never as PluginProjectorsDeps;

const emptyManifest = pluginManifestSchema.parse({
  format_version: 1,
  id: 'io.a/b',
  name: 'x',
  version: '1.0.0',
  usage: '启用即可使用。',
  instances: ['mcp'],
});

const dashscopeManifest = pluginManifestSchema.parse({
  format_version: 1,
  id: 'io.a/b',
  name: 'x',
  version: '1.0.0',
  usage: '启用即可使用。',
  instances: ['capability-model'],
  contributions: {
    capabilityModels: [
      { id: 'qwen-image', capability: 'image', model: 'qwen-image', engine: 'dashscope' },
      { id: 'ark-image', capability: 'image', model: 'doubao-seedream', engine: 'volcengine-ark' },
      { id: 'ark-video', capability: 'video', model: 'doubao-seedance', engine: 'volcengine-ark' },
    ],
  },
});

describe('MEDIA_ENGINES 引擎注册表（D124）', () => {
  it('首批恰好三个引擎：dashscope / volcengine-ark / openai-compatible', () => {
    expect(mediaEngineIds().sort()).toEqual(['dashscope', 'openai-compatible', 'volcengine-ark']);
    expect(Object.keys(MEDIA_ENGINES).sort()).toEqual(
      ['dashscope', 'openai-compatible', 'volcengine-ark'].sort(),
    );
  });

  it('adapter 是现有适配器对象原样注册（行为零变化），VendorAdapter 契约不变', () => {
    expect(MEDIA_ENGINES['dashscope']?.adapter).toBe(dashscopeAdapter);
    expect(MEDIA_ENGINES['volcengine-ark']?.adapter).toBe(volcengineAdapter);
    expect(MEDIA_ENGINES['openai-compatible']?.adapter).toBe(openAICompatibleAdapter);
    // 契约冻结：七方法形状仍在（embed 必选 + 视频三件套可选存在）。
    expect(typeof dashscopeAdapter.embed).toBe('function');
    expect(typeof dashscopeAdapter.generateImage).toBe('function');
    expect(typeof dashscopeAdapter.submitVideo).toBe('function');
    expect(typeof openAICompatibleAdapter.embed).toBe('function');
    expect(openAICompatibleAdapter.generateImage).toBeUndefined();
  });

  it('capabilities 与 VENDOR_DESCRIPTORS 能力矩阵一致；openai-compatible 仅 embedding', () => {
    expect(MEDIA_ENGINES['dashscope']?.capabilities).toEqual(
      expect.arrayContaining(['image', 'tts', 'asr', 'video', 'multimodal', 'embedding', 'rerank']),
    );
    expect(MEDIA_ENGINES['volcengine-ark']?.capabilities).toEqual(
      expect.arrayContaining(['image', 'video', 'multimodal', 'embedding']),
    );
    expect(MEDIA_ENGINES['openai-compatible']?.capabilities).toEqual(['embedding']);
  });

  it('credentialFields：apiKey 必填敏感；baseUrl 覆盖默认可空（openai-compatible 必填）', () => {
    for (const id of ['dashscope', 'volcengine-ark', 'openai-compatible'] as const) {
      const fields = MEDIA_ENGINES[id]!.credentialFields;
      const apiKey = fields.find((field) => field.key === 'apiKey');
      expect(apiKey).toMatchObject({ required: true, sensitive: true, type: 'string' });
      expect(fields.every((field) => field.title.length > 0)).toBe(true);
    }
    expect(MEDIA_ENGINES['dashscope']?.credentialFields.find((f) => f.key === 'baseUrl')).toMatchObject({
      required: false,
      sensitive: false,
    });
    expect(MEDIA_ENGINES['openai-compatible']?.credentialFields.find((f) => f.key === 'baseUrl')).toMatchObject({
      required: true,
      sensitive: false,
    });
  });

  it('vendor 路由键与厂商映射一致（openai-compatible 为 custom）', () => {
    expect(MEDIA_ENGINES['dashscope']?.vendor).toBe('dashscope');
    expect(MEDIA_ENGINES['volcengine-ark']?.vendor).toBe('volcengine');
    expect(MEDIA_ENGINES['openai-compatible']?.vendor).toBe('custom');
  });
});

describe('capabilityModelKind（CAPABILITY_KINDS 追加末位）', () => {
  it('投影顺序 skill → mcp → connector → mail → im → capability-model（末位）', () => {
    expect(CAPABILITY_KINDS.map((adapter) => adapter.kind)).toEqual([
      'skill',
      'mcp',
      'connector',
      'mail',
      'im',
      'capability-model',
    ]);
    // 固定契约具名常量（README「固定契约」）：capabilityModelKind 即末位适配器本体。
    expect(CAPABILITY_KINDS[CAPABILITY_KINDS.length - 1]).toBe(capabilityModelKind);
  });

  it('hasInstances: true；instanceFields = 条目引擎凭据字段并集去重（保序：条目声明序）', () => {
    const adapter = capabilityKindOf('capability-model');
    expect(adapter.hasInstances).toBe(true);
    expect(adapter.hasContribution(dashscopeManifest)).toBe(true);
    expect(adapter.hasContribution(emptyManifest)).toBe(false);
    // dashscope 与 volcengine-ark 的 apiKey 字段同名：去重保序，只出现一次。
    const fields = adapter.instanceFields(dashscopeManifest);
    expect(fields.map((field) => field.key)).toEqual(['apiKey', 'baseUrl']);
    expect(adapter.instanceFields(emptyManifest)).toEqual([]);
  });

  it('capability-model 投影器可按注册表构造且只记账（unproject 幂等）', () => {
    const projectors = CAPABILITY_KINDS.map((adapter) => adapter.createProjector(deps));
    expect(projectors[projectors.length - 1]).toBeInstanceOf(CapabilityModelsProjector);
  });
});
