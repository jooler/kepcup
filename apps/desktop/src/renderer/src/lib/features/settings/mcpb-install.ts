import type { McpbUserConfigField, McpbUserConfigValue } from '@kepcup/shared';

/**
 * MCPB 安装表单的纯函数（D73 P2 §6.5）：表单里所有值都是字符串 / 布尔，提交时按字段声明转成
 * `mcpb.install` 的 `userConfig`。组件本身只管界面状态。
 */

export type McpbFormValue = string | boolean;
export type McpbForm = Record<string, McpbFormValue>;

function defaultText(field: McpbUserConfigField): McpbFormValue {
  const value = field.default;
  if (field.type === 'boolean') return value === true || value === 'true';
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join('\n') : String(value);
}

export function initialForm(fields: readonly McpbUserConfigField[]): McpbForm {
  return Object.fromEntries(fields.map((field) => [field.key, defaultText(field)]));
}

/** 空白 = 未填；多值按行拆分并去掉空行。布尔恒视为已填。 */
function isFilled(field: McpbUserConfigField, value: McpbFormValue | undefined): boolean {
  if (field.type === 'boolean' && !field.multiple) return true;
  if (value === undefined || typeof value === 'boolean') return value !== undefined;
  return value.trim().length > 0;
}

export function missingRequired(fields: readonly McpbUserConfigField[], form: McpbForm): string[] {
  return fields
    .filter((field) => field.required && !isFilled(field, form[field.key]))
    .map((field) => field.title);
}

export function buildUserConfig(
  fields: readonly McpbUserConfigField[],
  form: McpbForm,
): Record<string, McpbUserConfigValue> {
  const result: Record<string, McpbUserConfigValue> = {};
  for (const field of fields) {
    const raw = form[field.key];
    if (raw === undefined) continue;
    if (field.type === 'boolean') {
      result[field.key] = raw === true || raw === 'true';
      continue;
    }
    const text = String(raw);
    if (text.trim().length === 0) continue;
    if (field.multiple) {
      const items = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (items.length > 0) result[field.key] = items;
    } else if (field.type === 'number') {
      const number = Number(text);
      result[field.key] = Number.isFinite(number) ? number : text;
    } else {
      result[field.key] = text;
    }
  }
  return result;
}

/** 提交后清空敏感字段（密码框不留明文），其余保持。 */
export function clearSensitive(fields: readonly McpbUserConfigField[], form: McpbForm): McpbForm {
  const next = { ...form };
  for (const field of fields) if (field.sensitive) next[field.key] = '';
  return next;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function runtimeLabel(kind: 'node' | 'python' | 'uv'): string {
  return kind === 'node' ? 'Node.js' : kind === 'python' ? 'Python' : 'uv';
}

/** 确认按钮能否点：已检查、兼容、运行时就绪、必填项齐全。 */
export function canInstall(input: {
  compatible: boolean;
  runtime: { available: boolean } | null;
  missing: readonly string[];
}): boolean {
  return (
    input.compatible &&
    (input.runtime === null || input.runtime.available) &&
    input.missing.length === 0
  );
}
