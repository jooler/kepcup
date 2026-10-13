import { describe, expect, it } from 'vitest';
import {
  APP_RPC_METHODS,
  BOT_HANDED_OVER_EVENT,
  BOT_HANDOVER_EVENT,
  HANDOVER_RESP_FROM_KEY,
  HANDOVER_RESP_TO_KEY,
  approvalDecisionSchema,
  approvalKindSchema,
  approvalsDecideInputSchema,
  botHandoverPayloadSchema,
  butlerProposedBotSchema,
  chatModelOptions,
  defaultHandoverKeys,
  jobTypeSchema,
  memoryEvidenceSchema,
  messageContentSchema,
  rpcEventSchemas,
  selectableHandoverKeys,
  type ProviderInfo,
} from '../../src/index.js';

/** D88 Bot 资产移交：审批载荷、决定、事件、系统事件与模型选项的契约。 */

const payload = {
  handoverId: 'hnd_1',
  fromBotId: 'bot_a',
  fromBotName: '管家',
  target: {
    kind: 'new',
    bot: { name: '邮件助理', responsibilities: '管邮件', model: 'inherit' },
  },
  items: [
    { key: 'mail:mal_1', assetType: 'mail', action: 'move', label: 'work@x.com' },
    {
      key: 'schedule:sch_1',
      assetType: 'schedule',
      action: 'move',
      label: '周报',
      blocked: '邮件助理 不在群「周报」里',
    },
  ],
  responsibilities: { from: '只管日程', fromBefore: '管日程和邮件' },
  handoverNote: '每天 9 点看摘要',
};

describe('botHandoverPayloadSchema', () => {
  it('parses a new-target card with defaults filled in', () => {
    const parsed = botHandoverPayloadSchema.parse(payload);
    expect(parsed.target).toMatchObject({
      kind: 'new',
      bot: { name: '邮件助理', model: 'inherit', modelLabel: '', routines: [], bio: '' },
    });
    expect(parsed.items[0]).toMatchObject({ detail: '', warnings: [] });
    expect(parsed.items[0]!.blocked).toBeUndefined();
    expect(parsed.note).toBe('');
    expect(parsed.responsibilities?.toBefore).toBe('');
  });

  it('parses an existing target and rejects unknown actions / asset types', () => {
    const existing = { ...payload, target: { kind: 'existing', botId: 'bot_b' } };
    expect(botHandoverPayloadSchema.parse(existing).target).toEqual({
      kind: 'existing',
      botId: 'bot_b',
      botName: '',
    });
    const badAction = {
      ...payload,
      items: [{ key: 'mail:x', assetType: 'mail', action: 'steal', label: 'x' }],
    };
    expect(botHandoverPayloadSchema.safeParse(badAction).success).toBe(false);
    const badType = {
      ...payload,
      items: [{ key: 'x:y', assetType: 'cat', action: 'move', label: '' }],
    };
    expect(botHandoverPayloadSchema.safeParse(badType).success).toBe(false);
  });

  it('selectable keys: unblocked items plus the responsibilities rewrites that are present', () => {
    const parsed = botHandoverPayloadSchema.parse(payload);
    expect(selectableHandoverKeys(parsed)).toEqual(['mail:mal_1', HANDOVER_RESP_FROM_KEY]);
    const both = botHandoverPayloadSchema.parse({
      ...payload,
      responsibilities: { to: 'a', from: 'b' },
    });
    expect(selectableHandoverKeys(both)).toEqual([
      'mail:mal_1',
      HANDOVER_RESP_TO_KEY,
      HANDOVER_RESP_FROM_KEY,
    ]);
  });
});

describe('P1 card marks / default selection / memory provenance', () => {
  it('items default to no marks and checked; sensitive memories opt out of the default selection', () => {
    const parsed = botHandoverPayloadSchema.parse({
      ...payload,
      items: [
        ...payload.items,
        {
          key: 'skill:deploy',
          assetType: 'skill',
          action: 'copy',
          label: 'deploy',
          marks: ['external_import'],
        },
        {
          key: 'memory:mem_s',
          assetType: 'memory',
          action: 'copy',
          label: '体检安排',
          marks: ['sensitive'],
          defaultSelected: false,
        },
      ],
    });
    expect(parsed.items[0]).toMatchObject({ marks: [], defaultSelected: true });
    expect(selectableHandoverKeys(parsed)).toContain('memory:mem_s');
    expect(defaultHandoverKeys(parsed)).toEqual([
      'mail:mal_1',
      'skill:deploy',
      HANDOVER_RESP_FROM_KEY,
    ]);
    expect(() =>
      botHandoverPayloadSchema.parse({
        ...payload,
        items: [{ ...payload.items[0], marks: ['made_up'] }],
      }),
    ).toThrow();
  });

  it('memory evidence accepts the handover provenance form next to the message form', () => {
    expect(
      memoryEvidenceSchema.parse({
        messageId: null,
        conversationId: null,
        runId: null,
        handoverId: 'hnd_1',
        fromBotId: 'bot_a',
        fromItemId: 'mem_1',
      }),
    ).toMatchObject({ handoverId: 'hnd_1', fromItemId: 'mem_1' });
    expect(
      memoryEvidenceSchema.parse({ messageId: 'msg_1', conversationId: 'c', runId: null }),
    ).toEqual({
      messageId: 'msg_1',
      conversationId: 'c',
      runId: null,
    });
  });
});

describe('decision / RPC / events', () => {
  it('bot_handover is an approval kind; decisions carry handoverSelection', () => {
    expect(approvalKindSchema.parse('bot_handover')).toBe('bot_handover');
    expect(
      approvalDecisionSchema.parse({ handoverSelection: ['mail:mal_1', 'resp:to'] })
        .handoverSelection,
    ).toEqual(['mail:mal_1', 'resp:to']);
    expect(
      approvalsDecideInputSchema.parse({ id: 'apr_1', approve: true, handoverSelection: [] })
        .handoverSelection,
    ).toEqual([]);
    expect(
      approvalsDecideInputSchema.safeParse({ id: 'apr_1', approve: true, handoverSelection: [''] })
        .success,
    ).toBe(false);
  });

  it('handovers.get is an app method; handover.updated carries the execution view', () => {
    expect(APP_RPC_METHODS).toContain('handovers.get');
    const event = rpcEventSchemas['handover.updated'].parse({
      conversationId: 'conv_1',
      handover: {
        id: 'hnd_1',
        approvalId: 'apr_1',
        conversationId: 'conv_1',
        status: 'applying',
        fromBotId: 'bot_a',
        toBotId: null,
        items: [{ key: 'mail:mal_1', assetType: 'mail', status: 'done', error: null }],
        updatedAt: 1,
      },
    });
    expect(event.handover.items[0]?.status).toBe('done');
    // P2 additions default for views pushed without them (older cores / non-copy items).
    expect(event.handover.items[0]).toMatchObject({ copiedCount: null, skippedPaths: [] });
    expect(event.handover.retire).toBeNull();
    expect(
      rpcEventSchemas['handover.updated'].parse({
        conversationId: 'conv_1',
        handover: {
          ...event.handover,
          status: 'completed',
          items: [
            {
              key: 'wiki:pages/',
              assetType: 'wiki',
              status: 'done',
              error: null,
              copiedCount: 3,
              skippedPaths: ['pages/a.md'],
            },
          ],
          retire: { botId: 'bot_a', botName: 'A' },
        },
      }).handover,
    ).toMatchObject({
      items: [{ copiedCount: 3, skippedPaths: ['pages/a.md'] }],
      retire: { botId: 'bot_a', botName: 'A' },
    });
    expect(jobTypeSchema.parse('handover_copy')).toBe('handover_copy');
    expect(
      rpcEventSchemas['handover.updated'].safeParse({
        conversationId: 'c',
        handover: { ...event.handover, status: 'maybe' },
      }).success,
    ).toBe(false);
  });

  it('handover system events and the schedule card marker survive the message content union', () => {
    for (const event of [BOT_HANDOVER_EVENT, BOT_HANDED_OVER_EVENT]) {
      const content = messageContentSchema.parse({
        event,
        text: '…',
        handover: {
          handoverId: 'hnd_1',
          fromBotId: 'bot_a',
          fromBotName: 'A',
          toBotId: 'bot_b',
          toBotName: 'B',
          items: ['把邮箱 x 移交给 B'],
        },
      });
      expect(content).toMatchObject({
        event,
        handover: { note: '', items: ['把邮箱 x 移交给 B'] },
      });
    }
    const receipt = messageContentSchema.parse({
      event: 'schedule_created',
      text: '已移交给 B',
      schedule: {
        id: 'sch_1',
        botId: 'bot_a',
        title: '日报',
        note: '写日报',
        kind: 'cron',
        runAt: null,
        cron: '0 9 * * *',
        timezone: 'UTC',
        origin: 'tool',
        status: 'cancelled',
        handedOverTo: { botId: 'bot_b', name: 'B' },
      },
    });
    expect(receipt).toMatchObject({ schedule: { handedOverTo: { botId: 'bot_b', name: 'B' } } });
  });
});

describe('models', () => {
  it('propose_bot bots get an optional model ("" = settings default)', () => {
    expect(butlerProposedBotSchema.parse({ name: 'x' }).model).toBe('');
    expect(butlerProposedBotSchema.parse({ name: 'x', model: 'p/m' }).model).toBe('p/m');
  });

  it('chatModelOptions lists only providers with a stored key', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'openai',
        name: 'OpenAI',
        kind: 'builtin',
        models: [{ id: 'gpt', name: 'GPT', contextWindow: 1 }],
        hasKey: true,
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        kind: 'builtin',
        models: [{ id: 'claude', name: 'Claude', contextWindow: 1 }],
        hasKey: false,
      },
    ];
    expect(chatModelOptions(providers)).toEqual([{ ref: 'openai/gpt', label: 'OpenAI · GPT' }]);
  });
});
