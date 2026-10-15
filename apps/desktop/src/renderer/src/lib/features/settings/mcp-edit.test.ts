import { describe, expect, it } from 'vitest';
import { mcpTargetLocked } from './mcp-edit';

describe('mcpTargetLocked', () => {
  it('never locks url / command / args (MCP management is ungated in extension center)', () => {
    expect(mcpTargetLocked({ variant: 'manage', developerMode: false, editing: true })).toBe(false);
    expect(mcpTargetLocked({ variant: 'manage', developerMode: true, editing: true })).toBe(false);
    expect(mcpTargetLocked({ variant: 'full', developerMode: false, editing: true })).toBe(false);
    expect(mcpTargetLocked({ variant: 'full', developerMode: true, editing: true })).toBe(false);
    expect(mcpTargetLocked({ variant: 'manage', developerMode: false, editing: false })).toBe(false);
  });
});
