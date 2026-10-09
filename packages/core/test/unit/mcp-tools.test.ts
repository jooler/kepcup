import { describe, expect, it } from 'vitest';
import {
  mcpToolName,
  serversForBot,
  enabledServers,
  type McpServer,
} from '../../src/mcp/service.js';
import {
  mcpReceiptOf,
  selectReadOnlyMcpEntries,
  type McpToolEntry,
} from '../../src/mcp/tools.js';
import { recipientFields, RECIPIENT_VALUE_MAX_CHARS } from '../../src/mcp/recipients.js';
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

describe('W4 exact cards and receipts', () => {
  it('recipientFields lists recipient-like keys in full (nested, camelCase, arrays), redacted', () => {
    const long = Array.from({ length: 60 }, (_, i) => `user${i}@example.com`);
    const fields = recipientFields(
      {
        to: long,
        Cc: 'boss@example.com',
        body: 'x'.repeat(1000),
        message: { chatId: 42, text: 'hi', meta: { phoneNumber: '+86 138 0000 0000' } },
        token: 'sk-SECRET',
        channel: '',
        user: { id: 'U1', apiKey: 'sk-SECRET' },
      },
      (text) => text.split('sk-SECRET').join('«secret»'),
    );
    // 复查: an object under a recipient key is not a value (only strings /
    // numbers and arrays of them); its own keys are searched instead.
    expect(fields.map((f) => f.key)).toEqual([
      'to',
      'Cc',
      'message.chatId',
      'message.meta.phoneNumber',
    ]);
    expect(fields[0]!.value).toBe(long.join(', '));
    expect(fields[0]!.value.length).toBeGreaterThan(400);
    expect(fields[2]!.value).toBe('42');
    expect(recipientFields({ to: ['a@x', { b: 1 }] }, (t) => t)).toEqual([]);
    expect(recipientFields({ to: { email: 'c@x' } }, (t) => t)).toEqual([
      { key: 'to.email', value: 'c@x' },
    ]);
    expect(
      recipientFields({ to: 'sk-SECRET@x' }, (t) => t.split('sk-SECRET').join('«secret»')),
    ).toEqual([{ key: 'to', value: '«secret»@x' }]);
    expect(recipientFields({ text: 'hi', subject: 's' }, (t) => t)).toEqual([]);
    const huge = recipientFields({ to: 'a'.repeat(RECIPIENT_VALUE_MAX_CHARS + 5) }, (t) => t);
    expect(huge[0]!.value).toContain('已截断');
  });

  it('mcpReceiptOf picks url / id from structured content or a lone JSON text block', () => {
    expect(
      mcpReceiptOf({ structuredContent: { html_url: 'https://gh.example/i/1', number: 7 } }, []),
    ).toEqual({ url: 'https://gh.example/i/1', externalId: '7' });
    expect(mcpReceiptOf({}, ['{"id":"m-1","url":"https://chat.example/m/1"}'])).toEqual({
      url: 'https://chat.example/m/1',
      externalId: 'm-1',
    });
    // Not an http(s) URL → not a receipt link; nothing usable → null.
    expect(mcpReceiptOf({ structuredContent: { url: 'javascript:alert(1)' } }, [])).toBeNull();
    expect(mcpReceiptOf({}, ['发送成功'])).toBeNull();
    expect(mcpReceiptOf({}, ['{"id":1}', 'more'])).toBeNull();
    expect(mcpReceiptOf({}, ['[1,2]'])).toBeNull();
  });

  it('复查 S3: receipts keep id-shaped values only and strip URL query / fragment', () => {
    // key / uid are not receipt keys any more.
    expect(mcpReceiptOf({ structuredContent: { key: 'abc', uid: 'u1' } }, [])).toBeNull();
    // Secret-looking or non-id-shaped values are dropped.
    for (const id of [
      'sk-proj-abcdef',
      'ghp_abcdefghijklmnop',
      'xoxb-123-456',
      'AKIAABCDEFGHIJKLMNOP',
      'has space',
      'x'.repeat(65),
      'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3', // > 32 chars, mixed case + digits
    ]) {
      expect(mcpReceiptOf({ structuredContent: { id } }, [])).toBeNull();
    }
    expect(
      mcpReceiptOf({ structuredContent: { id: '550e8400-e29b-41d4-a716-446655440000' } }, []),
    ).toEqual({ externalId: '550e8400-e29b-41d4-a716-446655440000' });
    expect(
      mcpReceiptOf(
        { structuredContent: { url: 'https://user:pw@chat.example/m/1?token=abc#frag', id: 9 } },
        [],
      ),
    ).toEqual({ url: 'https://chat.example/m/1', externalId: '9' });
  });
});
