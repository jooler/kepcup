import { describe, expect, it, vi } from 'vitest';
import type { McpServer, PluginManifest } from '@kepcup/shared';

import { createManifestHeaderNormalizer } from '../../src/mcp/header-scheme.js';

/**
 * 发送侧 header 归一化（`start.ts` 用插件清单接线的策略）：只有「实例来源 + 清单里该
 * header 显式声明了 `scheme: 'bearer'`」时才补前缀；通用 MCP、其他 header、清单读不到
 * 的情况一律原样返回——这条规则不允许污染别的 server / 别的 header。
 */

const PLUGIN_ID = 'app.kepcup/mcp-tencent-docs';

function manifestWith(
  headers: Array<{ name: string; key?: string; scheme?: 'bearer' }>,
): PluginManifest {
  return {
    format_version: 1,
    id: PLUGIN_ID,
    name: '腾讯文档',
    version: '1.0.3',
    description: '',
    author: { name: 'KepCup' },
    usage: '',
    engines: { kepcup: '>=0.5.11' },
    instances: ['mcp'],
    contributions: {
      skills: [],
      connectors: [],
      mail: [],
      im: [],
      mcp: [
        {
          kind: 'http',
          id: 'docs',
          url: 'https://docs.qq.com/openapi/mcp',
          auth: 'headers',
          headers,
        },
      ],
    },
    config: { fields: [] },
  } as unknown as PluginManifest;
}

function instanceServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'plg_abc123',
    name: '腾讯文档',
    transport: 'http',
    url: 'https://docs.qq.com/openapi/mcp',
    enabled: true,
    autoApprove: false,
    auth: 'headers',
    headers: {
      Authorization: 'secret:header:Authorization',
      'X-Api-Key': 'secret:header:X-Api-Key',
    },
    source: { kind: 'instance', pluginId: PLUGIN_ID, instanceId: 'pli_1' },
    ...overrides,
  } as McpServer;
}

const BEARER_MANIFEST = manifestWith([
  { name: 'Authorization', key: 'token', scheme: 'bearer' },
  { name: 'X-Api-Key', key: 'apiKey' },
]);

describe('createManifestHeaderNormalizer', () => {
  it('裸 token → 发送值补 `Bearer `', async () => {
    const normalize = createManifestHeaderNormalizer({
      manifestOf: async () => BEARER_MANIFEST,
    });
    await expect(normalize(instanceServer(), 'Authorization', 'tok_abc123')).resolves.toBe(
      'Bearer tok_abc123',
    );
  });

  it('已带前缀（含大小写 / 空白变体）不重复叠加', async () => {
    const normalize = createManifestHeaderNormalizer({
      manifestOf: async () => BEARER_MANIFEST,
    });
    for (const value of ['Bearer tok_abc123', 'bearer tok_abc123', 'BEARER   tok_abc123', ' Bearer\n tok_abc123 ']) {
      await expect(normalize(instanceServer(), 'Authorization', value)).resolves.toBe(
        'Bearer tok_abc123',
      );
    }
  });

  it('同一 server 里未声明方案的 header 原样返回', async () => {
    const normalize = createManifestHeaderNormalizer({
      manifestOf: async () => BEARER_MANIFEST,
    });
    await expect(normalize(instanceServer(), 'X-Api-Key', 'Bearer keep-me')).resolves.toBe(
      'Bearer keep-me',
    );
  });

  it('清单未声明方案时行为不变', async () => {
    const normalize = createManifestHeaderNormalizer({
      manifestOf: async () => manifestWith([{ name: 'Authorization', key: 'token' }]),
    });
    await expect(normalize(instanceServer(), 'Authorization', 'tok_abc123')).resolves.toBe(
      'tok_abc123',
    );
  });

  it('非实例来源（用户手填的 MCP server）不查清单、不改写', async () => {
    const manifestOf = vi.fn(async () => BEARER_MANIFEST);
    const normalize = createManifestHeaderNormalizer({ manifestOf });
    const manual: McpServer = {
      id: 'mcp_manual',
      name: '手填',
      transport: 'http',
      url: 'https://example.com/mcp',
      enabled: true,
      autoApprove: false,
      auth: 'headers',
      headers: { Authorization: 'secret:header:Authorization' },
    } as McpServer;
    await expect(normalize(manual, 'Authorization', 'tok_abc123')).resolves.toBe('tok_abc123');
    expect(manifestOf).not.toHaveBeenCalled();
  });

  it('清单读不到（null / 抛错）时按未声明处理，不阻断连接', async () => {
    const nullManifest = createManifestHeaderNormalizer({ manifestOf: async () => null });
    await expect(nullManifest(instanceServer(), 'Authorization', 'tok')).resolves.toBe('tok');
    const throwing = createManifestHeaderNormalizer({
      manifestOf: async () => {
        throw new Error('disk gone');
      },
    });
    await expect(throwing(instanceServer(), 'Authorization', 'tok')).resolves.toBe('tok');
  });

  it('空值不会被补成 `Bearer `', async () => {
    const normalize = createManifestHeaderNormalizer({
      manifestOf: async () => BEARER_MANIFEST,
    });
    await expect(normalize(instanceServer(), 'Authorization', '')).resolves.toBe('');
  });
});
