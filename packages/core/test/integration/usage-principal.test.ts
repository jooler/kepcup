import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { withCaller, type CoreHarness } from '@kepcup/core';
import { createTestStack, makeBot, openDirect, waitForRun, type TestStack } from '@kepcup/testkit';
import { step } from '@kepcup/testkit';

/**
 * Principal attribution on runs and usage (62.11 C7): a direct-chat turn run
 * carries the conversation owner as principal_id, and usage_ledger rows resolve
 * the principal from the run inside UsageService.record. Dormancy: without a
 * caller (or without a resolvable run) both stay NULL.
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

describe('run / usage principal attribution', () => {
  it('attributes a direct-chat turn and its usage ledger rows to the conversation owner', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().replyText('收到')]);
    const bot = await makeBot(core, '小艾');

    // With a caller: the direct chat is owned by that principal.
    const conv = ((await callAs(core, 'conversations.openDirect', { botId: bot.id }, 'mbr_A')) as {
      conversation: { id: string };
    }).conversation;
    await callAs(core, 'messages.send', { conversationId: conv.id, text: '在吗' }, 'mbr_A');
    const run = await waitForRun(core, conv.id, 'completed');

    const runRow = core.services.runsDb!.prepare('select principal_id from runs where id = ?').get(
      run.id,
    ) as { principal_id: string | null };
    expect(runRow.principal_id).toBe('mbr_A');

    const ledger = core.services.mainDb!
      .prepare('select principal_id from usage_ledger where run_id = ?')
      .all(run.id) as Array<{ principal_id: string | null }>;
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((row) => row.principal_id === 'mbr_A')).toBe(true);
  });

  it('resolves the principal inside record; an unknown run keeps NULL', async () => {
    const { core } = await start();
    core.services.domain!.usage.record({
      runId: 'run_does_not_exist',
      botId: null,
      conversationId: null,
      loopType: 'turn',
      provider: 'test-provider',
      model: 'test-model',
      inputTokens: 3,
      outputTokens: 4,
    });
    const row = core.services.mainDb!
      .prepare('select principal_id from usage_ledger where run_id = ?')
      .get('run_does_not_exist') as { principal_id: string | null };
    // The run cannot be resolved → no principal (not a crash, not a guess).
    expect(row.principal_id).toBeNull();
  });

  it('keeps NULL attribution for the dormant (no caller) path', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().replyText('收到')]);
    const bot = await makeBot(core, '小艾');

    // Dormant openDirect: owner NULL; dormant send: sender principal NULL.
    const conv = await openDirect(core, bot.id);
    const sent = (await callAs(core, 'messages.send', { conversationId: conv.id, text: '单用户' })) as {
      message: { senderPrincipalId?: string | null };
    };
    expect(sent.message.senderPrincipalId ?? null).toBeNull();
    const run = await waitForRun(core, conv.id, 'completed');

    const runRow = core.services.runsDb!.prepare('select principal_id from runs where id = ?').get(
      run.id,
    ) as { principal_id: string | null };
    expect(runRow.principal_id).toBeNull();

    const ledger = core.services.mainDb!
      .prepare('select principal_id from usage_ledger where run_id = ?')
      .all(run.id) as Array<{ principal_id: string | null }>;
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((row) => row.principal_id === null)).toBe(true);
  });
});
