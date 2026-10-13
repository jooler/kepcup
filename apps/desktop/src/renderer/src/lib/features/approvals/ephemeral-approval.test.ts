import { describe, expect, it } from 'vitest';
import { approvalKindSchema, EPHEMERAL_APPROVAL_CARD_TYPES, type Message } from '@kepcup/shared';
import { isEphemeralApprovalCard } from './ephemeral-approval';

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
