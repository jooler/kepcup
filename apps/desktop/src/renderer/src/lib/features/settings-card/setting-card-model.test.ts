import { describe, expect, it } from 'vitest';
import {
  getSettingItem,
  SETTING_CARD_EVENT,
  type Message,
  type SettingCardContent,
  type SettingFieldSpec,
  type SettingItem,
} from '@kepcup/shared';
import {
  capabilityOfItem,
  capabilityPrefill,
  embeddedCardKey,
  formatSettingValue,
  hostApplies,
  linkCardSettled,
  nonSensitiveValues,
  offersManualComplete,
  receiptUndo,
  sensorOfItem,
  settingCardOf,
  settingCardPrefill,
  settingCardStateKey,
  settingCardView,
  settingDiffRows,
  type ValueText,
} from './setting-card-model';

const text: ValueText = {
  on: '开启',
  off: '关闭',
  empty: '（未设置）',
  modelLabel: (ref) => (ref === 'custom:mock/mock-main' ? 'Mock Main' : null),
};

function item(id: string): SettingItem {
  const found = getSettingItem(id);
  if (found === null) throw new Error(`missing catalog item ${id}`);
  return found;
}

function card(patch: Partial<SettingCardContent> = {}): SettingCardContent {
  return {
    botId: 'bot_a',
    runId: 'run_1',
    itemId: 'models.default-light',
    mode: 'confirm',
    target: {},
    proposed: { model: 'custom:mock/mock-main' },
    before: { model: 'custom:mock/mock-light' },
    reason: '轻量工作也用主模型',
    state: 'pending',
    ...patch,
  };
}

describe('settingCardView / settingCardOf', () => {
  it('direct 档是回执卡，其余同档位名', () => {
    expect(settingCardView({ mode: 'direct' })).toBe('receipt');
    for (const mode of ['confirm', 'form', 'user-only', 'link'] as const) {
      expect(settingCardView({ mode })).toBe(mode);
    }
  });

  it('只认带结构化内容的 setting_card 系统事件', () => {
    const base = {
      id: 'msg_1',
      conversationId: 'conv_1',
      senderType: 'system',
      kind: 'system_event',
    } as unknown as Message;
    const content = card();
    expect(
      settingCardOf({
        ...base,
        content: { event: SETTING_CARD_EVENT, text: '', setting: content },
      } as Message),
    ).toEqual(content);
    expect(
      settingCardOf({ ...base, content: { event: SETTING_CARD_EVENT, text: '' } } as Message),
    ).toBeNull();
    expect(
      settingCardOf({
        ...base,
        content: { event: 'schedule_offer', text: '', setting: content },
      } as Message),
    ).toBeNull();
    expect(settingCardOf({ ...base, kind: 'text', content: { text: 'hi' } } as Message)).toBeNull();
  });
});

describe('值格式化与对比行', () => {
  it('布尔 / 空值 / 模型 ref / 静态选项 / 数组', () => {
    const toggle = { name: 'enabled', label: '开关', type: 'toggle', sensitive: false } as const;
    expect(formatSettingValue(toggle, true, text)).toBe('开启');
    expect(formatSettingValue(toggle, false, text)).toBe('关闭');
    expect(formatSettingValue(toggle, undefined, text)).toBe('（未设置）');
    const model = { name: 'model', label: '模型', type: 'model', sensitive: false } as const;
    expect(formatSettingValue(model, 'custom:mock/mock-main', text)).toBe('Mock Main');
    expect(formatSettingValue(model, 'other/x', text)).toBe('other/x');
    const select: SettingFieldSpec = {
      name: 'policy',
      label: '策略',
      type: 'select',
      sensitive: false,
      staticOptions: [{ value: 'open', label: '开放' }],
    };
    expect(formatSettingValue(select, 'open', text)).toBe('开放');
    expect(formatSettingValue(select, ['open', 'b'], text)).toBe('开放、b');
    expect(formatSettingValue(select, [], text)).toBe('（未设置）');
  });

  it('只列建议里出现的非敏感字段，并标出是否变化', () => {
    const rows = settingDiffRows(
      item('capability.image'),
      { provider: 'dashscope', model: 'wanx' },
      { provider: 'dashscope', model: 'qwen-image', apiKey: 'sk-should-not-show' },
      text,
    );
    expect(rows.map((row) => row.name)).toEqual(['provider', 'model']);
    expect(rows[0]).toMatchObject({ before: 'dashscope', after: 'dashscope', changed: false });
    expect(rows[1]).toMatchObject({ before: 'wanx', after: 'qwen-image', changed: true });
    expect(JSON.stringify(rows)).not.toContain('sk-should-not-show');
  });

  it('没有建议值（user-only / link）就没有对比行；当前值缺省显示未设置', () => {
    expect(settingDiffRows(item('unattended.enable'), null, null, text)).toEqual([]);
    const rows = settingDiffRows(
      item('models.default-main'),
      null,
      { model: 'custom:mock/mock-main' },
      text,
    );
    expect(rows).toEqual([
      { name: 'model', label: '主模型', before: '（未设置）', after: 'Mock Main', changed: true },
    ]);
  });
});

describe('预填过滤', () => {
  it('user-only / link / 回执卡不预填；其余只保留非敏感的已登记字段', () => {
    const capability = item('capability.image');
    const proposed = { provider: 'dashscope', apiKey: 'sk-x', bogus: 1 };
    expect(settingCardPrefill(capability, 'user-only', proposed)).toBeNull();
    expect(settingCardPrefill(capability, 'link', proposed)).toBeNull();
    expect(settingCardPrefill(capability, 'direct', proposed)).toBeNull();
    expect(settingCardPrefill(capability, 'form', proposed)).toEqual({ provider: 'dashscope' });
    expect(settingCardPrefill(capability, 'confirm', null)).toBeNull();
    expect(nonSensitiveValues(capability, { apiKey: 'sk-x' })).toBeNull();
  });

  it('能力模型预填：厂商须已适配该能力；厂商/模型写法拆开', () => {
    const vendors = ['dashscope', 'volcengine'];
    expect(capabilityPrefill({ provider: 'dashscope', model: 'qwen-image' }, vendors)).toEqual({
      vendor: 'dashscope',
      model: 'qwen-image',
    });
    expect(capabilityPrefill({ model: 'dashscope/qwen-image' }, vendors)).toEqual({
      vendor: 'dashscope',
      model: 'qwen-image',
    });
    expect(capabilityPrefill({ provider: 'dashscope', model: 'dashscope/x' }, vendors)).toEqual({
      vendor: 'dashscope',
      model: 'x',
    });
    expect(capabilityPrefill({ provider: 'openai' }, vendors)).toBeNull();
    expect(capabilityPrefill({ provider: 'volcengine' }, vendors)).toEqual({
      vendor: 'volcengine',
      model: null,
    });
    expect(capabilityPrefill(null, vendors)).toBeNull();
  });
});

describe('回执卡撤销与状态文案', () => {
  it('24 小时内的 applied 回执卡可撤销，过期 / 已撤销 / 非回执不可', () => {
    const now = 1_000_000;
    expect(
      receiptUndo(card({ mode: 'direct', state: 'applied', undoUntil: now + 1 }), now),
    ).toEqual({
      available: true,
      expired: false,
    });
    expect(receiptUndo(card({ mode: 'direct', state: 'applied', undoUntil: now }), now)).toEqual({
      available: false,
      expired: true,
    });
    expect(
      receiptUndo(card({ mode: 'direct', state: 'reverted', undoUntil: now + 1 }), now),
    ).toEqual({
      available: false,
      expired: false,
    });
    expect(
      receiptUndo(card({ mode: 'confirm', state: 'applied', undoUntil: now + 1 }), now).available,
    ).toBe(false);
  });

  it('pending 无说明；applied 区分回执；其余逐一对应', () => {
    expect(settingCardStateKey('pending', 'confirm')).toBeNull();
    expect(settingCardStateKey('applied', 'receipt')).toBe('settingCard.state.receipt');
    expect(settingCardStateKey('applied', 'confirm')).toBe('settingCard.state.applied');
    for (const state of ['dismissed', 'superseded', 'expired', 'reverted'] as const) {
      expect(settingCardStateKey(state, 'link')).toBe(`settingCard.state.${state}`);
    }
  });
});

describe('卡片形态的分发', () => {
  const always = () => true;

  it('link / 回执 / 无卡片键不内嵌；不能嵌（embeddable=false）退回跳转卡', () => {
    expect(embeddedCardKey(item('capability.image'), 'form', always)).toBe('capability-model');
    expect(embeddedCardKey(item('capability.image'), 'link', always)).toBeNull();
    expect(embeddedCardKey(item('models.default-main'), 'receipt', always)).toBeNull();
    expect(embeddedCardKey(item('environment.sandbox'), 'confirm', always)).toBeNull();
    expect(embeddedCardKey(item('general.theme'), 'confirm', always)).toBe('appearance');
    expect(embeddedCardKey(item('capability.image'), 'form', () => false)).toBeNull();
  });

  it('宿主「应用」：confirm + 有建议值 + 组件不自带 CAS 保存', () => {
    expect(hostApplies(item('capability.image'), 'confirm', { provider: 'dashscope' })).toBe(true);
    expect(hostApplies(item('hardware.microphone'), 'confirm', { enabled: true })).toBe(true);
    expect(hostApplies(item('models.default-main'), 'confirm', { model: 'x' })).toBe(false);
    expect(hostApplies(item('bot.model'), 'confirm', { model: 'x' })).toBe(false);
    expect(hostApplies(item('capability.image'), 'confirm', null)).toBe(false);
    expect(hostApplies(item('capability.image'), 'form', { provider: 'dashscope' })).toBe(false);
  });

  it('「我已设置好」只给用户亲手设置的形态', () => {
    expect(offersManualComplete('form')).toBe(true);
    expect(offersManualComplete('user-only')).toBe(true);
    expect(offersManualComplete('link')).toBe(true);
    expect(offersManualComplete('confirm')).toBe(false);
    expect(offersManualComplete('receipt')).toBe(false);
  });

  it('settings.changed 含本条目时 pending 的 link 卡自动完成', () => {
    const link = card({ mode: 'link', itemId: 'general.launch-at-login', proposed: null });
    expect(linkCardSettled(link, ['general.launch-at-login'])).toBe(true);
    expect(linkCardSettled(link, ['models.default-main'])).toBe(false);
    expect(linkCardSettled({ ...link, state: 'applied' }, ['general.launch-at-login'])).toBe(false);
    expect(linkCardSettled({ ...link, mode: 'confirm' }, ['general.launch-at-login'])).toBe(false);
  });

  it('条目 id → 能力 / 传感器', () => {
    expect(capabilityOfItem('capability.image')).toBe('image');
    expect(capabilityOfItem('capability.video')).toBe('video');
    expect(capabilityOfItem('models.default-main')).toBeNull();
    expect(sensorOfItem('hardware.microphone')).toBe('microphone');
    expect(sensorOfItem('hardware.camera')).toBe('camera');
    expect(sensorOfItem('general.theme')).toBeNull();
  });
});
