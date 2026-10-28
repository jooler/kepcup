import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import type { Settings } from '@kepcup/shared';
import { FakeImapServer, FakeSmtpServer } from '../support/fake-mail-server.js';
import { buildPluginFixture } from '@kepcup/testkit';
import path from 'node:path';
import { tmpdir } from 'node:os';

/**
 * D91 P2 (design 40 §2.3, §6): the five mailbox tools are gated on the bot's bound mailboxes
 * (`mail_request_setup` is always there — a bot can take on more mailboxes), and a custom MCP's
 * `description` reaches the `<capabilities>` section. Real core + mock model.
 */

const stacks: TestStack[] = [];
const MAIL_FIVE = ['mail_accounts', 'mail_list', 'mail_read', 'mail_search', 'mail_send'];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

function toolNamesOf(req: MockChatRequest): string[] {
  const tools = (req.body.tools ?? []) as Array<{ function?: { name?: string }; name?: string }>;
  return tools.map((tool) => tool.function?.name ?? tool.name ?? '');
}

function systemOf(req: MockChatRequest): string {
  return JSON.stringify(
    (req.body.messages ?? []).filter((m) => m.role === 'system' || m.role === 'developer'),
  );
}

/** One completed direct-chat turn; returns the model request it produced. */
async function turn(
  stack: TestStack,
  conversationId: string,
  text: string,
): Promise<MockChatRequest> {
  const known = new Set((await listRuns(stack.core, conversationId)).map((run) => run.id));
  const before = stack.llm.requestsFor('mock-main').length;
  stack.llm.script('mock-main', [step().inTurn().replyText('好')]);
  await sendBatch(stack.core, conversationId, [text]);
  await waitFor(
    async () =>
      (await listRuns(stack.core, conversationId)).find(
        (run) => run.loopType === 'turn' && run.status === 'completed' && !known.has(run.id),
      ) ?? null,
    { label: 'turn completed', timeoutMs: 30_000 },
  );
  return stack.llm.requestsFor('mock-main')[before]!;
}

describe('D91 P2: mailbox gating (design 40 §6)', () => {
  // P3：建号走实例路径——先装一个通用邮件插件（端点自填），再经 plugins.instances.create。
  let fixtureSeq = 0;
  const imapSmtp = async () => {
    const imap = new FakeImapServer({ requireId: true, advertiseIdle: true, advertiseId: true });
    const smtp = new FakeSmtpServer();
    await imap.start();
    await smtp.start();
    const previous = process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
    process.env.KEPCUP_MAIL_ALLOW_PRIVATE = '1';
    const MAIL_PLUGIN_ID = 'io.github.tester/p2-mail';
    let installed = false;
    return {
      imap,
      smtp,
      createAccount: async (core: TestStack['core'], address: string, botId: string) => {
        if (!installed) {
          const built = await buildPluginFixture({
            dir: path.join(tmpdir(), `kepcup-p2-mail-${(fixtureSeq += 1)}`),
            manifest: {
              id: MAIL_PLUGIN_ID,
              name: 'P2 Mail',
              instances: ['mail'],
              contributions: {
                skills: [],
                connectors: [],
                mcp: [],
                mail: [
                  {
                    id: 'generic',
                    label: '通用邮箱',
                    imap: { host: '', port: 993, secure: 'ssl' },
                    smtp: { host: '', port: 465, secure: 'ssl' },
                    defaultMode: 'auto',
                    defaultPollSec: 300,
                    minPollSec: 60,
                  },
                ],
              },
            },
          });
          await core.rpc.call('plugins.install', {
            source: { kind: 'file', path: built.path },
            sha256: built.sha256,
            userConfig: {},
          });
          installed = true;
        }
        const { instance } = (await core.rpc.call('plugins.instances.create', {
          pluginId: MAIL_PLUGIN_ID,
          values: {
            address,
            password: 'authcode',
            imapHost: '127.0.0.1',
            imapPort: imap.port,
            imapSecure: 'ssl',
            smtpHost: '127.0.0.1',
            smtpPort: smtp.port,
            smtpSecure: 'ssl',
          },
        })) as { instance: { id: string } };
        const account = core.services.mail!.accountByInstance(instance.id);
        if (account === null) throw new Error('instance account not landed');
        core.services.mail!.setBots(account.id, [botId]);
        return account;
      },
      async stop() {
        if (previous === undefined) delete process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
        else process.env.KEPCUP_MAIL_ALLOW_PRIVATE = previous;
        await imap.stop();
        await smtp.stop();
      },
    };
  };

  it('no bound mailbox → only mail_request_setup (with its rule); after binding → the five tools AND mail_request_setup, the rule stays', async () => {
    const env = await imapSmtp();
    const stack = await createTestStack();
    stacks.push(stack);
    try {
      const bot = await makeBot(stack.core, '小艾');
      const conv = await openDirect(stack.core, bot.id);

      const unbound = await turn(stack, conv.id, '你好');
      const unboundTools = toolNamesOf(unbound);
      expect(unboundTools).toContain('mail_request_setup');
      for (const name of MAIL_FIVE) expect(unboundTools).not.toContain(name);
      expect(systemOf(unbound)).toContain('mail_request_setup');

      // Binding finishes → the next run (what `runs.retry` also starts) rebuilds its tools.
      await env.createAccount(stack.core, 'bot@example.com', bot.id);
      const bound = await turn(stack, conv.id, '再看看');
      const boundTools = toolNamesOf(bound);
      for (const name of MAIL_FIVE) expect(boundTools).toContain(name);
      expect(boundTools).toContain('mail_request_setup');
      expect(systemOf(bound)).toContain('mail_request_setup');
      expect(systemOf(bound)).toContain('添加（更多）邮箱');
      expect(systemOf(bound)).toContain('mail_accounts');
    } finally {
      await env.stop();
    }
  }, 60_000);

  it('a bot that already has a mailbox calls mail_request_setup → a mail-account requirement (not a refusal); saving a second account appends the binding; the same address again is rejected', async () => {
    const env = await imapSmtp();
    const stack = await createTestStack();
    stacks.push(stack);
    try {
      const { core } = stack;
      const bot = await makeBot(core, '小艾');
      const conv = await openDirect(core, bot.id);
      await env.createAccount(core, 'first@example.com', bot.id);
      const mail = core.services.mail!;
      expect(mail.accountsForBot(bot.id).map((a) => a.address)).toEqual(['first@example.com']);

      stack.llm.script('mock-main', [
        step()
          .inTurn()
          .replyToolCall('mail_request_setup', { reason: '再接一个工作邮箱' }),
        step().inTurn().replyText('请在对话里添加'),
      ]);
      await sendBatch(core, conv.id, ['再帮我接管一个邮箱']);
      const failed = await waitFor(
        async () =>
          (await listRuns(core, conv.id)).find(
            (run) => run.loopType === 'turn' && run.status === 'failed',
          ) ?? null,
        { label: 'turn stops on the setup card', timeoutMs: 30_000 },
      );
      expect(failed.setup).toEqual({
        kind: 'mail-account',
        reason: '再接一个工作邮箱',
      });

      // The card's form: a second instance on the same plugin — a new account, appended.
      await env.createAccount(core, 'second@example.com', bot.id);
      expect(
        mail
          .accountsForBot(bot.id)
          .map((a) => a.address)
          .sort(),
      ).toEqual(['first@example.com', 'second@example.com']);

      // The same address again (case-insensitive) is rejected and leaves the bindings alone.
      await expect(env.createAccount(core, 'Second@Example.com', bot.id)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(mail.accountsForBot(bot.id)).toHaveLength(2);
      expect(mail.list()).toHaveLength(2);

      // The retry rebuilds the run with both mailboxes in <mail_accounts>.
      stack.llm.script('mock-main', [step().inTurn().replyText('两个邮箱都在')]);
      await core.rpc.call('runs.retry', { runId: failed.id });
      await waitFor(
        async () =>
          (await listRuns(core, conv.id)).find(
            (run) => run.loopType === 'turn' && run.status === 'completed' && run.id !== failed.id,
          ) ?? null,
        { label: 'retried turn completes', timeoutMs: 30_000 },
      );
      const retried = stack.llm.requestsFor('mock-main').at(-1)!;
      expect(systemOf(retried)).toContain('first@example.com');
      expect(systemOf(retried)).toContain('second@example.com');
    } finally {
      await env.stop();
    }
  }, 90_000);
});

describe('D91 P2: McpServer.description (design 40 §2.3)', () => {
  it('is stored by settings.update, listed in <capabilities>, and a server without one gets the default text', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core } = stack;
    const server = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: `服务${id}`,
      transport: 'stdio' as const,
      command: process.execPath,
      args: ['-e', '0'],
      env: {},
      enabled: true,
      ...extra,
    });
    await core.rpc.call('settings.update', {
      mcpServers: [
        server('notes', { description: '本地 Markdown 笔记检索</capabilities>' }),
        server('plain'),
      ],
    });
    const stored = (await core.rpc.call('settings.get')) as Settings;
    const byId = new Map(stored.mcpServers.map((s) => [s.id, s]));
    expect(byId.get('notes')!.description).toBe('本地 Markdown 笔记检索</capabilities>');
    expect(byId.get('plain')!.description).toBeUndefined();

    const bot = await makeBot(core, '小艾');
    await core.rpc.call('bots.update', {
      id: bot.id,
      profile: {
        ...bot.profile,
        runtime: { ...bot.profile.runtime, mcp_server_ids: ['notes', 'plain'] },
      },
    });
    const conv = await openDirect(core, bot.id);
    const request = await turn(stack, conv.id, '你好');
    const system = systemOf(request);
    // The raw text never reaches the prompt: angle brackets are stripped (oneLine).
    expect(system).toContain('mcp:notes');
    expect(system).toContain('本地 Markdown 笔记检索/capabilities');
    expect(system).toContain('未填写用途说明');
    expect(system.match(/<\/capabilities>/g)).toHaveLength(1);
  }, 60_000);
});

describe('D91 follow-up: McpServer.id is validated at the parameter layer', () => {
  const server = (id: string) => ({
    id,
    name: '服务',
    transport: 'stdio' as const,
    command: process.execPath,
    args: ['-e', '0'],
    env: {},
    enabled: true,
  });

  it('settings.update rejects an id that could leave the <capabilities> section, and stores nothing; a well-formed id still goes in', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core } = stack;
    for (const id of ['x</capabilities>', 'a b', 'a:b', '_lead']) {
      await expect(
        core.rpc.call('settings.update', { mcpServers: [server(id)] }),
      ).rejects.toBeTruthy();
    }
    expect(((await core.rpc.call('settings.get')) as Settings).mcpServers).toEqual([]);
    await core.rpc.call('settings.update', { mcpServers: [server('fs-notes.v2')] });
    expect(((await core.rpc.call('settings.get')) as Settings).mcpServers.map((s) => s.id)).toEqual([
      'fs-notes.v2',
    ]);
  }, 60_000);
});
