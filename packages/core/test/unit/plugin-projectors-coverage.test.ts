import { describe, expect, it } from 'vitest';
import { pluginContributionKindSchema } from '@kepcup/shared';

import {
  createPluginProjectors,
  PLUGIN_PROJECTOR_ORDER,
  type PluginProjectorsDeps,
} from '../../src/plugins/projectors/index.js';

/**
 * 投影器覆盖率（照 settings-adapters-coverage.test.ts）：`createPluginProjectors`
 * 返回的 kind 集合恰好等于 `pluginContributionKindSchema.options`，且顺序与
 * `PLUGIN_PROJECTOR_ORDER` 一致——新增贡献类别漏接投影器时这里失败。
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

describe('plugin projectors coverage', () => {
  it('one projector per contribution kind, in PLUGIN_PROJECTOR_ORDER', () => {
    const projectors = createPluginProjectors(deps);
    expect([...projectors.map((projector) => projector.kind)]).toEqual([...PLUGIN_PROJECTOR_ORDER]);
    // Set equality against the schema options (schema order is declaration order, the
    // projector order is the projection order — the sets must match exactly).
    expect([...projectors.map((projector) => projector.kind)].sort()).toEqual(
      [...pluginContributionKindSchema.options].sort(),
    );
  });

  it('PLUGIN_PROJECTOR_ORDER itself stays exhaustive and duplicate-free', () => {
    expect(new Set(PLUGIN_PROJECTOR_ORDER).size).toBe(pluginContributionKindSchema.options.length);
  });
});
