import { describe, expect, it } from 'vitest';
import type { AppToolDefinition, AppToolView } from '@kepcup/shared';
import {
  TOOL_POLICY_CHOICES,
  TOOL_STATE_LABEL_KEYS,
  definitionLines,
  diffLines,
  diffStats,
  isPendingTool,
  pendingToolNames,
  pendingTotal,
  policyForChoice,
  splitTools,
  toolDefinitionDiff,
  toolPolicyChoice,
} from './app-tools';

/** 连接详情的工具视图纯函数（D73 §5.9）：待复核拆分、策略映射、定义对比。 */

function definition(name: string, overrides: Partial<AppToolDefinition> = {}): AppToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    ...overrides,
  };
}

function tool(name: string, overrides: Partial<AppToolView> = {}): AppToolView {
  const def = definition(name);
  return {
    toolName: name,
    risk: 'read',
    state: 'approved',
    policy: null,
    enabled: true,
    approval: 'auto',
    exposed: true,
    definition: def,
    approvedDefinition: def,
    ...overrides,
  };
}

describe('tool lists', () => {
  it('splits pending (new / changed) from approved and sorts each by name', () => {
    const tools = [
      tool('zeta'),
      tool('beta', { state: 'new', approvedDefinition: null }),
      tool('alpha'),
      tool('gamma', { state: 'changed' }),
    ];
    const split = splitTools(tools);
    expect(split.approved.map((t) => t.toolName)).toEqual(['alpha', 'zeta']);
    expect(split.pending.map((t) => t.toolName)).toEqual(['beta', 'gamma']);
    expect(pendingToolNames(tools)).toEqual(['beta', 'gamma']);
    expect(isPendingTool({ state: 'approved' })).toBe(false);
    expect(isPendingTool({ state: 'changed' })).toBe(true);
  });

  it('has a label key for every state and sums the pending summary', () => {
    expect(Object.keys(TOOL_STATE_LABEL_KEYS).sort()).toEqual(['approved', 'changed', 'new']);
    expect(pendingTotal({ added: 2, changed: 3 })).toBe(5);
  });
});

describe('policies', () => {
  it('maps the stored policy onto the dropdown choice', () => {
    expect(toolPolicyChoice({ policy: null })).toBe('default');
    expect(toolPolicyChoice({ policy: {} })).toBe('default');
    expect(toolPolicyChoice({ policy: { approval: 'ask' } })).toBe('ask');
    expect(toolPolicyChoice({ policy: { approval: 'auto' } })).toBe('auto');
    // 停用优先于审批方式
    expect(toolPolicyChoice({ policy: { enabled: false, approval: 'auto' } })).toBe('disabled');
  });

  it('maps every choice back onto a whole-replacement policy', () => {
    expect(TOOL_POLICY_CHOICES).toEqual(['default', 'auto', 'ask', 'disabled']);
    expect(policyForChoice('default')).toEqual({});
    expect(policyForChoice('auto')).toEqual({ approval: 'auto' });
    expect(policyForChoice('ask')).toEqual({ approval: 'ask' });
    expect(policyForChoice('disabled')).toEqual({ enabled: false });
    for (const choice of TOOL_POLICY_CHOICES) {
      expect(toolPolicyChoice({ policy: policyForChoice(choice) })).toBe(choice);
    }
  });
});

describe('definitionLines', () => {
  it('renders title, multi-line description, annotations and schema in a stable key order', () => {
    const lines = definitionLines({
      name: 'search',
      inputSchema: { properties: { q: { type: 'string' } }, type: 'object' },
      description: 'line one\nline two',
      title: 'Search',
      annotations: { readOnlyHint: true },
      outputSchema: { type: 'object' },
    } as AppToolDefinition);
    expect(lines[0]).toBe('title: Search');
    expect(lines.slice(1, 4)).toEqual(['description:', '  line one', '  line two']);
    expect(lines).toContain('annotations:');
    expect(lines).toContain('inputSchema:');
    // 其余字段（outputSchema）在头部字段之后；name 不参与。
    expect(lines.indexOf('outputSchema:')).toBeGreaterThan(lines.indexOf('inputSchema:'));
    expect(lines.some((line) => line.startsWith('name'))).toBe(false);
  });

  it('is insensitive to object key order', () => {
    const a = definitionLines(definition('t', { inputSchema: { a: 1, b: { c: 2, d: 3 } } }));
    const b = definitionLines(definition('t', { inputSchema: { b: { d: 3, c: 2 }, a: 1 } }));
    expect(a).toEqual(b);
  });

  it('skips absent fields', () => {
    expect(definitionLines({ name: 'bare' })).toEqual([]);
  });
});

describe('diffLines', () => {
  it('returns all-same for identical input and nothing for empty input', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
    ]);
    expect(diffLines([], [])).toEqual([]);
  });

  it('marks pure insertions and deletions', () => {
    expect(diffLines([], ['x', 'y'])).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
    expect(diffLines(['x'], [])).toEqual([{ kind: 'del', text: 'x' }]);
  });

  it('keeps the common prefix / suffix and diffs the middle', () => {
    const lines = diffLines(
      ['head', 'old', 'keep', 'tail'],
      ['head', 'new', 'keep', 'extra', 'tail'],
    );
    expect(lines).toEqual([
      { kind: 'same', text: 'head' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'same', text: 'keep' },
      { kind: 'add', text: 'extra' },
      { kind: 'same', text: 'tail' },
    ]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it('falls back to whole-block replace for huge inputs instead of running LCS', () => {
    const before = Array.from({ length: 1500 }, (_, i) => `b${i}`);
    const after = Array.from({ length: 1500 }, (_, i) => `a${i}`);
    const started = Date.now();
    const lines = diffLines(before, after);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(lines).toHaveLength(3000);
    expect(lines.slice(0, 1500).every((line) => line.kind === 'del')).toBe(true);
    expect(lines.slice(1500).every((line) => line.kind === 'add')).toBe(true);
  });
});

describe('toolDefinitionDiff', () => {
  it('shows a never-approved tool as all additions', () => {
    const lines = toolDefinitionDiff(tool('fresh', { state: 'new', approvedDefinition: null }));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.kind === 'add')).toBe(true);
    expect(diffStats(lines).removed).toBe(0);
  });

  it('is empty-of-changes when the definitions match', () => {
    const lines = toolDefinitionDiff(tool('same'));
    expect(lines.every((line) => line.kind === 'same')).toBe(true);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
  });

  it('isolates a changed description to one deleted and one added line', () => {
    const lines = toolDefinitionDiff(
      tool('search', {
        state: 'changed',
        definition: definition('search', { description: 'search, now with delete' }),
        approvedDefinition: definition('search', { description: 'search' }),
      }),
    );
    expect(lines.filter((line) => line.kind !== 'same')).toEqual([
      { kind: 'del', text: '  search' },
      { kind: 'add', text: '  search, now with delete' },
    ]);
  });

  it('surfaces a new required parameter in the schema', () => {
    const lines = toolDefinitionDiff(
      tool('send', {
        state: 'changed',
        definition: definition('send', {
          inputSchema: { type: 'object', properties: { to: {}, body: {} }, required: ['to'] },
        }),
        approvedDefinition: definition('send', {
          inputSchema: { type: 'object', properties: { to: {}, body: {} } },
        }),
      }),
    );
    const added = lines.filter((line) => line.kind === 'add').map((line) => line.text.trim());
    expect(added.join('\n')).toContain('"required"');
    expect(added.join('\n')).toContain('"to"');
    // 旧定义的每一行都仍在（只增不删）。
    expect(diffStats(lines).removed).toBe(0);
  });
});
