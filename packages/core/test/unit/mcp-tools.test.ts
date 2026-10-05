import { describe, expect, it } from 'vitest';
import {
  mcpToolName,
  serversForBot,
  enabledServers,
  type McpServer,
} from '../../src/mcp/service.js';

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
