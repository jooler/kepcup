import { describe, expect, it } from 'vitest';
import { mcpServerId } from './mcp-server-patch';

describe('mcp server card patch', () => {
  it('takes the server id from before, not from an empty or non-string value', () => {
    expect(mcpServerId({ server: ' notes ', enabled: false })).toBe('notes');
    expect(mcpServerId({ enabled: false })).toBeNull();
    expect(mcpServerId({ server: '  ' })).toBeNull();
    expect(mcpServerId({ server: 1 })).toBeNull();
    expect(mcpServerId(null)).toBeNull();
  });
});
