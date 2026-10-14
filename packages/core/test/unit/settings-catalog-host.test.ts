import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SETTING_CARDS_PER_RUN_MAX,
  SETTING_CARD_DECLINE_WINDOW_MS,
  SETTING_RECEIPT_UNDO_WINDOW_MS,
  type Bot,
  type Message,
  type ProviderInfo,
  type SettingCardContent,
  type SettingCardResolved,
  type SetupRequirement,
} from '@kepcup/shared';
import { botProfile } from '@kepcup/testkit';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { MessagesService } from '../../src/domain/messages.js';
import { SettingsService } from '../../src/domain/settings.js';
import type { AdapterDeps } from '../../src/settings/adapters.js';
import { SettingsCatalogHost, type SettingsRunContext } from '../../src/settings/host.js';
import { SettingsWriteLock } from '../../src/settings/write-lock.js';
import {
  TRUSTED_TOOLS,
  UNTRUSTED_TOOLS,
  isUntrustedReadTool,
  triggerCarriesUntrusted,
  triggerFromUser,
} from '../../src/settings/context.js';
import { CLASSIFIED_BUILTIN_TOOLS } from '../../src/agent/effects/classify.js';
import { renderSettingCardLine } from '../../src/settings/render.js';
import { buildSettingsTools } from '../../src/tools/settings-tools.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * 对话内应用设置的 core 宿主（todo/conversational-app-setup.md §4.1 / §5 / §6）：条目级 CAS、
 * 脱敏读取、档位上下文、设置卡的防刷屏 / 顶替 / 拒绝退避、回执卡撤销与唤醒。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'settings-catalog-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SECRET = 'sk-super-secret-value';

interface Rig {
  db: SqliteDatabase;
  host: SettingsCatalogHost;
  settings: SettingsService;
  messages: MessagesService;
  secrets: Map<string, string>;
  bots: Map<string, Bot>;
  published: Array<{ event: string; payload: unknown }>;
  wakes: Array<{
    botId: string;
    conversationId: string;
    text: string;
    resolved: SettingCardResolved;
  }>;
  clock: { now: () => number; advance: (ms: number) => void };
  conversationId: string;
  groupId: string;
  tainted: Set<string>;
}

let rigCount = 0;

function makeBot(id: string, overrides: Partial<Bot['profile']['runtime']> = {}): Bot {
  const profile = botProfile({ name: id });
  return {
    id,
    name: id,
    bio: '',
    status: 'active',
    systemRole: null,
    setupState: 'done',
    profile: { ...profile, runtime: { ...profile.runtime, ...overrides } },
  } as unknown as Bot;
}

function makeRig(
  extras: {
    appConnections?: AdapterDeps['appConnections'];
    environment?: AdapterDeps['environment'];
    sandbox?: AdapterDeps['sandbox'];
  } = {},
): Rig {
  const home = path.join(dir, `home-${rigCount++}`);
  mkdirSync(home, { recursive: true });
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advance: (ms: number) => void (now += ms) };
  const conversationId = `conv_${rigCount}`;
  const groupId = `group_${rigCount}`;
  for (const [id, type] of [
    [conversationId, 'direct'],
    [groupId, 'group'],
  ] as const) {
    db.prepare(
      'insert into conversations (id, type, last_seq, created_at) values (?, ?, 0, ?)',
    ).run(id, type, now);
  }
  const settings = new SettingsService(db, clock);
  settings.update({
    customProviders: [
      {
        id: 'mock',
        name: 'Mock',
        baseUrl: 'http://127.0.0.1:1/v1',
        models: [
          { id: 'mock-main', name: 'Mock Main', contextWindow: 1000 },
          { id: 'mock-alt', name: 'Mock Alt', contextWindow: 1000 },
          { id: 'mock-x', name: 'Mock X', contextWindow: 1000 },
        ],
      },
    ] as never,
    defaultMainModel: 'custom:mock/mock-main',
    defaultLightModel: 'custom:mock/mock-alt',
  });
  const secrets = new Map<string, string>([['provider:custom:mock', SECRET]]);
  const providers = (): ProviderInfo[] => [
    {
      id: 'custom:mock',
      name: 'Mock',
      kind: 'custom',
      models: [
        { id: 'mock-main', name: 'Mock Main', contextWindow: 1000 },
        { id: 'mock-alt', name: 'Mock Alt', contextWindow: 1000 },
        { id: 'mock-x', name: 'Mock X', contextWindow: 1000 },
      ],
      hasKey: secrets.has('provider:custom:mock'),
    },
    {
      id: 'openai',
      name: 'OpenAI',
      kind: 'builtin',
      models: [{ id: 'gpt-x', name: 'GPT X', contextWindow: 1000 }],
      hasKey: secrets.has('provider:openai'),
    },
  ];
  const bots = new Map<string, Bot>([
    ['bot_a', makeBot('bot_a')],
    ['bot_b', makeBot('bot_b')],
  ]);
  const messages = new MessagesService(db, clock);
  const published: Rig['published'] = [];
  const wakes: Rig['wakes'] = [];
  const tainted = new Set<string>();
  const host = new SettingsCatalogHost({
    db,
    messages,
    clock,
    logger: { warn: () => {}, info: () => {} } as never,
    lock: new SettingsWriteLock(),
    settings,
    secrets: {
      hasValue: (name) => secrets.has(name),
      setValue: (name, value) => void secrets.set(name, value),
    },
    providers: {
      list: providers,
      setKey: (provider, key) => void secrets.set(`provider:${provider}`, key),
    },
    bots: {
      get: (id) => bots.get(id) ?? null,
      update: (id, profile) => {
        const next = { ...bots.get(id)!, profile } as Bot;
        bots.set(id, next);
        return next;
      },
    },
    conversations: {
      get: (id) =>
        id === conversationId
          ? { title: null, type: 'direct', projectId: null }
          : id === groupId
            ? { title: '项目群', type: 'group', projectId: null }
            : null,
    },
    taint: { isTainted: (botId, conv) => tainted.has(`${botId}:${conv}`) },
    agentCatalog: () =>
      [
        { id: 'agent-a', name: 'Agent A' },
        { id: 'agent-b', name: 'Agent B' },
      ] as never,
    publish: (event, payload) => void published.push({ event, payload }),
    wake: (input) => void wakes.push(input),
    ...(extras.appConnections !== undefined ? { appConnections: extras.appConnections } : {}),
    ...(extras.environment !== undefined ? { environment: extras.environment } : {}),
    ...(extras.sandbox !== undefined ? { sandbox: extras.sandbox } : {}),
  });
  return {
    db,
    host,
    settings,
    messages,
    secrets,
    bots,
    published,
    wakes,
    clock,
    conversationId,
    groupId,
    tainted,
  };
}

let runCount = 0;

function runCtx(
  rig: Rig,
  over: Partial<Omit<SettingsRunContext, 'identity'>> & {
    loopType?: 'turn' | 'task';
    conversationId?: string;
    botId?: string;
    runId?: string;
    untrusted?: boolean;
  } = {},
): SettingsRunContext & { setup: SetupRequirement[] } {
  const identity: RunIdentity = {
    runId: over.runId ?? `run_${runCount++}`,
    botId: over.botId ?? 'bot_a',
    conversationId: over.conversationId ?? rig.conversationId,
    loopType: over.loopType ?? 'turn',
  };
  const setup: SetupRequirement[] = [];
  return {
    identity,
    triggerReason: over.triggerReason ?? (identity.loopType === 'task' ? 'task' : 'direct'),
    triggerFromUser: over.triggerFromUser ?? identity.loopType !== 'task',
    isGroup: over.isGroup ?? identity.conversationId === rig.groupId,
    isButler: over.isButler ?? false,
    touchedUntrusted: over.touchedUntrusted ?? (() => over.untrusted === true),
    ...(over.externalEngine !== undefined ? { externalEngine: over.externalEngine } : {}),
    onSetupRequired: (requirement) => void setup.push(requirement),
    setup,
  };
}

function cardOf(rig: Rig, messageId: string): SettingCardContent {
  const message = rig.messages.getById(messageId)!;
  return (message.content as { setting: SettingCardContent }).setting;
}

function cards(rig: Rig, conversationId = rig.conversationId): Message[] {
  return rig.messages
    .list(conversationId, { limit: 200 })
    .filter((message) => (message.content as { event?: string }).event === 'setting_card');
}

function messageIdIn(text: string): string {
  const match = /msg_[A-Za-z0-9]+/.exec(text);
  if (match === null) throw new Error(`no message id in: ${text}`);
  return match[0];
}

describe('settings catalog: mode context helpers', () => {
  const user = { senderType: 'user', kind: 'text', content: { text: 'hi' } } as unknown as Message;
  const otherBot = {
    senderType: 'bot',
    kind: 'text',
    content: { text: 'hi' },
  } as unknown as Message;
  const widget = {
    senderType: 'user',
    kind: 'text',
    content: { text: 'hi', origin: 'widget', widgetId: 'w' },
  } as unknown as Message;
  const delegated = {
    senderType: 'user',
    kind: 'text',
    content: { text: 'hi', origin: 'delegation' },
  } as unknown as Message;
  const mailAlert = {
    senderType: 'system',
    kind: 'system_event',
    content: { event: 'mail_alert', text: 'new mail', internal: true },
  } as unknown as Message;

  it('only the user themself counts as the trigger sender', () => {
    expect(triggerFromUser({ messages: [user] })).toBe(true);
    expect(triggerFromUser({ messages: [user, otherBot] })).toBe(false);
    expect(triggerFromUser({ messages: [otherBot] })).toBe(false);
    expect(triggerFromUser({ messages: [widget] })).toBe(false);
    expect(triggerFromUser({ messages: [delegated] })).toBe(false);
    expect(triggerFromUser({ messages: [mailAlert] })).toBe(false);
    expect(triggerFromUser({ messages: [] })).toBe(false);
    // A merged batch with a non-direct part (e.g. a watch alert) is not the user's.
    expect(triggerFromUser({ messages: [user], partReasons: ['direct', 'watch'] })).toBe(false);
    expect(triggerFromUser({ messages: [user], partReasons: ['direct', 'mention'] })).toBe(true);
  });

  it('classifies untrusted-content reads', () => {
    for (const name of [
      'web_fetch',
      'web_search',
      'mail_read',
      'mail_search',
      'browser_snapshot',
      'browser_screenshot',
      'browser_open',
      'mcp_srv_lookup',
      'app_github_list_repos',
      'app_call_tool',
      'get_attachment',
    ]) {
      expect(isUntrustedReadTool(name), name).toBe(true);
    }
    for (const name of ['send_message', 'settings_read', 'app_request_connection', 'remember']) {
      expect(isUntrustedReadTool(name), name).toBe(false);
    }
    // Workspace files, history, memory, wiki and task results may carry foreign content.
    for (const name of [
      'read',
      'grep',
      'search_messages',
      'recall_memory',
      'wiki_read',
      'list_tasks',
      'get_run',
    ]) {
      expect(isUntrustedReadTool(name), name).toBe(true);
    }
    // Unknown / new tools default to untrusted.
    expect(isUntrustedReadTool('some_future_tool')).toBe(true);
  });

  it('every built-in tool is explicitly classified trusted or untrusted (new tools force a decision)', () => {
    const unclassified = CLASSIFIED_BUILTIN_TOOLS.filter(
      (name) => !TRUSTED_TOOLS.has(name) && !UNTRUSTED_TOOLS.has(name),
    );
    expect(unclassified).toEqual([]);
    expect([...TRUSTED_TOOLS].filter((name) => UNTRUSTED_TOOLS.has(name))).toEqual([]);
    // No stale names either.
    expect(
      [...TRUSTED_TOOLS, ...UNTRUSTED_TOOLS].filter(
        (name) => !CLASSIFIED_BUILTIN_TOOLS.includes(name),
      ),
    ).toEqual([]);
  });

  it('a trigger with attachments starts untrusted; task results / other bots are not the user', () => {
    expect(triggerCarriesUntrusted([{ ...user, attachments: [] } as Message])).toBe(false);
    expect(
      triggerCarriesUntrusted([{ ...user, attachments: [{ id: 'att_1' }] } as unknown as Message]),
    ).toBe(true);
    const taskResult = {
      senderType: 'bot',
      kind: 'text',
      content: { text: 'done', origin: 'task', taskId: 't_1' },
    } as unknown as Message;
    const taskEvent = {
      senderType: 'bot',
      kind: 'task_event',
      content: { phase: 'result' },
    } as unknown as Message;
    expect(triggerFromUser({ messages: [taskResult] })).toBe(false);
    expect(triggerFromUser({ messages: [taskEvent] })).toBe(false);
    expect(triggerFromUser({ messages: [user, taskEvent] })).toBe(false);
  });
});

describe('settings catalog host: reads', () => {
  it('settings_read never returns secrets and reports sensitive fields as configured / not', async () => {
    const rig = makeRig();
    rig.settings.update({
      capabilityModels: {
        ...rig.settings.get().capabilityModels,
        image: { vendor: 'dashscope', model: 'qwen-image' },
      },
    });
    rig.secrets.set('provider:dashscope', SECRET);
    const facade = rig.host.forRun(runCtx(rig));
    const read = facade.read('capability.image', undefined);
    expect(read.ok).toBe(true);
    expect(read.content).toContain('apiKey');
    expect(read.content).toContain('已配置');
    expect(read.content).toContain('qwen-image');
    expect(read.content).not.toContain(SECRET);
    expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(4096);

    const models = facade.read('models.default-main', undefined);
    expect(models.content).toContain('custom:mock/mock-alt');
    expect(models.content).toContain('本次修改方式：可直接修改');
    expect(models.content).not.toContain(SECRET);

    // A renderer item: core cannot see it.
    expect(facade.read('general.theme', undefined).content).toContain('状态未知');
    // A via-tool item: names the tool.
    expect(facade.read('mail.account', undefined).content).toContain('mail_request_setup');
    // Unknown id → candidates.
    const unknown = facade.read('models.default-mian', undefined);
    expect(unknown.ok).toBe(false);
    expect(unknown.content).toContain('models.default-main');
  });

  it('settings_search: overview per group and a query hit with state + loosest mode, within 2KB', async () => {
    const rig = makeRig();
    const facade = rig.host.forRun(runCtx(rig));
    const overview = facade.search(undefined);
    expect(overview).toContain('- 模型：');
    expect(Buffer.byteLength(overview)).toBeLessThanOrEqual(2048);
    const hits = facade.search('我想让你帮我生成图片');
    expect(hits).toContain('capability.image');
    expect(hits).toMatch(/capability\.image｜图像生成模型｜[^\n]*｜未配置｜本次：出待填卡/);
    expect(Buffer.byteLength(hits)).toBeLessThanOrEqual(2048);
  });
});

describe('settings catalog host: settings_change and cards', () => {
  it('direct (whitelisted item, the user asked): writes, posts a receipt card, undo restores via CAS', async () => {
    const rig = makeRig();
    const facade = rig.host.forRun(runCtx(rig));
    const result = await facade.change({
      id: 'models.default-main',
      values: { model: 'custom:mock/mock-alt' },
      reason: '用户想换个模型',
    });
    expect(result.ok).toBe(true);
    expect(rig.settings.get().defaultMainModel).toBe('custom:mock/mock-alt');
    const [receipt] = cards(rig);
    const card = cardOf(rig, receipt!.id);
    expect(card).toMatchObject({
      mode: 'direct',
      state: 'applied',
      before: { model: 'custom:mock/mock-main' },
      applied: { model: 'custom:mock/mock-alt' },
    });
    expect(card.undoUntil).toBe(rig.clock.now() + SETTING_RECEIPT_UNDO_WINDOW_MS);
    expect(rig.published.some((entry) => entry.event === 'settings.changed')).toBe(true);

    // A sibling field edited elsewhere meanwhile is not clobbered by the undo.
    rig.settings.update({ defaultLightModel: 'custom:mock/mock-main' });
    const undone = await rig.host.undoCard(receipt!.id);
    expect(undone.status).toBe('reverted');
    expect(rig.settings.get().defaultMainModel).toBe('custom:mock/mock-main');
    expect(rig.settings.get().defaultLightModel).toBe('custom:mock/mock-main');
    expect(cardOf(rig, receipt!.id).state).toBe('reverted');
    // Undo never wakes the bot; it leaves a context line.
    expect(rig.wakes).toHaveLength(0);
    expect(
      renderSettingCardLine(rig.messages.getById(receipt!.id)!, {
        selfBotId: 'bot_a',
        botNames: new Map(),
      }),
    ).toContain('用户撤销了你对「默认主模型」的修改');
  });

  it('undo reports a conflict instead of overwriting when the value changed since', async () => {
    const rig = makeRig();
    const facade = rig.host.forRun(runCtx(rig));
    const result = await facade.change({
      id: 'models.default-main',
      values: { model: 'custom:mock/mock-alt' },
      reason: '换模型',
    });
    const receiptId = messageIdIn(result.content);
    // Changed again elsewhere (settings page) since the receipt.
    rig.settings.update({ defaultMainModel: 'custom:mock/mock-x' });
    const undone = await rig.host.undoCard(receiptId);
    expect(undone).toEqual({ status: 'conflict', current: { model: 'custom:mock/mock-x' } });
    expect(rig.settings.get().defaultMainModel).toBe('custom:mock/mock-x');
    expect(cardOf(rig, receiptId).state).toBe('applied');
    // Past the undo window: refused.
    rig.settings.update({ defaultMainModel: 'custom:mock/mock-alt' });
    rig.clock.advance(SETTING_RECEIPT_UNDO_WINDOW_MS + 1);
    await expect(rig.host.undoCard(receiptId)).rejects.toThrow('撤销已过期');
  });

  it('item-level CAS on capability models: applying one capability keeps a concurrent sibling edit', async () => {
    const rig = makeRig();
    rig.secrets.set('provider:dashscope', SECRET);
    rig.settings.update({
      capabilityModels: {
        ...rig.settings.get().capabilityModels,
        image: { vendor: 'dashscope', model: 'qwen-image' },
      },
    });
    const facade = rig.host.forRun(runCtx(rig));
    const result = await facade.change({
      id: 'capability.image',
      values: { model: 'dashscope/qwen-image-plus' },
      reason: '换个更好的图像模型',
    });
    expect(result.ok).toBe(true);
    const cardId = messageIdIn(result.content);
    const card = cardOf(rig, cardId);
    expect(card).toMatchObject({ mode: 'confirm', state: 'pending' });
    // Meanwhile the settings page changes the tts capability (whole-object save).
    rig.settings.update({
      capabilityModels: {
        ...rig.settings.get().capabilityModels,
        tts: { vendor: 'dashscope', model: 'cosyvoice-v2' },
      },
    });
    const applied = await rig.host.applyItem({
      itemId: 'capability.image',
      values: card.proposed!,
      expected: card.before,
      messageId: cardId,
    });
    expect(applied.status).toBe('applied');
    const models = rig.settings.get().capabilityModels;
    expect(models.image).toEqual({ vendor: 'dashscope', model: 'qwen-image-plus' });
    expect(models.tts).toEqual({ vendor: 'dashscope', model: 'cosyvoice-v2' });
    expect(cardOf(rig, cardId).state).toBe('applied');
    expect(rig.wakes).toHaveLength(1);
    expect(rig.wakes[0]!.text).toContain('用户已应用「图像生成模型」');
    // A stale card (expected no longer matches) reports a conflict and does not write.
    const second = await facade.change({
      id: 'capability.image',
      values: { model: 'dashscope/qwen-image' },
      reason: '换回去',
    });
    const secondId = messageIdIn(second.content);
    rig.settings.update({
      capabilityModels: {
        ...rig.settings.get().capabilityModels,
        image: { vendor: 'dashscope', model: 'qwen-image-edit' },
      },
    });
    const conflict = await rig.host.applyItem({
      itemId: 'capability.image',
      values: cardOf(rig, secondId).proposed!,
      expected: cardOf(rig, secondId).before,
      messageId: secondId,
    });
    expect(conflict).toMatchObject({
      status: 'conflict',
      current: { model: 'dashscope/qwen-image-edit' },
    });
    expect(rig.settings.get().capabilityModels.image?.model).toBe('qwen-image-edit');
    expect(cardOf(rig, secondId).state).toBe('pending');
  });

  it('a card applied with a key stores it in secrets and never echoes it', async () => {
    const rig = makeRig();
    const facade = rig.host.forRun(runCtx(rig));
    const result = await facade.change({ id: 'capability.image', reason: '用户想生成图片' });
    const cardId = messageIdIn(result.content);
    expect(cardOf(rig, cardId)).toMatchObject({ mode: 'form', proposed: null, state: 'pending' });
    const applied = await rig.host.applyItem({
      itemId: 'capability.image',
      values: { provider: 'dashscope', model: 'dashscope/qwen-image', apiKey: SECRET },
      expected: cardOf(rig, cardId).before,
      messageId: cardId,
    });
    expect(applied.status).toBe('applied');
    expect(JSON.stringify(applied)).not.toContain(SECRET);
    expect(rig.secrets.get('provider:dashscope')).toBe(SECRET);
    expect(JSON.stringify(rig.messages.getById(cardId))).not.toContain(SECRET);
    expect(JSON.stringify(rig.wakes)).not.toContain(SECRET);
  });

  it('rejects sensitive values and redirects via-tool items', async () => {
    const rig = makeRig();
    const facade = rig.host.forRun(runCtx(rig));
    const secret = await facade.change({
      id: 'capability.image',
      values: { provider: 'dashscope', apiKey: 'sk-from-chat' },
      reason: '用户给了 key',
    });
    expect(secret.ok).toBe(false);
    expect(secret.content).toContain('不能带敏感字段');
    const via = await facade.change({ id: 'mail.account', reason: '接管邮箱' });
    expect(via.ok).toBe(false);
    expect(via.content).toContain('mail_request_setup');
    expect(cards(rig)).toHaveLength(0);
  });

  it('tightens to a confirm card: other-bot mention, mail wake, untrusted reads, taint, group chat', async () => {
    const cases: Array<[string, (rig: Rig) => SettingsRunContext]> = [
      [
        'other bot mention',
        (rig) => runCtx(rig, { triggerReason: 'mention', triggerFromUser: false }),
      ],
      ['mail wake', (rig) => runCtx(rig, { triggerReason: 'mail', triggerFromUser: false })],
      ['widget origin', (rig) => runCtx(rig, { triggerReason: 'direct', triggerFromUser: false })],
      ['web_fetch first', (rig) => runCtx(rig, { untrusted: true })],
      [
        'tainted',
        (rig) => {
          rig.tainted.add(`bot_a:${rig.conversationId}`);
          return runCtx(rig);
        },
      ],
      ['group chat', (rig) => runCtx(rig, { conversationId: rig.groupId })],
    ];
    for (const [label, make] of cases) {
      const rig = makeRig();
      const ctx = make(rig);
      const result = await rig.host.forRun(ctx).change({
        id: 'models.default-main',
        values: { model: 'custom:mock/mock-alt' },
        reason: '换模型',
      });
      expect(result.ok, label).toBe(true);
      expect(rig.settings.get().defaultMainModel, label).toBe('custom:mock/mock-main');
      const [card] = cards(rig, ctx.identity.conversationId!);
      expect(cardOf(rig, card!.id), label).toMatchObject({
        mode: 'confirm',
        state: 'pending',
        proposed: { model: 'custom:mock/mock-alt' },
      });
    }
  });

  it('another bot: refused for a normal bot, a confirm card for the butler', async () => {
    const rig = makeRig();
    const refused = await rig.host.forRun(runCtx(rig)).change({
      id: 'bot.model',
      values: { model: 'custom:mock/mock-alt' },
      reason: '帮 B 换模型',
      botId: 'bot_b',
    });
    expect(refused.ok).toBe(false);
    const butler = await rig.host.forRun(runCtx(rig, { isButler: true })).change({
      id: 'bot.model',
      values: { model: 'custom:mock/mock-alt' },
      reason: '帮 B 换模型',
      botId: 'bot_b',
    });
    expect(butler.ok).toBe(true);
    const [card] = cards(rig);
    expect(cardOf(rig, card!.id)).toMatchObject({ mode: 'confirm', target: { botId: 'bot_b' } });
    expect(rig.bots.get('bot_b')!.profile.runtime.model).toBe('');
    // The card applies to bot_b only.
    await rig.host.applyItem({
      itemId: 'bot.model',
      values: { model: 'custom:mock/mock-alt' },
      expected: cardOf(rig, card!.id).before,
      messageId: card!.id,
    });
    expect(rig.bots.get('bot_b')!.profile.runtime.model).toBe('custom:mock/mock-alt');
    expect(rig.bots.get('bot_a')!.profile.runtime.model).toBe('');
  });

  it('tool policy: tightening keeps the prefill; widening drops it but before still names the tool', async () => {
    const tools = new Map<string, { enabled: boolean; approval: 'auto' | 'ask' }>([
      ['search', { enabled: true, approval: 'auto' }],
    ]);
    const appConnections: AdapterDeps['appConnections'] = {
      list: () => [{ id: 'conn-1', label: 'Notion' }],
      peekTool: (connectionId, toolName) => {
        if (connectionId !== 'conn-1') return null;
        const tool = tools.get(toolName);
        return tool === undefined ? null : { policy: null, ...tool };
      },
    };
    const rig = makeRig({ appConnections });
    const tighten = await rig.host.forRun(runCtx(rig)).change({
      id: 'connections.tool-policy',
      values: { connection: 'conn-1', tool: 'search', policy: 'deny' },
      reason: '先停掉搜索',
    });
    expect(tighten.ok).toBe(true);
    const [tightCard] = cards(rig);
    expect(cardOf(rig, tightCard!.id)).toMatchObject({
      mode: 'confirm',
      proposed: { connection: 'conn-1', tool: 'search', policy: 'deny' },
      before: { connection: 'conn-1', tool: 'search', policy: 'allow' },
    });
    await expect(
      rig.host.applyItem({
        itemId: 'connections.tool-policy',
        values: { connection: 'conn-1', tool: 'search', policy: 'deny' },
        expected: cardOf(rig, tightCard!.id).before,
        messageId: tightCard!.id,
      }),
    ).rejects.toThrow(/暂不支持在对话里保存/);

    tools.set('search', { enabled: false, approval: 'ask' });
    const widen = await rig.host.forRun(runCtx(rig)).change({
      id: 'connections.tool-policy',
      values: { connection: 'conn-1', tool: 'search', policy: 'ask' },
      reason: '重新启用',
    });
    expect(widen.ok).toBe(true);
    expect(widen.content).toContain('没有采用');
    const blank = cards(rig)
      .map((message) => cardOf(rig, message.id))
      .find((card) => card.state === 'pending');
    expect(blank).toMatchObject({
      mode: 'user-only',
      proposed: null,
      before: { connection: 'conn-1', tool: 'search', policy: 'deny' },
    });
  });

  it('mcp servers: disabling keeps the prefill; enabling drops it but before still names the server', async () => {
    const rig = makeRig();
    rig.settings.update({
      mcpServers: [
        {
          id: 'notes',
          name: 'Notes',
          transport: 'stdio',
          command: 'echo',
          enabled: true,
          autoApprove: false,
          auth: 'none',
          toolPolicies: { search: { approval: 'ask' } },
        },
        {
          id: 'off',
          name: 'Off',
          transport: 'stdio',
          command: 'echo',
          enabled: false,
          autoApprove: false,
          auth: 'none',
        },
      ],
    });
    const tighten = await rig.host.forRun(runCtx(rig)).change({
      id: 'mcp.servers',
      values: { server: 'notes', enabled: false },
      reason: '先停掉这个服务',
    });
    expect(tighten.ok).toBe(true);
    const [tightCard] = cards(rig);
    expect(cardOf(rig, tightCard!.id)).toMatchObject({
      mode: 'confirm',
      proposed: { server: 'notes', enabled: false },
      before: { server: 'notes', enabled: true },
    });
    await expect(
      rig.host.applyItem({
        itemId: 'mcp.servers',
        values: { server: 'notes', enabled: false },
        expected: cardOf(rig, tightCard!.id).before,
        messageId: tightCard!.id,
      }),
    ).rejects.toThrow(/暂不支持在对话里保存/);
    expect(rig.settings.get().mcpServers.find((server) => server.id === 'notes')).toMatchObject({
      enabled: true,
      toolPolicies: { search: { approval: 'ask' } },
    });

    const widen = await rig.host.forRun(runCtx(rig)).change({
      id: 'mcp.servers',
      values: { server: 'off', enabled: true },
      reason: '重新启用',
    });
    expect(widen.ok).toBe(true);
    expect(widen.content).toContain('没有采用');
    const blank = cards(rig)
      .map((message) => cardOf(rig, message.id))
      .find((card) => card.state === 'pending');
    expect(blank).toMatchObject({
      mode: 'user-only',
      proposed: null,
      before: { server: 'off', enabled: false },
    });
  });

  it('shared browser profiles: a new name is a confirm card; the same name is already done; the host does not write', async () => {
    const rig = makeRig();
    rig.settings.update({
      browserProfiles: [{ id: 'bpf_work', name: '工作', createdAt: 1 }],
    });
    const same = await rig.host.forRun(runCtx(rig)).change({
      id: 'browser.shared-profiles',
      values: { name: '工作' },
      reason: '再建一个同名的',
    });
    expect(same.ok).toBe(true);
    expect(same.content).toContain('已经是这个值');
    expect(cards(rig)).toHaveLength(0);

    const created = await rig.host.forRun(runCtx(rig)).change({
      id: 'browser.shared-profiles',
      values: { name: '私人' },
      reason: '新建一份共享资料',
    });
    expect(created.ok).toBe(true);
    const id = messageIdIn(created.content);
    expect(cardOf(rig, id)).toMatchObject({
      mode: 'confirm',
      proposed: { name: '私人' },
      before: { name: '' },
    });
    expect(JSON.stringify(cardOf(rig, id))).not.toContain('bpf_');
    await expect(
      rig.host.applyItem({
        itemId: 'browser.shared-profiles',
        values: { name: '私人' },
        expected: { name: '' },
        messageId: id,
      }),
    ).rejects.toThrow(/暂不支持在对话里保存/);
    expect(rig.settings.get().browserProfiles).toEqual([
      { id: 'bpf_work', name: '工作', createdAt: 1 },
    ]);
    expect(rig.host.completeCard(id)).toEqual({ state: 'pending', verified: false });
    rig.settings.update({
      browserProfiles: [
        { id: 'bpf_work', name: '工作', createdAt: 1 },
        { id: 'bpf_new', name: '私人', createdAt: 2 },
      ],
    });
    expect(rig.host.completeCard(id)).toEqual({ state: 'applied', verified: true });
    expect(cardOf(rig, id).applied).toEqual({ name: '私人' });
    expect(JSON.stringify(cardOf(rig, id).applied)).not.toContain('bpf_');
  });

  it('toolchains: a blank user-only card; complete passes only when nothing failed or is missing', async () => {
    const installs = [
      { id: 'env_row_py', status: 'installed' },
      { id: 'env_row_node', status: 'failed' },
    ];
    const system = [{ available: false }];
    const rig = makeRig({
      environment: {
        listInstalls: () => installs,
        systemStatuses: () => system,
      },
    });
    const rejected = await rig.host.forRun(runCtx(rig)).change({
      id: 'environment.toolchains',
      values: { item: 'python' },
      reason: '装一下 Python',
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.content).toContain('没有字段');
    expect(cards(rig)).toHaveLength(0);
    const result = await rig.host.forRun(runCtx(rig)).change({
      id: 'environment.toolchains',
      reason: '看一下工具链',
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('空白卡');
    const id = messageIdIn(result.content);
    const card = cardOf(rig, id);
    expect(card).toMatchObject({ mode: 'user-only', proposed: null, state: 'pending', before: null });
    expect(JSON.stringify(card)).not.toContain('env_row_');
    expect(JSON.stringify(card)).not.toContain('python');
    const read = rig.host.forRun(runCtx(rig)).read('environment.toolchains', undefined);
    expect(read.content).toContain('已安装 1 项，失败或缺失 2 项');
    expect(read.content).toContain('你给的 values 不会被采用');
    expect(read.content).not.toContain('env_row_');
    expect(rig.host.completeCard(id)).toEqual({ state: 'pending', verified: false });
    await expect(
      rig.host.applyItem({
        itemId: 'environment.toolchains',
        values: {},
        expected: null,
        messageId: id,
      }),
    ).rejects.toThrow(/暂不支持在对话里保存/);
    expect(cardOf(rig, id).state).toBe('pending');
    installs.splice(1, 1);
    system[0] = { available: true };
    expect(rig.host.completeCard(id)).toEqual({ state: 'applied', verified: true });
    expect(cardOf(rig, id).applied).toBeUndefined();
    expect(JSON.stringify(cardOf(rig, id))).not.toContain('env_row_');
  });

  it('sandbox: a blank user-only card; complete passes only after the last probe says available', async () => {
    const leaked = {
      available: false,
      fixHint: 'sudo apt install bubblewrap socat',
      reason: '/Users/someone/.local/share/kepcup',
    };
    let last: { available: boolean } | null = null;
    const rig = makeRig({
      sandbox: { lastAvailability: () => last },
    });
    const rejected = await rig.host.forRun(runCtx(rig)).change({
      id: 'environment.sandbox',
      values: { enabled: true },
      reason: '打开沙箱',
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.content).toContain('没有字段');
    expect(cards(rig)).toHaveLength(0);

    const result = await rig.host.forRun(runCtx(rig)).change({
      id: 'environment.sandbox',
      reason: '准备沙箱',
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('空白卡');
    const id = messageIdIn(result.content);
    expect(cardOf(rig, id)).toMatchObject({
      mode: 'user-only',
      proposed: null,
      state: 'pending',
      before: null,
    });
    const unread = rig.host.forRun(runCtx(rig)).read('environment.sandbox', undefined);
    expect(unread.content).toContain('还没检测过沙箱');
    expect(unread.content).toContain('你给的 values 不会被采用');
    expect(unread.content).not.toContain('sudo');
    expect(rig.host.completeCard(id)).toEqual({ state: 'applied', verified: null });

    const again = await rig.host.forRun(runCtx(rig)).change({
      id: 'environment.sandbox',
      reason: '再看一次沙箱',
    });
    const pendingId = messageIdIn(again.content);
    last = leaked;
    const unavailable = rig.host.forRun(runCtx(rig)).read('environment.sandbox', undefined);
    expect(unavailable.content).toContain('沙箱不可用');
    expect(unavailable.content).not.toContain('sudo');
    expect(unavailable.content).not.toContain('/Users/');
    expect(rig.host.completeCard(pendingId)).toEqual({ state: 'pending', verified: false });
    await expect(
      rig.host.applyItem({
        itemId: 'environment.sandbox',
        values: {},
        expected: null,
        messageId: pendingId,
      }),
    ).rejects.toThrow(/暂不支持在对话里保存/);
    expect(cardOf(rig, pendingId).state).toBe('pending');
    last = { available: true };
    expect(rig.host.completeCard(pendingId)).toEqual({ state: 'applied', verified: true });
    expect(cardOf(rig, pendingId).applied).toBeUndefined();
    expect(JSON.stringify(cardOf(rig, pendingId))).not.toContain('sudo');
  });

  it('user-only: a blank card, the bot values are not used', async () => {
    const rig = makeRig();
    const result = await rig.host.forRun(runCtx(rig)).change({
      id: 'unattended.enable',
      values: { until: '18:00' },
      reason: '用户要离开一下午',
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('没有采用');
    const [card] = cards(rig);
    // No embedded component yet → the user-only item falls back to a link card; values ignored either way.
    expect(cardOf(rig, card!.id)).toMatchObject({ proposed: null, state: 'pending' });
    expect(['user-only', 'link']).toContain(cardOf(rig, card!.id).mode);
  });

  it('caps cards per run, supersedes the older pending card of the same item, and backs off after declines', async () => {
    const rig = makeRig();
    const ctx = runCtx(rig, { triggerReason: 'mail', triggerFromUser: false });
    const facade = rig.host.forRun(ctx);
    const first = await facade.change({
      id: 'models.default-main',
      values: { model: 'custom:mock/mock-alt' },
      reason: 'a',
    });
    const second = await facade.change({
      id: 'models.default-main',
      values: { model: 'custom:mock/mock-x' },
      reason: 'b',
    });
    expect(cardOf(rig, messageIdIn(first.content)).state).toBe('superseded');
    expect(cardOf(rig, messageIdIn(second.content)).state).toBe('pending');
    await facade.change({
      id: 'models.default-light',
      values: { model: 'custom:mock/mock-x' },
      reason: 'c',
    });
    expect(cards(rig)).toHaveLength(SETTING_CARDS_PER_RUN_MAX);
    const over = await facade.change({ id: 'capability.image', reason: 'd' });
    expect(over.ok).toBe(false);
    expect(over.content).toContain(`${SETTING_CARDS_PER_RUN_MAX} 张`);

    // Decline back-off: per bot + conversation + item.
    rig.host.dismissCard(messageIdIn(second.content));
    expect(rig.wakes.at(-1)!.text).toContain('用户没有修改「默认主模型」');
    const again = await rig.host
      .forRun(runCtx(rig, { triggerReason: 'mail', triggerFromUser: false }))
      .change({
        id: 'models.default-main',
        values: { model: 'custom:mock/mock-alt' },
        reason: 'e',
      });
    rig.host.dismissCard(messageIdIn(again.content));
    const refused = await rig.host
      .forRun(runCtx(rig, { triggerReason: 'mail', triggerFromUser: false }))
      .change({
        id: 'models.default-main',
        values: { model: 'custom:mock/mock-alt' },
        reason: 'f',
      });
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('拒绝 2 次');
    // Another item is not affected; the window ends after 7 days.
    const other = await rig.host
      .forRun(runCtx(rig, { triggerReason: 'mail', triggerFromUser: false }))
      .change({
        id: 'models.default-light',
        values: { model: 'custom:mock/mock-x' },
        reason: 'g',
      });
    expect(other.ok).toBe(true);
    rig.clock.advance(SETTING_CARD_DECLINE_WINDOW_MS + 1);
    const later = await rig.host
      .forRun(runCtx(rig, { triggerReason: 'mail', triggerFromUser: false }))
      .change({
        id: 'models.default-main',
        values: { model: 'custom:mock/mock-alt' },
        reason: 'h',
      });
    expect(later.ok).toBe(true);
  });

  it('dismiss wakes once; stale pending cards expire', async () => {
    const rig = makeRig();
    const result = await rig.host
      .forRun(runCtx(rig))
      .change({ id: 'capability.image', reason: '生成图片' });
    const id = messageIdIn(result.content);
    expect(rig.host.dismissCard(id)).toEqual({ state: 'dismissed' });
    expect(rig.host.dismissCard(id)).toEqual({ state: 'dismissed' });
    expect(rig.wakes).toHaveLength(1);
    expect(rig.wakes[0]!.resolved).toMatchObject({
      cardMessageId: id,
      outcome: 'dismissed',
      itemId: 'capability.image',
    });

    const stale = await rig.host
      .forRun(runCtx(rig))
      .change({ id: 'capability.video', reason: '生成视频' });
    rig.clock.advance(SETTING_CARD_DECLINE_WINDOW_MS + 1);
    expect(rig.host.dismissCard(messageIdIn(stale.content))).toEqual({ state: 'expired' });
    expect(rig.wakes).toHaveLength(1);
  });

  it('complete re-verifies through the adapter', async () => {
    const rig = makeRig();
    const result = await rig.host
      .forRun(runCtx(rig))
      .change({ id: 'capability.image', reason: '生成图片' });
    const id = messageIdIn(result.content);
    expect(rig.host.completeCard(id)).toEqual({ state: 'pending', verified: false });
    rig.secrets.set('provider:dashscope', SECRET);
    rig.settings.update({
      capabilityModels: {
        ...rig.settings.get().capabilityModels,
        image: { vendor: 'dashscope', model: 'qwen-image' },
      },
    });
    expect(rig.host.completeCard(id)).toEqual({ state: 'applied', verified: true });
    expect(rig.wakes).toHaveLength(1);
    // A renderer item cannot be verified: marked applied as the user says.
    const theme = await rig.host
      .forRun(runCtx(rig))
      .change({ id: 'general.theme', values: { theme: 'dark' }, reason: '暗色' });
    expect(rig.host.completeCard(messageIdIn(theme.content))).toEqual({
      state: 'applied',
      verified: null,
    });
  });

  it('task + required: SETUP_REQUIRED with a generic setting requirement, no card; configured → continue', async () => {
    const rig = makeRig();
    const ctx = runCtx(rig, { loopType: 'task' });
    const facade = rig.host.forRun(ctx);
    const result = await facade.change({
      id: 'capability.image',
      reason: '生成图片需要图像模型',
      required: true,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'SETUP_REQUIRED' });
    expect(ctx.setup).toEqual([
      { kind: 'setting', itemId: 'capability.image', reason: '生成图片需要图像模型' },
    ]);
    expect(cards(rig)).toHaveLength(0);
    // Not required: a non-blocking card, the task goes on.
    const soft = await facade.change({ id: 'capability.image', reason: '顺便配一下' });
    expect(soft.ok).toBe(true);
    expect(soft.content).toContain('不阻塞本任务');
    // Once configured (the user applied the setup card), the retried call just continues.
    await rig.host.applyItem({
      itemId: 'capability.image',
      values: { provider: 'dashscope', model: 'dashscope/qwen-image', apiKey: SECRET },
      expected: null,
    });
    const retried = await rig.host.forRun(runCtx(rig, { loopType: 'task' })).change({
      id: 'capability.image',
      reason: '生成图片需要图像模型',
      required: true,
    });
    expect(retried.ok).toBe(true);
    expect(retried.content).toContain('已经配置好了');
  });

  it('the tools wrap the facade with literal names', () => {
    const rig = makeRig();
    const tools = buildSettingsTools({ settings: rig.host.forRun(runCtx(rig)) });
    expect(tools.map((tool) => tool.name)).toEqual([
      'settings_search',
      'settings_read',
      'settings_change',
    ]);
    const descriptions = tools.map((tool) => tool.description).join('');
    // Usage only (no catalog listing), ~600 chars in total.
    expect(descriptions.length).toBeLessThanOrEqual(650);
    expect(descriptions).not.toContain('models.default-main');
  });
});

describe('settings catalog host: review fixes', () => {
  it('#1 an external-agent (ACP) run is always untrusted: a direct item becomes a confirm card', async () => {
    const rig = makeRig();
    const result = await rig.host
      .forRun(runCtx(rig, { triggerReason: 'direct', triggerFromUser: true, externalEngine: true }))
      .change(CHANGE_MAIN_ALT);
    expect(result.ok).toBe(true);
    expect(rig.settings.get().defaultMainModel).toBe('custom:mock/mock-main');
    const card = cardOf(rig, messageIdIn(result.content));
    expect(card).toMatchObject({ mode: 'confirm', state: 'pending' });
    expect(card.modeReason).toContain('读过网页');
  });

  it('#3 complete settles a card the user saved with a different value, recording the actual value', async () => {
    const rig = makeRig();
    const ctx = runCtx(rig, { triggerReason: 'mail', triggerFromUser: false });
    const result = await rig.host.forRun(ctx).change(CHANGE_MAIN_ALT);
    const id = messageIdIn(result.content);
    // The user edited the confirm card to another model and the embedded component saved it.
    rig.settings.update({ defaultMainModel: 'custom:mock/mock-x' });
    expect(rig.host.completeCard(id)).toEqual({ state: 'applied', verified: true });
    expect(cardOf(rig, id).applied).toEqual({ model: 'custom:mock/mock-x' });
    expect(rig.wakes).toHaveLength(1);
    expect(rig.wakes[0]!.resolved.after).toEqual({ model: 'custom:mock/mock-x' });
    // Settled once: a second complete does not wake again.
    expect(rig.host.completeCard(id)).toEqual({ state: 'applied', verified: null });
    expect(rig.wakes).toHaveLength(1);
  });

  it('#4 a dismiss racing an apply wins cleanly: nothing is written, one wake', async () => {
    const rig = makeRig();
    const ctx = runCtx(rig, { triggerReason: 'mail', triggerFromUser: false });
    const id = messageIdIn((await rig.host.forRun(ctx).change(CHANGE_MAIN_ALT)).content);
    const card = cardOf(rig, id);
    const applying = rig.host.applyItem({
      itemId: 'models.default-main',
      values: card.proposed!,
      expected: card.before,
      messageId: id,
    });
    // The dismiss lands while the apply waits for the write lock.
    expect(rig.host.dismissCard(id)).toEqual({ state: 'dismissed' });
    await expect(applying).rejects.toThrow('已经处理过了');
    expect(rig.settings.get().defaultMainModel).toBe('custom:mock/mock-main');
    expect(cardOf(rig, id).state).toBe('dismissed');
    expect(rig.wakes.map((wake) => wake.resolved.outcome)).toEqual(['dismissed']);

    // The other order: apply settles the card first; the later dismiss sees applied.
    const second = messageIdIn(
      (
        await rig.host
          .forRun(runCtx(rig, { triggerReason: 'mail', triggerFromUser: false }))
          .change(CHANGE_MAIN_ALT)
      ).content,
    );
    const applied = rig.host.applyItem({
      itemId: 'models.default-main',
      values: cardOf(rig, second).proposed!,
      expected: cardOf(rig, second).before,
      messageId: second,
    });
    await applied;
    expect(rig.host.dismissCard(second)).toEqual({ state: 'applied' });
    expect(rig.wakes.map((wake) => wake.resolved.outcome)).toEqual(['dismissed', 'applied']);
  });

  it('#5 with a messageId the target must match the card', async () => {
    const rig = makeRig();
    const result = await rig.host
      .forRun(runCtx(rig, { isButler: true }))
      .change({
        id: 'bot.model',
        values: { model: 'custom:mock/mock-alt' },
        reason: '换',
        botId: 'bot_b',
      });
    const id = messageIdIn(result.content);
    await expect(
      rig.host.applyItem({
        itemId: 'bot.model',
        values: { model: 'custom:mock/mock-alt' },
        expected: null,
        target: { botId: 'bot_a' },
        messageId: id,
      }),
    ).rejects.toThrow('作用对象与设置卡不一致');
    expect(rig.bots.get('bot_a')!.profile.runtime.model).toBe('');
    // Matching (or omitted) target: the card's target is used.
    await rig.host.applyItem({
      itemId: 'bot.model',
      values: { model: 'custom:mock/mock-alt' },
      expected: null,
      target: { botId: 'bot_b' },
      messageId: id,
    });
    expect(rig.bots.get('bot_b')!.profile.runtime.model).toBe('custom:mock/mock-alt');
  });

  it('#6 the per-run card cap holds under parallel tool calls', async () => {
    const rig = makeRig();
    const facade = rig.host.forRun(runCtx(rig));
    const results = await Promise.all([
      facade.change({
        id: 'models.default-main',
        values: { model: 'custom:mock/mock-x' },
        reason: 'a',
      }),
      facade.change({
        id: 'models.default-light',
        values: { model: 'custom:mock/mock-x' },
        reason: 'b',
      }),
      facade.change({ id: 'bot.model', values: { model: 'custom:mock/mock-x' }, reason: 'c' }),
      facade.change({
        id: 'bot.light-model',
        values: { model: 'custom:mock/mock-x' },
        reason: 'd',
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(SETTING_CARDS_PER_RUN_MAX);
    expect(results.filter((result) => result.errorCode === 'LIMIT_REACHED')).toHaveLength(1);
    expect(cards(rig)).toHaveLength(SETTING_CARDS_PER_RUN_MAX);
  });

  it('#7 task required still honors the per-item decline back-off', async () => {
    const rig = makeRig();
    for (const reason of ['a', 'b']) {
      const result = await rig.host.forRun(runCtx(rig)).change({ id: 'capability.image', reason });
      rig.host.dismissCard(messageIdIn(result.content));
    }
    const ctx = runCtx(rig, { loopType: 'task' });
    const result = await rig.host
      .forRun(ctx)
      .change({ id: 'capability.image', reason: 'c', required: true });
    expect(result).toMatchObject({ ok: false, errorCode: 'LIMIT_REACHED' });
    expect(result.content).toContain('也不能为它暂停任务');
    expect(ctx.setup).toEqual([]);
  });

  it('#8 settings_read of another bot: refused for a normal bot, allowed for the butler', () => {
    const rig = makeRig();
    const refused = rig.host.forRun(runCtx(rig)).read('bot.model', 'bot_b');
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('只能查看你自己的配置');
    const butler = rig.host.forRun(runCtx(rig, { isButler: true })).read('bot.model', 'bot_b');
    expect(butler.ok).toBe(true);
    expect(butler.content).toContain('出确认卡');
    expect(rig.host.forRun(runCtx(rig, { isButler: true })).read('bot.model', 'bot_zz').ok).toBe(
      false,
    );
    // Global items ignore bot_id.
    expect(rig.host.forRun(runCtx(rig)).read('models.default-main', 'bot_b').ok).toBe(true);
  });

  it('#10 agents.external: CAS per agent, a concurrent change to another agent is no conflict', async () => {
    const rig = makeRig();
    rig.settings.update({ agents: { 'agent-a': { enabled: true } } as never });
    const result = await rig.host
      .forRun(runCtx(rig))
      .change({
        id: 'agents.external',
        values: { agent: 'agent-b', enabled: true },
        reason: '用 B',
      });
    const id = messageIdIn(result.content);
    const card = cardOf(rig, id);
    expect(card.before).toEqual({ agent: 'agent-b', enabled: false });
    // Meanwhile agent-a is switched off elsewhere.
    rig.settings.update({ agents: { 'agent-a': { enabled: false } } as never });
    const applied = await rig.host.applyItem({
      itemId: 'agents.external',
      values: { agent: 'agent-b', enabled: true },
      expected: card.before,
      messageId: id,
    });
    expect(applied.status).toBe('applied');
    expect(rig.settings.get().agents['agent-b']?.enabled).toBe(true);
    expect(rig.settings.get().agents['agent-a']?.enabled).toBe(false);
    // The unfocused read covers every enabled agent.
    rig.settings.update({
      agents: { ...rig.settings.get().agents, 'agent-a': { enabled: true } } as never,
    });
    expect(
      rig.host.read('agents.external', { botId: null, conversationId: null, projectId: null }),
    ).toMatchObject({
      values: { agent: 'agent-a,agent-b', enabled: true },
      summary: '已启用：agent-a、agent-b',
    });
  });

  it('#11 the write lock fails a waiter after the bounded wait instead of stalling forever', async () => {
    const lock = new SettingsWriteLock({ waitMs: 50 });
    let release!: () => void;
    const hung = lock.run(
      () => new Promise<string>((resolve) => (release = () => resolve('first'))),
    );
    await expect(lock.run(() => 'second')).rejects.toMatchObject({ code: 'TIMEOUT' });
    let ran = false;
    const third = lock.run(() => {
      ran = true;
      return 'third';
    });
    release();
    await expect(hung).resolves.toBe('first');
    // The third waiter either got in after the release or timed out; it never jumped the queue.
    const outcome = await third.then(
      (value) => value,
      (error: { code?: string }) => error.code,
    );
    expect(['third', 'TIMEOUT']).toContain(outcome);
    expect(ran).toBe(outcome === 'third');
  });
});

const CHANGE_MAIN_ALT = {
  id: 'models.default-main',
  values: { model: 'custom:mock/mock-alt' },
  reason: '换模型',
};
