import type { SettingFieldSpec, SettingItem } from './types.js';

/**
 * 条目 `values` 的形状校验（D89 审查修复）：Bot 的 `settings_change` 与渲染层的
 * `settings.items.apply` 在 core 写入前都过这一道——只认目录登记的字段，按字段类型核对值的
 * 形状，静态选项必须是登记的值之一。语义校验（模型是否存在、厂商 id 是否已接入……）仍在各适配器
 * 的 `normalize` 里。
 */

/** 单个字符串值的上限（群名、域名、模型 id、智能体 id……都远小于它）。 */
export const SETTING_TEXT_MAX = 500;
/** 多值字段的条数上限。 */
export const SETTING_LIST_MAX = 200;
/** 敏感字段（Key、口令）的长度上限。 */
const SECRET_MAX = 4096;

function isString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/** 多值：数组，或模型写成的换行 / 逗号分隔字符串（适配器的 normalize 再拆）。 */
function isStringList(value: unknown): boolean {
  if (typeof value === 'string') return value.length <= SETTING_TEXT_MAX * 4;
  return (
    Array.isArray(value) &&
    value.length <= SETTING_LIST_MAX &&
    value.every((entry) => isString(entry, SETTING_TEXT_MAX))
  );
}

function fieldProblem(field: SettingFieldSpec, value: unknown): string | null {
  switch (field.type) {
    case 'secret':
    case 'oauth':
    case 'account':
      return isString(value, SECRET_MAX) ? null : `${field.name} 应为字符串`;
    case 'toggle':
      return typeof value === 'boolean' ? null : `${field.name} 应为 true / false`;
    case 'number':
      if (field.multiple === true) {
        return Array.isArray(value) &&
          value.length <= SETTING_LIST_MAX &&
          value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
          ? null
          : `${field.name} 应为数字列表`;
      }
      return typeof value === 'number' && Number.isFinite(value) ? null : `${field.name} 应为数字`;
    case 'text':
    case 'model':
      if (field.multiple === true) {
        return isStringList(value) ? null : `${field.name} 应为字符串列表`;
      }
      return isString(value, SETTING_TEXT_MAX) ? null : `${field.name} 应为字符串`;
    case 'select': {
      if (field.multiple === true) {
        return isStringList(value) ? null : `${field.name} 应为字符串列表`;
      }
      if (!isString(value, SETTING_TEXT_MAX)) return `${field.name} 应为字符串`;
      if (field.options === 'static') {
        const allowed = (field.staticOptions ?? []).map((option) => option.value);
        if (!allowed.includes(value)) return `${field.name} 只能是 ${allowed.join(' / ')}`;
      }
      return null;
    }
  }
}

/**
 * `values` 的问题列表（空 = 形状合法）。未登记的键、类型不符、超长、静态选项以外的值都算。
 * 不判断敏感与否（调用方各自决定敏感字段能不能出现）。
 */
export function settingValuesProblems(
  item: SettingItem,
  values: Readonly<Record<string, unknown>>,
): string[] {
  const fields = new Map(item.fields.map((field) => [field.name, field]));
  const problems: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key);
    if (field === undefined) {
      problems.push(`没有字段 ${key}`);
      continue;
    }
    const problem = fieldProblem(field, value);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}
