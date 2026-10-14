import {
  CAPABILITY_SETTING_IDS,
  SETTING_CARD_EVENT,
  type CardKey,
  type CapabilityModelKey,
  type Message,
  type SensorKind,
  type SettingCardContent,
  type SettingCardState,
  type SettingFieldSpec,
  type SettingItem,
  type SettingValues,
} from '@kepcup/shared';

/**
 * 对话内设置卡（todo/conversational-app-setup.md §六）的纯逻辑：档位 → 卡片形态、
 * 「当前 → 建议」对比行、预填过滤、撤销窗口、终态文案键、link 卡自动标 applied 的判定。
 * 组件（SettingCard / SettingCardEmbed）只负责渲染与调用 RPC。
 */

/** 卡片形态：direct 档 = 回执卡，其余同档位名。 */
export type SettingCardView = 'receipt' | 'confirm' | 'form' | 'user-only' | 'link';

export function settingCardView(content: Pick<SettingCardContent, 'mode'>): SettingCardView {
  return content.mode === 'direct' ? 'receipt' : content.mode;
}

/** 消息是不是设置卡（system_event `setting_card` 且带结构化内容）。 */
export function settingCardOf(message: Message): SettingCardContent | null {
  if (message.kind !== 'system_event') return null;
  const content = message.content as { event?: string; setting?: SettingCardContent };
  return content.event === SETTING_CARD_EVENT && content.setting !== undefined
    ? content.setting
    : null;
}

/**
 * 自带保存（经 `settings.items.apply` 做条目级 CAS）的卡片键：卡片宿主不再另给「应用」按钮，
 * 组件自己的「应用」就是宿主的应用（带 `expected` 与 `messageId`）。
 */
export const SELF_APPLYING_CARD_KEYS: ReadonlySet<CardKey> = new Set([
  'default-models',
  'bot-model',
  'bot-config',
  'bot-skills',
  'field-editor',
  'appearance',
]);

/**
 * confirm 卡有没有可编辑的非敏感字段。没有（如「关闭无人值守」）就直接展开组件，
 * 不靠「改一下」——宿主没有建议值可以代为应用。
 */
export function confirmHasFields(item: SettingItem): boolean {
  return item.fields.some((field) => !field.sensitive);
}

/** 文案：值格式化时的固定词（调用方从 i18n 取，保持本文件无 UI 依赖）。 */
export interface ValueText {
  on: string;
  off: string;
  empty: string;
  /** model 字段：ref → 展示名（不认识的返回 null，原样显示 ref）。 */
  modelLabel(ref: string): string | null;
}

/** 一个字段值的展示文本（敏感字段永不经过这里）。 */
export function formatSettingValue(
  field: SettingFieldSpec,
  value: unknown,
  text: ValueText,
): string {
  if (value === undefined || value === null || value === '') return text.empty;
  if (Array.isArray(value)) {
    if (value.length === 0) return text.empty;
    return value.map((entry) => formatSettingValue(field, entry, text)).join('、');
  }
  if (typeof value === 'boolean') return value ? text.on : text.off;
  if (typeof value === 'string') {
    if (field.type === 'model') return text.modelLabel(value) ?? value;
    const option = field.staticOptions?.find((entry) => entry.value === value);
    return option?.label ?? value;
  }
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

export interface SettingDiffRow {
  name: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

/**
 * 「当前 → 建议」（或回执卡的「旧值 → 新值」）对比行：只列非敏感字段，且只列 `after` 里出现
 * 的字段（Bot 只改它提到的字段）；`after` 为空时没有对比行。
 */
export function settingDiffRows(
  item: SettingItem,
  before: SettingValues | null,
  after: SettingValues | null,
  text: ValueText,
): SettingDiffRow[] {
  if (after === null) return [];
  return item.fields
    .filter((field) => !field.sensitive && Object.hasOwn(after, field.name))
    .map((field) => {
      const beforeValue = before?.[field.name];
      const afterValue = after[field.name];
      const beforeText = formatSettingValue(field, beforeValue, text);
      const afterText = formatSettingValue(field, afterValue, text);
      return {
        name: field.name,
        label: field.label,
        before: beforeText,
        after: afterText,
        changed: JSON.stringify(beforeValue ?? null) !== JSON.stringify(afterValue ?? null),
      };
    });
}

/**
 * 交给内嵌组件的预填：user-only / link 卡与回执卡恒为 null（宿主不采用 Bot 的值）；其余只保留
 * 目录里登记过的非敏感字段（core 已过滤，这里再兜一次底）。
 */
export function settingCardPrefill(
  item: SettingItem,
  mode: SettingCardContent['mode'],
  proposed: SettingValues | null,
): SettingValues | null {
  if (proposed === null || mode === 'user-only' || mode === 'link' || mode === 'direct') {
    return null;
  }
  return nonSensitiveValues(item, proposed);
}

/** 只保留目录里登记过的非敏感字段；一个都不剩返回 null。 */
export function nonSensitiveValues(
  item: SettingItem,
  values: SettingValues | null | undefined,
): SettingValues | null {
  if (values === null || values === undefined) return null;
  const allowed = new Set(
    item.fields.filter((field) => !field.sensitive).map((field) => field.name),
  );
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** 回执卡「撤销」：只有 applied 的 direct 卡、在有效期内才可撤销。 */
export function receiptUndo(
  content: Pick<SettingCardContent, 'mode' | 'state' | 'undoUntil'>,
  now: number,
): { available: boolean; expired: boolean } {
  if (content.mode !== 'direct' || content.state !== 'applied') {
    return { available: false, expired: false };
  }
  const expired = content.undoUntil === undefined || content.undoUntil <= now;
  return { available: !expired, expired };
}

/** 落定后的一行说明（pending 返回 null）。键在 i18n `settingCard.state.*`。 */
export function settingCardStateKey(
  state: SettingCardState,
  view: SettingCardView,
):
  | 'settingCard.state.applied'
  | 'settingCard.state.receipt'
  | 'settingCard.state.dismissed'
  | 'settingCard.state.superseded'
  | 'settingCard.state.expired'
  | 'settingCard.state.reverted'
  | null {
  switch (state) {
    case 'pending':
      return null;
    case 'applied':
      return view === 'receipt' ? 'settingCard.state.receipt' : 'settingCard.state.applied';
    default:
      return `settingCard.state.${state}`;
  }
}

/**
 * 卡片内嵌哪个组件：条目有卡片键、渲染层能嵌（`embeddable`）且档位不是 link / 回执。
 * 返回 null = 跳转卡（「在设置中打开」）。
 */
export function embeddedCardKey(
  item: SettingItem,
  view: SettingCardView,
  embeddable: (item: SettingItem) => boolean,
): CardKey | null {
  if (item.card === null || view === 'link' || view === 'receipt') return null;
  return embeddable(item) ? item.card : null;
}

/**
 * 宿主给不给「应用」按钮：confirm 卡、有 Bot 的建议值、组件不自带 CAS 保存。按钮经
 * `settings.items.apply`（`expected` = 出卡时的当前值）写入；渲染层条目在本机写后
 * `settings.cards.complete`。
 */
export function hostApplies(
  item: SettingItem,
  view: SettingCardView,
  proposed: SettingValues | null,
): boolean {
  if (view !== 'confirm' || proposed === null) return false;
  return item.card === null || !SELF_APPLYING_CARD_KEYS.has(item.card);
}

/** 「我已设置好」：用户亲手设置的形态（form / user-only / link）给，confirm 与回执卡不给。 */
export function offersManualComplete(view: SettingCardView): boolean {
  return view === 'form' || view === 'user-only' || view === 'link';
}

/**
 * link 卡收到 `settings.changed` 时自己标 applied（§6.1）：pending、link 形态、且变化条目里有它。
 * 其余形态由卡上的保存回调完成，不在这里重复。
 */
export function linkCardSettled(
  content: Pick<SettingCardContent, 'mode' | 'state' | 'itemId'>,
  changedItemIds: readonly string[],
): boolean {
  return (
    content.state === 'pending' &&
    content.mode === 'link' &&
    changedItemIds.includes(content.itemId)
  );
}

// --- 卡片键的组件参数（SettingCardEmbed 用；纯函数便于单测）------------------------

/** `capability.{能力}` → 能力键；不是能力条目返回 null。 */
export function capabilityOfItem(itemId: string): CapabilityModelKey | null {
  const entry = Object.entries(CAPABILITY_SETTING_IDS).find(([, id]) => id === itemId);
  return entry === undefined ? null : (entry[0] as CapabilityModelKey);
}

/** 硬件条目 → 传感器种类。 */
export function sensorOfItem(itemId: string): SensorKind | null {
  if (itemId === 'hardware.microphone') return 'microphone';
  if (itemId === 'hardware.camera') return 'camera';
  return null;
}

/** 预填里的一个字符串字段（非字符串 / 空串按缺省）。 */
export function prefillString(
  prefill: SettingValues | null | undefined,
  name: string,
): string | null {
  const value = prefill?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 预填里的一个布尔字段。 */
export function prefillBoolean(
  prefill: SettingValues | null | undefined,
  name: string,
): boolean | null {
  const value = prefill?.[name];
  return typeof value === 'boolean' ? value : null;
}

/**
 * 能力模型卡的预填（`provider` / `model` 字段）：厂商须在该能力已适配的厂商里；`model` 若写成
 * `厂商/模型` 且未给 `provider`，按第一个 `/` 拆开。拿不到可用厂商返回 null（不预填）。
 */
export function capabilityPrefill(
  prefill: SettingValues | null | undefined,
  vendorIds: readonly string[],
): { vendor: string; model: string | null } | null {
  let vendor = prefillString(prefill, 'provider');
  let model = prefillString(prefill, 'model');
  if (vendor === null && model !== null && model.includes('/')) {
    const slash = model.indexOf('/');
    vendor = model.slice(0, slash);
    model = model.slice(slash + 1);
  } else if (vendor !== null && model !== null && model.startsWith(`${vendor}/`)) {
    model = model.slice(vendor.length + 1);
  }
  if (vendor === null || !vendorIds.includes(vendor)) return null;
  return { vendor, model: model !== null && model.length > 0 ? model : null };
}
