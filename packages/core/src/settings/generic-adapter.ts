import type { SettingFieldSpec, SettingItem, SettingValues } from '@kepcup/shared';
import type { AdapterDeps, ItemAdapter, NormalizeResult } from './adapters.js';
import { snapshot } from './adapters.js';

/**
 * 通用标量适配器（todo/settings-catalog-registry.md §4.2.4）：目录里声明
 * `store: { kind: 'settings', generic: true }` 的条目直接用它读写，不必写自定义适配器。
 *
 * 只支持非敏感、单值、settings 顶层的标量字段（boolean / string / number / 静态下拉），
 * 字段用 `fields[].path` 指到顶层键（缺省 = 字段名）。不处理：敏感字段、嵌套对象、
 * 多选、写后副作用（如 platform.autostart）、放宽权限——这些写自定义适配器（目录测试
 * 强制 generic 条目不带这些属性）。
 */

function fieldValue(deps: AdapterDeps, field: SettingFieldSpec): unknown {
  const path = field.path ?? field.name;
  const settings = deps.settings.get() as unknown as Record<string, unknown>;
  return settings[path];
}

/** 单个字段的就绪状态：null = 该字段不算配置信号（如 toggle 恒有值）。 */
function fieldStatus(
  field: SettingFieldSpec,
  value: unknown,
): 'configured' | 'unconfigured' | null {
  switch (field.type) {
    case 'toggle':
      return typeof value === 'boolean' ? 'configured' : null;
    case 'text':
    case 'model':
      return typeof value === 'string' && value.length > 0 ? 'configured' : 'unconfigured';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? 'configured' : 'unconfigured';
    case 'select': {
      if (typeof value !== 'string' || value.length === 0) return 'unconfigured';
      if (field.options === 'static') {
        return (field.staticOptions ?? []).some((option) => option.value === value)
          ? 'configured'
          : 'unconfigured';
      }
      return 'configured';
    }
    default:
      return null;
  }
}

function normalizeField(field: SettingFieldSpec, values: SettingValues): NormalizeResult | null {
  if (!(field.name in values)) return null;
  const value = values[field.name];
  switch (field.type) {
    case 'toggle':
      return typeof value === 'boolean'
        ? null
        : { ok: false, message: `${field.name} 应为 true / false` };
    case 'text':
    case 'model':
      return typeof value === 'string' ? null : { ok: false, message: `${field.name} 应为字符串` };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, message: `${field.name} 应为数字` };
      }
      if (
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max)
      ) {
        const bound =
          field.min !== undefined && field.max !== undefined
            ? `${field.min}–${field.max}`
            : field.min !== undefined
              ? `≥ ${field.min}`
              : `≤ ${field.max}`;
        return { ok: false, message: `${field.label}应为 ${bound} 的数字` };
      }
      return null;
    case 'select': {
      if (typeof value !== 'string') return { ok: false, message: `${field.name} 应为字符串` };
      if (field.options === 'static') {
        const allowed = (field.staticOptions ?? []).map((option) => option.value);
        if (!allowed.includes(value)) {
          return { ok: false, message: `${field.label}只能是 ${allowed.join(' / ')}` };
        }
      }
      return null;
    }
    default:
      return { ok: false, message: `${field.name} 不支持经通用适配器写入` };
  }
}

export function genericSettingsAdapter(deps: AdapterDeps, item: SettingItem): ItemAdapter {
  const fields = item.fields.filter((field) => !field.sensitive);
  return {
    read: () => {
      const values: SettingValues = {};
      const states: Array<'configured' | 'unconfigured'> = [];
      const parts: string[] = [];
      for (const field of fields) {
        const value = fieldValue(deps, field);
        if (field.type === 'toggle' && typeof value === 'boolean') {
          parts.push(value ? '已开启' : '已关闭');
        }
        const state = fieldStatus(field, value);
        if (state !== null) states.push(state);
        if (value !== undefined) values[field.name] = value as never;
      }
      const status = states.every((state) => state === 'configured')
        ? 'configured'
        : states.every((state) => state === 'unconfigured')
          ? 'unconfigured'
          : 'partial';
      return snapshot(status, Object.keys(values).length > 0 ? values : null, parts.join('；'));
    },
    normalize: (_item, values): NormalizeResult => {
      for (const field of fields) {
        const problem = normalizeField(field, values);
        if (problem !== null) return problem;
      }
      return { ok: true, values };
    },
    write: (_item, { next }) => {
      const patch: Record<string, unknown> = {};
      for (const field of fields) {
        if (!(field.name in next)) continue;
        patch[field.path ?? field.name] = next[field.name];
      }
      if (Object.keys(patch).length > 0) deps.settings.update(patch as never);
    },
    valuesWiden: () => false,
  };
}
