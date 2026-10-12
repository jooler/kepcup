import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitFor,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

/** listRuns 默认新→旧；取对话轮并按时间正序。 */
async function turnModelsOldestFirst(
  core: TestStack['core'],
  conversationId: string,
): Promise<string[]> {
  const turns = (await listRuns(core, conversationId))
    .filter((run) => run.loopType === 'turn' && run.status === 'completed')
    .slice()
    .reverse();
  return turns.map((run) => run.model ?? '');
}

/**
 * Core 在 settings / bots.update 后下一轮必须用新模型 ref。
 * （渲染层若把未保存草稿冲掉，会表现为「改了仍走旧模型」——见 RightPanel /
 * ModelsSection 的同步修复。）
 */
describe('model switch mid-session', () => {
  it(
    'bots with empty runtime.model follow settings.defaultMainModel on the next turn',
    async () => {
      const stack = await createTestStack();
      stacks.push(stack);
      const { core, llm } = stack;

      llm.script('mock-main', [step().replyText('用主模型'), step().replyText('若误用旧模型')]);
      llm.script('mock-light', [step().replyText('用轻量作主模型'), step().replyText('多余')]);

      const bot = await makeBot(core, '跟随默认');
      expect(bot.profile.runtime.model).toBe('');
      const conv = await openDirect(core, bot.id);

      await sendBatch(core, conv.id, ['第一轮']);
      await waitForRun(core, conv.id, 'completed');
      expect(await turnModelsOldestFirst(core, conv.id)).toEqual(['custom:mock/mock-main']);

      await core.rpc.call('settings.update', {
        defaultMainModel: 'custom:mock/mock-light',
      });

      await sendBatch(core, conv.id, ['第二轮换默认']);
      await waitFor(
        async () => {
          const models = await turnModelsOldestFirst(core, conv.id);
          return models.length >= 2 && models[1] === 'custom:mock/mock-light' ? true : null;
        },
        { label: 'second turn uses new defaultMainModel' },
      );
    },
    20_000,
  );

  it(
    'bots.update runtime.model overrides the default on the next turn',
    async () => {
      const stack = await createTestStack();
      stacks.push(stack);
      const { core, llm } = stack;

      llm.script('mock-main', [step().replyText('默认'), step().replyText('若误用旧模型')]);
      llm.script('mock-light', [step().replyText('Bot 指定'), step().replyText('多余')]);

      const created = await makeBot(core, '指定模型');
      const conv = await openDirect(core, created.id);

      await sendBatch(core, conv.id, ['先用默认']);
      await waitForRun(core, conv.id, 'completed');
      expect(await turnModelsOldestFirst(core, conv.id)).toEqual(['custom:mock/mock-main']);

      const profile = {
        ...created.profile,
        identity: { ...created.profile.identity, name: created.name },
        runtime: { ...created.profile.runtime, model: 'custom:mock/mock-light' },
      };
      const updated = (await core.rpc.call('bots.update', {
        id: created.id,
        profile,
      })) as { bot: { profile: { runtime: { model: string } } } };
      expect(updated.bot.profile.runtime.model).toBe('custom:mock/mock-light');

      await sendBatch(core, conv.id, ['改成 Bot 覆盖']);
      await waitFor(
        async () => {
          const models = await turnModelsOldestFirst(core, conv.id);
          return models.length >= 2 && models[1] === 'custom:mock/mock-light' ? true : null;
        },
        { label: 'second turn uses bot runtime.model override' },
      );
    },
    20_000,
  );
});
