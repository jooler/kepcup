import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildPluginFixture,
  createTestStack,
  makeBot,
  waitForEvent,
  type TestStack,
} from '@kepcup/testkit';

/**
 * `plugins.enableForBots`（D105 P5，P4 审查 P2-2 处置）：合并追加启用集的 RPC 契约——
 * 并集在 core 一侧原子完成（渲染端不再读-改-写整集）；已启用幂等跳过；任一 Bot 失败
 * 整体拒绝；实际写入时广播 bot.updated + plugins.changed。
 */

const PLUGIN_A = 'io.github.tester/enable-a';
const PLUGIN_B = 'io.github.tester/enable-b';

const root = mkdtempSync(path.join(tmpdir(), 'plugins-enable-for-bots-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const stacks: TestStack[] = [];

async function setup(): Promise<TestStack> {
  const stack = await createTestStack({});
  stacks.push(stack);
  return stack;
}

let fxCounter = 0;

async function installSkillPlugin(core: TestStack['core'], pluginId: string): Promise<void> {
  const built = await buildPluginFixture({
    dir: path.join(root, `fx-${(fxCounter += 1)}`),
    manifest: { id: pluginId },
    skills: [{ name: `demo-${fxCounter}` }],
  });
  await core.rpc.call('plugins.install', {
    source: { kind: 'file', path: built.path },
    sha256: built.sha256,
    userConfig: {},
  });
}

const pluginIdsOf = (core: TestStack['core'], botId: string): string[] =>
  core.services.domain!.bots.get(botId)!.profile.runtime.plugin_ids ?? [];

describe('plugins.enableForBots (merge semantics)', () => {
  it('unions into each bot without touching existing ids; idempotent on repeat', async () => {
    const { core } = await setup();
    await installSkillPlugin(core, PLUGIN_A);
    await installSkillPlugin(core, PLUGIN_B);
    const botA = await makeBot(core, '甲');
    const botB = await makeBot(core, '乙');
    // 甲已启用 A（编辑器语义的既有状态）：合并追加 B 不得动它。
    await core.rpc.call('plugins.setBotPlugins', { botId: botA.id, pluginIds: [PLUGIN_A] });

    await core.rpc.call('plugins.enableForBots', { pluginId: PLUGIN_B, botIds: [botA.id, botB.id] });
    expect(pluginIdsOf(core, botA.id)).toEqual([PLUGIN_A, PLUGIN_B]);
    expect(pluginIdsOf(core, botB.id)).toEqual([PLUGIN_B]);

    // 幂等：重复追加不改集合。
    await core.rpc.call('plugins.enableForBots', { pluginId: PLUGIN_B, botIds: [botA.id, botB.id] });
    expect(pluginIdsOf(core, botA.id)).toEqual([PLUGIN_A, PLUGIN_B]);
    expect(pluginIdsOf(core, botB.id)).toEqual([PLUGIN_B]);
  }, 90_000);

  it('broadcasts bot.updated per written bot and one plugins.changed on the first write', async () => {
    const { core } = await setup();
    await installSkillPlugin(core, PLUGIN_A);
    const botA = await makeBot(core, '甲');
    const botB = await makeBot(core, '乙');

    const botEvent = waitForEvent(core, 'bot.updated', () => true);
    const pluginEvent = waitForEvent(
      core,
      'plugins.changed',
      (payload: { ids: string[] }) => payload.ids.includes(PLUGIN_A),
    );
    await core.rpc.call('plugins.enableForBots', { pluginId: PLUGIN_A, botIds: [botA.id, botB.id] });
    await botEvent;
    await pluginEvent;
    expect(pluginIdsOf(core, botA.id)).toEqual([PLUGIN_A]);
    expect(pluginIdsOf(core, botB.id)).toEqual([PLUGIN_A]);
  }, 90_000);

  it('rejects the whole call on an unknown bot or an uninstalled plugin (nothing written)', async () => {
    const { core } = await setup();
    await installSkillPlugin(core, PLUGIN_A);
    const botA = await makeBot(core, '甲');
    const botB = await makeBot(core, '乙');

    await expect(
      core.rpc.call('plugins.enableForBots', {
        pluginId: PLUGIN_A,
        botIds: [botA.id, 'bot_missing'],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      core.rpc.call('plugins.enableForBots', {
        pluginId: 'io.github.tester/absent',
        botIds: [botA.id, botB.id],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 整批拒绝：没有任何 Bot 被写入。
    expect(pluginIdsOf(core, botA.id)).toEqual([]);
    expect(pluginIdsOf(core, botB.id)).toEqual([]);
  }, 90_000);

  it('a soft-deleted bot later in the batch rejects the call before any write', async () => {
    const { core } = await setup();
    await installSkillPlugin(core, PLUGIN_A);
    const alive = await makeBot(core, '活着的');
    const doomed = await makeBot(core, '将被删');
    await core.rpc.call('bots.delete', { id: doomed.id });

    // 活 Bot 排在前面：预检必须在写入之前拒绝，否则它会被白写一次。
    await expect(
      core.rpc.call('plugins.enableForBots', {
        pluginId: PLUGIN_A,
        botIds: [alive.id, doomed.id],
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_READ_ONLY' });
    expect(pluginIdsOf(core, alive.id)).toEqual([]);
  }, 90_000);
});
