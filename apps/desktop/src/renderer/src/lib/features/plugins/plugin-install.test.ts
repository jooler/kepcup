import { describe, expect, it } from 'vitest';
import type { McpbUserConfigField, McpServer, PluginInspectOutput } from '@kepcup/shared';
import {
  buildPluginUserConfig,
  canInstallPlugin,
  clearPluginSensitive,
  initialPluginForm,
  managedServerPluginId,
  missingPluginConfig,
  pluginIdOfSkillSource,
} from './plugin-install';

const field = (patch: Partial<McpbUserConfigField> & { key: string }): McpbUserConfigField => ({
  type: 'string',
  title: patch.key,
  description: '',
  required: false,
  sensitive: false,
  multiple: false,
  ...patch,
});

const mcpbItem = {
  kind: 'mcpb' as const,
  id: 'docs',
  displayName: 'Doc Tools',
  serverType: 'node' as const,
  launchCommand: 'node server.js',
  runtime: null,
  mcpbSha256: 'a'.repeat(64),
  unpackedSize: 1024,
  compatible: true,
  incompatibleReason: null,
  userConfigFields: [
    field({ key: 'api_key', title: 'API Key', required: true, sensitive: true }),
    field({ key: 'port', type: 'number', default: 8080 }),
    field({ key: 'verbose', type: 'boolean', default: true }),
    field({ key: 'roots', type: 'directory', multiple: true }),
  ],
};

const info: PluginInspectOutput = {
  id: 'io.github.alice/doc-tools',
  name: 'Doc Tools',
  version: '1.2.0',
  description: '',
  author: null,
  homepage: null,
  origin: 'local',
  tier: 'developer',
  packageSha256: 'b'.repeat(64),
  sizeBytes: 2048,
  skills: [],
  connectors: [],
  mcp: [
    mcpbItem,
    {
      kind: 'http',
      id: 'web',
      displayName: 'Web Search',
      url: 'https://mcp.example.com/mcp',
      host: 'mcp.example.com',
    },
  ],
  mail: [],
  conflicts: [],
  existing: null,
  update: null,
  installable: true,
  blockers: [],
};

describe('plugin install form helpers', () => {
  it('seeds one form per embedded MCPB', () => {
    expect(initialPluginForm(info)).toEqual({
      docs: { api_key: '', port: '8080', verbose: true, roots: '' },
    });
  });

  it('lists missing required fields per MCPB, prefixed with the display name', () => {
    const form = initialPluginForm(info);
    expect(missingPluginConfig(info, form)).toEqual(['「Doc Tools」API Key']);
    expect(missingPluginConfig(info, { ...form, docs: { ...form.docs, api_key: '  ' } })).toEqual([
      '「Doc Tools」API Key',
    ]);
    expect(missingPluginConfig(info, { ...form, docs: { ...form.docs, api_key: 'k' } })).toEqual(
      [],
    );
  });

  it('treats an empty required sensitive field as kept (not missing) only for updates', () => {
    const form = initialPluginForm(info);
    const updating: PluginInspectOutput = {
      ...info,
      existing: { version: '1.1.0' },
      update: { from: '1.1.0', permissionsExpanded: false, added: [] },
    };
    // P1-2 keepSecrets：更新时敏感留空 = 保留已存 secret，不算缺项（否则确认按钮永远禁用）。
    expect(missingPluginConfig(updating, form)).toEqual([]);
    expect(
      missingPluginConfig(updating, { ...form, docs: { ...form.docs, api_key: 'rotated' } }),
    ).toEqual([]);
    // 全新安装没有已存 secret 可保留：必填敏感仍必须填。
    expect(missingPluginConfig(info, form)).toEqual(['「Doc Tools」API Key']);
  });

  it('builds typed userConfig per MCPB, keeping empty objects', () => {
    const form = initialPluginForm(info);
    expect(buildPluginUserConfig(info, { ...form, docs: { ...form.docs, api_key: 'sk' } })).toEqual(
      {
        docs: { api_key: 'sk', port: 8080, verbose: true },
      },
    );
    // No values at all: the mcpb id is still present with an empty object.
    expect(buildPluginUserConfig(info, { docs: {} })).toEqual({ docs: {} });
  });

  it('clears only sensitive fields after submit', () => {
    const form = initialPluginForm(info);
    expect(clearPluginSensitive(info, { ...form, docs: { ...form.docs, api_key: 'sk' } })).toEqual({
      docs: { api_key: '', port: '8080', verbose: true, roots: '' },
    });
  });

  it('gates the confirm button on installable and complete config', () => {
    expect(canInstallPlugin(info, [])).toBe(true);
    expect(canInstallPlugin(info, ['「Doc Tools」API Key'])).toBe(false);
    expect(canInstallPlugin({ ...info, installable: false }, [])).toBe(false);
  });

  it('gates the confirm button on the acknowledged permission diff (updates only)', () => {
    const expanded: PluginInspectOutput = {
      ...info,
      existing: { version: '1.0.0' },
      update: { from: '1.0.0', permissionsExpanded: true, added: ['新增网络主机 api.x.com'] },
    };
    expect(canInstallPlugin(expanded, [], false)).toBe(false);
    expect(canInstallPlugin(expanded, [], true)).toBe(true);
    // 权限不扩大：无需勾选即可确认。
    const notExpanded: PluginInspectOutput = {
      ...expanded,
      update: { from: '1.0.0', permissionsExpanded: false, added: [] },
    };
    expect(canInstallPlugin(notExpanded, [], false)).toBe(true);
  });

  it('parses plugin skill sources round-trip and rejects malformed ones', () => {
    expect(pluginIdOfSkillSource('plugin://io.github.alice/doc-tools/pdf-guide')).toBe(
      'io.github.alice/doc-tools',
    );
    expect(pluginIdOfSkillSource('builtin:///skills/pdf-guide')).toBeNull();
    expect(pluginIdOfSkillSource('plugin://no-skill-name')).toBeNull();
    expect(pluginIdOfSkillSource('plugin://a/b/')).toBeNull();
    expect(pluginIdOfSkillSource('')).toBeNull();
  });

  it('reads the plugin id off managed MCP servers', () => {
    const managed: McpServer = {
      id: 'plg_0123456789ab',
      name: 'Doc Tools',
      transport: 'stdio',
      command: 'node',
      args: [],
      cwd: null,
      env: {},
      enabled: true,
      auth: 'none',
      oauth: null,
      source: {
        kind: 'plugin',
        pluginId: 'io.github.alice/doc-tools',
        version: '1.2.0',
        key: 'docs',
      },
    } as unknown as McpServer;
    expect(managedServerPluginId(managed)).toBe('io.github.alice/doc-tools');
    expect(
      managedServerPluginId({
        ...managed,
        source: { kind: 'mcpb', name: 'x', version: '1', sha256: 'c'.repeat(64) },
      } as unknown as McpServer),
    ).toBeNull();
    expect(managedServerPluginId({ ...managed, source: undefined } as unknown as McpServer)).toBe(
      null,
    );
  });
});
