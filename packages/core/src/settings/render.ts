import {
  SETTING_CARD_EVENT,
  SETTING_CARD_RESOLVED_EVENT,
  getSettingItem,
  sanitizeDisplayText,
  type Message,
  type SettingCardContent,
  type SettingCardResolved,
  type SettingValues,
  type SettingWriteMode,
} from '@kepcup/shared';
import { neutralizeUntrusted } from '../infra/data-boundary.js';

/**
 * 设置卡在模型上下文里的样子（todo/conversational-app-setup.md §5.3 回执卡、§6.2）：
 * `setting_card`（含回执卡）与内部事件 `setting_card_resolved` 都按结构化内容渲染成一行；
 * 卡上的值、Bot 的理由来自模型输出与用户自填的名称——一律放进 `<untrusted>`。
 */

const VALUE_TEXT_MAX = 160;

export const SETTING_MODE_WORDS: Readonly<Record<SettingWriteMode, string>> = {
  direct: '直接修改',
  confirm: '确认卡',
  form: '待填卡',
  'user-only': '由用户亲手设置的卡',
  link: '跳转卡',
};

/** 条目标题（目录里的，可信）；未知条目用 id。 */
export function settingTitle(itemId: string): string {
  return getSettingItem(itemId)?.title ?? itemId;
}

/** 单个字段值的人话（未清洗）。 */
export function settingValueText(value: unknown): string {
  if (typeof value === 'string') return value.length > 0 ? value : '（空）';
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (Array.isArray(value))
    return value.length > 0 ? value.map((entry) => settingValueText(entry)).join('、') : '（空）';
  return JSON.stringify(value) ?? '（空）';
}

/** 字段值 → 一行人话（字段名用目录 label）；空 = 「（空）」。只含非敏感字段。 */
export function settingValuesText(itemId: string, values: SettingValues | null): string {
  if (values === null) return '（未知）';
  const fields = getSettingItem(itemId)?.fields ?? [];
  const parts = Object.entries(values)
    .filter(([key]) => !(fields.find((field) => field.name === key)?.sensitive ?? false))
    .map(([key, value]) => {
      const label = fields.find((field) => field.name === key)?.label ?? key;
      return `${label} ${settingValueText(value)}`;
    });
  return sanitizeDisplayText(parts.length > 0 ? parts.join('，') : '（空）', VALUE_TEXT_MAX);
}

function wrap(text: string): string {
  return `<untrusted>${neutralizeUntrusted(text)}</untrusted>`;
}

function beforeText(card: SettingCardContent): string {
  return card.beforeText ?? settingValuesText(card.itemId, card.before);
}

function afterText(card: SettingCardContent): string {
  return card.proposedText ?? settingValuesText(card.itemId, card.applied ?? card.proposed);
}

/** `setting_card` 系统事件的上下文行；不是设置卡返回 null。 */
export function renderSettingCardLine(
  message: Message,
  options: { selfBotId: string | null; botNames: ReadonlyMap<string, string> },
): string | null {
  const content = message.content as {
    event?: unknown;
    setting?: SettingCardContent;
    settingResolved?: SettingCardResolved;
    text?: string;
  };
  if (content.event === SETTING_CARD_RESOLVED_EVENT) {
    const resolved = content.settingResolved;
    const lead = content.text ?? '';
    if (resolved === undefined || resolved.outcome !== 'applied') return lead;
    return `${lead} 变更：${wrap(
      `${settingValuesText(resolved.itemId, resolved.before)} → ${settingValuesText(resolved.itemId, resolved.after)}`,
    )}`;
  }
  if (content.event !== SETTING_CARD_EVENT || content.setting === undefined) return null;
  const card = content.setting;
  const title = settingTitle(card.itemId);
  const who =
    options.selfBotId !== null && card.botId === options.selfBotId
      ? '你'
      : (options.botNames.get(card.botId) ?? card.botId);
  if (card.mode === 'direct') {
    if (card.state === 'reverted') {
      return `用户撤销了${who}对「${title}」的修改，已恢复为 ${wrap(beforeText(card))}`;
    }
    return `${who}直接修改了「${title}」：${wrap(`${beforeText(card)} → ${afterText(card)}`)}（回执卡，用户可撤销）`;
  }
  const head = `${who}出的设置卡「${title}」（${SETTING_MODE_WORDS[card.mode]}）`;
  switch (card.state) {
    case 'pending': {
      const proposal = card.proposed !== null ? `，建议改为 ${wrap(afterText(card))}` : '';
      return `${head}：等用户处理${proposal}；理由 ${wrap(card.reason)}`;
    }
    case 'applied':
      return `${head}：用户已应用${card.applied !== undefined ? ` ${wrap(`${beforeText(card)} → ${settingValuesText(card.itemId, card.applied)}`)}` : ''}`;
    case 'dismissed':
      return `${head}：用户点了「不用了」，没有修改`;
    case 'superseded':
      return `${head}：已被新的设置卡取代`;
    case 'expired':
      return `${head}：已过期，用户没有处理`;
    case 'reverted':
      return `${head}：修改已被用户撤销`;
  }
}
