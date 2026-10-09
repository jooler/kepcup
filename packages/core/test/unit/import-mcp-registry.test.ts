import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_META_KEY, connectorCatalogEntrySchema } from '@kepcup/shared';

/**
 * `scripts/import-mcp-registry.mjs`（D73 P1 §5.2）：从 Registry 导出 server.json 骨架。
 * 不联网：fetch 注入，另用本地夹具文件。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const script = pathToFileURL(
  path.resolve(here, '../../../../scripts/import-mcp-registry.mjs'),
).href;
const fixture = path.resolve(here, '../fixtures/mcp-registry-servers.json');

interface SkeletonEntry {
  name: string;
  title: string;
  remotes: unknown[];
  packages?: unknown[];
  _meta: Record<string, { slug: string; privacyPolicy: string; releaseGate: string }>;
}

interface ImportModule {
  fetchServerJson(
    name: string,
    options?: { registry?: string; fetch?: (url: string, init?: unknown) => Promise<unknown> },
  ): Promise<Record<string, unknown>>;
  toSkeleton(server: Record<string, unknown>): { entry: SkeletonEntry; todo: string[] };
  slugFromName(name: string): string;
}
const mod = (await import(/* @vite-ignore */ script)) as ImportModule;

describe('import-mcp-registry', () => {
  it('derives slugs that satisfy the catalog charset', () => {
    expect(mod.slugFromName('com.notion/mcp')).toBe('notion');
    expect(mod.slugFromName('app.linear/linear')).toBe('linear');
    expect(mod.slugFromName('com.canva.mcp/mcp')).toBe('canva');
    expect(mod.slugFromName('io.github.Some-Org/My_Server.v2')).toMatch(/^[a-z0-9]{2,16}$/);
  });

  it('picks the isLatest version from a local registry file', async () => {
    const server = await mod.fetchServerJson('com.example/mcp', { registry: fixture });
    expect(server.version).toBe('1.0.1');
    await expect(mod.fetchServerJson('com.none/x', { registry: fixture })).rejects.toThrow(
      /unknown registry name/,
    );
  });

  it('calls GET /v0.1/servers/{name}/versions/latest on an https registry (injected fetch)', async () => {
    const calls: string[] = [];
    const server = await mod.fetchServerJson('com.example/mcp', {
      registry: 'https://registry.test/',
      fetch: async (url) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ server: { name: 'com.example/mcp', version: '2.0.0' }, _meta: {} }),
        };
      },
    });
    expect(calls).toEqual(['https://registry.test/v0.1/servers/com.example%2Fmcp/versions/latest']);
    expect(server.version).toBe('2.0.0');
    await expect(
      mod.fetchServerJson('x/y', {
        registry: 'https://registry.test',
        fetch: async () => ({ ok: false, status: 404 }),
      }),
    ).rejects.toThrow(/unknown registry name/);
    await expect(
      mod.fetchServerJson('x/y', {
        registry: 'https://registry.test',
        fetch: async () => ({ ok: false, status: 500 }),
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('produces a skeleton whose only schema failure is the TODO privacy policy', async () => {
    const server = await mod.fetchServerJson('com.example/mcp', { registry: fixture });
    const { entry, todo } = mod.toSkeleton(server);
    expect(entry.name).toBe('com.example/mcp');
    expect(entry.remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
      { type: 'sse', url: 'https://mcp.example.com/sse' },
    ]);
    const meta = entry._meta[CONNECTOR_META_KEY];
    expect(meta.privacyPolicy).toBe('TODO');
    expect(meta.releaseGate).toBe(meta.slug);
    const result = connectorCatalogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual([
        `_meta.${CONNECTOR_META_KEY}.privacyPolicy`,
      ]);
    }
    expect(
      connectorCatalogEntrySchema.safeParse({
        ...entry,
        _meta: { [CONNECTOR_META_KEY]: { ...meta, privacyPolicy: 'https://example.com/privacy' } },
      }).success,
    ).toBe(true);
    expect(todo.some((line) => line.includes('privacyPolicy'))).toBe(true);
  });

  it('drops headers/variables and non-mcpb packages with a TODO note', async () => {
    const server = await mod.fetchServerJson('io.github.acme/widget-server', { registry: fixture });
    const { entry, todo } = mod.toSkeleton(server);
    expect(entry.remotes).toEqual([
      { type: 'streamable-http', url: 'https://{tenant}.acme.dev/mcp' },
    ]);
    expect(entry.packages).toEqual([
      {
        registryType: 'mcpb',
        identifier: 'https://dl.acme.dev/widget.mcpb',
        version: '0.3.0',
        fileSha256: '0'.repeat(64),
      },
    ]);
    expect(todo.join('\n')).toMatch(/headers\/variables/);
    expect(todo.join('\n')).toMatch(/URL template/);
    expect(entry.title).toBe('widget-server');
  });

  it('script file is committed with a shebang', () => {
    expect(readFileSync(fileURLToPath(script), 'utf8').startsWith('#!/usr/bin/env node')).toBe(
      true,
    );
  });
});
