import { describe, expect, it } from 'vitest';
import {
  capabilityRows,
  effectiveCapabilities,
  engineValue,
  estimatedTools,
  normalizeCapabilities,
  parseEngineValue,
  toggleCapability,
  toggleCapabilityOptIn,
  toolCountOf,
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

describe('邮件包预估（D91 邮箱门控）', () => {
  it('mail_request_setup 始终注册、五个读写工具在有绑定时再加，预估按登记的 6 个计', () => {
    expect(toolCountOf('mail')).toBe(6);
  });
});

describe('包内选项（settings:change，todo/conversational-app-setup.md §5.3 第 7 条）', () => {
  it('settings 包默认注入、三个工具；修改设置默认关闭（行里只计两个）', () => {
    expect(toolCountOf('settings')).toBe(3);
    expect(effectiveCapabilities(null, codexLike)).toContain('settings');
    expect(effectiveCapabilities(null, codexLike)).not.toContain('settings:change');
    const row = capabilityRows(null, { ...codexLike, prerequisiteReady: ready }).find(
      (entry) => entry.id === 'settings',
    )!;
    expect(row.optIns).toEqual([
      { id: 'settings:change', checked: false, i18nKey: 'agents.capabilities.settings.change' },
    ]);
    expect(row.toolCount).toBe(2);
  });

  it('开启选项后保留在显式集合里，行里计入工具，且不再等同默认值', () => {
    const on = toggleCapabilityOptIn(null, 'settings:change', true, codexLike);
    expect(on).toContain('settings');
    expect(on).toContain('settings:change');
    expect(effectiveCapabilities(on, codexLike)).toContain('settings:change');
    expect(normalizeCapabilities(on, codexLike)).toEqual(on);
    const row = capabilityRows(on, { ...codexLike, prerequisiteReady: ready }).find(
      (entry) => entry.id === 'settings',
    )!;
    expect(row.optIns[0]!.checked).toBe(true);
    expect(row.toolCount).toBe(3);
    // 关掉选项：回到默认值（null）。
    const off = toggleCapabilityOptIn(on, 'settings:change', false, codexLike);
    expect(off).not.toContain('settings:change');
    expect(normalizeCapabilities(off, codexLike)).toBeNull();
  });

  it('勾选 / 取消其它包时保留已开启的选项；取消所属包时选项随之去掉', () => {
    const on = toggleCapabilityOptIn(null, 'settings:change', true, codexLike);
    const withWeb = toggleCapability(on, 'web', true, codexLike);
    expect(withWeb).toContain('web');
    expect(withWeb).toContain('settings:change');
    const withoutSettings = toggleCapability(withWeb, 'settings', false, codexLike);
    expect(withoutSettings).not.toContain('settings');
    expect(withoutSettings).not.toContain('settings:change');
    // 所属包没选时开选项不生效；不认识的选项 id 忽略。
    expect(
      toggleCapabilityOptIn(withoutSettings, 'settings:change', true, codexLike),
    ).not.toContain('settings:change');
    expect(toggleCapabilityOptIn(null, 'bogus:x', true, codexLike)).not.toContain('bogus:x');
  });
});
