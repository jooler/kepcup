import { describe, expect, it } from 'vitest';
import type { Message, TriggerReason } from '@kepcup/shared';
import { buildTriggerSegment, projectWakeHint } from '../../src/agent/context/conversation.js';

/** D92 T1a routing：四个路由触发原因的触发段宿主说明（WP3 步骤 8）。 */

let seq = 0;
function userMessage(text: string): Message {
  seq += 1;
  return {
    id: `msg_${seq}`,
    conversationId: 'conv_1',
    seq,
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: { text },
    replyTo: null,
    mentions: [],
    batchId: 'batch_1',
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 1_700_000_000_000 + seq,
    attachments: [],
    ownerBotId: null,
    taskId: null,
  };
}

const OPTIONS = { selfBotId: 'bot_p', timeZone: 'UTC', botNames: new Map<string, string>() };

function segmentOf(reason: TriggerReason): string {
  return buildTriggerSegment({ reason, messages: [userMessage('你好')], options: OPTIONS });
}

const HINT_MARKS: Partial<Record<TriggerReason, string>> = {
  continuation: '宿主判断它是在延续你们的对话',
  routed: '项目负责人判断这条消息与你有关',
  routed_also: '前面的成员可能已经回复',
  lead_fallback: '由你作为项目负责人处理',
};

describe('projectWakeHint / buildTriggerSegment (D92 T1a 触发段宿主说明)', () => {
  it('the four routing reasons carry their host note inside the trigger segment', () => {
    for (const [reason, mark] of Object.entries(HINT_MARKS) as Array<[TriggerReason, string]>) {
      const segment = segmentOf(reason);
      expect(segment, reason).toContain(`<trigger reason="${reason}"`);
      expect(segment, reason).toContain(mark);
      expect(segment, reason).toContain('（宿主说明：');
    }
  });

  it('every other reason carries no host note', () => {
    const others: TriggerReason[] = [
      'direct',
      'mention',
      'reply',
      'bot_mention',
      'scheduled',
      'event',
      'background',
      'task',
      'watch',
      'mail',
    ];
    for (const reason of others) {
      expect(projectWakeHint(reason), reason).toBeNull();
      expect(segmentOf(reason), reason).not.toContain('宿主说明');
    }
    // delegation keeps its own W6 hint, not the routing one.
    expect(segmentOf('delegation')).toContain('代用户转交');
    expect(segmentOf('delegation')).not.toContain('延续你们的对话');
    expect(projectWakeHint('routing_gate' as never)).toBeNull();
  });

  it('projectWakeHint returns the note text verbatim per reason', () => {
    expect(projectWakeHint('continuation')).toBe(
      '（宿主说明：用户这条消息没有 @ 任何人。你是最近与用户交流的成员，宿主判断它是在延续你们的对话。如果你认为与你无关，可以调用 skip_reply。）',
    );
    expect(projectWakeHint('routed')).toBe(
      '（宿主说明：项目负责人判断这条消息与你有关。请直接回应用户，像你自己认为与己有关一样自然作答，不要提及被转交或负责人的判断。你必须给出回应。）',
    );
    expect(projectWakeHint('routed_also')).toBe(
      '（宿主说明：项目负责人判断这条消息也与你有关，前面的成员可能已经回复（见最近消息）。如果没有需要补充的，调用 skip_reply；不要提及被转交。）',
    );
    expect(projectWakeHint('lead_fallback')).toBe(
      '（宿主说明：用户这条消息没有 @ 任何人，也没有成员认领，由你作为项目负责人处理。请直接回应：自己回答，或在回复中 @ 合适的成员并写清要他做什么。你必须给出回应。）',
    );
  });
});
