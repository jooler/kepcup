import { describe, expect, it } from 'vitest';
import {
  PLUGIN_INSTANCE_KINDS,
  PLUGIN_MAX_CAPABILITY_MODELS,
  botRuntimeSchema,
  capabilityEntryRefSchema,
  capabilityModelEntrySchema,
  pluginManifestSchema,
  type CapabilityModelEntry,
} from '../../src/index.js';

/**
 * 能力模型插件契约（D124，docs/design/60-capability-model-plugins.md §2/§3）：清单
 * `contributions.capabilityModels` 条目（一个模型一条）、`'capability-model'` 实例
 * kind 与 Bot 运行时 `capability_entries` 软引用。P1 纯契约——引擎注册表校验、解析
 * 链与 RPC 归 P2/P3。
 */

const imageEntry = {
  id: 'qwen-image',
  capability: 'image',
  model: 'qwen-image-2.0',
  engine: 'dashscope',
} satisfies CapabilityModelEntry;

const baseManifest = {
  format_version: 1,
  id: 'com.example/media-models',
  name: '媒体模型',
  version: '1.0.0',
  usage: '启用后在插件详情添加厂商账号实例。',
  instances: ['capability-model'],
  contributions: {
    skills: [],
    connectors: [],
    mcp: [],
    mail: [],
    im: [],
    capabilityModels: [imageEntry],
  },
} satisfies Record<string, unknown>;

const parse = (input: unknown) => pluginManifestSchema.parse(input);

describe('capability model manifest contract (D124)', () => {
  it('accepts the minimal manifest (one image entry + instances kind) and keeps optional fields absent', () => {
    const manifest = parse(baseManifest);
    expect(manifest.instances).toEqual(['capability-model']);
    const entry = manifest.contributions.capabilityModels?.[0];
    expect(entry).toEqual(imageEntry);
    expect('displayName' in entry!).toBe(false);
    expect('params' in entry!).toBe(false);
    expect('instance' in entry!).toBe(false);
  });

  it('accepts a full entry with params / instance / displayName / description', () => {
    const manifest = parse({
      ...baseManifest,
      contributions: {
        ...baseManifest.contributions,
        capabilityModels: [
          {
            ...imageEntry,
            displayName: 'Qwen-Image 图片生成',
            description: '文生图 / 图生图',
            params: { size: '1024x1024', watermark: false },
            instance: 'pli_abc123456789',
          },
        ],
      },
    });
    expect(manifest.contributions.capabilityModels?.[0]?.params).toEqual({
      size: '1024x1024',
      watermark: false,
    });
  });

  it('rejects declaring entries without instances: [capability-model]', () => {
    // 带一个技能贡献避免「至少一类贡献」先触发——这里只应命中配对规则本身。
    const result = pluginManifestSchema.safeParse({
      ...baseManifest,
      instances: undefined,
      contributions: {
        ...baseManifest.contributions,
        skills: [{ dir: 'skills/docx' }],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['contributions', 'capabilityModels']);
      expect(result.error.issues[0]?.message).toContain('capability-model');
    }
    // 纯能力模型清单（无任何其他贡献）缺 instances：同样拒绝（两处都会报）。
    expect(
      pluginManifestSchema.safeParse({ ...baseManifest, instances: undefined }).success,
    ).toBe(false);
  });

  it('rejects duplicate entry ids (points at the offending index); the id charset is lowercase-only', () => {
    const result = pluginManifestSchema.safeParse({
      ...baseManifest,
      contributions: {
        ...baseManifest.contributions,
        capabilityModels: [imageEntry, { ...imageEntry, model: 'qwen-image-edit' }],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['contributions', 'capabilityModels', 1, 'id']);
    }
    // id 规则（PLUGIN_MCP_KEY_PATTERN，DEV-093）只收小写字母数字连字符：大小写变体
    // 重复不可能到达 superRefine 查重，由条目 schema 直接拒绝。
    expect(capabilityModelEntrySchema.safeParse({ ...imageEntry, id: 'Qwen-Image' }).success).toBe(
      false,
    );
  });

  it('rejects unknown capability values (chat is not an entry capability)', () => {
    expect(() =>
      parse({
        ...baseManifest,
        contributions: {
          ...baseManifest.contributions,
          capabilityModels: [{ ...imageEntry, capability: 'chat' }],
        },
      }),
    ).toThrow();
    expect(() =>
      parse({
        ...baseManifest,
        contributions: {
          ...baseManifest.contributions,
          capabilityModels: [{ ...imageEntry, capability: 'audio' }],
        },
      }),
    ).toThrow();
  });

  it('rejects empty / oversized model and engine fields', () => {
    expect(() =>
      parse({
        ...baseManifest,
        contributions: {
          ...baseManifest.contributions,
          capabilityModels: [{ ...imageEntry, model: '' }],
        },
      }),
    ).toThrow();
    expect(() =>
      parse({
        ...baseManifest,
        contributions: {
          ...baseManifest.contributions,
          capabilityModels: [{ ...imageEntry, engine: '' }],
        },
      }),
    ).toThrow();
    expect(() =>
      parse({
        ...baseManifest,
        contributions: {
          ...baseManifest.contributions,
          capabilityModels: [{ ...imageEntry, model: 'm'.repeat(201) }],
        },
      }),
    ).toThrow();
    expect(() =>
      parse({
        ...baseManifest,
        contributions: {
          ...baseManifest.contributions,
          capabilityModels: [{ ...imageEntry, engine: 'e'.repeat(65) }],
        },
      }),
    ).toThrow();
  });

  it('rejects entries beyond the 32 cap and unknown fields (strictObject)', () => {
    const entries = Array.from({ length: PLUGIN_MAX_CAPABILITY_MODELS + 1 }, (_, i) => ({
      ...imageEntry,
      id: `model-${i}`,
    }));
    expect(
      pluginManifestSchema.safeParse({
        ...baseManifest,
        contributions: { ...baseManifest.contributions, capabilityModels: entries },
      }).success,
    ).toBe(false);
    expect(capabilityModelEntrySchema.safeParse({ ...imageEntry, vendor: 'x' }).success).toBe(
      false,
    );
  });

  it('exposes the documented limits and the instance kind member', () => {
    expect(PLUGIN_MAX_CAPABILITY_MODELS).toBe(32);
    expect(PLUGIN_INSTANCE_KINDS).toContain('capability-model');
  });

  it('parses legacy manifests without the new fields (backward compatibility)', () => {
    // 旧清单：contributions 无 capabilityModels、manifest 无 instances —— 解析不新增键。
    const legacy = parse({
      format_version: 1,
      id: 'io.github.alice/doc-tools',
      name: '文档工具集',
      version: '1.2.0',
      usage: '启用即可使用，无需再绑定任何账号。',
      contributions: { skills: [{ dir: 'skills/docx' }] },
    }) as Record<string, unknown>;
    const contributions = legacy.contributions as Record<string, unknown>;
    expect('capabilityModels' in contributions).toBe(false);
    expect(contributions.capabilityModels).toBeUndefined();

    // 旧 profile_json：runtime 无 capability_entries —— 读出即默认空数组（零迁移）。
    expect(botRuntimeSchema.parse({}).capability_entries).toEqual([]);
    expect(botRuntimeSchema.parse({ model: 'gpt-x' }).capability_entries).toEqual([]);
  });
});

describe('capabilityEntryRefSchema / botRuntimeSchema.capability_entries (D124)', () => {
  it('accepts plugin + entry refs and applies the runtime default', () => {
    const ref = { plugin: 'com.example/media-models', entry: 'qwen-image' };
    expect(capabilityEntryRefSchema.parse(ref)).toEqual(ref);
    expect(botRuntimeSchema.parse({ capability_entries: [ref] }).capability_entries).toEqual([ref]);
  });

  it('rejects empty / missing ref parts and unknown ref fields', () => {
    expect(() => botRuntimeSchema.parse({ capability_entries: [{ plugin: '', entry: 'a' }] })).toThrow();
    expect(() => botRuntimeSchema.parse({ capability_entries: [{ plugin: 'p' }] })).toThrow();
    expect(() => botRuntimeSchema.parse({ capability_entries: [{ plugin: 'p', entry: 'e', bot: 'x' }] })).toThrow();
    expect(() => botRuntimeSchema.parse({ capability_entries: ['qwen-image'] })).toThrow();
  });

  it('caps capability_entries at 16', () => {
    const ref = { plugin: 'com.example/media-models', entry: 'qwen-image' };
    expect(botRuntimeSchema.parse({ capability_entries: Array(16).fill(ref) }).capability_entries).toHaveLength(16);
    expect(() =>
      botRuntimeSchema.parse({ capability_entries: Array(17).fill(ref) }),
    ).toThrow();
  });
});

/**
 * D125 P4（DEV-114 方案 1）：执行型插件的实例字段声明面 `runtime.instanceFields`。
 * 复用 D105 的 pluginFieldSchema；sensitive 字段走既有实例 secrets 管线。
 */
describe('runtime.instanceFields (D125 P4, DEV-114)', () => {
  const runtimeManifest = {
    ...baseManifest,
    runtime: {
      entry: 'dist/main.js',
      hostApi: '^1',
      instanceFields: [
        {
          key: 'apiKey',
          type: 'string',
          title: 'API Key',
          required: true,
          sensitive: true,
        },
        { key: 'region', type: 'string', title: 'Region', default: 'cn-beijing' },
      ],
    },
    contributions: {
      ...baseManifest.contributions,
      capabilityModels: [
        { id: 'wan-t2i', capability: 'image', model: 'wan2.7-t2v' },
      ],
    },
  };

  it('accepts the declaration and keeps it on the parsed manifest', () => {
    const manifest = parse(runtimeManifest);
    expect(manifest.runtime?.instanceFields).toHaveLength(2);
    expect(manifest.runtime?.instanceFields?.[0]).toMatchObject({
      key: 'apiKey',
      sensitive: true,
      required: true,
    });
  });

  it('rejects duplicate keys (same rule as every other instanceFields surface)', () => {
    expect(() =>
      parse({
        ...runtimeManifest,
        runtime: {
          ...runtimeManifest.runtime,
          instanceFields: [
            { key: 'apiKey', type: 'string', title: 'A' },
            { key: 'apiKey', type: 'string', title: 'B' },
          ],
        },
      }),
    ).toThrow(/实例字段重复/);
  });

  it('rejects unknown field keys / more than 16 fields', () => {
    expect(() =>
      parse({
        ...runtimeManifest,
        runtime: {
          ...runtimeManifest.runtime,
          instanceFields: [{ key: 'api key', type: 'string', title: 'bad' }],
        },
      }),
    ).toThrow();
    expect(() =>
      parse({
        ...runtimeManifest,
        runtime: {
          ...runtimeManifest.runtime,
          instanceFields: Array.from({ length: 17 }, (_, i) => ({
            key: `f${i}`,
            type: 'string',
            title: `F${i}`,
          })),
        },
      }),
    ).toThrow();
  });
});
