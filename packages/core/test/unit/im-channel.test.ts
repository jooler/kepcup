import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IM_FORWARD_TRUNCATED_SUFFIX, type ImAccount } from '@kepcup/shared';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations, migrationTargetVersion } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { mainVersionsAfter } from '../support/migration-versions.js';
import { ImStore, type ImAccountRecord } from '../../src/im/store.js';
import { ImSessionHub } from '../../src/im/session.js';
import { renderForwardText, ImForwarder } from '../../src/im/forwarder.js';
import { ImService } from '../../src/im/service.js';
import { ILinkClient, ILinkSessionExpiredError } from '../../src/im/ilink.js';
import type { ILinkMessage } from '../../src/im/ilink.js';
import type { CoreLogger } from '../../src/infra/logger.js';
import type { Message } from '@kepcup/shared';

/**
 * IM 通道（D107–D111，54 号文档）单测：迁移 0066 的表与枚举、store 的绑定 /
 * 转发开关语义、会话退避与 -14 暂停、转发文本渲染与入队过滤、ingest 扇出
 * （去重键含 botId、D111 自动补勾、风暴暂停、启用集过滤）。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as CoreLogger;

// --- 迁移 0066 -----------------------------------------------------------------

const root = mkdtempSync(path.join(tmpdir(), 'im-channel-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeDb(): SqliteDatabase {
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return db;
}

describe('migration 0066 (plugin im)', () => {
  it('creates im_accounts / im_account_bots and widens the kind CHECKs', () => {
    const db = makeDb();
    expect(migrationTargetVersion(migrationsUrl('main'))).toBeGreaterThanOrEqual(66);
    // plugin_instances 接受 'im'，拒绝未知 kind。
    db.prepare(
      "insert into plugins (id, version, origin, tier, state, enabled, package_sha256, dir, installed_at, updated_at) values ('io.a/im', '1.0.0', 'local', 'developer', 'installed', 1, 'a', 'io.a/im@1.0.0', 0, 0)",
    ).run();
    db.prepare(
      "insert into plugin_instances (id, plugin_id, kind, title, config_json, created_at, updated_at) values ('pli_1', 'io.a/im', 'im', 'x', '{}', 0, 0)",
    ).run();
    expect(() =>
      db
        .prepare(
          "insert into plugin_instances (id, plugin_id, kind, title, config_json, created_at, updated_at) values ('pli_2', 'io.a/im', 'sms', 'x', '{}', 0, 0)",
        )
        .run(),
    ).toThrow();
    // im_accounts：卸载级联（FK CASCADE）。
    db.prepare(
      "insert into im_accounts (id, instance_id, transport, api_base, label, status, config_json, created_at, updated_at) values ('ima_1', 'pli_1', 'ilink', 'https://ilinkai.weixin.qq.com', '微信', 'connecting', '{}', 0, 0)",
    ).run();
    db.prepare(
      "insert into im_account_bots (account_id, bot_id, forward_enabled, created_at) values ('ima_1', 'bot_a', 1, 0)",
    ).run();
    db.prepare('delete from plugin_instances where id = ?').run('pli_1');
    expect(db.prepare('select count(*) as n from im_accounts').get()).toEqual({ n: 0 });
    expect(db.prepare('select count(*) as n from im_account_bots').get()).toEqual({ n: 0 });
  });
});

// --- store ---------------------------------------------------------------------

function seedInstance(db: SqliteDatabase, pluginId = 'io.a/im', instanceId = 'pli_test'): void {
  db.prepare(
    "insert into plugins (id, version, origin, tier, state, enabled, package_sha256, dir, installed_at, updated_at) values (?, '1.0.0', 'local', 'developer', 'installed', 1, 'a', ?, 0, 0)",
  ).run(pluginId, `${pluginId}@1.0.0`);
  db.prepare(
    "insert into plugin_instances (id, plugin_id, kind, title, config_json, created_at, updated_at) values (?, ?, 'im', 'x', '{}', 0, 0)",
  ).run(instanceId, pluginId);
}

function accountRow(overrides: Partial<ImAccountRecord> = {}): ImAccountRecord {
  return {
    id: 'ima_test',
    instanceId: 'pli_test',
    transport: 'ilink',
    apiBase: 'https://ilinkai.weixin.qq.com',
    label: '微信',
    status: 'ready',
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    configJson: '{}',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('ImStore', () => {
  it('round-trips accounts and bindings; setForward is idempotent and reports change', () => {
    const db = makeDb();
    seedInstance(db);
    const store = new ImStore(db);
    store.insert(accountRow());
    expect(store.get('ima_test')?.label).toBe('微信');
    expect(store.idByInstance('pli_test')).toBe('ima_test');
    expect(store.countActiveForPlugin('io.a/im')).toBe(1);
    expect(store.countActiveForPlugin('io.a/other')).toBe(0);

    expect(store.setForward('ima_test', 'bot_a', true, 10)).toBe(false); // 绑定不存在
    store.replaceBots('ima_test', ['bot_a', 'bot_b'], 1);
    store.setForward('ima_test', 'bot_a', true, 2);
    expect(store.setForward('ima_test', 'bot_a', true, 3)).toBe(false); // 幂等
    expect(store.setForward('ima_test', 'bot_a', false, 4)).toBe(true);
    let bindings = store.bindings('ima_test');
    expect(bindings.find((row) => row.botId === 'bot_a')?.forwardEnabled).toBe(false);
    expect(bindings.find((row) => row.botId === 'bot_a')?.forwardUpdatedAt).toBe(4);
    expect(bindings.find((row) => row.botId === 'bot_b')?.forwardEnabled).toBe(false);

    // 整集替换保留既有行的开关 / 时间；删 Bot 只清它的绑定。
    store.setForward('ima_test', 'bot_a', true, 5);
    store.replaceBots('ima_test', ['bot_a', 'bot_c'], 6);
    bindings = store.bindings('ima_test');
    expect(bindings.map((row) => row.botId).sort()).toEqual(['bot_a', 'bot_c']);
    expect(bindings.find((row) => row.botId === 'bot_a')?.forwardEnabled).toBe(true);
    expect(store.deleteBindingsForBot('bot_c')).toBe(1);
    expect(store.bindings('ima_test').length).toBe(1);
    store.delete('ima_test');
    expect(store.get('ima_test')).toBeNull();
  });
});

// --- session hub ---------------------------------------------------------------

interface FakeClientState {
  getUpdates: (token: string, cursor: string) => Promise<{ cursor: string; msgs: ILinkMessage[] } | null>;
}

describe('ImSessionHub', () => {
  it('long-polls, forwards batches, and pauses on -14 without crashing', async () => {
    const state: FakeClientState = {
      // 生产里 getupdates 是长轮询（服务器挂住 ~35s）——测试桩必须同样「等」，
      // 否则 hub 的成功循环会变成微任务风暴把测试进程饿死。
      getUpdates: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { cursor: 'c1', msgs: [basicMessage('m1')] };
      },
    };
    const hubDb = makeDb();
    seedInstance(hubDb);
    const store = new ImStore(hubDb);
    store.insert(accountRow({ configJson: '{}' }));
    const batches: string[][] = [];
    let expired = 0;
    const hub = new ImSessionHub({
      load: (id) => store.get(id),
      token: () => 'token',
      saveCursor: (id, cursor) => {
        const row = store.get(id);
        if (row !== null) store.patch(id, { configJson: JSON.stringify({ cursor }) });
      },
      onReady: () => undefined,
      onMessages: (id, msgs) => batches.push(msgs.map((m) => String(m.message_id))),
      onFailure: () => undefined,
      onSessionExpired: () => {
        expired += 1;
      },
      onAuthFailed: () => undefined,
      openClient: () =>
        ({
          notify: async () => undefined,
          getUpdates: (token: string, cursor: string) => state.getUpdates(token, cursor),
        }) as never,
      backoffMs: () => 1,
      sessionPauseMs: 5,
    });
    hub.start('ima_test');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(batches).toEqual([['m1']]);
    // -14：会话暂停回调触发，一小时后自动重试（暂停时长注入为 5ms）。
    state.getUpdates = async () => {
      throw new ILinkSessionExpiredError(-14, 'session timeout');
    };
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(expired).toBeGreaterThanOrEqual(1);
    hub.stopAll();
  });
});

function basicMessage(messageId: string): ILinkMessage {
  return {
    message_id: messageId,
    from_user_id: 'user_a',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: '今天天气怎么样' } }],
    context_token: 'ctx_1',
  };
}

// --- forwarder -----------------------------------------------------------------

describe('renderForwardText', () => {
  it('strips markdown and truncates with the suffix', () => {
    expect(renderForwardText('## 标题\n**加粗** 与 `code`')).toBe('标题\n加粗 与 code');
    expect(renderForwardText('[链接](https://a.example.com)')).toBe('链接（https://a.example.com）');
    const long = 'K'.repeat(2500);
    const rendered = renderForwardText(long);
    expect(rendered.startsWith('K'.repeat(2000))).toBe(true);
    expect(rendered.endsWith(IM_FORWARD_TRUNCATED_SUFFIX)).toBe(true);
  });
});

describe('ImForwarder', () => {
  function message(overrides: Partial<Message> = {}): Message {
    return {
      id: 'msg_1',
      conversationId: 'conv_1',
      seq: 1,
      senderType: 'bot',
      senderBotId: 'bot_a',
      kind: 'text',
      content: { text: '回复内容' },
      replyTo: null,
      mentions: [],
      batchId: null,
      runId: null,
      status: 'normal',
      editedAt: null,
      createdAt: 0,
      attachments: [],
      ownerBotId: null,
      taskId: null,
      ...overrides,
    } as Message;
  }

  function rig(conversation: { type: string; directBotId: string | null } | null) {
    const enqueued: Array<{ messageId: string; botId: string; text: string }> = [];
    const forwarder = new ImForwarder({
      im: {
        enqueueForwards: (input: { messageId: string; botId: string; text: string }) =>
          enqueued.push(input),
      } as never,
      conversations: {
        get: (id: string) =>
          conversation === null ? null : ({ id, ...conversation } as never),
      } as never,
      logger,
    });
    return { forwarder, enqueued };
  }

  it('mirrors bot text replies in direct conversations only', () => {
    const direct = rig({ type: 'direct', directBotId: 'bot_a' });
    direct.forwarder.handleMessage(message());
    expect(direct.enqueued).toEqual([
      { conversationId: 'conv_1', messageId: 'msg_1', botId: 'bot_a', text: '回复内容' },
    ]);
    // 项目会话 / 用户消息 / 非文本：不转发。
    const project = rig({ type: 'project', directBotId: null });
    project.forwarder.handleMessage(message({ conversationId: 'conv_p' }));
    expect(project.enqueued).toEqual([]);
    const none = rig(null);
    none.forwarder.handleMessage(message());
    expect(none.enqueued).toEqual([]);
    const user = rig({ type: 'direct', directBotId: 'bot_a' });
    user.forwarder.handleMessage(message({ senderType: 'user', senderBotId: null }));
    expect(user.enqueued).toEqual([]);
  });
});


describe('ILinkClient long-poll timeouts', () => {
  /** 永不响应的 fetch：只在客户端 abort 时以 AbortError 拒绝（模拟服务器挂住）。 */
  function hangingFetch(): typeof fetch {
    return ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
  }

  it('qrcode status poll maps the long-poll abort to wait', async () => {
    const client = new ILinkClient({ apiBase: 'https://x.example.com', logger, fetchImpl: hangingFetch(), qrPollTimeoutMs: 30 });
    const status = await client.pollQrcodeStatus('qr');
    expect(status.status).toBe('wait');
  }, 10_000);

  it('getUpdates maps the long-poll abort to no data (null)', async () => {
    const client = new ILinkClient({ apiBase: 'https://x.example.com', logger, fetchImpl: hangingFetch(), pollTimeoutMs: 30 });
    const batch = await client.getUpdates('token', 'c0');
    expect(batch).toBeNull();
  }, 10_000);
});

// --- service ingest ------------------------------------------------------------

  function serviceRig(options: { pluginEnabled?: boolean; boundBots?: string[] } = {}) {
    const db = makeDb();
    seedInstance(db);
    const store = new ImStore(db);
    store.insert(
      accountRow({
        configJson: JSON.stringify({ ilink_user_id: 'user_a', cursor: '' }),
      }),
    );
const enqueued: Array<{ type: string; payload: Record<string, unknown>; dedupeKey?: string; botId?: string }> = [];
const notices: Array<{ key: string; text: string }> = [];
const systemEvents: string[] = [];
const forwardToggles: Array<{ botId: string; enabled: boolean }> = [];
const forwardState = { enabled: options.boundBots === undefined ? false : false };
void forwardState;
const bindings: Array<{ botId: string; forwardEnabled: boolean }> = (
  options.boundBots ?? ['bot_a']
).map((botId) => ({ botId, forwardEnabled: false }));
// 预置绑定行（replaceBots 后再关掉开关，模拟 D111 初始态）。
store.replaceBots('ima_test', bindings.map((binding) => binding.botId), 0);
for (const binding of bindings) {
  store.setForward('ima_test', binding.botId, binding.forwardEnabled, 0);
}
const service = new ImService({
  db,
  clock: { now: () => 1000 },
  logger,
  secrets: {
    getValue: () => 'token',
    setValue: () => undefined,
    removeValue: () => undefined,
    hasValue: () => true,
    names: () => [],
  } as never,
  bots: {
    get: (botId: string) => ({ id: botId, name: botId, status: 'active' }) as never,
  } as never,
  conversations: {
    openDirect: (botId: string) => ({
      conversation: { id: `conv_${botId}`, created: true },
      created: true,
    }),
  } as never,
  messages: {
    append: (input: { kind: string; event?: string }) => {
      systemEvents.push(input.event ?? input.kind);
      return { id: 'msg_sys', content: {} } as never;
    },
  } as never,
  jobs: {
    enqueue: (input: { type: string; payload: Record<string, unknown>; dedupeKey?: string; botId?: string }) =>
      enqueued.push(input),
  } as never,
  taint: { mark: () => undefined },
  deliverAlert: () => undefined,
  publishAccount: () => undefined,
  publishMessage: () => undefined,
  notice: (notice: { key: string; text: string }) => notices.push(notice),
  instanceOwner: {
    ownerOf: () => ({ pluginId: 'io.a/im' }),
    pluginName: () => '微信',
    botTokenSecretName: () => 'plugin:io_a_sim:instance:pli_test:bot_token',
  },
  instances: {
    create: async () => ({ id: 'pli_new' }) as never,
    update: async () => ({ id: 'pli_test' }) as never,
  },
  pluginEnabledForBot: () => options.pluginEnabled ?? true,
  openClient: () =>
    ({
      notify: async () => undefined,
      getUpdates: async () => null,
      sendText: async () => ({ ok: true, code: 0, errmsg: '' }),
    }) as never,
});
return { store, service, enqueued, notices, systemEvents, forwardToggles, db };
  }

describe('ImService ingest', () => {
  it('fans out to bound bots with botId-scoped dedupe keys and auto-enables the sync toggle (D111)', () => {
    const rig = serviceRig({ boundBots: ['bot_a', 'bot_b'] });
    rig.service.ingest('ima_test', [basicMessage('m1')]);
    const types = rig.enqueued.map((job) => job.type);
    expect(types).toEqual(['im_alert', 'im_alert']);
    expect(rig.enqueued[0]!.dedupeKey).toBe('im:ima_test:m1:bot_a');
    expect(rig.enqueued[1]!.dedupeKey).toBe('im:ima_test:m1:bot_b');
    // D111：两个绑定都自动补勾 + 一次性提示 + 对话内系统事件。
    expect(rig.store.bindings('ima_test').every((binding) => binding.forwardEnabled)).toBe(true);
    expect(rig.notices.filter((notice) => notice.key.startsWith('im-sync:')).length).toBe(2);
    expect(rig.systemEvents.filter((event) => event === 'im_sync_enabled').length).toBe(2);
  });

  it('already-enabled bindings do not re-notify; unbound accounts get one notice', () => {
    const rig = serviceRig({ boundBots: ['bot_a'] });
    rig.service.ingest('ima_test', [basicMessage('m1')]);
    expect(rig.notices.length).toBe(1);
    // 第二条入站：开关已开，不再提示。
    rig.service.ingest('ima_test', [basicMessage('m2')]);
    expect(rig.notices.length).toBe(1);
    expect(rig.enqueued.length).toBe(2);
    expect(rig.enqueued[1]!.dedupeKey).toBe('im:ima_test:m2:bot_a');

    const unbound = serviceRig({ boundBots: [] });
    unbound.service.ingest('ima_test', [basicMessage('m1')]);
    expect(unbound.enqueued.length).toBe(0);
    expect(unbound.notices.some((notice) => notice.key === 'im-unbound:ima_test')).toBe(true);
  });

  it('drops unauthorized sources and pauses bindings over the hourly alert cap', () => {
    const rig = serviceRig({ boundBots: ['bot_a'] });
    // 陌生来源（ilinkUserId 已知）：丢弃。
    rig.service.ingest('ima_test', [
      { ...basicMessage('m1'), from_user_id: 'stranger' },
    ]);
    expect(rig.enqueued.length).toBe(0);
    // 风暴：超过 IM_MAX_ALERTS_PER_HOUR 后该绑定暂停、不再入队。
    for (let index = 0; index < 32; index++) {
      rig.service.ingest('ima_test', [basicMessage(`m${index}`)]);
    }
    const paused = rig.store.bindings('ima_test')[0]!;
    expect(paused.alertsPaused).toBe(true);
    expect(rig.enqueued.length).toBeLessThan(32);
    expect(rig.notices.some((notice) => notice.key.startsWith('im-paused:'))).toBe(true);
  });

  it('bindings of bots without the owning plugin enabled are invisible (启用集过滤)', () => {
    const rig = serviceRig({ boundBots: ['bot_a'], pluginEnabled: false });
    rig.service.ingest('ima_test', [basicMessage('m1')]);
    expect(rig.enqueued.length).toBe(0);
    expect(rig.store.bindings('ima_test')[0]!.forwardEnabled).toBe(false);
  });
});

// --- public projection ----------------------------------------------------------

describe('ImService publicAccount', () => {
  it('hides cursors / tokens and projects binding flags', () => {
    const rig = serviceRig({ boundBots: ['bot_a'] });
    rig.store.setForward('ima_test', 'bot_a', true, 5);
    const account = rig.service.listAccounts()[0] as ImAccount;
    expect(account.botIds).toEqual(['bot_a']);
    expect(account.forwardBotIds).toEqual(['bot_a']);
    expect(account.pluginId).toBe('io.a/im');
    const serialized = JSON.stringify(account);
    expect(serialized).not.toContain('cursor');
    expect(serialized).not.toContain('context_token');
    expect(serialized).not.toContain('forward_times');
  });
});
