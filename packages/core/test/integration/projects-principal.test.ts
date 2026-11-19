import { afterEach, describe, expect, it } from 'vitest';
import type { Conversation } from '@kepcup/shared';
import { AppError } from '@kepcup/shared';
import { withCaller, type CoreHarness } from '@kepcup/core';
import { createTestStack, makeBot, type TestStack } from '@kepcup/testkit';

/**
 * Principalized projects.create (62.11 C3): a non-empty principalIds list
 * relaxes the bot-member floor from 2 to 1 (humans keep the group
 * collaborative), the caller is enrolled as the project lead
 * (conversation_principals role='lead') when present, and no principal row is
 * written on the dormant path. lead ∈ memberBotIds stays enforced.
 *
 * The harness RPC client hops over a MessagePort (no AsyncLocalStorage across
 * it), so tests dispatch against `services.appMethods` inside `withCaller`,
 * mirroring the RPC server's input/output parsing.
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

async function callAs(
  core: CoreHarness,
  method: string,
  input?: Record<string, unknown>,
  principalId?: string,
): Promise<unknown> {
  const spec = core.services.appMethods[method];
  if (spec === undefined) throw new Error(`method not bound: ${method}`);
  // voidInput methods take no input (z.void()); the rest parse like the RPC
  // server does.
  const parsed = input === undefined ? undefined : spec.input.safeParse(input);
  if (parsed !== undefined && !parsed.success) {
    throw new AppError('INVALID_INPUT', `Invalid input for ${method}`);
  }
  const task = async () => spec.output.parse(await spec.handle(parsed?.data));
  return principalId === undefined ? task() : withCaller({ principalId }, task);
}

interface PrincipalRow {
  conversation_id: string;
  principal_id: string;
  role: string;
}

function principalRows(core: CoreHarness, conversationId: string): PrincipalRow[] {
  return core.services.mainDb!
    .prepare('select * from conversation_principals where conversation_id = ?')
    .all(conversationId) as PrincipalRow[];
}

describe('projects.create with principals', () => {
  it('allows a single-bot project when principalIds is non-empty', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小阿');

    // Without principals the two-bot floor still applies.
    await expect(
      callAs(
        core,
        'projects.create',
        { title: '单人组', leadBotId: bot.id, memberBotIds: [bot.id] },
        'mbr_A',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const created = (await callAs(
      core,
      'projects.create',
      {
        title: '人机组',
        leadBotId: bot.id,
        memberBotIds: [bot.id],
        principalIds: ['mbr_A'],
      },
      'mbr_A',
    )) as { conversation: Conversation };
    expect(created.conversation.type).toBe('project');
    expect(created.conversation.leadBotId).toBe(bot.id);
  });

  it('enrolls the caller as the project lead (role=lead) when a caller is present', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小阿');

    const created = (await callAs(
      core,
      'projects.create',
      {
        title: '发布组',
        leadBotId: bot.id,
        memberBotIds: [bot.id],
        principalIds: ['mbr_A'],
      },
      'mbr_A',
    )) as { conversation: Conversation };

    const rows = principalRows(core, created.conversation.id);
    const lead = rows.find((row) => row.principal_id === 'mbr_A');
    expect(lead).toBeDefined();
    expect(lead!.role).toBe('lead');
  });

  it('enrolls client principalIds as members without a caller, but never a lead', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小阿');

    // Dormant create with principalIds: client-supplied ids land as plain
    // members; the role='lead' row is reserved for the caller context, so no
    // lead exists here.
    const created = (await callAs(core, 'projects.create', {
      title: '旧双人组',
      leadBotId: bot.id,
      memberBotIds: [bot.id],
      principalIds: ['mbr_X'],
    })) as { conversation: Conversation };
    const rows = principalRows(core, created.conversation.id);
    expect(rows.map((row) => [row.principal_id, row.role])).toEqual([['mbr_X', 'member']]);

    // Dormant create without principalIds behaves exactly as before: no
    // principal rows at all.
    const otherBot = await makeBot(core, '小乙');
    const legacy = (await callAs(core, 'projects.create', {
      title: '纯 Bot 组',
      leadBotId: bot.id,
      memberBotIds: [bot.id, otherBot.id],
    })) as { conversation: Conversation };
    expect(legacy.conversation.type).toBe('project');
    expect(principalRows(core, legacy.conversation.id)).toEqual([]);
  });

  it('still requires the lead bot to be a member', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小阿');
    const otherBot = await makeBot(core, '小乙');

    await expect(
      callAs(
        core,
        'projects.create',
        {
          title: '负责人不在组',
          leadBotId: otherBot.id,
          memberBotIds: [bot.id],
          principalIds: ['mbr_A'],
        },
        'mbr_A',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
