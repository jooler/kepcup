import { describe, expect, it } from 'vitest';
import {
  mcpToolName,
  serversForBot,
  enabledServers,
  type McpServer,
} from '../../src/mcp/service.js';
import { selectReadOnlyMcpEntries, type McpToolEntry } from '../../src/mcp/tools.js';
import { decideMcpTool } from '../../src/mcp/policy.js';
import { classifyRiskDetailed } from '../../src/mcp/risk.js';

/**
 * MCP（D65）纯函数单元：命名 sanitize、启用交集、工具面封顶裁剪逻辑。
 * 连接生命周期（懒连接/重连/failed 标记）在集成层覆盖。
 */

describe('mcpToolName', () => {
  it('格式 mcp_{serverId}_{toolName}，sanitize 为 [A-Za-z0-9_-]', () => {
    expect(mcpToolName('srv1', 'read_file')).toBe('mcp_srv1_read_file');
    expect(mcpToolName('my server', 'tool.name')).toBe('mcp_my_server_tool_name');
    expect(mcpToolName('中文', '工具')).toBe('mcp______');
  });

  it('≤64 字符截断', () => {
    const long = mcpToolName('s'.repeat(80), 't'.repeat(80));
    expect(long.length).toBe(64);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

function serverOf(id: string, enabled: boolean): McpServer {
  return {
    id,
    name: id,
    transport: 'stdio',
    command: 'echo',
    enabled,
    autoApprove: false,
  };
}

describe('serversForBot', () => {
  it('应用 enabled ∩ Bot 选中', () => {
    const servers = [serverOf('a', true), serverOf('b', false), serverOf('c', true)];
    expect(enabledServers(servers).map((s) => s.id)).toEqual(['a', 'c']);
    expect(serversForBot(servers, ['a', 'b']).map((s) => s.id)).toEqual(['a']);
    expect(serversForBot(servers, [])).toEqual([]);
    expect(serversForBot(servers, ['b'])).toEqual([]);
  });
});

function entryOf(server: McpServer, name: string, annotations?: Record<string, boolean>): McpToolEntry {
  return {
    server,
    tool: { name, inputSchema: { type: 'object' }, ...(annotations ? { annotations } : {}) },
    name: mcpToolName(server.id, name),
    decision: decideMcpTool(server, name, classifyRiskDetailed({ name, annotations })),
  };
}

describe('selectReadOnlyMcpEntries (W5 turn / read-only subagent surface)', () => {
  it('keeps read + auto tools only, in server order, and counts the rest as omitted', () => {
    const a = { ...serverOf('a', true), toolPolicies: { list_asked: { approval: 'ask' as const } } };
    const b = { ...serverOf('b', true), autoApprove: true };
    const entries = [
      entryOf(a, 'list_files'),
      entryOf(a, 'create_issue', { destructiveHint: false }),
      entryOf(a, 'list_asked'),
      entryOf(b, 'search', { readOnlyHint: true }),
      // autoApprove never lifts a write tool onto the read-only surface.
      entryOf(b, 'send_mail'),
    ];
    const picked = selectReadOnlyMcpEntries(entries);
    expect(picked.entries.map((e) => e.name)).toEqual(['mcp_a_list_files', 'mcp_b_search']);
    expect(picked.omitted).toBe(3);
  });

  it('caps at TURN_MCP_READ_TOOLS_MAX (first N in server order)', () => {
    const server = serverOf('s', true);
    const entries = Array.from({ length: 25 }, (_, i) => entryOf(server, `get_item_${i}`));
    const picked = selectReadOnlyMcpEntries(entries);
    expect(picked.entries).toHaveLength(20);
    expect(picked.entries[0]!.name).toBe('mcp_s_get_item_0');
    expect(picked.entries[19]!.name).toBe('mcp_s_get_item_19');
    expect(picked.omitted).toBe(5);
    expect(selectReadOnlyMcpEntries(entries, 3).entries).toHaveLength(3);
  });
});
