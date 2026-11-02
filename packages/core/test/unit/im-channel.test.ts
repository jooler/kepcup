import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IM_ALERT_EVENT, IM_FORWARD_TRUNCATED_SUFFIX, type ImAccount } from '@kepcup/shared';

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

  it('sendText 每个请求都带 X-WECHAT-UIN（缺它 sendmessage 被 ret -2 invalid arguments 打回）', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = ((_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers ?? {});
      return Promise.resolve(new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
    }) as unknown as typeof fetch;
    const client = new ILinkClient({ apiBase: 'https://x.example.com', logger, fetchImpl });
    const result = await client.sendText({ token: 't', toUserId: 'u', text: 'hi' });
    expect(result.ok).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0]!['X-WECHAT-UIN']).toBeTruthy();
  });
});

// --- service ingest ------------------------------------------------------------

  function serviceRig(
    options: {
      pluginEnabled?: boolean;
      boundBots?: string[];
      /** 覆盖账号 config_json（回归 legacy camelCase 形态用）。 */
      configJson?: string;
      /** 注入 sendmessage 响应；默认成功。 */
      sendResult?: { ok: boolean; code: number; errmsg: string };
    } = {},
  ) {
    const db = makeDb();
    seedInstance(db);
    const store = new ImStore(db);
    store.insert(
      accountRow({
        configJson: options.configJson ?? JSON.stringify({ ilink_user_id: 'user_a', cursor: '' }),
      }),
    );
const sent: Array<{ toUserId: string; text: string; contextToken?: string }> = [];
const enqueued: Array<{ type: string; payload: Record<string, unknown>; dedupeKey?: string; botId?: string }> = [];
const notices: Array<{ key: string; text: string }> = [];
const systemEvents: string[] = [];
const alerts: Array<{ botId: string; conversationId: string; text: string }> = [];
// messages.append / deliverAlert 都往真实 messages 表落行：runAlertJob 的幂等
// 查询（#cardExists / #wakeExists 走 json_extract SQL）要在真实 schema 上编译
// 执行——回归：wakeExists 曾引用不存在的 event 列，作业在线上 prepare 即崩。
let fakeSeq = 1;
const insertFakeMessage = (conversationId: string, content: Record<string, unknown>): string => {
  const id = `msg_${fakeSeq++}`;
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare(
      "insert into messages (id, conversation_id, seq, sender_type, kind, content_json, created_at) values (?, ?, ?, 'system', ?, ?, 1000)",
    ).run(
      id,
      conversationId,
      fakeSeq - 1,
      content.event === undefined ? 'card' : 'system_event',
      JSON.stringify(content),
    );
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return id;
};
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
    append: (input: { conversationId: string; kind: string; event?: string; text?: string; cardIm?: Record<string, unknown> }) => {
      const id = insertFakeMessage(input.conversationId, {
        ...(input.event !== undefined ? { event: input.event } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.cardIm ?? {}),
      });
      systemEvents.push(input.event ?? input.kind);
      return { id, content: {} } as never;
    },
  } as never,
  jobs: {
    enqueue: (input: { type: string; payload: Record<string, unknown>; dedupeKey?: string; botId?: string }) =>
      enqueued.push(input),
  } as never,
  taint: { mark: () => undefined },
  deliverAlert: (input: { botId: string; conversationId: string; text: string }) => {
    alerts.push(input);
    // 模拟 orchestrator.deliverEventToBot：唤醒系统事件落 messages 表（$.event/$.text）。
    insertFakeMessage(input.conversationId, { event: IM_ALERT_EVENT, text: input.text });
  },
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
      sendText: async (input: { toUserId: string; text: string; contextToken?: string }) => {
        sent.push(input);
        return options.sendResult ?? { ok: true, code: 0, errmsg: '' };
      },
    }) as never,
});
return { store, service, enqueued, notices, systemEvents, forwardToggles, alerts, db, sent };
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

  it('config 缺 ilink_user_id 时用首条入站锁定授权用户，之后陌生来源被拒（自愈）', () => {
    const rig = serviceRig({ boundBots: ['bot_a'], configJson: JSON.stringify({ cursor: 'c0' }) });
    rig.service.ingest('ima_test', [basicMessage('m1')]);
    const row = rig.db.prepare('select config_json from im_accounts where id = ?').get('ima_test') as {
      config_json: string;
    };
    expect((JSON.parse(row.config_json) as Record<string, unknown>).ilink_user_id).toBe('user_a');
    expect(rig.enqueued.length).toBe(1);
    rig.service.ingest('ima_test', [{ ...basicMessage('m2'), from_user_id: 'stranger' }]);
    expect(rig.enqueued.length).toBe(1);
  });
});

describe('ImService runAlertJob', () => {
  it('贴卡并唤醒一次；重跑幂等（幂等 SQL 在真实 messages 表 schema 上执行）', () => {
    const rig = serviceRig({ boundBots: ['bot_a'] });
    const job = {
      id: 'job_im1',
      type: 'im_alert',
      bot_id: 'bot_a',
      conversation_id: 'conv_bot_a',
      payload_json: JSON.stringify({
        accountId: 'ima_test',
        botId: 'bot_a',
        msgId: 'm1',
        key: 'im:ima_test:m1:bot_a',
        channel: '微信',
        summary: '今天天气怎么样',
      }),
    } as never;
    rig.service.runAlertJob(job);
    // 贴卡 + 唤醒各一次（回归：wakeExists 引用不存在的列时 prepare 即抛 SQLITE_ERROR）。
    expect(rig.systemEvents).toContain('card');
    expect(rig.alerts).toEqual([
      { botId: 'bot_a', conversationId: 'conv_bot_a', text: expect.stringContaining('im_alert ima_test m1') },
    ]);
    // 重跑：卡与唤醒都已存在 → 不再贴卡、不再唤醒。
    rig.service.runAlertJob(job);
    expect(rig.systemEvents.filter((event) => event === 'card').length).toBe(1);
    expect(rig.alerts.length).toBe(1);
  });
});

// --- config_json 存储契约（回归 2026-11-03 线上转发失败） ----------------------------

describe('ImService config_json 写入契约', () => {
  function accountConfig(rig: ReturnType<typeof serviceRig>): Record<string, unknown> {
    const row = rig.db.prepare('select config_json from im_accounts where id = ?').get('ima_test') as {
      config_json: string;
    };
    return JSON.parse(row.config_json) as Record<string, unknown>;
  }

  it('入站写 context_token / cursor 时保留登录元数据（回归：写回解析视图把 ilink_user_id 冲掉）', () => {
    const rig = serviceRig({ boundBots: ['bot_a'] });
    rig.service.ingest('ima_test', [basicMessage('m1')]);
    const config = accountConfig(rig);
    expect(config.ilink_user_id).toBe('user_a');
    expect(config.context_token).toBe('ctx_1');
    // 不再残留 camelCase 解析视图。
    expect(config.ilinkUserId).toBeUndefined();
    expect(config.forwardTimes).toBeUndefined();
  });

  it('legacy camelCase 配置自愈：转发用 ilinkUserId 恢复出的 to_user_id，写回后归一为 snake_case', async () => {
    const rig = serviceRig({
      boundBots: ['bot_a'],
      configJson: JSON.stringify({ ilinkUserId: 'user_legacy', ilinkBotId: 'bot_x', cursor: '' }),
    });
    rig.store.setForward('ima_test', 'bot_a', true, 0);
    await rig.service.runForwardJob({
      id: 'job_f1',
      type: 'im_forward',
      bot_id: 'bot_a',
      conversation_id: 'conv_bot_a',
      payload_json: JSON.stringify({
        accountId: 'ima_test',
        botId: 'bot_a',
        conversationId: 'conv_bot_a',
        messageId: 'msg_bot_1',
        text: '回复文本',
      }),
    } as never);
    expect(rig.sent).toEqual([{ token: 'token', toUserId: 'user_legacy', text: '回复文本' }]);
    const config = accountConfig(rig);
    expect(config.ilink_user_id).toBe('user_legacy');
    expect(config.forward_times).toEqual([1000]);
    expect(config.ilinkUserId).toBeUndefined();
  });

  it('转发失败写回 forward_failures 时同样保留 ilink_user_id', async () => {
    const rig = serviceRig({
      boundBots: ['bot_a'],
      configJson: JSON.stringify({ ilink_user_id: 'user_a', ilink_bot_id: 'bot_x' }),
      sendResult: { ok: false, code: -2, errmsg: 'invalid arguments' },
    });
    rig.store.setForward('ima_test', 'bot_a', true, 0);
    await expect(
      rig.service.runForwardJob({
        id: 'job_f2',
        type: 'im_forward',
        bot_id: 'bot_a',
        conversation_id: 'conv_bot_a',
        payload_json: JSON.stringify({
          accountId: 'ima_test',
          botId: 'bot_a',
          conversationId: 'conv_bot_a',
          messageId: 'msg_bot_2',
          text: '回复文本',
        }),
      } as never),
    ).rejects.toThrow(/im_forward failed/);
    const config = accountConfig(rig);
    expect(config.ilink_user_id).toBe('user_a');
    expect(config.ilink_bot_id).toBe('bot_x');
    expect(config.forward_failures).toBe(1);
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
