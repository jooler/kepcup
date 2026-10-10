import { describe, expect, it } from 'vitest';
import { mcpTargetLocked } from './mcp-edit';

describe('mcpTargetLocked', () => {
  it('locks url / command of an existing server in the manage view while developer mode is off', () => {
    expect(mcpTargetLocked({ variant: 'manage', developerMode: false, editing: true })).toBe(true);
  });

  it('is unlocked with developer mode on, in the full (developer) view, or for a new draft', () => {
    expect(mcpTargetLocked({ variant: 'manage', developerMode: true, editing: true })).toBe(false);
    expect(mcpTargetLocked({ variant: 'full', developerMode: false, editing: true })).toBe(false);
    expect(mcpTargetLocked({ variant: 'full', developerMode: true, editing: true })).toBe(false);
    expect(mcpTargetLocked({ variant: 'manage', developerMode: false, editing: false })).toBe(
      false,
    );
  });
});
