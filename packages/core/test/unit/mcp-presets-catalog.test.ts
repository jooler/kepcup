import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadMcpPresetCatalog,
  mcpPresetCatalogSchema,
  mcpPresetEntrySchema,
  parseMcpPresetEntries,
  resolveMcpPresetsDir,
} from '../../src/mcp/presets.js';

/**
 * 精选 MCP 清单（扩展中心「MCP」分组，设计 29 §16 决定 C）：随包清单首期为空且合法；
 * schema 拒绝不安全的包路径 / 非 https 端点；加载器对缺失 / 损坏 / 坏条目 / 重复 id 容错。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const shippedDir = path.join(repoRoot, 'apps/desktop/resources/mcp-presets');

const SHA = 'a'.repeat(64);

function entry(id: string, install: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    section: 'starter',
    displayName: id,
    summary: `${id} 说明`,
    version: '1.0.0',
    install,
  };
}

const tmpDirs: string[] = [];
function tmpCatalog(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-mcp-presets-'));
  tmpDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'catalog.json'), content);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('随包精选 MCP 清单', () => {
  it('catalog.json 合法，首期为空', () => {
    const raw = JSON.parse(readFileSync(path.join(shippedDir, 'catalog.json'), 'utf8')) as unknown;
    const parsed = mcpPresetCatalogSchema.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.presets).toEqual([]);
    expect(loadMcpPresetCatalog({ env: {}, dir: shippedDir })).toEqual([]);
  });

  it('开发态能向上找到资源目录；env 覆盖优先，路径不存在则为 null', () => {
    expect(resolveMcpPresetsDir({})).toBe(shippedDir);
    const dir = tmpCatalog('{"version":1,"presets":[]}');
    expect(resolveMcpPresetsDir({ KEPCUP_MCP_PRESETS: dir })).toBe(dir);
    expect(resolveMcpPresetsDir({ KEPCUP_MCP_PRESETS: path.join(dir, 'nope') })).toBeNull();
  });
});

describe('mcpPresetEntrySchema', () => {
  it('接受三种安装方式并补默认值', () => {
    const mcpb = mcpPresetEntrySchema.parse(
      entry('demo-mcpb', { kind: 'mcpb', file: 'demo.mcpb', sha256: SHA }),
    );
    expect(mcpb.icon).toBe('plug');
    expect(mcpb.tryIt).toBe('');
    const stdio = mcpPresetEntrySchema.parse(
      entry('demo-stdio', { kind: 'stdio', command: 'npx' }),
    );
    expect(stdio.install).toEqual({ kind: 'stdio', command: 'npx', args: [] });
    expect(
      mcpPresetEntrySchema.safeParse(
        entry('demo-http', { kind: 'http', url: 'https://mcp.example.com/mcp' }),
      ).success,
    ).toBe(true);
  });

  it('拒绝目录穿越 / 绝对路径 / 非 https 端点 / 坏哈希 / 坏 id', () => {
    for (const file of ['../x.mcpb', '/etc/passwd', 'a/../b.mcpb', 'a\\b.mcpb', './x.mcpb', '']) {
      expect(
        mcpPresetEntrySchema.safeParse(entry('demo', { kind: 'mcpb', file, sha256: SHA })).success,
        file,
      ).toBe(false);
    }
    expect(
      mcpPresetEntrySchema.safeParse(entry('demo', { kind: 'http', url: 'http://mcp.example.com' }))
        .success,
    ).toBe(false);
    expect(
      mcpPresetEntrySchema.safeParse(entry('demo', { kind: 'mcpb', file: 'a.mcpb', sha256: 'xyz' }))
        .success,
    ).toBe(false);
    expect(
      mcpPresetEntrySchema.safeParse(entry('Bad_ID', { kind: 'stdio', command: 'npx' })).success,
    ).toBe(false);
  });
});

describe('loadMcpPresetCatalog', () => {
  it('坏条目与重复 id 告警跳过，其余保留', () => {
    const warn = vi.fn();
    const dir = tmpCatalog(
      JSON.stringify({
        version: 1,
        presets: [
          entry('good-one', { kind: 'stdio', command: 'npx', args: ['-y', 'pkg'] }),
          { id: 'broken' },
          entry('good-one', { kind: 'stdio', command: 'other' }),
          entry('good-two', { kind: 'http', url: 'https://mcp.example.com/mcp' }),
        ],
      }),
    );
    const presets = loadMcpPresetCatalog({ env: {}, dir, logger: { warn } });
    expect(presets.map((preset) => preset.id)).toEqual(['good-one', 'good-two']);
    expect(presets[0]?.install).toMatchObject({ command: 'npx' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('文件缺失 / 损坏 / schema 不符 → 空清单并告警', () => {
    const warn = vi.fn();
    expect(loadMcpPresetCatalog({ env: {}, dir: null, logger: { warn } })).toEqual([]);
    expect(
      loadMcpPresetCatalog({ env: {}, dir: tmpCatalog('{not json'), logger: { warn } }),
    ).toEqual([]);
    expect(
      loadMcpPresetCatalog({
        env: {},
        dir: tmpCatalog('{"version":0,"presets":[]}'),
        logger: { warn },
      }),
    ).toEqual([]);
    expect(
      loadMcpPresetCatalog({
        env: {},
        dir: path.join(tmpdir(), 'kepcup-no-such-dir'),
        logger: { warn },
      }),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('parseMcpPresetEntries 不修改入参', () => {
    const input = [entry('one-ok', { kind: 'stdio', command: 'npx' })];
    const copy = structuredClone(input);
    parseMcpPresetEntries(input);
    expect(input).toEqual(copy);
  });
});
