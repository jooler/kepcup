import { describe, expect, it } from 'vitest';
import { botProfile } from '@kepcup/testkit';
import {
  getSettingItem,
  settingsSchema,
  type Bot,
  type PluginInstanceSummary,
  type PluginSummary,
} from '@kepcup/shared';
import { buildItemAdapters } from '../../src/settings/contributions/index.js';
import type { AdapterDeps } from '../../src/settings/adapters.js';

/**
 * `mcp.instance`（插件的工具服务）：Bot 用 settings_search 能按「腾讯文档 / token」找到，
 * settings_read 能看到插件与实例、settings_change 的 values 由适配器校验；没有同步写入
 * （渲染层卡片经 `plugins.instances.*` 保存）。
 */

function item(id: string) {
  const found = getSettingItem(id);
  if (found === null) throw new Error(`missing ${id}`);
  return found;
}

function makeBot(id: string, pluginIds: string[] = []): Bot {
  const profile = botProfile({ name: id });
  return {
    id,
    name: id,
    bio: '',
    status: 'active',
    systemRole: null,
    setupState: 'done',
    profile: { ...profile, runtime: { ...profile.runtime, plugin_ids: pluginIds } },
  } as unknown as Bot;
}

function mcpPlugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'app.kepcup/mcp-tencent-docs',
    name: '腾讯文档',
    iconDataUri: null,
    version: '1.0.1',
    description: '',
    usage: '启用后添加工具服务并勾选授权给 Bot。',
    author: null,
    origin: 'marketplace',
    tier: 'verified',
    state: 'installed',
    enabled: true,
    dirPath: null,
    marketplace: null,
    installedAt: 1,
    updatedAt: 1,
    counts: { skills: 0, connectors: 0, mcp: 3, mail: 0 },
    items: [],
    updateAvailable: null,
    revoked: null,
    configFields: [],
    instanceFields: [],
    instanceCounts: { mail: 0, mcp: 1, im: 0 },
    providesInstances: ['mcp'],
    ...overrides,
  };
}

function instance(overrides: Partial<PluginInstanceSummary> = {}): PluginInstanceSummary {
  return {
    id: 'pli_1',
    pluginId: 'app.kepcup/mcp-tencent-docs',
    kind: 'mcp',
    title: '我的腾讯文档',
    values: {},
    storedSensitiveKeys: ['token'],
    serverId: 'plg_abc',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function deps(
  options: {
    plugins?: PluginSummary[] | undefined;
    instances?: PluginInstanceSummary[] | undefined;
    bots?: Bot[];
  } = {},
): AdapterDeps {
  const bots = options.bots ?? [makeBot('bot_a'), makeBot('bot_b')];
  return {
    settings: {
      get: () => settingsSchema.parse({}),
      update: (patch) => settingsSchema.parse(patch),
    },
    secrets: { hasValue: () => false, setValue: () => undefined },
    providers: { list: () => [], setKey: () => undefined },
    bots: {
      get: (id) => bots.find((bot) => bot.id === id) ?? null,
      listActive: () => bots,
    },
    botProfiles: {
      apply: () => {
        throw new Error('not used');
      },
    },
    publish: () => undefined,
    ...(options.plugins !== undefined
      ? { plugins: { list: () => options.plugins!, instances: () => options.instances ?? [] } }
      : {}),
  };
}

const target = { botId: 'bot_a', conversationId: 'conv_1', workdirId: null };
const PLUGIN = 'app.kepcup/mcp-tencent-docs';

describe('mcp.instance adapter', () => {
  it('no plugin module → unknown; no mcp plugin → unconfigured', () => {
    const none = buildItemAdapters(deps())(item('mcp.instance'));
    expect(none.read(item('mcp.instance'), target).status).toBe('unknown');

    const empty = buildItemAdapters(deps({ plugins: [] }))(item('mcp.instance'));
    const snapshot = empty.read(item('mcp.instance'), target);
    expect(snapshot.status).toBe('unconfigured');
    expect(snapshot.summary).toContain('还没有安装提供工具服务的插件');
  });

  it('installed plugin without instances → unconfigured; with one → configured', () => {
    const adapter = buildItemAdapters(deps({ plugins: [mcpPlugin()] }))(item('mcp.instance'));
    const empty = adapter.read(item('mcp.instance'), target);
    expect(empty.status).toBe('unconfigured');
    expect(empty.values).toEqual({ plugin: PLUGIN });

    const withInstance = buildItemAdapters(
      deps({ plugins: [mcpPlugin()], instances: [instance()] }),
    )(item('mcp.instance'));
    const snapshot = withInstance.read(item('mcp.instance'), target);
    expect(snapshot.status).toBe('configured');
    expect(snapshot.values).toEqual({ plugin: PLUGIN, instance: 'pli_1' });
    expect(snapshot.summary).toContain('1 个工具服务');
  });

  it('focus reads the addressed instance; a globally disabled plugin is partial', () => {
    const adapter = buildItemAdapters(
      deps({
        plugins: [mcpPlugin()],
        instances: [instance(), instance({ id: 'pli_2', title: '另一个', serverId: 'plg_def' })],
      }),
    )(item('mcp.instance'));
    const focused = adapter.read(item('mcp.instance'), target, { plugin: PLUGIN, instance: 'pli_2' });
    expect(focused.values).toEqual({ plugin: PLUGIN, instance: 'pli_2' });
    expect(focused.summary).toContain('另一个');

    const disabled = buildItemAdapters(
      deps({ plugins: [mcpPlugin({ enabled: false })], instances: [instance()] }),
    )(item('mcp.instance'));
    expect(disabled.read(item('mcp.instance'), target).status).toBe('partial');
  });

  it('prefers the plugin this Bot already has enabled', () => {
    const other = mcpPlugin({ id: 'app.kepcup/mcp-feishu', name: '飞书' });
    const adapter = buildItemAdapters(
      deps({
        plugins: [mcpPlugin(), other],
        instances: [instance({ pluginId: other.id, id: 'pli_fs' })],
        bots: [makeBot('bot_a', [other.id]), makeBot('bot_b')],
      }),
    )(item('mcp.instance'));
    expect(adapter.read(item('mcp.instance'), target).values).toEqual({
      plugin: other.id,
      instance: 'pli_fs',
    });
  });

  it('lists plugins / instances and validates proposal values', () => {
    const adapter = buildItemAdapters(
      deps({ plugins: [mcpPlugin()], instances: [instance()] }),
    )(item('mcp.instance'));
    const [pluginField, instanceField] = item('mcp.instance').fields;
    expect(adapter.options?.(pluginField!, item('mcp.instance'), target)).toEqual([
      { value: PLUGIN, label: '腾讯文档' },
    ]);
    expect(adapter.options?.(instanceField!, item('mcp.instance'), target)).toEqual([
      { value: 'pli_1', label: '我的腾讯文档' },
    ]);
    expect(adapter.write).toBeUndefined();

    expect(adapter.normalize?.(item('mcp.instance'), { plugin: 'nope' }, target)).toEqual({
      ok: false,
      message: '没有这个提供工具服务的插件：nope',
    });
    expect(
      adapter.normalize?.(item('mcp.instance'), { plugin: PLUGIN, instance: 'pli_x' }, target),
    ).toEqual({ ok: false, message: `「${PLUGIN}」没有这个工具服务：pli_x` });
    // 只给 instance：按实例反查属主插件；空串实例视为新建并去掉。
    expect(adapter.normalize?.(item('mcp.instance'), { instance: 'pli_1' }, target)).toEqual({
      ok: true,
      values: { instance: 'pli_1', plugin: PLUGIN },
    });
    expect(adapter.normalize?.(item('mcp.instance'), { plugin: PLUGIN, instance: '' }, target)).toEqual(
      { ok: true, values: { plugin: PLUGIN } },
    );
  });

  it('values only address the form: unchanged values must not short-circuit the card', () => {
    const adapter = buildItemAdapters(
      deps({ plugins: [mcpPlugin()], instances: [instance()] }),
    )(item('mcp.instance'));
    const snapshot = adapter.read(item('mcp.instance'), target);
    expect(
      adapter.requiresForm?.(item('mcp.instance'), { plugin: PLUGIN, instance: 'pli_1' }, snapshot),
    ).toBe(true);
  });

  it('verifyComplete requires the required fields of the addressed instances', () => {
    const tokenField = [
      { key: 'token', title: 'Token', type: 'string', required: true, sensitive: true },
    ] as const;
    const stored = buildItemAdapters(
      deps({
        plugins: [mcpPlugin({ instanceFields: [...tokenField] })],
        instances: [instance()],
      }),
    )(item('mcp.instance'));
    const storedSnap = stored.read(item('mcp.instance'), target);
    expect(
      stored.verifyComplete?.(item('mcp.instance'), { plugin: PLUGIN, instance: 'pli_1' }, storedSnap),
    ).toBe(true);

    const missing = buildItemAdapters(
      deps({
        plugins: [mcpPlugin({ instanceFields: [...tokenField] })],
        instances: [instance({ storedSensitiveKeys: [] })],
      }),
    )(item('mcp.instance'));
    const missingSnap = missing.read(item('mcp.instance'), target);
    expect(
      missing.verifyComplete?.(item('mcp.instance'), { plugin: PLUGIN, instance: 'pli_1' }, missingSnap),
    ).toBe(false);
    // 没指名实例（新建意图）：任何一个实例缺必填凭据都不算完成。
    expect(missing.verifyComplete?.(item('mcp.instance'), { plugin: PLUGIN }, missingSnap)).toBe(
      false,
    );
    // 未知插件 / 模块未就绪：核对不了 → null（宿主按现有启发式兜底）。
    expect(stored.verifyComplete?.(item('mcp.instance'), { plugin: 'nope' }, storedSnap)).toBeNull();
    expect(buildItemAdapters(deps())(item('mcp.instance')).verifyComplete?.(
      item('mcp.instance'),
      { plugin: PLUGIN },
      { values: null } as never,
    )).toBeNull();
  });
});
