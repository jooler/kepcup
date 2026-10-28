import { describe, expect, it } from 'vitest';
import {
  PLUGIN_FORMAT_VERSION,
  PLUGIN_MANIFEST_MAX_BYTES,
  PLUGIN_MCP_KEY_PATTERN,
  PLUGIN_MAX_CONNECTORS,
  PLUGIN_MAX_MAIL,
  PLUGIN_MAX_MCP,
  PLUGIN_MAX_SKILLS,
  PLUGIN_RESERVED_NAMESPACES,
  PLUGIN_SOURCE_PREFIX,
  isReservedPluginNamespace,
  isSafePluginRelPath,
  parsePluginSkillSource,
  pluginCapabilitySummary,
  pluginFieldSchema,
  pluginFieldSummaryOf,
  capabilityFactsOf,
  pluginIdSchema,
  pluginManifestSchema,
  pluginNamespaceOf,
  pluginRelPathSchema,
  pluginSkillSource,
  pluginVersionSchema,
  type PluginManifest,
} from '../../src/index.js';

/**
 * 插件清单契约（D104，todo/plugin-system/P0a-1-foundation.md 步骤 2.1）：strict schema、
 * 跨贡献去重、相对路径守卫、来源标记往返。清单未知字段一律拒绝——`tier` 之类自声明
 * 进不来。
 */

const minimalManifest = {
  format_version: 1,
  id: 'io.github.alice/doc-tools',
  name: '文档工具集',
  version: '1.2.0',
  contributions: { skills: [{ dir: 'skills/docx' }] },
} satisfies Record<string, unknown>;

const parse = (input: unknown) => pluginManifestSchema.parse(input);

describe('plugin manifest schema', () => {
  it('accepts the minimal manifest (one skill) with defaults applied', () => {
    const manifest = parse(minimalManifest);
    expect(manifest.format_version).toBe(PLUGIN_FORMAT_VERSION);
    expect(manifest.description).toBe('');
    expect(manifest.contributions.connectors).toEqual([]);
    expect(manifest.contributions.mcp).toEqual([]);
    expect(manifest.contributions.mail).toEqual([]);
  });

  it('is strict: unknown fields like tier / categories are rejected', () => {
    expect(() => parse({ ...minimalManifest, tier: 'verified' })).toThrow();
    expect(() => parse({ ...minimalManifest, categories: ['productivity'] })).toThrow();
    expect(() => parse({ ...minimalManifest, permissions: ['fs'] })).toThrow();
  });

  it('rejects format_version 2 (schema is the last line of defense)', () => {
    expect(() => parse({ ...minimalManifest, format_version: 2 })).toThrow();
  });

  it('rejects an empty contributions set', () => {
    expect(() =>
      parse({
        ...minimalManifest,
        contributions: { skills: [], connectors: [], mcp: [], mail: [] },
      }),
    ).toThrow(/至少要包含一类贡献/);
  });

  it('rejects a duplicate mcp id across the mcpb / http kinds', () => {
    const manifest = {
      ...minimalManifest,
      contributions: {
        skills: [],
        connectors: [],
        mcp: [
          { kind: 'mcpb', id: 'dbtools', file: 'mcp/dbtools.mcpb' },
          { kind: 'http', id: 'dbtools', url: 'https://mcp.example.com/mcp' },
        ],
        mail: [],
      },
    };
    const result = pluginManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['contributions', 'mcp', 1, 'id']);
    }
  });

  it('rejects duplicate skill dirs, connector files, mcpb files and mail ids', () => {
    expect(() =>
      parse({
        ...minimalManifest,
        contributions: { skills: [{ dir: 'skills/a' }, { dir: 'skills/A' }] },
      }),
    ).toThrow(/重复项/);
    expect(() =>
      parse({
        ...minimalManifest,
        contributions: {
          skills: [],
          connectors: [{ file: 'connectors/a/server.json' }, { file: 'connectors/A/server.json' }],
        },
      }),
    ).toThrow(/重复项/);
    expect(() =>
      parse({
        ...minimalManifest,
        contributions: {
          skills: [],
          connectors: [],
          mcp: [
            { kind: 'mcpb', id: 'a', file: 'mcp/a.mcpb' },
            { kind: 'mcpb', id: 'b', file: 'mcp/A.mcpb' },
          ],
        },
      }),
    ).toThrow(/重复项/);
    expect(() =>
      parse({
        ...minimalManifest,
        contributions: {
          skills: [],
          connectors: [],
          mcp: [],
          mail: [
            {
              id: 'fast',
              label: 'Fast',
              imap: { host: 'i', port: 993, secure: 'ssl' },
              smtp: { host: 's', port: 465, secure: 'ssl' },
            },
            {
              id: 'FAST',
              label: 'Fast',
              imap: { host: 'i', port: 993, secure: 'ssl' },
              smtp: { host: 's', port: 465, secure: 'ssl' },
            },
          ],
        },
      }),
    ).toThrow(/重复项/);
  });

  it('points the mcpb-file duplicate issue at the index in the full mcp array', () => {
    const result = pluginManifestSchema.safeParse({
      ...minimalManifest,
      contributions: {
        skills: [],
        connectors: [],
        mcp: [
          { kind: 'http', id: 'docs', url: 'https://mcp.example.com/mcp' },
          { kind: 'mcpb', id: 'a', file: 'mcp/x.mcpb' },
          { kind: 'mcpb', id: 'b', file: 'mcp/X.mcpb' },
        ],
        mail: [],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The index must be the position inside `mcp` (2), not inside the mcpb-only subset (1).
      expect(result.error.issues[0]?.path).toEqual(['contributions', 'mcp', 2, 'file']);
    }
  });

  it('rejects a non-URL http contribution and a non-mcpb file', () => {
    expect(() =>
      parse({
        ...minimalManifest,
        contributions: {
          skills: [],
          connectors: [],
          mcp: [{ kind: 'http', id: 'docs', url: 'not a url' }],
        },
      }),
    ).toThrow();
    expect(() =>
      parse({
        ...minimalManifest,
        contributions: {
          skills: [],
          connectors: [],
          mcp: [{ kind: 'mcpb', id: 'a', file: 'mcp/a.zip' }],
        },
      }),
    ).toThrow();
    expect(() =>
      parse({
        ...minimalManifest,
        contributions: { skills: [], connectors: [{ file: 'connectors/a/server.yaml' }] },
      }),
    ).toThrow();
  });

  it('applies the mail defaults', () => {
    const manifest = parse({
      ...minimalManifest,
      contributions: {
        skills: [],
        connectors: [],
        mcp: [],
        mail: [
          {
            id: 'fastmail',
            label: 'Fastmail',
            imap: { host: 'imap.fastmail.com', port: 993, secure: 'ssl' },
            smtp: { host: 'smtp.fastmail.com', port: 465, secure: 'ssl' },
          },
        ],
      },
    }) as PluginManifest;
    const template = manifest.contributions.mail[0]!;
    expect(template.defaultMode).toBe('auto');
    expect(template.defaultPollSec).toBe(300);
    expect(template.minPollSec).toBe(60);
  });

  it('rejects http (non-https) author url / homepage / helpUrl', () => {
    expect(() => parse({ ...minimalManifest, homepage: 'http://example.com' })).toThrow();
    expect(() =>
      parse({ ...minimalManifest, author: { name: 'A', url: 'http://a.example' } }),
    ).toThrow();
    expect(() =>
      parse({
        ...minimalManifest,
        contributions: {
          skills: [],
          connectors: [],
          mcp: [],
          mail: [
            {
              id: 'fastmail',
              label: 'Fast',
              imap: { host: 'i', port: 993, secure: 'ssl' },
              smtp: { host: 's', port: 465, secure: 'ssl' },
              helpUrl: 'http://help.example',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('exposes the documented limits', () => {
    expect(PLUGIN_MAX_SKILLS).toBe(50);
    expect(PLUGIN_MAX_CONNECTORS).toBe(20);
    expect(PLUGIN_MAX_MCP).toBe(10);
    expect(PLUGIN_MAX_MAIL).toBe(10);
    expect(PLUGIN_MANIFEST_MAX_BYTES).toBe(65536);
    expect(PLUGIN_SOURCE_PREFIX).toBe('plugin://');
    expect(PLUGIN_RESERVED_NAMESPACES).toEqual(['com.kepcup', 'local.kepcup']);
    expect(PLUGIN_MCP_KEY_PATTERN.test('db-tools1')).toBe(true);
    expect(PLUGIN_MCP_KEY_PATTERN.test('Db')).toBe(false);
  });
});

describe('pluginRelPathSchema', () => {
  const rejected = [
    '..',
    '../x',
    'a/../..',
    '/abs',
    '\\back',
    'a\\b',
    'a:b',
    'a//b',
    'a/',
    'a/.',
    'a/..',
    'a\0b',
    'a\nb',
    ''.padEnd(301, 'a'),
  ];
  for (const value of rejected) {
    it(`rejects ${JSON.stringify(value.length > 40 ? `${value.slice(0, 12)}…(${value.length})` : value)}`, () => {
      expect(pluginRelPathSchema.safeParse(value).success).toBe(false);
      expect(isSafePluginRelPath(value)).toBe(false);
    });
  }
  it('accepts normal relative paths', () => {
    expect(pluginRelPathSchema.safeParse('skills/docx/SKILL.md').success).toBe(true);
    expect(pluginRelPathSchema.safeParse('mcp/db.mcpb').success).toBe(true);
  });
});

describe('plugin identity helpers', () => {
  it('extracts the lower-cased namespace', () => {
    expect(pluginNamespaceOf('io.github.Alice/doc-tools')).toBe('io.github.alice');
    expect(pluginNamespaceOf('com.kepcup/starter-skills')).toBe('com.kepcup');
  });

  it('detects reserved namespaces case-insensitively', () => {
    expect(isReservedPluginNamespace('com.kepcup')).toBe(true);
    expect(isReservedPluginNamespace('Local.KepCup')).toBe(true);
    expect(isReservedPluginNamespace('io.github.alice')).toBe(false);
  });

  it('pluginIdSchema matches the Registry namespace rule', () => {
    expect(pluginIdSchema.safeParse('io.github.alice/doc-tools').success).toBe(true);
    expect(pluginIdSchema.safeParse('com.kepcup/starter-skills').success).toBe(true);
    expect(pluginIdSchema.safeParse('no-slash').success).toBe(false);
    expect(pluginIdSchema.safeParse('ns/..').success).toBe(false);
  });

  it('pluginVersionSchema accepts semver and rejects loose strings', () => {
    expect(pluginVersionSchema.safeParse('1.2.0').success).toBe(true);
    expect(pluginVersionSchema.safeParse('1.2.0-beta.1+build').success).toBe(true);
    expect(pluginVersionSchema.safeParse('1.2').success).toBe(false);
    expect(pluginVersionSchema.safeParse('v1.2.0').success).toBe(false);
  });
});

describe('plugin skill source marker', () => {
  it('round-trips', () => {
    const source = pluginSkillSource('io.github.alice/doc-tools', 'docx');
    expect(source).toBe('plugin://io.github.alice/doc-tools/docx');
    expect(parsePluginSkillSource(source)).toEqual({
      pluginId: 'io.github.alice/doc-tools',
      skillName: 'docx',
    });
  });

  const malformed = [
    '',
    'preset://io.github.alice/x/docx',
    'plugin://io.github.alice',
    'plugin://io.github.alice/',
    'plugin://io.github.alice/x/',
    'plugin://io.github.alice/x/docx/extra',
    'plugin:////docx',
    'https://example.com/a/b',
  ];
  for (const value of malformed) {
    it(`returns null for ${value === '' ? 'empty string' : value}`, () => {
      expect(parsePluginSkillSource(value)).toBeNull();
    });
  }
});

describe('declarative fields & instances (D105)', () => {
  it('a pure-instance manifest with config fields is valid', () => {
    const manifest = parse({
      format_version: 1,
      id: 'app.kepcup.example/mail-x',
      name: '示例邮件',
      version: '1.0.0',
      instances: ['mail'],
      config: {
        fields: [
          { key: 'pollSec', type: 'number', title: '轮询间隔（秒）', min: 60, max: 3600 },
        ],
      },
    });
    expect(manifest.instances).toEqual(['mail']);
    expect(manifest.config?.fields[0]?.key).toBe('pollSec');
    expect(manifest.config?.fields[0]?.required).toBe(false);
  });

  it('rejects duplicate config keys and duplicate instance kinds', () => {
    expect(
      pluginManifestSchema.safeParse({
        ...minimalManifest,
        config: {
          fields: [
            { key: 'a', type: 'string', title: 'A' },
            { key: 'a', type: 'string', title: 'A2' },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({
        ...minimalManifest,
        instances: ['mail', 'mail'],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown instance kinds and bad field shapes', () => {
    expect(pluginManifestSchema.safeParse({ ...minimalManifest, instances: ['sms'] }).success).toBe(
      false,
    );
    expect(
      pluginManifestSchema.safeParse({
        ...minimalManifest,
        config: { fields: [{ key: 'a', type: 'json', title: 'A' }] },
      }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({
        ...minimalManifest,
        config: { fields: [{ key: 'has space', type: 'string', title: 'A' }] },
      }).success,
    ).toBe(false);
  });

  it('caps config fields and instances at the documented limits', () => {
    expect(
      pluginManifestSchema.safeParse({
        ...minimalManifest,
        config: {
          fields: Array.from({ length: 33 }, (_, i) => ({
            key: `f${i}`,
            type: 'string',
            title: `F${i}`,
          })),
        },
      }).success,
    ).toBe(false);
    // Only two kinds exist; >4 entries is structurally impossible without duplicates, so
    // the cap is asserted through the duplicate rejection above.
  });
});

describe('plugin field schema (D105: MCPB user_config 泛化)', () => {
  it('accepts a full field and applies defaults', () => {
    const field = pluginFieldSchema.parse({ key: 'apiKey', type: 'string', title: 'API Key' });
    expect(field).toMatchObject({
      key: 'apiKey',
      type: 'string',
      title: 'API Key',
      description: '',
      required: false,
      sensitive: false,
      multiple: false,
    });
    expect('default' in field).toBe(false);
  });

  it('is strict: unknown keys are rejected, not stripped', () => {
    expect(
      pluginFieldSchema.safeParse({ key: 'a', type: 'string', title: 'A', placeholder: 'x' })
        .success,
    ).toBe(false);
  });

  it('pluginFieldSummaryOf drops default and keeps the form-relevant bits', () => {
    const field = pluginFieldSchema.parse({
      key: 'apiKey',
      type: 'string',
      title: 'API Key',
      required: true,
      sensitive: true,
      default: 'never-travels',
    });
    const summary = pluginFieldSummaryOf(field);
    expect(summary).toEqual({
      key: 'apiKey',
      title: 'API Key',
      type: 'string',
      required: true,
      sensitive: true,
    });
  });
});

describe('capability summary (D105)', () => {
  it('describes contributions with names and instance offers', () => {
    const manifest = parse({
      format_version: 1,
      id: 'io.github.alice/doc-tools',
      name: '文档工具集',
      version: '1.2.0',
      contributions: {
        skills: [
          { dir: 'skills/docx', displayName: 'Word 工具' },
          { dir: 'skills/pptx' },
        ],
        connectors: [{ file: 'connectors/notion.json' }],
        mcp: [],
        mail: [],
      },
      instances: ['mail'],
    });
    expect(pluginCapabilitySummary(capabilityFactsOf(manifest))).toBe(
      '提供 2 个技能（Word 工具、pptx） 与 1 个连接；可添加多个邮箱账号',
    );
    // contributions 可整体省略（纯实例插件）；解析输出恒为完整对象。
    const pure = parse({
      format_version: 1,
      id: 'app.kepcup.example/mail-only',
      name: '纯邮件',
      version: '1.0.0',
      instances: ['mail'],
    });
    expect(pure.contributions).toEqual({ skills: [], connectors: [], mcp: [], mail: [] });
  });

  it('sanitizes untrusted skill names', () => {
    const summary = pluginCapabilitySummary({
      skills: 1,
      connectors: 0,
      mcp: 0,
      mail: 0,
      instances: [],
      skillNames: ['a\nb\u202ec'],
    });
    expect(summary).not.toMatch(/[\n\u202e]/);
  });

  it('falls back for a pure-instance manifest', () => {
    expect(
      pluginCapabilitySummary({
        skills: 0,
        connectors: 0,
        mcp: 0,
        mail: 0,
        instances: ['mcp'],
        skillNames: [],
      }),
    ).toBe('可添加自定义工具');
  });
});
