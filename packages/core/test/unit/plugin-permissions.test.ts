import { describe, expect, it } from 'vitest';
import type { PluginConsentMcp } from '@kepcup/shared';

import {
  describePermission,
  diffPermissions,
  permissionTokens,
} from '../../src/plugins/permissions.js';

/**
 * 权限令牌推导（D104 P1-2 步骤 3）：一类一种的小写前缀令牌、mcpb / http 两种 MCP、
 * host 与 scope 的展开；差异只由「新增令牌」判定（只删不增 = 不扩大）；令牌转中文。
 */

const mcpbItem = (overrides: Partial<Extract<PluginConsentMcp, { kind: 'mcpb' }>> = {}) => ({
  kind: 'mcpb' as const,
  id: 'db',
  displayName: 'DB',
  serverType: 'node' as const,
  launchCommand: 'node db',
  runtime: { kind: 'node' as const, available: true },
  mcpbSha256: 'a'.repeat(64),
  unpackedSize: 1,
  userConfigFields: [
    {
      key: 'token',
      title: 'Token',
      type: 'string' as const,
      description: '',
      required: true,
      sensitive: true,
      multiple: false,
      default: undefined,
      min: undefined,
      max: undefined,
    },
  ],
  compatible: true,
  incompatibleReason: null,
  ...overrides,
});

describe('permissionTokens', () => {
  it('derives one token per demanded capability', () => {
    const tokens = permissionTokens({
      skills: [
        {
          name: 'docx',
          description: '',
          runtimeDeps: [],
          compatible: true,
          incompatibleReason: null,
        },
      ],
      connectors: [
        {
          slug: 'notion',
          name: 'notion/mcp',
          title: 'Notion',
          hosts: ['mcp.notion.com', 'api.notion.com'],
          scopes: ['read', 'write'],
          authKind: 'oauth',
        },
      ],
      mcp: [
        mcpbItem(),
        {
          kind: 'http',
          id: 'docs',
          displayName: 'Docs',
          url: 'https://docs.test/mcp',
          host: 'docs.test',
        },
      ],
      mail: [{ id: 'corporate', label: 'Corporate', imapHost: 'imap.x', smtpHost: 'smtp.x' }],
    });
    expect([...tokens].sort()).toEqual([
      'config:db:token',
      'connector:notion',
      'host:api.notion.com',
      'host:docs.test',
      'host:mcp.notion.com',
      'mail:corporate',
      'mcp-http:docs',
      'mcpb:db',
      'runtime:node',
      'scope:notion:read',
      'scope:notion:write',
      'skill:docx',
    ]);
  });

  it('omits the runtime token when the bundle needs none', () => {
    const tokens = permissionTokens({
      skills: [],
      connectors: [],
      mcp: [mcpbItem({ runtime: null, userConfigFields: [] })],
      mail: [],
    });
    expect([...tokens]).toEqual(['mcpb:db']);
  });
});

describe('diffPermissions', () => {
  it('expands only on tokens the old set lacks; removals never expand', () => {
    const old = permissionTokens({
      skills: [
        { name: 'a', description: '', runtimeDeps: [], compatible: true, incompatibleReason: null },
      ],
      connectors: [],
      mcp: [],
      mail: [{ id: 'x', label: '', imapHost: '', smtpHost: '' }],
    });
    // Same size but a different skill: still an expansion (the set is what counts).
    const grown = permissionTokens({
      skills: [
        { name: 'a', description: '', runtimeDeps: [], compatible: true, incompatibleReason: null },
        { name: 'b', description: '', runtimeDeps: [], compatible: true, incompatibleReason: null },
      ],
      connectors: [],
      mcp: [],
      mail: [{ id: 'x', label: '', imapHost: '', smtpHost: '' }],
    });
    expect(diffPermissions(old, grown)).toEqual({ expanded: true, added: ['skill:b'] });
    // 只删不增: not an expansion.
    expect(diffPermissions(grown, old)).toEqual({ expanded: false, added: [] });
    // Identical sets: not an expansion either.
    expect(diffPermissions(old, old)).toEqual({ expanded: false, added: [] });
  });

  it('sorts the added tokens', () => {
    const added = diffPermissions(new Set(), new Set(['mail:z', 'skill:a', 'mcpb:m']));
    expect(added.added).toEqual(['mail:z', 'mcpb:m', 'skill:a']);
  });
});

describe('describePermission', () => {
  it('renders the documented examples', () => {
    expect(describePermission('skill:docx')).toBe('新增技能 docx（对所有 Bot 可见）');
    expect(describePermission('host:api.x.com')).toBe('新增网络主机 api.x.com');
    expect(describePermission('scope:notion:write')).toBe('应用 notion 新增授权范围 write');
    expect(describePermission('mcpb:db')).toBe('新增本地 MCP 服务器 db');
    expect(describePermission('runtime:node')).toBe('需要 Node.js 运行时');
    expect(describePermission('runtime:uv')).toBe('需要 uv 运行时');
    expect(describePermission('config:db:token')).toBe('MCP 服务器 db 新增配置项 token');
    expect(describePermission('mcp-http:docs')).toBe('新增远端 MCP 服务器 docs');
    expect(describePermission('connector:x')).toBe('新增连接应用 x');
    expect(describePermission('mail:x')).toBe('新增邮件模板 x');
  });

  it('returns unknown tokens verbatim', () => {
    expect(describePermission('future:thing')).toBe('future:thing');
    expect(describePermission('nocolon')).toBe('nocolon');
  });
});
