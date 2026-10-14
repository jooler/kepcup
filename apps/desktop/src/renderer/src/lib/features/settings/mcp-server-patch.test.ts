import { describe, expect, it } from 'vitest';
import type { McpServer } from '@kepcup/shared';
import { editedServerForSave, mcpServerId } from './mcp-server-patch';

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
});

describe('MCP edit form save (D89 review: only edited fields, guarded fields stay live)', () => {
  it('a rename saved after the bot disabled the server keeps it disabled', () => {
    const initial = server('s', { enabled: true, name: 'Old' });
    const live = server('s', { enabled: false, name: 'Old' });
    const edited = { ...initial, name: 'New' };
    expect(editedServerForSave(live, initial, edited)).toEqual({ ...live, name: 'New' });
  });

  it('enabled / autoApprove / toolPolicies always come from the live server', () => {
    const initial = server('s', { autoApprove: false, toolPolicies: { a: { approval: 'ask' } } });
    const live = server('s', { autoApprove: false, enabled: false });
    const edited = { ...initial, enabled: true, autoApprove: true, command: 'node' };
    const saved = editedServerForSave(live, initial, edited)!;
    expect(saved.enabled).toBe(false);
    expect(saved.autoApprove).toBe(false);
    expect(saved.toolPolicies).toBeUndefined();
    expect(saved.command).toBe('node');
  });

  it('fields the form removed are removed; untouched fields follow concurrent edits', () => {
    const initial = server('s', { headers: { A: 'x' }, args: ['1'] });
    const live = server('s', { headers: { A: 'x' }, args: ['2'] });
    const { headers: _drop, ...edited } = initial;
    void _drop;
    expect(editedServerForSave(live, initial, edited as McpServer)).toEqual(
      server('s', { args: ['2'] }),
    );
  });

  it('a new server is saved as typed; one deleted elsewhere during editing is not revived', () => {
    const fresh = server('n');
    expect(editedServerForSave(undefined, null, fresh)).toBe(fresh);
    expect(editedServerForSave(undefined, server('s'), server('s', { name: 'x' }))).toBeNull();
  });
});

