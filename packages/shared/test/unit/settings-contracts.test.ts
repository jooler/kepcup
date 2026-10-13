import { describe, expect, it } from 'vitest';
import {
  APP_RPC_METHODS,
  HOST_CAPABILITIES,
  HOST_CAPABILITY_OPT_INS,
  SETTINGS_CHANGE_TOOL,
  SETTINGS_READ_TOOL,
  SETTINGS_SEARCH_TOOL,
  SETTING_CARD_EVENT,
  SETTING_CARD_RESOLVED_EVENT,
  capabilityOfTool,
  defaultCapabilities,
  hostCapability,
  isHostToolInjected,
  messageContentSchema,
  optInOfTool,
  resolveCapabilities,
  resolveCapabilityOptIns,
  rpcEventSchemas,
  rpcMethodSchemas,
  runSchema,
  setupRequirementSchema,
  settingCardContentSchema,
  settingsChangeResultSchema,
  settingsReadResultSchema,
  settingsSearchResultSchema,
} from '../../src/index.js';

/** 对话内应用设置的 shared 契约：设置卡事件、通用 setup kind、RPC、事件与 ACP 能力包。 */

const card = {
  botId: 'bot_a',
  runId: 'run_1',
  itemId: 'models.default-main',
  mode: 'direct',
  target: {},
  proposed: { model: 'deepseek/deepseek-chat' },
  before: { model: 'openai/gpt-4o' },
  reason: '你说想换个便宜点的模型',
  state: 'applied',
  applied: { model: 'deepseek/deepseek-chat' },
  undoUntil: 1_700_000_000_000,
};

describe('setting_card system event', () => {
  it('round-trips through messageContentSchema without losing the card', () => {
    const content = messageContentSchema.parse({
      event: SETTING_CARD_EVENT,
      text: '已改为 deepseek',
      setting: card,
    });
    expect(content).toMatchObject({ event: 'setting_card', setting: card });
    expect(SETTING_CARD_EVENT).toBe('setting_card');
  });

  it('accepts every state and nullable values; rejects redirect / refused as a card mode', () => {
    for (const state of ['pending', 'applied', 'dismissed', 'superseded', 'expired', 'reverted']) {
      expect(settingCardContentSchema.safeParse({ ...card, state }).success, state).toBe(true);
    }
    expect(
      settingCardContentSchema.safeParse({
        ...card,
        mode: 'user-only',
        proposed: null,
        before: null,
      }).success,
    ).toBe(true);
    expect(settingCardContentSchema.safeParse({ ...card, mode: 'redirect' }).success).toBe(false);
    expect(settingCardContentSchema.safeParse({ ...card, state: 'accepted' }).success).toBe(false);
    // target 缺省为 {}。
    const { target: _target, ...rest } = card;
    expect(settingCardContentSchema.parse(rest).target).toEqual({});
  });

  it('carries the resolved internal event payload', () => {
    const content = messageContentSchema.parse({
      event: SETTING_CARD_RESOLVED_EVENT,
      text: '用户已应用：默认主模型（openai/gpt-4o → deepseek/deepseek-chat）',
      internal: true,
      settingResolved: {
        cardMessageId: 'msg_1',
        itemId: 'models.default-main',
        outcome: 'applied',
        before: { model: 'openai/gpt-4o' },
        after: { model: 'deepseek/deepseek-chat' },
      },
    });
    expect(content).toMatchObject({
      event: 'setting_card_resolved',
      settingResolved: { outcome: 'applied' },
    });
  });
});

describe("setupRequirement kind 'setting'", () => {
  it('parses the generic setting requirement and keeps the old kinds', () => {
    const requirement = {
      kind: 'setting',
      itemId: 'capability.image',
      prefill: { provider: 'openai' },
      reason: '生成图片需要图像模型',
    };
    expect(setupRequirementSchema.parse(requirement)).toEqual(requirement);
    expect(setupRequirementSchema.safeParse({ kind: 'setting', itemId: 'x' }).success).toBe(false);
    expect(setupRequirementSchema.parse({ kind: 'main-model' })).toEqual({ kind: 'main-model' });
    const run = runSchema.shape.setup.parse(requirement);
    expect(run).toMatchObject({ kind: 'setting' });
  });
});

describe('settings RPC methods and events', () => {
  it('registers the four methods on port A', () => {
    for (const name of [
      'settings.items.apply',
      'settings.cards.dismiss',
      'settings.cards.complete',
      'settings.cards.undo',
    ] as const) {
      expect(rpcMethodSchemas[name]).toBeDefined();
      expect(APP_RPC_METHODS).toContain(name);
    }
  });

  it('settings.items.apply: item-level CAS input and applied / conflict output', () => {
    const { input, output } = rpcMethodSchemas['settings.items.apply'];
    expect(
      input.safeParse({
        itemId: 'bot.model',
        values: { model: 'a/b' },
        expected: { model: '' },
        target: { botId: 'bot_a' },
        messageId: 'msg_1',
      }).success,
    ).toBe(true);
    expect(input.safeParse({ itemId: 'bot.model', values: {}, expected: null }).success).toBe(true);
    // expected 必须显式给（null = 不比对），防止卡片漏传而绕过 CAS。
    expect(input.safeParse({ itemId: 'bot.model', values: {} }).success).toBe(false);
    expect(input.safeParse({ itemId: '', values: {}, expected: null }).success).toBe(false);
    expect(
      output.parse({ status: 'conflict', itemId: 'bot.model', current: { model: 'x/y' } }),
    ).toMatchObject({ status: 'conflict' });
    expect(
      output.safeParse({ status: 'applied', itemId: 'bot.model', before: null, values: {} })
        .success,
    ).toBe(true);
  });

  it('card actions take the card message id', () => {
    expect(
      rpcMethodSchemas['settings.cards.dismiss'].input.safeParse({ messageId: 'm' }).success,
    ).toBe(true);
    expect(rpcMethodSchemas['settings.cards.dismiss'].input.safeParse({}).success).toBe(false);
    expect(
      rpcMethodSchemas['settings.cards.complete'].output.parse({
        state: 'applied',
        verified: null,
      }),
    ).toEqual({ state: 'applied', verified: null });
    expect(
      rpcMethodSchemas['settings.cards.undo'].output.parse({ status: 'conflict', current: null }),
    ).toEqual({ status: 'conflict', current: null });
  });

  it('settings.changed carries a non-empty item id list', () => {
    const schema = rpcEventSchemas['settings.changed'];
    expect(schema.parse({ itemIds: ['models.default-main'] })).toEqual({
      itemIds: ['models.default-main'],
    });
    expect(schema.safeParse({ itemIds: [] }).success).toBe(false);
  });
});

describe('bot tool result shapes', () => {
  it('search: overview or ≤10 hits; read: item or unknown with candidates; change outcomes', () => {
    expect(
      settingsSearchResultSchema.safeParse({
        kind: 'overview',
        groups: [{ group: 'models', title: '模型', summary: '主模型已配；图像能力未配' }],
      }).success,
    ).toBe(true);
    expect(
      settingsSearchResultSchema.safeParse({
        kind: 'results',
        query: '生成图片',
        items: [
          {
            id: 'capability.image',
            title: '图像生成模型',
            summary: '…',
            status: 'unconfigured',
            mode: 'confirm',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      settingsReadResultSchema.safeParse({
        kind: 'unknown',
        id: 'x',
        candidates: ['models.default-main'],
      }).success,
    ).toBe(true);
    expect(
      settingsReadResultSchema.safeParse({
        kind: 'item',
        id: 'capability.image',
        title: '图像生成模型',
        summary: '…',
        group: 'models',
        scope: 'global',
        owner: 'core',
        status: 'partial',
        fields: [
          { name: 'apiKey', label: 'API Key', type: 'secret', sensitive: true, configured: false },
          {
            name: 'model',
            label: '模型',
            type: 'model',
            sensitive: false,
            value: 'openai/gpt-image-1',
            options: [{ value: 'openai/gpt-image-1', label: 'GPT Image' }],
          },
        ],
        decision: {
          mode: 'form',
          acceptValues: true,
          tool: null,
          rules: ['sensitive-input'],
          reason: '需要用户自己填写密钥或登录，已出待填卡',
        },
      }).success,
    ).toBe(true);
    for (const outcome of ['applied', 'card', 'setup_required', 'redirect', 'rejected']) {
      expect(
        settingsChangeResultSchema.safeParse({
          outcome,
          itemId: 'bot.model',
          mode: outcome === 'rejected' ? null : 'confirm',
          cardMessageId: null,
          tool: null,
          before: null,
          after: null,
          message: '…',
        }).success,
        outcome,
      ).toBe(true);
    }
  });
});

describe("ACP capability pack 'settings' (§5.3 第 7 条)", () => {
  const caps = resolveCapabilities(null, { nativeCapabilities: {} });

  it('is a host pack injected by default with all three tools', () => {
    const pack = hostCapability('settings');
    expect(pack).toMatchObject({ category: 'host', default: 'inject', overlapsNative: null });
    expect(pack.tools).toEqual([SETTINGS_SEARCH_TOOL, SETTINGS_READ_TOOL, SETTINGS_CHANGE_TOOL]);
    expect(defaultCapabilities({ nativeCapabilities: {} })).toContain('settings');
    for (const tool of pack.tools) expect(capabilityOfTool(tool)?.id).toBe('settings');
  });

  it('injects search / read by default but settings_change only when the bot opts in', () => {
    expect(resolveCapabilityOptIns(null, caps)).toEqual([]);
    expect(isHostToolInjected(SETTINGS_SEARCH_TOOL, caps, [])).toBe(true);
    expect(isHostToolInjected(SETTINGS_READ_TOOL, caps, [])).toBe(true);
    expect(isHostToolInjected(SETTINGS_CHANGE_TOOL, caps, [])).toBe(false);

    const selected = [...caps, 'settings:change'];
    const resolved = resolveCapabilities(selected, { nativeCapabilities: {} });
    // 选项 id 不是包 id：不会混进 resolveCapabilities 的结果。
    expect(resolved).toEqual(caps);
    const optIns = resolveCapabilityOptIns(selected, resolved);
    expect(optIns).toEqual(['settings:change']);
    expect(isHostToolInjected(SETTINGS_CHANGE_TOOL, resolved, optIns)).toBe(true);

    // 包没选中时选项不生效。
    const withoutPack = resolveCapabilities(['memory', 'settings:change'], {
      nativeCapabilities: {},
    });
    expect(resolveCapabilityOptIns(['memory', 'settings:change'], withoutPack)).toEqual([]);
    expect(isHostToolInjected(SETTINGS_READ_TOOL, withoutPack, ['settings:change'])).toBe(false);
  });

  it('opt-in tools are tools of their own pack; only settings has opt-ins for now', () => {
    expect(HOST_CAPABILITY_OPT_INS.map((optIn) => optIn.id)).toEqual(['settings:change']);
    for (const capability of HOST_CAPABILITIES) {
      for (const optIn of capability.optIns) {
        expect(optIn.id.startsWith(`${capability.id}:`)).toBe(true);
        for (const tool of optIn.tools) expect(capability.tools).toContain(tool);
      }
    }
    expect(optInOfTool(SETTINGS_CHANGE_TOOL)?.id).toBe('settings:change');
    expect(optInOfTool('send_message')).toBeNull();
    // 其余工具不受选项影响。
    expect(isHostToolInjected('send_message', caps, [])).toBe(true);
    expect(isHostToolInjected('bash', caps, [])).toBe(false);
  });
});
