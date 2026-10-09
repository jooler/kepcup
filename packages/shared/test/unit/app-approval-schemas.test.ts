import { describe, expect, it } from 'vitest';
import {
  approvalDecisionSchema,
  approvalsDecideInputSchema,
  botRuntimeSchema,
  grantDurationSchema,
  mcpToolApprovalPayloadSchema,
} from '../../src/index.js';

/** D73 P1 §5.6 / §5.7：审批载荷、决定、RPC 入参与 Bot 运行配置的 schema 形状。 */

describe('mcpToolApprovalPayloadSchema', () => {
  const base = { serverId: 's', serverName: 'S', toolName: 't' };

  it('stays valid for pre-D73 rows (no connection context, no durations)', () => {
    const parsed = mcpToolApprovalPayloadSchema.parse({
      ...base,
      argsSummary: '{}',
      risk: 'write',
    });
    expect(parsed.connectionId).toBeUndefined();
    expect(parsed.durations).toBeUndefined();
  });

  it('carries the connection context, risk and offered durations', () => {
    const parsed = mcpToolApprovalPayloadSchema.parse({
      ...base,
      risk: 'write',
      connectionId: 'conn_1',
      connectorSlug: 'github',
      accountLabel: 'jyy@example.com',
      durations: ['once', 'conversation', 'bot'],
      argsFull: '{\n}',
    });
    expect(parsed).toMatchObject({
      connectionId: 'conn_1',
      connectorSlug: 'github',
      accountLabel: 'jyy@example.com',
      durations: ['once', 'conversation', 'bot'],
    });
    expect(() => mcpToolApprovalPayloadSchema.parse({ ...base, durations: ['forever'] })).toThrow();
  });
});

describe('durations', () => {
  it('ApprovalDecision and approvals.decide accept bot; grants keep once | conversation', () => {
    expect(approvalDecisionSchema.parse({ duration: 'bot' })).toEqual({ duration: 'bot' });
    expect(
      approvalsDecideInputSchema.parse({ id: 'a', approve: true, duration: 'bot' }).duration,
    ).toBe('bot');
    expect(() =>
      approvalsDecideInputSchema.parse({ id: 'a', approve: true, duration: 'x' }),
    ).toThrow();
    expect(grantDurationSchema.options).toEqual(['once', 'conversation']);
  });
});

describe('botRuntimeSchema.app_connection_ids', () => {
  it('defaults to [] so stored profiles need no migration', () => {
    expect(botRuntimeSchema.parse({}).app_connection_ids).toEqual([]);
    expect(botRuntimeSchema.parse({ app_connection_ids: ['conn_a'] }).app_connection_ids).toEqual([
      'conn_a',
    ]);
    expect(() => botRuntimeSchema.parse({ app_connection_ids: [1] })).toThrow();
  });
});
