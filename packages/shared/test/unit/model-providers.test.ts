import { describe, expect, it } from 'vitest';
import {
  createInstanceFromTemplate,
  getProviderTemplate,
  migrateLegacyModelProviders,
  nextProviderInstanceId,
  PROVIDER_TEMPLATES,
  settingsSchema,
} from '../../src/index.js';

/** legacy 设置形状的迁移（modelProviders 实例化，v0.5.6）。 */
describe('migrateLegacyModelProviders', () => {
  const legacy = {
    defaultMainModel: 'dashscope/qwen-plus',
    customProviders: [
      {
        id: 'proxy',
        name: 'Proxy',
        baseUrl: 'https://proxy.example.com/v1',
        models: [{ id: 'm1', name: 'M1', contextWindow: 8192 }],
      },
    ],
    vendorProviders: [
      { id: 'dashscope', models: [{ id: 'qwen-plus', name: 'Qwen Plus' }] },
    ],
    capabilityModels: {
      embedding: { vendor: 'dashscope', model: 'text-embedding-v4' },
      rerank: null,
    },
  };

  it('legacy 三块数据一次性搬进实例列表；ref 与密钥名不变式成立', () => {
    const { data, changed } = migrateLegacyModelProviders(structuredClone(legacy));
    expect(changed).toBe(true);
    expect(data.customProviders).toBeUndefined();
    expect(data.vendorProviders).toBeUndefined();
    const instances = data.modelProviders as Array<Record<string, unknown>>;
    // 厂商实例沿用厂商 id，自定义实例带 custom: 前缀 → 存量 ref（dashscope/qwen-plus、
    // custom:proxy/m1）与密钥名（provider:dashscope、provider:custom:proxy）原样有效。
    expect(instances.map((p) => p.id)).toEqual(['dashscope', 'custom:proxy']);
    // 能力引用改写为 {provider, model}；模型补进实例（能力合并，同 id 不重复）。
    expect((data.capabilityModels as Record<string, unknown>).embedding).toEqual({
      provider: 'dashscope',
      model: 'text-embedding-v4',
    });
    const dashscope = instances[0]!;
    expect(dashscope.models).toEqual([
      { id: 'qwen-plus', name: 'Qwen Plus', capabilities: ['chat'] },
      { id: 'text-embedding-v4', capabilities: ['embedding'] },
    ]);
    expect(legacy.defaultMainModel).toBe('dashscope/qwen-plus');
  });

  it('迁移产物通过 settingsSchema 解析（schema 内不再有 legacy 字段）', () => {
    const { data } = migrateLegacyModelProviders(structuredClone(legacy));
    const parsed = settingsSchema.parse(data);
    expect(parsed.modelProviders).toHaveLength(2);
    expect(parsed.modelProviders[0]!.models[1]!.capabilities).toEqual(['embedding']);
    expect(parsed.defaultMainModel).toBe('dashscope/qwen-plus');
  });

  it('幂等：modelProviders 非空时原样返回；无 legacy 数据时不动', () => {
    const migrated = migrateLegacyModelProviders(structuredClone(legacy)).data;
    expect(migrateLegacyModelProviders(migrated)).toEqual({ data: migrated, changed: false });
    expect(migrateLegacyModelProviders({ defaultMainModel: 'a/b' })).toEqual({
      data: { defaultMainModel: 'a/b' },
      changed: false,
    });
  });

  it('未知厂商条目丢弃、未知厂商的能力引用置空；空模型列表的能力厂商补建实例', () => {
    const { data } = migrateLegacyModelProviders({
      vendorProviders: [{ id: 'siliconflow', models: [{ id: 'x' }] }],
      capabilityModels: {
        rerank: { vendor: 'siliconflow', model: 'r' },
        image: { vendor: 'volcengine', model: 'qwen-image' },
      },
    });
    expect(data.modelProviders).toEqual([
      {
        id: 'volcengine',
        vendor: 'volcengine',
        name: '火山方舟',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        enabled: true,
        models: [{ id: 'qwen-image', capabilities: ['image'] }],
      },
    ]);
    expect(data.capabilityModels).toEqual({
      rerank: null,
      image: { provider: 'volcengine', model: 'qwen-image' },
    });
  });
});

describe('nextProviderInstanceId', () => {
  it('base 空闲直接用；占用时追加 -2 / -3', () => {
    expect(nextProviderInstanceId('dashscope', [])).toBe('dashscope');
    expect(nextProviderInstanceId('dashscope', ['dashscope'])).toBe('dashscope-2');
    expect(nextProviderInstanceId('dashscope', ['dashscope', 'dashscope-2'])).toBe('dashscope-3');
  });
});

describe('PROVIDER_TEMPLATES / createInstanceFromTemplate', () => {
  it('完整搬运 ZCode 目录 + 合并 pi 内置供应商；媒体厂商卡带 vendor', () => {
    const ids = PROVIDER_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    // ZCode 的 34 张卡（含同供应商多端点变体）。
    for (const id of [
      'zai-api',
      'zai-standard-api',
      'bigmodel-api',
      'bigmodel-standard-api',
      'moonshot-kimi',
      'kimi-code-cn',
      'kimi-code-intl',
      'minimax',
      'minimax-m-plan-cn',
      'deepseek',
      'qwen-coding-plan-cn',
      'qwen-token-plan-team-cn',
      'xiaomi-mimo',
      'xiaomi-mimo-token-plan',
      'tencent-tokenhub-cn',
      'tencent-tokenhub-intl',
      'volcengine-coding-plan',
      'volcengine-agent-plan',
      'stepfun',
      'stepfun-step-plan',
      'openai',
      'anthropic',
      'xai',
      'siliconflow-cn',
      'openrouter',
      'opencode-zen-chat',
    ]) {
      expect(ids, id).toContain(id);
    }
    // 我们的媒体厂商卡 + pi 内置目录卡。
    expect(getProviderTemplate('dashscope')?.vendor).toBe('dashscope');
    expect(getProviderTemplate('volcengine')?.vendor).toBe('volcengine');
    expect(getProviderTemplate('deepseek')?.vendor).toBeUndefined();
    for (const id of ['google', 'mistral', 'groq', 'openrouter']) {
      expect(ids, id).toContain(id);
    }
    for (const id of ['google', 'groq', 'mistral']) {
      expect(getProviderTemplate(id)?.builtinCatalog).toBe(true);
      expect(getProviderTemplate(id)?.baseUrl).toBeUndefined();
    }
    // 线协议随 ZCode 模板（anthropic 端点变体原样保留）。
    expect(getProviderTemplate('zai-api')?.api).toBe('anthropic-messages');
    expect(getProviderTemplate('zai-standard-api')?.api).toBe('openai-completions');
    expect(getProviderTemplate('openai')?.api).toBe('openai-responses');
    // 模板图标 / baseUrl 参数合法。
    for (const template of PROVIDER_TEMPLATES) {
      if (template.baseUrl !== undefined) {
        expect(() => new URL(template.baseUrl), template.id).not.toThrow();
      }
      if (template.logo !== undefined) {
        expect(template.logo.length, template.id).toBeGreaterThan(0);
      }
    }
  });

  it('模板建档：预填对话模型与线协议 / 图标；id 避让 + 同模板第 N 个带序号', () => {
    const first = createInstanceFromTemplate([], 'zai-standard-api');
    expect(first).toMatchObject({
      id: 'zai-standard-api',
      vendor: null,
      name: 'Z.ai API',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      api: 'openai-completions',
      logo: 'model-provider-zai.png',
      builtinCatalog: false,
    });
    expect(first.models.length).toBeGreaterThan(0);
    expect(first.models.every((m) => m.capabilities.includes('chat'))).toBe(true);

    const anthropicTpl = createInstanceFromTemplate([], 'anthropic');
    expect(anthropicTpl.api).toBe('anthropic-messages');

    const dashscope = createInstanceFromTemplate(['dashscope'], 'dashscope');
    expect(dashscope.id).toBe('dashscope-2');
    expect(dashscope.vendor).toBe('dashscope');
    expect(dashscope.name).toBe('阿里云百炼 2');

    const unknown = () => createInstanceFromTemplate([], 'nope');
    expect(unknown).toThrow();
  });

  it('pi 目录模板建档：models 为空、无 baseUrl、builtinCatalog 标记', () => {
    const google = createInstanceFromTemplate([], 'google');
    expect(google).toMatchObject({
      id: 'google',
      vendor: null,
      name: 'Google Gemini',
      builtinCatalog: true,
      models: [],
    });
    expect(google.baseUrl).toBeUndefined();
  });

  it('模板建档产物通过 settingsSchema 解析', () => {
    const settings = settingsSchema.parse({
      modelProviders: [
        createInstanceFromTemplate([], 'kimi-code-cn'),
        createInstanceFromTemplate([], 'google'),
      ],
    });
    expect(settings.modelProviders[0]!.models.length).toBeGreaterThan(0);
    expect(settings.modelProviders[1]!.builtinCatalog).toBe(true);
  });
});
