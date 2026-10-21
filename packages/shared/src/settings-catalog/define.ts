import {
  SENSITIVE_FIELD_TYPES,
  type SettingFieldSpec,
  type SettingFieldType,
  type SettingItem,
  type SettingWriteMode,
  type SettingWriteSpec,
} from './types.js';

/**
 * 登记目录条目用的一组小 helper（todo/settings-catalog-registry.md §4.1.1）。
 * `items.ts`（或拆分后的 `items/`）从这里 import；导出成公开 API 是为了后续
 * 按功能拆文件时不必再挪。
 */

export type SettingItemInput = Omit<
  SettingItem,
  'owner' | 'readOnly' | 'enables' | 'keywords' | 'fields'
> &
  Partial<Pick<SettingItem, 'owner' | 'readOnly' | 'enables' | 'keywords' | 'fields'>>;

export function defineSettingItem(input: SettingItemInput): SettingItem {
  return { owner: 'core', readOnly: false, enables: [], keywords: [], fields: [], ...input };
}

export function defineSettingField(
  name: string,
  label: string,
  type: SettingFieldType,
  extra: Partial<Omit<SettingFieldSpec, 'name' | 'label' | 'type'>> = {},
): SettingFieldSpec {
  return { name, label, type, sensitive: SENSITIVE_FIELD_TYPES.has(type), ...extra };
}

export function defineSettingWrite(
  maxMode: SettingWriteMode,
  extra: Partial<Omit<SettingWriteSpec, 'maxMode'>> = {},
): SettingWriteSpec {
  return { maxMode, via: 'catalog', widensPermission: false, ...extra };
}

/** 经专门工具的项：档位只作展示，`effectiveMode` 一律给 redirect。 */
export function defineViaTool(
  tool: string,
  maxMode: SettingWriteMode,
  widensPermission = false,
): SettingWriteSpec {
  return { maxMode, via: { tool }, widensPermission };
}
