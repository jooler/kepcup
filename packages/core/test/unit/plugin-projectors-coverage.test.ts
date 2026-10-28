import { describe, expect, it } from 'vitest';
import {
  pluginContributionKindSchema,
  pluginConnectorContributionSchema,
  pluginMailContributionSchema,
  pluginManifestSchema,
  pluginMcpContributionSchema,
  pluginSkillContributionSchema,
} from '@kepcup/shared';

import { CAPABILITY_KINDS } from '../../src/plugins/kinds.js';
import {
  createPluginProjectors,
  PLUGIN_PROJECTOR_ORDER,
  type PluginProjectorsDeps,
} from '../../src/plugins/projectors/index.js';

/**
 * 投影器覆盖率（照 settings-adapters-coverage.test.ts），D105 起从能力类型注册表
 * （`CAPABILITY_KINDS`）派生：注册表恰好覆盖 `pluginContributionKindSchema` 的全部
 * kind、顺序即投影顺序、每个适配器都能造出投影器并引用 shared 的条目 schema——
 * 新增贡献类别漏注册适配器时这里失败。
 */

const noopLogger = { info() {}, warn() {}, error() {} };

// The coverage test only reads `kind`; every projector stores its deps untouched, so
// structural fakes are enough here.
const deps = {
  skills: { skills: {}, logger: noopLogger },
  mcp: {
    settings: {},
    mcpb: {},
    mcp: {},
    disconnector: {},
    revokeMcpServerChanges: () => {},
    logger: noopLogger,
  },
  connectors: {
    catalog: {},
    connectionStore: {},
    disconnector: {},
    connections: {},
    events: {},
    logger: noopLogger,
  },
} as never as PluginProjectorsDeps;

const CONTRIBUTION_SCHEMAS = {
  skill: pluginSkillContributionSchema,
  mcp: pluginMcpContributionSchema,
  connector: pluginConnectorContributionSchema,
  mail: pluginMailContributionSchema,
} as const;

describe('capability kind registry (D105)', () => {
  it('covers every contribution kind exactly once, and PLUGIN_PROJECTOR_ORDER derives from it', () => {
    expect(CAPABILITY_KINDS.map((adapter) => adapter.kind)).toEqual([...PLUGIN_PROJECTOR_ORDER]);
    expect([...CAPABILITY_KINDS.map((adapter) => adapter.kind)].sort()).toEqual(
      [...pluginContributionKindSchema.options].sort(),
    );
    expect(new Set(CAPABILITY_KINDS.map((adapter) => adapter.kind)).size).toBe(
      pluginContributionKindSchema.options.length,
    );
  });

  it('every adapter references the shared entry schema of its kind', () => {
    for (const adapter of CAPABILITY_KINDS) {
      expect(adapter.contributionSchema).toBe(CONTRIBUTION_SCHEMAS[adapter.kind]);
    }
  });

  it('every adapter builds exactly its projector, and consent keys are unique', () => {
    const projectors = createPluginProjectors(deps);
    expect(projectors.map((projector) => projector.kind)).toEqual(
      CAPABILITY_KINDS.map((adapter) => adapter.kind),
    );
    const consentKeys = CAPABILITY_KINDS.map((adapter) => adapter.consentKey);
    expect(new Set(consentKeys).size).toBe(consentKeys.length);
    for (const adapter of CAPABILITY_KINDS) {
      expect(typeof adapter.instanceFields()).toBe('object');
      expect(typeof adapter.hasContribution).toBe('function');
      expect(typeof adapter.consentItems).toBe('function');
    }
  });

  it('hasContribution mirrors the manifest contribution arrays', () => {
    const parse = (extra: Record<string, unknown>) =>
      pluginManifestSchema.parse({
        format_version: 1,
        id: 'io.a/b',
        name: 'x',
        version: '1.0.0',
        ...extra,
      });
    // A contribution-less manifest is legal via `instances`; every kind reports false.
    const empty = parse({ instances: ['mail'] });
    for (const adapter of CAPABILITY_KINDS) {
      expect(adapter.hasContribution(empty)).toBe(false);
    }
    const byKind = {
      skill: parse({ contributions: { skills: [{ dir: 'skills/docx' }] } }),
      connector: parse({ contributions: { connectors: [{ file: 'connectors/x.json' }] } }),
      mcp: parse({
        contributions: { mcp: [{ kind: 'http', id: 'docs', url: 'https://mcp.example.com/mcp' }] },
      }),
      mail: parse({
        contributions: {
          mail: [
            {
              id: 'fastmail',
              label: 'Fastmail',
              imap: { host: 'imap.fastmail.com', port: 993, secure: 'ssl' },
              smtp: { host: 'smtp.fastmail.com', port: 465, secure: 'ssl' },
            },
          ],
        },
      }),
    } as const;
    for (const adapter of CAPABILITY_KINDS) {
      expect(adapter.hasContribution(byKind[adapter.kind])).toBe(true);
      for (const other of CAPABILITY_KINDS) {
        if (other !== adapter) expect(other.hasContribution(byKind[adapter.kind])).toBe(false);
      }
    }
  });

  it('every projector implements update (P1-2): a new contribution kind cannot skip the update flow', () => {
    const projectors = createPluginProjectors(deps);
    for (const projector of projectors) {
      expect(typeof projector.update).toBe('function');
    }
  });

  it('only mail declares instances today (materializers land P3 / P4-M2)', () => {
    for (const adapter of CAPABILITY_KINDS) {
      expect(adapter.hasInstances).toBe(adapter.kind === 'mail');
    }
  });
});
