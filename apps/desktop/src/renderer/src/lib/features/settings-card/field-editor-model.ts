import type { SettingFieldSpec, SettingItem, SettingValues } from '@kepcup/shared';

/**
 * 通用 `FieldEditorCard`（card: 'field-editor'）的纯逻辑（todo/settings-catalog-registry.md
 * §4.3.5 / 任务 5）：按目录字段的元数据（type / options / path / min / max）决定控件、
 * 种子值与提交值。四个有联动或 i18n 语义的条目（models.concurrency /
 * general.launch-at-login / models.widget-review / agents.default）在组件里保留专用分支，
 * 其余条目零改动出卡。
 */

export type FieldControlKind =
  | 'toggle'
  | 'text'
  | 'number'
  | 'select-static'
  | 'select-agents'
  | 'select-providers'
  | 'model';

/** 这个字段能不能由通用控件渲染；null = 不支持（组件提示去设置页改）。 */
export function fieldControl(field: SettingFieldSpec): FieldControlKind | null {
  if (field.sensitive || field.multiple === true) return null;
  switch (field.type) {
    case 'toggle':
      return 'toggle';
    case 'text':
      return 'text';
    case 'number':
      return 'number';
    case 'model':
      return 'model';
    case 'select':
      switch (field.options) {
        case 'static':
          return 'select-static';
        case 'agents':
          return 'select-agents';
        case 'providers':
          return 'select-providers';
        default:
          return null;
      }
    default:
      return null;
  }
}

/** settings 上的点路径取值（`taskLoop.idleWarnAfter`）；任何一层缺失返回 undefined。 */
export function readSettingAtPath(settings: unknown, path: string): unknown {
  let node: unknown = settings;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** 没有存值时各控件类型的初始值（设置快照到达后会被真实值覆盖）。 */
export function controlDefault(field: SettingFieldSpec): unknown {
  switch (fieldControl(field)) {
    case 'toggle':
      return false;
    case 'number':
      return field.min ?? 0;
    case 'select-static':
      return field.staticOptions?.[0]?.value ?? '';
    default:
      return '';
  }
}

/**
 * 种子值：预填优先（Bot 建议 / 卡片预填，已是过滤后的非敏感字段）；否则按
 * `field.path ?? field.name` 从 settings 快照取。敏感字段永不进种子。
 */
export function seedValues(
  item: SettingItem,
  prefill: SettingValues | null,
  settings: unknown,
): SettingValues {
  if (prefill !== null) return { ...prefill };
  const out: SettingValues = {};
  for (const field of item.fields) {
    if (field.sensitive) continue;
    const value = readSettingAtPath(settings, field.path ?? field.name);
    if (value !== undefined) out[field.name] = value as never;
  }
  return out;
}

/**
 * 提交给 `settings.items.apply` 的值：只含非敏感字段；通用控件的值直接来自 state，
 * 专用分支（provider/limit 等）由组件写入 state 后同样从这里带出。数字控件给空 /
 * 非有限数时回落到字段默认，不让 `null` 混进 values；没有控件的字段（不支持的类型，
 * 卡上已提示去设置页改）不提交。
 */
export function valuesFromState(item: SettingItem, state: SettingValues): SettingValues {
  const out: SettingValues = {};
  for (const field of item.fields) {
    if (field.sensitive) continue;
    const value = state[field.name];
    if (value === undefined && field.type !== 'number') continue;
    if (field.type === 'number' && typeof value !== 'number') {
      out[field.name] = controlDefault(field) as never;
      continue;
    }
    out[field.name] = value as never;
  }
  return out;
}

/** 卡片能否完整渲染这个条目：所有非敏感字段都有通用控件或专用分支。 */
export function supportsItem(item: SettingItem): boolean {
  const SPECIAL = new Set([
    'models.concurrency',
    'general.launch-at-login',
    'models.widget-review',
    'agents.default',
  ]);
  return (
    SPECIAL.has(item.id) ||
    item.fields.every((field) => field.sensitive || fieldControl(field) !== null)
  );
}
