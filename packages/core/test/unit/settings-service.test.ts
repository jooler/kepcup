import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../../src/domain/settings.js';

/** 单行 settings 表的桩：get 返回构造时给定的 value_json，run 记下写回值。 */
function fakeDb(valueJson: string | undefined) {
  let stored = valueJson;
  return {
    prepare: () => ({
      get: () => (stored === undefined ? undefined : { value_json: stored }),
      run: (_key: string, valueJson: string) => {
        stored = valueJson;
      },
    }),
    get stored() {
      return stored;
    },
  } as never as { prepare: () => { get: () => { value_json: string } | undefined; run: () => void }; stored: string | undefined };
}

const CLOCK = { now: () => 0 } as never;

describe('SettingsService：legacy 供应商数据迁移（modelProviders 实例化）', () => {
  it('vendorProviders / customProviders / capabilityModels 一次性搬进实例列表，未知厂商被丢弃', () => {
    const stored = {
      defaultMainModel: 'dashscope/qwen-plus',
      vendorProviders: [
        { id: 'siliconflow', models: [{ id: 'deepseek-ai/DeepSeek-V3.1' }] },
        { id: 'dashscope', models: [{ id: 'qwen-plus', name: 'Qwen Plus' }] },
      ],
      customProviders: [
        { id: 'proxy', name: 'Proxy', baseUrl: 'https://proxy.example.com/v1', models: [{ id: 'm1' }] },
      ],
      capabilityModels: {
        embedding: { vendor: 'siliconflow', model: 'BAAI/bge-m3' },
        image: { vendor: 'dashscope', model: 'qwen-image' },
      },
    };
    const db = fakeDb(JSON.stringify(stored));
    const settings = new SettingsService(db, CLOCK).get();
    // 未知厂商条目被丢弃，dashscope 实例沿用厂商 id（ref 兼容）。
    expect(
      settings.modelProviders.map((p) => ({ id: p.id, vendor: p.vendor, name: p.name })),
    ).toEqual([
      { id: 'dashscope', vendor: 'dashscope', name: '阿里云百炼' },
      { id: 'custom:proxy', vendor: null, name: 'Proxy' },
    ]);
    expect(settings.modelProviders[0]!.models[0]).toEqual({
      id: 'qwen-plus',
      name: 'Qwen Plus',
      contextWindow: 128_000,
      capabilities: ['chat'],
    });
    // 能力配置：未知厂商引用置空；有效引用改写为 {provider, model}，模型补进实例。
    expect(settings.capabilityModels.embedding).toBeNull();
    expect(settings.capabilityModels.image).toEqual({ provider: 'dashscope', model: 'qwen-image' });
    expect(settings.modelProviders[0]!.models.map((m) => m.id)).toEqual(['qwen-plus', 'qwen-image']);
    expect(settings.modelProviders[0]!.models[1]!.capabilities).toEqual(['image']);
    expect(settings.defaultMainModel).toBe('dashscope/qwen-plus');
    // 迁移写回：legacy 字段不再存库（下次读取不再迁移）。
    const persisted = JSON.parse(db.stored!);
    expect(persisted.vendorProviders).toBeUndefined();
    expect(persisted.customProviders).toBeUndefined();
    expect(persisted.modelProviders).toHaveLength(2);
  });

  it('能力配置引用的厂商无条目时补建空实例（对齐旧行为：能力模型可单独配置）', () => {
    const stored = { capabilityModels: { rerank: { vendor: 'dashscope', model: 'gte-rerank-v2' } } };
    const settings = new SettingsService(fakeDb(JSON.stringify(stored)), CLOCK).get();
    expect(settings.modelProviders).toEqual([
      {
        id: 'dashscope',
        vendor: 'dashscope',
        name: '阿里云百炼',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        enabled: true,
        api: 'openai-completions',
        builtinCatalog: false,
        models: [{ id: 'gte-rerank-v2', contextWindow: 128_000, capabilities: ['rerank'] }],
      },
    ]);
    expect(settings.capabilityModels.rerank).toEqual({
      provider: 'dashscope',
      model: 'gte-rerank-v2',
    });
  });

  it('已迁移（modelProviders 非空）或无 legacy 数据时原样解析；空库返回默认值', () => {
    const stored = {
      modelProviders: [{ id: 'custom:a', vendor: null, name: 'A', baseUrl: 'https://a.example.com' }],
      vendorProviders: [{ id: 'dashscope', models: [] }],
      capabilityModels: { embedding: { vendor: 'dashscope', model: 'text-embedding-v4' } },
    };
    const settings = new SettingsService(fakeDb(JSON.stringify(stored)), CLOCK).get();
    expect(settings.modelProviders).toEqual([
      {
        id: 'custom:a',
        vendor: null,
        name: 'A',
        baseUrl: 'https://a.example.com',
        enabled: true,
        api: 'openai-completions',
        builtinCatalog: false,
        models: [],
      },
    ]);
    expect(new SettingsService(fakeDb(undefined), CLOCK).get().modelProviders).toEqual([]);
  });
});

describe('SettingsService：modelProviders 存量归一化', () => {
  it('非法实例条目被丢弃并告警；悬空的能力引用置空', () => {
    const stored = {
      modelProviders: [
        { id: 'custom:ok', vendor: null, name: 'OK', baseUrl: 'https://ok.example.com', models: [] },
        { id: 'bad id!', vendor: null, name: 'Bad', baseUrl: 'https://bad.example.com' },
        { id: 'dashscope', vendor: 'siliconflow', name: 'X', baseUrl: 'https://x.example.com' },
      ],
      capabilityModels: { embedding: { provider: 'custom:gone', model: 'm' } },
    };
    const warn = vi.fn();
    const settings = new SettingsService(fakeDb(JSON.stringify(stored)), CLOCK, { warn }).get();
    expect(settings.modelProviders.map((p) => p.id)).toEqual(['custom:ok']);
    expect(settings.capabilityModels.embedding).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
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
