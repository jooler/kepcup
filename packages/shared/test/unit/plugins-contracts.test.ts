import { describe, expect, it } from 'vitest';
import {
  APP_RPC_METHODS,
  ERROR_CODES,
  RPC_EVENT_NAMES,
  connectorOriginSchema,
  mcpServerSchema,
  pluginInspectOutputSchema,
  pluginSummarySchema,
  pluginsInstallInputSchema,
  rpcEventSchemas,
  rpcMethodSchemas,
} from '../../src/index.js';

/**
 * 插件系统 RPC / 事件 / 错误码 / 既有契约改动（D104，P0a-1 步骤 2.2–2.4）：
 * 五个方法都进了 `APP_RPC_METHODS`、事件与错误码登记、`McpServerSource` 联合、
 * 同意面板与 summary 的 schema 往返。
 */

const PLUGIN_METHODS = [
  'plugins.list',
  'plugins.inspect',
  'plugins.install',
  'plugins.setEnabled',
  'plugins.uninstall',
];

const summary = {
  id: 'io.github.alice/doc-tools',
  name: '文档工具集',
  version: '1.2.0',
  description: '',
  author: null,
  origin: 'local',
  tier: 'developer',
  state: 'installed',
  enabled: true,
  dirPath: '/home/.kepcup/plugins/io.github.alice/doc-tools@1.2.0',
  marketplace: null,
  installedAt: 1,
  updatedAt: 1,
  counts: { skills: 2, connectors: 1, mcp: 1, mail: 0 },
  items: [
    { kind: 'skill', ref: 'docx' },
    { kind: 'mcp', ref: 'plg_abc123456789', missing: true },
    { kind: 'connector', ref: 'notion', yielded: true },
  ],
  updateAvailable: null,
};

describe('plugins RPC / event / error-code contracts', () => {
  it('registers all five plugins.* methods in APP_RPC_METHODS', () => {
    for (const method of PLUGIN_METHODS) {
      expect(APP_RPC_METHODS).toContain(method);
      expect(rpcMethodSchemas).toHaveProperty(method);
    }
  });

  it('registers the plugins.changed event', () => {
    expect(RPC_EVENT_NAMES).toContain('plugins.changed');
    expect(rpcEventSchemas['plugins.changed']!.parse({ ids: ['io.github.a/b'] })).toEqual({
      ids: ['io.github.a/b'],
    });
  });

  it('registers the four PLUGIN_* error codes', () => {
    for (const code of ['PLUGIN_INVALID', 'PLUGIN_INCOMPATIBLE', 'PLUGIN_CONFLICT', 'PLUGIN_MANAGED']) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('adds plugin to connectorOriginSchema', () => {
    expect(connectorOriginSchema.options).toContain('plugin');
    expect(connectorOriginSchema.safeParse('plugin').success).toBe(true);
  });
});

describe('mcpServerSourceSchema union', () => {
  it('keeps a plugin source with an embedded mcpb ref', () => {
    const server = mcpServerSchema.parse({
      id: 'plg_abc123456789',
      name: 'DB tools',
      transport: 'stdio',
      command: '/managed/node/bin/node',
      enabled: true,
      source: {
        kind: 'plugin',
        pluginId: 'io.github.alice/doc-tools',
        version: '1.2.0',
        key: 'dbtools',
        mcpb: { name: 'dbtools', version: '0.5.0', sha256: 'a'.repeat(64) },
      },
    });
    expect(server.source).toEqual({
      kind: 'plugin',
      pluginId: 'io.github.alice/doc-tools',
      version: '1.2.0',
      key: 'dbtools',
      mcpb: { name: 'dbtools', version: '0.5.0', sha256: 'a'.repeat(64) },
    });
  });

  it('keeps an mcpb source', () => {
    const server = mcpServerSchema.parse({
      id: 'mcpb_x',
      name: 'x',
      transport: 'stdio',
      command: 'node',
      enabled: true,
      source: { kind: 'mcpb', name: 'echo', version: '1.0.0', sha256: 'b'.repeat(64) },
    });
    expect(server.source).toEqual({
      kind: 'mcpb',
      name: 'echo',
      version: '1.0.0',
      sha256: 'b'.repeat(64),
    });
  });

  it('drops a malformed plugin source but keeps the server valid', () => {
    const server = mcpServerSchema.parse({
      id: 'x',
      name: 'x',
      transport: 'stdio',
      command: 'node',
      enabled: true,
      source: { kind: 'plugin', pluginId: 'io.github.a/b', version: '1.0.0' },
    });
    expect(server.source).toBeUndefined();
  });
});

describe('payload round-trips', () => {
  it('pluginSummarySchema round-trips', () => {
    expect(pluginSummarySchema.parse(summary)).toEqual(summary);
  });

  it('pluginInspectOutputSchema round-trips', () => {
    const inspect = {
      id: 'io.github.alice/doc-tools',
      name: '文档工具集',
      version: '1.2.0',
      description: '',
      author: null,
      homepage: null,
      origin: 'local',
      tier: 'developer',
      packageSha256: 'c'.repeat(64),
      sizeBytes: 1024,
      skills: [
        {
          name: 'docx',
          description: 'Word tools',
          runtimeDeps: ['pandoc'],
          compatible: true,
          incompatibleReason: null,
        },
      ],
      connectors: [
        {
          slug: 'notion',
          name: 'test.notion/mcp',
          title: 'Notion',
          hosts: ['api.notion.com'],
          scopes: [],
          authKind: 'oauth',
        },
      ],
      mcp: [
        {
          kind: 'mcpb',
          id: 'dbtools',
          displayName: 'DB tools',
          serverType: 'node',
          launchCommand: '/managed/node/bin/node /dir/index.cjs',
          runtime: { kind: 'node', available: true },
          mcpbSha256: 'd'.repeat(64),
          unpackedSize: 10,
          userConfigFields: [],
          compatible: true,
          incompatibleReason: null,
        },
        { kind: 'http', id: 'docs', displayName: 'Docs', url: 'https://mcp.example.com/mcp', host: 'mcp.example.com' },
      ],
      mail: [{ id: 'fastmail', label: 'Fastmail', imapHost: 'imap.fastmail.com', smtpHost: 'smtp.fastmail.com' }],
      conflicts: [{ kind: 'skill', ref: 'docx', withWhat: '公共技能 docx（预置）' }],
      existing: null,
      update: null,
      installable: false,
      blockers: ['与公共技能 docx 冲突'],
    };
    expect(pluginInspectOutputSchema.parse(inspect)).toEqual(inspect);
  });

  it('pluginsInstallInputSchema defaults userConfig to {}', () => {
    const input = pluginsInstallInputSchema.parse({
      source: { kind: 'file', path: '/tmp/x.kepcup' },
      sha256: 'e'.repeat(64),
    });
    expect(input.userConfig).toEqual({});
  });
});
