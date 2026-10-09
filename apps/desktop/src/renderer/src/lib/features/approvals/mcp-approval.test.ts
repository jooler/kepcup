import { describe, expect, it } from 'vitest';
import type { McpToolApprovalPayload } from '@kepcup/shared';
import {
  appToolArgsView,
  appToolIdentity,
  clampDuration,
  durationForKey,
  foldedApprovedKey,
  mcpChoosesDuration,
  mcpDurationOptions,
} from './mcp-approval';

/** D73 P1：连接应用工具审批卡的纯逻辑。 */

const base: McpToolApprovalPayload = {
  serverId: 'conn_1',
  serverName: 'GitHub',
  toolName: 'create_issue',
  argsSummary: '{"title":"x"}',
  risk: 'write',
  connectionId: 'conn_1',
  connectorSlug: 'github',
  accountLabel: 'jyy@example.com',
  durations: ['once', 'conversation', 'bot'],
};

describe('mcpDurationOptions', () => {
  it('renders exactly the durations the card offers, once first', () => {
    expect(mcpDurationOptions(base)).toEqual(['once', 'conversation', 'bot']);
    expect(mcpDurationOptions({ durations: ['bot', 'once'] })).toEqual(['once', 'bot']);
    expect(mcpChoosesDuration(base)).toBe(true);
  });

  it('defaults to just「仅这一次」(plain MCP cards, destructive app cards)', () => {
    expect(mcpDurationOptions({})).toEqual(['once']);
    expect(mcpDurationOptions({ durations: ['once'] })).toEqual(['once']);
    expect(mcpChoosesDuration({})).toBe(false);
    expect(mcpChoosesDuration({ durations: ['once'] })).toBe(false);
  });

  it('maps the 1/2/3 keys onto the offered options only', () => {
    const options = mcpDurationOptions(base);
    expect(durationForKey(options, '1')).toBe('once');
    expect(durationForKey(options, '3')).toBe('bot');
    expect(durationForKey(options, '4')).toBeNull();
    expect(durationForKey(['once'], '2')).toBeNull();
    expect(durationForKey(options, 'x')).toBeNull();
  });

  it('clamps a stale choice back to once', () => {
    expect(clampDuration('bot', ['once'])).toBe('once');
    expect(clampDuration('conversation', ['once', 'conversation'])).toBe('conversation');
  });
});

describe('appToolIdentity', () => {
  it('names account, app and tool for a connection call', () => {
    expect(appToolIdentity(base)).toEqual({
      account: 'jyy@example.com',
      app: 'GitHub',
      tool: 'create_issue',
    });
  });

  it('falls back to no account when the label is blank; plain MCP cards have no identity', () => {
    expect(appToolIdentity({ ...base, accountLabel: '  ' })?.account).toBeNull();
    const { connectionId: _c, connectorSlug: _s, accountLabel: _a, ...plain } = base;
    expect(appToolIdentity(plain)).toBeNull();
  });
});

describe('appToolArgsView', () => {
  it('shows the full parameters and the irreversible notice for a destructive app call', () => {
    const view = appToolArgsView({
      ...base,
      risk: 'destructive',
      durations: ['once'],
      argsFull: '{\n  "title": "x"\n}',
    });
    expect(view).toEqual({ text: '{\n  "title": "x"\n}', full: true, irreversible: true });
  });

  it('falls back to the summary for old rows without full args; write calls keep the summary', () => {
    expect(appToolArgsView({ ...base, risk: 'destructive' })).toMatchObject({
      text: base.argsSummary,
      full: false,
      irreversible: true,
    });
    expect(appToolArgsView({ ...base, argsFull: 'ignored' })).toMatchObject({
      full: false,
      irreversible: false,
    });
  });

  it('a plain MCP destructive call is not flagged as an irreversible app action', () => {
    const { connectionId: _c, ...plain } = base;
    expect(appToolArgsView({ ...plain, risk: 'destructive' }).irreversible).toBe(false);
  });
});

describe('foldedApprovedKey', () => {
  it('maps the recorded duration to the folded record text', () => {
    expect(foldedApprovedKey('bot')).toBe('approvals.foldedApprovedBot');
    expect(foldedApprovedKey('conversation')).toBe('approvals.foldedApprovedConversation');
    expect(foldedApprovedKey(undefined)).toBe('approvals.foldedApprovedOnce');
  });
});
