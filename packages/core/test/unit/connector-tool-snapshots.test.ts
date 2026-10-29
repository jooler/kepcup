import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyAppToolRisk,
  connectorCatalogEntrySchema,
  connectorMetaOf,
  type McpToolRisk,
} from '@kepcup/shared';
import { readShippedConnectorEntries } from '../support/shipped-connectors.js';

/**
 * 真实工具定义快照（`test/fixtures/connectors/<slug>.tools.json`，README 有导出方法）与目录条目的
 * 一致性——「测好一家，放行一家」的守门测试（todo/extension-center.md §4）：
 * - 每个有快照的条目（新连接器上架前先导出）必须有完整注解覆盖；
 * - 快照里每个工具都带风险注解（注解覆盖率 100%），否则放行前必须在 `toolPolicy` 里逐个定档；
 * - `toolPolicy` 的键必须是快照里真实存在的工具（防拼写错误）；`whoami.tool` 必须存在且判为只读；
 * - 分级分布钉死：上游悄悄改了工具 / 注解后重新导出快照，这里会红，逼着人重新看一遍。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixturesDir = path.join(repoRoot, 'packages/core/test/fixtures/connectors');
const shipped = readShippedConnectorEntries();

interface SnapshotTool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

const entries = shipped.map((raw) => {
  const entry = connectorCatalogEntrySchema.parse(raw);
  return { entry, meta: connectorMetaOf(entry) };
});

function loadSnapshot(slug: string): SnapshotTool[] | null {
  const file = path.join(fixturesDir, `${slug}.tools.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as SnapshotTool[];
}

function distribution(slug: string): Record<McpToolRisk, number> {
  const tools = loadSnapshot(slug) ?? [];
  const found = entries.find((candidate) => candidate.meta.slug === slug);
  if (found === undefined) throw new Error(`no catalog entry ${slug}`);
  const counts: Record<McpToolRisk, number> = { read: 0, write: 0, destructive: 0 };
  for (const tool of tools) {
    const { risk } = classifyAppToolRisk(
      { name: tool.name, annotations: tool.annotations },
      { tier: found.meta.tier, toolPolicy: found.meta.toolPolicy },
    );
    counts[risk] += 1;
  }
  return counts;
}

describe('connectors with a tool snapshot: unique names, full annotation coverage', () => {
  // 目录通道及其发行门禁已随商店化移除；守门对象 = 快照存在的条目
  // （新连接器上架时先导出快照，这里逼着人把注解 / toolPolicy 定全）。
  const snapshotSlugs = entries
    .map((e) => e.meta.slug)
    .filter((slug) => loadSnapshot(slug) !== null);
  expect(snapshotSlugs.length).toBeGreaterThan(0);
  for (const slug of snapshotSlugs) {
    const found = entries.find((candidate) => candidate.meta.slug === slug)!;
    it(`${slug}: unique tool names, full annotation coverage`, () => {
      const tools = loadSnapshot(slug) ?? [];
      expect(tools.length).toBeGreaterThan(0);
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
      const missing = tools
        .filter(
          (tool) =>
            tool.annotations?.readOnlyHint === undefined &&
            tool.annotations?.destructiveHint === undefined &&
            found.meta.toolPolicy[tool.name] === undefined,
        )
        .map((tool) => tool.name);
      expect(missing, 'tools with neither annotations nor a toolPolicy entry').toEqual([]);
    });
  }
});

describe('catalog toolPolicy / whoami reference real tools', () => {
  for (const { meta } of entries) {
    const tools = loadSnapshot(meta.slug);
    if (tools === null) continue;
    const names = new Set(tools.map((tool) => tool.name));
    it(`${meta.slug}: toolPolicy keys exist in the snapshot`, () => {
      for (const key of Object.keys(meta.toolPolicy)) expect(names.has(key), key).toBe(true);
    });
    it(`${meta.slug}: whoami tool exists and is read-only`, () => {
      if (meta.whoami === undefined) return;
      expect(names.has(meta.whoami.tool)).toBe(true);
      expect(distribution(meta.slug).read).toBeGreaterThan(0);
      const tool = tools.find((candidate) => candidate.name === meta.whoami?.tool);
      const risk = classifyAppToolRisk(
        { name: meta.whoami.tool, annotations: tool?.annotations },
        { tier: meta.tier, toolPolicy: meta.toolPolicy },
      ).risk;
      expect(risk).toBe('read');
    });
  }
});

describe('risk distribution of the snapshots (re-export => review)', () => {
  it('notion: 50 tools; create-comment raised to destructive (visible to others, notifies)', () => {
    expect(distribution('notion')).toEqual({ read: 30, write: 12, destructive: 8 });
    const notion = entries.find((candidate) => candidate.meta.slug === 'notion');
    expect(notion?.meta.toolPolicy['notion-create-comment']).toEqual({ risk: 'destructive' });
  });

  it('linear: 64 tools; server-declared destructive tools are kept as declared (no downgrade)', () => {
    expect(distribution('linear')).toEqual({ read: 37, write: 5, destructive: 22 });
    const linear = entries.find((candidate) => candidate.meta.slug === 'linear');
    expect(linear?.meta.toolPolicy).toEqual({});
  });
});
