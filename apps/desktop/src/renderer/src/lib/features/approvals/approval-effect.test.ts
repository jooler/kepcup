import { describe, expect, it } from 'vitest';
import type { Approval } from '@kepcup/shared';
import {
  approvalEffectLine,
  decisionBinding,
  effectStatusLine,
  mergeApprovalUpdate,
  priorEffectFlag,
  priorEffectOf,
  receiptText,
} from './approval-effect';

function approval(patch: Partial<Approval> = {}): Approval {
  return {
    id: 'apr_1',
    kind: 'mcp_tool',
    botId: 'bot_1',
    conversationId: 'conv_1',
    runId: 'run_1',
    payload: { serverId: 's', serverName: 'S', toolName: 'send', argsSummary: '{}' },
    status: 'approved',
    decision: null,
    autoApproved: false,
    messageId: null,
    createdAt: 1,
    decidedAt: 2,
    ...patch,
  };
}

describe('approval receipts (W4)', () => {
  it('shows the ledger outcome under an approved card only', () => {
    expect(approvalEffectLine(approval({ effect: { status: 'completed' } }))).toBe('completed');
    expect(approvalEffectLine(approval({ effect: { status: 'uncertain' } }))).toBe('uncertain');
    expect(approvalEffectLine(approval({ effect: { status: 'failed' } }))).toBe('failed');
    expect(approvalEffectLine(approval({ effect: { status: 'executing' } }))).toBe('executing');
    // Still waiting on its approval: no line.
    expect(approvalEffectLine(approval({ effect: { status: 'intended' } }))).toBeNull();
    // A denied / cancelled card already says how it ended.
    expect(
      approvalEffectLine(approval({ status: 'denied', effect: { status: 'denied' } })),
    ).toBeNull();
    expect(
      approvalEffectLine(approval({ status: 'cancelled', effect: { status: 'denied' } })),
    ).toBeNull();
  });

  it('old approvals without effect / hash / flag keep working', () => {
    const old = approval();
    expect(approvalEffectLine(old)).toBeNull();
    expect(priorEffectOf(old)).toBeNull();
    expect(decisionBinding(old)).toEqual({});
    expect(effectStatusLine(undefined)).toBeNull();
  });

  it('receipt text joins url / id / note; empty receipts give null', () => {
    expect(receiptText({ url: 'https://x.example/1', externalId: '42' })).toBe(
      'https://x.example/1 · 42',
    );
    expect(receiptText({})).toBeNull();
    expect(receiptText(undefined)).toBeNull();
  });

  it('reads the uncertain-duplicate flag from the payload', () => {
    const flagged = approval({
      status: 'pending',
      payload: {
        toolName: 'send',
        priorEffect: { status: 'uncertain', summary: 'mcp_s_send {"to":"a"}', createdAt: 5 },
      },
    });
    expect(priorEffectOf(flagged)).toEqual({
      status: 'uncertain',
      summary: 'mcp_s_send {"to":"a"}',
      createdAt: 5,
    });
    expect(priorEffectOf(approval({ payload: { priorEffect: { status: 'nope' } } }))).toBeNull();
  });

  it('binds the decision to the rendered payload hash', () => {
    expect(decisionBinding(approval({ payloadHash: 'abc' }))).toEqual({ payloadHash: 'abc' });
    expect(decisionBinding(approval({ payloadHash: '' }))).toEqual({});
  });
});

describe('approval receipts — review fixes (W4 复查)', () => {
  it('a decide result never downgrades a later-settled receipt', () => {
    const settled = approval({ effect: { status: 'completed', settledAt: 50 } });
    const fromDecide = approval({ effect: { status: 'executing' } });
    expect(mergeApprovalUpdate(settled, fromDecide).effect).toEqual({
      status: 'completed',
      settledAt: 50,
    });
    expect(mergeApprovalUpdate(settled, approval()).effect?.status).toBe('completed');
    // A newer settlement wins; nothing held → the incoming copy as is.
    const newer = approval({ effect: { status: 'failed', settledAt: 60 } });
    expect(mergeApprovalUpdate(settled, newer).effect?.status).toBe('failed');
    expect(mergeApprovalUpdate(undefined, fromDecide)).toBe(fromDecide);
  });

  it('flags a completed non-MCP repeat differently from an uncertain one', () => {
    const flag = (status: string) =>
      priorEffectFlag(
        approval({ payload: { priorEffect: { status, summary: 's', createdAt: 1 } } }),
      );
    expect(flag('uncertain')).toBe('uncertain');
    expect(flag('completed')).toBe('completed');
    expect(flag('failed')).toBeNull();
    expect(priorEffectFlag(approval())).toBeNull();
    expect(
      priorEffectOf(
        approval({
          payload: {
            priorEffect: {
              status: 'completed',
              summary: 's',
              createdAt: 1,
              receipt: { externalId: '7' },
            },
          },
        }),
      )?.receipt,
    ).toEqual({ externalId: '7' });
  });
});
