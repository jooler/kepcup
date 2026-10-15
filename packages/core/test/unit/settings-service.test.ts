import { describe, expect, it } from 'vitest';
import { SettingsService } from '../../src/domain/settings.js';



/** 单行 settings 表的桩：get 返回构造时给定的 value_json。 */
function fakeDb(valueJson: string | undefined) {
  return {
    prepare: () => ({ get: () => (valueJson === undefined ? undefined : { value_json: valueJson }) }),
  } as never;
}

const CLOCK = { now: () => 0 } as never;

describe('SettingsService：读取时丢弃已移除厂商的残留配置', () => {
  it('vendorProviders 里的未知厂商条目被删除，capabilityModels 的未知厂商引用置空', () => {
    const stored = {
      defaultMainModel: 'siliconflow/deepseek-ai/DeepSeek-V3.1',
      vendorProviders: [
        { id: 'siliconflow', models: [{ id: 'deepseek-ai/DeepSeek-V3.1' }] },
        { id: 'dashscope', models: [{ id: 'qwen-plus' }] },
      ],
      capabilityModels: {
        embedding: { vendor: 'siliconflow', model: 'BAAI/bge-m3' },
        image: { vendor: 'dashscope', model: 'qwen-image' },
      },
    };
    const service = new SettingsService(fakeDb(JSON.stringify(stored)), CLOCK);
    const settings = service.get();
    expect(settings.vendorProviders).toEqual([{ id: 'dashscope', models: [{ id: 'qwen-plus' }] }]);
    expect(settings.capabilityModels.embedding).toBeNull();
    expect(settings.capabilityModels.image).toEqual({
      vendor: 'dashscope',
      model: 'qwen-image',
    });
  });

  it('无残留时原样解析；空库返回默认值', () => {
    const stored = { vendorProviders: [{ id: 'volcengine', models: [] }] };
    const service = new SettingsService(fakeDb(JSON.stringify(stored)), CLOCK);
    expect(service.get().vendorProviders).toEqual([{ id: 'volcengine', models: [] }]);
    expect(new SettingsService(fakeDb(undefined), CLOCK).get().vendorProviders).toEqual([]);
  });
});

describe('SettingsService：工作台开关（D90）', () => {
  it('缺省关闭；update 可自由打开 / 关闭，与定时任务数量无关', () => {
    let stored: string | undefined;
    const db = {
      prepare: () => ({
        get: () => (stored === undefined ? undefined : { value_json: stored }),
        run: (_key: string, valueJson: string) => {
          stored = valueJson;
        },
      }),
    } as never;
    const service = new SettingsService(db, CLOCK);
    expect(service.get().workbenchEnabled).toBe(false);
    expect(service.get().workbenchNudgeDismissed).toBe(false);
    expect(service.update({ workbenchEnabled: true }).workbenchEnabled).toBe(true);
    expect(service.get().workbenchEnabled).toBe(true);
    expect(service.update({ workbenchEnabled: false }).workbenchEnabled).toBe(false);
  });
});

