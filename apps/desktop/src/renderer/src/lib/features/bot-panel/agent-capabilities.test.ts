import { describe, expect, it } from 'vitest';
import {
  capabilityRows,
  effectiveCapabilities,
  engineValue,
  estimatedTools,
  normalizeCapabilities,
  parseEngineValue,
  toggleCapability,
} from './agent-capabilities';

const codexLike = { nativeCapabilities: { web: ['web_search'], image_generation: ['image_gen'] } };
const ready = () => true;

describe('agent capability packs (Bot runtime form)', () => {
  it('defaults: core required, native-covered supplement packs unchecked', () => {
    const selected = effectiveCapabilities(null, codexLike);
    expect(selected).toContain('core');
    expect(selected).toContain('memory');
    expect(selected).not.toContain('web');
    expect(selected).not.toContain('image_generation');
    expect(selected).toContain('image_understanding');
  });

  it('rows carry required / native / unconfigured flags and tool counts', () => {
    const rows = capabilityRows(null, {
      ...codexLike,
      prerequisiteReady: (prerequisite) => prerequisite.kind !== 'web-search',
    });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.core).toMatchObject({ required: true, checked: true, toolCount: 7 });
    expect(byId.web).toMatchObject({
      checked: false,
      nativeTools: ['web_search'],
      unconfigured: true,
    });
    expect(byId.browser).toMatchObject({ toolCount: 9, nativeTools: [] });
    expect(byId.mcp).toMatchObject({ toolCount: null });
    const estimate = estimatedTools(rows);
    expect(estimate.mcp).toBe(true);
    expect(estimate.count).toBeGreaterThan(20);
  });

  it('core cannot be unchecked; matching the defaults collapses back to null', () => {
    expect(toggleCapability(null, 'core', false, codexLike)).toContain('core');
    const withWeb = toggleCapability(null, 'web', true, codexLike);
    expect(withWeb).toContain('web');
    expect(normalizeCapabilities(withWeb, codexLike)).toEqual(withWeb);
    const back = toggleCapability(withWeb, 'web', false, codexLike);
    expect(normalizeCapabilities(back, codexLike)).toBeNull();
    // Unknown stored ids are dropped.
    expect(effectiveCapabilities(['memory', 'nope'], codexLike)).toEqual(['core', 'memory']);
    expect(capabilityRows(['memory'], { ...codexLike, prerequisiteReady: ready })[0]!.checked).toBe(
      true,
    );
  });

  it('encodes the model / agent selector value', () => {
    expect(engineValue({ model: 'deepseek/chat', agent: { id: '' } })).toBe('deepseek/chat');
    expect(engineValue({ model: 'deepseek/chat', agent: { id: 'codex' } })).toBe('@agent:codex');
    expect(parseEngineValue('@agent:codex')).toEqual({ agentId: 'codex' });
    expect(parseEngineValue('')).toEqual({ model: '' });
  });
});
