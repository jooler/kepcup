import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  TestClock,
  buildPluginFixture,
  createTestStack,
  listAllMessages,
  listMessages,
  makeBot,
  openDirect,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 插件激活通报（2026-11-03，设计 51 §15.8）：用户操作插件 30 秒后，core 把启用集 +
 * manifest `usage` + 就绪状态作为一条 `internal` 系统事件发给 Bot；用户可见消息流不含它。
 */

const PLUGIN_ID = 'io.github.tester/mail-demo';

const root = mkdtempSync(path.join(tmpdir(), 'plugin-activation-notice-'));
const stacks: TestStack[] = [];
afterAll(async () => {
  for (const stack of stacks) await stack.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe('plugin activation notice', () => {
  it('delivers one internal event 30 seconds after the last plugin operation', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    stacks.push(stack);
    const { core } = stack;
    const bot = await makeBot(core, '甲');
    const conversation = await openDirect(core, bot.id);
    const built = await buildPluginFixture({
      dir: path.join(root, 'mail-demo'),
      manifest: {
        id: PLUGIN_ID,
        usage: '启用后还需要添加邮箱账号，并在 Bot 详情勾选绑定。',
        instances: ['mail'],
      },
      mail: [
        {
          id: 'demo',
          label: 'Demo 邮箱',
          imap: { host: 'imap.demo.test', port: 993, secure: 'ssl' },
          smtp: { host: 'smtp.demo.test', port: 465, secure: 'ssl' },
        },
      ],
    });
    await core.rpc.call('plugins.install', {
      source: { kind: 'file', path: built.path },
      sha256: built.sha256,
      userConfig: {},
    });

    const events = (await listAllMessages(core, conversation.id)).filter(
      (message) => message.kind === 'system_event',
    );
    expect(events.some((message) => message.content.event === 'plugin_activation_changed')).toBe(
      false,
    );

    await core.rpc.call('plugins.setBotPlugins', { botId: bot.id, pluginIds: [PLUGIN_ID] });
    // 29 秒还不发；第 30 秒才发（按最后一次操作合并）。
    clock.advance(29_999);
    expect(
      (await listAllMessages(core, conversation.id)).some(
        (message) => message.content.event === 'plugin_activation_changed',
      ),
    ).toBe(false);
    clock.advance(1);

    const notice = (await listAllMessages(core, conversation.id)).find(
      (message) => message.content.event === 'plugin_activation_changed',
    );
    expect(notice).toBeDefined();
    expect(notice!.kind).toBe('system_event');
    expect(notice!.content.internal).toBe(true);
    expect(notice!.content.text).toContain('启用说明');
    expect(notice!.content.text).toContain('添加邮箱账号');
    expect(notice!.content.text).toContain('尚未添加任何邮箱账号');
    // 用户可见消息流不含这条内部事件。
    expect(
      (await listMessages(core, conversation.id)).some(
        (message) => message.content.event === 'plugin_activation_changed',
      ),
    ).toBe(false);
  }, 90_000);
});
