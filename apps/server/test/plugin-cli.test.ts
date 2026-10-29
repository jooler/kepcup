import { describe, expect, it } from 'vitest';
import { pluginInspectOutputSchema } from '@kepcup/shared';
import {
  PluginConfigError,
  formatPluginInspection,
  missingRequiredUserConfig,
  parseUserConfigText,
} from '../src/plugin-cli.js';

const INFO = pluginInspectOutputSchema.parse({
  id: 'io.github.tester/demo',
  name: 'Demo',
  version: '1.0.0',
  description: 'A demo plugin',
  author: 'Tester',
  homepage: null,
  origin: 'local',
  tier: 'developer',
  packageSha256: 'a'.repeat(64),
  sizeBytes: 2048,
  skills: [
    {
      name: 'hello',
      description: 'Says hello',
      runtimeDeps: [],
      compatible: true,
      incompatibleReason: null,
    },
  ],
  connectors: [
    {
      slug: 'acme',
      name: 'com.acme/mcp',
      title: 'Acme',
      hosts: ['mcp.acme.test'],
      scopes: ['read'],
      authKind: 'oauth',
    },
  ],
  mcp: [
    {
      kind: 'mcpb',
      id: 'echo',
      displayName: 'Echo',
      serverType: 'node',
      launchCommand: 'node server/index.cjs',
      runtime: { kind: 'node', available: false },
      mcpbSha256: 'b'.repeat(64),
      unpackedSize: 100,
      userConfigFields: [
        {
          key: 'API_KEY',
          type: 'string',
          title: 'API key',
          description: '',
          required: true,
          sensitive: true,
        },
      ],
      compatible: true,
      incompatibleReason: null,
    },
    {
      kind: 'http',
      id: 'docs',
      displayName: 'Docs',
      url: 'https://mcp.example.com/mcp',
      host: 'mcp.example.com',
    },
  ],
  mail: [
    {
      id: 'fastmail',
      label: 'Fastmail',
      imapHost: 'imap.fastmail.com',
      smtpHost: 'smtp.fastmail.com',
    },
  ],
  conflicts: [],
  existing: null,
  update: null,
  installable: true,
  configFields: [],
  capabilitySummary: '提供 1 个技能、1 个连接与 1 个工具',
  blockers: [],
});

describe('formatPluginInspection', () => {
  it('renders the identity, contributions, runtime state and the developer warning', () => {
    const text = formatPluginInspection(INFO);
    expect(text).toContain('Demo（io.github.tester/demo@1.0.0）');
    expect(text).toContain(`包 sha256：${'a'.repeat(64)}（2.0 KB）`);
    expect(text).toContain('hello：Says hello');
    expect(text).toContain('运行时 node 未安装');
    expect(text).toContain('user_config：API_KEY（必填）（敏感）');
    expect(text).toContain('[docs] Docs：https://mcp.example.com/mcp');
    expect(text).toContain('mcp.acme.test');
    expect(text).toContain('Fastmail（fastmail）');
    expect(text).toContain('本地插件未经审核');
  });

  it('renders blockers, conflicts and update details', () => {
    const text = formatPluginInspection({
      ...INFO,
      existing: { version: '0.9.0' },
      update: { from: '0.9.0', permissionsExpanded: true, added: ['host:new.example.com'] },
      conflicts: [{ kind: 'connector', ref: 'acme', withWhat: '内置连接器 acme' }],
      installable: false,
      blockers: ['「Echo」需要 Node.js 运行时'],
    });
    expect(text).toContain('已安装版本：0.9.0');
    expect(text).toContain('更新：0.9.0 → 1.0.0，权限扩大（host:new.example.com）');
    expect(text).toContain('冲突：');
    expect(text).toContain('connector acme ↔ 内置连接器 acme');
    expect(text).toContain('阻断项：');
    expect(text).toContain('需要 Node.js 运行时');
  });

  it('renders empty contribution groups, a runtime-free MCPB and no warning for verified plugins', () => {
    const text = formatPluginInspection({
      ...INFO,
      origin: 'marketplace',
      tier: 'verified',
      skills: [],
      connectors: [],
      mail: [],
      mcp: [
        {
          kind: 'mcpb',
          id: 'bin',
          displayName: 'Binary',
          serverType: 'binary',
          launchCommand: './server',
          runtime: null,
          mcpbSha256: 'c'.repeat(64),
          unpackedSize: 10,
          userConfigFields: [],
          compatible: true,
          incompatibleReason: null,
        },
      ],
    });
    expect(text).toContain('技能（0）：\n  （无）');
    expect(text).toContain('连接器（0）：\n  （无）');
    expect(text).toContain('邮件模板（0）：\n  （无）');
    expect(text).toContain('运行时 不需要运行时');
    expect(text).not.toContain('未经审核');
  });
});

describe('missingRequiredUserConfig', () => {
  it('lists required keys that the file and defaults do not provide', () => {
    expect(missingRequiredUserConfig(INFO, {})).toEqual(['echo.API_KEY']);
    expect(missingRequiredUserConfig(INFO, { echo: { API_KEY: 'secret' } })).toEqual([]);
    expect(missingRequiredUserConfig(INFO, { echo: { API_KEY: '' } })).toEqual(['echo.API_KEY']);
    expect(missingRequiredUserConfig(INFO, { echo: { API_KEY: [] } })).toEqual(['echo.API_KEY']);
  });

  it('accepts a field default as satisfying the requirement', () => {
    const info = {
      ...INFO,
      mcp: INFO.mcp.map((item) =>
        item.kind === 'mcpb'
          ? {
              ...item,
              userConfigFields: [{ ...item.userConfigFields[0]!, default: 'from-default' }],
            }
          : item,
      ),
    };
    expect(missingRequiredUserConfig(info, {})).toEqual([]);
  });

  it('on an update, a blank required sensitive field keeps the stored secret (not missing); non-sensitive ones still are', () => {
    const updating = {
      ...INFO,
      existing: { version: '0.9.0' },
      update: { from: '0.9.0', permissionsExpanded: false, added: [] },
    };
    expect(missingRequiredUserConfig(updating, {})).toEqual([]);
    const withPlain = {
      ...updating,
      mcp: updating.mcp.map((item) =>
        item.kind === 'mcpb'
          ? {
              ...item,
              userConfigFields: [
                ...item.userConfigFields,
                {
                  key: 'REGION',
                  type: 'string' as const,
                  title: 'Region',
                  description: '',
                  required: true,
                  sensitive: false,
                  multiple: false,
                },
              ],
            }
          : item,
      ),
    };
    expect(missingRequiredUserConfig(withPlain, {})).toEqual(['echo.REGION']);
  });
});

describe('parseUserConfigText', () => {
  it('parses the documented shape', () => {
    expect(parseUserConfigText('{"echo":{"API_KEY":"secret","COUNT":2,"LIST":["a"]}}')).toEqual({
      echo: { API_KEY: 'secret', COUNT: 2, LIST: ['a'] },
    });
  });

  it('rejects invalid JSON / shapes / value types without echoing values', () => {
    const secret = 'super-secret-value';
    for (const text of [
      `{"echo": {"API_KEY": "${secret}"`,
      '[]',
      `{"echo": "${secret}"}`,
      `{"echo": {"API_KEY": {"nested": "${secret}"}}}`,
    ]) {
      let message = '';
      try {
        parseUserConfigText(text);
      } catch (error) {
        expect(error).toBeInstanceOf(PluginConfigError);
        message = (error as Error).message;
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(secret);
    }
  });
});
