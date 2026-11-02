import { describe, expect, it } from 'vitest';
import { botProfile } from '@kepcup/testkit';
import {
  getSettingItem,
  settingsSchema,
  type Bot,
  type MailAccount,
  type PluginSummary,
} from '@kepcup/shared';
import { buildItemAdapters } from '../../src/settings/contributions/index.js';
import type { AdapterDeps } from '../../src/settings/adapters.js';

/**
 * 邮件组的两个设置条目（`mail.plugin` / `mail.mailbox`）：Bot 用 settings_search 能找到，
 * settings_read 能看到插件 / 邮箱与可绑定的 Bot，settings_change 的 values 由适配器校验。
 */

function item(id: string) {
  const found = getSettingItem(id);
  if (found === null) throw new Error(`missing ${id}`);
  return found;
}

function makeBot(id: string, pluginIds: string[] = []): Bot {
  const profile = botProfile({ name: id });
  return {
    id,
    name: id,
    bio: '',
    status: 'active',
    systemRole: null,
    setupState: 'done',
    profile: { ...profile, runtime: { ...profile.runtime, plugin_ids: pluginIds } },
  } as unknown as Bot;
}

function mailPlugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'app.kepcup/mail-qq',
    name: 'QQ 邮箱',
    iconDataUri: null,
    version: '1.0.0',
    description: '',
    author: null,
    origin: 'marketplace',
    tier: 'verified',
    state: 'installed',
    enabled: true,
    dirPath: null,
    marketplace: null,
    installedAt: 1,
    updatedAt: 1,
    counts: { skills: 0, connectors: 0, mcp: 0, mail: 1 },
    items: [],
    updateAvailable: null,
    revoked: null,
    configFields: [],
    instanceFields: [],
    instanceCounts: { mail: 2, mcp: 0 },
    providesInstances: ['mail'],
    ...overrides,
  };
}

function account(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'mal_1',
    address: 'work@example.com',
    label: '工作',
    provider: 'custom',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecure: 'ssl',
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: 'ssl',
    username: 'work@example.com',
    mode: 'auto',
    pollIntervalSec: 300,
    status: 'idle',
    listen: 'idle',
    lastError: null,
    lastOkAt: null,
    unseenCount: null,
    botIds: ['bot_b'],
    alertPausedBotIds: [],
    instanceId: 'pli_1',
    pluginId: 'app.kepcup/mail-qq',
    pluginName: 'QQ 邮箱',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function deps(
  options: {
    plugins?: PluginSummary[] | undefined;
    mail?: MailAccount[] | undefined;
    bots?: Bot[];
  } = {},
): AdapterDeps {
  const bots = options.bots ?? [makeBot('bot_a'), makeBot('bot_b')];
  return {
    settings: {
      get: () => settingsSchema.parse({}),
      update: (patch) => settingsSchema.parse(patch),
    },
    secrets: { hasValue: () => false, setValue: () => undefined },
    providers: { list: () => [], setKey: () => undefined },
    bots: {
      get: (id) => bots.find((bot) => bot.id === id) ?? null,
      listActive: () => bots,
    },
    botProfiles: {
      apply: () => {
        throw new Error('not used');
      },
    },
    publish: () => undefined,
    ...(options.plugins !== undefined ? { plugins: { list: () => options.plugins! } } : {}),
    ...(options.mail !== undefined ? { mail: { list: () => options.mail! } } : {}),
  };
}

const target = { botId: 'bot_a', conversationId: 'conv_1', workdirId: null };

describe('mail.plugin adapter', () => {
  it('no installed mail plugin → unconfigured', () => {
    const adapter = buildItemAdapters(deps({ plugins: [] }))(item('mail.plugin'));
    const snapshot = adapter.read(item('mail.plugin'), target);
    expect(snapshot.status).toBe('unconfigured');
    expect(snapshot.values).toBeNull();
    expect(snapshot.summary).toContain('还没有安装邮件插件');
  });

  it('installed but not given to this Bot → the Bot switch is off', () => {
    const adapter = buildItemAdapters(deps({ plugins: [mailPlugin()] }))(item('mail.plugin'));
    const snapshot = adapter.read(item('mail.plugin'), target);
    expect(snapshot.status).toBe('configured');
    expect(snapshot.values).toEqual({ plugin: 'app.kepcup/mail-qq', enabled: false });
    expect(snapshot.summary).toContain('还没有交给这个 Bot');
  });

  it('given to this Bot → enabled; a globally disabled plugin is partial', () => {
    const enabled = buildItemAdapters(
      deps({
        plugins: [mailPlugin()],
        bots: [makeBot('bot_a', ['app.kepcup/mail-qq']), makeBot('bot_b')],
      }),
    )(item('mail.plugin'));
    expect(enabled.read(item('mail.plugin'), target).values).toEqual({
      plugin: 'app.kepcup/mail-qq',
      enabled: true,
    });

    const disabled = buildItemAdapters(deps({ plugins: [mailPlugin({ enabled: false })] }))(
      item('mail.plugin'),
    );
    expect(disabled.read(item('mail.plugin'), target).status).toBe('partial');
  });

  it('lists installed mail plugins and rejects an unknown plugin id', () => {
    const adapter = buildItemAdapters(
      deps({
        plugins: [mailPlugin(), mailPlugin({ id: 'app.kepcup/mail-163', name: '163 邮箱' })],
      }),
    )(item('mail.plugin'));
    expect(adapter.options?.(item('mail.plugin').fields[0]!, item('mail.plugin'), target)).toEqual([
      { value: 'app.kepcup/mail-qq', label: 'QQ 邮箱' },
      { value: 'app.kepcup/mail-163', label: '163 邮箱' },
    ]);
    expect(adapter.normalize?.(item('mail.plugin'), { plugin: 'nope' }, target)).toEqual({
      ok: false,
      message: '没有这个邮件插件：nope',
    });
  });
});

describe('mail.mailbox adapter', () => {
  it('no account → unconfigured', () => {
    const adapter = buildItemAdapters(deps({ mail: [] }))(item('mail.mailbox'));
    const snapshot = adapter.read(item('mail.mailbox'), target);
    expect(snapshot.status).toBe('unconfigured');
    expect(snapshot.values).toBeNull();
  });

  it('prefers the mailbox already given to this Bot', () => {
    const adapter = buildItemAdapters(
      deps({
        mail: [
          account({ id: 'mal_2', address: 'other@example.com', botIds: ['bot_a'] }),
          account({ id: 'mal_1', botIds: ['bot_b'] }),
        ],
      }),
    )(item('mail.mailbox'));
    const snapshot = adapter.read(item('mail.mailbox'), target);
    expect(snapshot.status).toBe('configured');
    expect(snapshot.values).toEqual({ account: 'mal_2', bots: ['bot_a'], paused: false });
  });

  it('focus on a mailbox reads that one; paused is reflected', () => {
    const adapter = buildItemAdapters(
      deps({ mail: [account(), account({ id: 'mal_2', status: 'paused', botIds: ['bot_a'] })] }),
    )(item('mail.mailbox'));
    const snapshot = adapter.read(item('mail.mailbox'), target, { account: 'mal_2' });
    expect(snapshot.values).toEqual({ account: 'mal_2', bots: ['bot_a'], paused: true });
    expect(snapshot.summary).toContain('已暂停收信');
  });

  it('lists mailboxes / active Bots and rejects unknown ids', () => {
    const adapter = buildItemAdapters(deps({ mail: [account()] }))(item('mail.mailbox'));
    const [accountField, botsField] = item('mail.mailbox').fields;
    expect(adapter.options?.(accountField!, item('mail.mailbox'), target)).toEqual([
      { value: 'mal_1', label: '工作 <work@example.com>' },
    ]);
    expect(adapter.options?.(botsField!, item('mail.mailbox'), target)).toEqual([
      { value: 'bot_a', label: 'bot_a' },
      { value: 'bot_b', label: 'bot_b' },
    ]);
    expect(adapter.normalize?.(item('mail.mailbox'), { account: 'nope' }, target)).toEqual({
      ok: false,
      message: '没有这个邮箱：nope',
    });
    expect(
      adapter.normalize?.(item('mail.mailbox'), { account: 'mal_1', bots: ['ghost'] }, target),
    ).toEqual({ ok: false, message: '没有这个 Bot：ghost' });
  });

  it('accepts a comma separated Bot list from the model', () => {
    const adapter = buildItemAdapters(deps({ mail: [account()] }))(item('mail.mailbox'));
    expect(
      adapter.normalize?.(item('mail.mailbox'), { account: 'mal_1', bots: 'bot_a, bot_b' }, target),
    ).toEqual({ ok: true, values: { account: 'mal_1', bots: ['bot_a', 'bot_b'] } });
  });
});
