import { describe, expect, it } from 'vitest';
import {
  classifyRisk,
  classifyRiskDetailed,
  nameLooksMutating,
  normalizeToolName,
} from '../../src/mcp/risk.js';
import {
  allowedOnReadOnlySurface,
  decideMcpTool,
  effectiveMcpApproval,
  mcpToolEnabled,
} from '../../src/mcp/policy.js';

/**
 * W5 MCP 工具风险分级：注解 × 名字的真值表。注解只能放宽到只读，且受名字
 * 一票否决；无注解 + 明确只读动词名 → 只读；readOnlyHint:false 不走名字放宽；
 * destructiveHint:false 只降到 write。
 */

describe('classifyRisk truth table', () => {
  const cases: Array<{
    name: string;
    annotations?: Record<string, boolean>;
    risk: 'read' | 'write' | 'destructive';
    source: 'annotation' | 'name' | 'default';
  }> = [
    // readOnlyHint:true 放宽到只读……
    { name: 'search_issues', annotations: { readOnlyHint: true }, risk: 'read', source: 'annotation' },
    { name: 'echo', annotations: { readOnlyHint: true }, risk: 'read', source: 'annotation' },
    // ……但名字像写操作时一票否决。
    { name: 'delete_x', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    { name: 'get_and_delete', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    { name: 'deleteFile', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    // 否决后 destructiveHint:false 仍只降到 write。
    {
      name: 'create_note',
      annotations: { readOnlyHint: true, destructiveHint: false },
      risk: 'write',
      source: 'annotation',
    },
    // 复合名字无注解：destructive。
    { name: 'get_and_delete', risk: 'destructive', source: 'default' },
    { name: 'list_then_archive', risk: 'destructive', source: 'default' },
    // 无注解 + 明确只读动词 → 只读（按名字推断）。
    { name: 'list_files', risk: 'read', source: 'name' },
    { name: 'get', risk: 'read', source: 'name' },
    { name: 'getUser', risk: 'read', source: 'name' },
    { name: 'search-docs', risk: 'read', source: 'name' },
    // 只读动词开头但含写动词：否决。
    { name: 'get_or_create_user', risk: 'destructive', source: 'default' },
    { name: 'list_and_send', risk: 'destructive', source: 'default' },
    // readOnlyHint:false 永远不走名字放宽。
    { name: 'get_x', annotations: { readOnlyHint: false }, risk: 'destructive', source: 'annotation' },
    {
      name: 'get_x',
      annotations: { readOnlyHint: false, destructiveHint: false },
      risk: 'write',
      source: 'annotation',
    },
    // 只有其他注解（readOnlyHint 缺失）时名字放宽仍然生效。
    { name: 'list_files', annotations: { openWorldHint: true }, risk: 'read', source: 'name' },
    // destructiveHint:false → write。
    { name: 'create_issue', annotations: { destructiveHint: false }, risk: 'write', source: 'annotation' },
    // destructiveHint:true / 缺省：destructive。
    { name: 'drop_table', annotations: { destructiveHint: true }, risk: 'destructive', source: 'annotation' },
    { name: 'echo', risk: 'destructive', source: 'default' },
    { name: 'create_issue', risk: 'destructive', source: 'default' },
    // 非动词前缀不误判：settings / checkout / runner 不含写动词词元。
    { name: 'settings', annotations: { readOnlyHint: true }, risk: 'read', source: 'annotation' },
    // 扩充的写动词（复查）：声明只读也被否决。
    { name: 'execute_sql', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    { name: 'invokeLambda', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    { name: 'drop_table', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    { name: 'toggle_flag', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    { name: 'checkIn', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    { name: 'check_in_guest', risk: 'destructive', source: 'default' },
    { name: 'list_and_kill', risk: 'destructive', source: 'default' },
    // 也作名词的写动词只在开头时否决：get_commit / get_order / get_sync_status 是读。
    { name: 'commit_changes', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    { name: 'order_pizza', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    { name: 'deploy', annotations: { readOnlyHint: true }, risk: 'destructive', source: 'name' },
    { name: 'get_commit', risk: 'read', source: 'name' },
    { name: 'get_order', risk: 'read', source: 'name' },
    { name: 'get_sync_status', risk: 'read', source: 'name' },
    { name: 'check_status', risk: 'read', source: 'name' },
  ];
  for (const c of cases) {
    it(`${c.name} ${JSON.stringify(c.annotations ?? {})} → ${c.risk} (${c.source})`, () => {
      expect(classifyRiskDetailed({ name: c.name, annotations: c.annotations })).toEqual({
        risk: c.risk,
        source: c.source,
      });
      expect(classifyRisk({ name: c.name, annotations: c.annotations })).toBe(c.risk);
    });
  }
});

describe('name normalization', () => {
  it('splits camelCase, kebab-case and dots into lowercase words', () => {
    expect(normalizeToolName('deleteFile')).toBe('delete_file');
    expect(normalizeToolName('send-mail')).toBe('send_mail');
    expect(normalizeToolName('Get.Items')).toBe('get_items');
    expect(normalizeToolName('parseHTMLDoc')).toBe('parse_html_doc');
  });
  it('mutating veto matches whole words only', () => {
    expect(nameLooksMutating('sendMessage')).toBe(true);
    expect(nameLooksMutating('get_settings')).toBe(false);
    expect(nameLooksMutating('checkout_status')).toBe(false);
    expect(nameLooksMutating('run_query')).toBe(true);
  });
});

describe('per-tool policy (tool policy > server autoApprove > risk default)', () => {
  const base = { autoApprove: false } as const;
  it('defaults: read → auto, write / destructive → ask', () => {
    expect(effectiveMcpApproval(base, 't', 'read')).toEqual({ approval: 'auto', source: 'default' });
    expect(effectiveMcpApproval(base, 't', 'write')).toEqual({ approval: 'ask', source: 'default' });
    expect(effectiveMcpApproval(base, 't', 'destructive')).toEqual({
      approval: 'ask',
      source: 'default',
    });
  });
  it('server autoApprove makes everything auto unless a tool policy says ask', () => {
    const server = { autoApprove: true, toolPolicies: { risky: { approval: 'ask' as const } } };
    expect(effectiveMcpApproval(server, 'other', 'destructive')).toEqual({
      approval: 'auto',
      source: 'server',
    });
    expect(effectiveMcpApproval(server, 'risky', 'read')).toEqual({ approval: 'ask', source: 'policy' });
  });
  it('tool policy auto overrides the default for a write tool', () => {
    const server = { autoApprove: false, toolPolicies: { create_issue: { approval: 'auto' as const } } };
    expect(effectiveMcpApproval(server, 'create_issue', 'write').approval).toBe('auto');
  });
  it('enabled defaults to true; enabled:false hides the tool', () => {
    const server = { autoApprove: false, toolPolicies: { a: { enabled: false }, b: { approval: 'ask' as const } } };
    expect(mcpToolEnabled(server, 'a')).toBe(false);
    expect(mcpToolEnabled(server, 'b')).toBe(true);
    expect(mcpToolEnabled(server, 'c')).toBe(true);
  });
  it('read-only surface admits only enabled read tools with effective approval auto', () => {
    const server = {
      autoApprove: false,
      toolPolicies: { list_asked: { approval: 'ask' as const }, list_off: { enabled: false } },
    };
    const decide = (name: string, risk: 'read' | 'write' | 'destructive') =>
      allowedOnReadOnlySurface(decideMcpTool(server, name, { risk, source: 'name' }));
    expect(decide('list_files', 'read')).toBe(true);
    expect(decide('list_asked', 'read')).toBe(false);
    expect(decide('list_off', 'read')).toBe(false);
    expect(decide('create_issue', 'write')).toBe(false);
    // autoApprove on a write tool never puts it on the read-only surface.
    expect(
      allowedOnReadOnlySurface(
        decideMcpTool({ autoApprove: true }, 'create_issue', { risk: 'write', source: 'annotation' }),
      ),
    ).toBe(false);
  });
});
