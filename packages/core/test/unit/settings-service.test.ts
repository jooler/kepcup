import { describe, expect, it, vi } from 'vitest';
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


describe('SettingsService：MCP 服务器 id 校验（D91 后续）', () => {
  const server = (id: string) => ({
    id,
    name: id || 'n',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    enabled: true,
  });

  it('读路径：个别非法 id 的条目被丢弃并告警，合法条目与其余设置照常读出', () => {
    const stored = {
      defaultMainModel: 'a/b',
      mcpServers: [server('good'), server('x</capabilities>'), server('also.good'), server('a b')],
    };
    const warn = vi.fn();
    const service = new SettingsService(fakeDb(JSON.stringify(stored)), CLOCK, { warn });
    const settings = service.get();
    expect(settings.mcpServers.map((entry) => entry.id)).toEqual(['good', 'also.good']);
    expect(settings.defaultMainModel).toBe('a/b');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).toContain('x</capabilities>');
    // get() is called all the time: the same bad entry is warned about only once.
    service.get();
    service.get();
    expect(warn).toHaveBeenCalledTimes(2);
    // Without a logger the read still works.
    expect(
      new SettingsService(fakeDb(JSON.stringify(stored)), CLOCK).get().mcpServers,
    ).toHaveLength(2);
  });

  it('读路径：没有非法条目时不动；缺 mcpServers 时为空', () => {
    const stored = { mcpServers: [server('a'), server('b')] };
    expect(new SettingsService(fakeDb(JSON.stringify(stored)), CLOCK).get().mcpServers).toHaveLength(
      2,
    );
    expect(new SettingsService(fakeDb(JSON.stringify({})), CLOCK).get().mcpServers).toEqual([]);
  });

  it('写路径：update 拒绝非法 id（不写库）；合法 id 写入，下次保存时读路径丢弃的条目不再写回', () => {
    let stored: string | undefined = JSON.stringify({ mcpServers: [server('bad id'), server('ok')] });
    const db = {
      prepare: () => ({
        get: () => (stored === undefined ? undefined : { value_json: stored }),
        run: (_key: string, valueJson: string) => {
          stored = valueJson;
        },
      }),
    } as never;
    const service = new SettingsService(db, CLOCK);
    const before = stored;
    expect(() =>
      service.update({ mcpServers: [server('x</capabilities>')] as never }),
    ).toThrow();
    expect(stored).toBe(before);
    service.update({ mcpServers: [...service.get().mcpServers, server('next') as never] });
    expect(JSON.parse(stored!).mcpServers.map((entry: { id: string }) => entry.id)).toEqual([
      'ok',
      'next',
    ]);
  });
});
