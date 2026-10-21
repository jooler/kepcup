import { describe, expect, it } from 'vitest';
import { getSettingItem } from '@kepcup/shared';
import {
  controlDefault,
  fieldControl,
  readSettingAtPath,
  seedValues,
  supportsItem,
  valuesFromState,
} from './field-editor-model';

/**
 * 通用 FieldEditorCard 的纯逻辑（todo/settings-catalog-registry.md 任务 5）：
 * 控件判定、按 `fields[].path` 的种子值、提交值整理。
 */

const workbench = getSettingItem('general.workbench')!;
const taskLoop = getSettingItem('general.task-loop')!;

describe('fieldControl', () => {
  it('maps the metadata-driven controls and refuses sensitive / multiple / dynamic options', () => {
    expect(fieldControl(workbench.fields[0]!)).toBe('toggle');
    expect(fieldControl(taskLoop.fields[0]!)).toBe('toggle');
    expect(fieldControl(taskLoop.fields[1]!)).toBe('number');
    expect(
      fieldControl({ ...workbench.fields[0]!, type: 'select' as const, options: 'static' as const }),
    ).toBe('select-static');
    expect(
      fieldControl({ ...workbench.fields[0]!, type: 'select' as const, options: 'agents' as const }),
    ).toBe('select-agents');
    expect(
      fieldControl({ ...workbench.fields[0]!, type: 'select' as const, options: 'providers' as const }),
    ).toBe('select-providers');
    expect(fieldControl({ ...workbench.fields[0]!, type: 'model' as const })).toBe('model');
    expect(fieldControl({ ...workbench.fields[0]!, type: 'text' as const })).toBe('text');
    // 不支持：敏感、多选、其余动态选项来源、secret / oauth / account。
    expect(fieldControl({ ...workbench.fields[0]!, sensitive: true })).toBeNull();
    expect(fieldControl({ ...workbench.fields[0]!, multiple: true })).toBeNull();
    expect(
      fieldControl({ ...workbench.fields[0]!, type: 'select', options: 'chat-models' }),
    ).toBeNull();
    expect(fieldControl({ ...workbench.fields[0]!, type: 'secret' as const })).toBeNull();
  });
});

describe('readSettingAtPath / seedValues', () => {
  it('reads nested dot paths', () => {
    expect(readSettingAtPath({ taskLoop: { idleWarnAfter: 4 } }, 'taskLoop.idleWarnAfter')).toBe(4);
    expect(readSettingAtPath({ taskLoop: null }, 'taskLoop.idleWarnAfter')).toBeUndefined();
    expect(readSettingAtPath(null, 'workbenchEnabled')).toBeUndefined();
    expect(readSettingAtPath({ a: 1 }, 'a')).toBe(1);
  });

  it('seeds from field.path ?? name; prefill wins and sensitive fields never seed', () => {
    expect(
      seedValues(workbench, null, { workbenchEnabled: true, other: 1 }),
    ).toEqual({ enabled: true });
    expect(seedValues(workbench, { enabled: false }, { workbenchEnabled: true })).toEqual({
      enabled: false,
    });
    expect(
      seedValues(taskLoop, null, {
        taskLoop: { idleGuardEnabled: false, idleWarnAfter: 5, idleStopAfter: 9, idleWindowCalls: 20, tokenSoftBudget: 1_000_000 },
      }),
    ).toEqual({
      idleGuardEnabled: false,
      idleWarnAfter: 5,
      idleStopAfter: 9,
      idleWindowCalls: 20,
      tokenSoftBudget: 1_000_000,
    });
    const withSecret = {
      ...workbench,
      fields: [...workbench.fields, { ...workbench.fields[0]!, name: 'apiKey', sensitive: true }],
    };
    expect(Object.keys(seedValues(withSecret, null, { workbenchEnabled: true }))).toEqual([
      'enabled',
    ]);
  });
});

describe('valuesFromState / controlDefault / supportsItem', () => {
  it('falls empty numbers back to the field default and keeps every non-sensitive field', () => {
    expect(valuesFromState(taskLoop, { idleGuardEnabled: true, idleWarnAfter: undefined })).toEqual({
      idleGuardEnabled: true,
      idleWarnAfter: 2,
      idleStopAfter: 3,
      idleWindowCalls: 3,
      tokenSoftBudget: 0,
    });
    expect(controlDefault(taskLoop.fields[1]!)).toBe(2);
    expect(controlDefault(workbench.fields[0]!)).toBe(false);
    // 没有控件的字段（不支持的类型）不提交。
    const unsupported = {
      ...workbench,
      fields: [
        workbench.fields[0]!,
        {
          ...workbench.fields[0]!,
          name: 'dynamic',
          type: 'select' as const,
          options: 'chat-models' as const,
        },
      ],
    };
    expect(valuesFromState(unsupported, { enabled: true })).toEqual({ enabled: true });
  });

  it('supports the metadata-driven items and the four special-cased ones', () => {
    for (const id of [
      'general.workbench',
      'general.task-loop',
      'models.concurrency',
      'general.launch-at-login',
      'models.widget-review',
      'agents.default',
    ]) {
      expect(supportsItem(getSettingItem(id)!), id).toBe(true);
    }
    const withDynamicSelect = {
      ...workbench,
      fields: [{ ...workbench.fields[0]!, type: 'select' as const, options: 'chat-models' as const }],
    };
    expect(supportsItem(withDynamicSelect)).toBe(false);
  });
});
