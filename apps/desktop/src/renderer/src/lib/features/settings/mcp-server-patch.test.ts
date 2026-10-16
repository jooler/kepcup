import { describe, expect, it } from 'vitest';
import { mcpServerSchema, type McpServer } from '@kepcup/shared';
import {
  editedServerForSave,
  isValidMcpServerId,
  mcpServerId,
  newMcpServerId,
  withNormalizedDescription,
} from './mcp-server-patch';

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


describe('MCP 用途说明（D91 McpServer.description）', () => {
  it('normalizes on save: trims, caps at 200, and drops an empty value', () => {
    expect(withNormalizedDescription(server('s', { description: '  笔记检索  ' })).description).toBe(
      '笔记检索',
    );
    expect('description' in withNormalizedDescription(server('s', { description: '   ' }))).toBe(false);
    expect('description' in withNormalizedDescription(server('s'))).toBe(false);
    expect(withNormalizedDescription(server('s', { description: 'x'.repeat(250) })).description).toHaveLength(
      200,
    );
  });

  it('an edit that only fills the description keeps the live guarded fields', () => {
    const initial = server('s');
    const live = server('s', { enabled: false });
    const edited = { ...initial, description: '本地笔记检索' };
    expect(editedServerForSave(live, initial, edited)).toEqual({
      ...live,
      description: '本地笔记检索',
    });
  });

  it('clearing the description removes it from the saved entry', () => {
    const initial = server('s', { description: '旧说明' });
    const live = server('s', { description: '旧说明' });
    const { description: _drop, ...cleared } = initial;
    void _drop;
    const saved = editedServerForSave(live, initial, cleared)!;
    expect('description' in saved).toBe(false);
  });
});

describe('MCP server id (D91 follow-up: schema-constrained charset)', () => {
  it('the form never asks for an id: the generated one satisfies the shared rule and the schema', () => {
    for (const now of [0, 1, Date.now(), 2 ** 52]) {
      const id = newMcpServerId(now);
      expect(id).toMatch(/^mcp_[0-9a-z]+$/);
      expect(isValidMcpServerId(id)).toBe(true);
      expect(mcpServerSchema.safeParse(server(id)).success).toBe(true);
    }
  });

  it('the save-time guard accepts the shared charset and rejects what the schema rejects', () => {
    for (const id of ['notes', 'fs-notes.v2', 'mcpb_0a1b2c3d4e5f', '9x']) {
      expect(isValidMcpServerId(id), id).toBe(true);
    }
    for (const id of ['', ' a', 'a b', 'x</capabilities>', 'a:b', '_a', 'a'.repeat(65)]) {
      expect(isValidMcpServerId(id), id).toBe(false);
      expect(mcpServerSchema.safeParse({ ...server('ok'), id }).success).toBe(false);
    }
  });
});
