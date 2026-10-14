import { describe, expect, it } from 'vitest';
import {
  approvalKindSchema,
  EPHEMERAL_APPROVAL_CARD_TYPES,
  type Approval,
  type Message,
} from '@kepcup/shared';
import { hiddenFromTranscript, isEphemeralApprovalCard } from './ephemeral-approval';

function card(content: Record<string, unknown>, kind: Message['kind'] = 'card'): Message {
  return { id: 'msg_1', kind, content } as unknown as Message;
}

describe('isEphemeralApprovalCard', () => {
  it('whitelists only mid-turn permission popups', () => {
    expect([...EPHEMERAL_APPROVAL_CARD_TYPES]).toEqual([
      'access',
      'unsandboxed',
      'command',
      'git_remote',
      'mcp_tool',
      'agent_tool',
      'egress',
    ]);
    for (const cardType of EPHEMERAL_APPROVAL_CARD_TYPES) {
      expect(approvalKindSchema.options).toContain(cardType);
      expect(isEphemeralApprovalCard(card({ cardType, approvalId: 'apr_1' }))).toBe(true);
    }
  });

  it('keeps import, install, and handover records in the transcript', () => {
    for (const cardType of [
      'environment',
      'skill_import',
      'skill_preset',
      'mail_send',
      'butler_proposal',
      'profile_change',
      'bot_handover',
    ]) {
      expect(isEphemeralApprovalCard(card({ cardType, approvalId: 'apr_1' }))).toBe(false);
    }
    for (const cardType of [
      'task',
      'watch',
      'mail',
      'mcp_app',
      'bot_widget',
      'present',
      'run_changes',
      'delegation_sent',
    ]) {
      expect(isEphemeralApprovalCard(card({ cardType }))).toBe(false);
    }
    expect(isEphemeralApprovalCard(card({ cardType: 'access' }, 'text'))).toBe(false);
  });
});

describe('approval records in the transcript', () => {
  const approval = (status: string, autoApproved = false) =>
    ({ id: 'apr_1', status, autoApproved }) as unknown as Approval;

  it('keeps auto-decided / egress records, hidden only while pending', () => {
    const record = card({ cardType: 'command', approvalId: 'apr_1', record: true });
    expect(isEphemeralApprovalCard(record)).toBe(false);
    expect(hiddenFromTranscript(record, { apr_1: approval('approved', true) })).toBe(false);
    expect(hiddenFromTranscript(record, { apr_1: approval('denied') })).toBe(false);
    // Pending: the dock is the popup; unknown approval: nothing to render.
    expect(hiddenFromTranscript(record, { apr_1: approval('pending') })).toBe(true);
    expect(hiddenFromTranscript(record, {})).toBe(true);
  });

  it('still hides user-answered popups and never hides non-permission cards', () => {
    const popup = card({ cardType: 'access', approvalId: 'apr_1' });
    expect(hiddenFromTranscript(popup, { apr_1: approval('approved') })).toBe(true);
    const install = card({ cardType: 'environment', approvalId: 'apr_1', record: true });
    expect(hiddenFromTranscript(install, {})).toBe(false);
  });
});
