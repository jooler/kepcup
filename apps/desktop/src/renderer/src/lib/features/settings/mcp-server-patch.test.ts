import { describe, expect, it } from 'vitest';
import type { McpServer } from '@kepcup/shared';
import { mcpServerId, patchMcpServerEnabled } from './mcp-server-patch';

function server(id: string, patch: Partial<McpServer> = {}): McpServer {
  return {
    id,
    name: id,
    transport: 'stdio',
    command: 'echo',
    enabled: true,
    autoApprove: false,
    auth: 'none',
    ...patch,
  };
}

describe('mcp server card patch', () => {
  it('takes the server id from before, not from an empty or non-string value', () => {
    expect(mcpServerId({ server: ' notes ', enabled: false })).toBe('notes');
    expect(mcpServerId({ enabled: false })).toBeNull();
    expect(mcpServerId({ server: '  ' })).toBeNull();
    expect(mcpServerId({ server: 1 })).toBeNull();
    expect(mcpServerId(null)).toBeNull();
  });

  it('flips only that server enabled and keeps siblings and tool policies', () => {
    const notes = server('notes', {
      enabled: true,
      toolPolicies: { search: { approval: 'ask' } },
      autoApprove: true,
    });
    const other = server('other', { enabled: false, name: 'Other' });
    const patched = patchMcpServerEnabled([notes, other], 'notes', false);
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.servers).toEqual([
      { ...notes, enabled: false },
      other,
    ]);
    expect(patched.servers[1]).toBe(other);
    expect(notes.enabled).toBe(true);
    expect(notes.toolPolicies).toEqual({ search: { approval: 'ask' } });
  });

  it('does not rewrite the list when the server is gone', () => {
    const notes = server('notes');
    expect(patchMcpServerEnabled([notes], 'gone', false)).toEqual({ ok: false });
    expect(notes.enabled).toBe(true);
  });
});
