import { describe, expect, it } from 'vitest';
import {
  countRiskyTools,
  effectiveApproval,
  mcpUnattendedNotice,
  withToolPolicy,
} from './mcp-risk';

/**
 * W5 渲染端纯逻辑：Bot 详情 MCP 区的无人值守风险提示（选了 server 即常驻；
 * 无人值守生效且有写入 / 破坏性工具时升级为警示并给数量）、设置页逐工具策略
 * 写回。
 */

describe('mcpUnattendedNotice', () => {
  it('is hidden when no MCP server is selected', () => {
    expect(
      mcpUnattendedNotice({ selectedServerCount: 0, unattendedEnabled: true, riskyCount: 3 }),
    ).toEqual({ show: false, warning: false, riskyCount: 3, unknown: false });
  });

  it('is always shown once a server is selected (plain style while attended)', () => {
    expect(
      mcpUnattendedNotice({ selectedServerCount: 1, unattendedEnabled: false, riskyCount: null }),
    ).toEqual({ show: true, warning: false, riskyCount: 0, unknown: false });
    expect(
      mcpUnattendedNotice({ selectedServerCount: 2, unattendedEnabled: false, riskyCount: 4 }).warning,
    ).toBe(false);
  });

  it('turns into a warning with the count when unattended is on and risky tools exist', () => {
    expect(
      mcpUnattendedNotice({ selectedServerCount: 1, unattendedEnabled: true, riskyCount: 2 }),
    ).toEqual({ show: true, warning: true, riskyCount: 2, unknown: false });
    // Only read tools (or risks not loaded yet): the persistent notice stays plain.
    expect(
      mcpUnattendedNotice({ selectedServerCount: 1, unattendedEnabled: true, riskyCount: 0 }).warning,
    ).toBe(false);
    expect(
      mcpUnattendedNotice({ selectedServerCount: 1, unattendedEnabled: true, riskyCount: null })
        .warning,
    ).toBe(false);
  });
});

describe('mcpUnattendedNotice with unreachable servers', () => {
  it('an unknown risk (error / rejection) warns instead of counting as 0', () => {
    expect(
      mcpUnattendedNotice({
        selectedServerCount: 1,
        unattendedEnabled: true,
        riskyCount: 0,
        riskUnknown: true,
      }),
    ).toEqual({ show: true, warning: true, riskyCount: 0, unknown: true });
    // Attended: still the plain persistent notice.
    expect(
      mcpUnattendedNotice({
        selectedServerCount: 1,
        unattendedEnabled: false,
        riskyCount: 0,
        riskUnknown: true,
      }),
    ).toEqual({ show: true, warning: false, riskyCount: 0, unknown: false });
  });
});

describe('countRiskyTools', () => {
  it('counts enabled write / destructive tools that the server still lists', () => {
    const tools = [
      { name: 'list', risk: 'read' as const },
      { name: 'create', risk: 'write' as const },
      { name: 'purge', risk: 'destructive' as const },
      { name: 'off', risk: 'destructive' as const },
      { name: 'gone', risk: 'destructive' as const, missing: true },
    ];
    expect(countRiskyTools({ toolPolicies: { off: { enabled: false } } }, tools)).toBe(2);
    expect(countRiskyTools({}, tools)).toBe(3);
  });
});

describe('withToolPolicy / effectiveApproval', () => {
  it('stores overrides by tool name and drops defaults', () => {
    let policies = withToolPolicy(undefined, 'create', { approval: 'auto' });
    expect(policies).toEqual({ create: { approval: 'auto' } });
    policies = withToolPolicy(policies, 'purge', { enabled: false });
    expect(policies).toEqual({ create: { approval: 'auto' }, purge: { enabled: false } });
    policies = withToolPolicy(policies, 'create', { approval: 'default' });
    expect(policies).toEqual({ purge: { enabled: false } });
    expect(withToolPolicy(policies, 'purge', { enabled: true })).toBeUndefined();
  });

  it('tool policy > server autoApprove > risk default', () => {
    expect(effectiveApproval({ autoApprove: false }, 'x', 'read')).toBe('auto');
    expect(effectiveApproval({ autoApprove: false }, 'x', 'write')).toBe('ask');
    expect(effectiveApproval({ autoApprove: true }, 'x', 'destructive')).toBe('auto');
    expect(
      effectiveApproval({ autoApprove: true, toolPolicies: { x: { approval: 'ask' } } }, 'x', 'read'),
    ).toBe('ask');
  });
});
